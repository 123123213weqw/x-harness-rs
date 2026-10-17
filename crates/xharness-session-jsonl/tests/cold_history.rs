//! Source-bound display reads must never recover or rewrite the journal.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_session::{EventData, HistoryPresentation, SessionCatalogEntry, SessionHeader, Store};
use xharness_session_jsonl::JsonlSessionStore;
const SCHEMA: &str = "test.display.v1";
struct Fixture {
    dir: PathBuf,
    store: JsonlSessionStore,
    entry: SessionCatalogEntry,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
async fn fixture() -> Fixture {
    static ID: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "xh-cold-history-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        ID.fetch_add(1, Ordering::Relaxed)
    ));
    let store = JsonlSessionStore::new(&dir)
        .unwrap()
        .with_cache_limits(0, 0)
        .for_runtime();
    let header = SessionHeader::new("test");
    let s = store.create(header.clone()).await.unwrap();
    store
        .append(
            "test",
            s.revision(),
            vec![EventData::PlanMode { active: true }.into()],
        )
        .await
        .unwrap();
    let s = store.load("test").await.unwrap().unwrap();
    let entry = SessionCatalogEntry {
        header,
        updated_at_ms: 1,
        title: Some("display".into()),
        agent_preset: None,
        parent_session_id: None,
        origin: None,
        model_provider: "test".into(),
        model: "model".into(),
        reasoning_effort: None,
        context_window_tokens: None,
        permission_preset: "workspace-write".into(),
        plan_active: true,
        blank: true,
        next_seq: s.next_seq(),
        needs_recovery: false,
        metric_snapshot: None,
    };
    store.publish_catalog_presentation(entry.clone(),HistoryPresentation{schema:SCHEMA.into(),values:json!({"goal":{"phase":"complete"},"plan":{"active":true},"usage":{"exact":17}})}).await.unwrap();
    Fixture { dir, store, entry }
}
#[tokio::test]
async fn cold_display_is_read_only_bounded_source_validated_and_restart_safe() {
    let f = fixture().await;
    let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
    let reopened = JsonlSessionStore::new(&f.dir).unwrap().for_runtime();
    let cut = reopened
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cut.catalog, f.entry);
    assert_eq!(cut.window.next_seq, f.entry.next_seq);
    assert_eq!(cut.presentation.values["goal"]["phase"], "complete");
    assert_eq!(cut.presentation.values["usage"]["exact"], 17);
    assert_eq!(
        reopened.cache_stats().entries,
        0,
        "no heavyweight Session was loaded"
    );
    assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
    let first = reopened
        .cold_history_window("test", SCHEMA, Some(0), 50)
        .await
        .unwrap()
        .unwrap();
    assert!(first.window.events.is_empty());
    assert!(!first.window.has_more);
    assert!(reopened
        .cold_history_window("test", "future.schema", None, 50)
        .await
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn legacy_corrupt_unknown_or_incomplete_display_state_is_a_cache_miss() {
    for damage in ["legacy", "schema", "values", "version", "pending", "id"] {
        let f = fixture().await;
        let path = f
            .dir
            .join(if matches!(damage, "legacy" | "schema" | "values") {
                "test.history-presentation"
            } else {
                "test.catalog"
            });
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match damage {
            "legacy" => {
                record.as_object_mut().unwrap().remove("presentation");
            }
            "schema" => record["presentation"]["schema"] = json!("future.schema"),
            "values" => record["presentation"]["values"] = json!(null),
            "version" => record["version"] = json!(99),
            "id" => record["entry"]["header"]["id"] = json!("another"),
            "pending" => record["entry"]["needsRecovery"] = json!(true),
            "index" => {
                fs::write(f.dir.join("test.history-index"), b"broken").unwrap();
            }
            _ => unreachable!(),
        }
        if damage != "index" {
            fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        assert!(
            f.store
                .cold_history_window("test", SCHEMA, None, 50)
                .await
                .unwrap()
                .is_none(),
            "{damage}"
        );
        assert!(
            f.store.load("test").await.unwrap().is_some(),
            "optional acceleration never damages recovery"
        );
    }
}
#[tokio::test]
async fn stale_sources_and_stale_publication_cannot_certify_a_display_cut() {
    let f = fixture().await;
    let s = f.store.load("test").await.unwrap().unwrap();
    f.store
        .append(
            "test",
            s.revision(),
            vec![EventData::PlanMode { active: false }.into()],
        )
        .await
        .unwrap();
    assert!(f
        .store
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .is_none());
    assert!(f
        .store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({})
            }
        )
        .await
        .is_err());
}
#[tokio::test]
async fn oversized_snapshots_fall_back_without_losing_the_legacy_catalogue() {
    let f = fixture().await;
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({"large":"x".repeat(1024*1024)}),
            },
        )
        .await
        .unwrap();
    assert!(f
        .store
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        f.store.catalog_entry("test").await.unwrap().unwrap(),
        f.entry
    );
    assert!(fs::metadata(f.dir.join("test.catalog")).unwrap().len() < 1024 * 1024);
    assert!(!f.dir.join("test.history-presentation").exists());
}
#[tokio::test]
async fn publication_never_preserves_presentation_for_pending_work() {
    let mut f = fixture().await;
    f.entry.needs_recovery = true;
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({"looksIdle":true}),
            },
        )
        .await
        .unwrap();
    assert!(f
        .store
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .is_none());
    assert!(
        f.store
            .catalog_entry("test")
            .await
            .unwrap()
            .unwrap()
            .needs_recovery
    );
}
#[cfg(unix)]
#[tokio::test]
async fn symlink_sidecars_are_not_accepted_as_display_evidence() {
    for name in ["test.catalog", "test.history-presentation"] {
        let f = fixture().await;
        let path = f.dir.join(name);
        let backup = f.dir.join("saved");
        fs::rename(&path, &backup).unwrap();
        std::os::unix::fs::symlink(&backup, &path).unwrap();
        let original = fs::read(&backup).unwrap();
        assert!(f
            .store
            .cold_history_window("test", SCHEMA, None, 50)
            .await
            .unwrap()
            .is_none());
        assert_eq!(fs::read(&backup).unwrap(), original);
    }
}

