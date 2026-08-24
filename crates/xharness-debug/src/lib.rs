//! Opt-in full-fidelity diagnostic traces for XHarness.
//!
//! A debug trace is a disposable sidecar, not an authoritative session log.
//! The default recorder is a zero-I/O [`NoopDebugSink`]. Full mode serializes
//! every submitted event through one writer, assigns a monotonic sequence,
//! stores large redacted payloads as content-addressed blobs and exposes an
//! explicit durability [`DebugSink::flush`] boundary.

use std::{
    fmt,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncWriteExt, BufWriter},
    sync::{mpsc, oneshot, Mutex},
};

pub const DEBUG_TRACE_FORMAT: &str = "xharness-debug-trace";
pub const DEBUG_TRACE_VERSION: u32 = 1;
pub const DEFAULT_MAX_INLINE_BYTES: usize = 64 * 1024;
pub const DEFAULT_CHANNEL_CAPACITY: usize = 1_024;
pub const REDACTED_VALUE: &str = "[REDACTED]";

static TRACE_NONCE: AtomicU64 = AtomicU64::new(0);

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DebugTraceMode {
    #[default]
    Off,
    Full,
}

impl FromStr for DebugTraceMode {
    type Err = DebugError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "off" => Ok(Self::Off),
            "full" => Ok(Self::Full),
            _ => Err(DebugError::invalid_config(format!(
                "unsupported debug trace mode {value:?}; use off or full"
            ))),
        }
    }
}

impl fmt::Display for DebugTraceMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Off => "off",
            Self::Full => "full",
        })
    }
}

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugTraceConfig {
    pub mode: DebugTraceMode,
    pub root_dir: PathBuf,
    pub max_inline_bytes: usize,
    pub channel_capacity: usize,
}

impl DebugTraceConfig {
    pub fn new(mode: DebugTraceMode, root_dir: impl Into<PathBuf>) -> Self {
        Self {
            mode,
            root_dir: root_dir.into(),
            max_inline_bytes: DEFAULT_MAX_INLINE_BYTES,
            channel_capacity: DEFAULT_CHANNEL_CAPACITY,
        }
    }

    pub fn validate(&self) -> Result<(), DebugError> {
        if self.mode == DebugTraceMode::Full && self.root_dir.as_os_str().is_empty() {
            return Err(DebugError::invalid_config(
                "full debug trace requires a non-empty root directory",
            ));
        }
        if self.max_inline_bytes == 0 {
            return Err(DebugError::invalid_config(
                "max_inline_bytes must be greater than zero",
            ));
        }
        if self.channel_capacity == 0 {
            return Err(DebugError::invalid_config(
                "channel_capacity must be greater than zero",
            ));
        }
        Ok(())
    }
}

impl Default for DebugTraceConfig {
    fn default() -> Self {
        Self::new(DebugTraceMode::Off, ".xharness-debug")
    }
}

/// Optional correlation coordinates. They remain absent for host-wide events.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
}

impl DebugScope {
    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub fn with_run(mut self, run_id: impl Into<String>) -> Self {
        self.run_id = Some(run_id.into());
        self
    }

    pub const fn with_turn_step(mut self, turn: u64, step: u64) -> Self {
        self.turn = Some(turn);
        self.step = Some(step);
        self
    }
}

/// Unsequenced event submitted by one subsystem.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEvent {
    #[serde(default)]
    pub scope: DebugScope,
    pub layer: String,
    pub event: String,
    pub payload: Value,
}

impl DebugEvent {
    pub fn new(layer: impl Into<String>, event: impl Into<String>, payload: Value) -> Self {
        Self {
            scope: DebugScope::default(),
            layer: layer.into(),
            event: event.into(),
            payload,
        }
    }

    pub fn with_scope(mut self, scope: DebugScope) -> Self {
        self.scope = scope;
        self
    }

    fn validate(&self) -> Result<(), DebugError> {
        if self.layer.trim().is_empty() {
            return Err(DebugError::invalid_event("layer must not be empty"));
        }
        if self.event.trim().is_empty() {
            return Err(DebugError::invalid_event("event must not be empty"));
        }
        Ok(())
    }
}

