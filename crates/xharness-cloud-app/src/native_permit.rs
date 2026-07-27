//! VM-local execution authority. This journal is NOT a controller task store,
//! a model credential store, a Goal journal, or proof that the VM is quiet.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use xharness_cloud::*;

const APPLICATION: i64 = 0x58485031;
const SCHEMA: &str = "xharness-native-permit/v1";
const LIMIT: usize = 64 * 1024;

fn valid_permit_revision(record: &PermitRecord) -> bool {
    match record.permit {
        ExecutionPermit::Prepared => record.revision == Counter(1),
        ExecutionPermit::Active => record.revision == Counter(2),
        ExecutionPermit::Sealed => matches!(record.revision.0, 2 | 3),
    }
}

fn storage() -> CloudError {
    CloudError::new(
        ErrorCode::StorageFailure,
        "native permit journal is unavailable or invalid",
    )
}
fn invalid() -> CloudError {
    CloudError::new(ErrorCode::InvalidRequest, "invalid native permit operation")
}
fn encode<T: Serialize>(value: &T) -> CloudResult<String> {
    let data = serde_json::to_string(value).map_err(|_| storage())?;
    if data.len() > LIMIT {
        return Err(storage());
    }
    Ok(data)
}
fn decode<T: DeserializeOwned>(data: &str) -> CloudResult<T> {
    if data.len() > LIMIT {
        return Err(storage());
    }
    serde_json::from_str(data).map_err(|_| storage())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePermitBinding {
    pub binding: Binding,
    /// Fixed canonical VM paths, not client paths or credentials.
    pub workspace: String,
    pub state_dir: String,
}
impl NativePermitBinding {
    pub fn validate(&self) -> CloudResult<()> {
        if self.binding.scope.execution_epoch.0 == 0
            || self.binding.host_build_ref.version.as_str().len() != 64
            || self
                .binding
                .host_build_ref
                .version
                .as_str()
                .bytes()
                .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
            || !Path::new(&self.workspace).is_absolute()
            || !Path::new(&self.state_dir).is_absolute()
            || self.workspace == self.state_dir
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePermitSnapshot {
    pub schema: String,
    pub specification: NativePermitBinding,
    pub permit: PermitRecord,
    pub launch_generation: Counter,
}
impl NativePermitSnapshot {
    fn validate(&self) -> CloudResult<()> {
        self.specification.validate()?;
        if !valid_permit_revision(&self.permit)
            || self.schema != SCHEMA
            || self.permit.revision.0 == 0
            || self.permit.scope != self.specification.binding.scope
        {
            return Err(storage());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePermitCommand {
    pub operation_id: Id,
    pub scope: BindingScope,
    pub expected_revision: Counter,
    pub to: ExecutionPermit,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeShutdownOutcome {
    /// Observed sealed authority, not a replacement for the controller CAS.
    pub sealed: bool,
    pub runtime_graceful: bool,
    pub forced_workers: usize,
    pub cleanup_errors: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLaunchPhase {
    Starting,
    PreparedReady,
    Ready,
    Stopped,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLaunchReceipt {
    pub scope: BindingScope,
    pub generation: Counter,
    pub permit_revision_at_start: Counter,
    pub phase: NativeLaunchPhase,
    pub shutdown: Option<NativeShutdownOutcome>,
}

/// Each mutation is a short SQLite transaction; control commands can seal a
/// running Host. The Host's existing state-directory ownership lease still
/// fences concurrent native processes. No whole-history rewrite per launch.
pub struct NativePermitJournal {
    connection: Mutex<Connection>,
    path: PathBuf,
    identity: JournalIdentity,
}
#[derive(PartialEq, Eq)]
struct JournalIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
fn journal_identity(path: &Path) -> CloudResult<JournalIdentity> {
    let metadata = fs::symlink_metadata(path).map_err(|_| storage())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(storage());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(JournalIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(JournalIdentity {})
    }
}
impl NativePermitJournal {
    fn check_identity(&self) -> CloudResult<()> {
        if journal_identity(&self.path)? != self.identity {
            return Err(storage());
        }
        let parent = self.path.parent().ok_or_else(storage)?;
        let metadata = fs::symlink_metadata(parent).map_err(|_| storage())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(storage());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(storage());
            }
        }
        for suffix in ["-wal", "-shm"] {
            match fs::symlink_metadata(parent.join(format!("native-permit.sqlite3{suffix}"))) {
                Ok(m) if m.is_file() && !m.file_type().is_symlink() => {}
                Ok(_) => return Err(storage()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(storage()),
            }
        }
        Ok(())
    }
    pub fn open(directory: &Path) -> CloudResult<Self> {
        if !directory.exists() {
            fs::create_dir_all(directory).map_err(|_| storage())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| storage())?;
            }
        }
        let meta = fs::symlink_metadata(directory).map_err(|_| storage())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(storage());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(storage());
            }
        }
        let path = directory.join("native-permit.sqlite3");
        for suffix in ["", "-wal", "-shm"] {
            match fs::symlink_metadata(directory.join(format!("native-permit.sqlite3{suffix}"))) {
                Ok(m) if m.is_file() && !m.file_type().is_symlink() => {}
                Ok(_) => return Err(storage()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(storage()),
            }
        }
        let exists = path.exists();
        if exists && fs::metadata(&path).map_err(|_| storage())?.len() == 0 {
            return Err(storage());
        }
        let connection = Connection::open(&path).map_err(|_| storage())?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|_| storage())?;
        if exists {
            let app: i64 = connection
                .pragma_query_value(None, "application_id", |r| r.get(0))
                .map_err(|_| storage())?;
            let version: i64 = connection
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|_| storage())?;
            let check: String = connection
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|_| storage())?;
            if app != APPLICATION || !matches!(version, 1 | 2) || check != "ok" {
                return Err(storage());
            }
        }
        let journal: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(|_| storage())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| storage())?;
        let sync: i64 = connection
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(|_| storage())?;
        if journal.to_lowercase() != "wal" || sync != 2 {
            return Err(storage());
        }
        if !exists {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE authority(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
                CREATE TABLE commands(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE launches(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                PRAGMA application_id=1481134129; PRAGMA user_version=1; COMMIT;").map_err(|_| storage())?;
            #[cfg(unix)]
            std::fs::File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| storage())?;
        }
        // Additive v1 -> v2 migration; old authority/launches are never reset.
        connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS bootstrap(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); PRAGMA user_version=2; COMMIT;").map_err(|_| storage())?;
        let identity = journal_identity(&path)?;
        Ok(Self {
            connection: Mutex::new(connection),
            path,
            identity,
        })
    }
    pub fn initialize(
        &self,
        specification: NativePermitBinding,
    ) -> CloudResult<NativePermitSnapshot> {
        self.check_identity()?;
        specification.validate()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let prior: Option<String> = tx
            .query_row("SELECT payload FROM authority WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|_| storage())?;
        if let Some(data) = prior {
            let _: NativePermitSnapshot = decode(&data)?;
            let current = load(&tx)?;
            if current.specification != specification {
                return Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "native binding already has a different specification",
                ));
            }
            return Ok(current);
        }
        // A missing authority row is not a fresh journal when any previous
        // operation/launch remains. Do not reset a damaged sealed binding.
        let residual: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM commands) OR EXISTS(SELECT 1 FROM launches) OR EXISTS(SELECT 1 FROM bootstrap)",
                [],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if residual {
            return Err(storage());
        }
        let snapshot = NativePermitSnapshot {
            schema: SCHEMA.into(),
            permit: PermitRecord {
                scope: specification.binding.scope.clone(),
                revision: Counter(1),
                permit: ExecutionPermit::Prepared,
            },
            specification,
            launch_generation: Counter(0),
        };
        tx.execute("INSERT INTO authority VALUES(1,?1)", [encode(&snapshot)?])
            .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(snapshot)
    }
    pub fn snapshot(&self) -> CloudResult<NativePermitSnapshot> {
        self.check_identity()?;
        let c = self.connection.lock().map_err(|_| storage())?;
        load(&c)
    }
    pub fn transition(&self, command: &NativePermitCommand) -> CloudResult<PermitRecord> {
        self.check_identity()?;
        let fingerprint = format!("{:x}", Sha256::digest(encode(command)?.as_bytes()));
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let mut current = load(&tx)?;
        if command.scope != current.permit.scope {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "native binding mismatch",
            ));
        }
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT fingerprint,payload FROM commands WHERE id=?1",
                [command.operation_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| storage())?;
        if let Some((old, data)) = prior {
            if old != fingerprint {
                return Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "native operation changed under a stable identity",
                ));
            }
            let receipt: PermitRecord = decode(&data)?;
            let revision_matches_operation = receipt.revision == command.expected_revision
                || command.expected_revision.0.checked_add(1) == Some(receipt.revision.0);
            if !valid_permit_revision(&receipt)
                || command.expected_revision.0 == 0
                || !revision_matches_operation
                || receipt.scope != command.scope
                || receipt.permit != command.to
                || receipt.revision > current.permit.revision
            {
                return Err(storage());
            }
            return Ok(receipt); // Historical acknowledgement, never current authority.
        }
        if command.to == ExecutionPermit::Active
            && current.permit.permit == ExecutionPermit::Prepared
        {
            if let Some(bootstrap) = load_bootstrap(&tx)? {
                if !bootstrap.applied
                    || current.launch_generation == Counter(0)
                    || load_launch(&tx, current.launch_generation)?.phase
                        != NativeLaunchPhase::PreparedReady
                {
                    return Err(CloudError::new(
                        ErrorCode::RuntimeUnavailable,
                        "native bootstrap is not prepared-ready",
                    ));
                }
            }
        }
        current.permit =
            current
                .permit
                .transition(&command.scope, command.expected_revision, command.to)?;
        tx.execute(
            "UPDATE authority SET payload=?1 WHERE id=1",
            [encode(&current)?],
        )
        .map_err(|_| storage())?;
        tx.execute(
            "INSERT INTO commands VALUES(?1,?2,?3)",
            params![
                command.operation_id.as_str(),
                fingerprint,
                encode(&current.permit)?
            ],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(current.permit)
    }
    /// Invoke only while holding the original Host state ownership lease.
    pub fn claim_launch(&self) -> CloudResult<NativeLaunchReceipt> {
        self.claim_launch_in(ExecutionPermit::Active)
    }
    /// Only the trusted original Host holding the state-directory lease calls
    /// this, after reserving a bootstrap identity. It grants NO execution.
    pub fn claim_prepared_launch(&self) -> CloudResult<NativeLaunchReceipt> {
        if self.bootstrap()?.is_none() {
            return Err(invalid());
        }
        self.claim_launch_in(ExecutionPermit::Prepared)
    }
    fn claim_launch_in(&self, expected: ExecutionPermit) -> CloudResult<NativeLaunchReceipt> {
        self.check_identity()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let mut current = load(&tx)?;
        if current.permit.permit != expected {
            return Err(CloudError::new(
                ErrorCode::RuntimeUnavailable,
                "native execution permit is not active",
            ));
        }
        if current.launch_generation.0 > 0 {
            let previous = load_launch(&tx, current.launch_generation)?;
            if previous.phase != NativeLaunchPhase::Stopped
                || !previous
                    .shutdown
                    .as_ref()
                    .is_some_and(|s| s.runtime_graceful)
            {
                return Err(CloudError::new(ErrorCode::RuntimeUnavailable,"prior native launch has no graceful stop proof; external reconciliation is required"));
            }
        }
        current.launch_generation = current.launch_generation.next()?;
        let receipt = NativeLaunchReceipt {
            scope: current.permit.scope.clone(),
            generation: current.launch_generation,
            permit_revision_at_start: current.permit.revision,
            phase: NativeLaunchPhase::Starting,
            shutdown: None,
        };
        tx.execute(
            "UPDATE authority SET payload=?1 WHERE id=1",
            [encode(&current)?],
        )
        .map_err(|_| storage())?;
        tx.execute(
            "INSERT INTO launches VALUES(?1,?2)",
            params![receipt.generation.0.to_string(), encode(&receipt)?],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(receipt)
    }
    pub fn launch(&self, generation: Counter) -> CloudResult<NativeLaunchReceipt> {
        self.check_identity()?;
        let c = self.connection.lock().map_err(|_| storage())?;
        let current = load(&c)?;
        let receipt = load_launch(&c, generation)?;
        if receipt.scope != current.permit.scope
            || generation > current.launch_generation
            || receipt.permit_revision_at_start > current.permit.revision
        {
            return Err(storage());
        }
        Ok(receipt)
    }
    pub fn record_prepared_ready(&self, generation: Counter) -> CloudResult<NativeLaunchReceipt> {
        self.check_identity()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let head = load(&tx)?;
        let mut launch = load_launch(&tx, generation)?;
        let bootstrap = load_bootstrap(&tx)?.ok_or_else(invalid)?;
        if head.permit.permit != ExecutionPermit::Prepared
            || generation != head.launch_generation
            || launch.scope != head.permit.scope
            || !bootstrap.applied
            || !matches!(
                launch.phase,
                NativeLaunchPhase::Starting | NativeLaunchPhase::PreparedReady
            )
        {
            return Err(invalid());
        }
        launch.phase = NativeLaunchPhase::PreparedReady;
        tx.execute(
            "UPDATE launches SET payload=?1 WHERE id=?2",
            params![encode(&launch)?, generation.0.to_string()],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(launch)
    }
    pub fn record_ready(&self, generation: Counter) -> CloudResult<NativeLaunchReceipt> {
        self.update_launch(generation, None)
    }
    pub fn record_shutdown(
        &self,
        generation: Counter,
        outcome: NativeShutdownOutcome,
    ) -> CloudResult<NativeLaunchReceipt> {
        self.update_launch(generation, Some(outcome))
    }
    fn update_launch(
        &self,
        generation: Counter,
        outcome: Option<NativeShutdownOutcome>,
    ) -> CloudResult<NativeLaunchReceipt> {
        self.check_identity()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let current = load(&tx)?;
        let mut receipt = load_launch(&tx, generation)?;
        if receipt.scope != current.permit.scope || generation != current.launch_generation {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "native launch generation is stale",
            ));
        }
        if let Some(outcome) = outcome {
            if outcome.sealed != (current.permit.permit == ExecutionPermit::Sealed)
                || (outcome.runtime_graceful
                    && (outcome.forced_workers != 0 || outcome.cleanup_errors != 0))
            {
                return Err(invalid());
            }
            if receipt.phase == NativeLaunchPhase::Stopped {
                if receipt.shutdown.as_ref() != Some(&outcome) {
                    return Err(CloudError::new(
                        ErrorCode::IdempotencyConflict,
                        "native shutdown receipt is immutable",
                    ));
                }
                return Ok(receipt);
            }
            receipt.phase = NativeLaunchPhase::Stopped;
            receipt.shutdown = Some(outcome);
        } else {
            if current.permit.permit != ExecutionPermit::Active
                || receipt.phase == NativeLaunchPhase::Stopped
            {
                return Err(CloudError::new(
                    ErrorCode::RuntimeUnavailable,
                    "native Host cannot become ready after seal or stop",
                ));
            }
            receipt.phase = NativeLaunchPhase::Ready;
        }
        tx.execute(
            "UPDATE launches SET payload=?1 WHERE id=?2",
            params![encode(&receipt)?, generation.0.to_string()],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(receipt)
    }
}
fn load(c: &Connection) -> CloudResult<NativePermitSnapshot> {
    let data: String = c
        .query_row("SELECT payload FROM authority WHERE id=1", [], |r| r.get(0))
        .map_err(|_| storage())?;
    let current: NativePermitSnapshot = decode(&data)?;
    current.validate()?;
    if current.launch_generation.0 > 0 {
        let head = load_launch(c, current.launch_generation)?;
        if head.scope != current.permit.scope
            || head.permit_revision_at_start > current.permit.revision
        {
            return Err(storage());
        }
    }
    Ok(current)
}
fn load_launch(c: &Connection, generation: Counter) -> CloudResult<NativeLaunchReceipt> {
    let data: String = c
        .query_row(
            "SELECT payload FROM launches WHERE id=?1",
            [generation.0.to_string()],
            |r| r.get(0),
        )
        .map_err(|_| storage())?;
    let row: NativeLaunchReceipt = decode(&data)?;
    if row.generation != generation
        || generation.0 == 0
        || !matches!(row.permit_revision_at_start.0, 1 | 2)
        || (row.phase == NativeLaunchPhase::PreparedReady
            && row.permit_revision_at_start != Counter(1))
        || (row.phase == NativeLaunchPhase::Stopped) != row.shutdown.is_some()
        || row
            .shutdown
            .as_ref()
            .is_some_and(|s| s.runtime_graceful && (s.forced_workers != 0 || s.cleanup_errors != 0))
    {
        return Err(storage());
    }
    if row.permit_revision_at_start == Counter(1) {
        let data: String = c
            .query_row("SELECT payload FROM bootstrap WHERE id=1", [], |r| r.get(0))
            .map_err(|_| storage())?;
        let bootstrap: NativeBootstrapRecord = decode(&data)?;
        if bootstrap.intent.scope != row.scope
            || (matches!(
                row.phase,
                NativeLaunchPhase::PreparedReady | NativeLaunchPhase::Ready
            ) && !bootstrap.applied)
        {
            return Err(storage());
        }
    }
    Ok(row)
}

