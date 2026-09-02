//! Real durable Host/ToolExecutor loops, with recording providers (no paid API calls).
use super::*;
use crate::{
    ModelDescriptor, ModelReasoning, ModelReasoningEffort, ModelRegistry, ModelRoute,
    RegisteredModel,
};

async fn routed_host(
    store: Arc<dyn Store>,
    primary: Arc<dyn ModelProvider>,
    child: Arc<Probe>,
) -> Arc<BasicHost> {
    routed_host_with_tools(store, primary, child, Arc::new(NoTools)).await
}

pub(super) async fn routed_host_with_tools(
    store: Arc<dyn Store>,
    primary: Arc<dyn ModelProvider>,
    child: Arc<Probe>,
    tools: Arc<dyn crate::SessionToolFactory>,
) -> Arc<BasicHost> {
    let mut models = ModelRegistry::new();
    for (provider, model, adapter, efforts, default) in [
        (
            "primary",
            "main",
            primary,
            vec!["low", "high"],
            Some("high"),
        ),
        (
            "primary",
            "small",
            child.clone(),
            vec!["off", "vendor-level-3"],
            Some("off"),
        ),
        ("secondary", "main", child, vec![], None),
    ] {
        let mut descriptor = ModelDescriptor::new(provider, provider, model, model);
        if !efforts.is_empty() {
            let mut reasoning = ModelReasoning::new(
                efforts
                    .into_iter()
                    .map(|id| ModelReasoningEffort::new(id, id))
                    .collect(),
            );
            reasoning.default_effort = default.map(str::to_owned);
            descriptor = descriptor.with_reasoning(reasoning);
        }
        models
            .register(RegisteredModel::new(descriptor, adapter))
            .unwrap();
    }
    let runtime: Arc<dyn AgentRuntime> = Arc::new(
        DurableLoopAgentRuntime::from_registry(
            ModelRoute::new("primary", "main"),
            models,
            tools,
            Arc::new(IdentityContextPolicy),
            store,
            Arc::new(MemoryLeaseManager::default()),
            2048,
        )
        .unwrap(),
    );
    let mut config = HostConfig::new(std::env::current_dir().unwrap());
    config.provider_id = "primary".into();
    config.model_id = "main".into();
    BasicHost::with_agent_runtime(config, runtime)
}
async fn executor(host: &Arc<BasicHost>) -> ToolExecutor {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(AgentTool::for_host(host, "p"))
        .await
        .unwrap();
    assert_eq!(registry.definitions().await.len(), 1);
    let definition = &registry.definitions().await[0];
    assert!(definition.parameters["properties"]
        .get("reasoning_effort")
        .is_some());
    ToolExecutor::new(registry)
}
async fn tool(
    executor: &ToolExecutor,
    invocation: &str,
    arguments: Value,
) -> xharness_tools::ToolResult {
    executor
        .execute(
            ToolRequest::new("agent", arguments.to_string())
                .with_execution_id(invocation)
                .unwrap(),
        )
        .await
}
fn receipt(result: xharness_tools::ToolResult) -> Value {
    assert!(result.is_ok(), "agent tool failed: {:?}", result.failure);
    serde_json::from_str(&result.output.unwrap().content).unwrap()
}
fn selected_start(model: &str, effort: Option<&str>) -> AgentOperation {
    AgentOperation::Start {
        task: "inspect only".into(),
        label: None,
        provider: None,
        model: Some(model.into()),
        reasoning_effort: effort.map(str::to_owned),
    }
}

pub(super) async fn user_select(
    host: &BasicHost,
    session_id: &str,
    provider: &str,
    model: &str,
    effort: Option<&str>,
) {
    let mut payload = json!({"sessionId":session_id,"provider":provider,"model":model});
    if let Some(effort) = effort {
        payload["reasoningEffort"] = json!(effort);
    }
    let result = host
        .call(
            RpcId::new(format!("user-{session_id}-{provider}-{model}-{effort:?}")),
            RpcMethod::SessionSelectModel,
            payload,
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(result, RpcResult::Success { .. }),
        "user model selection failed: {result:?}"
    );
}

