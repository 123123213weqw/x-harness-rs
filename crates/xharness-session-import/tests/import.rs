use serde_json::json;
use xharness_session::{derive_messages, EventData, Revision, Session, SessionHeader};
use xharness_session_import::{parse, Source};
fn log(rows: &[serde_json::Value]) -> String {
    rows.iter().map(|v| format!("{v}\n")).collect()
}
#[test]
fn codex_uses_canonical_messages_and_never_replays_foreign_tools() {
    let raw = log(&[
        json!({"type":"session_meta","payload":{"id":"original","cwd":"/do/not/use","model_provider":"openai"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"echo"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix test"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"old-id","arguments":"{\"cmd\":\"exit 7\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-id","output":"exit code 7"}}),
        json!({"type":"response_item","payload":{"type":"reasoning","encrypted_content":"never-forward-this"}}),
    ]);
    let t = parse(Source::Codex, &raw).unwrap();
    assert_eq!(t.tools, 1);
    assert!(t.messages.iter().all(|m| m.tool_calls.is_empty()
        && m.provider_items.is_empty()
        && m.tool_call_id.is_none()));
    let text = t
        .messages
        .iter()
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains("echo"));
    assert!(!text.contains("never-forward-this"));
    assert!(text.contains("exec_command"));
    assert!(text.contains("exit code 7"));
    let mut session = Session::new(SessionHeader::new("import-test")).unwrap();
    session.append_batch(Revision::ZERO, t.events()).unwrap();
    assert!(session.events().iter().all(|e| !matches!(
        e.data(),
        EventData::ToolCall { .. } | EventData::ToolResult { .. }
    )));
    let projected = derive_messages(session.events());
    assert_eq!(projected.len(), t.messages.len() + 1);
    let restored = Session::restore(
        session.header().clone(),
        session.revision(),
        session.events().to_vec(),
    )
    .unwrap();
    assert_eq!(derive_messages(restored.events()), projected);
}
#[test]
fn claude_selects_current_branch_not_abandoned_edits_or_sidechains() {
    let raw = log(&[
        json!({"type":"user","uuid":"root","parentUuid":null,"message":{"content":"start"}}),
        json!({"type":"assistant","uuid":"discarded","parentUuid":"root","message":{"content":"obsolete answer"}}),
        json!({"type":"progress","uuid":"progress","parentUuid":"root"}),
        json!({"type":"assistant","uuid":"current","parentUuid":"progress","message":{"content":[{"type":"text","text":"new answer"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src.rs"}}]}}),
        json!({"type":"assistant","uuid":"side","isSidechain":true,"message":{"content":"sidechain"}}),
    ]);
    let t = parse(Source::ClaudeCode, &raw).unwrap();
    let text = t
        .messages
        .iter()
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("new answer"));
    assert!(!text.contains("obsolete answer"));
    assert!(!text.contains("sidechain"));
    assert!(text.contains("result unknown"));
}
#[test]
fn bounded_bad_input_is_not_silently_partially_imported() {
    assert!(parse(Source::Codex, "{broken}\n").is_err());
    let raw = format!(
        "{}{{\"type\":",
        log(&[json!({"type":"user","message":{"content":"hello"}})])
    );
    let t = parse(Source::ClaudeCode, &raw).unwrap();
    assert!(t.warnings.contains(&"incomplete-tail-skipped".into()));
    assert!(parse(
        Source::ClaudeCode,
        &"x".repeat(xharness_session_import::MAX_BYTES + 1)
    )
    .is_err());
    assert!(parse(Source::ClaudeCode, "{\"apiKey\":\"not a session\"}\n").is_err());
}
#[test]
fn media_and_provider_state_are_reported_not_secretly_forwarded() {
    let raw = log(&[
        json!({"type":"user","message":{"content":[{"type":"image","source":{"data":"PRIVATEBASE64"}},{"type":"text","text":"look"}]}}),
        json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"PRIVATE"}]}}),
    ]);
    let t = parse(Source::ClaudeCode, &raw).unwrap();
    assert_eq!(t.warnings.len(), 2);
    assert!(!format!("{:?}", t.messages).contains("PRIVATE"));
}

#[test]
fn tool_result_images_are_not_forwarded_as_textual_base64() {
    let raw = log(&[
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"missing","content":[{"type":"image","source":{"data":"PRIVATEBASE64"}},{"type":"text","text":"screenshot returned"}]}]}}),
    ]);
    let t = parse(Source::ClaudeCode, &raw).unwrap();
    assert!(!format!("{:?}", t.messages).contains("PRIVATEBASE64"));
    assert!(t.messages[0].content.contains("screenshot returned"));
    assert!(t.warnings.contains(&"attachments-not-imported".to_owned()));
}
#[test]
fn broken_or_cyclic_claude_branch_is_not_mixed_into_a_new_session() {
    for parent in ["missing", "self"] {
        let raw = log(&[
            json!({"type":"user","uuid":"self","parentUuid":parent,"message":{"content":"prompt"}}),
        ]);
        assert!(parse(Source::ClaudeCode, &raw).is_err());
    }
}
