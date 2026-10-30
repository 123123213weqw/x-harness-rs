// Scripted admission faults only. No model calls, credentials or private history.
#[derive(Clone)]
enum VerificationReply {
    Exact(u64),
    Unsupported,
    Calibrated(u64),
    Http(u16, Option<u64>),
    Timeout,
}
struct BudgetVerificationProbe {
    inner: ScriptProvider,
    replies: Mutex<VecDeque<VerificationReply>>,
    counted: Mutex<Vec<(tokio::time::Instant, ProviderRequest)>>,
    estimates: AtomicUsize,
}
#[async_trait]
impl ModelProvider for BudgetVerificationProbe {
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.counted
            .lock()
            .unwrap()
            .push((tokio::time::Instant::now(), request.clone()));
        let reply = self.replies.lock().unwrap().pop_front().unwrap();
        match reply {
            VerificationReply::Exact(tokens) => Ok(Some(ProviderInputTokenCount::exact_request(
                "verification-fixture/native",
                tokens,
            ))),
            VerificationReply::Unsupported => Ok(None),
            VerificationReply::Calibrated(tokens) => Ok(Some(ProviderInputTokenCount {
                counter: "verification-fixture/calibrated".into(),
                input_tokens: tokens,
                accuracy: xharness_token::TokenCountAccuracy::Calibrated,
            })),
            VerificationReply::Http(status, retry_after) => {
                let mut error = ProviderError::http(status, "fixture counter unavailable");
                error.retry_after_ms = retry_after;
                Err(error)
            }
            VerificationReply::Timeout => {
                cancel.cancelled().await;
                Ok(None)
            }
        }
    }
    fn estimate_input_tokens(&self, _: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        self.estimates.fetch_add(1, Ordering::SeqCst);
        Some(ProviderInputTokenCount {
            counter: "verification-fixture/inflated-image-estimate".into(),
            input_tokens: 1200,
            accuracy: xharness_token::TokenCountAccuracy::ConservativeUpperBound,
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
async fn budget_verification_request(
    id: &str,
    replies: impl IntoIterator<Item = VerificationReply>,
) -> (
    LoopRequest,
    Arc<BudgetVerificationProbe>,
    Arc<EventMemorySessionStore>,
) {
    let store = Arc::new(EventMemorySessionStore::default());
    seed_long_compaction_history(store.as_ref(), id).await;
    let provider = Arc::new(BudgetVerificationProbe {
        inner: ScriptProvider::new([
            vec![
                Ok(ProviderEvent::TextDelta("verified response".into())),
                Ok(completed()),
            ],
            vec![Ok(ProviderEvent::TextDelta("done".into())), Ok(completed())],
        ]),
        replies: Mutex::new(replies.into_iter().collect()),
        counted: Mutex::new(Vec::new()),
        estimates: AtomicUsize::new(0),
    });
    let image = xharness_session::ContentBlock::Image {
        attachment: xharness_session::AttachmentRef {
            id: "a".repeat(64),
            session_id: id.into(),
            media_type: "image/png".into(),
            bytes: 8192,
            width: 1024,
            height: 1024,
        },
    };
    let mut request = LoopRequest::new(
        provider.clone(),
        vec![AgentMessage::user("continue using the screenshot").with_content_blocks(vec![image])],
    );
    request.session_id = Some(id.into());
    request.journal_store = Some(store.clone());
    request.config.provider_retry_base_delay_ms = 1;
    request.config.provider_retry_budget_ms = 50;
    request.token_guard = Some(
        TokenGuard::conservative(TokenBudget {
            context_window_tokens: 1000,
            reserved_output_tokens: 40,
            minimum_output_tokens: 40,
            safety_margin_tokens: 10,
        })
        .unwrap()
        .with_counter_policy(Duration::from_millis(5), true),
    );
    request.compaction = Some(CompactionConfig {
        retain_ratio: None,
        retain_tokens: Some(10),
        max_tokens: 64,
        ..CompactionConfig::default()
    });
    (request, provider, store)
}
fn assert_no_budget_recovery_transaction(session: &xharness_session::Session, start: usize) {
    assert!(!session.events().iter().skip(start).any(|event| matches!(
        event.data(),
        SessionEventData::CompactionStart { .. }
            | SessionEventData::CompactionSummary { .. }
            | SessionEventData::CompactionEnd { .. }
            | SessionEventData::RequestHeader { .. }
    )));
}

#[tokio::test]
async fn budget_verification_inflated_image_estimate_uses_native_before_any_compaction() {
    let (request, provider, store) = budget_verification_request(
        "verify-inflated-image",
        [
            VerificationReply::Http(503, None),
            VerificationReply::Exact(300),
        ],
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.estimates.load(Ordering::SeqCst), 1);
    assert_eq!(provider.inner.attempts(), 1);
    {
        let counted = provider.counted.lock().unwrap();
        assert_eq!(counted.len(), 2);
        assert_eq!(counted[0].1.messages, counted[1].1.messages);
        assert_eq!(counted[0].1.tools, counted[1].1.tools);
        assert_eq!(provider.inner.requests()[0].messages, counted[1].1.messages);
    }
    let session = store.load("verify-inflated-image").await.unwrap().unwrap();
    assert!(!session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::CompactionStart { .. } | SessionEventData::CompactionSummary { .. }
    )));
    let report = session
        .events()
        .iter()
        .find_map(|event| match event.data() {
            SessionEventData::RequestHeader { header } => header.options.get("tokenBudget"),
            _ => None,
        })
        .unwrap();
    assert_eq!(report["accuracy"], "exact_request");
    assert_eq!(report["counterRechecks"], 1);
}

#[tokio::test(start_paused = true)]
async fn budget_verification_outage_never_starts_compaction_and_preserves_retry_metadata() {
    for (id, replies, expected_calls, status, retry_after) in [
        (
            "verify-timeout",
            vec![VerificationReply::Timeout; 3],
            3,
            None,
            None,
        ),
        (
            "verify-503",
            vec![VerificationReply::Http(503, None); 3],
            3,
            Some(503),
            None,
        ),
        (
            "verify-unsupported",
            vec![VerificationReply::Unsupported; 2],
            2,
            None,
            None,
        ),
        (
            "verify-calibrated",
            vec![VerificationReply::Calibrated(1200); 2],
            2,
            None,
            None,
        ),
        (
            "verify-429",
            vec![VerificationReply::Http(429, Some(10)); 3],
            3,
            Some(429),
            Some(10),
        ),
        (
            "verify-429-long",
            vec![VerificationReply::Http(429, Some(120_000))],
            1,
            Some(429),
            Some(120_000),
        ),
    ] {
        let (request, provider, store) = budget_verification_request(id, replies).await;
        let before = store.load(id).await.unwrap().unwrap();
        let started = tokio::time::Instant::now();
        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Failed, "{id}");
        let error = result.error.as_deref().unwrap();
        assert!(error.contains("measurement unavailable"), "{id}: {error}");
        assert!(
            !error.contains("overflow compaction failed"),
            "{id}: {error}"
        );
        assert_eq!(
            provider.inner.attempts(),
            0,
            "{id}: no auxiliary or main generation"
        );
        {
            let counted = provider.counted.lock().unwrap();
            assert_eq!(counted.len(), expected_calls, "{id}");
            assert!(counted
                .iter()
                .all(|(_, request)| request.messages == counted[0].1.messages));
            if id == "verify-429" {
                for pair in counted.windows(2) {
                    assert!(pair[1].0.duration_since(pair[0].0) >= Duration::from_millis(10));
                }
            }
            assert!(
                started.elapsed() <= Duration::from_millis(55),
                "{id}: bounded recount deadline"
            );
        }
        let after = store.load(id).await.unwrap().unwrap();
        assert_eq!(&after.events()[..before.events().len()], before.events());
        assert!(after
            .derive_messages()
            .iter()
            .any(|m| m.content.contains("OLD-CONTEXT")));
        assert_no_budget_recovery_transaction(&after, before.events().len());
        let failure = after
            .events()
            .iter()
            .find_map(|event| match event.data() {
                SessionEventData::TurnEnd {
                    reason:
                        TurnEndReason::Failed {
                            provider_failure: Some(failure),
                            ..
                        },
                    ..
                } => Some(failure),
                _ => None,
            })
            .unwrap();
        assert!(failure.retryable, "{id}");
        assert_eq!(failure.http_status, status, "{id}");
        assert_eq!(failure.retry_after_ms, retry_after, "{id}");
    }
}

