//! Diagnostic metadata is deliberately a closed schema: never accept arbitrary
//! log text, paths, prompts, configuration, tool arguments or environment values.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const SEGMENT_BYTES: u64 = 1024 * 1024;
pub const SEGMENTS: usize = 4;
pub const DEEP_SECONDS: u64 = 15 * 60;
/// Distinct protocol marker, not a wall-clock deadline.
pub const PERSISTENT_DEEP: u64 = u64::MAX;

/// Explicit user preferences only; never infer consent from an old lease file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeepPreferences {
    pub persistent: bool,
    pub full_memory: bool,
    pub heap_check: bool,
}
impl DeepPreferences {
    pub fn load(path: &Path) -> io::Result<Self> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(1025).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 {
            return Err(io::Error::other("diagnostic preferences exceed budget"));
        }
        let value: Self = serde_json::from_slice(&bytes)?;
        if !value.persistent && (value.full_memory || value.heap_check) {
            return Err(io::Error::other(
                "diagnostic options require persistent consent",
            ));
        }
        Ok(value)
    }
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if !self.persistent && (self.full_memory || self.heap_check) {
            return Err(io::Error::other(
                "diagnostic options require persistent consent",
            ));
        }
        let temporary = path.with_extension("json.tmp");
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(self)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temporary, path)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    HeapValidation,
    Activity,
    DesktopStart,
    HostStart,
    HostReady,
    HostExit,
    HostStderr,
    HostIoError,
    Sample,
    DeepEnabled,
    DeepDisabled,
    DeepExpired,
    CaptureStarted,
    CaptureFinished,
    CaptureFailed,
    DesktopExit,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Model,
    Tool,
    Session,
    Network,
    Host,
    Other,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Resources {
    pub resident_bytes: Option<u64>,
    pub private_bytes: Option<u64>,
    pub handles: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    pub version: Option<[u32; 3]>,
    pub activity: Option<Activity>,
    pub sequence: Option<u64>,
    pub time_ms: u64,
    pub phase: Phase,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub expected: Option<bool>,
    pub byte_count: Option<u64>,
    pub resources: Option<Resources>,
}

impl Record {
    pub fn new(phase: Phase) -> Self {
        Self {
            version: None,
            activity: None,
            sequence: None,
            time_ms: now_ms(),
            phase,
            pid: None,
            exit_code: None,
            signal: None,
            expected: None,
            byte_count: None,
            resources: None,
        }
    }
}

/// One writer per directory. Callers serialize access, and surface I/O failure
/// without turning a diagnostic failure into a product crash.
pub struct Recorder {
    root: PathBuf,
    limit: u64,
}