/// Content-addressed payload stored outside the JSONL line.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugBlobRef {
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub relative_path: String,
}

/// On-disk event envelope. Sequence is assigned by the single writer, not by
/// producers, so every trace has one total order.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRecord {
    pub version: u32,
    pub seq: u64,
    pub timestamp_unix_micros: u64,
    pub scope: DebugScope,
    pub layer: String,
    pub event: String,
    pub payload: Value,
}

#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugTraceInfo {
    pub trace_id: String,
    pub directory: PathBuf,
    pub events_path: PathBuf,
}

#[derive(Clone, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DebugError {
    #[error("invalid debug trace configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid debug event: {0}")]
    InvalidEvent(String),
    #[error("debug trace writer is closed")]
    Closed,
    #[error("debug trace writer failed: {0}")]
    Writer(String),
    #[error("debug trace I/O failed: {0}")]
    Io(#[from] Arc<std::io::Error>),
    #[error("debug trace serialization failed: {0}")]
    Serialize(#[from] Arc<serde_json::Error>),
}

impl DebugError {
    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::InvalidConfig(message.into())
    }

    pub fn invalid_event(message: impl Into<String>) -> Self {
        Self::InvalidEvent(message.into())
    }
}

impl From<std::io::Error> for DebugError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(Arc::new(error))
    }
}

impl From<serde_json::Error> for DebugError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialize(Arc::new(error))
    }
}

/// Redaction runs before both inline serialization and blob hashing.
pub trait DebugRedactor: Send + Sync + 'static {
    fn redact(&self, value: &mut Value);
}

/// Recursive key-based credential redactor. Token accounting keys such as
/// `input_tokens` remain visible; authentication tokens and secret-bearing
/// environment/header keys do not.
#[derive(Clone, Copy, Debug, Default)]
pub struct SecretRedactor;

impl DebugRedactor for SecretRedactor {
    fn redact(&self, value: &mut Value) {
        redact_value(value);
    }
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_sensitive_key(key) {
                    *value = Value::String(REDACTED_VALUE.to_owned());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_value(value);
            }
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "token"
            | "credential"
            | "credentials"
            | "privatekey"
    ) || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.ends_with("apikey")
        || normalized.ends_with("accesstoken")
        || normalized.ends_with("refreshtoken")
}

#[async_trait]
pub trait DebugSink: Send + Sync + 'static {
    fn enabled(&self) -> bool;
    async fn record(&self, event: DebugEvent) -> Result<(), DebugError>;
    async fn flush(&self) -> Result<(), DebugError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopDebugSink;

#[async_trait]
impl DebugSink for NoopDebugSink {
    fn enabled(&self) -> bool {
        false
    }

    async fn record(&self, _event: DebugEvent) -> Result<(), DebugError> {
        Ok(())
    }

    async fn flush(&self) -> Result<(), DebugError> {
        Ok(())
    }
}

/// Deterministic in-memory sink for embedders and cross-layer tests.
#[derive(Debug, Default)]
pub struct MemoryDebugSink {
    events: Mutex<Vec<DebugEvent>>,
}

impl MemoryDebugSink {
    pub async fn events(&self) -> Vec<DebugEvent> {
        self.events.lock().await.clone()
    }
}

#[async_trait]
impl DebugSink for MemoryDebugSink {
    fn enabled(&self) -> bool {
        true
    }

    async fn record(&self, event: DebugEvent) -> Result<(), DebugError> {
        event.validate()?;
        self.events.lock().await.push(event);
        Ok(())
    }

    async fn flush(&self) -> Result<(), DebugError> {
        Ok(())
    }
}

/// Cloneable dependency injected into Host/Core/Provider/Tool layers.
#[derive(Clone)]
pub struct DebugRecorder {
    sink: Arc<dyn DebugSink>,
    deferred_error: Arc<StdMutex<Option<DebugError>>>,
}

impl DebugRecorder {
    pub fn disabled() -> Self {
        Self {
            sink: Arc::new(NoopDebugSink),
            deferred_error: Arc::new(StdMutex::new(None)),
        }
    }

    pub fn new(sink: Arc<dyn DebugSink>) -> Self {
        Self {
            sink,
            deferred_error: Arc::new(StdMutex::new(None)),
        }
    }