#[tokio::test]
async fn valid_json_payload_corruption_is_not_accepted_at_the_same_source_cursor() {
    for damage in ["digest", "partial", "missing-digest"] {
        let f = fixture().await;
        let path = f.dir.join("test.history-presentation");
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match damage {
            "digest" => record["presentation"]["values"]["usage"]["exact"] = json!(18),
            "partial" => {
                record["presentation"]["values"]
                    .as_object_mut()
                    .unwrap()
                    .remove("goal");
            }
            "missing-digest" => {
                record.as_object_mut().unwrap().remove("sha256");
            }
            _ => unreachable!(),
        }
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(
            f.store
                .cold_history_window("test", SCHEMA, None, 50)
                .await
                .unwrap()
                .is_none(),
            "{damage}"
        );
    }
}

#[tokio::test]
async fn display_snapshot_does_not_enlarge_startup_metadata_and_is_disposable() {
    let f = fixture().await;
    let before = fs::read(f.dir.join("test.catalog")).unwrap();
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({"large":"x".repeat(512*1024)}),
            },
        )
        .await
        .unwrap();
    assert_eq!(fs::read(f.dir.join("test.catalog")).unwrap(), before);
    assert!(
        fs::metadata(f.dir.join("test.history-presentation"))
            .unwrap()
            .len()
            > 512 * 1024
    );
    f.store
        .publish_catalog_entry(f.entry.clone())
        .await
        .unwrap();
    assert!(!f.dir.join("test.history-presentation").exists());
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({}),
            },
        )
        .await
        .unwrap();
    assert!(f.dir.join("test.history-presentation").exists());
    f.store.delete_session_data("test").await.unwrap();
    assert!(!f.dir.join("test.history-presentation").exists());
}

#[tokio::test]
async fn optional_snapshot_publication_failure_does_not_fail_catalogue_or_journal() {
    let f = fixture().await;
    let path = f.dir.join("test.history-presentation");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("foreign"), b"do not remove unrelated contents").unwrap();
    let original = fs::read(f.dir.join("test.jsonl")).unwrap();
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        f.store.catalog_entry("test").await.unwrap().unwrap(),
        f.entry
    );
    assert!(f
        .store
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .is_none());
    assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), original);
    assert_eq!(
        fs::read(path.join("foreign")).unwrap(),
        b"do not remove unrelated contents"
    );
}

