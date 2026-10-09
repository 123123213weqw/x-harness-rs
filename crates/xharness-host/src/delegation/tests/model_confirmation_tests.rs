//! Model -> registered agent guard -> Core durable approval -> real user RPC
//! -> child provider. Never uses a boolean supplied by the model as permission.
use super::model_selection_tests::{routed_host_with_tools, user_select};
use super::*;
use std::sync::{atomic::AtomicBool, OnceLock};
use xharness_api::{ClientResponse, ClientResponseKind, RpcReceipt};

struct DelegateModel {
    arguments: Value,
    requested: AtomicBool,
}
#[async_trait]
impl ModelProvider for DelegateModel {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if request.tools.iter().any(|t| t.name == "agent")
            && !request
                .messages
                .iter()
                .any(|m| m.tool_calls.iter().any(|c| c.name == "agent"))
            && !self.requested.swap(true, Ordering::SeqCst)
        {
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "provider-agent".into(),
                    name: "agent".into(),
                    arguments_delta: self.arguments.to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ])))
        } else {
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(ProviderEvent::TextDelta("done".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ])))
        }
    }
}
struct PolicyTools {
    host: OnceLock<Weak<BasicHost>>,
    approval_timeout: Option<Duration>,
}
#[async_trait]
impl crate::SessionToolFactory for PolicyTools {
    async fn executor(
        &self,
        session: &str,
        _: &str,
        _: crate::PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let host = self
            .host
            .get()
            .and_then(Weak::upgrade)
            .ok_or("test host unavailable")?;
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(AgentTool::for_host(&host, session))
            .await
            .map_err(|e| e.to_string())?;
        let mut executor = ToolExecutor::new(registry)
            .with_guards(vec![AgentTool::model_selection_guard(&host, session)]);
        if let Some(timeout) = self.approval_timeout {
            executor = executor.with_approval_timeout(timeout).unwrap();
        }
        Ok(executor)
    }
}
async fn live_host(
    store: Arc<dyn Store>,
    arguments: Value,
    timeout: Option<Duration>,
) -> (Arc<BasicHost>, Arc<Probe>) {
    let tools = Arc::new(PolicyTools {
        host: OnceLock::new(),
        approval_timeout: timeout,
    });
    let child = Arc::new(Probe::default());
    let parent_model = Arc::new(DelegateModel {
        arguments,
        requested: AtomicBool::new(false),
    });
    let host = routed_host_with_tools(store, parent_model, child.clone(), tools.clone()).await;
    tools.host.set(Arc::downgrade(&host)).unwrap();
    (host, child)
}
async fn prompt(host: &BasicHost) {
    let response=host.call(RpcId::new("user-request"),RpcMethod::SessionPrompt,
        json!({"sessionId":"p","mode":"queue","content":[{"type":"text","text":"Use primary/small at vendor-level-3 for this independent review."}]}),CancellationToken::new()).await;
    assert!(
        matches!(response, RpcResult::Success { .. }),
        "prompt failed: {response:?}"
    );
}
async fn pending(host: &BasicHost) -> (String, String, String) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = host.state.read().await;
            if let Some((
                rpc_id,
                crate::state::PendingResponse::Approval {
                    approval_id,
                    reviewing,
                    reason,
                    ..
                },
            )) = state.pending.iter().next()
            {
                assert!(
                    !reviewing,
                    "model selection must never be auto-approved by AI review"
                );
                return (rpc_id.clone(), approval_id.clone(), reason.clone());
            }
            drop(state);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
async fn answer(host: &BasicHost, rpc_id: &str, approval_id: &str, outcome: &str) -> RpcReceipt {
    host.respond(ClientResponse {
        kind: ClientResponseKind::ClientResponse,
        rpc_id: RpcId::new(rpc_id),
        result: RpcResult::Success {
            value: Some(json!({"sessionId":"p","approvalId":approval_id,"outcome":outcome})),
        },
    })
    .await
}
fn arguments() -> Value {
    json!({"action":"start","task":"inspect only","model":"small","reasoning_effort":"vendor-level-3"})
}