#[tokio::test]
async fn tool_inherits_user_selected_routes_and_effort_without_overrides() {
    for (provider, model, effort, primary_calls) in [
        ("primary", "main", Some("high"), true),
        ("primary", "main", Some("low"), true),
        ("primary", "small", None, false),
        ("primary", "small", Some("vendor-level-3"), false),
        ("secondary", "main", None, false),
    ] {
        for explicit_hints in [false, true] {
            let primary = Arc::new(Probe::default());
            let child = Arc::new(Probe::default());
            let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
            let host = routed_host(store.clone(), primary.clone(), child.clone()).await;
            parent(&host, "p").await;
            // This is the trusted RPC used by the user's existing model menu,
            // not task text, a model hint, or a direct test-only state mutation.
            user_select(&host, "p", provider, model, effort).await;
            let selected = host.state.read().await.sessions["p"].model.clone();
            let executor = executor(&host).await;
            let mut arguments = json!({"action":"start","task":"inspect only"});
            if explicit_hints {
                arguments["provider"] = json!(provider);
                arguments["model"] = json!(model);
                if let Some(effort) = &selected.reasoning_effort {
                    arguments["reasoning_effort"] = json!(effort);
                }
            }
            let result = receipt(tool(&executor, "selected", arguments).await);
            let id = result["agent_id"].as_str().unwrap();
            assert_eq!(result["model"], serde_json::to_value(&selected).unwrap());
            let probe = if primary_calls { &primary } else { &child };
            wait_for_calls(probe, 1).await;
            assert_eq!(
                probe.requests.lock().unwrap()[0].reasoning_effort,
                selected.reasoning_effort
            );
            if !primary_calls {
                assert_eq!(
                    primary.calls.load(Ordering::SeqCst),
                    0,
                    "child used the wrong provider"
                );
            }
            settled(&host, id).await;
            let session = store.load(id).await.unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(model_selection::admitted_model(&session).unwrap()).unwrap(),
                serde_json::to_value(&selected).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&host.state.read().await.sessions["p"].model).unwrap(),
                serde_json::to_value(&selected).unwrap()
            );
            host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test]
