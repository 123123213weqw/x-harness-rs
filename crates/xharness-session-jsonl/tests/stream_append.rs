//! Synthetic stream checkpoints over a journal deliberately larger than its LRU.
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_session::{
    AssistantChunk, EventData, Message, ModelReception, Revision, SessionHeader, Store,
    TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-stream-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> JsonlSessionStore {
        JsonlSessionStore::new(&self.0)
            .unwrap()
            .with_cache_limits(1, 0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn open(store: &JsonlSessionStore, id: &str) -> Revision {
    store.create(SessionHeader::new(id)).await.unwrap();
    store
        .append(
            id,
            Revision::ZERO,
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: Message::user("synthetic history ".repeat(1024)),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
            ],
        )
        .await
        .unwrap()
        .revision
}

fn frame(turn: u32, step: u32, n: u64) -> Vec<xharness_session::SessionEvent> {
    vec![
        EventData::AssistantChunk {
            turn,
            step,
            chunk: AssistantChunk::TextDelta(format!("chunk-{n} ")),
        }
        .into(),
        EventData::ModelReception {
            turn,
            step,
            reception: ModelReception {
                attempt: 0,
                start_ms: 1000,
                first_delta_ms: Some(1001),
                elapsed_ms: n + 2,
                reception_ms: n + 1,
                estimated_units: n + 1,
                estimated_reasoning_units: 0,
                finished: false,
                output_tokens: None,
                reasoning_tokens: None,
                samples: vec![],
            },
        }
        .into(),
    ]
}

#[tokio::test]
async fn oversized_stream_checkpoints_do_not_replay_the_validated_prefix() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let mut revision = open(&store, "large").await;
    let before = store.authoritative_replay_count();
    for n in 0..32 {
        revision = store
            .append("large", revision, frame(1, 1, n))
            .await
            .unwrap()
            .revision;
        store.flush("large").await.unwrap();
    }
    assert_eq!(
        store.cache_stats().entries,
        0,
        "do not silently raise the resident cache limit"
    );
    assert_eq!(
        store.authoritative_replay_count() - before,
        0,
        "stream-only appends must reuse the source-validated cursor, not replay the whole journal"
    );
    store
        .append(
            "large",
            revision,
            vec![
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("complete"),
                    usage: None,
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let restored = fixture.store().load("large").await.unwrap().unwrap();
    assert_eq!(restored.events().len(), 70);
    assert_eq!(
        restored.derive_messages().last().unwrap().content,
        "complete"
    );
}

#[tokio::test]
async fn invalid_stream_batches_and_stale_cas_never_modify_disk_or_cursor() {
    let f = Fixture::new();
    let store = f.store();
    let revision = open(&store, "invalid").await;
    let path = f.0.join("invalid.jsonl");
    let before = std::fs::read(&path).unwrap();
    assert!(store
        .append("invalid", revision, frame(2, 1, 0))
        .await
        .is_err());
    assert!(store
        .append("invalid", Revision::ZERO, frame(1, 1, 0))
        .await
        .is_err());
    let mut mixed = frame(1, 1, 0);
    mixed.extend(frame(1, 2, 1));
    assert!(store.append("invalid", revision, mixed).await.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let receipt = store
        .append("invalid", revision, frame(1, 1, 2))
        .await
        .unwrap();
    assert_eq!(receipt.first_seq, 3);
    assert_eq!(
        f.store().load("invalid").await.unwrap().unwrap().next_seq(),
        5
    );
}

#[tokio::test]
async fn external_writer_invalidates_the_cursor_and_preserves_cas() {
    let f = Fixture::new();
    let store = f.store();
    let old = open(&store, "external").await;
    let other = f.store();
    let current = other
        .append(
            "external",
            old,
            vec![EventData::SessionTitle {
                title: "external title".into(),
                message_seqs: vec![],
                source: xharness_session::SessionTitleSource::User,
            }
            .into()],
        )
        .await
        .unwrap()
        .revision;
    assert!(
        matches!(store.append("external",old,frame(1,1,0)).await,Err(xharness_session::StoreError::RevisionConflict{actual,..}) if actual == current)
    );
    store
        .append("external", current, frame(1, 1, 1))
        .await
        .unwrap();
    let loaded = f.store().load("external").await.unwrap().unwrap();
    assert!(loaded
        .events()
        .iter()
        .any(|e| matches!(e.data(),EventData::SessionTitle{title,..}if title=="external title")));
    assert_eq!(loaded.next_seq(), 6);
}

#[tokio::test]
async fn cold_reopen_replays_once_then_streams_incrementally() {
    let f = Fixture::new();
    let original = f.store();
    let mut revision = open(&original, "cold").await;
    drop(original);
    let store = f.store();
    revision = store
        .append("cold", revision, frame(1, 1, 0))
        .await
        .unwrap()
        .revision;
    assert_eq!(store.authoritative_replay_count(), 1);
    for n in 1..20 {
        revision = store
            .append("cold", revision, frame(1, 1, n))
            .await
            .unwrap()
            .revision;
    }
    assert_eq!(store.authoritative_replay_count(), 1);
    assert_eq!(
        f.store().load("cold").await.unwrap().unwrap().next_seq(),
        43
    );
}

#[tokio::test]
async fn torn_tail_and_missing_newline_use_authoritative_repair_before_acceleration() {
    use std::io::Write;
    for torn in [false, true] {
        let f = Fixture::new();
        let store = f.store();
        let revision = open(&store, "repair").await;
        let path = f.0.join("repair.jsonl");
        if torn {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(b"{\"record\":")
                .unwrap();
        } else {
            let mut bytes = std::fs::read(&path).unwrap();
            assert_eq!(bytes.pop(), Some(b'\n'));
            std::fs::write(&path, bytes).unwrap();
        }
        let revision = store
            .append("repair", revision, frame(1, 1, 0))
            .await
            .unwrap()
            .revision;
        let replayed = store.authoritative_replay_count();
        store
            .append("repair", revision, frame(1, 1, 1))
            .await
            .unwrap();
        assert_eq!(store.authoritative_replay_count(), replayed);
        assert_eq!(
            f.store().load("repair").await.unwrap().unwrap().next_seq(),
            7
        );
    }
}

#[tokio::test]
async fn corrupt_prefix_and_replaced_inode_never_reuse_a_stale_cursor() {
    let f = Fixture::new();
    let store = f.store();
    let revision = open(&store, "replace").await;
    let path = f.0.join("replace.jsonl");
    let bytes = std::fs::read(&path).unwrap();
    let replacement = f.0.join("replacement");
    std::fs::write(&replacement, &bytes).unwrap();
    std::fs::rename(replacement, &path).unwrap();
    let revision = store
        .append("replace", revision, frame(1, 1, 0))
        .await
        .unwrap()
        .revision;
    assert_eq!(
        store.authoritative_replay_count(),
        2,
        "create/open append and replaced-inode replay"
    );
    let mut corrupted = std::fs::read(&path).unwrap();
    corrupted[0] = b'!';
    std::fs::write(&path, &corrupted).unwrap();
    assert!(store
        .append("replace", revision, frame(1, 1, 1))
        .await
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), corrupted);
}

#[tokio::test]
async fn concurrent_cas_has_one_winner_without_dropping_or_duplicating_events() {
    let f = Fixture::new();
    let store = std::sync::Arc::new(f.store());
    let revision = open(&store, "race").await;
    let (a, b) = tokio::join!(
        store.append("race", revision, frame(1, 1, 0)),
        store.append("race", revision, frame(1, 1, 1))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(f.store().load("race").await.unwrap().unwrap().next_seq(), 5);
}

#[tokio::test]
async fn structural_batches_fall_back_and_streams_after_completion_are_rejected() {
    let f = Fixture::new();
    let store = f.store();
    let revision = open(&store, "mixed").await;
    let mut events = frame(1, 1, 0);
    events.push(
        EventData::AssistantMessage {
            turn: 1,
            step: 1,
            message: Message::assistant("done"),
            usage: None,
        }
        .into(),
    );
    let revision = store
        .append("mixed", revision, events)
        .await
        .unwrap()
        .revision;
    let path = f.0.join("mixed.jsonl");
    let before = std::fs::read(&path).unwrap();
    assert!(store
        .append("mixed", revision, frame(1, 1, 1))
        .await
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        f.store().load("mixed").await.unwrap().unwrap().next_seq(),
        6
    );
}

#[tokio::test]
async fn scoped_readers_reuse_the_snapshot_and_release_it_without_promoting_to_lru() {
    let f = Fixture::new();
    let store = f.store();
    let mut revision = open(&store, "scope").await;
    let a = store.read_scope("scope").unwrap();
    let b = store.read_scope("scope").unwrap();
    store.load("scope").await.unwrap();
    let before = store.authoritative_replay_count();
    for n in 0..30 {
        revision = store
            .append("scope", revision, frame(1, 1, n))
            .await
            .unwrap()
            .revision;
        let cut = store.load("scope").await.unwrap().unwrap();
        assert_eq!(cut.revision(), revision);
    }
    assert_eq!(store.authoritative_replay_count(), before);
    assert!(store.replay_scope_cache_stats().accounted_bytes > 0);
    assert_eq!(store.cache_stats().entries, 0);
    drop(a);
    assert!(store.replay_scope_cache_stats().accounted_bytes > 0);
    drop(b);
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
}

#[tokio::test]
async fn exhausted_scope_budget_keeps_stream_writes_fast_without_retaining_history() {
    let f = Fixture::new();
    let store = f.store().with_replay_scope_cache_limit(1);
    let mut revision = open(&store, "bounded").await;
    let _scope = store.read_scope("bounded").unwrap();
    let before = store.authoritative_replay_count();
    for n in 0..50 {
        revision = store
            .append("bounded", revision, frame(1, 1, n))
            .await
            .unwrap()
            .revision;
    }
    assert_eq!(store.authoritative_replay_count(), before);
    assert_eq!(store.replay_scope_cache_stats().accounted_bytes, 0);
    assert_eq!(store.cache_stats().accounted_bytes, 0);
    assert_eq!(
        f.store().load("bounded").await.unwrap().unwrap().next_seq(),
        103
    );
}

#[tokio::test]
async fn scoped_concurrent_snapshots_do_not_thrash_a_smaller_resident_lru() {
    let f = Fixture::new();
    let store = JsonlSessionStore::new(&f.0)
        .unwrap()
        .with_cache_limits(80 * 1024, 16);
    let mut a = open(&store, "a").await;
    let mut b = open(&store, "b").await;
    let _a = store.read_scope("a").unwrap();
    let _b = store.read_scope("b").unwrap();
    a = store.append("a", a, frame(1, 1, 0)).await.unwrap().revision;
    b = store.append("b", b, frame(1, 1, 0)).await.unwrap().revision;
    // Creating a scope does not eagerly load history. Populate both reader
    // snapshots before counting repeated stream/observer work.
    store.load("a").await.unwrap();
    store.load("b").await.unwrap();
    assert_eq!(store.replay_scope_cache_stats().entries, 2);
    let before = store.authoritative_replay_count();
    for n in 1..20 {
        a = store.append("a", a, frame(1, 1, n)).await.unwrap().revision;
        b = store.append("b", b, frame(1, 1, n)).await.unwrap().revision;
        store.load("a").await.unwrap();
        store.load("b").await.unwrap();
    }
    assert_eq!(store.authoritative_replay_count(), before);
    assert_eq!(store.replay_scope_cache_stats().entries, 2);
    assert!(
        store.replay_scope_cache_stats().accounted_bytes
            <= store.replay_scope_cache_stats().max_bytes
    );
}

#[tokio::test]
async fn compressed_prefix_accepts_streams_and_bounded_history_without_losing_events() {
    let f = Fixture::new();
    let store = f.store();
    let revision = open(&store, "compressed").await;
    let revision = store
        .append(
            "compressed",
            revision,
            vec![
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("old"),
                    usage: None,
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap()
        .revision;
    assert!(
        store
            .compress_cold_session("compressed")
            .await
            .unwrap()
            .changed
    );
    let mut revision = store
        .append(
            "compressed",
            revision,
            vec![
                EventData::TurnStart { turn: 2 }.into(),
                EventData::StepStart { turn: 2, step: 1 }.into(),
            ],
        )
        .await
        .unwrap()
        .revision;
    let before = store.authoritative_replay_count();
    for n in 0..20 {
        revision = store
            .append("compressed", revision, frame(2, 1, n))
            .await
            .unwrap()
            .revision;
    }
    assert_eq!(store.authoritative_replay_count(), before);
    let fresh = f.store();
    let session = fresh.load("compressed").await.unwrap().unwrap();
    assert_eq!(session.next_seq(), 48);
    assert_eq!(session.revision(), revision);
    let page = fresh
        .history_window("compressed", session.next_seq(), None, 10)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.next_seq, session.next_seq());
    assert!(page
        .events
        .iter()
        .any(|e| matches!(e.data(), EventData::ModelReception { turn: 2, .. })));
}

#[tokio::test]
async fn symbolic_link_replacement_cannot_redirect_fast_stream_writes() {
    #[cfg(unix)]
    {
        let f = Fixture::new();
        let store = f.store();
        let revision = open(&store, "symlink").await;
        let path = f.0.join("symlink.jsonl");
        let target = f.0.join("outside");
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&target, &bytes).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(store
            .append("symlink", revision, frame(1, 1, 0))
            .await
            .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }
}
