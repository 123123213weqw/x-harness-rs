use std::collections::HashSet;

use serde_json::{json, Value};
use xharness_api::{
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