/// Immutable, secret-free bootstrap reservation; the Goal itself belongs to
/// the original Session Store, not this native authority journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBootstrapIntent {
    pub operation_id: Id,
    pub scope: BindingScope,
    pub root_session_id: Id,
    pub fingerprint: String,
    pub task_spec_fingerprint: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBootstrapRecord {
    pub intent: NativeBootstrapIntent,
    pub applied: bool,
}
fn load_bootstrap(c: &Connection) -> CloudResult<Option<NativeBootstrapRecord>> {
    let data: Option<String> = c
        .query_row("SELECT payload FROM bootstrap WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(|_| storage())?;
    let value: Option<NativeBootstrapRecord> = data.as_deref().map(decode).transpose()?;
    if let Some(row) = &value {
        let head = load(c)?;
        if row.intent.scope != head.permit.scope
            || row.intent.root_session_id != head.specification.binding.root_session_id
            || row.intent.task_spec_fingerprint.len() != 64
            || !row
                .intent
                .task_spec_fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || row.intent.fingerprint.len() != 64
            || !row
                .intent
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(storage());
        }
    }
    Ok(value)
}
impl NativePermitJournal {
    /// Query exact activation acknowledgement without replaying a command.
    /// The caller separately checks CURRENT permit/generation; historical acks
    /// never reopen sealed authority.
    pub fn activation_receipt(&self, operation_id: &Id) -> CloudResult<PermitRecord> {
        self.check_identity()?;
        let c = self.connection.lock().map_err(|_| storage())?;
        let head = load(&c)?;
        let (fingerprint, data): (String, String) = c
            .query_row(
                "SELECT fingerprint,payload FROM commands WHERE id=?1",
                [operation_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| storage())?;
        let expected = NativePermitCommand {
            operation_id: operation_id.clone(),
            scope: head.permit.scope.clone(),
            expected_revision: Counter(1),
            to: ExecutionPermit::Active,
        };
        if fingerprint != format!("{:x}", Sha256::digest(encode(&expected)?.as_bytes())) {
            return Err(storage());
        }
        let row: PermitRecord = decode(&data)?;
        if row.scope != head.permit.scope
            || row.permit != ExecutionPermit::Active
            || row.revision != Counter(2)
        {
            return Err(storage());
        }
        Ok(row)
    }
    pub fn bootstrap(&self) -> CloudResult<Option<NativeBootstrapRecord>> {
        self.check_identity()?;
        {
            let c = self.connection.lock().map_err(|_| storage())?;
            load_bootstrap(&c)
        }
    }
    /// Caller verifies a NEW root has no existing journal before reservation.
    /// After reservation, only the exactly matching empty header may recover.
    pub fn reserve_bootstrap(
        &self,
        intent: NativeBootstrapIntent,
    ) -> CloudResult<NativeBootstrapRecord> {
        self.check_identity()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        if let Some(old) = load_bootstrap(&tx)? {
            if old.intent != intent {
                return Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "native bootstrap identity is immutable",
                ));
            }
            return Ok(old);
        }
        let head = load(&tx)?;
        if head.permit.permit != ExecutionPermit::Prepared
            || head.launch_generation != Counter(0)
            || intent.scope != head.permit.scope
            || intent.root_session_id != head.specification.binding.root_session_id
            || intent.task_spec_fingerprint.len() != 64
            || !intent
                .task_spec_fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || intent.fingerprint.len() != 64
            || !intent
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(invalid());
        }
        let row = NativeBootstrapRecord {
            intent,
            applied: false,
        };
        tx.execute("INSERT INTO bootstrap VALUES(1,?1)", [encode(&row)?])
            .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(row)
    }
    pub fn record_bootstrap_applied(
        &self,
        intent: &NativeBootstrapIntent,
    ) -> CloudResult<NativeBootstrapRecord> {
        self.check_identity()?;
        let mut c = self.connection.lock().map_err(|_| storage())?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let mut row = load_bootstrap(&tx)?.ok_or_else(invalid)?;
        if row.intent != *intent {
            return Err(invalid());
        }
        if row.applied {
            return Ok(row);
        }
        if load(&tx)?.permit.permit != ExecutionPermit::Prepared {
            return Err(invalid());
        }
        row.applied = true;
        tx.execute(
            "UPDATE bootstrap SET payload=?1 WHERE id=1",
            [encode(&row)?],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(row)
    }
}