    pub async fn open(
        config: DebugTraceConfig,
    ) -> Result<(Self, Option<DebugTraceInfo>), DebugError> {
        Self::open_with_redactor(config, Arc::new(SecretRedactor)).await
    }

    pub async fn open_with_redactor(
        config: DebugTraceConfig,
        redactor: Arc<dyn DebugRedactor>,
    ) -> Result<(Self, Option<DebugTraceInfo>), DebugError> {
        config.validate()?;
        if config.mode == DebugTraceMode::Off {
            return Ok((Self::disabled(), None));
        }
        let (sink, info) = JsonlDebugSink::create(config, redactor).await?;
        Ok((Self::new(Arc::new(sink)), Some(info)))
    }

    pub fn enabled(&self) -> bool {
        self.sink.enabled()
    }

    pub async fn record(&self, event: DebugEvent) -> Result<(), DebugError> {
        self.sink.record(event).await
    }

    /// Record a diagnostic event without allowing trace I/O to change the
    /// product operation being observed. Runtime layers use this at execution
    /// boundaries: full tracing is best-effort, while the Host still performs
    /// an explicit [`Self::flush`] at shutdown to surface writer failures.
    pub async fn record_lossy(&self, event: DebugEvent) {
        if self.enabled() {
            if let Err(error) = self.sink.record(event).await {
                let mut deferred = self
                    .deferred_error
                    .lock()
                    .expect("debug deferred error mutex poisoned");
                if deferred.is_none() {
                    *deferred = Some(error);
                }
            }
        }
    }

    pub async fn flush(&self) -> Result<(), DebugError> {
        self.sink.flush().await?;
        if let Some(error) = self
            .deferred_error
            .lock()
            .expect("debug deferred error mutex poisoned")
            .clone()
        {
            return Err(error);
        }
        Ok(())
    }
}

impl Default for DebugRecorder {
    fn default() -> Self {
        Self::disabled()
    }
}

impl fmt::Debug for DebugRecorder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DebugRecorder")
            .field("enabled", &self.enabled())
            .finish()
    }
}

enum WriterCommand {
    Record {
        event: DebugEvent,
        ack: oneshot::Sender<Result<(), String>>,
    },
    Flush {
        ack: oneshot::Sender<Result<(), String>>,
    },
}

struct JsonlDebugSink {
    sender: mpsc::Sender<WriterCommand>,
}

impl JsonlDebugSink {
    async fn create(
        config: DebugTraceConfig,
        redactor: Arc<dyn DebugRedactor>,
    ) -> Result<(Self, DebugTraceInfo), DebugError> {
        create_private_dir_all(&config.root_dir).await?;
        let trace_id = next_trace_id();
        let trace_dir = config.root_dir.join(&trace_id);
        fs::create_dir(&trace_dir).await?;
        set_private_dir(&trace_dir).await?;
        let blobs_dir = trace_dir.join("blobs");
        fs::create_dir(&blobs_dir).await?;
        set_private_dir(&blobs_dir).await?;

        let started_unix_micros = unix_micros();
        let manifest = DebugManifest {
            format: DEBUG_TRACE_FORMAT.to_owned(),
            version: DEBUG_TRACE_VERSION,
            trace_id: trace_id.clone(),
            mode: config.mode,
            started_unix_micros,
            process_id: std::process::id(),
            max_inline_bytes: config.max_inline_bytes,
        };
        write_manifest(&trace_dir.join("manifest.json"), &manifest).await?;

        let events_path = trace_dir.join("events.jsonl");
        let events_file = create_private_file(&events_path).await?;
        let (sender, receiver) = mpsc::channel(config.channel_capacity);
        let state = WriterState {
            writer: BufWriter::new(events_file),
            blobs_dir,
            redactor,
            max_inline_bytes: config.max_inline_bytes,
            next_seq: 0,
        };
        tokio::spawn(writer_loop(receiver, state));
        Ok((
            Self { sender },
            DebugTraceInfo {
                trace_id,
                directory: trace_dir,
                events_path,
            },
        ))
    }