#[tokio::test]
async fn changed_selection_waits_for_manual_confirmation_even_in_full_access_and_ai_review() {
    for permission in [
        crate::PermissionPreset::WorkspaceWrite,
        crate::PermissionPreset::DangerFullAccess,
        crate::PermissionPreset::WorkspaceWriteAiReview,
    ] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let (host, child) = live_host(store.clone(), arguments(), None).await;
        parent(&host, "p").await;
        user_select(&host, "p", "primary", "main", Some("high")).await;
        let result=host.call_dynamic(RpcId::new("permission"),"commands/execute",json!({"args":{"agentId":"p","line":format!("/permission {}",permission.as_str()),"images":[]}}),CancellationToken::new()).await.unwrap();
        assert!(matches!(result, RpcResult::Success { .. }));
        prompt(&host).await;
        let (rpc_id, approval_id, reason) = pending(&host).await;
        assert!(
            reason.contains("primary/small") && reason.contains("vendor-level-3"),
            "wrong confirmation label: {reason}"
        );
        assert_eq!(
            host.state.read().await.sessions.len(),
            1,
            "child created before confirmation"
        );
        assert_eq!(child.calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            answer(&host, &rpc_id, "wrong-approval", "allowed-once").await,
            RpcReceipt::Rejected { .. }
        ));
        assert_eq!(host.state.read().await.sessions.len(), 1);
        assert!(matches!(
            answer(&host, &rpc_id, &approval_id, "allowed-once").await,
            RpcReceipt::Accepted
        ));
        wait_for_calls(&child, 1).await;
        settled(&host, "p").await;
        let id = host
            .state
            .read()
            .await
            .sessions
            .values()
            .find(|s| s.delegated)
            .unwrap()
            .session_id
            .clone();
        settled(&host, &id).await;
        assert_eq!(host.state.read().await.sessions["p"].model.model, "main");
        assert_eq!(
            host.state.read().await.sessions[&id]
                .model
                .reasoning_effort
                .as_deref(),
            Some("vendor-level-3")
        );
        assert_eq!(
            child.requests.lock().unwrap()[0]
                .reasoning_effort
                .as_deref(),
            Some("vendor-level-3")
        );
        assert!(matches!(
            answer(&host, &rpc_id, &approval_id, "allowed-once").await,
            RpcReceipt::Rejected { .. }
        ));
        let journal = store.load("p").await.unwrap().unwrap();
        assert!(journal.events().iter().any(|e|matches!(e.data(),EventData::ApprovalAsked{reason:Some(reason),..} if reason.contains("xharness.agent-model-approval.v1:"))));
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        host.stop_background_listeners();
    }
}

#[tokio::test]
async fn rejection_cancel_and_approval_timeout_never_create_a_child() {
    for mode in ["rejected", "cancel", "timeout"] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let (host, child) = live_host(
            store,
            arguments(),
            (mode == "timeout").then_some(Duration::from_millis(100)),
        )
        .await;
        parent(&host, "p").await;
        prompt(&host).await;
        let (rpc_id, approval_id, _) = pending(&host).await;
        if mode == "rejected" {
            assert!(matches!(
                answer(&host, &rpc_id, &approval_id, "rejected").await,
                RpcReceipt::Accepted
            ));
        }
        if mode == "cancel" {
            crate::rpc::turn::send_control(&host, "p", LoopCommand::Cancel)
                .await
                .unwrap();
        }
        settled(&host, "p").await;
        assert_eq!(host.state.read().await.sessions.len(), 1);
        assert_eq!(child.calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            answer(&host, &rpc_id, &approval_id, "allowed-once").await,
            RpcReceipt::Rejected { .. }
        ));
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        host.stop_background_listeners();
    }
}

#[tokio::test]
async fn changing_parent_settings_while_waiting_invalidates_the_confirmation() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, child) = live_host(store.clone(), arguments(), None).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "main", Some("high")).await;
    prompt(&host).await;
    let (rpc_id, approval_id, _) = pending(&host).await;
    user_select(&host, "p", "primary", "main", Some("low")).await;
    assert!(matches!(
        answer(&host, &rpc_id, &approval_id, "allowed-once").await,
        RpcReceipt::Accepted
    ));
    settled(&host, "p").await;
    assert_eq!(host.state.read().await.sessions.len(), 1);
    assert_eq!(child.calls.load(Ordering::SeqCst), 0);
    let journal = store.load("p").await.unwrap().unwrap();
    assert!(journal.events().iter().any(|e|matches!(e.data(),EventData::ToolResult{result,..} if serde_json::to_string(result).unwrap().contains("stale"))));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
}

