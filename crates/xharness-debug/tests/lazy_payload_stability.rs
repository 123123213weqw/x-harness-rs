//! Bounded stress and ownership checks for lazy full-trace payloads.
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use xharness_debug::{
    DebugBlobRef, DebugError, DebugEvent, DebugRecord, DebugRecorder, DebugScope, DebugSink,
    DebugTraceConfig, DebugTraceMode, REDACTED_VALUE,
};

static NONCE: AtomicU64 = AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-lazy-stability-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Capture {
    bytes: Vec<u8>,
    dropped: Arc<AtomicU64>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }
}

#[tokio::test]
async fn disabled_payload_captures_are_released_on_every_call() {
    let recorder = DebugRecorder::disabled();
    let dropped = Arc::new(AtomicU64::new(0));
    let evaluated = Arc::new(AtomicU64::new(0));
    for _ in 0..2048 {
        let capture = Capture {
            bytes: vec![42; 16 * 1024],
            dropped: dropped.clone(),
        };
        let evaluated = evaluated.clone();
        recorder
            .record_lossy_with(
                "core",
                "context.prepared",
                DebugScope::default(),
                move || {
                    evaluated.fetch_add(1, Ordering::Relaxed);
                    json!({"bytes": capture.bytes.len()})
                },
            )
            .await;
    }
    recorder.flush().await.unwrap();
    assert_eq!(evaluated.load(Ordering::Relaxed), 0);
    assert_eq!(dropped.load(Ordering::Relaxed), 2048);
    assert_eq!(Arc::strong_count(&dropped), 1);
    assert_eq!(Arc::strong_count(&evaluated), 1);
}

struct PendingSink {
    entered: Notify,
    dropped: Arc<AtomicU64>,
}
#[async_trait]
impl DebugSink for PendingSink {
    fn enabled(&self) -> bool {
        true
    }
    async fn record(&self, event: DebugEvent) -> Result<(), DebugError> {
        let capture = Capture {
            bytes: vec![42; 128 * 1024],
            dropped: self.dropped.clone(),
        };
        self.entered.notify_one();
        std::future::pending::<()>().await;
        std::hint::black_box((event, capture));
        Ok(())
    }
    async fn flush(&self) -> Result<(), DebugError> {
        Ok(())
    }
}

#[tokio::test]
async fn cancelling_pending_sink_releases_recorder_and_in_flight_ownership() {
    let dropped = Arc::new(AtomicU64::new(0));
    let sink = Arc::new(PendingSink {
        entered: Notify::new(),
        dropped: dropped.clone(),
    });
    let recorder = Arc::new(DebugRecorder::new(sink.clone()));
    let weak = Arc::downgrade(&recorder);
    let task = tokio::spawn(async move {
        recorder
            .record_lossy_with(
                "core",
                "context.prepared",
                DebugScope::default(),
                || json!({"content": "x".repeat(128 * 1024)}),
            )
            .await;
    });
    tokio::time::timeout(Duration::from_secs(5), sink.entered.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(weak.upgrade().is_none());
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
    assert_eq!(Arc::strong_count(&sink), 1);
}

fn body(offset: usize) -> String {
    if offset.is_multiple_of(8) {
        "λ😀x\n".repeat(16 * 1024)
    } else {
        "small\t\\\"\0".repeat(4)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_full_trace_preserves_redaction_order_and_large_blob_integrity() {
    let root = TempDir::new();
    let mut config = DebugTraceConfig::new(DebugTraceMode::Full, root.0.join("trace"));
    config.max_inline_bytes = 1024;
    config.channel_capacity = 1;
    let (recorder, info) = DebugRecorder::open(config).await.unwrap();
    let info = info.unwrap();
    let evaluated = Arc::new(AtomicU64::new(0));
    let operation = async {
        let mut tasks = Vec::new();
        for producer in 0..16 {
            let recorder = recorder.clone();
            let evaluated = evaluated.clone();
            tasks.push(tokio::spawn(async move {
                for offset in 0..32 {
                    recorder.record_lossy_with("core", "context.prepared", DebugScope::default().with_session(format!("worker-{producer}")), || {
                        evaluated.fetch_add(1, Ordering::Relaxed);
                        json!({"producer":producer,"offset":offset,"content":body(offset),"authorization":"Bearer fixture-private","nested":{"api_key":"fixture-private","input_tokens":7}})
                    }).await;
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        recorder.flush().await.unwrap();
    };
    tokio::time::timeout(Duration::from_secs(60), operation)
        .await
        .expect("bounded full-trace stress must finish without deadlock");
    assert_eq!(evaluated.load(Ordering::Relaxed), 512);
    let lines = tokio::fs::read_to_string(&info.events_path).await.unwrap();
    assert!(!lines.contains("fixture-private"));
    let records: Vec<DebugRecord> = lines
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 512);
    let mut offsets = [0_u64; 16];
    let mut blobs = HashSet::new();
    for (index, record) in records.into_iter().enumerate() {
        assert_eq!(record.seq, u64::try_from(index).unwrap());
        let payload = if let Some(reference) = record.payload.get("$debugBlob") {
            let reference: DebugBlobRef = serde_json::from_value(reference.clone()).unwrap();
            let raw = tokio::fs::read(info.directory.join(&reference.relative_path))
                .await
                .unwrap();
            assert_eq!(u64::try_from(raw.len()).unwrap(), reference.bytes);
            assert_eq!(format!("{:x}", Sha256::digest(&raw)), reference.sha256);
            assert!(!String::from_utf8_lossy(&raw).contains("fixture-private"));
            blobs.insert(reference.sha256);
            serde_json::from_slice::<Value>(&raw).unwrap()
        } else {
            record.payload
        };
        let producer = usize::try_from(payload["producer"].as_u64().unwrap()).unwrap();
        let offset = payload["offset"].as_u64().unwrap();
        assert_eq!(offset, offsets[producer]);
        offsets[producer] += 1;
        assert_eq!(record.scope.session_id, Some(format!("worker-{producer}")));
        assert_eq!(payload["content"], body(usize::try_from(offset).unwrap()));
        assert_eq!(payload["authorization"], REDACTED_VALUE);
        assert_eq!(payload["nested"]["api_key"], REDACTED_VALUE);
        assert_eq!(payload["nested"]["input_tokens"], 7);
    }
    assert_eq!(offsets, [32; 16]);
    assert_eq!(blobs.len(), 64);
}

/// A large closure must not enlarge every enclosing async state machine, even
/// if the caller keeps the returned disabled future without polling it.
#[test]
fn disabled_future_does_not_retain_payload_captures_or_their_layout() {
    struct LargeCapture {
        bytes: [u8; 64 * 1024],
        dropped: Arc<AtomicU64>,
    }
    impl Drop for LargeCapture {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    let recorder = DebugRecorder::disabled();
    let dropped = Arc::new(AtomicU64::new(0));
    let capture = LargeCapture {
        bytes: [42; 64 * 1024],
        dropped: dropped.clone(),
    };
    let future =
        recorder.record_lossy_with("core", "large-capture", DebugScope::default(), move || {
            let value = std::hint::black_box(capture);
            json!({"bytes": value.bytes.len()})
        });
    println!(
        "XH_DISABLED_TRACE_FUTURE_BYTES {}",
        std::mem::size_of_val(&future)
    );
    assert_eq!(
        dropped.load(Ordering::Relaxed),
        1,
        "disabled captures must be released at call time"
    );
    assert!(
        std::mem::size_of_val(&future) <= 64,
        "trace closure inflated the enclosing future"
    );
    drop(future);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
}