#[tokio::test]
async fn checkpoint_owner_can_seed_only_an_identical_valid_idle_catalogue_without_load() {
    let f = fixture().await;
    fs::remove_file(f.dir.join("test.history-presentation")).unwrap();
    let fresh = JsonlSessionStore::new(&f.dir).unwrap().for_runtime();
    let mut changed = f.entry.clone();
    changed.title = Some("must not change metadata without recovery".into());
    assert!(fresh
        .publish_catalog_presentation(
            changed,
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({}),
            }
        )
        .await
        .is_err());
    fresh
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({"verifiedCheckpoint":true}),
            },
        )
        .await
        .unwrap();
    assert_eq!(fresh.cache_stats().entries, 0);
    assert!(fresh
        .cold_history_window("test", SCHEMA, None, 50)
        .await
        .unwrap()
        .is_some());
    assert_eq!(fresh.catalog_entry("test").await.unwrap().unwrap(), f.entry);
}

#[tokio::test]
async fn missing_stale_and_corrupt_offset_indexes_repair_without_a_session() {
    for damage in [
        "missing", "json", "checksum", "version", "source", "oversize",
    ] {
        let f = fixture().await;
        let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
        let expected = f
            .store
            .cold_history_window("test", SCHEMA, None, 1)
            .await
            .unwrap()
            .unwrap();
        let path = f.dir.join("test.history-index");
        let mut index: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match damage {
            "missing" => fs::remove_file(&path).unwrap(),
            "json" => fs::write(&path, b"broken").unwrap(),
            "oversize" => fs::File::create(&path)
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap(),
            _ => {
                match damage {
                    "checksum" => index["sha256"] = json!("0".repeat(64)),
                    "version" => index["index"]["version"] = json!(99),
                    "source" => index["index"]["fingerprint"]["len"] = json!(0),
                    _ => unreachable!(),
                }
                fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
            }
        }
        let cold = JsonlSessionStore::new(&f.dir).unwrap().for_runtime();
        let actual = cold
            .cold_history_window("test", SCHEMA, None, 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual.window.events, expected.window.events, "{damage}");
        assert_eq!(actual.window.context, expected.window.context, "{damage}");
        assert_eq!(actual.window.next_seq, expected.window.next_seq);
        assert_eq!(actual.window.has_more, expected.window.has_more);
        assert_eq!(actual.presentation.values, expected.presentation.values);
        assert_eq!(cold.cache_stats().entries, 0);
        let older = cold
            .cold_history_window("test", SCHEMA, Some(0), 1)
            .await
            .unwrap()
            .unwrap();
        assert!(older.window.events.is_empty() && !older.window.has_more);
        assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
        assert!(serde_json::from_slice::<Value>(&fs::read(path).unwrap()).is_ok());
    }
}

#[tokio::test]
async fn parsed_indexes_are_bounded_optional_and_invalidated_by_replacement() {
    let f = multi_batch_fixture(256, 128).await;
    for (bytes, entries) in [(0, 4), (1024 * 1024, 0), (1, 4), (1024 * 1024, 1)] {
        let cold = JsonlSessionStore::new(&f.dir)
            .unwrap()
            .with_history_index_cache_limits(bytes, entries);
        for _ in 0..3 {
            assert!(cold
                .cold_history_window("test", SCHEMA, None, 1)
                .await
                .unwrap()
                .is_some());
        }
        let stats = cold.history_index_cache_stats();
        assert!(stats.accounted_bytes <= bytes);
        assert!(stats.entries <= entries);
        assert_eq!(
            stats.entries,
            usize::from(bytes == 1024 * 1024 && entries == 1)
        );
        fs::write(f.dir.join("test.history-index"), b"corrupt after cache hit").unwrap();
        assert!(cold
            .cold_history_window("test", SCHEMA, None, 1)
            .await
            .unwrap()
            .is_some());
        assert_eq!(cold.cache_stats().entries, 0);
    }
}

struct CountFold {
    seen: u64,
    oversize: bool,
}
impl xharness_session::CatalogMetricsFold for CountFold {
    fn apply(&mut self, events: &[xharness_session::LoggedEvent]) {
        self.seen += events.len() as u64;
    }
    fn snapshot(&self) -> Value {
        if self.oversize {
            json!({"tooLarge": "x".repeat(1024 * 1024)})
        } else {
            json!({"count": self.seen})
        }
    }
}

