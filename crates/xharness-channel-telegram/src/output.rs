//! Durable native event projection. No Agent, global RPC, reasoning or raw diagnostics.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::replies::split_text;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use xharness_remote::{
    AccountLease, Error, Gateway, ProjectedReply, ProjectionCheckpoint, ProjectionUpdate,
    ReplyBody, ReplyPlan, ReplyState, ScopedEventPage, Subscription, MAX_REPLY_BATCH,
};
const MAX_TEXT: usize = 200_000;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    streams: BTreeMap<String, Assistant>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assistant {
    turn: u64,
    step: u64,
    last_seq: u64,
    text: String,
    complete: bool,
    interrupted: bool,
    parts: Vec<String>,
}
fn coordinate(data: &Value) -> Result<(u64, u64), Error> {
    Ok((
        data["turn"].as_u64().ok_or(Error::Invalid("output turn"))?,
        data["step"].as_u64().ok_or(Error::Invalid("output step"))?,
    ))
}
fn stream_key(turn: u64, step: u64) -> String {
    format!("{turn:020}:{step:020}")
}
fn slot(key: &str, index: usize) -> String {
    format!("assistant:{key}:{index}")
}
fn safe_text(text: &str) -> Result<(), Error> {
    if text.len() > MAX_TEXT {
        return Err(Error::Capacity);
    }
    if text.contains('\0') {
        return Err(Error::Invalid("output text"));
    }
    Ok(())
}
fn display_name(value: &Value) -> Result<&str, Error> {
    let name = value.as_str().ok_or(Error::Invalid("tool output name"))?;
    if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
        return Err(Error::Invalid("tool output name"));
    }
    Ok(name)
}
fn reduce(
    mut state: State,
    cp: &ProjectionCheckpoint,
    page: &ScopedEventPage,
    take: usize,
) -> Result<ProjectionUpdate, Error> {
    let mut notices = Vec::<(u64, String)>::new();
    let mut media = Vec::new();
    for frame in page.events.iter().take(take) {
        let event = &frame.payload["event"];
        let seq = event["seq"]
            .as_u64()
            .ok_or(Error::Invalid("output sequence"))?;
        let data = &event["data"];
        media.extend(
            crate::media::event_plans(event, &format!("output:{}", cp.key), false)?
                .into_iter()
                .map(|plan| (seq, plan)),
        );
        match event["type"]
            .as_str()
            .ok_or(Error::Invalid("output event kind"))?
        {
            "assistant/chunk" | "assistant/message" => {
                let (turn, step) = coordinate(data)?;
                let key = stream_key(turn, step);
                let is_final = event["type"] == "assistant/message";
                if !is_final
                    && matches!(
                        data["chunk"]["type"].as_str(),
                        Some(
                            "reasoning-delta" | "tool-call-delta" | "usage" | "finish" | "provider"
                        )
                    )
                {
                    continue;
                }
                let entry = state.streams.entry(key).or_insert_with(|| Assistant {
                    turn,
                    step,
                    last_seq: seq,
                    text: String::new(),
                    complete: false,
                    interrupted: false,
                    parts: vec![],
                });
                entry.last_seq = seq;
                if is_final {
                    if data["message"]["role"] != "assistant" {
                        return Err(Error::Invalid("output message role"));
                    }
                    let content = data["message"]["content"]
                        .as_array()
                        .ok_or(Error::Invalid("output content"))?;
                    if content.len() > 128 {
                        return Err(Error::Capacity);
                    }
                    let mut text = String::new();
                    for block in content {
                        match block["type"].as_str() {
                            Some("text") => text.push_str(
                                block["text"]
                                    .as_str()
                                    .ok_or(Error::Invalid("output message text"))?,
                            ),
                            Some("reasoning") => {}
                            Some("image" | "file") => {
                                text.push_str("\n[Attachment queued separately]\n")
                            }
                            _ => return Err(Error::Invalid("unsupported assistant output block")),
                        }
                    }
                    entry.text = text;
                    entry.complete = true;
                    entry.interrupted = data["interrupted"].as_bool().unwrap_or(false);
                } else {
                    if data["chunk"]["type"] != "text-delta" {
                        return Err(Error::Invalid("unsupported assistant output chunk"));
                    }
                    entry.text.push_str(
                        data["chunk"]["text"]
                            .as_str()
                            .ok_or(Error::Invalid("output delta text"))?,
                    );
                }
                safe_text(&entry.text)?;
            }
            "tool/call" => notices.push((
                seq,
                format!("Tool started: {}", display_name(&data["name"])?),
            )),
            "tool/result" => {
                let content = data["message"]["content"]
                    .as_array()
                    .ok_or(Error::Invalid("tool output shape"))?;
                let failed = content.iter().any(|b| b["isError"] == true);
                let media = content
                    .iter()
                    .filter_map(|b| b["content"].as_array())
                    .flatten()
                    .any(|b| matches!(b["type"].as_str(), Some("image" | "file")));
                notices.push((
                    seq,
                    format!(
                        "Tool {}{}",
                        if failed { "failed" } else { "finished" },
                        if media {
                            "; attachment queued separately"
                        } else {
                            ""
                        }
                    ),
                ));
            }
            "turn/start" => notices.push((seq, "Task started".into())),
            "turn/end" => {
                let text = match data["reason"]["kind"].as_str() {
                    Some("completed") => "Task completed",
                    Some("cancelled") => "Task cancelled",
                    Some("max-tokens") => "Task stopped: output-token limit",
                    Some("max-steps") => "Task stopped: step limit",
                    Some("error") => "Task failed; inspect the native session for details",
                    _ => return Err(Error::Invalid("output turn end shape")),
                };
                notices.push((seq, text.into()));
            }
            _ => {} // Typed native lifecycle/metadata facts are cursor-only, never raw JSON replies.
        }
    }
    if state.streams.len() > 32 {
        return Err(Error::Capacity);
    }
    let next = page.start_seq + take as u64;
    let mut ordered = Vec::<(u64, ProjectedReply)>::new();
    let mut retain = BTreeSet::new();
    for (key, stream) in &mut state.streams {
        if stream.text.is_empty() && !stream.complete {
            continue;
        }
        let header = if stream.complete {
            "Assistant response\n"
        } else {
            "Assistant (streaming)\n"
        };
        let text = format!(
            "{header}{}{}",
            if stream.text.is_empty() {
                "[No text response]"
            } else {
                &stream.text
            },
            if stream.interrupted {
                "\n[Interrupted]"
            } else {
                ""
            }
        );
        let chunks = split_text(&text);
        if chunks.len() > MAX_REPLY_BATCH {
            return Err(Error::Capacity);
        }
        let count = chunks.len().max(stream.parts.len());
        for index in 0..count {
            let label = slot(key, index);
            let body = chunks.get(index).cloned().unwrap_or_else(|| {
                "Earlier streaming segment superseded by the final response.".into()
            });
            if !stream.complete && index < chunks.len() {
                retain.insert(label.clone());
            }
            if stream.parts.get(index) == Some(&body) {
                continue;
            }
            ordered.push((
                stream.last_seq,
                ProjectedReply {
                    slot: (!stream.complete).then_some(label.clone()),
                    plan: ReplyPlan {
                        id: format!("output:{}:{next}:{label}", cp.key),
                        body: ReplyBody {
                            attachment: None,
                            text: body,
                            buttons: vec![],
                        },
                        replace_of: cp.links.get(&label).cloned(),
                    },
                },
            ));
        }
        stream.parts = chunks;
    }
    for (seq, text) in notices {
        ordered.push((
            seq,
            ProjectedReply {
                slot: None,
                plan: ReplyPlan {
                    id: format!("output:{}:notice:{seq}", cp.key),
                    body: ReplyBody {
                        attachment: None,
                        text,
                        buttons: vec![],
                    },
                    replace_of: None,
                },
            },
        ));
    }
    for (seq, plan) in media {
        ordered.push((seq, ProjectedReply { slot: None, plan }));
    }
    ordered.sort_by_key(|(seq, _)| *seq);
    let replies = ordered.into_iter().map(|(_, r)| r).collect::<Vec<_>>();
    if replies.len() > MAX_REPLY_BATCH {
        return Err(Error::Capacity);
    }
    state.streams.retain(|_, s| !s.complete);
    state.version = 1;
    Ok(ProjectionUpdate {
        next_seq: next,
        state: serde_json::to_value(state)?,
        retain,
        replies,
    })
}
/// Coalesce raw durable deltas, then render only changed parts. If one batch
/// would exceed the outbox limit, commit a smaller contiguous prefix, not a gap.
pub fn format_output(
    cp: &ProjectionCheckpoint,
    page: &ScopedEventPage,
) -> Result<ProjectionUpdate, Error> {
    let state = if cp.state.is_null() {
        State {
            version: 1,
            ..State::default()
        }
    } else {
        serde_json::from_value::<State>(cp.state.clone())?
    };
    if state.version != 1 || state.streams.len() > 32 {
        return Err(Error::Invalid("output formatter state version"));
    }
    for stream in state.streams.values() {
        safe_text(&stream.text)?;
        if stream.parts.len() > 64 {
            return Err(Error::Capacity);
        }
    }
    if page.start_seq != cp.next_seq || page.events.is_empty() {
        return Err(Error::Invalid("output page cursor"));
    }
    for take in (1..=page.events.len()).rev() {
        match reduce(state.clone(), cp, page, take) {
            Ok(update) => return Ok(update),
            Err(Error::Capacity) if take > 1 => {}
            Err(error) => return Err(error),
        }
    }
    Err(Error::Capacity)
}
/// Owns no provider send. Unknown sending receipts pause projection; they never
/// advance by replaying an Agent or by guessing an edit target.
pub(crate) async fn sync_output(
    gateway: &Gateway,
    lease: &AccountLease,
    scope: Subscription,
) -> Result<(), Error> {
    let checkpoint = gateway.projection_checkpoint(lease, scope.clone()).await?;
    for key in &checkpoint.pending {
        let record = gateway
            .inspect_reply(key)
            .await?
            .ok_or(Error::Invalid("missing projection outgoing receipt"))?;
        match record.state {
            ReplyState::Delivered => {}
            ReplyState::Pending | ReplyState::Sending | ReplyState::Uncertain => return Ok(()),
            ReplyState::Rejected | ReplyState::Abandoned => {
                return Err(Error::Invalid("projection predecessor not delivered"))
            }
        }
    }
    let page = gateway
        .read_event_page(lease, scope.clone(), Some(checkpoint.next_seq))
        .await?;
    if page.events.is_empty() {
        return Ok(());
    }
    let update = format_output(&checkpoint, &page)?;
    gateway
        .advance_projection(lease, scope, checkpoint, update)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn checkpoint() -> ProjectionCheckpoint {
        ProjectionCheckpoint {
            key: "fixture".into(),
            revision: 1,
            next_seq: 0,
            state: Value::Null,
            links: BTreeMap::new(),
            pending: vec![],
        }
    }
    fn page(events: Vec<Value>, start: u64) -> ScopedEventPage {
        let next = start + events.len() as u64;
        let frames=events.into_iter().enumerate().map(|(i,event)| {
            // ServerRequest is carried by the Remote API; no direct API dependency in production.
            let mut frame=serde_json::json!({"type":"server-request","rpcId":format!("e-{}",start+i as u64),"method":"session/event","payload":{"type":"session/event","sessionId":"s","event":event}});
            frame["payload"]["event"]["seq"]=json!(start+i as u64);serde_json::from_value(frame).unwrap()
        }).collect();
        ScopedEventPage {
            start_seq: start,
            next_seq: next,
            head_seq: next,
            events: frames,
        }
    }
    #[test]
    fn output_is_lossless_unicode_plain_text_and_never_forwards_reasoning_or_error_details() {
        let text = "你好 🧪\n".repeat(5000);
        let output_page = page(
            vec![
                json!({"type":"assistant/message","data":{"turn":0,"step":0,"message":{"role":"assistant","content":[{"type":"reasoning","text":"PRIVATE_REASONING"},{"type":"text","text":text}]}}}),
            ],
            0,
        );
        let update = format_output(&checkpoint(), &output_page).unwrap();
        assert!(update.replies.len() > 1);
        assert_eq!(
            update
                .replies
                .iter()
                .map(|r| r.plan.body.text.as_str())
                .collect::<String>(),
            format!("Assistant response\n{text}")
        );
        assert!(update
            .replies
            .iter()
            .all(|r| r.plan.body.text.encode_utf16().count() <= 4096));
        let update=format_output(&checkpoint(),&page(vec![json!({"type":"turn/end","data":{"turn":0,"reason":{"kind":"error","error":{"message":"PRIVATE_PROVIDER_ERROR"}}}})],0)).unwrap();
        assert!(!update.replies[0]
            .plan
            .body
            .text
            .contains("PRIVATE_PROVIDER_ERROR"));
    }
    #[test]
    fn output_capacity_commits_only_a_contiguous_prefix_and_never_truncates_oversized_text() {
        let events = (0..128)
            .map(|_| json!({"type":"turn/start","data":{"turn":0}}))
            .collect();
        let update = format_output(&checkpoint(), &page(events, 0)).unwrap();
        assert_eq!(update.next_seq, 64);
        assert_eq!(update.replies.len(), 64);
        let huge = page(
            vec![
                json!({"type":"assistant/chunk","data":{"turn":0,"step":0,"chunk":{"type":"text-delta","text":"x".repeat(MAX_TEXT+1)}}}),
            ],
            0,
        );
        assert!(matches!(
            format_output(&checkpoint(), &huge),
            Err(Error::Capacity)
        ));
    }
    #[test]
    fn nontext_native_chunks_and_tool_notices_do_not_leak_provider_items_arguments_or_stdout() {
        let events = ["usage", "finish", "provider", "reasoning-delta", "tool-call-delta"]
            .into_iter().map(|kind| json!({"type":"assistant/chunk","data":{"turn":0,"step":0,"chunk":{"type":kind,"item":"SECRET","text":"SECRET","arguments":"SECRET"}}})).chain([
                json!({"type":"tool/call","data":{"name":"fixture","arguments":"SECRET"}}),
                json!({"type":"tool/result","data":{"message":{"content":[{"type":"tool-result","isError":true,"content":[{"type":"text","text":"SECRET"},{"type":"image","attachment":{"attachmentId":"a".repeat(64),"reference":"PRIVATE_PATH"}}]}]}}})
            ]).collect();
        let update = format_output(&checkpoint(), &page(events, 0)).unwrap();
        assert_eq!(update.next_seq, 7);
        assert_eq!(update.replies.len(), 3);
        assert_eq!(
            update.replies[2]
                .plan
                .body
                .attachment
                .as_ref()
                .unwrap()
                .event_seq,
            6
        );
        assert_eq!(update.replies[0].plan.body.text, "Tool started: fixture");
        assert_eq!(
            update.replies[1].plan.body.text,
            "Tool failed; attachment queued separately"
        );
        assert!(!serde_json::to_string(&update.state)
            .unwrap()
            .contains("SECRET"));
    }
    #[test]
    fn final_output_edits_known_parts_and_clears_superseded_stream_segments() {
        let cp = checkpoint();
        let first=format_output(&cp,&page(vec![json!({"type":"assistant/chunk","data":{"turn":0,"step":0,"chunk":{"type":"text-delta","text":"x".repeat(6000)}}})],0)).unwrap();
        assert_eq!(first.replies.len(), 2);
        let links = first
            .replies
            .iter()
            .enumerate()
            .map(|(i, r)| (r.slot.clone().unwrap(), format!("known-{i}")))
            .collect();
        let cp = ProjectionCheckpoint {
            next_seq: 1,
            state: first.state,
            links,
            ..cp
        };
        let final_page = page(
            vec![
                json!({"type":"assistant/message","data":{"turn":0,"step":0,"interrupted":true,"message":{"role":"assistant","content":[{"type":"text","text":"short"}]}}}),
            ],
            1,
        );
        let update = format_output(&cp, &final_page).unwrap();
        assert_eq!(update.replies.len(), 2);
        assert_eq!(
            update.replies[0].plan.replace_of.as_deref(),
            Some("known-0")
        );
        assert_eq!(
            update.replies[1].plan.replace_of.as_deref(),
            Some("known-1")
        );
        assert!(!update.replies[1].plan.body.text.contains("xxxxx"));
        assert!(update.retain.is_empty());
    }
}