#[tokio::test]
async fn budget_verification_exact_overflow_still_compacts_before_main_generation() {
    let (request, provider, store) = budget_verification_request(
        "verify-exact-overflow",
        [980, 500, 300, 300].map(VerificationReply::Exact),
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.estimates.load(Ordering::SeqCst), 0);
    assert_eq!(
        provider.inner.attempts(),
        2,
        "summary then admitted main request only"
    );
    let session = store.load("verify-exact-overflow").await.unwrap().unwrap();
    assert!(session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::CompactionEnd {
            outcome: Some(xharness_session::CompactionEndOutcome::Applied),
            ..
        }
    )));
    let sent = provider.inner.requests();
    assert!(!sent[1]
        .messages
        .iter()
        .any(|m| m.content.contains("OLD-CONTEXT")));
    let counted = provider.counted.lock().unwrap();
    assert_eq!(sent[0].messages, counted[1].1.messages);
    assert_eq!(sent[1].messages, counted[3].1.messages);
    assert!(300 + sent[1].max_output_tokens.unwrap() + 10 <= 1000);
}

#[tokio::test]
async fn budget_verification_unsupported_summary_counter_is_not_no_benefit() {
    let (request, provider, store) = budget_verification_request(
        "verify-summary-unsupported",
        [
            VerificationReply::Exact(980),
            VerificationReply::Unsupported,
            VerificationReply::Unsupported,
        ],
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("measurement unavailable"));
    assert_eq!(provider.inner.attempts(), 0);
    let session = store
        .load("verify-summary-unsupported")
        .await
        .unwrap()
        .unwrap();
    assert!(!session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::CompactionSummary { .. }
            | SessionEventData::CompactionEnd {
                outcome: Some(xharness_session::CompactionEndOutcome::NoBenefit),
                ..
            }
    )));
    assert!(session.events().iter().any(|event| matches!(
        event.data(), SessionEventData::CompactionProgress { progress, .. }
            if progress.summary_budget.as_ref().is_some_and(|b| b["accuracy"] == "conservative_upper_bound")
    )));
}

