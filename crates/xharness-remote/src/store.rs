//! Private SQLite journal. One process owns the consumer; SQLite transactions
//! atomically commit ingress and its dedup identity before acknowledgement.
use crate::{Delivery, Error};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(crate) struct Store {
    connection: Mutex<Connection>,
    _consumer: File,
    closed: AtomicBool,
}

impl Store {
    pub(crate) fn open(root: &Path, host_id: &str) -> Result<Arc<Self>, Error> {
        fs::create_dir_all(root)?;
        if fs::symlink_metadata(root)?.file_type().is_symlink() {
            return Err(Error::Invalid("storage symlink"));
        }
        // System temp/state parents can be aliases (macOS /var -> /private/var).
        // SQLite NOFOLLOW rejects those ancestors too. Resolve the already
        // validated directory, never the database/lock leaf: their explicit
        // symlink checks and SQLite NOFOLLOW remain in force.
        let canonical_root = fs::canonicalize(root)?;
        let root = canonical_root.as_path();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        }
        for name in [
            "consumer.lock",
            "remote.sqlite",
            "remote.sqlite-wal",
            "remote.sqlite-shm",
        ] {
            let path = root.join(name);
            match fs::symlink_metadata(path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(Error::Invalid("storage symlink"))
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into())
                }
                _ => {}
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let consumer = options.open(root.join("consumer.lock"))?;
        consumer
            .try_lock_exclusive()
            .map_err(|_| Error::ConsumerBusy)?;
        let connection = Connection::open_with_flags(
            root.join("remote.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            return Err(Error::Invalid("unsupported journal version"));
        }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL,
                body TEXT NOT NULL, PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(state,seq);
            CREATE INDEX IF NOT EXISTS inbox_session ON inbox(session,seq);
            CREATE INDEX IF NOT EXISTS inbox_command_scope ON inbox(session,json_extract(body,'$.principal'),
                (body -> '$.principal_revision'),json_extract(body,'$.binding.id'),(body -> '$.binding.generation'),seq)
                WHERE state IN ('completed','rejected','uncertain','abandoned');
            CREATE INDEX IF NOT EXISTS binding_conversation ON entities(json_extract(body,'$.conversation')) WHERE kind='binding';
            CREATE INDEX IF NOT EXISTS principal_sender ON entities(json_extract(body,'$.sender.channel'),json_extract(body,'$.sender.account'),json_extract(body,'$.sender.user')) WHERE kind='principal';
            CREATE TABLE IF NOT EXISTS recovery_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL, account TEXT NOT NULL, route TEXT NOT NULL,
                state TEXT NOT NULL, not_before INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(account,state,not_before,seq);
            CREATE INDEX IF NOT EXISTS outbox_route ON outbox(route,seq);
            CREATE TABLE IF NOT EXISTS reply_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS interaction_tickets(id TEXT PRIMARY KEY,instance TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS interaction_ticket_scope ON interaction_tickets(instance,scope,state,expires);
            CREATE TABLE IF NOT EXISTS interaction_fences(instance TEXT PRIMARY KEY,state TEXT NOT NULL,delivery TEXT NOT NULL);
            PRAGMA user_version=1;")?;
        let existing_host: Option<String> = connection
            .query_row(
                "SELECT body FROM entities WHERE kind='host' AND id='identity'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match existing_host {
            Some(identity) if identity != host_id => return Err(Error::Unauthorized),
            Some(_) => {}
            None => {
                connection.execute(
                    "INSERT INTO entities(kind,id,body) VALUES ('host','identity',?1)",
                    [host_id],
                )?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in [
                "consumer.lock",
                "remote.sqlite",
                "remote.sqlite-wal",
                "remote.sqlite-shm",
            ] {
                let path = root.join(name);
                if path.try_exists()? {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
                }
            }
        }
        Ok(Arc::new(Self {
            connection: Mutex::new(connection),
            _consumer: consumer,
            closed: AtomicBool::new(false),
        }))
    }

    pub(crate) async fn transaction<T: Send + 'static>(
        self: &Arc<Self>,
        action: impl FnOnce(&Transaction<'_>) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.transaction_fenced((), action).await
    }
    /// Retain authority writers until commit/rollback, even if their async
    /// caller was cancelled while this blocking job waited for the SQL mutex.
    pub(crate) async fn transaction_fenced<T: Send + 'static>(
        self: &Arc<Self>,
        fence: impl Send + 'static,
        action: impl FnOnce(&Transaction<'_>) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _fence = fence;
            let mut connection = store.connection.lock().map_err(|_| Error::Poisoned)?;
            if store.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            let tx = connection.transaction()?;
            let value = action(&tx)?;
            tx.commit()?;
            Ok(value)
        })
        .await
        .map_err(|_| Error::WorkerFailed)?
    }