    async fn request(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> WriterCommand,
    ) -> Result<(), DebugError> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.sender
            .send(command(ack_tx))
            .await
            .map_err(|_| DebugError::Closed)?;
        ack_rx
            .await
            .map_err(|_| DebugError::Closed)?
            .map_err(DebugError::Writer)
    }
}

#[async_trait]
impl DebugSink for JsonlDebugSink {
    fn enabled(&self) -> bool {
        true
    }

    async fn record(&self, event: DebugEvent) -> Result<(), DebugError> {
        event.validate()?;
        self.request(|ack| WriterCommand::Record { event, ack })
            .await
    }

    async fn flush(&self) -> Result<(), DebugError> {
        self.request(|ack| WriterCommand::Flush { ack }).await
    }
}

struct WriterState {
    writer: BufWriter<File>,
    blobs_dir: PathBuf,
    redactor: Arc<dyn DebugRedactor>,
    max_inline_bytes: usize,
    next_seq: u64,
}

impl WriterState {
    async fn record(&mut self, mut event: DebugEvent) -> Result<(), DebugError> {
        self.redactor.redact(&mut event.payload);
        let payload_bytes = serde_json::to_vec(&event.payload)?;
        let payload = if payload_bytes.len() > self.max_inline_bytes {
            let reference = self.write_blob(&payload_bytes).await?;
            json!({"$debugBlob": reference})
        } else {
            event.payload
        };
        let record = DebugRecord {
            version: DEBUG_TRACE_VERSION,
            seq: self.next_seq,
            timestamp_unix_micros: unix_micros(),
            scope: event.scope,
            layer: event.layer,
            event: event.event,
            payload,
        };
        let mut line = serde_json::to_vec(&record)?;
        line.push(b'\n');
        self.writer.write_all(&line).await?;
        // Full debug mode favors crash usefulness over throughput. Make every
        // acknowledged event visible to another process and resilient to a
        // Host SIGKILL; explicit flush still adds the sync_data durability
        // boundary without fsyncing every token.
        self.writer.flush().await?;
        self.next_seq = self.next_seq.saturating_add(1);
        Ok(())
    }

    async fn write_blob(&self, bytes: &[u8]) -> Result<DebugBlobRef, DebugError> {
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let filename = format!("{sha256}.json");
        let final_path = self.blobs_dir.join(&filename);
        match fs::metadata(&final_path).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let temporary_path = self
                    .blobs_dir
                    .join(format!(".{sha256}-{}.tmp", self.next_seq));
                let mut file = create_private_file(&temporary_path).await?;
                file.write_all(bytes).await?;
                file.flush().await?;
                file.sync_data().await?;
                fs::rename(&temporary_path, &final_path).await?;
            }
            Err(error) => return Err(error.into()),
        }
        Ok(DebugBlobRef {
            sha256,
            bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            media_type: "application/json".to_owned(),
            relative_path: format!("blobs/{filename}"),
        })
    }

    async fn flush(&mut self) -> Result<(), DebugError> {
        self.writer.flush().await?;
        self.writer.get_ref().sync_data().await?;
        Ok(())
    }
}

async fn writer_loop(mut receiver: mpsc::Receiver<WriterCommand>, mut state: WriterState) {
    while let Some(command) = receiver.recv().await {
        match command {
            WriterCommand::Record { event, ack } => {
                let result = state.record(event).await.map_err(|error| error.to_string());
                let _ = ack.send(result);
            }
            WriterCommand::Flush { ack } => {
                let result = state.flush().await.map_err(|error| error.to_string());
                let _ = ack.send(result);
            }
        }
    }
    let _ = state.flush().await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugManifest {
    format: String,
    version: u32,
    trace_id: String,
    mode: DebugTraceMode,
    started_unix_micros: u64,
    process_id: u32,
    max_inline_bytes: usize,
}

async fn write_manifest(path: &Path, manifest: &DebugManifest) -> Result<(), DebugError> {
    let mut bytes = serde_json::to_vec_pretty(manifest)?;
    bytes.push(b'\n');
    let mut file = create_private_file(path).await?;
    file.write_all(&bytes).await?;
    file.flush().await?;
    file.sync_data().await?;
    Ok(())
}

async fn create_private_dir_all(path: &Path) -> Result<(), DebugError> {
    fs::create_dir_all(path).await?;
    set_private_dir(path).await
}

async fn create_private_file(path: &Path) -> Result<File, DebugError> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .await?;
    set_private_file(path).await?;
    Ok(file)
}

