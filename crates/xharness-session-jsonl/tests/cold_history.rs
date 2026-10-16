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
    for damage in [
        "legacy", "schema", "values", "version", "index", "pending", "id",
    ] {
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
