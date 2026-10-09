use serde_json::{json, Value};
use xharness_core::{AgentMessage, ProviderRequest, Role, ToolCall, ToolDefinition};
use xharness_provider_openai::{
    build_openai_request, build_openai_token_count_request, OpenAiProtocol,
};

fn foreground() -> Value {
    json!({
        "kind": "foreground", "pid": 4242, "success": true, "exit_code": 0,
        "signal": null, "termination": "exited",
        "stdout": "  PID COMMAND\n 4242 python\n    中文\t\"x\"\r\n",
        "stderr": "warning: kept verbatim\n",
        "stdout_truncated": false, "stderr_truncated": false,
        "stdout_bytes": 52, "stderr_bytes": 23,
        "stdout_omitted_bytes": 0, "stderr_omitted_bytes": 0,
        "execution": {"shell": "bash", "future": [1, 2]},
        "future_diagnostic": {"pid": 777, "note": "keep nested PIDs"}
    })
}

fn envelope(inner: &Value, object_content: bool) -> Value {
    json!({
        "ok": true, "error": "", "truncated": false,
        "content": if object_content { inner.clone() } else {
            Value::String(serde_json::to_string_pretty(inner).unwrap())
        },
        "future_metadata": {"pid": 888, "note": "preserve unknown fields"}
    })
}

fn request(tool: &str, raw: String) -> ProviderRequest {
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(ToolCall {
        id: "internal-execution".into(),
        provider_call_id: Some("wire-call".into()),
        name: tool.into(),
        arguments_json: "{\"command\":\"ps\"}".into(),
        ..Default::default()
    });
    ProviderRequest {
        messages: vec![
            AgentMessage::system("system unchanged"),
            AgentMessage::user("inspect PID 4242"),
            assistant,
            AgentMessage::tool("wire-call", raw),
        ],
        tools: vec![ToolDefinition {
            name: tool.into(),
            description: "definition unchanged".into(),
            parameters: json!({"type": "object"}),
        }],
        step: 2,
        reasoning_effort: None,
        max_output_tokens: Some(4096),
        debug_scope: Default::default(),
    }
}

