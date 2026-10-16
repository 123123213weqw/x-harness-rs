use crate::protocol::{ErrorCode, PairedDevice, Secret};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;
use xharness_remote::{Binding, Channel, CreationPolicy, Gateway, Principal, Sender, Subscription};

const MAX_DEVICES: usize = 1024;
const MAX_PAIRINGS: usize = 4096;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingScopes {
    pub workspaces: BTreeSet<String>,
    pub sessions: BTreeSet<String>,
    pub workspace: String,
    pub session: String,
    #[serde(default)]
    pub create_workspaces: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingOffer {
    pub code: Secret,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub created_at_ms: u64,
    pub revoked: bool,
    /// Reserved/incomplete credentials never authenticate, including after crash.
    pub active: bool,
}
pub struct MobileHost {
    pub(crate) gateway: Arc<Gateway>,
    store: Arc<Store>,
    pair_gate: AsyncMutex<()>,
    pub(crate) event_lease: AsyncMutex<Option<xharness_remote::AccountLease>>,
}
struct Store {
    connection: Mutex<Connection>,
    _owner: File,
}
impl Store {
    fn open(root: &Path, host: &str) -> Result<Arc<Self>, ErrorCode> {
        fs::create_dir_all(root).map_err(|_| ErrorCode::StorageUnavailable)?;
        if fs::symlink_metadata(root)
            .map_err(|_| ErrorCode::StorageUnavailable)?
            .file_type()
            .is_symlink()
        {
            return Err(ErrorCode::StorageUnavailable);
        }
        let root = fs::canonicalize(root).map_err(|_| ErrorCode::StorageUnavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| ErrorCode::StorageUnavailable)?;
        }
        for name in [
            "consumer.lock",
            "mobile.sqlite",
            "mobile.sqlite-wal",
            "mobile.sqlite-shm",
        ] {
            match fs::symlink_metadata(root.join(name)) {
                Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                    return Err(ErrorCode::StorageUnavailable)
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(ErrorCode::StorageUnavailable)
                }
                _ => {}
            }
        }
        let mut opts = OpenOptions::new();
        opts.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let owner = opts
            .open(root.join("consumer.lock"))
            .map_err(|_| ErrorCode::StorageUnavailable)?;
        owner
            .try_lock_exclusive()
            .map_err(|_| ErrorCode::StorageUnavailable)?;
        let mut conn = Connection::open_with_flags(
            root.join("mobile.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| ErrorCode::StorageUnavailable)?;
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| ErrorCode::StorageUnavailable)?;
        if version > 1 {
            return Err(ErrorCode::StorageUnavailable);
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pairings(hash BLOB PRIMARY KEY,expires INTEGER NOT NULL,state TEXT NOT NULL,scopes TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash BLOB NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,device TEXT,at INTEGER NOT NULL);
            PRAGMA user_version=1;").map_err(|_| ErrorCode::StorageUnavailable)?;
        let tx = conn
            .transaction()
            .map_err(|_| ErrorCode::StorageUnavailable)?;
        let stored: Option<String> = tx
            .query_row("SELECT value FROM meta WHERE key='host'", [], |r| r.get(0))
            .optional()
            .map_err(|_| ErrorCode::StorageUnavailable)?;
        match stored {
            Some(h) if h != host => return Err(ErrorCode::Unauthorized),
            Some(_) => {}
            None => {
                tx.execute("INSERT INTO meta(key,value) VALUES('host',?1)", [host])
                    .map_err(|_| ErrorCode::StorageUnavailable)?;
            }
        }
        // An interrupted reservation is permanently sealed, not resumed as active.
        tx.execute(
            "UPDATE devices SET state='revoked' WHERE state='reserved'",
            [],
        )
        .map_err(|_| ErrorCode::StorageUnavailable)?;
        tx.commit().map_err(|_| ErrorCode::StorageUnavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in [
                "consumer.lock",
                "mobile.sqlite",
                "mobile.sqlite-wal",
                "mobile.sqlite-shm",
            ] {
                let path = root.join(name);
                if path
                    .try_exists()
                    .map_err(|_| ErrorCode::StorageUnavailable)?
                {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                        .map_err(|_| ErrorCode::StorageUnavailable)?;
                }
            }
        }
        Ok(Arc::new(Self {
            connection: Mutex::new(conn),
            _owner: owner,
        }))
    }
    async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&mut Connection) -> Result<T, ErrorCode> + Send + 'static,
    ) -> Result<T, ErrorCode> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = store
                .connection
                .lock()
                .map_err(|_| ErrorCode::StorageUnavailable)?;
            f(&mut conn)
        })
        .await
        .map_err(|_| ErrorCode::StorageUnavailable)?
    }
}
fn db<T>(value: rusqlite::Result<T>) -> Result<T, ErrorCode> {
    value.map_err(|_| ErrorCode::StorageUnavailable)
}
fn clock(tx: &Transaction<'_>) -> Result<u64, ErrorCode> {
    let observed: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ErrorCode::StorageUnavailable)?
        .as_millis()
        .try_into()
        .map_err(|_| ErrorCode::StorageUnavailable)?;
    let old: Option<String> = db(tx
        .query_row("SELECT value FROM meta WHERE key='clock'", [], |r| r.get(0))
        .optional())?;
    if old.is_some_and(|old| old.parse::<u64>().map_or(true, |old| observed < old)) {
        return Err(ErrorCode::StorageUnavailable);
    }
    db(tx.execute("INSERT INTO meta(key,value) VALUES('clock',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [observed.to_string()]))?;
    Ok(observed)
}
// Persist the clock watermark even if the following request is rejected.
// Otherwise a rejected expired code + clock rollback could revive that offer.
fn persisted_time(conn: &mut Connection) -> Result<u64, ErrorCode> {
    let tx = db(conn.transaction())?;
    let observed = clock(&tx)?;
    db(tx.commit())?;
    Ok(observed)
}
fn random_secret() -> Result<Secret, ErrorCode> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|_| ErrorCode::StorageUnavailable)?;
    raw.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .try_into()
        .map_err(|_| ErrorCode::StorageUnavailable)
}
fn hash(value: &Secret) -> [u8; 32] {
    Sha256::digest(value.expose().as_bytes()).into()
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}
fn validate_scopes(scopes: &PairingScopes) -> Result<(), ErrorCode> {
    if scopes.workspaces.is_empty()
        || scopes.sessions.is_empty()
        || scopes.workspaces.len() > 256
        || scopes.sessions.len() > 4096
        || !scopes.workspaces.contains(&scopes.workspace)
        || !scopes.sessions.contains(&scopes.session)
        || !scopes.create_workspaces.is_subset(&scopes.workspaces)
        || scopes
            .workspaces
            .iter()
            .chain(&scopes.sessions)
            .any(|v| !valid_id(v))
    {
        return Err(ErrorCode::InvalidRequest);
    }
    Ok(())
}
pub(crate) fn sender(device: &str) -> Sender {
    Sender {
        channel: Channel::MobileWeb,
        account: "mobile".into(),
        user: device.into(),
    }
}
fn principal_id(device: &str) -> String {
    format!("mobile-{device}")
}
fn binding_id(device: &str) -> String {
    format!("mobile-binding-{device}")
}

