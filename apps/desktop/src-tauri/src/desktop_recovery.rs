//! Private launch handoff, separate from payload-free diagnostics. Never export
//! this file or put it in browser metadata. It is not a replacement Host lease.
#![forbid(unsafe_code)]

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_RECEIPT: u64 = 8192;
const DOMAIN: &[u8] = b"xharness-desktop-host-v1\0";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    schema: u8,
    pub runtime_id: String,
    pub token: String,
    pub browser_address: SocketAddr,
    pub browser_token: String,
    version: String,
    state_dir: PathBuf,
    workspace: PathBuf,
}

impl Launch {
    pub fn compatible(&self) -> bool {
        self.version == env!("CARGO_PKG_VERSION")
    }
}

pub struct RecoveryStore {
    path: PathBuf,
    root: PathBuf,
    state_dir: PathBuf,
    workspace: PathBuf,
    // Independent desktop ownership, including dev/release instances. Never
    // remove the lock file: closing this handle releases the advisory lock.
    _desktop_owner: File,
}

pub fn secret() -> io::Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("recovery entropy unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn hex_secret(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn loopback(address: SocketAddr) -> bool {
    address.ip() == Ipv4Addr::LOCALHOST && address.port() != 0
}
fn private_regular(path: &Path, file: &File, root: &Path) -> io::Result<()> {
    let link = fs::symlink_metadata(path)?;
    let actual = file.metadata()?;
    if !link.is_file() || link.file_type().is_symlink() || !actual.is_file() {
        return Err(io::Error::other("recovery file must be regular"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if link.dev() != actual.dev()
            || link.ino() != actual.ino()
            || actual.mode() & 0o077 != 0
            || actual.uid() != fs::metadata(root)?.uid()
            || actual.nlink() != 1
        {
            return Err(io::Error::other("recovery file is not private"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if link.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("reparse recovery file denied"));
        }
    }
    let _ = root;
    Ok(())
}

impl RecoveryStore {
    pub fn open(root: &Path, state_dir: &Path, workspace: &Path) -> io::Result<Self> {
        let root = fs::canonicalize(root)?;
        let state_dir = fs::canonicalize(state_dir)?;
        let workspace = fs::canonicalize(workspace)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if fs::metadata(&root)?.mode() & 0o022 != 0 {
                return Err(io::Error::other("runtime directory is writable by others"));
            }
        }
        let key = Sha256::digest(serde_json::to_vec(&(&state_dir, &workspace))?);
        let key: String = key.iter().map(|b| format!("{b:02x}")).collect();
        let owner_path = root.join(format!("desktop-owner-{key}.lock"));
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Refuse an existing symlink before even opening it for writing.
        if fs::symlink_metadata(&owner_path)
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err(io::Error::other("invalid desktop ownership file"));
        }
        let owner = options.open(&owner_path)?;
        private_regular(&owner_path, &owner, &root)?;
        owner
            .try_lock()
            .map_err(|_| io::Error::other("another desktop owns this runtime"))?;
        Ok(Self {
            path: root.join(format!("desktop-session-{key}.json")),
            root,
            state_dir,
            workspace,
            _desktop_owner: owner,
        })
    }
    pub fn load(&self) -> io::Result<Option<Launch>> {
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err(io::Error::other("invalid recovery file"));
        }
        let file = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        private_regular(&self.path, &file, &self.root)?;
        let mut bytes = Vec::new();
        file.take(MAX_RECEIPT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RECEIPT {
            return Err(io::Error::other("recovery file exceeds budget"));
        }
        // Do not expose serde error text: it can quote private file contents.
        let value: Launch = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("invalid recovery receipt"))?;
        if value.schema != 1
            || value.state_dir != self.state_dir
            || value.workspace != self.workspace
            || !hex_secret(&value.runtime_id)
            || !hex_secret(&value.token)
            || !hex_secret(&value.browser_token)
            || !loopback(value.browser_address)
            || value.version.len() > 64
        {
            return Err(io::Error::other("recovery receipt binding mismatch"));
        }
        Ok(Some(value))
    }
    pub fn save(
        &self,
        runtime_id: &str,
        token: &str,
        address: SocketAddr,
        browser_token: &str,
    ) -> io::Result<()> {
        if !hex_secret(runtime_id)
            || !hex_secret(token)
            || !hex_secret(browser_token)
            || !loopback(address)
        {
            return Err(io::Error::other("invalid recovery identity"));
        }
        let value = Launch {
            schema: 1,
            runtime_id: runtime_id.into(),
            token: token.into(),
            browser_address: address,
            browser_token: browser_token.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            state_dir: self.state_dir.clone(),
            workspace: self.workspace.clone(),
        };
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)?;
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() as u64 > MAX_RECEIPT {
            return Err(io::Error::other("recovery receipt exceeds budget"));
        }
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(&self.path)
            .map_err(|_| io::Error::other("could not publish recovery receipt"))?;
        Ok(())
    }
    /// OS lease state, not a PID lookup, timeout, HTTP response or stale file.
    /// Never delete, truncate or retain a successfully acquired Host lock.
    pub fn host_owned(&self) -> io::Result<bool> {
        host_owned(&self.state_dir)
    }

    pub fn clear_after_stop(&self) -> io::Result<()> {
        if self.host_owned()? {
            return Err(io::Error::other("live Host recovery must be retained"));
        }
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

fn host_owned(state_dir: &Path) -> io::Result<bool> {
    let path = state_dir.join("ownership/host.agent.lock");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(io::Error::other("invalid Host ownership file"));
    }
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    match file.try_lock() {
        Ok(()) => {
            drop(file);
            Ok(false)
        }
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    proof: String,
}

/// No bearer is sent, redirects/proxies are disabled, responses are bounded.
/// A recycled port that merely serves healthy HTML cannot capture credentials.
pub async fn authenticate(address: SocketAddr, token: &str) -> Result<bool, String> {
    if !loopback(address) || !hex_secret(token) {
        return Err("invalid recovery endpoint".into());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let nonce = secret().map_err(|_| "recovery entropy unavailable")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "recovery transport unavailable")?;
    let mut response = match client
        .get(format!("http://{address}/desktop/identity?nonce={nonce}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(false),
    };
    if response.status() != reqwest::StatusCode::OK {
        return Ok(false);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "recovery proof interrupted")?
    {
        if body.len() + chunk.len() > 256 {
            return Ok(false);
        }
        body.extend_from_slice(&chunk);
    }
    let identity: Identity = match serde_json::from_slice(&body) {
        Ok(i) => i,
        Err(_) => return Ok(false),
    };
    if identity.proof.len() != 64 {
        return Ok(false);
    }
    let mut proof = [0; 32];
    for (index, part) in identity
        .proof
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
    {
        let Some(high) = (part[0] as char).to_digit(16) else {
            return Ok(false);
        };
        let Some(low) = (part[1] as char).to_digit(16) else {
            return Ok(false);
        };
        proof[index] = ((high << 4) | low) as u8;
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| "invalid recovery key")?;
    mac.update(DOMAIN);
    mac.update(nonce.as_bytes());
    Ok(mac.verify_slice(&proof).is_ok())
}

pub async fn authenticate_with_retry(address: SocketAddr, token: &str) -> Result<bool, String> {
    if !loopback(address) || !hex_secret(token) {
        return Err("invalid recovery endpoint".into());
    }
    for delay in [100, 300, 700] {
        if authenticate(address, token)
            .await
            .is_ok_and(|verified| verified)
        {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn identity_fixture(
        key: String,
        mode: &'static str,
    ) -> (SocketAddr, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            if mode == "reset-first" {
                let (stream, _) = listener.accept().await.unwrap();
                drop(stream);
            }
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut byte = [0];
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
                assert!(request.len() < 4096);
            }
            let text = String::from_utf8(request).unwrap();
            assert!(!text.contains(&key));
            assert!(!text.to_lowercase().contains("cookie:"));
            let path = text
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let url = url::Url::parse(&format!("http://localhost{path}")).unwrap();
            let nonce = url
                .query_pairs()
                .find(|(k, _)| k == "nonce")
                .unwrap()
                .1
                .into_owned();
            let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
            mac.update(DOMAIN);
            mac.update(nonce.as_bytes());
            let proof: String = mac
                .finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let (status, body) = match mode {
                "valid" | "reset-first" => ("200 OK", format!(r#"{{"proof":"{proof}"}}"#)),
                "wrong" => ("200 OK", format!(r#"{{"proof":"{}"}}"#, "0".repeat(64))),
                "large" => ("200 OK", "x".repeat(2048)),
                "echo" => ("200 OK", format!(r#"{{"proof":"{nonce}"}}"#)),
                "unknown" => (
                    "200 OK",
                    format!(r#"{{"proof":"{proof}","token":"private"}}"#),
                ),
                "redirect" => ("302 Found", "".into()),
                _ => ("401 Unauthorized", "".into()),
            };
            let bytes=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/never-follow\r\nConnection: close\r\n\r\n{body}",body.len());
            let _ = stream.write_all(bytes.as_bytes()).await;
            text
        });
        (address, task)
    }

    #[tokio::test]
    async fn challenge_proves_server_before_sending_any_bearer_no_redirects_or_large_bodies() {
        let key = secret().unwrap();
        for mode in [
            "valid",
            "wrong",
            "large",
            "echo",
            "unknown",
            "redirect",
            "unauthorized",
        ] {
            let (address, task) = identity_fixture(key.clone(), mode).await;
            assert_eq!(
                authenticate(address, &key).await.unwrap(),
                mode == "valid",
                "{mode}"
            );
            let request = task.await.unwrap();
            assert!(request.starts_with("GET /desktop/identity?nonce="));
        }
        assert!(authenticate("1.2.3.4:80".parse().unwrap(), &key)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn transient_connection_reset_recovers_with_bounded_retry_without_credentials() {
        let key = secret().unwrap();
        let (address, server) = identity_fixture(key.clone(), "reset-first").await;
        assert!(authenticate_with_retry(address, &key).await.unwrap());
        server.await.unwrap();
        assert!(authenticate_with_retry("1.2.3.4:80".parse().unwrap(), &key)
            .await
            .is_err());
    }
    fn paths() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("runtime");
        let state = dir.path().join("state");
        let workspace = dir.path().join("工作区");
        for p in [&root, &state, &workspace] {
            fs::create_dir(p).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        (dir, root, state, workspace)
    }
    #[test]
    fn roundtrip_private_bound_and_second_desktop_denied_without_erasing_lease() {
        let (_dir, root, state, workspace) = paths();
        let store = RecoveryStore::open(&root, &state, &workspace).unwrap();
        assert!(store.load().unwrap().is_none());
        let id = secret().unwrap();
        let token = secret().unwrap();
        let bridge = secret().unwrap();
        store
            .save(&id, &token, "127.0.0.1:12345".parse().unwrap(), &bridge)
            .unwrap();
        assert!(RecoveryStore::open(&root, &state, &workspace).is_err());
        let saved = store.load().unwrap().unwrap();
        assert_eq!(saved.token, token);
        assert_eq!(saved.runtime_id, id);
        assert!(saved.compatible());
        #[cfg(unix)]
        let path = store.path.clone();
        drop(store);
        assert_eq!(
            RecoveryStore::open(&root, &state, &workspace)
                .unwrap()
                .load()
                .unwrap()
                .unwrap()
                .browser_token,
            bridge
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn a_file_or_pid_is_not_a_live_host_and_lock_is_never_removed() {
        let (_dir, root, state, workspace) = paths();
        let store = RecoveryStore::open(&root, &state, &workspace).unwrap();
        assert!(!store.host_owned().unwrap());
        fs::create_dir(state.join("ownership")).unwrap();
        let path = state.join("ownership/host.agent.lock");
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(!store.host_owned().unwrap());
        file.lock().unwrap();
        assert!(store.host_owned().unwrap());
        assert!(store.clear_after_stop().is_err());
        drop(file);
        assert!(!store.host_owned().unwrap());
        store.clear_after_stop().unwrap();
        assert!(path.is_file());
    }
    #[test]
    fn corrupt_oversize_wrong_binding_and_nonloopback_fail_closed() {
        let (_dir, root, state, workspace) = paths();
        let store = RecoveryStore::open(&root, &state, &workspace).unwrap();
        let key = secret().unwrap();
        assert!(store
            .save(&key, &key, "1.2.3.4:80".parse().unwrap(), &key)
            .is_err());
        store
            .save(&key, &key, "127.0.0.1:23".parse().unwrap(), &key)
            .unwrap();
        let original = fs::read(&store.path).unwrap();
        let mut bad: serde_json::Value = serde_json::from_slice(&original).unwrap();
        bad["state_dir"] = "/unrelated".into();
        fs::write(&store.path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(store.load().is_err());
        fs::write(&store.path, b"private-corrupt-secret").unwrap();
        let error = store.load().err().unwrap().to_string();
        assert!(!error.contains("private-corrupt-secret"));
        fs::write(&store.path, vec![0; MAX_RECEIPT as usize + 1]).unwrap();
        assert!(store.load().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_and_public_receipts_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_dir, root, state, workspace) = paths();
        let store = RecoveryStore::open(&root, &state, &workspace).unwrap();
        let key = secret().unwrap();
        store
            .save(&key, &key, "127.0.0.1:23".parse().unwrap(), &key)
            .unwrap();
        fs::set_permissions(&store.path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.load().is_err());
        fs::remove_file(&store.path).unwrap();
        let target = root.join("outside");
        fs::write(&target, b"untouched").unwrap();
        symlink(&target, &store.path).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(target).unwrap(), b"untouched");
    }
}
