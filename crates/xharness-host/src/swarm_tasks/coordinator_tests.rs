//! Real ToolExecutor, shared board service, disk stores and durable Agent inboxes.
use super::*;
use crate::AgentTool;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

async fn executor(host: &Arc<BasicHost>, caller: &str) -> ToolExecutor {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(AgentTool::for_session(host, caller).await)
        .await
        .unwrap();
    assert_eq!(
        registry.definitions().await.len(),
        1,
        "do not introduce another tool"
    );
    ToolExecutor::new(registry)
}
async fn invoke(executor: &ToolExecutor, invocation: &str, team: &str, command: Value) -> Value {
    let request = ToolRequest::new(
        "agent",
        json!({"action":"tasks","swarm_id":team,"command":command}).to_string(),
    )
    .with_execution_id(invocation)
    .unwrap();
    let result = executor.execute(request).await;
    assert!(result.is_ok(), "tool failed: {result:?}");
    serde_json::from_str(&result.output.unwrap().content).unwrap()
}
fn operation(team: &str, command: Value) -> AgentOperation {
    serde_json::from_value(json!({"action":"tasks","swarm_id":team,"command":command})).unwrap()
}
fn row<'a>(page: &'a Value, task: &str) -> &'a Value {
    page["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["task"]["id"] == task)
        .unwrap()
}

