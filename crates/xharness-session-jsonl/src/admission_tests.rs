//! Long-conversation admission reuse and durability regressions.
#![forbid(unsafe_code)]
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
use xharness_session::{AssistantChunk, EventData};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self::at_time(nonce)
    }

    fn at_time(nonce: u128) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xh-flush-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        // Never let this fixture's cleanup own a pre-existing directory.
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn admission_fixtures_are_isolated_when_clock_ticks_repeat() {
    let first = Fixture::at_time(0);
    let second = Fixture::at_time(0);
    assert_ne!(first.0, second.0, "a clock tick is not a unique test ID");

    let fixtures = std::thread::scope(|scope| {
        let handles = (0..16)
            .map(|_| scope.spawn(|| Fixture::at_time(0)))
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    let paths = fixtures
        .iter()
        .map(|fixture| fixture.0.clone())
        .collect::<Vec<_>>();
    let unique = paths.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), paths.len());
    for fixture in &fixtures {
        assert!(
            fixture.0.is_dir(),
            "the fixture must exclusively own its directory"
        );
        fs::write(fixture.0.join("marker"), b"owned by this test").unwrap();
    }

    drop(first);
    assert!(
        second.0.is_dir(),
        "dropping another fixture must not remove this one"
    );
    drop(second);
    for path in &paths {
        assert!(path.join("marker").is_file());
    }
    drop(fixtures);
    for path in paths {
        assert!(!path.exists(), "each owned directory must be cleaned up");
    }
}

fn replays(store: &JsonlSessionStore) -> usize {
    store.cache.lock().unwrap().authoritative_replays
}
async fn populate(store: &JsonlSessionStore) -> Revision {
    store
        .create(SessionHeader {
            version: SessionHeader::FORMAT_VERSION,
            id: "large".into(),
            created_at_ms: 123,
            cwd: None,
        })
        .await
        .unwrap();
    let mut events = vec![
        EventData::TurnStart { turn: 1 }.into(),
        EventData::StepStart { turn: 1, step: 1 }.into(),
    ];
    for _ in 0..4096 {
        events.push(
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("stream data".repeat(16)),
            }
            .into(),
        );
    }
    store
        .append("large", Revision::ZERO, events)
        .await
        .unwrap()
        .revision
}

#[tokio::test]
async fn oversized_conversation_flush_reuses_validated_stamp_without_replay() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(1024, 1);
    let revision = populate(&store).await;
    assert_eq!(
        store.cache_stats().entries,
        0,
        "snapshot must exceed the LRU budget"
    );
    let before = replays(&store);
    let bytes = fs::read(fixture.0.join("large.jsonl")).unwrap();
    for _ in 0..3 {
        assert_eq!(store.flush("large").await.unwrap(), revision);
    }
    assert_eq!(
        replays(&store),
        before,
        "durability must not reparse the evicted snapshot"
    );
    assert_eq!(fs::read(fixture.0.join("large.jsonl")).unwrap(), bytes);
    assert_eq!(store.cache_stats().entries, 0);

    // A restarted store has no trusted stamp: validate once, then reuse it.
    let reopened = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    assert_eq!(reopened.flush("large").await.unwrap(), revision);
    assert_eq!(replays(&reopened), 1);
    assert_eq!(reopened.flush("large").await.unwrap(), revision);
    assert_eq!(replays(&reopened), 1);
}

#[tokio::test]
async fn flush_stamp_does_not_hide_other_writer_corruption_or_removal() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    let revision = populate(&store).await;
    let before = replays(&store);
    let writer = JsonlSessionStore::new(&fixture.0).unwrap();
    let next = writer
        .append(
            "large",
            revision,
            vec![EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("other writer".into()),
            }
            .into()],
        )
        .await
        .unwrap()
        .revision;
    assert_eq!(store.flush("large").await.unwrap(), next);
    assert_eq!(replays(&store), before + 1);
    let path = fixture.0.join("large.jsonl");
    let valid = fs::read(&path).unwrap();
    fs::write(&path, b"corrupt\n").unwrap();
    assert!(store.flush("large").await.is_err());
    fs::write(&path, valid).unwrap();
    assert_eq!(store.flush("large").await.unwrap(), next);
    fs::remove_file(&path).unwrap();
    assert!(matches!(
        store.flush("large").await,
        Err(StoreError::NotFound { .. })
    ));
}

#[tokio::test]
async fn flush_revalidates_replacement_and_keeps_torn_tail_recovery_read_only() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    let revision = populate(&store).await;
    let path = fixture.0.join("large.jsonl");
    let before = replays(&store);
    // An atomic replacement with identical bytes is not the validated file.
    let replacement = fixture.0.join("replacement");
    fs::write(&replacement, fs::read(&path).unwrap()).unwrap();
    fs::remove_file(&path).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_eq!(store.flush("large").await.unwrap(), revision);
    assert_eq!(replays(&store), before + 1);
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"record\":")
        .unwrap();
    let torn = fs::read(&path).unwrap();
    assert_eq!(store.flush("large").await.unwrap(), revision);
    assert_eq!(replays(&store), before + 2);
    assert_eq!(store.flush("large").await.unwrap(), revision);
    assert_eq!(replays(&store), before + 2);
    assert_eq!(fs::read(&path).unwrap(), torn);
}

