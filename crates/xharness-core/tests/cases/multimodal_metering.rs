// Synthetic counters only: no user history, live model calls or credentials.
struct MeterSwitchProbe {
    inner: ScriptProvider,
    counts: AtomicUsize,
    recounts: AtomicUsize,
    mode: u8,
}
#[async_trait]
impl ModelProvider for MeterSwitchProbe {
    async fn count_input_tokens(
        &self,
        _: &ProviderRequest,
        _: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        let call = self.counts.fetch_add(1, Ordering::SeqCst);
        if self.mode == 0 {
            return Err(ProviderError::http(503, "fixture counter offline"));
        }
        if call == 2 && self.mode != 5 || call == 1 && self.mode == 5 {
            return if self.mode == 3 {
                Ok(None)
            } else {
                Err(ProviderError::http(
                    503,
                    "fixture candidate counter offline",
                ))
            };
        }
        Ok(Some(ProviderInputTokenCount::exact_request(
            "fixture-native",
            match call {
                0 if self.mode == 3 => 800,
                0 if self.mode >= 4 => 900,
                0 => 980,
                1 => 500,
                _ => 300,
            },
        )))
    }
    async fn recount_input_tokens(
        &self,
        _: &ProviderRequest,
        _: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.recounts.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, 2 | 4 | 5) {
            return Err(ProviderError::http(503, "fixture remains offline"));
        }
        Ok(Some(ProviderInputTokenCount::exact_request(
            "fixture-native",
            300,
        )))
    }
    fn estimate_input_tokens(&self, _: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        Some(ProviderInputTokenCount {
            counter: "fixture-estimate".into(),
            input_tokens: if self.mode == 3 { 900 } else { 1200 },
            accuracy: xharness_token::TokenCountAccuracy::Estimated,
        })
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.inner.stream(request, cancel).await
    }
}
async fn meter_switch_request(
    mode: u8,
) -> (
    LoopRequest,
    Arc<MeterSwitchProbe>,
    Arc<EventMemorySessionStore>,
) {
    let store = Arc::new(EventMemorySessionStore::default());
    let id = format!("meter-switch-{mode}");
    seed_long_compaction_history(store.as_ref(), &id).await;
    let provider = Arc::new(MeterSwitchProbe {
        inner: ScriptProvider::new(if mode == 0 || mode == 5 {
            vec![vec![Ok(completed())]]
        } else {
            vec![
                vec![
                    Ok(ProviderEvent::TextDelta("CHECKPOINT".into())),
                    Ok(completed()),
                ],
                vec![Ok(ProviderEvent::TextDelta("done".into())), Ok(completed())],
            ]
        }),
        counts: AtomicUsize::new(0),
        recounts: AtomicUsize::new(0),
        mode,
    });
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("new work")]);
    request.session_id = Some(id);
    request.journal_store = Some(store.clone());
    request.config.provider_retry_base_delay_ms = 1;
    request.token_guard = Some(
        TokenGuard::conservative(TokenBudget {
            context_window_tokens: 1000,
            reserved_output_tokens: 40,
            minimum_output_tokens: 40,
            safety_margin_tokens: 10,
        })
        .unwrap(),
    );
    request.compaction = Some(CompactionConfig {
        threshold_ratio: 0.75,
        retain_ratio: None,
        retain_tokens: Some(10),
        max_tokens: 64,
        ..CompactionConfig::default()
    });
    (request, provider, store)
}

#[tokio::test]
async fn estimated_overflow_recounts_same_model_before_starting_compaction() {
    let (mut request, provider, store) = meter_switch_request(0).await;
    request.compaction = None;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.recounts.load(Ordering::SeqCst), 1);
    assert_eq!(provider.inner.attempts(), 1);
    let session = store.load("meter-switch-0").await.unwrap().unwrap();
    assert!(!session
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionStart { .. })));
    let report = session
        .events()
        .iter()
        .find_map(|e| match e.data() {
            SessionEventData::RequestHeader { header } => header.options.get("tokenBudget"),
            _ => None,
        })
        .unwrap();
    assert_eq!(report["accuracy"], "exact_request");
    assert_eq!(report["counterRechecks"], 1);
    assert!(report["requestSha256"]
        .as_str()
        .is_some_and(|s| s.len() == 64));
}

