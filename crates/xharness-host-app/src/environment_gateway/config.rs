use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs, io,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
};

/// Explicit owner-controlled configuration; never accepts a browser-supplied
/// target URL, credential, arbitrary tunnel command or workspace path.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayConfig {
    pub version: u32,
    pub launch_token_file: PathBuf,
    pub environments: Vec<EnvironmentConfig>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentConfig {
    pub id: String,
    pub label: String,
    pub kind: EnvironmentKind,
    pub listen: SocketAddr,
    #[serde(deserialize_with = "deserialize_url")]
    pub upstream: reqwest::Url,
    pub token_file: PathBuf,
}
#[derive(Clone, Copy, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentKind {
    Local,
    Cloud,
}
impl GatewayConfig {
    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = read_private(path, 64 * 1024)?;
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1
            || self.environments.is_empty()
            || self.environments.len() > 8
            || !self.launch_token_file.is_absolute()
        {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        let mut listeners = BTreeSet::new();
        let mut upstreams = BTreeSet::new();
        for e in &self.environments {
            if e.id.is_empty()
                || e.id.len() > 64
                || !e.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || e.label.trim().is_empty()
                || e.label.len() > 80
                || e.label.chars().any(char::is_control)
                || !ids.insert(&e.id)
                || !listeners.insert(e.listen)
                || e.listen.ip() != std::net::Ipv4Addr::LOCALHOST
                || e.listen.port() == 0
                || !e.token_file.is_absolute()
            {
                return Err(invalid());
            }
            // v1 is SSH-loopback only. TLS, DNS, proxy discovery and public
            // endpoints must not silently expand this trusted boundary.
            let u = &e.upstream;
            if u.scheme() != "http"
                || u.host_str() != Some("127.0.0.1")
                || u.port().is_none()
                || u.port() == Some(0)
                || u.path() != "/"
                || u.query().is_some()
                || u.fragment().is_some()
                || !u.username().is_empty()
                || u.password().is_some()
                || !upstreams.insert(u.as_str())
            {
                return Err(invalid());
            }
        }
        for e in &self.environments {
            let address = SocketAddr::from((
                std::net::Ipv4Addr::LOCALHOST,
                e.upstream.port().ok_or_else(invalid)?,
            ));
            if listeners.contains(&address) {
                return Err(invalid());
            }
        }
        if self
            .environments
            .iter()
            .filter(|e| e.kind == EnvironmentKind::Local)
            .count()
            != 1
        {
            return Err(invalid());
        }
        Ok(())
    }
}
fn invalid() -> io::Error {
    io::Error::other("invalid personal environment configuration")
}
fn private_regular_file(path: &Path) -> io::Result<()> {
    // Do not treat absent Unix mode bits as proof of a private Windows ACL.
    // Add an audited native ACL port before enabling this opt-in carrier there.
    if !cfg!(unix) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "personal environment Gateway requires Unix private-file validation",
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid());
        }
    }
    Ok(())
}
fn read_private(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    private_regular_file(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    Ok(bytes)
}
pub(super) fn read_token(path: &Path) -> io::Result<String> {
    let token = String::from_utf8(read_private(path, 512)?).map_err(|_| invalid())?;
    let token = token.trim_end_matches(['\n', '\r']);
    if !(32..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(invalid());
    }
    Ok(token.to_owned())
}

fn deserialize_url<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<reqwest::Url, D::Error> {
    let value = String::deserialize(deserializer)?;
    value
        .parse()
        .map_err(|_| serde::de::Error::custom("invalid environment URL"))
}

#[cfg(all(test, not(unix)))]
mod platform_tests {
    #[test]
    fn unsupported_private_file_boundary_never_claims_windows_acl_validation() {
        assert_eq!(
            super::private_regular_file(std::path::Path::new("not-opened"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::Unsupported
        );
    }
}