#[cfg(unix)]
async fn set_private_dir(path: &Path) -> Result<(), DebugError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn set_private_dir(_path: &Path) -> Result<(), DebugError> {
    Ok(())
}

#[cfg(unix)]
async fn set_private_file(path: &Path) -> Result<(), DebugError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn set_private_file(_path: &Path) -> Result<(), DebugError> {
    Ok(())
}

fn next_trace_id() -> String {
    format!(
        "trace-{}-{}-{}",
        unix_micros(),
        std::process::id(),
        TRACE_NONCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn unix_micros() -> u64 {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    u64::try_from(micros).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_NONCE: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xharness-debug-{name}-{}-{}",
                std::process::id(),
                TEST_NONCE.fetch_add(1, Ordering::Relaxed)
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

    #[test]
    fn redactor_hides_credentials_but_keeps_token_accounting() {
        let mut value = json!({
            "Authorization": "Bearer abc",
            "nested": {
                "OPENAI_API_KEY": "secret",
                "input_tokens": 123,
                "token_safety_margin": 1024
            },
            "items": [{"password": "pw"}]
        });
        SecretRedactor.redact(&mut value);
        assert_eq!(value["Authorization"], REDACTED_VALUE);
        assert_eq!(value["nested"]["OPENAI_API_KEY"], REDACTED_VALUE);
        assert_eq!(value["nested"]["input_tokens"], 123);
        assert_eq!(value["nested"]["token_safety_margin"], 1024);
        assert_eq!(value["items"][0]["password"], REDACTED_VALUE);
    }

    #[tokio::test]
    async fn off_mode_is_a_real_zero_io_recorder() {
        let root = TempDir::new("off");
        let expected = root.0.join("unused");
        let (recorder, info) =
            DebugRecorder::open(DebugTraceConfig::new(DebugTraceMode::Off, &expected))
                .await
                .unwrap();
        assert!(!recorder.enabled());
        assert!(info.is_none());
        recorder
            .record(DebugEvent::new("host", "ignored", json!({"x": 1})))
            .await
            .unwrap();
        recorder.flush().await.unwrap();
        assert!(!expected.exists());
    }

    #[tokio::test]
    async fn full_mode_orders_redacts_spills_and_flushes() {
        let root = TempDir::new("full");
        let mut config = DebugTraceConfig::new(DebugTraceMode::Full, root.0.join("traces"));
        config.max_inline_bytes = 128;
        config.channel_capacity = 2;
        let (recorder, info) = DebugRecorder::open(config).await.unwrap();
        let info = info.unwrap();
        recorder
            .record(DebugEvent::new(
                "provider",
                "request",
                json!({"authorization":"Bearer no", "input_tokens":7}),
            ))
            .await
            .unwrap();
        recorder
            .record(
                DebugEvent::new(
                    "tool",
                    "completed",
                    json!({"output":"x".repeat(256), "api_key":"do-not-store"}),
                )
                .with_scope(DebugScope::default().with_session("session-1")),
            )
            .await
            .unwrap();
        recorder.flush().await.unwrap();

        let lines = fs::read_to_string(&info.events_path).await.unwrap();
        let records: Vec<DebugRecord> = lines
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].seq, 0);
        assert_eq!(records[1].seq, 1);
        assert_eq!(records[0].payload["authorization"], REDACTED_VALUE);
        assert_eq!(records[0].payload["input_tokens"], 7);
        let reference: DebugBlobRef =
            serde_json::from_value(records[1].payload["$debugBlob"].clone()).unwrap();
        let blob = fs::read(info.directory.join(reference.relative_path))
            .await
            .unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&blob)), reference.sha256);
        let blob: Value = serde_json::from_slice(&blob).unwrap();
        assert_eq!(blob["api_key"], REDACTED_VALUE);
        assert_eq!(blob["output"].as_str().unwrap().len(), 256);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&info.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&info.events_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