#[tokio::test]
async fn candidate_counter_recovers_without_switching_model() {
    let (request, provider, store) = meter_switch_request(1).await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.recounts.load(Ordering::SeqCst), 1);
    let session = store.load("meter-switch-1").await.unwrap().unwrap();
    assert!(session
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    let progress = session
        .events()
        .iter()
        .find_map(|e| match e.data() {
            SessionEventData::CompactionProgress { progress, .. }
                if progress.budget_after.is_some() =>
            {
                Some(progress)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        progress.budget_before.as_ref().unwrap()["accuracy"],
        "exact_request"
    );
    assert_eq!(
        progress.budget_after.as_ref().unwrap()["accuracy"],
        "exact_request"
    );
    assert_eq!(
        progress.validation,
        Some(xharness_session::CompactionValidation::AdmittedExact)
    );
}

#[tokio::test]
async fn estimated_candidate_rejection_is_retryable_and_keeps_budget_evidence() {
    let (request, provider, store) = meter_switch_request(2).await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("measurement unavailable"));
    assert_eq!(
        provider.inner.attempts(),
        1,
        "unverified candidate is never sent"
    );
    assert_eq!(provider.recounts.load(Ordering::SeqCst), 2);
    let session = store.load("meter-switch-2").await.unwrap().unwrap();
    assert!(session.events().iter().any(|e| matches!(e.data(), SessionEventData::TurnEnd { reason: xharness_session::TurnEndReason::Failed { provider_failure: Some(failure), .. }, .. } if failure.retryable)));
    assert!(!session.events().iter().any(|e| matches!(
        e.data(),
        SessionEventData::CompactionSummary { .. }
            | SessionEventData::CompactionEnd {
                outcome: Some(xharness_session::CompactionEndOutcome::NoBenefit),
                ..
            }
    )));
    assert!(session
        .derive_messages()
        .iter()
        .any(|m| m.content.contains("OLD-CONTEXT")));
    let progress = session
        .events()
        .iter()
        .find_map(|e| match e.data() {
            SessionEventData::CompactionProgress { progress, .. }
                if progress.validation
                    == Some(xharness_session::CompactionValidation::EstimatedOverBudget) =>
            {
                Some(progress)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(progress.input_tokens_after, Some(1200));
    assert_eq!(
        progress.budget_after.as_ref().unwrap()["fallbackReason"],
        "transient_counter_failure"
    );
    assert_eq!(
        progress.budget_after.as_ref().unwrap()["counterHttpStatus"],
        503
    );
    assert!(progress.source_range.is_some());
}

#[tokio::test]
async fn estimate_and_exact_counts_are_not_compared_as_compaction_gain() {
    let (request, _, store) = meter_switch_request(3).await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let session = store.load("meter-switch-3").await.unwrap().unwrap();
    let progress = session
        .events()
        .iter()
        .find_map(|e| match e.data() {
            SessionEventData::CompactionProgress { progress, .. }
                if progress.budget_after.is_some() =>
            {
                Some(progress)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(progress.input_tokens_before, Some(800));
    assert_eq!(progress.input_tokens_after, Some(900));
    assert_eq!(
        progress.validation,
        Some(xharness_session::CompactionValidation::AdmittedWithLocalGain)
    );
    assert!(session
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
}

#[tokio::test]
async fn failed_session_resumes_on_same_route_after_counter_recovery() {
    let (request, _, store) = meter_switch_request(2).await;
    let (_, failed) = collect(LoopEngine.start(request)).await;
    assert_eq!(failed.status, LoopStatus::Failed);
    let original = store.load("meter-switch-2").await.unwrap().unwrap();
    let original_messages = original.derive_messages();
    let provider = Arc::new(MeterSwitchProbe {
        inner: ScriptProvider::new([vec![
            Ok(ProviderEvent::TextDelta("resumed on same route".into())),
            Ok(completed()),
        ]]),
        counts: AtomicUsize::new(0),
        recounts: AtomicUsize::new(0),
        mode: 0,
    });
    let mut resumed = LoopRequest::new(provider.clone(), vec![AgentMessage::user("continue")]);
    resumed.session_id = Some("meter-switch-2".into());
    resumed.journal_store = Some(store.clone());
    resumed.token_guard = Some(
        TokenGuard::conservative(TokenBudget {
            context_window_tokens: 1000,
            reserved_output_tokens: 40,
            minimum_output_tokens: 40,
            safety_margin_tokens: 10,
        })
        .unwrap(),
    );
    let (_, result) = collect(LoopEngine.start(resumed)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(result.final_text, "resumed on same route");
    let after = store.load("meter-switch-2").await.unwrap().unwrap();
    assert_eq!(
        &after.derive_messages()[..original_messages.len()],
        original_messages.as_slice()
    );
    let resumed_headers = after
        .events()
        .iter()
        .skip(original.events().len())
        .filter_map(|e| match e.data() {
            SessionEventData::RequestHeader { header } => Some(header.provider.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(!resumed_headers.is_empty());
    assert!(resumed_headers.iter().all(|p| *p == "custom"));
    assert!(!after
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
}

#[tokio::test]
async fn optional_pressure_counter_outage_revalidates_original_history() {
    // 4 fails candidate counting; 5 fails auxiliary admission before any summary.
    for mode in [4, 5] {
        let (request, provider, store) = meter_switch_request(mode).await;
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(
            result.status,
            LoopStatus::Completed,
            "mode={mode}: {:?}",
            result.error
        );
        let session = store
            .load(&format!("meter-switch-{mode}"))
            .await
            .unwrap()
            .unwrap();
        assert!(session.events().iter().any(|e| matches!(
            e.data(),
            SessionEventData::CompactionEnd {
                outcome: Some(xharness_session::CompactionEndOutcome::Failed),
                ..
            }
        )));
        assert!(!session
            .events()
            .iter()
            .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
        assert!(session
            .derive_messages()
            .iter()
            .any(|m| m.content.contains("OLD-CONTEXT")));
        assert_eq!(provider.inner.attempts(), if mode == 4 { 2 } else { 1 });
        let report = session
            .events()
            .iter()
            .rev()
            .find_map(|e| match e.data() {
                SessionEventData::RequestHeader { header } => header.options.get("tokenBudget"),
                _ => None,
            })
            .unwrap();
        assert_eq!(report["accuracy"], "exact_request");
        assert_eq!(report["estimate"]["totalInputTokens"], 300);
        if mode == 5 {
            let progress = session
                .events()
                .iter()
                .find_map(|e| match e.data() {
                    SessionEventData::CompactionProgress { progress, .. }
                        if progress.summary_budget.is_some() =>
                    {
                        Some(progress)
                    }
                    _ => None,
                })
                .unwrap();
            assert!(progress.source_range.is_some());
            assert!(progress.budget_before.is_some());
            let budget = progress.summary_budget.as_ref().unwrap();
            assert_eq!(budget["fallbackReason"], "transient_counter_failure");
            assert_eq!(budget["counterHttpStatus"], 503);
            assert_eq!(budget["counterRechecks"], 1);
        }
    }
}