impl Recorder {
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            limit: SEGMENT_BYTES,
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn append(&mut self, record: &Record) -> io::Result<()> {
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        if line.len() as u64 > self.limit {
            return Err(io::Error::other("diagnostic record exceeds segment budget"));
        }
        let current = self.root.join("events-0.jsonl");
        let len = match fs::metadata(&current) {
            Ok(meta) => meta.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if len.saturating_add(line.len() as u64) > self.limit {
            remove_if_present(&self.root.join(format!("events-{}.jsonl", SEGMENTS - 1)))?;
            for index in (0..SEGMENTS - 1).rev() {
                let source = self.root.join(format!("events-{index}.jsonl"));
                match fs::rename(
                    source,
                    self.root.join(format!("events-{}.jsonl", index + 1)),
                ) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(current)?;
        file.write_all(&line)?;
        file.flush()
    }
    /// A marker is persisted before work starts, not inferred from an exit code.
    pub fn begin_run(&mut self) -> io::Result<bool> {
        let interrupted = self.root.join("active-run").try_exists()?;
        if interrupted {
            self.mark_incident()?;
        }
        let mut marker = fs::File::create(self.root.join("active-run"))?;
        marker.write_all(b"1")?;
        marker.sync_all()?;
        self.append(&Record::new(Phase::DesktopStart))?;
        Ok(interrupted || self.has_incident()?)
    }
    pub fn mark_incident(&self) -> io::Result<()> {
        let mut file = fs::File::create(self.root.join("unacknowledged-exit"))?;
        file.write_all(b"1")?;
        file.sync_all()
    }
    pub fn has_incident(&self) -> io::Result<bool> {
        self.root.join("unacknowledged-exit").try_exists()
    }
    pub fn acknowledge(&self) -> io::Result<()> {
        remove_if_present(&self.root.join("unacknowledged-exit"))
    }
    pub fn finish_run(&mut self) -> io::Result<()> {
        self.append(&Record::new(Phase::DesktopExit))?;
        remove_if_present(&self.root.join("active-run"))
    }
    /// Parse back into the closed type so even a locally contaminated log cannot
    /// silently contribute arbitrary fields to an exported report. Partial last
    /// lines are counted, not copied. Never recursively archive this directory.
    pub fn snapshot(&self) -> io::Result<Snapshot> {
        let mut records = Vec::new();
        let mut rejected_lines = 0;
        for index in (0..SEGMENTS).rev() {
            let path = self.root.join(format!("events-{index}.jsonl"));
            let file = match fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let mut bytes = Vec::new();
            file.take(self.limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > self.limit {
                return Err(io::Error::other("diagnostic segment exceeds budget"));
            }
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                match serde_json::from_slice::<Record>(line) {
                    Ok(record) => records.push(record),
                    Err(_) => rejected_lines += 1,
                }
            }
        }
        Ok(Snapshot {
            format: "xharness-diagnostics-v1",
            records,
            rejected_lines,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub format: &'static str,
    pub records: Vec<Record>,
    pub rejected_lines: u64,
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Timed consent remains monotonic. Persistent consent is explicit and must be
/// restored by the caller from validated user preferences, never by default.
#[derive(Default)]
pub struct DeepLease {
    deadline: Option<Instant>,
    persistent: bool,
}
impl DeepLease {
    pub fn enable(&mut self, consent: bool) -> io::Result<()> {
        if !consent {
            return Err(io::Error::other(
                "explicit diagnostic privacy consent required",
            ));
        }
        self.deadline = Some(Instant::now() + Duration::from_secs(DEEP_SECONDS));
        self.persistent = false;
        Ok(())
    }
    pub fn enable_persistent(&mut self, consent: bool) -> io::Result<()> {
        self.enable(consent)?;
        self.deadline = None;
        self.persistent = true;
        Ok(())
    }
    pub fn persistent(&self) -> bool {
        self.persistent
    }
    pub fn disable(&mut self) {
        self.deadline = None;
        self.persistent = false;
    }
    pub fn remaining_seconds(&self) -> u64 {
        self.deadline
            .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            .map(|duration| duration.as_secs() + 1)
            .unwrap_or(0)
    }
    pub fn active(&self) -> bool {
        self.persistent || self.remaining_seconds() > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "xh-diag-{}-{}-{}",
                std::process::id(),
                now_ms(),
                NONCE.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn interrupted_run_survives_restart_and_clean_exit() {
        let dir = Temp::new();
        let mut log = Recorder::open(&dir.0).unwrap();
        assert!(!log.begin_run().unwrap());
        assert!(log.begin_run().unwrap());
        log.finish_run().unwrap();
        assert!(log.begin_run().unwrap()); // do not hide an earlier crash
        log.acknowledge().unwrap();
        log.finish_run().unwrap();
        assert!(!log.begin_run().unwrap());
    }
    #[test]
    fn bounded_rotation_preserves_recent_events() {
        let dir = Temp::new();
        let mut log = Recorder::open(&dir.0).unwrap();
        log.limit = 600;
        for pid in 0..100 {
            let mut record = Record::new(Phase::Sample);
            record.pid = Some(pid);
            log.append(&record).unwrap();
        }
        let files: Vec<_> = fs::read_dir(&dir.0).unwrap().map(Result::unwrap).collect();
        assert!(files.len() <= SEGMENTS);
        assert!(files
            .iter()
            .all(|entry| entry.metadata().unwrap().len() <= 600));
        assert_eq!(
            log.snapshot().unwrap().records.last().unwrap().pid,
            Some(99)
        );
    }
    #[test]
    fn export_rejects_extra_fields_and_does_not_collect_sensitive_files() {
        let dir = Temp::new();
        let mut log = Recorder::open(&dir.0).unwrap();
        log.append(&Record::new(Phase::HostReady)).unwrap();
        let mut bad = serde_json::to_value(Record::new(Phase::HostExit)).unwrap();
        bad["apiKey"] = serde_json::json!("DO-NOT-EXPORT");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(dir.0.join("events-0.jsonl"))
            .unwrap();
        writeln!(file, "{bad}").unwrap();
        write!(file, "{{partial").unwrap();
        fs::write(dir.0.join("private.dmp"), b"SECRET").unwrap();
        let snapshot = log.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.rejected_lines, 2);
        let report = serde_json::to_string(&snapshot).unwrap();
        assert!(!report.contains("DO-NOT-EXPORT"));
        assert!(!report.contains("SECRET"));
    }
    #[test]
    fn storage_failure_is_not_reported_as_saved() {
        let dir = Temp::new();
        let mut log = Recorder::open(&dir.0).unwrap();
        fs::create_dir(dir.0.join("events-0.jsonl")).unwrap();
        assert!(log.append(&Record::new(Phase::Sample)).is_err());
        assert!(log.snapshot().is_err());
    }
    #[test]
    fn deep_mode_requires_consent_expires_and_is_not_restored() {
        let mut lease = DeepLease::default();
        assert!(!lease.active());
        assert!(lease.enable(false).is_err());
        lease.enable(true).unwrap();
        assert!(lease.active());
        assert!(!DeepLease::default().active());
        lease.deadline = Some(Instant::now() - Duration::from_secs(1));
        assert!(!lease.active());
        lease.enable(true).unwrap();
        lease.disable();
        assert!(!lease.active());
    }
    #[test]
    fn persistent_consent_survives_reload_and_explicit_disable() {
        let dir = Temp::new();
        fs::create_dir_all(&dir.0).unwrap();
        let path = dir.0.join("diagnostics.json");
        assert_eq!(
            DeepPreferences::load(&path).unwrap(),
            DeepPreferences::default()
        );
        let selected = DeepPreferences {
            persistent: true,
            full_memory: true,
            heap_check: false,
        };
        selected.save(&path).unwrap();
        assert_eq!(DeepPreferences::load(&path).unwrap(), selected);
        let mut lease = DeepLease::default();
        assert!(lease.enable_persistent(false).is_err());
        assert!(!lease.active());
        lease.enable_persistent(true).unwrap();
        lease.deadline = Some(Instant::now() - Duration::from_secs(1));
        assert!(lease.active());
        assert!(lease.persistent());
        lease.disable();
        DeepPreferences::default().save(&path).unwrap();
        assert!(!lease.active());
        assert!(!DeepPreferences::load(&path).unwrap().persistent);
        lease.enable_persistent(true).unwrap();
        lease.enable(true).unwrap();
        assert!(!lease.persistent());
    }
    #[test]
    fn preferences_reject_corruption_and_surface_write_failure() {
        let dir = Temp::new();
        fs::create_dir_all(&dir.0).unwrap();
        let path = dir.0.join("diagnostics.json");
        for bytes in [
            b"{partial".as_slice(),
            br#"{"persistent":true,"fullMemory":true,"heapCheck":false,"extra":1}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(DeepPreferences::load(&path).is_err());
        }
        fs::write(&path, vec![b' '; 1025]).unwrap();
        assert!(DeepPreferences::load(&path).is_err());
        let blocked = dir.0.join("directory.json");
        fs::create_dir(&blocked).unwrap();
        assert!(DeepPreferences::default().save(&blocked).is_err());
    }
}