fn result_text(body: &Value, protocol: OpenAiProtocol) -> &str {
    match protocol {
        OpenAiProtocol::ChatCompletions => body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
        OpenAiProtocol::Responses => body["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["type"] == "function_call_output")
            .unwrap()["output"]
            .as_str()
            .unwrap(),
    }
}

fn assert_wire(request: &ProviderRequest, expected: &Value) {
    let original = request.messages.clone();
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let body = build_openai_request(protocol, "model", request);
        let actual: Value = serde_json::from_str(result_text(&body, protocol)).unwrap();
        assert_eq!(&actual, expected);
        let count = build_openai_token_count_request(protocol, "model", request);
        assert_eq!(result_text(&count, protocol), result_text(&body, protocol));
        // The counter uses the same complete encoder, not a separate estimate.
        let mut expected_count = body;
        for key in [
            "stream",
            "stream_options",
            "max_tokens",
            "max_output_tokens",
            "store",
        ] {
            expected_count.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(count, expected_count);
    }
    assert_eq!(
        request.messages, original,
        "persisted/UI messages must not change"
    );
}

#[test]
fn successful_foreground_bash_omits_only_incidental_pid_in_both_protocols() {
    for object_content in [false, true] {
        let inner = foreground();
        let outer = envelope(&inner, object_content);
        let mut expected = outer.clone();
        expected["content"] = inner;
        expected["content"].as_object_mut().unwrap().remove("pid");
        let request = request("bash", outer.to_string());
        assert_wire(&request, &expected);
        // Re-encoding an already projected object is stable.
        let mut replay = request;
        replay.messages.last_mut().unwrap().content = expected.to_string();
        assert_wire(&replay, &expected);
    }
}

#[test]
fn output_text_and_other_fields_survive_varied_payloads() {
    for i in 0..1000 {
        let mut inner = foreground();
        inner["stdout"] = json!(format!("{i}: \"quoted\"\t中文\r\n    code\nPID=4242\n"));
        inner["stderr"] = json!("  warning\n".repeat(i % 11));
        inner["stdout_bytes"] = json!(1000 + i);
        inner["future_diagnostic"] = json!({"pid": i, "nested": [null, true, "x"]});
        let outer = envelope(&inner, i % 2 == 0);
        let mut expected = outer.clone();
        expected["content"] = inner;
        expected["content"].as_object_mut().unwrap().remove("pid");
        assert_wire(&request("bash", outer.to_string()), &expected);
    }
}

#[test]
fn incomplete_failed_truncated_or_unknown_process_states_keep_pid() {
    let mutations = [
        ("kind", json!("background")),
        ("success", json!(false)),
        ("exit_code", json!(1)),
        ("exit_code", json!(null)),
        ("exit_code", json!(0.0)),
        ("signal", json!(9)),
        ("termination", json!("cancelled")),
        ("termination", json!("timedout")),
        ("termination", json!("future")),
        ("stdout", json!(null)),
        ("stderr", json!({"future": "format"})),
        ("stdout_bytes", json!("52")),
        ("stderr_bytes", json!(-1)),
        ("stdout_truncated", json!(true)),
        ("stderr_truncated", json!(true)),
        ("stdout_omitted_bytes", json!(1)),
        ("stderr_omitted_bytes", json!(1)),
        ("job_id", json!("job-1")),
        ("job_id", json!(null)),
        ("pid", json!("4242")),
    ];
    for (key, value) in mutations {
        for object_content in [false, true] {
            let mut inner = foreground();
            inner[key] = value.clone();
            let outer = envelope(&inner, object_content);
            let mut expected = outer.clone();
            // Preserve the pre-existing string-to-object envelope projection.
            expected["content"] = inner;
            assert_wire(&request("bash", outer.to_string()), &expected);
        }
    }
    for key in [
        "kind",
        "success",
        "exit_code",
        "signal",
        "termination",
        "stdout",
        "stderr",
        "stdout_bytes",
        "stderr_bytes",
        "stdout_truncated",
        "stderr_truncated",
        "stdout_omitted_bytes",
        "stderr_omitted_bytes",
    ] {
        let mut inner = foreground();
        inner.as_object_mut().unwrap().remove(key);
        let outer = envelope(&inner, false);
        let mut expected = outer.clone();
        // A missing exit_code is not a known process envelope at all.
        if key != "exit_code" {
            expected["content"] = inner;
        }
        assert_wire(&request("bash", outer.to_string()), &expected);
    }
}

#[test]
fn envelope_failures_and_archive_references_keep_pid_and_metadata() {
    for (key, value) in [
        ("ok", json!(false)),
        ("truncated", json!(true)),
        ("error", json!("outcome unknown")),
        (
            "archive",
            json!({"ref": "sha256:abc", "read_with": "history"}),
        ),
        ("reduction", json!({"sha256": "abc", "omitted_bytes": 100})),
    ] {
        let inner = foreground();
        let mut outer = envelope(&inner, false);
        outer[key] = value;
        let mut expected = outer.clone();
        expected["content"] = inner;
        assert_wire(&request("bash", outer.to_string()), &expected);
    }
}

#[test]
fn background_job_identity_and_process_diagnostics_are_unchanged() {
    let inner = json!({
        "kind": "background", "pid": 4242, "job_id": "job-1", "status": "running",
        "execution": {"shell": "bash", "future": "keep"}
    });
    let outer = envelope(&inner, false);
    let mut expected = outer.clone();
    expected["content"] = inner;
    assert_wire(&request("bash", outer.to_string()), &expected);
}

#[test]
fn lookalike_other_tools_or_orphan_results_are_not_pruned() {
    let inner = foreground();
    let outer = envelope(&inner, false);
    let mut expected = outer.clone();
    expected["content"] = inner;
    for name in ["read", "grep", "custom_process", "mcp__bash"] {
        assert_wire(&request(name, outer.to_string()), &expected);
    }
    let mut orphan = request("bash", outer.to_string());
    orphan.messages[2].tool_calls.clear();
    assert_wire(&orphan, &expected);
    let mut conflicting = request("bash", outer.to_string());
    let mut other_call = conflicting.messages[2].tool_calls[0].clone();
    other_call.name = "other".into();
    conflicting.messages[2].tool_calls.push(other_call);
    assert_wire(&conflicting, &expected);
    // Result IDs refer to the provider wire ID, never the internal execution ID.
    let mut mismatched = request("bash", outer.to_string());
    mismatched.messages.last_mut().unwrap().tool_call_id = Some("internal-execution".into());
    assert_wire(&mismatched, &expected);
}

#[test]
fn legacy_call_ids_without_provider_alias_still_project() {
    let inner = foreground();
    let outer = envelope(&inner, false);
    let mut request = request("bash", outer.to_string());
    request.messages[2].tool_calls[0].provider_call_id = None;
    request.messages.last_mut().unwrap().tool_call_id = Some("internal-execution".into());
    let mut expected = outer;
    expected["content"] = inner;
    expected["content"].as_object_mut().unwrap().remove("pid");
    assert_wire(&request, &expected);
}

#[test]
fn non_tool_messages_and_arbitrary_content_keep_their_exact_text() {
    let raw = serde_json::to_string_pretty(&envelope(&foreground(), false)).unwrap();
    for role in [Role::System, Role::User, Role::Assistant] {
        let mut request = request("bash", raw.clone());
        request.messages.last_mut().unwrap().role = role;
        let body = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
        assert_eq!(body["messages"][3]["content"], raw);
    }
    for raw in ["PID=4242\n", "{bad json", r#"{"content":"PID=4242"}"#] {
        let request = request("bash", raw.into());
        for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
            let body = build_openai_request(protocol, "model", &request);
            assert_eq!(result_text(&body, protocol), raw);
        }
    }
}
