//! Genuine Host boundary, no provider or paid model calls.
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_host::{BasicHost, HostConfig, NoTools};

#[tokio::test]
async fn registered_workspace_scope_is_checked_by_host_not_message_ids() {
    let temp = tempfile::tempdir().unwrap();
    let host = BasicHost::new(HostConfig::new(temp.path()), None, Arc::new(NoTools));
    let created = host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":"s"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(created, RpcResult::Success { .. }), "{created:?}");
    assert!(host
        .session_in_workspace("workspace-default", "s")
        .await
        .unwrap());
    assert!(!host
        .session_in_workspace("unregistered", "s")
        .await
        .unwrap());
    assert!(!host
        .session_in_workspace("workspace-default", "missing")
        .await
        .unwrap());
    let outside = tempfile::tempdir().unwrap();
    host.call(
        RpcId::new("outside"),
        RpcMethod::SessionCreate,
        json!({"cwd":outside.path(),"sessionId":"outside"}),
        CancellationToken::new(),
    )
    .await;
    assert!(!host
        .session_in_workspace("workspace-default", "outside")
        .await
        .unwrap());
    let payload = json!({"sessionId":"s","mode":"queue","content":[{"type":"text","text":"test"}]});
    // An ephemeral Host is not allowed to certify durable remote admission.
    assert!(host
        .prompt_receipt("s", &RpcId::new("not-admitted"), &payload)
        .await
        .is_err());
}
