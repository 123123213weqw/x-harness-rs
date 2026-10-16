//! Typed event references only; bytes are resolved by the scoped gateway sender.
use serde_json::Value;
use xharness_remote::{Error, ReplyAttachment, ReplyBody, ReplyPlan, MAX_REPLY_BATCH};
pub(crate) fn event_plans(
    event: &Value,
    identity: &str,
    include_user: bool,
) -> Result<Vec<ReplyPlan>, Error> {
    let seq = event["seq"]
        .as_u64()
        .ok_or(Error::Invalid("media event sequence"))?;
    let data = &event["data"];
    let mut blocks = Vec::new();
    match event["type"].as_str() {
        Some("assistant/message") => blocks.extend(
            data["message"]["content"]
                .as_array()
                .ok_or(Error::Invalid("media message content"))?
                .iter(),
        ),
        Some("user/message") if include_user => blocks.extend(
            data["content"]
                .as_array()
                .ok_or(Error::Invalid("media user content"))?
                .iter(),
        ),
        Some("tool/result") => {
            for result in data["message"]["content"]
                .as_array()
                .ok_or(Error::Invalid("media tool content"))?
            {
                blocks.extend(
                    result["content"]
                        .as_array()
                        .ok_or(Error::Invalid("media tool result content"))?
                        .iter(),
                );
            }
        }
        _ => {}
    }
    let mut plans = Vec::new();
    for (index, block) in blocks.into_iter().enumerate() {
        if !matches!(block["type"].as_str(), Some("image" | "file")) {
            continue;
        }
        let id = block["attachment"]["attachmentId"]
            .as_str()
            .ok_or(Error::Invalid("media native reference"))?;
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("media native identity"));
        }
        plans.push(ReplyPlan {
            id: format!("{identity}:media:{seq}:{index}"),
            body: ReplyBody {
                text: "Session attachment".into(),
                buttons: vec![],
                attachment: Some(ReplyAttachment {
                    event_seq: seq,
                    id: id.into(),
                }),
            },
            replace_of: None,
        });
        if plans.len() > MAX_REPLY_BATCH {
            return Err(Error::Capacity);
        }
    }
    Ok(plans)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn media_refs_are_exact_stable_and_input_echo_requires_explicit_history() {
        let e = json!({"seq":7,"type":"user/message","data":{"content":[{"type":"file","name":"PRIVATE_PATH","attachment":{"attachmentId":"a".repeat(64),"reference":{"session_id":"PRIVATE_OWNER"}}}]}});
        assert!(event_plans(&e, "fixture", false).unwrap().is_empty());
        let p = event_plans(&e, "fixture", true).unwrap();
        assert_eq!(p, event_plans(&e, "fixture", true).unwrap());
        assert_eq!(p[0].body.attachment.as_ref().unwrap().event_seq, 7);
        assert!(!serde_json::to_string(&p).unwrap().contains("PRIVATE_"));
        let mut bad = e.clone();
        bad["data"]["content"][0]["attachment"]["attachmentId"] = json!("../PRIVATE_PATH");
        assert!(event_plans(&bad, "fixture", true).is_err());
    }
}