#[tokio::test]
async fn a_pending_confirmation_survives_jsonl_restart_without_auto_execution() {
    let root = std::env::temp_dir().join(format!(
        "xharness-model-confirm-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let source =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root.join("source")).unwrap());
    let (host, child) = live_host(source.clone(), arguments(), None).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "main", Some("high")).await;
    prompt(&host).await;
    let (_, approval_id, _) = pending(&host).await;
    let journal = source.load("p").await.unwrap().unwrap();
    assert_eq!(child.calls.load(Ordering::SeqCst), 0);
    // Copy the exact durable crash boundary to an isolated store. Gracefully
    // stopping the original process would cancel its approval, not simulate a crash.
    let recovery =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root.join("recovery")).unwrap());
    recovery.create(journal.header().clone()).await.unwrap();
    let mut revision = xharness_session::Revision::ZERO;
    // Mutation receipts end their original revision. Preserve those CAS batch
    // boundaries rather than flattening the whole history into one append.
    for batch in journal.events().chunk_by(|a, b| a.revision == b.revision) {
        revision = recovery
            .append(
                "p",
                revision,
                batch.iter().map(|e| e.event.clone()).collect(),
            )
            .await
            .unwrap()
            .revision;
    }
    recovery.flush("p").await.unwrap();
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
    drop(host);
    drop(source);
    let (resumed, resumed_child) = live_host(recovery.clone(), arguments(), None).await;
    resumed.restore_from_store(recovery.clone()).await.unwrap();
    let (rpc_id, resumed_id, reason) = pending(&resumed).await;
    assert_eq!(resumed_id, approval_id);
    assert!(reason.contains("vendor-level-3"));
    assert_eq!(resumed_child.calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        answer(&resumed, &rpc_id, &resumed_id, "allowed-once").await,
        RpcReceipt::Accepted
    ));
    wait_for_calls(&resumed_child, 1).await;
    settled(&resumed, "p").await;
    assert_eq!(resumed_child.calls.load(Ordering::SeqCst), 1);
    resumed.agent_runtime.shutdown(Duration::from_secs(2)).await;
    resumed.stop_background_listeners();
    drop(resumed);
    drop(recovery);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn inherited_starts_do_not_ask_and_a_pending_override_does_not_lock_other_sessions() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, _) = live_host(store, json!({"action":"start","task":"inspect only"}), None).await;
    parent(&host, "p").await;
    prompt(&host).await;
    settled(&host, "p").await;
    assert!(host.state.read().await.pending.is_empty());
    assert_eq!(
        host.state
            .read()
            .await
            .sessions
            .values()
            .filter(|s| s.delegated)
            .count(),
        1
    );
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, _) = live_host(store, arguments(), None).await;
    parent(&host, "p").await;
    prompt(&host).await;
    let (rpc_id, approval_id, _) = pending(&host).await;
    parent(&host, "other").await;
    // The global creation fence is not held by the human wait.
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        host.execute_agent("other", "independent", start("independent review")),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(result["agent_id"].as_str().is_some());
    assert!(matches!(
        answer(&host, &rpc_id, &approval_id, "rejected").await,
        RpcReceipt::Accepted
    ));
    settled(&host, "p").await;
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
}

#[tokio::test]
async fn effort_only_model_default_and_provider_only_each_confirm_the_resolved_selection() {
    for (args, provider, model, effort) in [
        (
            json!({"action":"start","task":"inspect only","reasoning_effort":"low"}),
            "primary",
            "main",
            Some("low"),
        ),
        (
            json!({"action":"start","task":"inspect only","model":"small"}),
            "primary",
            "small",
            Some("off"),
        ),
        (
            json!({"action":"start","task":"inspect only","provider":"secondary"}),
            "secondary",
            "main",
            None,
        ),
    ] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let (host, child) = live_host(store, args, None).await;
        parent(&host, "p").await;
        user_select(&host, "p", "primary", "main", Some("high")).await;
        prompt(&host).await;
        let (rpc_id, approval_id, reason) = pending(&host).await;
        assert!(reason.contains(&format!("{provider}/{model}")));
        assert!(reason.contains(effort.unwrap_or("provider default")));
        assert_eq!(host.state.read().await.sessions.len(), 1);
        assert!(matches!(
            answer(&host, &rpc_id, &approval_id, "allowed-once").await,
            RpcReceipt::Accepted
        ));
        settled(&host, "p").await;
        let id = host
            .state
            .read()
            .await
            .sessions
            .values()
            .find(|s| s.delegated)
            .unwrap()
            .session_id
            .clone();
        settled(&host, &id).await;
        let state = host.state.read().await;
        let selected = &state.sessions[&id].model;
        assert_eq!(selected.provider, provider);
        assert_eq!(selected.model, model);
        assert_eq!(selected.reasoning_effort.as_deref(), effort);
        assert_eq!(
            state.sessions["p"].model.reasoning_effort.as_deref(),
            Some("high")
        );
        drop(state);
        if model == "small" || provider == "secondary" {
            assert_eq!(child.calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                child.requests.lock().unwrap()[0]
                    .reasoning_effort
                    .as_deref(),
                effort
            );
        }
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        host.stop_background_listeners();
    }
}

#[tokio::test]
async fn invalid_routes_and_efforts_fail_before_a_confirmation_or_child_is_created() {
    for args in [
        json!({"action":"start","task":"inspect only","model":"not-configured"}),
        json!({"action":"start","task":"inspect only","provider":"secondary","reasoning_effort":"high"}),
        json!({"action":"start","task":"inspect only","model":"small","reasoning_effort":"high"}),
    ] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let (host, child) = live_host(store, args, None).await;
        parent(&host, "p").await;
        prompt(&host).await;
        settled(&host, "p").await;
        assert!(host.state.read().await.pending.is_empty());
        assert_eq!(host.state.read().await.sessions.len(), 1);
        assert_eq!(child.calls.load(Ordering::SeqCst), 0);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        host.stop_background_listeners();
    }
}