#[cfg(unix)]
#[tokio::test]
async fn warm_flush_stamp_never_follows_a_replacement_symlink() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    populate(&store).await;
    let path = fixture.0.join("large.jsonl");
    let target = fixture.0.join("outside");
    fs::rename(&path, &target).unwrap();
    let before = fs::read(&target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(store.flush("large").await.is_err());
    assert_eq!(fs::read(&target).unwrap(), before);
}

#[tokio::test]
async fn admission_scope_reuses_one_oversized_replay_and_releases_it() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    let revision = populate(&store).await;
    let before = replays(&store);
    let scope = store.read_scope("large").unwrap();
    let nested = store.read_scope("large").unwrap();
    let old = store.load("large").await.unwrap().unwrap();
    assert_eq!(store.replay_scope_cache_stats().entries, 1);
    for _ in 0..3 {
        store.load("large").await.unwrap().unwrap();
    }
    let next = store
        .append(
            "large",
            revision,
            vec![EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("new".into()),
            }
            .into()],
        )
        .await
        .unwrap();
    assert_eq!(store.flush("large").await.unwrap(), next.revision);
    assert_eq!(
        old.revision(),
        revision,
        "prior immutable snapshots cannot change"
    );
    assert_eq!(
        store.load("large").await.unwrap().unwrap().revision(),
        next.revision
    );
    assert_eq!(
        replays(&store),
        before + 1,
        "one admission must not replay between stages"
    );
    assert_eq!(store.cache_stats().entries, 0);
    drop(scope);
    assert_eq!(
        store.replay_scope_cache_stats().entries,
        1,
        "nested scope still owns reuse"
    );
    drop(nested);
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
    store.load("large").await.unwrap().unwrap();
    assert_eq!(replays(&store), before + 2);
}

#[tokio::test]
async fn admission_scope_external_writes_stale_cas_and_failed_appends_are_not_hidden() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    let revision = populate(&store).await;
    let scope = store.read_scope("large").unwrap();
    store.load("large").await.unwrap().unwrap();
    let writer = JsonlSessionStore::new(&fixture.0).unwrap();
    let next = writer
        .append(
            "large",
            revision,
            vec![EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("external".into()),
            }
            .into()],
        )
        .await
        .unwrap();
    assert!(matches!(store.append("large", revision, vec![]).await,
            Err(StoreError::RevisionConflict { actual, .. }) if actual == next.revision));
    assert!(store
        .append(
            "large",
            next.revision,
            vec![EventData::StepStart { turn: 99, step: 2 }.into()]
        )
        .await
        .is_err());
    assert_eq!(store.flush("large").await.unwrap(), next.revision);
    assert_eq!(
        store.load("large").await.unwrap().unwrap().revision(),
        next.revision
    );
    fs::write(fixture.0.join("large.jsonl"), b"corrupt\n").unwrap();
    assert!(store.load("large").await.is_err());
    assert!(store.flush("large").await.is_err());
    drop(scope);
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
}

#[tokio::test]
async fn admission_scope_byte_and_entry_limits_decline_without_changing_reads() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    let revision = populate(&store).await;
    store.cache.lock().unwrap().scopes.max_bytes = 1;
    let mut guards = Vec::new();
    for id in ["a", "b", "c", "d", "large"] {
        guards.push(store.read_scope(id).unwrap());
    }
    assert_eq!(store.cache.lock().unwrap().scopes.entries.len(), 4);
    for _ in 0..2 {
        assert_eq!(
            store.load("large").await.unwrap().unwrap().revision(),
            revision
        );
    }
    assert_eq!(store.replay_scope_cache_stats().entries, 0);
    drop(guards);
    let scope = store.read_scope("large").unwrap();
    let before = replays(&store);
    for _ in 0..2 {
        store.load("large").await.unwrap().unwrap();
    }
    assert_eq!(
        replays(&store),
        before + 2,
        "over-budget scopes must fall back, not retain"
    );
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
    drop(scope);
}

#[tokio::test]
async fn cancelling_admission_releases_the_temporary_snapshot() {
    let fixture = Fixture::new();
    let store = JsonlSessionStore::new(&fixture.0)
        .unwrap()
        .with_cache_limits(0, 0);
    populate(&store).await;
    let owned = store.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _scope = owned.read_scope("large").unwrap();
        owned.load("large").await.unwrap().unwrap();
        tx.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    rx.await.unwrap();
    assert_eq!(store.replay_scope_cache_stats().entries, 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
}