impl MobileHost {
    pub fn open(gateway: Arc<Gateway>, root: &Path) -> Result<Arc<Self>, ErrorCode> {
        let store = Store::open(root, gateway.host_id())?;
        Ok(Arc::new(Self {
            gateway,
            store,
            pair_gate: AsyncMutex::new(()),
            event_lease: AsyncMutex::new(None),
        }))
    }
    /// Only trusted desktop composition calls this. Scope is immutable during redemption.
    pub async fn create_pairing(
        &self,
        scopes: PairingScopes,
        ttl_seconds: u16,
    ) -> Result<PairingOffer, ErrorCode> {
        validate_scopes(&scopes)?;
        if ttl_seconds == 0 || ttl_seconds > 300 {
            return Err(ErrorCode::InvalidRequest);
        }
        let code = random_secret()?;
        let digest = hash(&code);
        let scopes = serde_json::to_string(&scopes).map_err(|_| ErrorCode::InvalidRequest)?;
        let expires = self
            .store
            .run(move |conn| {
                let now = persisted_time(conn)?;
                let tx = db(conn.transaction())?;
                let count: usize =
                    db(tx.query_row("SELECT COUNT(*) FROM pairings", [], |r| r.get(0)))?;
                if count >= MAX_PAIRINGS {
                    return Err(ErrorCode::Capacity);
                }
                let expires = now
                    .checked_add(u64::from(ttl_seconds) * 1000)
                    .ok_or(ErrorCode::Capacity)?;
                db(tx.execute(
                    "INSERT INTO pairings(hash,expires,state,scopes) VALUES(?1,?2,'open',?3)",
                    params![digest.as_slice(), expires, scopes],
                ))?;
                db(tx.execute(
                    "INSERT INTO audit(event,at) VALUES('pair_created',?1)",
                    [now],
                ))?;
                db(tx.commit())?;
                Ok(expires)
            })
            .await?;
        Ok(PairingOffer {
            code,
            expires_at_ms: expires,
        })
    }
    pub async fn devices(&self) -> Result<Vec<DeviceView>, ErrorCode> {
        self.store
            .run(|conn| {
                let mut q = db(conn.prepare(
                    "SELECT id,name,created,state FROM devices ORDER BY created,id LIMIT 1025",
                ))?;
                let rows = db(q.query_map([], |r| {
                    let state: String = r.get(3)?;
                    Ok(DeviceView {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at_ms: r.get(2)?,
                        revoked: state == "revoked",
                        active: state == "active",
                    })
                }))?;
                let rows = db(rows.collect::<rusqlite::Result<Vec<_>>>())?;
                if rows.len() > MAX_DEVICES {
                    return Err(ErrorCode::Capacity);
                }
                Ok(rows)
            })
            .await
    }
    pub async fn revoke(&self, device: &str) -> Result<(), ErrorCode> {
        if !valid_id(device) {
            return Err(ErrorCode::InvalidRequest);
        }
        let _gate = self.pair_gate.lock().await;
        let id = device.to_owned();
        let exists = self
            .store
            .run({
                let id = id.clone();
                move |conn| {
                    db(conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?1)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    ))
                }
            })
            .await?;
        if !exists {
            return Err(ErrorCode::Unauthorized);
        }
        // Gateway irreversibly seals admissions/subscriptions first. A later DB failure cannot resurrect it.
        match self.gateway.revoke(&principal_id(device)).await {
            Ok(()) | Err(xharness_remote::Error::Unauthorized) => {}
            Err(error) => return Err(crate::handler::remote_error(error)),
        }
        self.store
            .run(move |conn| {
                let now = persisted_time(conn)?;
                let tx = db(conn.transaction())?;
                db(tx.execute("UPDATE devices SET state='revoked' WHERE id=?1", [&id]))?;
                db(tx.execute(
                    "INSERT INTO audit(event,device,at) VALUES('device_revoked',?1,?2)",
                    params![id, now],
                ))?;
                db(tx.commit())
            })
            .await
    }
    pub(crate) async fn redeem(
        &self,
        code: Secret,
        name: String,
    ) -> Result<PairedDevice, ErrorCode> {
        if name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err(ErrorCode::InvalidRequest);
        }
        let _gate = self.pair_gate.lock().await;
        let digest = hash(&code);
        let secret = random_secret()?;
        let token_hash = hash(&secret);
        let device = format!("device-{}", &random_secret()?.expose()[..32]);
        let id = device.clone();
        let scopes = self.store.run(move |conn| {
            let now = persisted_time(conn)?;
            let tx = db(conn.transaction())?;
            let pair: Option<(u64,String,String)> = db(tx.query_row("SELECT expires,state,scopes FROM pairings WHERE hash=?1", [digest.as_slice()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
            let (expires,state,raw) = pair.ok_or(ErrorCode::Unauthorized)?;
            if state != "open" { return Err(ErrorCode::PairConsumed); }
            if now >= expires { return Err(ErrorCode::PairExpired); }
            let count: usize = db(tx.query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0)))?;
            if count >= MAX_DEVICES { return Err(ErrorCode::Capacity); }
            let scopes: PairingScopes = serde_json::from_str(&raw).map_err(|_| ErrorCode::StorageUnavailable)?;
            validate_scopes(&scopes)?;
            db(tx.execute("UPDATE pairings SET state='consumed' WHERE hash=?1 AND state='open'", [digest.as_slice()]))?;
            db(tx.execute("INSERT INTO devices(id,name,hash,state,created) VALUES(?1,?2,?3,'reserved',?4)", params![id,name,token_hash.as_slice(),now]))?;
            db(tx.execute("INSERT INTO audit(event,device,at) VALUES('pair_reserved',?1,?2)", params![id,now]))?;
            db(tx.commit())?;
            Ok(scopes)
        }).await?;
        let principal = Principal {
            id: principal_id(&device),
            host: self.gateway.host_id().into(),
            sender: sender(&device),
            workspaces: scopes.workspaces.clone(),
            sessions: scopes.sessions.clone(),
            revision: 1,
            revoked: false,
        };
        let binding = Binding {
            id: binding_id(&device),
            principal: principal.id.clone(),
            conversation: device.clone(),
            workspace: scopes.workspace,
            session: scopes.session,
            generation: 1,
        };
        let creation = Some(CreationPolicy {
            principal: principal.id.clone(),
            principal_revision: 1,
            generation: 1,
            workspaces: scopes.create_workspaces,
        });
        self.gateway
            .configure_private_scopes(principal, binding, creation)
            .await
            .map_err(crate::handler::remote_error)?;
        let id = device.clone();
        self.store
            .run(move |conn| {
                let now = persisted_time(conn)?;
                let tx = db(conn.transaction())?;
                let changed = db(tx.execute(
                    "UPDATE devices SET state='active' WHERE id=?1 AND state='reserved'",
                    [&id],
                ))?;
                if changed != 1 {
                    return Err(ErrorCode::Unauthorized);
                }
                db(tx.execute(
                    "INSERT INTO audit(event,device,at) VALUES('device_activated',?1,?2)",
                    params![id, now],
                ))?;
                db(tx.commit())
            })
            .await?;
        Ok(PairedDevice {
            host: self.gateway.host_id().into(),
            device,
            secret,
        })
    }
    pub(crate) async fn authenticate(
        &self,
        device: String,
        secret: Secret,
    ) -> Result<Subscription, ErrorCode> {
        if !valid_id(&device) {
            return Err(ErrorCode::Unauthorized);
        }
        let expected = hash(&secret);
        let id = device.clone();
        self.store
            .run(move |conn| {
                let row: Option<(Vec<u8>, String)> = db(conn
                    .query_row("SELECT hash,state FROM devices WHERE id=?1", [id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional())?;
                let (stored, state) = row.ok_or(ErrorCode::Unauthorized)?;
                // Fixed length byte comparison; credential material never enters SQL or logs.
                let mismatch = stored
                    .iter()
                    .zip(expected)
                    .fold(0u8, |n, (a, b)| n | (*a ^ b));
                if state != "active" || stored.len() != 32 || mismatch != 0 {
                    return Err(ErrorCode::Unauthorized);
                }
                Ok(())
            })
            .await?;
        let route = self
            .gateway
            .resolve_sender(sender(&device), device.clone())
            .await
            .map_err(crate::handler::remote_error)?
            .ok_or(ErrorCode::Unauthorized)?;
        if route.principal != principal_id(&device) || route.binding.id != binding_id(&device) {
            return Err(ErrorCode::Unauthorized);
        }
        Ok(Subscription {
            principal: route.principal,
            sender: sender(&device),
            conversation: device,
            binding: route.binding.id,
            generation: route.binding.generation,
        })
    }
}
