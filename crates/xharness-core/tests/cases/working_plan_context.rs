// Included by loop.rs to exercise the actual request/budget/journal paths.
fn context_plan(revision: u64) -> xharness_session::SessionPlan {
    xharness_session::SessionPlan {
        revision,
        items: vec![xharness_session::PlanItem {
            id: "verify".into(),
            title: "Verify parser, not a request to execute it".into(),
            status: xharness_session::PlanItemStatus::Pending,
        }],
    }
}

async fn append_context_plan(
    store: &dyn EventStore,
    id: &str,
    plan: xharness_session::SessionPlan,
) {
    let session = store.load(id).await.unwrap().unwrap();
    store
        .append(
            id,
            session.revision(),
            vec![SessionEventData::SessionPlanUpdated { plan }.into()],
        )
        .await
        .unwrap();
}

fn plan_notes(messages: &[AgentMessage]) -> Vec<&AgentMessage> {
    messages
        .iter()
        .filter(|m| m.id.as_deref() == Some("session-working-plan-context"))
        .collect()
}

fn unused_goal_tool() -> TestToolSpec {
    TestToolSpec::new("goal", "goal", json!({"type":"object"}), |_, _| async {
        panic!("no implicit goal operation may execute")
    })
}

#[tokio::test]
async fn working_plan_context_replay_stable_across_steps_retries_and_new_user_scope() {
    let store = Arc::new(EventMemorySessionStore::default());
    store
        .create(SessionHeader::new("plan-replay"))
        .await
        .unwrap();
    append_context_plan(store.as_ref(), "plan-replay", context_plan(1)).await;
    let provider = Arc::new(ScriptProvider::with_attempts([
        Err(ProviderError::retryable("transient fixture failure")),
        Ok(vec![
            Ok(tool_delta(0, "inspect-1", "inspect", "{}")),
            Ok(completed_for_calls()),
        ]),
        Ok(vec![
            Ok(tool_delta(0, "inspect-2", "inspect", "{}")),
            Ok(completed_for_calls()),
        ]),
        Ok(vec![
            Ok(ProviderEvent::TextDelta(
                "load inspected; parser left alone".into(),
            )),
            Ok(completed()),
        ]),
    ]));
    let latest_user =
        AgentMessage::user("Do not continue parser work; inspect load only").with_id("new-scope");
    let mut request = LoopRequest::new(provider.clone(), vec![latest_user.clone()]);
    let prompt = PromptAssembler
        .assemble([PromptSection::new("identity", "1", "Stable system")])
        .unwrap();
    let system = prompt.system().to_owned();
    request.prompt = Some(prompt);
    request.session_id = Some("plan-replay".into());
    request.journal_store = Some(store.clone());
    request.config.provider_retry_base_delay_ms = 1;
    request.config.provider_retry_max_delay_ms = 1;
    install_tools(
        &mut request,
        vec![
            unused_goal_tool(),
            TestToolSpec::new(
                "inspect",
                "inspect",
                json!({"type":"object"}),
                |_, _| async { ToolResult::success("load=0.2") },
            ),
        ],
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let requests = provider.requests();
    assert_eq!(requests.len(), 4, "no probe or plan-driven extra turn");
    let first_note = plan_notes(&requests[0].messages)[0].clone();
    for req in &requests {
        let notes = plan_notes(&req.messages);
        assert_eq!(notes, vec![&first_note]);
        assert_eq!(
            notes[0].role,
            Role::User,
            "snapshot must not become system authority"
        );
        assert_eq!(req.messages[0], AgentMessage::system(&system));
        let note_index = req
            .messages
            .iter()
            .position(|m| m.id.as_deref() == Some("session-working-plan-context"))
            .unwrap();
        let user_index = req
            .messages
            .iter()
            .position(|m| m.id.as_deref() == Some("new-scope"))
            .unwrap();
        assert!(note_index < user_index);
        assert_eq!(&req.messages[user_index], &latest_user);
    }
    assert!(
        plan_notes(&result.messages).is_empty(),
        "not stored in runner transcript"
    );
    let session = store.load("plan-replay").await.unwrap().unwrap();
    assert!(
        plan_notes(&session.derive_messages()).is_empty(),
        "no synthetic durable user input"
    );
    assert!(session.events().iter().all(|e| !matches!(
        e.data(),
        SessionEventData::GoalExecution { .. } | SessionEventData::GoalChange { .. }
    )));
    assert_eq!(
        xharness_session::session_plan(&session).unwrap().revision,
        1
    );
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), SessionEventData::TurnStart { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn working_plan_context_current_tool_receipt_replaces_snapshot_and_clear_removes_it() {
    for (clear, drop_receipt) in [(false, false), (true, false), (false, true)] {
        let store = Arc::new(EventMemorySessionStore::default());
        let id = if clear { "plan-clear" } else if drop_receipt { "plan-receipt-projected" } else { "plan-receipt" };
        store.create(SessionHeader::new(id)).await.unwrap();
        append_context_plan(store.as_ref(), id, context_plan(1)).await;
        let provider = Arc::new(ScriptProvider::new([
            vec![
                Ok(tool_delta(
                    0,
                    "plan-update",
                    "goal",
                    r#"{"action":"update_plan"}"#,
                )),
                Ok(completed_for_calls()),
            ],
            vec![Ok(ProviderEvent::TextDelta("done".into())), Ok(completed())],
        ]));
        let mut request = LoopRequest::new(
            provider.clone(),
            vec![AgentMessage::user("Track verification")],
        );
        request.session_id = Some(id.into());
        request.journal_store = Some(store.clone());
        if drop_receipt { request.context_policy = Arc::new(RecordingCompactionPolicy::default()); }
        let tool_store = store.clone();
        install_tool(
            &mut request,
            TestToolSpec::new("goal", "goal", json!({"type":"object"}), move |_, _| {
                let tool_store = tool_store.clone();
                async move {
                    let mut plan = context_plan(2);
                    if clear {
                        plan.items.clear();
                    } else {
                        plan.items[0].status = xharness_session::PlanItemStatus::Completed;
                    }
                    append_context_plan(tool_store.as_ref(), id, plan.clone()).await;
                    ToolResult::success(json!({"accepted":true,"result":{"plan":plan}}).to_string())
                }
            }),
        )
        .await;
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
        let requests = provider.requests();
        assert_eq!(plan_notes(&requests[0].messages).len(), 1);
        if drop_receipt {
            let notes = plan_notes(&requests[1].messages);
            assert_eq!(notes.len(), 1, "restore state after policy hid the receipt");
            assert!(notes[0].content.contains("\"revision\":2"));
            assert!(!notes[0].content.contains("\"revision\":1"));
        } else {
            assert!(plan_notes(&requests[1].messages).is_empty(), "no stale revision 1 note after update/clear");
        }
        let next = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
        let mut replay = LoopRequest::new(next.clone(), vec![AgentMessage::user("Only report")]);
        replay.session_id = Some(id.into());
        replay.journal_store = Some(store.clone());
        install_tool(&mut replay, unused_goal_tool()).await;
        let (_, result) = collect(LoopEngine.start(replay)).await;
        assert_eq!(result.status, LoopStatus::Completed);
        assert!(
            plan_notes(&next.requests()[0].messages).is_empty(),
            "visible receipt survives subsequent journal replay"
        );
    }
}

#[tokio::test]
async fn working_plan_context_absent_empty_unregistered_and_other_session_leave_requests_unchanged()
{
    for case in ["absent", "empty", "unregistered", "other-session"] {
        let store = Arc::new(EventMemorySessionStore::default());
        store.create(SessionHeader::new(case)).await.unwrap();
        store.create(SessionHeader::new("unrelated")).await.unwrap();
        append_context_plan(store.as_ref(), "unrelated", context_plan(1)).await;
        if matches!(case, "empty" | "unregistered") {
            let mut plan = context_plan(1);
            if case == "empty" {
                plan.items.clear();
            }
            append_context_plan(store.as_ref(), case, plan).await;
        }
        let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
        let user = AgentMessage::user("Report only");
        let mut request = LoopRequest::new(provider.clone(), vec![user.clone()]);
        request.session_id = Some(case.into());
        request.journal_store = Some(store.clone());
        if case != "unregistered" {
            install_tool(&mut request, unused_goal_tool()).await;
        }
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Completed);
        assert_eq!(provider.requests()[0].messages, vec![user], "case {case}");
    }
}

#[tokio::test]
async fn working_plan_context_compaction_candidate_budget_matches_live_and_snapshot_is_not_summarized(
) {
    let id = "compact-plan-context";
    let (mut request, store, scripted) = compaction_commit_fault_request(id, false, false).await;
    append_context_plan(&store.inner, id, context_plan(1)).await;
    *scripted.counts.lock().unwrap() = [880, 500, 300, 300, 300].into();
    let provider = Arc::new(RecordingCompactionCounts {
        inner: scripted.as_ref().clone(),
        counted: Mutex::new(Vec::new()),
    });
    request.provider = provider.clone();
    install_tool(&mut request, unused_goal_tool()).await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let counted = provider.counted.lock().unwrap().clone();
    let candidate_and_live = counted
        .iter()
        .filter(|r| {
            r.messages.iter().any(|m| {
                m.id.as_deref()
                    .is_some_and(|id| id.starts_with("compaction-checkpoint-"))
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(candidate_and_live.len(), 2);
    assert_eq!(
        candidate_and_live[0].messages, candidate_and_live[1].messages,
        "candidate admission includes exact same snapshot bytes"
    );
    assert_eq!(plan_notes(&candidate_and_live[0].messages).len(), 1);
    let streamed = provider.inner.inner.requests();
    assert_eq!(
        streamed.len(),
        2,
        "one summary and one main call, no extra probe/turn"
    );
    assert!(
        plan_notes(&streamed[0].messages).is_empty(),
        "summary uses only durable raw history"
    );
    assert_eq!(plan_notes(&streamed[1].messages).len(), 1);
    let session = store.load(id).await.unwrap().unwrap();
    assert!(session
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    assert_eq!(
        xharness_session::session_plan(&session),
        Some(context_plan(1))
    );
    assert!(plan_notes(&session.derive_messages()).is_empty());
}
