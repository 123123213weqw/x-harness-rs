// Synthetic cold-restart admission regressions. No real history or model I/O.
#[derive(Clone, Copy)]
enum WorkingSetCounterFault {
    Http550,
    RateLimited,
    Unauthorized,
    Unsupported,
    Timeout,
    Calibrated,
}

struct WorkingSetVerificationProbe {
    inner: ScriptProvider,
    counted: Mutex<Vec<ProviderRequest>>,
    fault: WorkingSetCounterFault,
    always_large: bool,
    high_pressure: AtomicBool,
}

impl WorkingSetVerificationProbe {
    fn has_retirable_result(request: &ProviderRequest) -> bool {
        request.messages.iter().any(|message| {
            message.role == Role::Tool && message.content.contains("CALIBRATION_RAW_")
        })
    }

    fn estimated_input(&self, request: &ProviderRequest) -> u64 {
        if self.always_large || Self::has_retirable_result(request) {
            2_322_726
        } else if self.high_pressure.load(Ordering::SeqCst) {
            13_500
        } else {
            2_000
        }
    }
}

#[async_trait]
impl ModelProvider for WorkingSetVerificationProbe {
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.counted.lock().unwrap().push(request.clone());
        match self.fault {
            WorkingSetCounterFault::Http550 => {
                Err(ProviderError::http(550, "synthetic counter outage"))
            }
            WorkingSetCounterFault::RateLimited => {
                let mut error = ProviderError::http(429, "synthetic rate limit");
                error.retry_after_ms = Some(120_000);
                Err(error)
            }
            WorkingSetCounterFault::Unauthorized => {
                Err(ProviderError::http(401, "synthetic unauthorized counter"))
            }
            WorkingSetCounterFault::Unsupported => Ok(None),
            WorkingSetCounterFault::Timeout => {
                cancellation.cancelled().await;
                Ok(None)
            }
            WorkingSetCounterFault::Calibrated => Ok(Some(ProviderInputTokenCount {
                counter: "working-set-fixture/calibrated".into(),
                input_tokens: self.estimated_input(request),
                accuracy: xharness_token::TokenCountAccuracy::Calibrated,
            })),
        }
    }

    fn estimate_input_tokens(&self, request: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        Some(ProviderInputTokenCount {
            counter: "working-set-fixture/complete-request-ceiling".into(),
            input_tokens: self.estimated_input(request),
            accuracy: xharness_token::TokenCountAccuracy::ConservativeUpperBound,
        })
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.inner.stream(request, cancellation).await
    }
}

fn working_set_prompt(version: &str) -> xharness_prompt::PromptAssembly {
    PromptAssembler
        .assemble([PromptSection::new(
            "identity",
            version,
            format!("System {version}; inspect only; never publish."),
        )])
        .unwrap()
}

async fn cold_working_set_fixture(id: &str) -> Arc<EventMemorySessionStore> {
    let store = Arc::new(EventMemorySessionStore::default());
    seed_long_compaction_history(store.as_ref(), id).await;
    let provider = Arc::new(DensityMismatchCounter {
        inner: ScriptProvider::new(stable_prefix_scripts(false)),
        counted: Mutex::new(Vec::new()),
    });
    let mut request = stable_prefix_request(id, store.clone(), provider, "inspect only").await;
    request.prompt = Some(working_set_prompt("v1"));
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let snapshot = store.load(id).await.unwrap().unwrap();
    assert!(snapshot.events().iter().any(|event| matches!(
        event.data(), SessionEventData::RequestHeader { header }
            if header.options.contains_key("workingSetSelection")
    )));
    // A fresh Runner must restore only metadata, not a captured request body or
    // any in-memory working-set selection from the previous turn.
    let events = snapshot
        .events()
        .iter()
        .map(|event| match event.data() {
            SessionEventData::RequestHeader { header } => SessionEventData::RequestHeader {
                header: header.metadata_only(json!({"kind":"omitted","reason":"capture_disabled"})),
            }
            .into(),
            _ => event.event.clone(),
        })
        .collect::<Vec<xharness_session::SessionEvent>>();
    let bytes = serde_json::to_vec(&events).unwrap();
    let cold = Arc::new(EventMemorySessionStore::default());
    cold.create(snapshot.header().clone()).await.unwrap();
    cold.append(id, Revision::ZERO, serde_json::from_slice(&bytes).unwrap())
        .await
        .unwrap();
    cold
}

