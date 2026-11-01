// Complete-request counters derive their answers from request contents, not
// call order. Every summary is staged against immutable original evidence.
struct CapacityRecoveryProbe {
    inner: ScriptProvider,
    fixed: u64,
    outage_after_two: bool,
    mutate_after_two: AtomicBool,
    pause_second: AtomicBool,
    second_entered: Notify,
    summary_calls: AtomicUsize,
    counted: Mutex<Vec<ProviderRequest>>,
    journal: Arc<EventMemorySessionStore>,
    session_id: String,
}
impl CapacityRecoveryProbe {
    fn summary(request: &ProviderRequest) -> bool {
        request.messages.iter().any(|m| {
            m.content.contains("Summarize the NEW raw evidence below")
                || m.content
                    .contains(xharness_compaction::DEFAULT_COMPACTION_INSTRUCTION)
        })
    }
    fn checkpoints(request: &ProviderRequest) -> usize {
        request
            .messages
            .iter()
            .filter(|m| {
                m.id.as_deref()
                    .is_some_and(|id| id.starts_with("compaction-checkpoint-"))
            })
            .count()
    }
    fn price(&self, request: &ProviderRequest) -> u64 {
        if Self::summary(request) {
            return 300;
        }
        let mut tokens = self.fixed;
        for message in &request.messages {
            if message.content.contains("OLD-CONTEXT:") {
                tokens += 180;
            }
            if message.content.contains("SECOND-RAW:") {
                tokens += 180;
            }
            if message
                .id
                .as_deref()
                .is_some_and(|id| id.starts_with("compaction-checkpoint-"))
            {
                tokens += if message.content.contains("LONG_NOTE") {
                    120
                } else {
                    20
                };
            }
        }
        tokens
    }
}
#[async_trait]
impl ModelProvider for CapacityRecoveryProbe {
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        _: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.counted.lock().unwrap().push(request.clone());
        if Self::checkpoints(request) == 2 && self.mutate_after_two.swap(false, Ordering::SeqCst) {
            let current = self.journal.load(&self.session_id).await.unwrap().unwrap();
            self.journal
                .append(
                    &self.session_id,
                    current.revision(),
                    vec![SessionEventData::SessionTitle {
                        title: "synthetic metadata race".into(),
                        message_seqs: Vec::new(),
                        source: xharness_session::SessionTitleSource::User,
                    }
                    .into()],
                )
                .await
                .unwrap();
        }
        if self.outage_after_two && Self::checkpoints(request) == 2 {
            return Err(ProviderError::http(
                503,
                "synthetic final-candidate count unavailable",
            ));
        }
        Ok(Some(ProviderInputTokenCount::exact_request(
            "capacity-recovery/exact",
            self.price(request),
        )))
    }
    fn estimate_input_tokens(&self, _: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        Some(ProviderInputTokenCount {
            counter: "capacity-recovery/fallback".into(),
            input_tokens: 2000,
            accuracy: xharness_token::TokenCountAccuracy::Estimated,
        })
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let snapshot = self.journal.load(&self.session_id).await.unwrap().unwrap();
        if Self::summary(&request) {
            let call = self.summary_calls.fetch_add(1, Ordering::SeqCst);
            if call == 1 && self.pause_second.load(Ordering::SeqCst) {
                self.second_entered.notify_one();
                cancel.cancelled().await;
                return Err(ProviderError::new("synthetic cancelled second summary"));
            }
            assert!(
                !snapshot
                    .events()
                    .iter()
                    .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })),
                "no partial checkpoint may be durable while generating more notes"
            );
            assert!(request
                .messages
                .iter()
                .any(|m| m.content.contains("OLD-CONTEXT:") || m.content.contains("SECOND-RAW:")));
            assert!(
                !request
                    .messages
                    .iter()
                    .any(|m| m.content.contains("LONG_NOTE") || m.content.contains("SHORT_NOTE")),
                "regeneration must use original evidence, never a previous summary"
            );
        } else {
            assert!(
                self.price(&request) + request.max_output_tokens.unwrap() + 10 <= 1000,
                "a rejected candidate can never reach main generation"
            );
        }
        self.inner.stream(request, cancel).await
    }
}
async fn capacity_recovery_request(
    id: &str,
    second_span: bool,
    fixed: u64,
    notes: &[&str],
    outage_after_two: bool,
) -> (
    LoopRequest,
    Arc<CapacityRecoveryProbe>,
    Arc<EventMemorySessionStore>,
) {
    let journal = Arc::new(EventMemorySessionStore::default());
    seed_long_compaction_history(journal.as_ref(), id).await;
    if second_span {
        let before = journal.load(id).await.unwrap().unwrap();
        journal
            .append(
                id,
                before.revision(),
                vec![
                    SessionEventData::TurnStart { turn: 2 }.into(),
                    SessionEventData::UserMessage {
                        message: AgentMessage::user(
                            "SECOND_SCOPE: do not modify files or publish anything",
                        ),
                        surface_replace: None,
                    }
                    .into(),
                    SessionEventData::StepStart { turn: 2, step: 1 }.into(),
                    SessionEventData::RequestHeader {
                        header: RequestHeader::new("fixture", "fixture"),
                    }
                    .into(),
                    SessionEventData::AssistantMessage {
                        turn: 2,
                        step: 1,
                        message: AgentMessage::assistant(format!(
                            "SECOND-RAW:{}",
                            "y".repeat(6500)
                        )),
                        usage: None,
                    }
                    .into(),
                    SessionEventData::StepEnd { turn: 2, step: 1 }.into(),
                    SessionEventData::TurnEnd {
                        turn: 2,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
    }
    let scripts = notes
        .iter()
        .map(|note| {
            vec![
                Ok(ProviderEvent::TextDelta((*note).into())),
                Ok(completed()),
            ]
        })
        .chain([vec![
            Ok(ProviderEvent::TextDelta("done".into())),
            Ok(completed()),
        ]])
        .collect::<Vec<_>>();
    let provider = Arc::new(CapacityRecoveryProbe {
        inner: ScriptProvider::new(scripts),
        fixed,
        outage_after_two,
        mutate_after_two: AtomicBool::new(false),
        pause_second: AtomicBool::new(false),
        second_entered: Notify::new(),
        summary_calls: AtomicUsize::new(0),
        counted: Mutex::new(Vec::new()),
        journal: journal.clone(),
        session_id: id.into(),
    });
    let mut request = LoopRequest::new(
        provider.clone(),
        vec![AgentMessage::user("continue read-only; text response only")],
    );
    request.session_id = Some(id.into());
    request.journal_store = Some(journal.clone());
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
        retain_ratio: None,
        retain_tokens: Some(10),
        max_tokens: 64,
        ..CompactionConfig::default()
    });
    (request, provider, journal)
}
fn assert_no_capacity_no_benefit(session: &Session) {
    assert!(!session.events().iter().any(|e| matches!(
        e.data(),
        SessionEventData::CompactionEnd {
            outcome: Some(xharness_session::CompactionEndOutcome::NoBenefit),
            ..
        }
    )));
}
#[tokio::test]
async fn capacity_recovery_stages_two_disjoint_spans_and_commits_both_atomically() {
    let (request, provider, journal) = capacity_recovery_request(
        "capacity-batch",
        true,
        850,
        &["SHORT_NOTE_A", "SHORT_NOTE_B"],
        false,
    )
    .await;
    let original = journal.load("capacity-batch").await.unwrap().unwrap();
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(provider.inner.attempts(), 3);
    let after = journal.load("capacity-batch").await.unwrap().unwrap();
    assert_eq!(
        &after.events()[..original.events().len()],
        original.events()
    );
    assert_no_capacity_no_benefit(&after);
    let revisions = after
        .events()
        .iter()
        .filter_map(|e| {
            matches!(e.data(), SessionEventData::CompactionSummary { .. }).then_some(e.revision)
        })
        .collect::<Vec<_>>();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0], revisions[1]);
    let wire = provider.inner.requests();
    let last = wire.last().unwrap();
    assert_eq!(CapacityRecoveryProbe::checkpoints(last), 2);
    assert!(last
        .messages
        .iter()
        .any(|m| m.content.contains("SECOND_SCOPE")));
    assert!(last
        .messages
        .iter()
        .any(|m| m.content.contains("Original task scope")));
    assert!(!last
        .messages
        .iter()
        .any(|m| m.content.contains("OLD-CONTEXT:") || m.content.contains("SECOND-RAW:")));
    let candidate = provider
        .counted
        .lock()
        .unwrap()
        .iter()
        .rfind(|r| CapacityRecoveryProbe::checkpoints(r) == 2)
        .unwrap()
        .clone();
    assert_eq!(
        candidate.messages, last.messages,
        "actual main must match the fully admitted multi-note candidate"
    );
}
#[tokio::test]
async fn capacity_recovery_regenerates_original_raw_span_under_a_smaller_output_ceiling() {
    let (request, provider, journal) = capacity_recovery_request(
        "capacity-regenerate",
        false,
        930,
        &["LONG_NOTE", "SHORT_NOTE"],
        false,
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let requests = provider.inner.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].max_output_tokens.unwrap() < requests[0].max_output_tokens.unwrap());
    let after = journal.load("capacity-regenerate").await.unwrap().unwrap();
    assert_no_capacity_no_benefit(&after);
    let summaries = after
        .events()
        .iter()
        .filter_map(|e| match e.data() {
            SessionEventData::CompactionSummary { summary, .. } => Some(summary),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(summaries.len(), 1);
    assert!(summaries[0].contains("SHORT_NOTE"));
}
#[tokio::test]
async fn capacity_recovery_stops_nonshrinking_candidates_without_caching_no_benefit() {
    let (request, provider, journal) = capacity_recovery_request(
        "capacity-stalled",
        false,
        1000,
        &["SHORT_NOTE", "SHORT_NOTE"],
        false,
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.inner.attempts(), 2);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("stopped making progress"));
    let after = journal.load("capacity-stalled").await.unwrap().unwrap();
    assert_no_capacity_no_benefit(&after);
    assert!(!after
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    assert!(after
        .derive_messages()
        .iter()
        .any(|m| m.content.contains("OLD-CONTEXT:")));
}
#[tokio::test]
async fn capacity_recovery_final_counter_outage_discards_every_staged_note() {
    let (request, provider, journal) = capacity_recovery_request(
        "capacity-outage",
        true,
        850,
        &["SHORT_NOTE_A", "SHORT_NOTE_B"],
        true,
    )
    .await;
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.inner.attempts(), 2);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("measurement unavailable"));
    let after = journal.load("capacity-outage").await.unwrap().unwrap();
    assert_no_capacity_no_benefit(&after);
    assert!(!after
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    let starts = after
        .events()
        .iter()
        .filter(|e| matches!(e.data(), SessionEventData::CompactionStart { .. }))
        .count();
    let ends = after
        .events()
        .iter()
        .filter(|e| {
            matches!(
                e.data(),
                SessionEventData::CompactionEnd {
                    outcome: Some(xharness_session::CompactionEndOutcome::Failed),
                    fingerprint: None,
                    ..
                }
            )
        })
        .count();
    assert_eq!(starts, 2);
    assert_eq!(starts, ends);
}

