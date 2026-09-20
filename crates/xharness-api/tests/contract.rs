use std::collections::HashSet;

use serde_json::{json, Value};
use xharness_api::{
    protocol::{TypedRpcParams, TypedRpcResponse},
    ClientRequest, HostFrame, MuxFrame, RpcErrorCode, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ServerRequest, ServerResponse, UPSTREAM_CONTRACT_REVISION,
};

const UPSTREAM_METHODS: &[&str] = &[
    "session.list",
    "session.search",
    "session.create",
    "session.history",
    "session.models",
    "session.selectModel",
    "session.rename",
    "session.fork",
    "session.prompt",
    "session.attachment",
    "session.updateQueue",
    "session.cancel",
    "subagent.list",
    "subagent.history",
    "subagent.prompt",
    "subagent.interrupt",
    "host.describe",
    "host.pickDirectory",
    "host.listDirectory",
    "host.createDirectory",
    "host.openPath",
    "workspace.list",
    "workspace.create",
    "workspace.rename",
    "workspace.delete",
    "workspace.insertBefore",
    "workspace.insertSessionBefore",
    "workspace.archiveSession",
    "skill.list",
    "agentPreset.list",
    "agentPreset.select",
    "agentPreset.read",
    "agentPreset.copy",
    "agentPreset.openDocument",
    "agentPreset.remove",
    "goal.create",
    "goal.edit",
    "goal.pause",
    "goal.resume",
    "goal.complete",
    "goal.clear",
    "settings.describe",
    "settings.openDocument",
    "settings.update",
    "settings.replace",
    "settings.mutate",
    "credentials.describe",
    "credentials.set",
    "credentials.unset",
    "llm.providers",
    "llm.models",
    "llm.discoverModels",
];

#[test]
fn method_directory_matches_upstream_exactly() {
    assert_eq!(UPSTREAM_CONTRACT_REVISION, "deepseek-harness@141eb6fef8");
    let actual = RpcMethod::ALL
        .iter()
        .map(|method| method.as_str())
        .collect::<Vec<_>>();
    assert_eq!(actual, UPSTREAM_METHODS);
    assert_eq!(actual.iter().copied().collect::<HashSet<_>>().len(), 52);
    for name in UPSTREAM_METHODS {
        assert_eq!(name.parse::<RpcMethod>().unwrap().as_str(), *name);
    }
}

#[test]
fn mux_and_host_discriminants_match_frontend_frames() {
    let mux = MuxFrame::SessionSubscribed {
        session_id: "s".into(),
        last_seq: -1,
    }
    .into_server_request(RpcId::new("m1"));
    assert_eq!(
        serde_json::to_value(mux).unwrap(),
        json!({
            "type": "server-request", "rpcId": "m1", "method": "session/subscribed",
            "payload": {"type":"session/subscribed", "sessionId":"s", "lastSeq":-1}
        })
    );

    let host = HostFrame::SessionStatus {
        session_id: "s".into(),
        running: true,
    }
    .into_server_request(RpcId::new("h1"));
    assert_eq!(host.method, "host/session-status");
    assert_eq!(host.payload["sessionId"], "s");
}

#[test]
fn four_quadrant_envelopes_match_wire_shape() {
    let request = ClientRequest::new(RpcId::new("c1"), RpcMethod::SessionList, json!({}));
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "type": "client-request", "rpcId": "c1", "method": "session.list", "payload": {}
        })
    );

    let response = ServerResponse::new(RpcId::new("c1"), RpcResult::success(json!({"items": []})));
    let encoded = serde_json::to_value(&response).unwrap();
    assert_eq!(
        encoded,
        json!({
            "type": "server-response", "rpcId": "c1",
            "result": {"ok": true, "value": {"items": []}}
        })
    );
    assert_eq!(
        serde_json::from_value::<ServerResponse>(encoded).unwrap(),
        response
    );

    let frame = ServerRequest::frame(
        RpcId::new("s1"),
        json!({"type": "session/subscribed", "sessionId": "session", "lastSeq": -1}),
    )
    .unwrap();
    assert_eq!(frame.method, "session/subscribed");
    assert_eq!(
        serde_json::to_value(frame).unwrap()["type"],
        "server-request"
    );
}

#[test]
fn result_and_receipt_boolean_discriminants_are_strict() {
    assert!(serde_json::from_value::<RpcResult>(json!({"ok": true})).is_ok());
    assert!(serde_json::from_value::<RpcResult>(json!({"ok": false})).is_err());
    assert!(serde_json::from_value::<RpcResult>(json!({
        "ok": false,
        "error": {"code": "internal", "message": "x", "details": {}}
    }))
    .is_ok());
    assert_eq!(
        serde_json::to_value(RpcReceipt::Accepted).unwrap(),
        json!({"accepted": true})
    );
    assert!(serde_json::from_value::<RpcReceipt>(json!({"accepted": false})).is_err());

    let error_code: RpcErrorCode =
        serde_json::from_value(Value::String("bad-request".into())).unwrap();
    assert_eq!(error_code, RpcErrorCode::BadRequest);
}

