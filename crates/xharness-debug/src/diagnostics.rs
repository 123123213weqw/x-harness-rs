use crate::DebugEvent;
use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc,
    },
    time::{Duration, Instant},
};
use xharness_diagnostics::{now_ms, Activity, Phase, Record, Recorder, DEEP_SECONDS};

/// The producer never performs I/O and never waits for the writer. Queue
/// overflow is counted, not allowed to slow a tool/model stream.
pub(super) struct Observer {
    sender: SyncSender<Record>,
    dropped: Arc<AtomicU64>,
}
impl Observer {
    pub fn start(root: PathBuf, control: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Record>(256);
        let dropped = Arc::new(AtomicU64::new(0));
        let missed = dropped.clone();
        std::thread::spawn(move || {
            let Ok(mut recorder) = Recorder::open(&root) else {
                let _ = fs::write(control.with_extension("failed"), b"1");
                return;
            };
            let mut lease = ControlLease::default();
            let mut next_control = Instant::now();
            let mut next_summary = Instant::now();
            let mut count = 0u64;
            let mut last = Record::new(Phase::Activity);
            let mut deep_records = 0;
            #[cfg(windows)]
            let mut next_heap_check = Instant::now();
            loop {
                if Instant::now() >= next_control {
                    // Fixed-size control file, no arbitrary config deserialization.
                    let value = fs::File::open(&control)
                        .ok()
                        .and_then(|file| {
                            let mut value = String::new();
                            file.take(32).read_to_string(&mut value).ok()?;
                            value.trim().parse::<u64>().ok()
                        })
                        .unwrap_or(0);
                    if lease.update(value) {
                        deep_records = 0;
                    }
                    next_control = Instant::now() + Duration::from_secs(2);
                    #[cfg(windows)]
                    if lease.active() && Instant::now() >= next_heap_check {
                        let heap_consent = fs::File::open(control.with_extension("heap"))
                            .ok()
                            .and_then(|file| {
                                let mut value = String::new();
                                file.take(32).read_to_string(&mut value).ok()?;
                                value.parse::<u64>().ok()
                            });
                        if heap_consent == Some(lease.last) {
                            let mut record = Record::new(Phase::HeapValidation);
                            record.expected = Some(xharness_win32::validate_process_heap());
                            let _ = recorder.append(&record);
                        }
                        next_heap_check = Instant::now() + Duration::from_secs(60);
                    }
                }
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(record) => {
                        count += 1;
                        if lease.active() && deep_records < 4096 {
                            // At most 4096 fixed-schema records per consent lease;
                            // no raw payload, stderr, prompt or tool command.
                            if recorder.append(&record).is_err() {
                                let _ = fs::write(root.join("write-failed"), b"1");
                            }
                            deep_records += 1;
                        }
                        last = record;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if Instant::now() >= next_summary {
                    last.time_ms = now_ms();
                    last.sequence = Some(count);
                    last.byte_count = Some(missed.swap(0, Ordering::Relaxed)); // dropped metadata event count
                    if recorder.append(&last).is_err() {
                        let _ = fs::write(root.join("write-failed"), b"1");
                    }
                    count = 0;
                    next_summary = Instant::now() + Duration::from_secs(10);
                }
            }
            last.sequence = Some(count);
            let _ = recorder.append(&last);
        });
        Self { sender, dropped }
    }
    pub fn record(&self, event: &DebugEvent) {
        let mut record = Record::new(Phase::Activity);
        record.pid = Some(std::process::id());
        record.activity = Some(classify(&event.layer, &event.event));
        record.sequence = event.scope.step;
        if self.sender.try_send(record).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn classify(layer: &str, event: &str) -> Activity {
    if event.starts_with("tool.") {
        Activity::Tool
    } else if layer.starts_with("provider")
        || event.starts_with("model.")
        || event.starts_with("provider.")
    {
        Activity::Model
    } else if layer == "server" {
        Activity::Network
    } else if layer == "host" {
        Activity::Host
    } else if layer == "session" || layer == "core" {
        Activity::Session
    } else {
        Activity::Other
    }
}

#[derive(Default)]
struct ControlLease {
    last: u64,
    deadline: Option<Instant>,
}
impl ControlLease {
    fn update(&mut self, value: u64) -> bool {
        if value == self.last {
            return false;
        }
        self.last = value;
        let remaining = value.saturating_sub(now_ms()).min(DEEP_SECONDS * 1000);
        self.deadline = (remaining > 0).then(|| Instant::now() + Duration::from_millis(remaining));
        true
    }
    fn active(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() < deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_control_file_cannot_extend_an_expired_monotonic_lease() {
        let mut lease = ControlLease::default();
        let value = now_ms() + 10_000;
        assert!(lease.update(value));
        assert!(lease.active());
        lease.deadline = Some(Instant::now() - Duration::from_secs(1));
        assert!(!lease.update(value));
        assert!(!lease.active());
        lease.update(0);
        assert!(!lease.active());
    }
    #[test]
    fn classification_never_copies_arbitrary_text() {
        let serialized = serde_json::to_string(&classify("secret-key", "private command")).unwrap();
        assert_eq!(serialized, "\"other\"");
    }
}