#[tokio::test]
async fn metrics_scan_publishes_only_a_complete_exact_source_without_recovery_stamps() {
    let f = fixture().await;
    let cold = JsonlSessionStore::new(&f.dir).unwrap().for_runtime();
    let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
    let snapshot = cold
        .repair_catalog_metrics(
            f.entry.clone(),
            Box::new(CountFold {
                seen: 0,
                oversize: false,
            }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot, json!({"count": f.entry.next_seq}));
    let mut expected = f.entry.clone();
    expected.metric_snapshot = Some(snapshot);
    assert_eq!(cold.catalog_entry("test").await.unwrap().unwrap(), expected);
    assert_eq!(cold.cache_stats().entries, 0);
    assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
    let mut changed = expected.clone();
    changed.title = Some("unauthorized metadata change".into());
    assert!(
        cold.publish_catalog_entry(changed.clone()).await.is_err(),
        "display scan must not mint a recovery/source publication stamp"
    );
    assert!(cold
        .repair_catalog_metrics(
            changed,
            Box::new(CountFold {
                seen: 0,
                oversize: false
            })
        )
        .await
        .unwrap()
        .is_none());
    let before = fs::read(f.dir.join("test.catalog")).unwrap();
    assert!(cold
        .repair_catalog_metrics(
            expected,
            Box::new(CountFold {
                seen: 0,
                oversize: true
            })
        )
        .await
        .is_err());
    assert_eq!(fs::read(f.dir.join("test.catalog")).unwrap(), before);
}

#[tokio::test]
async fn noncooperating_source_or_catalogue_changes_discard_partial_metrics() {
    struct RacingFold {
        path: PathBuf,
    }
    impl xharness_session::CatalogMetricsFold for RacingFold {
        fn apply(&mut self, _: &[xharness_session::LoggedEvent]) {
            use std::io::Write;
            if self.path.extension().is_some_and(|e| e == "catalog") {
                let mut record: Value =
                    serde_json::from_slice(&fs::read(&self.path).unwrap()).unwrap();
                record["entry"]["title"] = json!("another publisher changed metadata");
                fs::write(&self.path, serde_json::to_vec(&record).unwrap()).unwrap();
            } else {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&self.path)
                    .unwrap()
                    .write_all(b" ")
                    .unwrap();
            }
        }
        fn snapshot(&self) -> Value {
            json!({"mustNotBePublished":true})
        }
    }
    for suffix in ["jsonl", "catalog"] {
        let f = fixture().await;
        let cold = JsonlSessionStore::new(&f.dir).unwrap();
        let result = cold
            .repair_catalog_metrics(
                f.entry.clone(),
                Box::new(RacingFold {
                    path: f.dir.join(format!("test.{suffix}")),
                }),
            )
            .await;
        assert!(matches!(result, Ok(None)), "{result:?}");
        let bytes = fs::read(f.dir.join("test.catalog")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("mustNotBePublished"));
        assert_eq!(cold.cache_stats().entries, 0);
    }
}

#[tokio::test]
async fn failed_index_publication_still_serves_the_page_without_replay_or_removing_files() {
    let f = fixture().await;
    let index = f.dir.join("test.history-index");
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap();
    fs::write(index.join("foreign"), b"preserve").unwrap();
    let cold = JsonlSessionStore::new(&f.dir).unwrap();
    let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
    assert!(cold
        .cold_history_window("test", SCHEMA, None, 1)
        .await
        .unwrap()
        .is_some());
    assert_eq!(cold.cache_stats().entries, 0);
    assert_eq!(fs::read(index.join("foreign")).unwrap(), b"preserve");
    assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
}

/// Synthetic multi-batch journal, verified once by the normal full replay.
/// Benchmarks then use fresh Stores so a warm Session cannot hide disk reads.
async fn multi_batch_fixture(turns: u32, text_bytes: usize) -> Fixture {
    use std::io::{BufWriter, Write};
    use xharness_session::{LoggedEvent, Message, RequestHeader, Revision, TurnEndReason};
    let mut f = fixture().await;
    let path = f.dir.join("test.jsonl");
    let mut file = BufWriter::new(fs::File::create(&path).unwrap());
    serde_json::to_writer(&mut file, &json!({"record":"header", "format":"xharness.session.jsonl", "format_version":1, "header": f.entry.header})).unwrap();
    file.write_all(b"\n").unwrap();
    let mut seq = 0;
    for turn in 1..=turns {
        let events = vec![
            EventData::TurnStart { turn },
            EventData::UserMessage {
                message: Message::user(format!("question {turn}")),
                surface_replace: None,
            },
            EventData::StepStart { turn, step: 1 },
            EventData::RequestHeader {
                header: RequestHeader::new("test", "model"),
            },
            EventData::AssistantMessage {
                turn,
                step: 1,
                message: Message::assistant("x".repeat(text_bytes)),
                usage: Some(json!({"inputTokens":10,"cacheReadTokens":90,"outputTokens":5})),
            },
            EventData::StepEnd { turn, step: 1 },
            EventData::TurnEnd {
                turn,
                reason: TurnEndReason::Completed,
            },
        ]
        .into_iter()
        .map(|data| {
            let event = LoggedEvent {
                seq,
                revision: Revision(turn as u64),
                timestamp_ms: turn as u64 * 1000,
                event: data.into(),
            };
            seq += 1;
            event
        })
        .collect::<Vec<_>>();
        serde_json::to_writer(&mut file, &json!({"record":"batch", "previous_revision":Revision(turn as u64 - 1), "revision":Revision(turn as u64), "events":events})).unwrap();
        file.write_all(b"\n").unwrap();
    }
    file.flush().unwrap();
    drop(file);
    let loaded = f.store.load("test").await.unwrap().unwrap();
    f.entry.next_seq = loaded.next_seq();
    f.entry.plan_active = false;
    f.entry.blank = false;
    f.store
        .publish_catalog_presentation(
            f.entry.clone(),
            HistoryPresentation {
                schema: SCHEMA.into(),
                values: json!({"fixture":true}),
            },
        )
        .await
        .unwrap();
    f
}