async fn working_set_verification_request(
    id: &str,
    store: Arc<EventMemorySessionStore>,
    fault: WorkingSetCounterFault,
    always_large: bool,
    prompt_version: &str,
) -> (LoopRequest, Arc<WorkingSetVerificationProbe>) {
    let provider = Arc::new(WorkingSetVerificationProbe {
        inner: ScriptProvider::new([vec![
            Ok(ProviderEvent::TextDelta("continued safely".into())),
            Ok(completed()),
        ]]),
        counted: Mutex::new(Vec::new()),
        fault,
        always_large,
        high_pressure: AtomicBool::new(false),
    });
    let input = AgentMessage::user("Continue read-only; retain this current attachment.")
        .with_id("current-input")
        .with_content_blocks(vec![xharness_session::ContentBlock::Image {
            attachment: xharness_session::AttachmentRef {
                id: "a".repeat(64),
                session_id: id.into(),
                media_type: "image/png".into(),
                bytes: 1_024,
                width: 16,
                height: 16,
            },
        }]);
    let mut request = LoopRequest::new(provider.clone(), vec![input]);
    request.session_id = Some(id.into());
    request.journal_store = Some(store);
    request.prompt = Some(working_set_prompt(prompt_version));
    request.token_guard = Some(
        TokenGuard::conservative(TokenBudget {
            context_window_tokens: 16_384,
            reserved_output_tokens: 1_024,
            minimum_output_tokens: 1_024,
            safety_margin_tokens: 1_024,
        })
        .unwrap()
        .with_counter_policy(Duration::from_millis(5), true),
    );
    request.config.provider_retry_base_delay_ms = 1;
    request.config.provider_retry_budget_ms = 50;
    request.compaction = Some(CompactionConfig {
        retain_ratio: None,
        retain_tokens: Some(0),
        max_tokens: 512,
        ..CompactionConfig::default()
    });
    install_tools(
        &mut request,
        vec![TestToolSpec::new(
            "history",
            "recover original evidence",
            json!({"type":"object"}),
            |_, _| async { panic!("admission must not execute history or any other tool") },
        )],
    )
    .await;
    (request, provider)
}