#[tokio::test]
async fn swarm_coordinator_schema_only_exposes_owned_open_teams_and_host_rechecks_cached_scope() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    create_session(&host, "normal").await;
    let normal = store.load("normal").await.unwrap().unwrap();
    for caller in ["normal", child.as_str()] {
        assert_eq!(
            AgentTool::for_session(&host, caller).await.definition,
            AgentTool::for_host(&host, caller).definition
        );
        assert!(host
            .execute_agent(caller, "forged", operation(&team, json!({"action":"list"})))
            .await
            .is_err());
        let ex = executor(&host, caller).await;
        assert!(!ex
            .execute(ToolRequest::new(
                "agent",
                json!({"action":"tasks","swarm_id":team,"command":{"action":"list"}}).to_string()
            ))
            .await
            .is_ok());
    }
    create_session(&host, "other-coordinator").await;
    let foreign = success(
        manage(
            &host,
            "foreign-owned-team",
            "other-coordinator",
            json!({"action":"create","objective":"Other team"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(host
        .execute_agent(
            "owner",
            "cross-owner-board",
            operation(&foreign, json!({"action":"list"}))
        )
        .await
        .is_err());
    let spec = AgentTool::for_session(&host, "owner").await;
    assert_eq!(
        spec.definition.parameters["properties"]["swarm_id"]["enum"],
        json!([team])
    );
    let catalog = spec.definition.parameters["properties"]["swarm_id"]["description"]
        .as_str()
        .unwrap();
    assert!(catalog.contains("Research and synthesize"));
    assert!(!catalog.contains("Other team"));
    let cached = executor(&host, "owner").await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    success(manage(&host,"close-tool-team","owner",json!({"action":"set_status","swarmId":team,"expectedRevision":revision,"status":"closed"})).await);
    assert_eq!(
        AgentTool::for_session(&host, "owner").await.definition,
        AgentTool::for_host(&host, "owner").definition
    );
    assert!(!cached
        .execute(ToolRequest::new(
            "agent",
            json!({"action":"tasks","swarm_id":team,"command":{"action":"list"}}).to_string()
        ))
        .await
        .is_ok());
    assert_eq!(
        store.load("normal").await.unwrap().unwrap().revision(),
        normal.revision()
    );
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_coordinator_tool_add_assign_exact_evidence_review_and_ui_share_one_board() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let ex = executor(&host, "owner").await;
    let page = invoke(&ex, "tool-list", &team, json!({"action":"list"})).await;
    assert_eq!(page["workers"][0]["worker_session_id"], child);
    let add = json!({"action":"add","expected_revision":page["revision"],"title":"Collect sources","instructions":"Find supporting evidence"});
    let first = invoke(&ex, "tool-add", &team, add.clone()).await;
    assert_eq!(
        invoke(&ex, "tool-add", &team, add).await,
        first,
        "retry must return receipt, not add another task"
    );
    let id = first["taskId"].as_str().unwrap();
    let next = board_add(&host, &team, "Synthesize", vec![id.into()]).await;
    let list = invoke(&ex, "tool-list-2", &team, json!({"action":"list"})).await;
    let assign = json!({"action":"assign","expected_revision":list["revision"],"task_id":id,"worker_session_id":child});
    let claim = invoke(&ex, "tool-assign", &team, assign.clone()).await;
    assert_eq!(invoke(&ex, "tool-assign", &team, assign).await, claim);
    let delivery = claim["deliveryId"].as_str().unwrap();
    let turn = board_wait_delivery(&host, &child, delivery).await;
    let list = invoke(&ex, "tool-list-3", &team, json!({"action":"list"})).await;
    assert_eq!(row(&list, id)["attempt"]["turn"], turn);
    assert_eq!(row(&list, id)["attempt"]["message_id"], delivery);
    assert_eq!(row(&list, id)["attempt"]["answer"], "verified result");
    let review = json!({"action":"review","expected_revision":list["revision"],"task_id":id,"execution_ref":row(&list,id)["attempt"]["execution_ref"],"outcome":"completed","summary":"Evidence checked"});
    let accepted = invoke(&ex, "tool-review", &team, review.clone()).await;
    assert_eq!(
        invoke(&ex, "tool-review", &team, review.clone()).await,
        accepted
    );
    let final_page = board_list(&host, &team).await;
    assert_eq!(
        row(&final_page, id)["task"]["state"]["outcome"],
        "completed"
    );
    assert_eq!(row(&final_page, &next)["ready"], true);
    assert_eq!(store.load(&child).await.unwrap().unwrap().events().iter().filter(|e|matches!(e.data(),EventData::UserMessage { message,..} if message.id.as_deref()==Some(delivery))).count(),1);
    // Same execution identity cannot be changed to a second mutation.
    let mut changed = review;
    changed["summary"] = json!("changed request");
    assert!(host
        .execute_agent("owner", "tool-review", operation(&team, changed))
        .await
        .is_err());
    settle(&host, "owner").await;
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_coordinator_review_rejects_forged_reference_and_ignores_unrelated_latest_turn() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "specific evidence", vec![]).await;
    let claim = board_claim(&host, &team, &task, &child, "exact-claim").await;
    let turn = board_wait_delivery(&host, &child, claim["deliveryId"].as_str().unwrap()).await;
    let ex = executor(&host, "owner").await;
    let first = invoke(&ex, "evidence-1", &team, json!({"action":"list"})).await;
    host.execute_agent(
        "owner",
        "unrelated-send",
        AgentOperation::Send {
            agent_id: child.clone(),
            message: "Unrelated follow-up".into(),
        },
    )
    .await
    .unwrap();
    settle(&host, &child).await;
    let second = invoke(&ex, "evidence-2", &team, json!({"action":"list"})).await;
    assert_eq!(row(&second, &task)["attempt"]["turn"], turn);
    assert_eq!(
        row(&second, &task)["attempt"]["execution_ref"],
        row(&first, &task)["attempt"]["execution_ref"]
    );
    assert!(host.execute_agent("owner","forged-proof",operation(&team,json!({"action":"review","expected_revision":second["revision"],"task_id":task,"execution_ref":"invented","outcome":"completed","summary":"guess"}))).await.is_err());
    let waiting = board_add(&host, &team, "not the same task", vec![]).await;
    let page = board_list(&host, &team).await;
    assert!(host.execute_agent("owner","cross-task-proof",operation(&team,json!({"action":"review","expected_revision":page["revision"],"task_id":waiting,"execution_ref":row(&second,&task)["attempt"]["execution_ref"],"outcome":"completed","summary":"wrong task"}))).await.is_err());
    // A valid historical execution reference cannot accept work through a later unknown effect.
    host.set_dispatch_paused(&child, true).await.unwrap();
    let call = ToolCall {
        id: "unknown-after-task".into(),
        name: "fixture_unknown_effect".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut assistant = Message::assistant("");
    assistant.tool_calls.push(call.clone());
    host.commit_session_events(
        &child,
        vec![
            EventData::TurnStart { turn: turn + 2 }.into(),
            EventData::UserMessage {
                message: Message::user("Interrupted unrelated work"),
                surface_replace: None,
            }
            .into(),
            EventData::StepStart {
                turn: turn + 2,
                step: 1,
            }
            .into(),
            EventData::AssistantMessage {
                turn: turn + 2,
                step: 1,
                message: assistant,
                usage: None,
            }
            .into(),
            EventData::ToolCall {
                turn: turn + 2,
                step: 1,
                call,
            }
            .into(),
        ],
    )
    .await
    .unwrap();
    let review = operation(
        &team,
        json!({"action":"review","expected_revision":page["revision"],"task_id":task,"execution_ref":row(&second,&task)["attempt"]["execution_ref"],"outcome":"completed","summary":"Cannot bypass unresolved operation"}),
    );
    assert!(host
        .execute_agent("owner", "unresolved-guard", review)
        .await
        .unwrap_err()
        .contains("unresolved tool outcomes"));
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_coordinator_restart_replays_tool_receipts_without_adding_or_readmitting_work() {
    let disk = Disk::new();
    let provider = Arc::new(Provider::default());
    let (host, runtime, store) = setup(&disk, provider.clone());
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let page = board_list(&host, &team).await;
    let add = json!({"action":"add","expected_revision":page["revision"],"title":"Restart","instructions":"Retain evidence"});
    let added = host
        .execute_agent("owner", "restart-add", operation(&team, add.clone()))
        .await
        .unwrap();
    let task = added["taskId"].as_str().unwrap();
    let page = board_list(&host, &team).await;
    let assign = json!({"action":"assign","expected_revision":page["revision"],"task_id":task,"worker_session_id":child});
    let claim = host
        .execute_agent("owner", "restart-assign", operation(&team, assign.clone()))
        .await
        .unwrap();
    board_wait_delivery(&host, &child, claim["deliveryId"].as_str().unwrap()).await;
    settle(&host, "owner").await;
    stop_host(host, runtime).await;
    let (cold, runtime, store) = setup(&disk, provider);
    cold.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let ex = executor(&cold, "owner").await;
    assert_eq!(invoke(&ex, "restart-add", &team, add).await, added);
    assert_eq!(invoke(&ex, "restart-assign", &team, assign).await, claim);
    assert_eq!(
        board_list(&cold, &team).await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let delivery = claim["deliveryId"].as_str().unwrap();
    assert_eq!(store.load(&child).await.unwrap().unwrap().events().iter().filter(|e|matches!(e.data(),EventData::UserMessage { message,..} if message.id.as_deref()==Some(delivery))).count(),1);
    stop_host(cold, runtime).await;
}

#[tokio::test]
async fn swarm_coordinator_never_picks_work_on_read_and_respects_owner_stop_and_team_pause() {
    let disk = Disk::new();
    let provider = Arc::new(Provider::default());
    let (host, runtime, store) = setup(&disk, provider.clone());
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "Do not auto-pick", vec![]).await;
    settle(&host, "owner").await;
    let calls = provider.0.lock().unwrap().len();
    let ex = executor(&host, "owner").await;
    invoke(&ex, "read-no-work", &team, json!({"action":"list"})).await;
    host.reconcile_swarm_task_deliveries().await.unwrap();
    assert_eq!(provider.0.lock().unwrap().len(), calls);
    let page = board_list(&host, &team).await;
    success(manage(&host,"pause-coordinator-team","owner",json!({"action":"set_status","swarmId":team,"expectedRevision":page["revision"],"status":"paused"})).await);
    let page = invoke(&ex, "paused-read", &team, json!({"action":"list"})).await;
    assert!(host.execute_agent("owner","paused-assign",operation(&team,json!({"action":"assign","expected_revision":page["revision"],"task_id":task,"worker_session_id":child}))).await.is_err());
    host.set_dispatch_paused("owner", true).await.unwrap();
    assert_eq!(
        AgentTool::for_session(&host, "owner").await.definition,
        AgentTool::for_host(&host, "owner").definition
    );
    assert!(host
        .execute_agent(
            "owner",
            "stopped-owner",
            operation(&team, json!({"action":"list"}))
        )
        .await
        .is_err());
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_coordinator_can_reject_normal_turn_without_unlocking_dependent_work() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "review quality", vec![]).await;
    let next = board_add(&host, &team, "blocked result", vec![task.clone()]).await;
    let claim = board_claim(&host, &team, &task, &child, "reject-attempt").await;
    board_wait_delivery(&host, &child, claim["deliveryId"].as_str().unwrap()).await;
    let ex = executor(&host, "owner").await;
    let page = invoke(&ex, "reject-list", &team, json!({"action":"list"})).await;
    invoke(&ex,"reject-normal",&team,json!({"action":"review","expected_revision":page["revision"],"task_id":task,"execution_ref":row(&page,&task)["attempt"]["execution_ref"],"outcome":"failed","summary":"The answer lacks supporting evidence"})).await;
    let page = board_list(&host, &team).await;
    assert_eq!(row(&page, &next)["ready"], false);
    stop_host(host, runtime).await;
}

struct ScopedTools(std::sync::OnceLock<std::sync::Weak<BasicHost>>);
#[async_trait]
impl crate::SessionToolFactory for ScopedTools {
    async fn executor(
        &self,
        session: &str,
        _: &str,
        _: crate::PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let host = self
            .0
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or("fixture host missing")?;
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(AgentTool::for_session(&host, session).await)
            .await
            .map_err(|e| e.to_string())?;
        Ok(ToolExecutor::new(registry)
            .with_guards(vec![AgentTool::model_selection_guard(&host, session)]))
    }
}
#[derive(Default)]
struct ScriptedCoordinator {
    stage: std::sync::atomic::AtomicUsize,
    seen: Mutex<Vec<ProviderRequest>>,
}
#[async_trait]
impl ModelProvider for ScriptedCoordinator {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.seen.lock().unwrap().push(request.clone());
        let team = request
            .tools
            .iter()
            .find(|t| t.name == "agent")
            .and_then(|t| t.parameters["properties"]["swarm_id"]["enum"][0].as_str());
        let command = if let Some(team) = team {
            match self.stage.fetch_add(1, Ordering::SeqCst) {
                0 => Some(json!({"action":"tasks","swarm_id":team,"command":{"action":"list"}})),
                1 => {
                    let result = request
                        .messages
                        .iter()
                        .rev()
                        .find(|m| m.role == xharness_core::Role::Tool)
                        .unwrap();
                    let outer: Value = serde_json::from_str(&result.content).unwrap();
                    let page: Value =
                        serde_json::from_str(outer["content"].as_str().unwrap()).unwrap();
                    Some(
                        json!({"action":"tasks","swarm_id":team,"command":{"action":"add","expected_revision":page["revision"],"title":"Model-created work","instructions":"Collect a reproducible test result"}}),
                    )
                }
                _ => None,
            }
        } else {
            None
        };
        let events = match command {
            Some(command) => vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: format!("coordinator-step-{}", request.step),
                    name: "agent".into(),
                    arguments_delta: command.to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ],
            None => vec![
                Ok(ProviderEvent::TextDelta(
                    "Recorded the requested work.".into(),
                )),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ],
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
#[tokio::test]
async fn swarm_coordinator_model_loop_uses_projected_agent_tool_without_a_second_execution_loop() {
    let disk = Disk::new();
    let store = disk.sessions();
    let provider = Arc::new(ScriptedCoordinator::default());
    let tools = Arc::new(ScopedTools(std::sync::OnceLock::new()));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test",
        Some(provider.clone()),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        16384,
    ));
    let mut config = HostConfig::new(disk.0.clone());
    config.provider_id = "test".into();
    config.model_id = "test".into();
    let host =
        BasicHost::with_agent_runtime_and_control_store(config, runtime.clone(), disk.control());
    tools.0.set(Arc::downgrade(&host)).unwrap();
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    create_session(&host, "owner").await;
    create_session(&host, "ordinary-model").await;
    let team = success(
        manage(
            &host,
            "model-team",
            "owner",
            json!({"action":"create","objective":"Coordinator tool integration"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    success(host.call(RpcId::new("model-prompt"),RpcMethod::SessionPrompt,json!({"sessionId":"owner","mode":"queue","content":[{"type":"text","text":"List the Swarm board, then add one evidence task."}]}),CancellationToken::new()).await);
    settle(&host, "owner").await;
    let page = board_list(&host, &team).await;
    assert_eq!(page["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(page["tasks"][0]["task"]["title"], "Model-created work");
    let journal = store.load("owner").await.unwrap().unwrap();
    assert_eq!(
        journal
            .events()
            .iter()
            .filter(|e| matches!(e.data(),EventData::ToolCall { call,..} if call.name=="agent"))
            .count(),
        2
    );
    assert!(journal.events().iter().all(|e|!matches!(e.data(),EventData::ToolResult { result,..} if result.outcome!=ToolOutcome::Success)));
    let before = provider.seen.lock().unwrap().len();
    success(host.call(RpcId::new("normal-model-prompt"),RpcMethod::SessionPrompt,json!({"sessionId":"ordinary-model","mode":"queue","content":[{"type":"text","text":"Reply normally."}]}),CancellationToken::new()).await);
    settle(&host, "ordinary-model").await;
    {
        let seen = provider.seen.lock().unwrap();
        assert!(seen.len() > before);
        for request in &seen[before..] {
            let tool = request.tools.iter().find(|t| t.name == "agent").unwrap();
            assert!(tool.parameters["properties"].get("swarm_id").is_none());
            assert!(!tool.description.contains("Swarm coordinator scope"));
        }
    }
    stop_host(host, runtime).await;
}