fn canonical_request(method: RpcMethod) -> Value {
    match method {
        RpcMethod::SessionList => json!({}),
        RpcMethod::SessionSearch => json!({"query":"needle"}),
        RpcMethod::SessionCreate => json!({"workspaceId":"workspace","agentPreset":"coding"}),
        RpcMethod::SessionHistory => json!({"sessionId":"session","beforeSeq":42,"maxMessages":50}),
        RpcMethod::SessionModels => json!({"sessionId":"session"}),
        RpcMethod::SessionSelectModel => json!({
            "sessionId":"session", "provider":"provider", "model":"model",
            "reasoningEffort":"high"
        }),
        RpcMethod::SessionRename => json!({"sessionId":"session","title":"title"}),
        RpcMethod::SessionFork => json!({"sessionId":"session","atSeq":7}),
        RpcMethod::SessionPrompt => json!({
            "sessionId":"session", "mode":"queue",
            "content":[{"type":"text","text":"hello"}],
            "requireIdle":true, "clientTimeZone":"Asia/Shanghai"
        }),
        RpcMethod::SessionAttachment => json!({"sessionId":"session","attachmentId":"attachment"}),
        RpcMethod::SessionUpdateQueue => json!({
            "sessionId":"session", "itemId":"item", "action":{"kind":"remove"}
        }),
        RpcMethod::SessionCancel => json!({"sessionId":"session"}),
        RpcMethod::SubagentList => json!({"parentSessionId":"parent"}),
        RpcMethod::SubagentHistory => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable"
        }),
        RpcMethod::SubagentPrompt => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable",
            "content":[{"type":"text","text":"continue"}]
        }),
        RpcMethod::SubagentInterrupt => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable"
        }),
        RpcMethod::HostDescribe | RpcMethod::HostPickDirectory => json!({}),
        RpcMethod::HostListDirectory => json!({"path":"/tmp"}),
        RpcMethod::HostCreateDirectory => json!({"path":"/tmp","name":"child"}),
        RpcMethod::HostOpenPath => json!({"path":"/tmp"}),
        RpcMethod::WorkspaceList => json!({}),
        RpcMethod::WorkspaceCreate => json!({"path":"/tmp"}),
        RpcMethod::WorkspaceRename => json!({"workspaceId":"workspace","title":"title"}),
        RpcMethod::WorkspaceDelete => json!({"workspaceId":"workspace"}),
        RpcMethod::WorkspaceInsertBefore => json!({
            "workspaceId":"workspace", "beforeWorkspaceId":"other"
        }),
        RpcMethod::WorkspaceInsertSessionBefore => json!({
            "workspaceId":"workspace", "sessionId":"session", "beforeSessionId":"other"
        }),
        RpcMethod::WorkspaceArchiveSession => json!({"sessionId":"session"}),
        RpcMethod::SkillList => json!({"sessionId":"session"}),
        RpcMethod::AgentPresetList => json!({}),
        RpcMethod::AgentPresetSelect => json!({"sessionId":"session","agentPreset":"coding"}),
        RpcMethod::AgentPresetRead => json!({"agentPreset":"coding"}),
        RpcMethod::AgentPresetCopy => json!({"from":"coding","agentPreset":"custom"}),
        RpcMethod::AgentPresetOpenDocument | RpcMethod::AgentPresetRemove => {
            json!({"agentPreset":"custom"})
        }
        RpcMethod::GoalCreate => json!({"sessionId":"session","objective":"ship"}),
        RpcMethod::GoalEdit => json!({
            "sessionId":"session", "ref":{"id":"goal","revision":1},
            "objective":"ship safely", "maxGoalRounds":64
        }),
        RpcMethod::GoalPause
        | RpcMethod::GoalResume
        | RpcMethod::GoalComplete
        | RpcMethod::GoalClear => {
            json!({"sessionId":"session","ref":{"id":"goal","revision":1}})
        }
        RpcMethod::SettingsDescribe | RpcMethod::SettingsOpenDocument => json!({}),
        RpcMethod::SettingsUpdate => json!({
            "ns":"xharness", "patch":{"theme":"dark"}, "expectedRevision":1
        }),
        RpcMethod::SettingsReplace => json!({
            "ns":"xharness", "section":{"theme":"dark"}, "expectedRevision":1
        }),
        RpcMethod::SettingsMutate => json!({
            "ns":"xharness", "ops":[{"op":"set","path":["theme"],"value":"dark"}],
            "expectedRevision":1
        }),
        RpcMethod::CredentialsDescribe => json!({"refs":["EXAMPLE_API_KEY"]}),
        RpcMethod::CredentialsSet => json!({"ref":"EXAMPLE_API_KEY","value":"secret"}),
        RpcMethod::CredentialsUnset => json!({"ref":"EXAMPLE_API_KEY"}),
        RpcMethod::LlmProviders | RpcMethod::LlmModels => json!({}),
        RpcMethod::LlmDiscoverModels => json!({"settingsNs":"llm-example"}),
    }
}

#[test]
fn every_fixed_rpc_method_has_a_typed_request_contract() {
    for &method in RpcMethod::ALL {
        let payload = canonical_request(method);
        let typed = TypedRpcParams::decode(method, &payload)
            .unwrap_or_else(|error| panic!("{method}: {error}; payload={payload}"));
        assert_eq!(typed.method(), method);
        assert_eq!(typed.to_value(), payload, "{method} request roundtrip");
    }
}

#[test]
fn typed_protocol_reports_method_and_side_for_shape_errors() {
    let error = TypedRpcParams::decode(RpcMethod::SessionHistory, &json!({})).unwrap_err();
    assert_eq!(error.method, RpcMethod::SessionHistory);
    assert_eq!(error.side, "request");

    let error = TypedRpcResponse::decode(RpcMethod::SessionList, &json!({})).unwrap_err();
    assert_eq!(error.method, RpcMethod::SessionList);
    assert_eq!(error.side, "response");
}

#[test]
fn compatibility_boundary_tolerates_additive_fields() {
    let payload = json!({"sessionId":"session","futureField":{"enabled":true}});
    let typed = TypedRpcParams::decode(RpcMethod::SessionModels, &payload).unwrap();
    assert_eq!(typed.method(), RpcMethod::SessionModels);
}
