use serde_json::json;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_session::{EventData, Session, SessionHeader, SessionRecoveryCheckpoint, Store};
use xharness_session_jsonl::JsonlSessionStore;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "xh-recovery-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn journal(&self) -> PathBuf {
        self.0.join("test.jsonl")
    }
    fn checkpoint(&self) -> PathBuf {
        self.0.join("test.recovery-checkpoint")
    }
    fn store(&self) -> JsonlSessionStore {
        JsonlSessionStore::new(&self.0).unwrap().for_runtime()
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn checkpoint(session: &Session) -> SessionRecoveryCheckpoint {
    SessionRecoveryCheckpoint {
        schema: "test.v1".into(),
        header: session.header().clone(),
        next_seq: session.next_seq(),
        revision: session.revision(),
        state: json!({"tiny":"state 🧪"}),
    }
}
async fn fixture() -> (Dir, JsonlSessionStore, SessionRecoveryCheckpoint) {
    let d = Dir::new();
    let s = d.store();
    let session = s.create(SessionHeader::new("test")).await.unwrap();
    let cp = checkpoint(&session);
    s.publish_recovery_checkpoint(cp.clone()).await.unwrap();
    (d, s, cp)
}
#[tokio::test]
async fn exact_source_survives_restart_and_tail_preserves_original_cursors() {
    let (d, s, cp) = fixture().await;
    let bytes = fs::read(d.journal()).unwrap();
    let reopened = d.store();
    let read = reopened
        .recovery_tail("test", "test.v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.checkpoint, cp);
    assert!(read.events.is_empty());
    assert_eq!(fs::read(d.journal()).unwrap(), bytes);
    let receipt = s
        .append(
            "test",
            cp.revision,
            vec![EventData::PlanMode { active: true }.into()],
        )
        .await
        .unwrap();
    let read = reopened
        .recovery_tail("test", "test.v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.checkpoint, cp);
    assert_eq!(read.events, receipt.events);
    assert_eq!(read.revision, receipt.revision);
    assert_eq!(read.next_seq, 1);
    assert_eq!(
        reopened.load("test").await.unwrap().unwrap().events(),
        read.events
    );
}
#[tokio::test]
async fn corrupt_missing_unknown_oversized_and_nonregular_sidecars_are_cache_misses() {
    let (d, s, _) = fixture().await;
    let original = fs::read(d.checkpoint()).unwrap();
    for payload in [
        b"{".to_vec(),
        b"null".to_vec(),
        b"[]".to_vec(),
        vec![b' '; 4 * 1024 * 1024 + 1],
    ] {
        fs::write(d.checkpoint(), payload).unwrap();
        assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
        assert!(s.load("test").await.unwrap().is_some());
    }
    fs::write(d.checkpoint(), &original).unwrap();
    assert!(s
        .recovery_tail("test", "different.schema")
        .await
        .unwrap()
        .is_none());
    let mut body: serde_json::Value = serde_json::from_slice(&original).unwrap();
    body["body"]["checkpoint"]["state"] = json!({"forged":true});
    fs::write(d.checkpoint(), serde_json::to_vec(&body).unwrap()).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    fs::remove_file(d.checkpoint()).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    fs::create_dir(d.checkpoint()).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    s.delete_session_data("test").await.unwrap(); // acceleration failure cannot prevent deletion
    assert!(!d.journal().exists());
}
#[tokio::test]
async fn stale_publication_cannot_rebind_an_old_projection_to_new_work() {
    let (d, s, cp) = fixture().await;
    let sidecar = fs::read(d.checkpoint()).unwrap();
    s.append(
        "test",
        cp.revision,
        vec![EventData::PlanMode { active: true }.into()],
    )
    .await
    .unwrap();
    let mut stale = cp.clone();
    stale.state = json!({"stale":"must not become new"});
    s.publish_recovery_checkpoint(stale).await.unwrap();
    assert_eq!(fs::read(d.checkpoint()).unwrap(), sidecar);
    let read = d
        .store()
        .recovery_tail("test", "test.v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.checkpoint, cp);
    assert_eq!(read.events.len(), 1);
}
#[tokio::test]
async fn a_modified_prefix_is_not_accepted_as_an_append() {
    let (d, s, cp) = fixture().await;
    s.append(
        "test",
        cp.revision,
        vec![EventData::PlanMode { active: true }.into()],
    )
    .await
    .unwrap();
    let bytes = fs::read(d.journal()).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let changed = text.replacen("created_at_ms", "created_at_mX", 1);
    assert_ne!(changed, text);
    fs::write(d.journal(), changed).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    assert!(s.load("test").await.is_err());
}
#[tokio::test]
async fn torn_tail_and_invalid_cas_or_sequence_require_full_replay() {
    let (d, s, cp) = fixture().await;
    let base = fs::read(d.journal()).unwrap();
    for suffix in [
        "{",
        "{\"record\":\"batch\",\"previous_revision\":99,\"revision\":100,\"events\":[]}\n",
    ] {
        fs::write(d.journal(), &base).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(d.journal())
            .unwrap()
            .write_all(suffix.as_bytes())
            .unwrap();
        assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    }
    fs::write(d.journal(), &base).unwrap();
    let receipt = s
        .append(
            "test",
            cp.revision,
            vec![EventData::PlanMode { active: true }.into()],
        )
        .await
        .unwrap();
    let mut batch: serde_json::Value = serde_json::from_slice(
        fs::read(d.journal())
            .unwrap()
            .split(|b| *b == b'\n')
            .nth(1)
            .unwrap(),
    )
    .unwrap();
    batch["events"][0]["seq"] = json!(receipt.events[0].seq + 1);
    let mut encoded = base;
    encoded.extend(serde_json::to_vec(&batch).unwrap());
    encoded.push(b'\n');
    fs::write(d.journal(), encoded).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    assert!(s.load("test").await.is_err());
}
#[tokio::test]
async fn checkpoint_size_budget_never_limits_the_journal_or_publishes_oversize_state() {
    let d = Dir::new();
    let s = d.store();
    let session = s.create(SessionHeader::new("test")).await.unwrap();
    let mut cp = checkpoint(&session);
    cp.state = json!({"big":"a".repeat(4*1024*1024)});
    s.publish_recovery_checkpoint(cp).await.unwrap();
    assert!(!d.checkpoint().exists());
    assert!(s.load("test").await.unwrap().is_some());
    let small = checkpoint(&session);
    s.publish_recovery_checkpoint(small).await.unwrap();
    let big = EventData::AgentPresetSelected {
        agent_preset: "a".repeat(8 * 1024 * 1024),
    };
    s.append("test", session.revision(), vec![big.into()])
        .await
        .unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    assert_eq!(s.load("test").await.unwrap().unwrap().next_seq(), 1);
}
#[tokio::test]
async fn checkpoint_publication_io_failure_never_changes_the_journal() {
    let d = Dir::new();
    let s = d.store();
    let session = s.create(SessionHeader::new("test")).await.unwrap();
    let bytes = fs::read(d.journal()).unwrap();
    fs::create_dir(d.checkpoint()).unwrap();
    assert!(s
        .publish_recovery_checkpoint(checkpoint(&session))
        .await
        .is_err());
    assert_eq!(fs::read(d.journal()).unwrap(), bytes);
    assert_eq!(s.load("test").await.unwrap().unwrap(), session);
}
#[cfg(unix)]
#[tokio::test]
async fn symlink_sidecar_cannot_supply_or_receive_checkpoint_data() {
    let d = Dir::new();
    let s = d.store();
    let session = s.create(SessionHeader::new("test")).await.unwrap();
    let target = d.0.join("outside");
    fs::write(&target, "protected").unwrap();
    std::os::unix::fs::symlink(&target, d.checkpoint()).unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    // Atomic replacement may replace the symlink itself, never its target.
    let _ = s.publish_recovery_checkpoint(checkpoint(&session)).await;
    assert_eq!(fs::read_to_string(target).unwrap(), "protected");
}

#[tokio::test]
async fn compression_invalidates_old_anchor_and_rebuilt_checkpoint_supports_v2_appends() {
    let (d, s, cp) = fixture().await;
    s.append(
        "test",
        cp.revision,
        vec![EventData::AgentPresetSelected {
            agent_preset: "x".repeat(32768),
        }
        .into()],
    )
    .await
    .unwrap();
    let session = s.load("test").await.unwrap().unwrap();
    s.publish_recovery_checkpoint(checkpoint(&session))
        .await
        .unwrap();
    let migrated = s.compress_cold_session("test").await.unwrap();
    assert!(migrated.changed);
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    let session = s.load("test").await.unwrap().unwrap();
    s.publish_recovery_checkpoint(checkpoint(&session))
        .await
        .unwrap();
    s.append(
        "test",
        session.revision(),
        vec![EventData::PlanMode { active: true }.into()],
    )
    .await
    .unwrap();
    let read = d
        .store()
        .recovery_tail("test", "test.v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.events.len(), 1);
    assert_eq!(read.next_seq, 2);
}

#[tokio::test]
async fn bounded_tail_rejects_event_flood_and_forged_gzip_expansion_before_decode() {
    let (d, s, cp) = fixture().await;
    s.append(
        "test",
        cp.revision,
        vec![EventData::PlanMode { active: true }.into(); 4097],
    )
    .await
    .unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
    let base = fs::read(d.journal()).unwrap();
    // Switch only the empty source header to v2 in an independent fresh store,
    // then bind a checkpoint after full validation of that exact header.
    let source = base.split(|b| *b == b'\n').next().unwrap();
    let mut header: serde_json::Value = serde_json::from_slice(source).unwrap();
    header["format_version"] = json!(2);
    let mut header = serde_json::to_vec(&header).unwrap();
    header.push(b'\n');
    fs::write(d.journal(), header).unwrap();
    let session = s.load("test").await.unwrap().unwrap();
    s.publish_recovery_checkpoint(checkpoint(&session))
        .await
        .unwrap();
    let record = json!({"record":"batch_gzip","uncompressed_len":9*1024*1024,"sha256":"0".repeat(64),"compressed_sha256":"0".repeat(64),"data":"invalid but never decoded"});
    let mut bytes = serde_json::to_vec(&record).unwrap();
    bytes.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(d.journal())
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    assert!(s.recovery_tail("test", "test.v1").await.unwrap().is_none());
}

#[tokio::test]
async fn concurrent_checkpoint_read_and_append_never_mix_cursors_or_lose_events() {
    let (d, s, cp) = fixture().await;
    let writer = s.clone();
    let task = tokio::spawn(async move {
        let mut rev = cp.revision;
        for i in 0..32 {
            rev = writer
                .append(
                    "test",
                    rev,
                    vec![EventData::PlanMode { active: i % 2 == 0 }.into()],
                )
                .await
                .unwrap()
                .revision;
            tokio::task::yield_now().await;
        }
    });
    let cold = d.store();
    for _ in 0..32 {
        let window = cold
            .recovery_tail("test", "test.v1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(window.next_seq, window.events.len() as u64);
        assert_eq!(window.revision.0, window.next_seq);
        for (i, e) in window.events.iter().enumerate() {
            assert_eq!(e.seq, i as u64);
            assert_eq!(e.revision.0, i as u64 + 1);
        }
        tokio::task::yield_now().await;
    }
    task.await.unwrap();
    let window = cold
        .recovery_tail("test", "test.v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(window.events.len(), 32);
    assert_eq!(
        cold.load("test").await.unwrap().unwrap().events(),
        window.events
    );
}
