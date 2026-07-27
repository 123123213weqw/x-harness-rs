use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    ops::Deref,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use xharness_cloud::*;

const SCHEMA: i64 = 1;
const APPLICATION: i64 = 0x58484331;
const MAX_ROW_BYTES: usize = 2 * 1024 * 1024;

fn storage() -> CloudError {
    CloudError::new(
        ErrorCode::StorageFailure,
        "cloud control persistence failed; reopen and reconcile",
    )
}
fn encode<T: Serialize>(value: &T) -> CloudResult<String> {
    let data = serde_json::to_string(value).map_err(|_| storage())?;
    if data.len() > MAX_ROW_BYTES {
        return Err(storage());
    }
    Ok(data)
}
fn decode<T: DeserializeOwned>(data: &str) -> CloudResult<T> {
    if data.len() > MAX_ROW_BYTES {
        return Err(storage());
    }
    serde_json::from_str(data).map_err(|_| storage())
}
fn counter(connection: &Connection, key: &str) -> CloudResult<Counter> {
    let value: String = connection
        .query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .map_err(|_| storage())?;
    decode(&value)
}

/// The sink owns a process-lifetime writer lock. Cloning the state store cannot
/// accidentally release it. It does not claim distributed/VM execution fencing.
struct SqliteSink {
    connection: Mutex<Connection>,
    _writer: File,
}
impl CloudCommitSink for SqliteSink {
    fn commit(&self, change: &CloudMutation) -> CloudResult<()> {
        let mut connection = self.connection.lock().map_err(|_| storage())?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        if counter(&tx, "generation")? != change.expected_generation
            || change.generation != change.expected_generation.next()?
        {
            return Err(storage());
        }
        for row in &change.environments {
            tx.execute("INSERT INTO environments(id,version,payload) VALUES(?1,?2,?3) ON CONFLICT(id,version) DO UPDATE SET payload=excluded.payload",
                params![row.environment_ref.id.as_str(), row.environment_ref.version.as_str(), encode(row)?]).map_err(|_| storage())?;
        }
        for row in &change.tasks {
            tx.execute("INSERT INTO tasks(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                params![row.task_id.as_str(), encode(row)?]).map_err(|_| storage())?;
        }
        for row in &change.receipts {
            tx.execute("INSERT INTO receipts(owner,request_id,payload) VALUES(?1,?2,?3) ON CONFLICT(owner,request_id) DO UPDATE SET payload=excluded.payload",
                params![row.owner_id.as_str(), row.receipt.request_id.as_str(), encode(row)?]).map_err(|_| storage())?;
        }
        for row in &change.intents {
            tx.execute("INSERT INTO intents(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                params![row.operation_id.as_str(), encode(row)?]).map_err(|_| storage())?;
        }
        tx.execute(
            "UPDATE metadata SET value=?1 WHERE key='generation'",
            [encode(&change.generation)?],
        )
        .map_err(|_| storage())?;
        if let Some(next_id) = change.next_id {
            if next_id <= counter(&tx, "next_id")? {
                return Err(storage());
            }
            tx.execute(
                "UPDATE metadata SET value=?1 WHERE key='next_id'",
                [encode(&next_id)?],
            )
            .map_err(|_| storage())?;
        }
        tx.commit().map_err(|_| storage())
    }
}

pub struct SqliteCloudTaskStore {
    inner: Arc<MemoryCloudTaskStore>,
    sink: Arc<SqliteSink>,
}
impl Deref for SqliteCloudTaskStore {
    type Target = MemoryCloudTaskStore;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
impl SqliteCloudTaskStore {
    /// Keep the store in a private, local filesystem directory, not a VM volume
    /// or network share. Existing empty/corrupt/schema-mismatched DBs fail closed.
    pub fn open(directory: &Path, limits: AdmissionLimits) -> CloudResult<Self> {
        if !directory.exists() {
            fs::create_dir_all(directory).map_err(|_| storage())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| storage())?;
            }
        }
        let metadata = fs::symlink_metadata(directory).map_err(|_| storage())?;
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
        let writer_path = directory.join("control.writer.lock");
        reject_symlink(&writer_path)?;
        let writer = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&writer_path)
            .map_err(|_| storage())?;
        writer.try_lock_exclusive().map_err(|_| {
            CloudError::new(
                ErrorCode::EnvironmentBusy,
                "cloud controller already has a writer",
            )
        })?;
        let path = directory.join("control.sqlite3");
        for suffix in ["", "-wal", "-shm"] {
            reject_symlink(&directory.join(format!("control.sqlite3{suffix}")))?;
        }
        let exists = path.exists();
        if exists && fs::metadata(&path).map_err(|_| storage())?.len() == 0 {
            return Err(storage());
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | if exists {
                OpenFlags::empty()
            } else {
                OpenFlags::SQLITE_OPEN_CREATE
            };
        let connection = Connection::open_with_flags(&path, flags).map_err(|_| storage())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| storage())?;
        if exists {
            let application: i64 = connection
                .pragma_query_value(None, "application_id", |r| r.get(0))
                .map_err(|_| storage())?;
            let schema: i64 = connection
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|_| storage())?;
            if application != APPLICATION || schema != SCHEMA {
                return Err(storage());
            }
            let check: String = connection
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|_| storage())?;
            if check != "ok" {
                return Err(storage());
            }
        }
        let journal: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(|_| storage())?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| storage())?;
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(|_| storage())?;
        if journal.to_lowercase() != "wal" || synchronous != 2 {
            return Err(storage());
        }
        if !exists {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE environments(id TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
                CREATE TABLE tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE receipts(owner TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,request_id));
                CREATE TABLE intents(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                INSERT INTO metadata VALUES('generation','\"0\"'),('next_id','\"0\"');
                PRAGMA application_id=1481130801;
                PRAGMA user_version=1;
                COMMIT;").map_err(|_| storage())?;
            #[cfg(unix)]
            File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| storage())?;
        }
        let snapshot = load(&connection)?;
        let sink = Arc::new(SqliteSink {
            connection: Mutex::new(connection),
            _writer: writer,
        });
        let inner = Arc::new(MemoryCloudTaskStore::restore(
            snapshot,
            limits,
            sink.clone(),
        )?);
        Ok(Self { inner, sink })
    }
    pub fn state(&self) -> Arc<MemoryCloudTaskStore> {
        Arc::clone(&self.inner)
    }

    /// Persist an immutable native/VM receipt before reducing facts. If reduction
    /// is interrupted, reopening re-applies this same receipt without redispatch.
    pub fn save_observation(&self, observation: &crate::StageObservation) -> CloudResult<()> {
        let mut connection = self.sink.connection.lock().map_err(|_| storage())?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let data = encode(observation)?;
        let prior = tx.query_row(
            "SELECT payload FROM observations WHERE id=?1",
            [observation.operation_id.as_str()],
            |r| r.get::<_, String>(0),
        );
        match prior {
            Ok(old) => {
                let decoded: crate::StageObservation = decode(&old)?;
                if decoded != *observation {
                    return Err(CloudError::new(
                        ErrorCode::IdempotencyConflict,
                        "external receipt changed under a stable operation ID",
                    ));
                }
                return Ok(());
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(_) => return Err(storage()),
        }
        tx.execute(
            "INSERT INTO observations(id,payload) VALUES(?1,?2)",
            params![observation.operation_id.as_str(), data],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())
    }
    pub fn observation(&self, operation_id: &Id) -> CloudResult<Option<crate::StageObservation>> {
        let connection = self.sink.connection.lock().map_err(|_| storage())?;
        match connection.query_row(
            "SELECT payload FROM observations WHERE id=?1",
            [operation_id.as_str()],
            |r| r.get::<_, String>(0),
        ) {
            Ok(data) => {
                let row: crate::StageObservation = decode(&data)?;
                if &row.operation_id != operation_id {
                    return Err(storage());
                }
                Ok(Some(row))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(_) => Err(storage()),
        }
    }
}
fn reject_symlink(path: &Path) -> CloudResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(storage()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(storage()),
    }
}
fn load(connection: &Connection) -> CloudResult<CloudSnapshot> {
    let mut result = CloudSnapshot {
        generation: counter(connection, "generation")?,
        next_id: counter(connection, "next_id")?,
        ..CloudSnapshot::default()
    };
    let mut statement = connection
        .prepare("SELECT id,version,payload FROM environments ORDER BY id,version")
        .map_err(|_| storage())?;
    let mut rows = statement.query([]).map_err(|_| storage())?;
    while let Some(row) = rows.next().map_err(|_| storage())? {
        let environment: RegisteredEnvironment =
            decode(&row.get::<_, String>(2).map_err(|_| storage())?)?;
        if row.get::<_, String>(0).map_err(|_| storage())?
            != environment.environment_ref.id.as_str()
            || row.get::<_, String>(1).map_err(|_| storage())?
                != environment.environment_ref.version.as_str()
        {
            return Err(storage());
        }
        result.environments.push(environment);
    }
    let mut statement = connection
        .prepare("SELECT id,payload FROM tasks ORDER BY id")
        .map_err(|_| storage())?;
    let mut rows = statement.query([]).map_err(|_| storage())?;
    while let Some(row) = rows.next().map_err(|_| storage())? {
        let task: TaskRecord = decode(&row.get::<_, String>(1).map_err(|_| storage())?)?;
        if row.get::<_, String>(0).map_err(|_| storage())? != task.task_id.as_str() {
            return Err(storage());
        }
        result.tasks.push(task);
    }
    let mut statement = connection
        .prepare("SELECT owner,request_id,payload FROM receipts ORDER BY owner,request_id")
        .map_err(|_| storage())?;
    let mut rows = statement.query([]).map_err(|_| storage())?;
    while let Some(row) = rows.next().map_err(|_| storage())? {
        let receipt: OwnedReceipt = decode(&row.get::<_, String>(2).map_err(|_| storage())?)?;
        if row.get::<_, String>(0).map_err(|_| storage())? != receipt.owner_id.as_str()
            || row.get::<_, String>(1).map_err(|_| storage())?
                != receipt.receipt.request_id.as_str()
        {
            return Err(storage());
        }
        result.receipts.push(receipt);
    }
    let mut statement = connection
        .prepare("SELECT id,payload FROM intents ORDER BY id")
        .map_err(|_| storage())?;
    let mut rows = statement.query([]).map_err(|_| storage())?;
    while let Some(row) = rows.next().map_err(|_| storage())? {
        let intent: StageIntent = decode(&row.get::<_, String>(1).map_err(|_| storage())?)?;
        if row.get::<_, String>(0).map_err(|_| storage())? != intent.operation_id.as_str() {
            return Err(storage());
        }
        result.intents.push(intent);
    }
    Ok(result)
}
