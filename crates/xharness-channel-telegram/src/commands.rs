//! Native terminal command results, not Agent execution or raw RPC forwarding.
use crate::replies::split_text;
use serde_json::Value;
use std::collections::BTreeSet;
use xharness_remote::{
    AccountLease, Command, Delivery, DeliveryState, Error, Gateway, NativeCommandResult, ReplyBody,
    ReplyPlan, Subscription, MAX_REPLY_BATCH,
};
const MAX_HISTORY_TEXT: usize = 200_000;
const MAX_HISTORY_EVENTS: usize = 8192;
fn append(to: &mut String, text: &str) -> Result<(), Error> {
    if text.contains('\0') {
        return Err(Error::Invalid("history text"));
    }
    if to.len().saturating_add(text.len()) > MAX_HISTORY_TEXT {
        return Err(Error::Capacity);
    }
    to.push_str(text);
    Ok(())
}
fn message_text(message: &Value, expected_role: &str) -> Result<String, Error> {
    if message["role"] != expected_role {
        return Err(Error::Invalid("history role"));
    }
    let blocks = message["content"]
        .as_array()
        .ok_or(Error::Invalid("history content"))?;
    if blocks.len() > 128 {
        return Err(Error::Capacity);
    }
    let mut text = String::new();
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => append(
                &mut text,
                b["text"].as_str().ok_or(Error::Invalid("history text"))?,
            )?,
            Some("reasoning") => {}
            Some("image" | "file") => append(&mut text, "\n[Attachment queued separately]\n")?,
            _ => return Err(Error::Invalid("history content kind")),
        }
    }
    Ok(text)
}
fn coordinate(data: &Value) -> Result<(u64, u64), Error> {
    Ok((
        data["turn"]
            .as_u64()
            .ok_or(Error::Invalid("history turn"))?,
        data["step"]
            .as_u64()
            .ok_or(Error::Invalid("history step"))?,
    ))
}
fn history(
    delivery: &Delivery,
    value: &Value,
    before: Option<u64>,
    count: u16,
) -> Result<String, Error> {
    let entries = value["events"]
        .as_array()
        .ok_or(Error::Invalid("history events"))?;
    let more = value["hasMore"]
        .as_bool()
        .ok_or(Error::Invalid("history continuation"))?;
    if entries.len() > MAX_HISTORY_EVENTS {
        return Err(Error::Capacity);
    }
    let mut previous = None;
    let mut finals = BTreeSet::new();
    for entry in entries {
        let event = &entry["event"];
        let seq = event["seq"]
            .as_u64()
            .ok_or(Error::Invalid("history sequence"))?;
        if previous.is_some_and(|old| seq <= old) || before.is_some_and(|end| seq >= end) {
            return Err(Error::Invalid("history ordering"));
        }
        previous = Some(seq);
        if event["type"] == "assistant/message" {
            finals.insert(coordinate(&event["data"])?);
        }
    }
    let mut rendered = format!("History — session {}\n", delivery.binding.session);
    let mut messages = 0usize;
    for entry in entries {
        let event = &entry["event"];
        let data = &event["data"];
        let block = match event["type"]
            .as_str()
            .ok_or(Error::Invalid("history kind"))?
        {
            "user/message" => Some(format!("\nUser\n{}\n", message_text(data, "user")?)),
            "assistant/message" => Some(format!(
                "\nAssistant\n{}{}\n",
                message_text(&data["message"], "assistant")?,
                if data["interrupted"] == true {
                    "\n[Interrupted]"
                } else {
                    ""
                }
            )),
            "assistant/chunk" => {
                if finals.contains(&coordinate(data)?) {
                    None
                } else {
                    match data["chunk"]["type"].as_str() {
                        Some("text-delta") => Some(format!(
                            "\nAssistant (partial)\n{}\n",
                            data["chunk"]["text"]
                                .as_str()
                                .ok_or(Error::Invalid("history chunk"))?
                        )),
                        Some(
                            "reasoning-delta" | "tool-call-delta" | "usage" | "finish" | "provider",
                        ) => None,
                        _ => return Err(Error::Invalid("history chunk kind")),
                    }
                }
            }
            "tool/call" => {
                let name = data["name"]
                    .as_str()
                    .ok_or(Error::Invalid("history tool name"))?;
                if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
                    return Err(Error::Invalid("history tool name"));
                }
                Some(format!("\nTool started: {name}\n"))
            }
            "tool/result" => {
                let content = data["message"]["content"]
                    .as_array()
                    .ok_or(Error::Invalid("history tool result"))?;
                if content.is_empty() || content.len() > 128 {
                    return Err(Error::Invalid("history tool result bound"));
                }
                let mut failed = false;
                let mut media = false;
                for result in content {
                    if result["type"] != "tool-result" {
                        return Err(Error::Invalid("history tool result kind"));
                    }
                    failed |= result["isError"]
                        .as_bool()
                        .ok_or(Error::Invalid("history tool result outcome"))?;
                    let parts = result["content"]
                        .as_array()
                        .ok_or(Error::Invalid("history tool result content"))?;
                    if parts.len() > 128 {
                        return Err(Error::Capacity);
                    }
                    media |= parts
                        .iter()
                        .any(|p| matches!(p["type"].as_str(), Some("image" | "file")));
                }
                Some(format!(
                    "\nTool {}{}\n",
                    if failed { "failed" } else { "finished" },
                    if media {
                        "; attachment queued separately"
                    } else {
                        ""
                    }
                ))
            }
            _ => None, // No metadata, diagnostics, view projections or paths in a command reply.
        };
        if let Some(block) = block {
            append(&mut rendered, &block)?;
            messages += 1;
        }
    }
    if messages == 0 {
        append(&mut rendered, "\nNo conversation text in this page.\n")?;
    }
    if more {
        let cursor = entries
            .first()
            .and_then(|e| e["event"]["seq"].as_u64())
            .filter(|seq| *seq > 0)
            .ok_or(Error::Invalid("history cursor"))?;
        append(
            &mut rendered,
            &format!("\nEarlier history: /history {count} {cursor}"),
        )?;
    } else {
        append(&mut rendered, "\nBeginning of history reached.")?;
    }
    Ok(rendered)
}
fn catalogue_label(value: &str) -> Result<String, Error> {
    let mut preview: String = value.chars().take(160).collect();
    if value.chars().count() > 160 {
        preview.push('…');
    }
    // Labels are quoted data, not raw multiline command syntax. Identity fields
    // are never shortened; this preview applies only to human-readable titles.
    Ok(serde_json::to_string(&preview)?)
}
fn catalogue(
    delivery: &Delivery,
    value: &Value,
    after: Option<&xharness_remote::CatalogueCursor>,
) -> Result<String, Error> {
    let page: xharness_remote::ControllerCatalogue = serde_json::from_value(value.clone())?;
    if page.principal_revision != delivery.principal_revision
        || page.binding_generation != delivery.binding.generation
        || !page.is_bounded_after(after)
    {
        return Err(Error::Invalid("catalogue receipt"));
    }
    let mut text=format!("Sessions — authorized page ({} session entries; {} allowed workspaces)\nThis page lists existing sessions, not every workspace or creation permission.\nTitles are previews (up to 160 characters); IDs are exact.\n",page.catalogue.sessions.len(),page.catalogue.workspaces.len());
    for session in &page.catalogue.sessions {
        let workspace = page
            .catalogue
            .workspaces
            .iter()
            .find(|w| w.id == session.workspace)
            .ok_or(Error::Invalid("catalogue workspace"))?;
        text.push_str(&format!(
            "\n{} / {}{}{}{}\nWorkspace ID: {}\nSession ID: {}\nSelect: /select {}\n",
            catalogue_label(&workspace.title)?,
            catalogue_label(session.title.as_deref().unwrap_or("Untitled"))?,
            if session.workspace == delivery.binding.workspace
                && session.id == delivery.binding.session
            {
                " [current]"
            } else {
                ""
            },
            if session.running { " [running]" } else { "" },
            if session.restoring {
                " [restoring]"
            } else {
                ""
            },
            workspace.id,
            session.id,
            serde_json::to_string(&xharness_remote::SessionSelection {
                workspace: workspace.id.clone(),
                session: session.id.clone()
            })?
        ));
    }
    if page.catalogue.sessions.is_empty() {
        text.push_str("\nNo accessible unarchived sessions after this cursor.\n");
    }
    match page.catalogue.next {
        Some(cursor) => text.push_str(&format!(
            "\nNext page: /sessions {}",
            serde_json::to_string(&cursor)?
        )),
        None => text.push_str("\nEnd of this session listing."),
    }
    // 25 title previews and exact ID pairs fit the bounded plain-text reply.
    // Do not dump up to 256 unused workspace labels or omit session entries.
    if text.contains('\0') || text.len() > 250_000 {
        return Err(Error::Capacity);
    }
    Ok(text)
}
fn state_tag(state: &DeliveryState) -> Result<&'static str, Error> {
    match state {
        DeliveryState::Completed => Ok("completed"),
        DeliveryState::Rejected => Ok("rejected"),
        DeliveryState::Uncertain => Ok("uncertain"),
        DeliveryState::Abandoned => Ok("abandoned"),
        _ => Err(Error::Invalid("nonterminal command result")),
    }
}
/// Explicit result reply identity includes native delivery state. A desktop
/// reconciliation can notify the new state once without replaying the command.
fn automation_read(delivery: &Delivery, value: &Value) -> Result<String, Error> {
    let r: xharness_remote::ControllerAutomationRead =
        serde_json::from_value(value.clone()).map_err(|_| Error::Invalid("automation result"))?;
    if !r.is_for_delivery(delivery) {
        return Err(Error::Invalid("automation scope result"));
    }
    let mut text = format!("Saved automations — session {}\n", delivery.binding.session);
    if r.page.entries.is_empty() {
        append(&mut text, "No active saved automations in this page.\n")?;
    }
    for entry in &r.page.entries {
        let state = serde_json::to_value(entry.state)?
            .as_str()
            .ok_or(Error::Invalid("automation state"))?
            .to_owned();
        let mode = serde_json::to_value(entry.mode)?
            .as_str()
            .ok_or(Error::Invalid("automation mode"))?
            .to_owned();
        let target = serde_json::to_value(entry.target)?
            .as_str()
            .ok_or(Error::Invalid("automation target"))?
            .to_owned();
        append(&mut text,&format!("\nAutomation ID: {}\nState: {state}; mode: {mode}; target: {target}\nScheduled at: {}\nPrompt{}: {}\n",entry.id,entry.scheduled_at,if entry.prompt_is_preview {" preview"}else{""},serde_json::to_string(&entry.prompt)?))?;
        if let Some(seconds) = entry.every_seconds {
            append(&mut text, &format!("Every {seconds} seconds\n"))?;
        }
        for action in ["view", "pause", "resume", "delete"] {
            append(
                &mut text,
                &format!(
                    "{action}: /automation {}\n",
                    serde_json::to_string(&serde_json::json!({"action":action,"id":entry.id}))?
                ),
            )?;
        }
    }
    if let Some(detail) = r.page.detail {
        append(&mut text,&format!("\nRuns: {} total; {} native admissions. Latest {} run receipts shown. Admission is not completion.\n",detail.run_count,detail.admitted_run_count,detail.runs.len()))?;
        for run in detail.runs {
            let state = serde_json::to_value(run.state)?
                .as_str()
                .ok_or(Error::Invalid("automation run state"))?
                .to_owned();
            append(
                &mut text,
                &format!(
                    "Run ID: {}; occurrence: {}; state: {state}\n",
                    run.id, run.occurrence_at
                ),
            )?;
        }
    }
    if let Some(next) = r.page.next {
        append(
            &mut text,
            &format!(
                "\nNext: /automations {}",
                serde_json::to_string(&serde_json::json!({"after":next}))?
            ),
        )?;
    }
    Ok(text)
}
fn automation_control(delivery: &Delivery, value: &Value) -> Result<String, Error> {
    let r: xharness_remote::ControllerAutomationControl = serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("automation control receipt"))?;
    if !r.is_for_delivery(delivery) {
        return Err(Error::Invalid("automation control scope"));
    }
    let state = serde_json::to_value(r.applied.state)?
        .as_str()
        .ok_or(Error::Invalid("automation control state"))?
        .to_owned();
    Ok(format!("Saved automation control recorded: {state}.\nAutomation ID: {}\nThis is the original operation receipt, not a current-state snapshot. Pause/delete affect future triggers; admitted runs were not cancelled.\nInspect: /automation {}",r.applied.control.id(),serde_json::to_string(&serde_json::json!({"action":"view","id":r.applied.control.id()}))?))
}
pub fn format_command_reply(delivery: &Delivery) -> Result<Vec<ReplyPlan>, Error> {
    let tag = state_tag(&delivery.state)?;
    let mut media = Vec::new();
    let text=match delivery.state {
        DeliveryState::Uncertain=>"Command outcome is unknown. Do not resend; reconcile it in desktop settings.".into(),
        DeliveryState::Rejected=>"Request was not applied. Check its scope or native pending state in the desktop.".into(),
        DeliveryState::Abandoned=>"Request was abandoned after desktop review; it was not retried.".into(),
        DeliveryState::Completed if delivery.reason.as_deref()==Some("manually-observed-accepted")=>"Request was reconciled by the desktop owner; no replay was performed.".into(),
        DeliveryState::Completed=>match &delivery.result {
            Some(NativeCommandResult::Success{value:Some(value)})=>match &delivery.inbound.command {
                Command::CreateSession{..}=>serde_json::from_value::<xharness_remote::ControllerCreated>(value.clone()).ok().filter(|r|r.is_for_delivery(delivery)).map(|r|format!("Session created and granted. The current session was not changed.\nWorkspace ID: {}\nSession ID: {}\nSelect: /select {}",r.created.workspace,r.created.session,serde_json::to_string(&xharness_remote::SessionSelection{workspace:r.created.workspace.clone(),session:r.created.session.clone()}).expect("closed selection JSON"))).unwrap_or_else(||"Session creation receipt is unavailable or invalid. Inspect the desktop; do not resend.".into()),
                Command::Select{..}=>serde_json::from_value::<xharness_remote::ControllerSelection>(value.clone()).ok().filter(|s|s.is_for_delivery(delivery)).map(|s|format!("Session selected.\nWorkspace ID: {}\nSession ID: {}\nBinding generation: {}\nExisting tasks were not cancelled or replayed; history is available with /history.",s.binding.workspace,s.binding.session,s.binding.generation)).unwrap_or_else(||"Session selection receipt is unavailable or invalid. Reload the route in the desktop; do not resend.".into()),
                Command::AutomationRead{..}=>automation_read(delivery,value).unwrap_or_else(|_|"Saved automation view is unavailable, invalid or exceeds the reply budget. Inspect the native desktop; no partial view was returned.".into()),
                Command::AutomationControl{..}=>automation_control(delivery,value).unwrap_or_else(|_|"Saved automation control receipt is unavailable or invalid. Inspect the native desktop; do not resend the control.".into()),
                Command::Catalogue{after}=>catalogue(delivery,value,after.as_ref()).unwrap_or_else(|_|"Session listing is unavailable or invalid; no partial listing was returned. Refresh your scope in the desktop.".into()),
                Command::History{before_seq,max_messages}=>match history(delivery,value,*before_seq,*max_messages) {
                    Ok(text)=>{
                        let planned=value["events"].as_array().ok_or(Error::Invalid("history media events")).and_then(|events|{
                            let mut plans=Vec::new();
                            for entry in events {plans.extend(crate::media::event_plans(&entry["event"],&format!("command-result:{}:{tag}",delivery.key),true)?);if plans.len()>MAX_REPLY_BATCH {return Err(Error::Capacity);}}
                            Ok(plans)
                        });
                        match planned {
                            Ok(plans)=>{media=plans;text},
                            Err(Error::Capacity)=>"History exceeds the reply budget. Request fewer messages; nothing was truncated.".into(),
                            Err(_)=>"Native history attachment reference is unavailable or unsupported. Inspect the native session; the command was not replayed.".into(),
                        }
                    },
                    Err(Error::Capacity)=>"History exceeds the reply budget. Request fewer messages or inspect the native session; no text was truncated.".into(),
                    Err(_)=>"Native history response is unavailable or unsupported. Inspect the native session; the command was not replayed.".into(),
                },
                Command::Prompt{..}|Command::Cancel|Command::AnswerInteraction{..} if value["accepted"]==true => match delivery.inbound.command {
                    Command::Prompt{..}=>"Prompt accepted. Task completion is reported separately.".into(),
                    Command::Cancel=>"Cancellation request accepted. This is not proof that a task completed.".into(),
                    _=>"Native response recorded.".into(),
                },
                _=>"Native command receipt is unavailable or unsupported. Inspect the desktop session.".into(),
            },
            Some(NativeCommandResult::Failure{..})=>"Native command failed. Inspect the desktop session for details; it was not automatically retried.".into(),
            _=>"Native command receipt is unavailable. Inspect the desktop session.".into(),
        },
        _=>return Err(Error::Invalid("command state")),
    };
    let mut parts = split_text(&text);
    if parts.len().saturating_add(media.len()) > MAX_REPLY_BATCH {
        media.clear();
        parts = vec![
            "History exceeds the reply budget. Request fewer messages; nothing was truncated."
                .into(),
        ];
    }
    let mut plans: Vec<ReplyPlan> = parts
        .into_iter()
        .enumerate()
        .map(|(index, text)| ReplyPlan {
            id: format!("command-result:{}:{tag}:{index}", delivery.key),
            body: ReplyBody {
                attachment: None,
                text,
                buttons: vec![],
            },
            replace_of: None,
        })
        .collect();
    plans.extend(media);
    Ok(plans)
}
pub(crate) async fn sync_command_replies(
    gateway: &Gateway,
    lease: &AccountLease,
    scope: Subscription,
) -> Result<(), Error> {
    if let Some(delivery) = gateway
        .command_reply_candidate(lease, scope.clone())
        .await?
    {
        let plans = format_command_reply(&delivery)?;
        gateway
            .enqueue_command_replies(lease, scope, delivery, plans)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use xharness_remote::{Binding, Content, Inbound, PromptMode};
    fn delivery(value: Value) -> Delivery {
        Delivery {
            sequence: 1,
            key: "fixture-key".into(),
            principal: "p".into(),
            principal_revision: 1,
            binding: Binding {
                id: "b".into(),
                principal: "p".into(),
                conversation: "42".into(),
                workspace: "w".into(),
                session: "s".into(),
                generation: 1,
            },
            inbound: Inbound {
                request_id: "one".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::History {
                    before_seq: None,
                    max_messages: 25,
                },
            },
            state: DeliveryState::Completed,
            result: Some(NativeCommandResult::success(value)),
            reason: None,
        }
    }
    fn entry(seq: u64, kind: &str, data: Value) -> Value {
        json!({"event":{"seq":seq,"type":kind,"data":data},"view":{"private":"PRIVATE_VIEW"}})
    }
    fn message(role: &str, text: &str) -> Value {
        json!({"role":role,"content":[{"type":"reasoning","text":"PRIVATE_REASONING"},{"type":"text","text":text}]})
    }
    fn text(plans: &[ReplyPlan]) -> String {
        plans.iter().map(|p| p.body.text.as_str()).collect()
    }
    #[test]
    fn explicit_history_is_unicode_lossless_and_paginates_native_cut_without_private_details() {
        let long = "你好 🧪\n".repeat(4000);
        let d = delivery(
            json!({"events":[entry(10,"user/message",message("user","genuine user")),entry(12,"assistant/message",json!({"turn":0,"step":0,"message":message("assistant",&long)})),entry(13,"tool/call",json!({"name":"fixture","arguments":"PRIVATE_ARGS"})),entry(14,"tool/result",json!({"message":{"content":[{"type":"tool-result","isError":true,"content":[{"type":"text","text":"PRIVATE_STDOUT"}]}]}}))],"hasMore":true,"projections":{"private":"PRIVATE_METADATA"}}),
        );
        let plans = format_command_reply(&d).unwrap();
        let all = text(&plans);
        assert!(all.contains(&long));
        assert!(all.contains("genuine user"));
        assert!(all.ends_with("Earlier history: /history 25 10"));
        assert!(!all.contains("PRIVATE_"));
        assert!(plans.len() > 1);
        assert!(plans
            .iter()
            .all(|p| p.body.text.encode_utf16().count() <= 4096
                && p.body.buttons.is_empty()
                && p.replace_of.is_none()));
        assert_eq!(format_command_reply(&d).unwrap(), plans);
    }
    #[test]
    fn history_final_text_supersedes_chunks_and_known_nontext_never_leaks() {
        let d = delivery(
            json!({"events":[entry(1,"assistant/chunk",json!({"turn":0,"step":0,"chunk":{"type":"text-delta","text":"partial-secret-marker"}})),entry(2,"assistant/chunk",json!({"turn":0,"step":0,"chunk":{"type":"provider","item":"PRIVATE_PROVIDER"}})),entry(3,"assistant/message",json!({"turn":0,"step":0,"message":message("assistant","canonical final")}))],"hasMore":false}),
        );
        let all = text(&format_command_reply(&d).unwrap());
        assert!(all.contains("canonical final"));
        assert!(!all.contains("partial-secret-marker"));
        assert!(!all.contains("PRIVATE_"));
        assert!(all.ends_with("Beginning of history reached."));
    }
    #[test]
    fn oversize_or_invalid_history_replies_are_closed_failures_not_truncated_success() {
        let oversized = vec![entry(
            1,
            "user/message",
            message("user", &"x".repeat(MAX_HISTORY_TEXT + 1)),
        )];
        let out_of_order = vec![
            entry(2, "user/message", message("user", "PRIVATE_TEXT")),
            entry(1, "user/message", message("user", "PRIVATE_TEXT")),
        ];
        for events in [oversized, out_of_order] {
            let d = delivery(json!({"events":events,"hasMore":false}));
            let all = text(&format_command_reply(&d).unwrap());
            assert!(!all.contains("PRIVATE_TEXT"));
            assert!(!all.starts_with("History —"));
        }
        let mut d = delivery(
            json!({"events":[entry(10,"user/message",message("user","PRIVATE_TEXT"))],"hasMore":true}),
        );
        d.inbound.command = Command::History {
            before_seq: Some(10),
            max_messages: 25,
        };
        assert!(!text(&format_command_reply(&d).unwrap()).contains("PRIVATE_TEXT"));
    }
    #[test]
    fn history_media_is_explicit_without_paths_or_tool_stdout_and_malformed_results_do_not_claim_success(
    ) {
        let value = json!({"events":[entry(10,"user/message",json!({"role":"user","content":[{"type":"image","attachment":{"attachmentId":"a".repeat(64),"path":"PRIVATE_PATH"}}]})),entry(11,"tool/result",json!({"message":{"content":[{"type":"tool-result","isError":false,"content":[{"type":"image","attachment":{"attachmentId":"a".repeat(64),"path":"PRIVATE_PATH"}},{"type":"text","text":"PRIVATE_STDOUT"}]}]}}))],"hasMore":false});
        let all = text(&format_command_reply(&delivery(value)).unwrap());
        assert!(all.contains("Attachment queued separately"));
        assert!(all.contains("Tool finished; attachment queued separately"));
        assert!(!all.contains("PRIVATE_"));
        let value = json!({"events":[entry(1,"tool/result",json!({"message":{"content":[{"type":"text","text":"PRIVATE_STDOUT"}]}}))],"hasMore":false});
        let all = text(&format_command_reply(&delivery(value)).unwrap());
        assert!(!all.contains("Tool finished"));
        assert!(!all.contains("PRIVATE_STDOUT"));
    }
    #[test]
    fn native_admission_cancel_failure_uncertainty_and_reconciliation_are_not_task_completion() {
        let mut d = delivery(json!({"accepted":true}));
        d.inbound.command = Command::Prompt {
            mode: PromptMode::Queue,
            content: vec![Content::Text {
                text: "PRIVATE_PROMPT".into(),
            }],
            client_time_zone: None,
        };
        assert_eq!(
            text(&format_command_reply(&d).unwrap()),
            "Prompt accepted. Task completion is reported separately."
        );
        d.inbound.command = Command::Cancel;
        assert!(
            text(&format_command_reply(&d).unwrap()).starts_with("Cancellation request accepted.")
        );
        d.result = Some(NativeCommandResult::success(json!({"accepted":false})));
        assert!(
            !text(&format_command_reply(&d).unwrap()).starts_with("Cancellation request accepted.")
        );
        d.result=Some(serde_json::from_value(json!({"ok":false,"error":{"code":"internal","message":"PRIVATE_PROVIDER_ERROR","details":{"private":"PRIVATE_DETAILS"}}})).unwrap());
        let failed = text(&format_command_reply(&d).unwrap());
        assert!(failed.starts_with("Native command failed."));
        assert!(!failed.contains("PRIVATE_"));
        d.state = DeliveryState::Uncertain;
        let unknown = format_command_reply(&d).unwrap();
        assert!(text(&unknown).contains("unknown"));
        d.state = DeliveryState::Completed;
        d.reason = Some("manually-observed-accepted".into());
        let reconciled = format_command_reply(&d).unwrap();
        assert!(text(&reconciled).contains("no replay"));
        assert_ne!(unknown[0].id, reconciled[0].id);
        d.state = DeliveryState::Queued;
        assert!(format_command_reply(&d).is_err());
    }
    #[test]
    fn catalogue_titles_are_explicit_previews_but_every_id_and_cursor_is_exact() {
        let title = "你好 🧪\n".repeat(200);
        let sessions=(0..25).map(|n|json!({"workspace":"w","id":format!("s-{n:02}-{}","x".repeat(490)),"title":title,"running":n==0,"restoring":n==1})).collect::<Vec<_>>();
        let cursor = json!({"workspace":"w","session":sessions[24]["id"]});
        let mut d = delivery(
            json!({"principal_revision":1,"binding_generation":1,"catalogue":{"workspaces":[{"id":"w","title":title},{"id":"w-unused","title":"UNUSED_TITLE"}],"sessions":sessions,"next":cursor}}),
        );
        d.binding.session = sessions[0]["id"].as_str().unwrap().into();
        d.inbound.command = Command::Catalogue { after: None };
        let plans = format_command_reply(&d).unwrap();
        let all = text(&plans);
        assert!(all.starts_with("Sessions — authorized page"));
        assert!(all.contains("Titles are previews"));
        assert!(all.contains('…'));
        assert!(all.contains("[current] [running]"));
        assert!(all.contains("[restoring]"));
        assert!(!all.contains("UNUSED_TITLE"));
        assert!(all.ends_with(&format!(
            "Next page: /sessions {}",
            serde_json::to_string(
                &serde_json::from_value::<xharness_remote::CatalogueCursor>(cursor.clone())
                    .unwrap()
            )
            .unwrap()
        )));
        for session in &sessions {
            assert!(all.contains(session["id"].as_str().unwrap()));
        }
        assert!(plans.len() > 1 && plans.len() <= MAX_REPLY_BATCH);
        assert!(plans
            .iter()
            .all(|p| p.body.text.encode_utf16().count() <= 4096
                && p.body.buttons.is_empty()
                && p.body.attachment.is_none()
                && p.replace_of.is_none()));
        assert_eq!(format_command_reply(&d).unwrap(), plans);
    }
    #[test]
    fn catalogue_result_is_closed_versioned_and_ordered_not_a_raw_directory_dump() {
        let original = json!({"principal_revision":1,"binding_generation":1,"catalogue":{"workspaces":[{"id":"w","title":"Native"}],"sessions":[{"workspace":"w","id":"s","title":"PRIVATE_BAD_RESULT","running":false,"restoring":false}],"next":null}});
        let mut cases = vec![];
        for (key, value) in [
            ("principal_revision", json!(2)),
            ("binding_generation", json!(2)),
            ("path", json!("PRIVATE_PATH")),
        ] {
            let mut v = original.clone();
            v[key] = value;
            cases.push(v);
        }
        let mut v = original.clone();
        v["catalogue"]["sessions"][0]["workspace"] = json!("foreign");
        cases.push(v);
        let mut v = original.clone();
        v["catalogue"]["sessions"][0]["title"] = json!("\0");
        cases.push(v);
        let mut v = original.clone();
        v["catalogue"]["sessions"][0]["cwd"] = json!("PRIVATE_PATH");
        cases.push(v);
        let mut v = original.clone();
        v["catalogue"]["next"] = json!({"workspace":"w","session":"s"});
        cases.push(v);
        let mut v = original.clone();
        v["catalogue"]["sessions"] = json!(vec![original["catalogue"]["sessions"][0].clone(); 26]);
        cases.push(v);
        for value in cases {
            let mut d = delivery(value);
            d.inbound.command = Command::Catalogue { after: None };
            let all = text(&format_command_reply(&d).unwrap());
            assert!(!all.starts_with("Sessions —"));
            assert!(!all.contains("PRIVATE_"));
        }
        let mut d = delivery(original);
        d.inbound.command = Command::Catalogue {
            after: Some(xharness_remote::CatalogueCursor {
                workspace: "w".into(),
                session: "s".into(),
            }),
        };
        assert!(!text(&format_command_reply(&d).unwrap()).contains("PRIVATE_BAD_RESULT"));
        d.result = Some(NativeCommandResult::success(
            json!({"principal_revision":1,"binding_generation":1,"catalogue":{"workspaces":[{"id":"w","title":"Native"}],"sessions":[],"next":null}}),
        ));
        assert!(
            text(&format_command_reply(&d).unwrap()).contains("No accessible unarchived sessions")
        );
    }
    #[test]
    fn selection_receipt_certifies_exact_old_and_new_binding_not_generic_success() {
        let mut d = delivery(json!({"accepted":true}));
        d.inbound.command = Command::Select {
            target: xharness_remote::SessionSelection {
                workspace: "w2".into(),
                session: "t".into(),
            },
        };
        let mut selected = d.binding.clone();
        selected.workspace = "w2".into();
        selected.session = "t".into();
        selected.generation = 2;
        let receipt = xharness_remote::ControllerSelection {
            principal_revision: 1,
            previous_binding: d.binding.clone(),
            binding: selected,
        };
        let good = serde_json::to_value(receipt).unwrap();
        for value in [
            json!({"accepted":true}),
            json!({}),
            {
                let mut v = good.clone();
                v["binding"]["generation"] = json!(1);
                v
            },
            {
                let mut v = good.clone();
                v["binding"]["principal"] = json!("PRIVATE_FOREIGN");
                v
            },
            {
                let mut v = good.clone();
                v["principal_revision"] = json!(2);
                v
            },
            {
                let mut v = good.clone();
                v["cwd"] = json!("PRIVATE_PATH");
                v
            },
        ] {
            d.result = Some(NativeCommandResult::success(value));
            let all = text(&format_command_reply(&d).unwrap());
            assert!(!all.starts_with("Session selected."));
            assert!(!all.contains("PRIVATE_"));
        }
        d.result = Some(NativeCommandResult::success(good));
        let plans = format_command_reply(&d).unwrap();
        let all = text(&plans);
        assert!(all.starts_with("Session selected."));
        assert!(all.contains("Session ID: t"));
        assert!(all.contains("Binding generation: 2"));
        assert_eq!(d.binding.session, "s");
        assert!(plans.iter().all(|p| p.body.buttons.is_empty()
            && p.body.attachment.is_none()
            && p.replace_of.is_none()));
    }
    #[test]
    fn creation_reply_is_exact_revision_transition_not_accepted_or_selected_by_guess() {
        let mut d = delivery(json!({"accepted":true}));
        d.inbound.command = Command::CreateSession {
            workspace: "w".into(),
        };
        // Exercise the public gateway DTO as a closed wire receipt, without
        // crossing the channel crate's remote-only architecture boundary.
        let session = format!("remote-{}", "a".repeat(64));
        let created: xharness_remote::ControllerCreated = serde_json::from_value(json!({
            "previous_revision": 1,
            "principal_revision": 2,
            "binding": d.binding,
            "created": {"workspace":"w", "session":session, "request_key":"a".repeat(64)}
        }))
        .unwrap();
        let good = serde_json::to_value(created).unwrap();
        for v in [
            json!({"accepted":true}),
            json!({}),
            {
                let mut v = good.clone();
                v["principal_revision"] = json!(1);
                v
            },
            {
                let mut v = good.clone();
                v["previous_revision"] = json!(2);
                v
            },
            {
                let mut v = good.clone();
                v["binding"]["generation"] = json!(2);
                v
            },
            {
                let mut v = good.clone();
                v["created"]["session"] = json!("PRIVATE_FOREIGN");
                v
            },
            {
                let mut v = good.clone();
                v["cwd"] = json!("PRIVATE_PATH");
                v
            },
        ] {
            d.result = Some(NativeCommandResult::success(v));
            let all = text(&format_command_reply(&d).unwrap());
            assert!(!all.starts_with("Session created and granted."));
            assert!(!all.contains("PRIVATE_"));
        }
        d.result = Some(NativeCommandResult::success(good));
        let plans = format_command_reply(&d).unwrap();
        let all = text(&plans);
        assert!(all.starts_with("Session created and granted."));
        assert!(all.contains("current session was not changed"));
        assert!(all.ends_with(&format!(
            "Select: /select {}",
            serde_json::to_string(&xharness_remote::SessionSelection {
                workspace: "w".into(),
                session: session.clone()
            })
            .unwrap()
        )));
        assert!(plans.iter().all(|p| p.body.buttons.is_empty()
            && p.body.attachment.is_none()
            && p.replace_of.is_none()));
    }
    fn saved_read_delivery(prompt: &str, list: bool) -> Delivery {
        let read = if list {
            xharness_remote::AutomationRead::List { after: None }
        } else {
            xharness_remote::AutomationRead::View {
                id: "提醒 🧪".into(),
            }
        };
        let mut d = delivery(
            json!({"principal_revision":1,"binding_generation":1,"page":{"workspace":"w","session":"s","read":read,"entries":[{"id":"提醒 🧪","prompt":prompt,"prompt_is_preview":list,"kind":"after","mode":"reminder","target":"current_chat","state":"scheduled","scheduled_at":"2026-10-10T00:00:00.000Z","after_seconds":3600,"every_seconds":null}],"next":null,"detail":if list {Value::Null} else {json!({"runs":[{"id":"run-1","occurrence_at":"2026-10-10T00:00:00.000Z","state":"queued"}],"run_count":1,"admitted_run_count":1})}}}),
        );
        d.inbound.command = Command::AutomationRead { read };
        d
    }
    #[test]
    fn saved_automation_view_is_lossless_unicode_plain_text_and_closed_run_metadata() {
        let prompt = "你好 🧪\n".repeat(3000);
        let d = saved_read_delivery(&prompt, false);
        let plans = format_command_reply(&d).unwrap();
        let all = text(&plans);
        assert!(all.contains(&serde_json::to_string(&prompt).unwrap()));
        assert!(all.contains("Admission is not completion"));
        assert!(all.contains("Run ID: run-1"));
        assert!(plans.len() > 1);
        assert!(plans.iter().all(|p| p.body.buttons.is_empty()
            && p.body.attachment.is_none()
            && p.body.text.encode_utf16().count() <= 4096));
        let list = saved_read_delivery("preview 🧪", true);
        let all = text(&format_command_reply(&list).unwrap());
        assert!(all.contains("Prompt preview:"));
        assert!(all.contains("/automation {\"action\":\"pause\",\"id\":\"提醒 🧪\"}"));
    }
    #[test]
    fn saved_automation_foreign_versions_extra_fields_and_oversize_fail_closed_without_partial_text(
    ) {
        let d = saved_read_delivery("PRIVATE_PROMPT", false);
        for (path, value) in [
            (vec!["page", "session"], json!("foreign")),
            (vec!["principal_revision"], json!(2)),
            (vec!["binding_generation"], json!(2)),
            (
                vec!["page", "detail", "private"],
                json!("PRIVATE_DIAGNOSTIC"),
            ),
        ] {
            let mut bad = d.clone();
            let Some(NativeCommandResult::Success {
                value: Some(ref mut v),
            }) = bad.result
            else {
                panic!("fixture")
            };
            let mut dest = v;
            for key in path {
                dest = &mut dest[key];
            }
            *dest = value;
            let all = text(&format_command_reply(&bad).unwrap());
            assert!(all.contains("unavailable"));
            assert!(!all.contains("PRIVATE_"));
        }
        let long = saved_read_delivery(&"x".repeat(200_000), false);
        let plans = format_command_reply(&long).unwrap();
        assert_eq!(plans.len(), 1);
        assert!(text(&plans).contains("no partial view"));
        assert!(!text(&plans).contains("xxxxx"));
    }
    #[test]
    fn saved_control_receipt_is_historical_not_completion_and_rejects_generic_acceptance() {
        let mut d = delivery(
            json!({"principal_revision":1,"binding_generation":1,"applied":{"workspace":"w","session":"s","request_key":"a".repeat(64),"control":{"action":"pause","id":"saved"},"state":"paused"}}),
        );
        d.inbound.command = Command::AutomationControl {
            control: xharness_remote::AutomationControl::Pause { id: "saved".into() },
        };
        let all = text(&format_command_reply(&d).unwrap());
        assert!(all.contains("original operation receipt, not a current-state snapshot"));
        assert!(all.contains("admitted runs were not cancelled"));
        assert!(!all.contains(&"a".repeat(64)));
        d.result = Some(NativeCommandResult::success(
            json!({"accepted":true,"private":"PRIVATE_RAW"}),
        ));
        let all = text(&format_command_reply(&d).unwrap());
        assert!(all.contains("unavailable"));
        assert!(!all.contains("PRIVATE_RAW"));
        d.result = Some(NativeCommandResult::failure(
            serde_json::from_value(
                json!({"code":"internal","message":"PRIVATE_ERROR","details":null}),
            )
            .unwrap(),
        ));
        let all = text(&format_command_reply(&d).unwrap());
        assert!(!all.contains("PRIVATE_ERROR"));
    }
}