#[tokio::test]
async fn streaming_metrics_and_index_repair_match_compressed_multi_batch_sources() {
    for compressed in [false, true] {
        let f = multi_batch_fixture(8, 8192).await;
        if compressed {
            assert!(f.store.compress_cold_session("test").await.unwrap().changed);
            f.store.load("test").await.unwrap().unwrap();
            f.store
                .publish_catalog_presentation(
                    f.entry.clone(),
                    HistoryPresentation {
                        schema: SCHEMA.into(),
                        values: json!({"fixture":true}),
                    },
                )
                .await
                .unwrap();
        }
        let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
        fs::remove_file(f.dir.join("test.history-index")).unwrap();
        let cold = JsonlSessionStore::new(&f.dir).unwrap().for_runtime();
        let tail = cold
            .cold_history_window("test", SCHEMA, None, 2)
            .await
            .unwrap()
            .unwrap();
        assert!(tail.window.has_more);
        assert_eq!(tail.window.next_seq, 56);
        let before = tail.window.events[0].seq;
        let older = cold
            .cold_history_window("test", SCHEMA, Some(before), 2)
            .await
            .unwrap()
            .unwrap();
        assert!(older.window.events.iter().all(|e| e.seq < before));
        let counted = cold
            .repair_catalog_metrics(
                f.entry.clone(),
                Box::new(CountFold {
                    seen: 0,
                    oversize: false,
                }),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(counted, json!({"count":56}));
        assert_eq!(cold.cache_stats().entries, 0);
        assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
    }
}

#[tokio::test]
#[ignore = "opt-in parsed-index A/B benchmark; no network/model calls"]
async fn parsed_index_cache_ab_benchmark() {
    let f = multi_batch_fixture(2000, 256).await;
    let journal = fs::read(f.dir.join("test.jsonl")).unwrap();
    let mut expected = None;
    for enabled in [false, true, true, false] {
        let store = JsonlSessionStore::new(&f.dir)
            .unwrap()
            .with_history_index_cache_limits(if enabled { 8 * 1024 * 1024 } else { 0 }, 4);
        let began = std::time::Instant::now();
        let mut cursor = None;
        let mut coordinates = Vec::new();
        for _ in 0..60 {
            let page = store
                .cold_history_window("test", SCHEMA, cursor, 20)
                .await
                .unwrap()
                .unwrap();
            coordinates.extend(page.window.events.iter().map(|e| e.seq));
            cursor = page.window.events.first().map(|e| e.seq);
        }
        let ms = began.elapsed().as_secs_f64() * 1000.0;
        if let Some(reference) = &expected {
            assert_eq!(&coordinates, reference);
        } else {
            expected = Some(coordinates);
        }
        let cache = store.history_index_cache_stats();
        assert!(cache.accounted_bytes <= cache.max_bytes);
        assert_eq!(store.cache_stats().entries, 0);
        println!("INDEX_CACHE_AB enabled={enabled} pages=60 ms={ms:.3} cache_entries={} cache_bytes={} index_bytes={}", cache.entries, cache.accounted_bytes, fs::metadata(f.dir.join("test.history-index")).unwrap().len());
    }
    assert_eq!(fs::read(f.dir.join("test.jsonl")).unwrap(), journal);
}