fn assert_working_set_verification_preserves_history(
    before: &xharness_session::Session,
    after: &xharness_session::Session,
) {
    assert_eq!(&after.events()[..before.events().len()], before.events());
    assert!(!after.events()[before.events().len()..]
        .iter()
        .any(|event| matches!(
            event.data(),
            SessionEventData::CompactionStart { .. }
                | SessionEventData::CompactionSummary { .. }
                | SessionEventData::CompactionEnd { .. }
        )));
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_prompt_upgrade_reselects_after_cold_restart_and_counter_outage() {
    for fault in [
        WorkingSetCounterFault::Http550,
        WorkingSetCounterFault::Unsupported,
        WorkingSetCounterFault::Timeout,
        WorkingSetCounterFault::Calibrated,
    ] {
        let id = "working-set-prompt-upgrade";
        let store = cold_working_set_fixture(id).await;
        let before = store.load(id).await.unwrap().unwrap();
        let (request, provider) =
            working_set_verification_request(id, store.clone(), fault, false, "v2").await;
        let input = request.messages[0].clone();
        let system = AgentMessage::system(request.prompt.as_ref().unwrap().system());
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
        let counted = provider.counted.lock().unwrap().clone();
        assert!(WorkingSetVerificationProbe::has_retirable_result(
            &counted[0]
        ));
        let selected = counted
            .iter()
            .position(|request| !WorkingSetVerificationProbe::has_retirable_result(request))
            .expect("invalidated metadata must be replaced by a newly counted working set");
        assert!(selected > 0);
        assert!(
            counted.len() <= 6,
            "only one selection and bounded recounts"
        );
        assert!(counted[..selected]
            .windows(2)
            .all(|p| p[0].messages == p[1].messages));
        assert!(counted[selected..]
            .windows(2)
            .all(|p| p[0].messages == p[1].messages));
        for counted_request in &counted {
            assert_eq!(counted_request.messages[0], system);
            assert_eq!(counted_request.messages.last(), Some(&input));
            assert_eq!(counted_request.tools, counted[0].tools);
        }
        let sent = provider.inner.requests();
        assert_eq!(
            sent.len(),
            1,
            "no summary generation or implicit continuation"
        );
        assert_eq!(sent[0].messages, counted.last().unwrap().messages);
        assert_eq!(sent[0].tools, counted.last().unwrap().tools);
        assert!(sent[0]
            .messages
            .iter()
            .any(|m| m.content.starts_with("<working_set_history>")));
        let after = store.load(id).await.unwrap().unwrap();
        assert_working_set_verification_preserves_history(&before, &after);
        let header = after.events()[before.events().len()..]
            .iter()
            .find_map(|event| match event.data() {
                SessionEventData::RequestHeader { header } => Some(header),
                _ => None,
            })
            .unwrap();
        assert!(header.options.contains_key("workingSetSelection"));
        assert_eq!(
            header.options["tokenBudget"]["estimate"]["totalInputTokens"],
            2_000
        );
        assert_ne!(header.options["tokenBudget"]["accuracy"], "exact_request");
    }
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_unchanged_prompt_reuses_selection_without_full_recount() {
    let id = "working-set-unchanged-prompt";
    let store = cold_working_set_fixture(id).await;
    let (request, provider) =
        working_set_verification_request(id, store, WorkingSetCounterFault::Http550, false, "v1")
            .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let counted = provider.counted.lock().unwrap().clone();
    assert_eq!(counted.len(), 1);
    assert!(!WorkingSetVerificationProbe::has_retirable_result(
        &counted[0]
    ));
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_admissible_pressure_does_not_cascade_into_lossy_summary() {
    let id = "working-set-admissible-pressure";
    let store = cold_working_set_fixture(id).await;
    let before = store.load(id).await.unwrap().unwrap();
    let (request, provider) = working_set_verification_request(
        id,
        store.clone(),
        WorkingSetCounterFault::Http550,
        false,
        "v2",
    )
    .await;
    provider.high_pressure.store(true, Ordering::SeqCst);
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let sent = provider.inner.requests();
    assert_eq!(
        sent.len(),
        1,
        "estimated pressure must not launch a summarizer"
    );
    assert!(
        sent[0]
            .messages
            .iter()
            .any(|m| m.content.contains("OLD-CONTEXT:")),
        "plain assistant history stays present; only recoverable tool units retire"
    );
    let after = store.load(id).await.unwrap().unwrap();
    assert_working_set_verification_preserves_history(&before, &after);
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_still_oversized_candidate_fails_closed_without_summary_or_loop() {
    let id = "working-set-still-large";
    let store = cold_working_set_fixture(id).await;
    let before = store.load(id).await.unwrap().unwrap();
    let (request, provider) = working_set_verification_request(
        id,
        store.clone(),
        WorkingSetCounterFault::Http550,
        true,
        "v2",
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result.error.unwrap().contains("measurement unavailable"));
    let counted = provider.counted.lock().unwrap().clone();
    assert!(counted.len() <= 6);
    assert!(counted
        .iter()
        .any(|r| !WorkingSetVerificationProbe::has_retirable_result(r)));
    assert_eq!(
        provider.inner.attempts(),
        0,
        "never send an unadmitted candidate"
    );
    let after = store.load(id).await.unwrap().unwrap();
    assert_working_set_verification_preserves_history(&before, &after);
    assert_no_budget_recovery_transaction(&after, before.events().len());
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_no_retirable_units_cannot_repeat_selection_forever() {
    let id = "working-set-all-fixed";
    let store = Arc::new(EventMemorySessionStore::default());
    seed_long_compaction_history(store.as_ref(), id).await;
    let before = store.load(id).await.unwrap().unwrap();
    let (request, provider) = working_set_verification_request(
        id,
        store.clone(),
        WorkingSetCounterFault::Http550,
        true,
        "v2",
    )
    .await;
    let (_, result) =
        tokio::time::timeout(Duration::from_secs(1), collect(LoopEngine.start(request)))
            .await
            .expect("an unchanged candidate must not cause an unbounded admission loop");
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result.error.unwrap().contains("measurement unavailable"));
    let counted = provider.counted.lock().unwrap().clone();
    assert_eq!(counted.len(), 6, "at most two bounded admission passes");
    assert!(counted.iter().all(|r| r.messages == counted[0].messages));
    assert_eq!(provider.inner.attempts(), 0);
    let after = store.load(id).await.unwrap().unwrap();
    assert_working_set_verification_preserves_history(&before, &after);
    assert_no_budget_recovery_transaction(&after, before.events().len());
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_respects_opt_out_missing_history_and_ephemeral_requests() {
    for mode in ["auto-off", "no-config", "no-history", "no-journal"] {
        let id = format!("working-set-{mode}");
        let store = cold_working_set_fixture(&id).await;
        let before = store.load(&id).await.unwrap().unwrap();
        let (mut request, provider) = working_set_verification_request(
            &id,
            store.clone(),
            WorkingSetCounterFault::Unsupported,
            true,
            "v2",
        )
        .await;
        match mode {
            "auto-off" => request.compaction.as_mut().unwrap().auto = false,
            "no-config" => request.compaction = None,
            "no-history" => {
                request.tool_executor = None;
            }
            "no-journal" => {
                request.journal_store = None;
                assert!(request
                    .validate()
                    .unwrap_err()
                    .to_string()
                    .contains("compaction requires an append-only journal_store"));
                // Also exercise a valid ephemeral request, not only the
                // earlier configuration rejection before admission can run.
                request.compaction = None;
            }
            _ => unreachable!(),
        }
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Failed, "{mode}");
        assert!(
            result.error.unwrap().contains("measurement unavailable"),
            "{mode}"
        );
        assert_eq!(provider.inner.attempts(), 0, "{mode}");
        let counted = provider.counted.lock().unwrap().clone();
        assert_eq!(counted.len(), 2, "{mode}: no selection retry");
        assert_eq!(counted[0].messages, counted[1].messages);
        let after = store.load(&id).await.unwrap().unwrap();
        assert_working_set_verification_preserves_history(&before, &after);
        assert_no_budget_recovery_transaction(&after, before.events().len());
    }
}

#[tokio::test(start_paused = true)]
async fn working_set_verification_does_not_bypass_rate_limit_or_authentication_failure() {
    for fault in [
        WorkingSetCounterFault::RateLimited,
        WorkingSetCounterFault::Unauthorized,
    ] {
        let id = "working-set-counter-backoff";
        let store = cold_working_set_fixture(id).await;
        let before = store.load(id).await.unwrap().unwrap();
        let (request, provider) =
            working_set_verification_request(id, store.clone(), fault, true, "v2").await;
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Failed);
        assert_eq!(provider.counted.lock().unwrap().len(), 1);
        assert_eq!(provider.inner.attempts(), 0);
        let after = store.load(id).await.unwrap().unwrap();
        assert_working_set_verification_preserves_history(&before, &after);
        assert_no_budget_recovery_transaction(&after, before.events().len());
        if matches!(fault, WorkingSetCounterFault::RateLimited) {
            assert!(result.error.unwrap().contains("measurement unavailable"));
            assert!(matches!(after.events().last().unwrap().data(),
                SessionEventData::TurnEnd { reason: TurnEndReason::Failed { provider_failure: Some(failure), .. }, .. }
                    if failure.http_status == Some(429) && failure.retry_after_ms == Some(120_000)
            ));
        } else {
            assert!(result
                .error
                .unwrap()
                .contains("provider input token count failed"));
        }
    }
}