#[tokio::test]
async fn capacity_recovery_cancel_during_second_note_closes_all_staged_starts() {
    let (request, provider, journal) = capacity_recovery_request(
        "capacity-cancel",
        true,
        850,
        &["SHORT_NOTE_A", "SHORT_NOTE_B"],
        false,
    )
    .await;
    provider.pause_second.store(true, Ordering::SeqCst);
    let run = LoopEngine.start(request);
    tokio::time::timeout(Duration::from_secs(5), provider.second_entered.notified())
        .await
        .unwrap();
    run.cancel();
    let (_, result) = collect(run).await;
    assert_eq!(result.status, LoopStatus::Cancelled);
    let after = journal.load("capacity-cancel").await.unwrap().unwrap();
    assert_no_capacity_no_benefit(&after);
    assert!(!after
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    let starts = after
        .events()
        .iter()
        .filter(|e| matches!(e.data(), SessionEventData::CompactionStart { .. }))
        .count();
    let ends = after
        .events()
        .iter()
        .filter(|e| {
            matches!(
                e.data(),
                SessionEventData::CompactionEnd {
                    outcome: Some(xharness_session::CompactionEndOutcome::Interrupted),
                    ..
                }
            )
        })
        .count();
    assert_eq!(starts, 2);
    assert_eq!(starts, ends);
}

#[tokio::test]
async fn capacity_recovery_batch_cas_rejects_concurrent_metadata_without_partial_commit() {
    let (mut request, provider, journal) = capacity_recovery_request(
        "capacity-cas",
        true,
        850,
        &["SHORT_NOTE_A", "SHORT_NOTE_B"],
        false,
    )
    .await;
    let current = journal.load("capacity-cas").await.unwrap().unwrap();
    journal
        .append(
            "capacity-cas",
            current.revision(),
            vec![
                SessionEventData::TurnStart { turn: 3 }.into(),
                SessionEventData::UserMessage {
                    message: AgentMessage::user("TAIL_SCOPE: read-only"),
                    surface_replace: None,
                }
                .into(),
                SessionEventData::StepStart { turn: 3, step: 1 }.into(),
                SessionEventData::RequestHeader {
                    header: RequestHeader::new("fixture", "fixture"),
                }
                .into(),
                SessionEventData::AssistantMessage {
                    turn: 3,
                    step: 1,
                    message: AgentMessage::assistant("tail"),
                    usage: None,
                }
                .into(),
                SessionEventData::StepEnd { turn: 3, step: 1 }.into(),
                SessionEventData::TurnEnd {
                    turn: 3,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    provider.mutate_after_two.store(true, Ordering::SeqCst);
    let command_source = journal.load("capacity-cas").await.unwrap().unwrap();
    journal
        .append(
            "capacity-cas",
            command_source.revision(),
            vec![SessionEventData::CommandRun {
                command_id: "capacity-cas-command".into(),
                name: "compact".into(),
                args: None,
                source: xharness_session::CommandSource::User,
            }
            .into()],
        )
        .await
        .unwrap();
    request.messages.clear();
    request.manual_compaction_command_id = Some("capacity-cas-command".into());
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.inner.attempts(), 2, "{:?}", result.error);
    let after = journal.load("capacity-cas").await.unwrap().unwrap();
    assert_no_capacity_no_benefit(&after);
    assert!(!after
        .events()
        .iter()
        .any(|e| matches!(e.data(), SessionEventData::CompactionSummary { .. })));
    assert!(after.events().iter().any(|e| matches!(e.data(),SessionEventData::SessionTitle{title,..} if title=="synthetic metadata race")));
    assert_eq!(
        after
            .events()
            .iter()
            .filter(|e| matches!(
                e.data(),
                SessionEventData::CompactionEnd {
                    outcome: Some(xharness_session::CompactionEndOutcome::Interrupted),
                    ..
                }
            ))
            .count(),
        2
    );
}
