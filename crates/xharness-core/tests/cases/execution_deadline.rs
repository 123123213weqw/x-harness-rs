use super::*;
fn deadline_in(ms: u64) -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
        + ms
}
#[tokio::test]
async fn expired_deadline_commits_terminal_failure_without_provider_or_tool_execution() {
    let provider = Arc::new(ScriptProvider::new([]));
    let store = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("fixture")]);
    request.execution_deadline_ms = Some(1);
    request.session_id = Some("expired".into());
    request.journal_store = Some(store.clone());
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result.error.unwrap().contains("timeout_seconds"));
    assert_eq!(provider.attempts(), 0);
    let session = store.load("expired").await.unwrap().unwrap();
    assert!(session.events().iter().any(|e|matches!(e.data(),SessionEventData::TurnEnd{reason:TurnEndReason::Failed{error,..},..} if error.contains("timeout_seconds"))));
}
#[tokio::test]
async fn deadline_cancels_running_handler_and_preserves_known_or_unknown_outcome_without_replay() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "long", "long", "{}")),
        Ok(completed_for_calls()),
    ]]));
    let store = Arc::new(EventMemorySessionStore::default());
    let executions = Arc::new(AtomicUsize::new(0));
    let cleaned = Arc::new(AtomicBool::new(false));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new("long", "long", json!({"type":"object"})),
            {
                let executions = executions.clone();
                let cleaned = cleaned.clone();
                move |context| {
                    let executions = executions.clone();
                    let cleaned = cleaned.clone();
                    async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        context.cancellation.cancelled().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        cleaned.store(true, Ordering::SeqCst);
                        Err(RuntimeToolHandlerError::new("cancelled after cleanup"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    request.execution_deadline_ms = Some(deadline_in(1000));
    request.session_id = Some("active-timeout".into());
    request.journal_store = Some(store.clone());
    let (_, result) =
        tokio::time::timeout(Duration::from_secs(6), collect(LoopEngine.start(request)))
            .await
            .unwrap();
    assert_eq!(result.status, LoopStatus::Failed, "{:?}", result.error);
    assert!(result.error.unwrap().contains("timeout_seconds"));
    assert!(cleaned.load(Ordering::SeqCst));
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(provider.attempts(), 1);
    let s = store.load("active-timeout").await.unwrap().unwrap();
    assert!(xharness_session::incomplete_tool_calls(s.events()).is_empty());
    assert!(s.events().iter().any(|e|matches!(e.data(),SessionEventData::ToolResult{result,..} if result.outcome!=ToolOutcome::Success)));
}
#[tokio::test]
async fn expired_recovered_approval_is_cancelled_not_executed_or_reasked() {
    let store = Arc::new(EventMemorySessionStore::default());
    store
        .create(SessionHeader::new("approval-timeout"))
        .await
        .unwrap();
    let call = ToolCall {
        id: "pending-call".into(),
        name: "guarded".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(call.clone());
    store
        .append(
            "approval-timeout",
            Revision::ZERO,
            vec![
                SessionEventData::TurnStart { turn: 1 }.into(),
                SessionEventData::UserMessage {
                    message: AgentMessage::user("run"),
                    surface_replace: None,
                }
                .into(),
                SessionEventData::StepStart { turn: 1, step: 1 }.into(),
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                SessionEventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call.clone(),
                }
                .into(),
                SessionEventData::ApprovalAsked {
                    id: "pending-approval".into(),
                    tool_name: "guarded".into(),
                    call_id: Some(call.id),
                    reason: None,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
            {
                let executions = executions.clone();
                move |_| {
                    let executions = executions.clone();
                    async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        Ok(RuntimeToolOutput::text("must not run"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let provider = Arc::new(ScriptProvider::new([]));
    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.execution_deadline_ms = Some(1);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    request.session_id = Some("approval-timeout".into());
    request.journal_store = Some(store.clone());
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed, "{:?}", result.error);
    assert!(result.error.unwrap().contains("timeout_seconds"));
    let s = store.load("approval-timeout").await.unwrap().unwrap();
    assert!(s.pending_tool_approvals().is_empty());
    assert!(xharness_session::incomplete_tool_calls(s.events()).is_empty());
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert_eq!(provider.attempts(), 0);
    assert!(s.events().iter().any(|e| matches!(
        e.data(),
        SessionEventData::ApprovalDecided {
            outcome: ApprovalOutcome::Cancelled,
            ..
        }
    )));
}

#[tokio::test]
async fn narrowed_recovered_call_cannot_regain_tools_or_a_fresh_model_step() {
    let store = Arc::new(EventMemorySessionStore::default());
    store
        .create(SessionHeader::new("approval-timeout"))
        .await
        .unwrap();
    let call = ToolCall {
        id: "pending-call".into(),
        name: "guarded".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(call.clone());
    store
        .append(
            "approval-timeout",
            Revision::ZERO,
            vec![
                SessionEventData::TurnStart { turn: 1 }.into(),
                SessionEventData::UserMessage {
                    message: AgentMessage::user("run"),
                    surface_replace: None,
                }
                .into(),
                SessionEventData::StepStart { turn: 1, step: 1 }.into(),
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                SessionEventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call.clone(),
                }
                .into(),
                SessionEventData::ApprovalAsked {
                    id: "pending-approval".into(),
                    tool_name: "guarded".into(),
                    call_id: Some(call.id),
                    reason: None,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
            {
                let executions = executions.clone();
                move |_| {
                    let executions = executions.clone();
                    async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        Ok(RuntimeToolOutput::text("must not run"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let provider = Arc::new(ScriptProvider::new([]));
    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.config.max_steps = 1;
    request.tool_executor = Some(
        RuntimeToolExecutor::new(registry)
            .restrict_tools(&std::collections::BTreeSet::new())
            .await,
    );
    request.session_id = Some("approval-timeout".into());
    request.journal_store = Some(store.clone());
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(
        result.status,
        LoopStatus::LimitReached,
        "{:?}",
        result.error
    );
    assert!(result.error.is_none());
    let s = store.load("approval-timeout").await.unwrap().unwrap();
    assert!(s.pending_tool_approvals().is_empty());
    assert!(xharness_session::incomplete_tool_calls(s.events()).is_empty());
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert_eq!(provider.attempts(), 0);
    assert!(s.events().iter().any(|e| matches!(
        e.data(),
        SessionEventData::ApprovalDecided {
            outcome: ApprovalOutcome::Cancelled,
            ..
        }
    )));
}