#[tokio::test]
async fn budget_verification_manual_unverified_request_does_not_spend_summary_calls() {
    let (mut request, provider, store) = budget_verification_request(
        "verify-manual",
        [
            VerificationReply::Unsupported,
            VerificationReply::Unsupported,
        ],
    )
    .await;
    let baseline = store.load("verify-manual").await.unwrap().unwrap();
    request.manual_compaction_command_id = Some("verify-manual-command".into());
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.inner.attempts(), 0);
    let session = store.load("verify-manual").await.unwrap().unwrap();
    assert_no_budget_recovery_transaction(&session, baseline.events().len());
}

#[tokio::test]
async fn budget_verification_failed_main_can_resume_after_native_counter_recovers() {
    let (request, provider, store) = budget_verification_request(
        "verify-resume",
        [
            VerificationReply::Http(503, None),
            VerificationReply::Http(503, None),
            VerificationReply::Http(503, None),
            VerificationReply::Exact(300),
        ],
    )
    .await;
    let baseline = store.load("verify-resume").await.unwrap().unwrap();
    let guard = request.token_guard.clone();
    let (_, failed) = collect(LoopEngine.start(request)).await;
    assert_eq!(failed.status, LoopStatus::Failed);
    let before = store.load("verify-resume").await.unwrap().unwrap();
    assert_no_budget_recovery_transaction(&before, baseline.events().len());
    let mut resumed = LoopRequest::new(
        provider.clone(),
        vec![AgentMessage::user("retry after recovery")],
    );
    resumed.session_id = Some("verify-resume".into());
    resumed.journal_store = Some(store.clone());
    resumed.token_guard = guard;
    resumed.compaction = Some(CompactionConfig::default());
    let (_, result) = collect(LoopEngine.start(resumed)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.inner.attempts(), 1);
    let after = store.load("verify-resume").await.unwrap().unwrap();
    assert_eq!(&after.events()[..before.events().len()], before.events());
    assert!(!after
        .events()
        .iter()
        .any(|event| matches!(event.data(), SessionEventData::CompactionStart { .. })));
    assert!(provider.inner.requests()[0]
        .messages
        .iter()
        .any(|message| message.content.contains("OLD-CONTEXT")));
}
