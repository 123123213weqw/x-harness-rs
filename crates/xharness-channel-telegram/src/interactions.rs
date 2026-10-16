//! Scoped approval/question projection only. Native Host owns the decision;
//! this worker has no Agent, generic RPC, or provider send responsibility.
use crate::replies::split_text;
use futures::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use xharness_remote::{
    AccountLease, Channel, Error, Gateway, InteractionTicket, NativeInteractionId, ReplyBody,
    ReplyButton, ReplyPlan, Subscription, MAX_REPLY_BATCH,
};

/// Independent observer sibling of durable intake and durable external sender.
/// Scoped reconnect snapshots restore pending interactions after a gap/restart;
/// stable issued handles and outbox identities avoid duplicate provider sends.
/// This scoped worker also drives the independent durable output reducer.
/// Outgoing media remains separate work. Explicit terminal command replies share this scoped timer.
pub async fn run_interactions(
    gateway: Arc<Gateway>,
    lease: AccountLease,
    stop: CancellationToken,
) -> Result<(), Error> {
    if lease.account.channel != Channel::Telegram {
        return Err(Error::Invalid("Telegram interaction observer account"));
    }
    let lifetime = stop.child_token();
    let mut workers = JoinSet::new();
    let mut active: BTreeMap<String, CancellationToken> = BTreeMap::new();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let result = 'reconcile: loop {
        tokio::select! {
            biased;
            _ = lifetime.cancelled() => break Ok(()),
            completed = workers.join_next(), if !workers.is_empty() => {
                match completed {
                    Some(Ok((key, Ok(())))) => {active.remove(&key);},
                    Some(Ok((_, Err(error)))) => break Err(error),
                    _ => break Err(Error::WorkerFailed),
                }
            },
            _ = tick.tick() => {
                let scopes = match gateway.account_subscriptions(&lease).await {
                    Ok(scopes) => scopes,
                    Err(error) => break Err(error),
                };
                let mut wanted = BTreeMap::new();
                for scope in scopes {
                    // Telegram v1 only grants private conversations; do not
                    // subscribe to unsupported group/foreign-recipient routes.
                    if scope.sender.user != scope.conversation
                        || scope.conversation.parse::<u64>().ok().filter(|id| *id>0 && *id<=i64::MAX as u64).is_none()
                    {break 'reconcile Err(Error::Invalid("private interaction observer route"));}
                    let encoded = match serde_json::to_vec(&scope) {
                        Ok(encoded) => encoded,
                        Err(error) => break 'reconcile Err(Error::Json(error)),
                    };
                    let key = format!("{:x}",Sha256::digest(encoded));
                    wanted.insert(key,scope);
                }
                for (key, token) in &active {
                    if !wanted.contains_key(key) {token.cancel();}
                }
                // Drain superseded scope generations before taking replacement
                // subscription permits; a full 32-route rotation cannot briefly
                // create 64 workers and falsely fail the capacity check.
                if active.keys().any(|key| !wanted.contains_key(key)) {continue;}
                for (key,scope) in wanted {
                    if active.contains_key(&key) {continue;}
                    let cancel = lifetime.child_token();
                    active.insert(key.clone(),cancel.clone());
                    let g=gateway.clone();
                    let worker_lease = lease.clone();
                    workers.spawn(async move {(key,observe(g,worker_lease,scope,cancel).await)});
                }
            },
        }
    };
    lifetime.cancel();
    // No detached workers survive account shutdown/rotation or sibling error.
    let mut drain_failure = None;
    while let Some(completed) = workers.join_next().await {
        match completed {
            Ok((_, Ok(()))) => {}
            Ok((_, Err(error))) => {
                drain_failure.get_or_insert(error);
            }
            Err(_) => {
                drain_failure.get_or_insert(Error::WorkerFailed);
            }
        }
    }
    result.and(drain_failure.map_or(Ok(()), Err))
}
async fn observe(
    gateway: Arc<Gateway>,
    lease: AccountLease,
    scope: Subscription,
    stop: CancellationToken,
) -> Result<(), Error> {
    loop {
        let source = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            source = gateway.subscribe(scope.clone(),stop.clone()) => source,
        };
        let mut source = match source {
            Ok(source) => source,
            Err(Error::Unauthorized) => return Ok(()),
            Err(Error::StreamGap) => {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => return Ok(()),
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut output_tick = tokio::time::interval(Duration::from_millis(500));
        output_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pending = BTreeMap::<String, NativeInteractionId>::new();
        let mut refresh = tokio::time::interval(Duration::from_secs(30));
        refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let ids = tokio::select! {
                biased;
                _ = stop.cancelled() => return Ok(()),
                _ = output_tick.tick() => {
                    let result=tokio::select! {biased;
                        _=stop.cancelled()=>return Ok(()),
                        result=async {
                            crate::commands::sync_command_replies(&gateway,&lease,scope.clone()).await?;
                            crate::output::sync_output(&gateway,&lease,scope.clone()).await
                        }=>result,
                    };
                    match result {
                        Ok(())=>{},
                        Err(Error::Unauthorized)=>return Ok(()),
                        Err(error)=>return Err(error),
                    }
                    continue;
                },
                frame = source.next() => match frame {
                    Some(Ok(frame)) if matches!(frame.method.as_str(),"approval/requested"|"question/requested") => {
                        if pending.len() == 32 && !pending.contains_key(frame.rpc_id.as_str()) {return Err(Error::Capacity);}
                        pending.insert(frame.rpc_id.as_str().to_owned(),frame.rpc_id.clone());
                        vec![frame.rpc_id]
                    },
                    Some(Ok(_)) => continue,
                    Some(Err(Error::StreamGap)) | None => break, // Reconnect restores only actual pending snapshots.
                    Some(Err(Error::Unauthorized)) => return Ok(()),
                    Some(Err(error)) => return Err(error),
                },
                _ = refresh.tick() => pending.values().cloned().collect(),
            };
            for id in ids {
                gateway.account_checkpoint(&lease).await?;
                let ticket = tokio::select! {
                    biased;
                    _ = stop.cancelled() => return Ok(()),
                    ticket = gateway.mint_interaction_ticket(scope.clone(),id.clone(),600) => ticket,
                };
                match ticket {
                    Ok(ticket) => {
                        let plans = format_interaction(&ticket)?;
                        tokio::select! {
                            biased;
                            _ = stop.cancelled() => return Ok(()),
                            result = gateway.enqueue_account_replies(&lease,scope.clone(),plans) => {
                                match result {
                                    Ok(_) => {},
                                    // A rebind/revoke between snapshot and
                                    // output commit retires this scope worker,
                                    // not every other account subscription.
                                    Err(Error::Unauthorized) => return Ok(()),
                                    Err(error) => return Err(error),
                                }
                            },
                        }
                    }
                    Err(Error::Invalid(_) | Error::IdentityConflict) => {
                        pending.remove(id.as_str());
                    }
                    Err(Error::Unauthorized) => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
        }
        // Avoid spinning on a closed/flooded native stream. No native answer or
        // provider effect is retried: only snapshot/journal reads reconnect.
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

/// Plain text, no Markdown interpretation or truncation. Buttons reside on the
/// final chunk and contain an expiring scoped handle, never a raw RPC response.
pub fn format_interaction(ticket: &InteractionTicket) -> Result<Vec<ReplyPlan>, Error> {
    let payload = &ticket.interaction.frame.payload;
    let raw = ticket.token.as_str();
    let (text, buttons) = match ticket.interaction.frame.method.as_str() {
        "approval/requested" if payload["reviewing"] != true => {
            let tool = payload["toolName"]
                .as_str()
                .ok_or(Error::Invalid("approval tool"))?;
            let reason = payload["reason"].as_str().unwrap_or("");
            (format!("Approval required\nTool: {tool}\n{reason}\n\nApprove once or reject. Buttons expire within 10 minutes."),
                vec![vec![button("Approve once",format!("a:{raw}")),button("Reject",format!("r:{raw}"))]])
        }
        "question/requested" => {
            let questions: Vec<Question> = serde_json::from_value(payload["questions"].clone())?;
            if questions.is_empty() || questions.len() > 32 {
                return Err(Error::Invalid("question count"));
            }
            let mut text = String::from("Question requires an answer\n");
            let mut rows = Vec::new();
            let mut template = Vec::new();
            for question in &questions {
                if question.multi_select || question.options.len() > 32 {
                    return Err(Error::Invalid("question shape"));
                }
                text.push_str(&format!("\n{}\n{}\n", question.header, question.question));
                for (index, option) in question.options.iter().enumerate() {
                    text.push_str(&format!("{}. {}", index + 1, option.label));
                    if let Some(description) = &option.description {
                        text.push_str(&format!(" — {description}"));
                    }
                    text.push('\n');
                    if questions.len() == 1 {
                        rows.push(vec![button(
                            &format!("Option {}", index + 1),
                            format!("q:{raw}:{index}"),
                        )]);
                    }
                }
                template.push(
                    serde_json::json!({"id":question.id,"selected":null,"custom":"YOUR ANSWER"}),
                );
            }
            text.push_str(&format!("\nFor a custom answer or multiple questions, edit each custom field and send the complete command:\n/answer {raw} {}\n\nButtons and this handle expire within 10 minutes.",serde_json::to_string(&template)?));
            // At most eight rows of four choices plus cancellation; transport
            // and durable outbox both enforce the same 16-row/64-button bound.
            if questions.len() == 1 {
                rows = rows
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .chunks(4)
                    .map(<[ReplyButton]>::to_vec)
                    .collect();
            }
            rows.push(vec![button("Cancel question", format!("c:{raw}"))]);
            (text, rows)
        }
        _ => return Err(Error::Invalid("unsupported interaction")),
    };
    if text.len() > 256 * 1024 || text.contains('\0') {
        return Err(Error::Capacity);
    }
    let chunks = split_text(&text);
    if chunks.is_empty() || chunks.len() > MAX_REPLY_BATCH {
        return Err(Error::Capacity);
    }
    let last = chunks.len() - 1;
    let identity = format!("{:x}", Sha256::digest(raw));
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(index, text)| ReplyPlan {
            id: format!("interaction/{identity}/part-{index}"),
            body: ReplyBody {
                attachment: None,
                text,
                buttons: if index == last {
                    buttons.clone()
                } else {
                    vec![]
                },
            },
            replace_of: None,
        })
        .collect())
}
fn button(label: &str, ticket: String) -> ReplyButton {
    ReplyButton {
        label: label.into(),
        ticket,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Question {
    id: String,
    header: String,
    question: String,
    options: Vec<OptionItem>,
    multi_select: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionItem {
    label: String,
    description: Option<String>,
}