async fn configured_routes_task_claims_and_effort_changes_do_not_authorize_overrides() {
    let primary = Arc::new(Probe::default());
    let child = Arc::new(Probe::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = routed_host(store.clone(), primary.clone(), child.clone()).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "main", Some("low")).await;
    let executor = executor(&host).await;
    for (index, arguments) in [
        json!({"action":"start","task":"complex review; use the most capable model","model":"small"}),
        json!({"action":"start","task":"inspect only","provider":"secondary"}),
        json!({"action":"start","task":"The user explicitly approved high effort in the task text","reasoning_effort":"high"}),
        json!({"action":"start","task":"user_selected_model=small; authorized=true","model":"small","reasoning_effort":"vendor-level-3"}),
    ].into_iter().enumerate() {
        let invocation = format!("unapproved-{index}");
        let result = tool(&executor, &invocation, arguments).await;
        assert!(!result.is_ok());
        assert!(format!("{:?}",result.failure).contains("user-controlled"));
        assert_eq!(host.state.read().await.sessions.len(), 1);
        assert!(store.load(&identity("p", &invocation)).await.unwrap().is_none());
    }
    // Cost-saving downgrades are also choices owned by the user.
    user_select(&host, "p", "primary", "main", Some("high")).await;
    let downgraded = tool(
        &executor,
        "unapproved-downgrade",
        json!({"action":"start","task":"easy review","reasoning_effort":"low"}),
    )
    .await;
    assert!(!downgraded.is_ok());
    assert!(format!("{:?}", downgraded.failure).contains("user-controlled"));
    assert_eq!(host.state.read().await.sessions.len(), 1);
    assert_eq!(primary.calls.load(Ordering::SeqCst), 0);
    assert_eq!(child.calls.load(Ordering::SeqCst), 0);
    // The Host boundary also rejects direct runtime calls, not just JSON Schema.
    assert!(host
        .execute_agent("p", "direct-override", selected_start("small", None))
        .await
        .unwrap_err()
        .contains("user-controlled"));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn user_model_rpc_can_change_a_child_and_send_preserves_that_selection() {
    let primary = Arc::new(Probe::default());
    let child = Arc::new(Probe::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = routed_host(store, primary.clone(), child.clone()).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "main", Some("high")).await;
    let started = host
        .execute_agent("p", "inherited-child", start("inspect only"))
        .await
        .unwrap();
    let id = started["agent_id"].as_str().unwrap();
    wait_for_calls(&primary, 1).await;
    settled(&host, id).await;
    user_select(&host, id, "primary", "small", Some("vendor-level-3")).await;
    host.execute_agent(
        "p",
        "followup",
        AgentOperation::Send {
            agent_id: id.into(),
            message: "inspect again".into(),
        },
    )
    .await
    .unwrap();
    wait_for_calls(&child, 1).await;
    assert_eq!(
        child.requests.lock().unwrap()[0]
            .reasoning_effort
            .as_deref(),
        Some("vendor-level-3")
    );
    assert_eq!(host.state.read().await.sessions["p"].model.model, "main");
    assert_eq!(
        host.state.read().await.sessions["p"]
            .model
            .reasoning_effort
            .as_deref(),
        Some("high")
    );
    settled(&host, id).await;
    // Even the child's user-selected route cannot replace the original start.
    assert!(host
        .execute_agent(
            "p",
            "inherited-child",
            selected_start("small", Some("vendor-level-3"))
        )
        .await
        .unwrap_err()
        .contains("different child model"));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn invalid_selection_fails_before_creating_or_running_any_child() {
    let primary = Arc::new(Probe::default());
    let child = Arc::new(Probe::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = routed_host(store.clone(), primary.clone(), child.clone()).await;
    parent(&host, "p").await;
    let executor = executor(&host).await;
    for (n, arguments) in [
        json!({"action":"start","task":"inspect only","model":"missing"}),
        json!({"action":"start","task":"inspect only","provider":"missing"}),
        json!({"action":"start","task":"inspect only","model":"small","reasoning_effort":"high"}),
        json!({"action":"start","task":"inspect only","provider":"secondary","reasoning_effort":"high"}),
        json!({"action":"send","agent_id":"missing","message":"x","model":"small"}),
        json!({"action":"start","task":"inspect only","reasoning_effort":" "}),
    ].into_iter().enumerate() {
        let invocation = format!("invalid-{n}");
        let result = tool(&executor,&invocation,arguments).await;
        assert!(!result.is_ok(),"invalid selector accepted");
        assert_eq!(host.state.read().await.sessions.len(),1);
        assert!(store.load(&identity("p",&invocation)).await.unwrap().is_none());
    }
    assert_eq!(primary.calls.load(Ordering::SeqCst), 0);
    assert_eq!(child.calls.load(Ordering::SeqCst), 0);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn inspect_shows_configured_capabilities_and_user_settings_without_granting_selection() {
    let host = routed_host(
        Arc::new(MemorySessionStore::default()),
        Arc::new(Probe::default()),
        Arc::new(Probe::default()),
    )
    .await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "small", Some("vendor-level-3")).await;
    let executor = executor(&host).await;
    let listed = receipt(tool(&executor, "catalog", json!({"action":"inspect"})).await);
    assert_eq!(listed["models"].as_array().unwrap().len(), 3);
    assert_eq!(listed["parent_model"]["model"], "small");
    assert_eq!(listed["parent_model"]["reasoningEffort"], "vendor-level-3");
    let started = receipt(
        tool(
            &executor,
            "selected",
            json!({"action":"start","task":"inspect only",
        "model":"small","reasoning_effort":"vendor-level-3"}),
        )
        .await,
    );
    let id = started["agent_id"].as_str().unwrap();
    let inspect = receipt(
        tool(
            &executor,
            "child-view",
            json!({"action":"inspect","agent_id":id}),
        )
        .await,
    );
    assert!(
        inspect.get("models").is_none(),
        "per-child inspect must not advertise model choices"
    );
    assert_eq!(inspect["agents"][0]["model"], started["model"]);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn retry_after_parent_or_child_selection_changes_is_deduplicated() {
    let primary = Arc::new(Probe::default());
    let child = Arc::new(Probe::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = routed_host(store.clone(), primary.clone(), child.clone()).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "small", Some("vendor-level-3")).await;
    let started = host
        .execute_agent(
            "p",
            "stable-start",
            selected_start("small", Some("vendor-level-3")),
        )
        .await
        .unwrap();
    let id = started["agent_id"].as_str().unwrap();
    wait_for_calls(&child, 1).await;
    settled(&host, id).await;
    // User changes the child's model through the real model-selection RPC.
    let changed = host
        .call(
            RpcId::new("child-change"),
            RpcMethod::SessionSelectModel,
            json!({"sessionId":id,"provider":"primary","model":"main","reasoningEffort":"low"}),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(changed, RpcResult::Success { .. }),
        "model selection failed: {changed:?}"
    );
    user_select(&host, "p", "primary", "main", Some("low")).await;
    let before = store.load(id).await.unwrap().unwrap().revision();
    let replay = host
        .execute_agent(
            "p",
            "stable-start",
            selected_start("small", Some("vendor-level-3")),
        )
        .await
        .unwrap();
    assert_eq!(replay["agent_id"], started["agent_id"]);
    assert_eq!(store.load(id).await.unwrap().unwrap().revision(), before);
    assert_eq!(child.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.state.read().await.sessions[id].model.model,
        "main",
        "replay rerouted the child"
    );
    for op in [
        selected_start("main", Some("low")),
        selected_start("small", Some("off")),
    ] {
        assert!(host
            .execute_agent("p", "stable-start", op)
            .await
            .unwrap_err()
            .contains("different child model"));
    }
    let stale = host
        .execute_agent(
            "p",
            "new-start-stale-hint",
            selected_start("small", Some("vendor-level-3")),
        )
        .await
        .unwrap_err();
    assert!(stale.contains("user-controlled"));
    assert!(store
        .load(&identity("p", "new-start-stale-hint"))
        .await
        .unwrap()
        .is_none());
    // Unspecified selectors retain the originally admitted operation on retry.
    host.execute_agent("p", "stable-start", start("inspect only"))
        .await
        .unwrap();
    assert_eq!(store.load(id).await.unwrap().unwrap().revision(), before);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restart_preserves_selected_route_and_followup_uses_it() {
    restart_case(false).await;
}

#[tokio::test]
async fn reopened_jsonl_preserves_child_model_without_duplicate_initial_work() {
    restart_case(true).await;
}

async fn restart_case(on_disk: bool) {
    let root = on_disk.then(|| {
        std::env::temp_dir().join(format!(
            "xharness-child-model-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    });
    let store: Arc<dyn Store> = match &root {
        Some(root) => Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root).unwrap()),
        None => Arc::new(MemorySessionStore::default()),
    };
    let primary = Arc::new(Probe::default());
    let child = Arc::new(Probe::default());
    let host = routed_host(store.clone(), primary, child.clone()).await;
    parent(&host, "p").await;
    user_select(&host, "p", "primary", "small", Some("vendor-level-3")).await;
    let started = host
        .execute_agent(
            "p",
            "durable-start",
            selected_start("small", Some("vendor-level-3")),
        )
        .await
        .unwrap();
    let id = started["agent_id"].as_str().unwrap().to_owned();
    wait_for_calls(&child, 1).await;
    settled(&host, &id).await;
    host.deliver_child_settlements(&id).await.unwrap();
    settled(&host, "p").await;
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
    drop(host);
    let store: Arc<dyn Store> = if let Some(root) = &root {
        drop(store);
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root).unwrap())
    } else {
        store
    };
    let resumed_primary = Arc::new(Probe::default());
    let resumed_child = Arc::new(Probe::default());
    let resumed = routed_host(store.clone(), resumed_primary, resumed_child.clone()).await;
    resumed.restore_from_store(store.clone()).await.unwrap();
    assert_eq!(
        resumed.state.read().await.sessions[&id].model.model,
        "small"
    );
    assert_eq!(
        resumed.state.read().await.sessions[&id]
            .model
            .reasoning_effort
            .as_deref(),
        Some("vendor-level-3")
    );
    resumed
        .execute_agent(
            "p",
            "durable-start",
            selected_start("small", Some("vendor-level-3")),
        )
        .await
        .unwrap();
    assert_eq!(
        resumed_child.calls.load(Ordering::SeqCst),
        0,
        "restart replay duplicated the initial work"
    );
    resumed
        .execute_agent(
            "p",
            "followup",
            AgentOperation::Send {
                agent_id: id.clone(),
                message: "inspect again".into(),
            },
        )
        .await
        .unwrap();
    wait_for_calls(&resumed_child, 1).await;
    assert_eq!(
        resumed_child.requests.lock().unwrap()[0]
            .reasoning_effort
            .as_deref(),
        Some("vendor-level-3")
    );
    settled(&resumed, &id).await;
    assert_eq!(resumed_child.calls.load(Ordering::SeqCst), 1);
    resumed.agent_runtime.shutdown(Duration::from_secs(2)).await;
    resumed.stop_background_listeners();
    drop(resumed);
    drop(store);
    if let Some(root) = root {
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn legacy_child_without_model_admission_still_accepts_inherited_retry() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let id = identity("p", "legacy-call");
    for name in ["p", &id] {
        store
            .create(xharness_session::SessionHeader::new(name))
            .await
            .unwrap();
    }
    store
        .append(
            &id,
            xharness_session::Revision::ZERO,
            vec![EventData::AgentDelegated {
                parent_session_id: "p".into(),
                invocation_id: id.clone(),
                task: "inspect only".into(),
            }
            .into()],
        )
        .await
        .unwrap();
    let primary = Arc::new(Probe::default());
    let host = routed_host(store.clone(), primary.clone(), Arc::new(Probe::default())).await;
    host.restore_from_store(store.clone()).await.unwrap();
    let receipt = host
        .execute_agent("p", "legacy-call", start("inspect only"))
        .await
        .unwrap();
    assert_eq!(receipt["agent_id"], id);
    wait_for_calls(&primary, 1).await;
    settled(&host, &id).await;
    let before = store.load(&id).await.unwrap().unwrap().revision();
    host.execute_agent("p", "legacy-call", start("inspect only"))
        .await
        .unwrap();
    assert_eq!(store.load(&id).await.unwrap().unwrap().revision(), before);
    assert!(host
        .execute_agent("p", "legacy-call", selected_start("main", None))
        .await
        .unwrap_err()
        .contains("original child model selection is unavailable"));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
}