    /// Close under the same mutex as every journal transaction. Already queued
    /// blocking jobs recheck closed after acquiring the mutex and cannot write.
    /// Explicitly release ownership instead of relying on task-capture Arc drop
    /// timing after a JoinHandle has delivered its completion.
    pub(crate) async fn close(self: &Arc<Self>) -> Result<(), Error> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _connection = store.connection.lock().map_err(|_| Error::Poisoned)?;
            if !store.closed.swap(true, Ordering::AcqRel) {
                FileExt::unlock(&store._consumer)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| Error::WorkerFailed)?
    }
}

pub(crate) fn entity<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
) -> Result<Option<T>, Error> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT body FROM entities WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Error::from))
        .transpose()
}
pub(crate) fn put_entity<T: Serialize>(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
    value: &T,
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO entities(kind,id,body) VALUES (?1,?2,?3)
        ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
        params![kind, id, serde_json::to_string(value)?],
    )?;
    Ok(())
}
pub(crate) fn delivery(tx: &Transaction<'_>, key: &str) -> Result<Option<Delivery>, Error> {
    let raw: Option<String> = tx
        .query_row("SELECT body FROM inbox WHERE key=?1", [key], |r| r.get(0))
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Error::from))
        .transpose()
}
pub(crate) fn save(tx: &Transaction<'_>, d: &Delivery) -> Result<(), Error> {
    tx.execute(
        "UPDATE inbox SET state=?1,body=?2 WHERE key=?3",
        params![d.state.wire(), serde_json::to_string(d)?, d.key],
    )?;
    Ok(())
}

#[cfg(all(test, unix))]
mod path_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn canonical_parent_alias_keeps_private_journal_and_exclusive_owner() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("physical-parent");
        fs::create_dir(&parent).unwrap();
        let alias = temp.path().join("parent-alias");
        symlink(&parent, &alias).unwrap();
        let root = alias.join("journal");
        let physical = parent.join("journal");
        let store = Store::open(&root, "h").unwrap();
        assert_eq!(
            fs::metadata(&physical).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in [
            "consumer.lock",
            "remote.sqlite",
            "remote.sqlite-wal",
            "remote.sqlite-shm",
        ] {
            assert_eq!(
                fs::metadata(physical.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        {
            let connection = store.connection.lock().unwrap();
            let mode: String = connection
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            let sync: u32 = connection
                .query_row("PRAGMA synchronous", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "wal");
            assert_eq!(sync, 2);
        }
        assert!(matches!(
            Store::open(&physical, "h"),
            Err(Error::ConsumerBusy)
        ));
        drop(store);
        let reopened = Store::open(&root, "h").unwrap();
        let identity: String = reopened
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT body FROM entities WHERE kind='host' AND id='identity'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(identity, "h");
    }

    #[test]
    fn canonical_parent_resolution_still_rejects_symlinked_storage_root() {
        let temp = tempfile::tempdir().unwrap();
        let physical = temp.path().join("physical-root");
        fs::create_dir(&physical).unwrap();
        let root = temp.path().join("root-alias");
        symlink(&physical, &root).unwrap();
        assert!(matches!(
            Store::open(&root, "h"),
            Err(Error::Invalid("storage symlink"))
        ));
        assert!(!physical.join("consumer.lock").exists());
        assert!(!physical.join("remote.sqlite").exists());
    }

    #[test]
    fn canonical_parent_resolution_still_rejects_every_symlinked_journal_leaf() {
        for name in [
            "consumer.lock",
            "remote.sqlite",
            "remote.sqlite-wal",
            "remote.sqlite-shm",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("journal");
            fs::create_dir(&root).unwrap();
            let outside = temp.path().join("outside");
            fs::write(&outside, b"unchanged").unwrap();
            symlink(&outside, root.join(name)).unwrap();
            assert!(
                matches!(
                    Store::open(&root, "h"),
                    Err(Error::Invalid("storage symlink"))
                ),
                "{name}"
            );
            assert_eq!(fs::read(&outside).unwrap(), b"unchanged");
        }
    }
}
