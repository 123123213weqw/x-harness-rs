//! User-installed plugin data. No third-party JavaScript or executable code is
//! loaded into the Host. Install is explicit, hash-checked and transactional;
//! only SKILL.md is an active capability in this crate.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

mod mcp_config;
pub use mcp_config::{McpServerPreview, McpServerSpec};

const MAX_CATALOG: usize = 2 * 1024 * 1024;
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const MAX_SKILL: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("invalid plugin data: {0}")]
    Invalid(String),
    #[error("plugin not found: {0}")]
    NotFound(String),
    #[error("plugin operation failed: {0}")]
    Operation(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub name: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub description_i18n: BTreeMap<String, String>,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub source: PackageSource,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageSource {
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct CatalogDocument {
    plugins: Vec<CatalogEntry>,
}
fn default_scope() -> String {
    "public".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub name: String,
    pub description: String,
    pub relative_path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub name: String,
    pub version: String,
    pub description: String,
    pub digest: String,
    pub enabled: bool,
    #[serde(default)]
    pub mcp_enabled: bool,
    #[serde(default)]
    pub mcp_config_sha256: Option<String>,
    pub capabilities: Vec<String>,
    pub skills: Vec<SkillRecord>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdate {
    pub name: String,
    pub installed_version: String,
    pub available_version: String,
    pub available_digest: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    catalog: Vec<CatalogEntry>,
    #[serde(default)]
    installed: BTreeMap<String, InstalledPlugin>,
}

pub struct PluginManager {
    root: PathBuf,
    state: Mutex<State>,
    mutation: Mutex<()>,
}
impl PluginManager {
    pub fn open(root: PathBuf) -> Result<Self, PluginError> {
        fs::create_dir_all(&root)?;
        let state = load_state(&root)?;
        cleanup_stale_packages(&root, &state);
        Ok(Self {
            root,
            state: Mutex::new(state),
            mutation: Mutex::new(()),
        })
    }
    pub async fn catalog(&self) -> Vec<CatalogEntry> {
        self.state.lock().await.catalog.clone()
    }
    pub async fn installed(&self) -> Vec<InstalledPlugin> {
        self.state
            .lock()
            .await
            .installed
            .values()
            .cloned()
            .collect()
    }
    pub async fn updates(&self) -> Vec<PluginUpdate> {
        let state = self.state.lock().await;
        state
            .catalog
            .iter()
            .filter_map(|entry| {
                let current = state.installed.get(&entry.name)?;
                if current.digest.eq_ignore_ascii_case(&entry.source.sha256) {
                    return None;
                }
                Some(PluginUpdate {
                    name: entry.name.clone(),
                    installed_version: current.version.clone(),
                    available_version: entry.version.clone(),
                    available_digest: entry.source.sha256.clone(),
                })
            })
            .collect()
    }
    pub async fn import_catalog(&self, content: &str) -> Result<Vec<CatalogEntry>, PluginError> {
        self.import_catalog_scoped(content, "public").await
    }
    pub async fn import_catalog_scoped(
        &self,
        content: &str,
        scope: &str,
    ) -> Result<Vec<CatalogEntry>, PluginError> {
        if !matches!(scope, "public" | "personal") {
            return Err(PluginError::Invalid(
                "catalog scope must be public or personal".into(),
            ));
        }
        if content.len() > MAX_CATALOG {
            return Err(PluginError::Invalid("catalog exceeds 2 MiB".into()));
        }
        let mut document: CatalogDocument = serde_json::from_str(content)?;
        if document.plugins.len() > 1000 {
            return Err(PluginError::Invalid("too many catalog entries".into()));
        }
        let mut names = BTreeSet::new();
        for item in &mut document.plugins {
            item.scope = scope.into();
            valid_id(&item.name)?;
            if !names.insert(&item.name) {
                return Err(PluginError::Invalid(format!(
                    "duplicate plugin {}",
                    item.name
                )));
            }
            validate_source(&item.source)?;
        }
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        if let Some(conflict) = state
            .catalog
            .iter()
            .find(|item| item.scope != scope && names.contains(&item.name))
        {
            return Err(PluginError::Invalid(format!(
                "plugin {} already exists in another catalog",
                conflict.name
            )));
        }
        let mut next = state.clone();
        next.catalog.retain(|item| item.scope != scope);
        next.catalog.extend(document.plugins.clone());
        save_state(&self.root, &next)?;
        *state = next;
        Ok(document.plugins)
    }
    pub async fn install(&self, name: &str) -> Result<InstalledPlugin, PluginError> {
        valid_id(name)?;
        // Mutations are serialized, but catalog and installed reads stay live
        // while the network download is in flight.
        let _mutation = self.mutation.lock().await;
        let entry = {
            let state = self.state.lock().await;
            state
                .catalog
                .iter()
                .find(|item| item.name == name)
                .cloned()
                .ok_or_else(|| PluginError::NotFound(name.into()))?
        };
        validate_source(&entry.source)?;
        let client = pinned_client(&entry.source.url).await?;
        let response = client
            .get(&entry.source.url)
            .send()
            .await
            .map_err(|e| PluginError::Operation(format!("download failed: {e}")))?;
        if !response.status().is_success() {
            return Err(PluginError::Operation(format!(
                "download returned {}",
                response.status()
            )));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_ARCHIVE as u64)
        {
            return Err(PluginError::Invalid("archive exceeds 64 MiB".into()));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| PluginError::Operation(e.to_string()))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_ARCHIVE {
                return Err(PluginError::Invalid("archive exceeds 64 MiB".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut state = self.state.lock().await;
        self.publish_archive(name, &entry, &bytes, &mut state)
    }
    /// Offline installation still requires a catalog-pinned SHA-256. No
    /// caller-provided archive can bypass the same inspection transaction.
    pub async fn install_verified_archive(
        &self,
        name: &str,
        bytes: &[u8],
    ) -> Result<InstalledPlugin, PluginError> {
        valid_id(name)?;
        if bytes.len() > MAX_ARCHIVE {
            return Err(PluginError::Invalid("archive exceeds 64 MiB".into()));
        }
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let entry = state
            .catalog
            .iter()
            .find(|item| item.name == name)
            .cloned()
            .ok_or_else(|| PluginError::NotFound(name.into()))?;
        self.publish_archive(name, &entry, bytes, &mut state)
    }
    fn publish_archive(
        &self,
        name: &str,
        entry: &CatalogEntry,
        bytes: &[u8],
        state: &mut State,
    ) -> Result<InstalledPlugin, PluginError> {
        let digest = format!("{:x}", Sha256::digest(bytes));
        if !digest.eq_ignore_ascii_case(&entry.source.sha256) {
            return Err(PluginError::Invalid(
                "archive SHA-256 does not match catalog".into(),
            ));
        }
        let staging = self
            .root
            .join(format!(".stage-{}-{}", std::process::id(), nonce()));
        fs::create_dir(&staging)?;
        let result = (|| -> Result<InstalledPlugin, PluginError> {
            extract_zip(bytes, &staging)?;
            let package_root = find_package_root(&staging)?;
            let capabilities = inspect_capabilities(&package_root, name)?;
            let mcp_config_sha256 = if package_root.join(".mcp.json").is_file() {
                Some(format!(
                    "{:x}",
                    Sha256::digest(fs::read(package_root.join(".mcp.json"))?)
                ))
            } else {
                None
            };
            let skills = discover_skills(&package_root)?;
            let published = self.root.join("packages").join(name).join(&digest);
            fs::create_dir_all(published.parent().unwrap())?;
            if !published.exists() {
                fs::rename(&package_root, &published)?;
            }
            let installed = InstalledPlugin {
                name: name.into(),
                version: entry.version.clone(),
                description: entry.description.clone(),
                digest,
                enabled: false,
                mcp_enabled: false,
                mcp_config_sha256,
                capabilities,
                skills,
            };
            let mut next = state.clone();
            next.installed.insert(name.into(), installed.clone());
            save_state(&self.root, &next)?;
            *state = next;
            Ok(installed)
        })();
        let _ = fs::remove_dir_all(&staging);
        result
    }
    pub async fn set_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<InstalledPlugin, PluginError> {
        valid_id(name)?;
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        let item = next
            .installed
            .get_mut(name)
            .ok_or_else(|| PluginError::NotFound(name.into()))?;
        if enabled && item.skills.is_empty() {
            return Err(PluginError::Invalid(
                "this package has no supported Skill capability".into(),
            ));
        }
        item.enabled = enabled;
        let result = item.clone();
        save_state(&self.root, &next)?;
        *state = next;
        Ok(result)
    }
    /// MCP authorization is separate from Skill enablement. This only persists
    /// the user's explicit opt-in; no process is started until an agent needs it.
    pub async fn set_mcp_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<InstalledPlugin, PluginError> {
        valid_id(name)?;
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        let item = next
            .installed
            .get_mut(name)
            .ok_or_else(|| PluginError::NotFound(name.into()))?;
        if enabled {
            self.parse_mcp_servers(item)?;
        }
        item.mcp_enabled = enabled;
        let result = item.clone();
        save_state(&self.root, &next)?;
        *state = next;
        Ok(result)
    }
    pub async fn mcp_preview(&self, name: &str) -> Result<Vec<McpServerPreview>, PluginError> {
        valid_id(name)?;
        let state = self.state.lock().await;
        let item = state
            .installed
            .get(name)
            .ok_or_else(|| PluginError::NotFound(name.into()))?;
        self.parse_mcp_servers(item)
            .map(|items| items.into_iter().map(|item| item.preview()).collect())
    }
    pub async fn enabled_mcp_plugins(&self) -> Vec<String> {
        self.state
            .lock()
            .await
            .installed
            .values()
            .filter(|item| item.mcp_enabled)
            .map(|item| item.name.clone())
            .collect()
    }
    pub async fn mcp_server(
        &self,
        plugin: &str,
        server: &str,
    ) -> Result<McpServerSpec, PluginError> {
        valid_id(plugin)?;
        if !mcp_config::valid_server_id(server) {
            return Err(PluginError::Invalid("unsafe MCP server name".into()));
        }
        let state = self.state.lock().await;
        let item = state
            .installed
            .get(plugin)
            .filter(|item| item.mcp_enabled)
            .ok_or_else(|| PluginError::NotFound(format!("MCP permission for {plugin}")))?;
        self.parse_mcp_servers(item)?
            .into_iter()
            .find(|item| item.server == server)
            .ok_or_else(|| PluginError::NotFound(format!("MCP server {server}")))
    }
    fn parse_mcp_servers(&self, item: &InstalledPlugin) -> Result<Vec<McpServerSpec>, PluginError> {
        let expected = item.mcp_config_sha256.as_ref().ok_or_else(|| {
            PluginError::Invalid(
                "this installation has no verified .mcp.json; reinstall to enable MCP".into(),
            )
        })?;
        let root = self
            .root
            .join("packages")
            .join(&item.name)
            .join(&item.digest);
        let file = root.join(".mcp.json");
        let metadata = fs::symlink_metadata(&file)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL {
            return Err(PluginError::Invalid(
                "MCP config must be a bounded regular file".into(),
            ));
        }
        let bytes = fs::read(&file)?;
        if format!("{:x}", Sha256::digest(&bytes)) != *expected {
            return Err(PluginError::Invalid(
                "installed MCP config changed after verification".into(),
            ));
        }
        mcp_config::parse(&item.name, &item.digest, &root, &bytes)
    }
    pub async fn uninstall(&self, name: &str) -> Result<(), PluginError> {
        valid_id(name)?;
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        let removed = next
            .installed
            .remove(name)
            .ok_or_else(|| PluginError::NotFound(name.into()))?;
        save_state(&self.root, &next)?;
        *state = next;
        // A turn may retain a snapshot; its read fails closed after removal.
        let _ = fs::remove_dir_all(self.root.join("packages").join(name).join(removed.digest));
        Ok(())
    }
    pub async fn enabled_skills(&self) -> Vec<(String, SkillRecord)> {
        self.state
            .lock()
            .await
            .installed
            .values()
            .filter(|p| p.enabled)
            .flat_map(|p| {
                p.skills
                    .iter()
                    .cloned()
                    .map(|s| (p.name.clone(), s))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    pub async fn read_skill(&self, plugin: &str, skill: &str) -> Result<String, PluginError> {
        valid_id(plugin)?;
        valid_id(skill)?;
        let state = self.state.lock().await;
        let item = state
            .installed
            .get(plugin)
            .filter(|p| p.enabled)
            .ok_or_else(|| PluginError::NotFound(format!("enabled plugin {plugin}")))?;
        let record = item
            .skills
            .iter()
            .find(|s| s.name == skill)
            .ok_or_else(|| PluginError::NotFound(format!("skill {skill}")))?;
        let package_root = self.root.join("packages").join(plugin).join(&item.digest);
        let path = package_root.join(&record.relative_path);
        let canonical_root = fs::canonicalize(package_root)?;
        let canonical_path = fs::canonicalize(&path)?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(PluginError::Invalid("skill escaped its package".into()));
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL {
            return Err(PluginError::Invalid(
                "skill is not a bounded regular file".into(),
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(canonical_path)?
            .take(MAX_SKILL + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SKILL {
            return Err(PluginError::Invalid("Skill exceeds 64 KiB".into()));
        }
        if format!("{:x}", Sha256::digest(&bytes)) != record.sha256 {
            return Err(PluginError::Invalid(
                "installed Skill content changed after verification".into(),
            ));
        }
        String::from_utf8(bytes).map_err(|e| PluginError::Invalid(e.to_string()))
    }
    /// Read a textual Skill dependency without granting the plugin code
    /// execution or exposing files outside its verified installation root.
    pub async fn read_resource(&self, plugin: &str, relative: &str) -> Result<String, PluginError> {
        valid_id(plugin)?;
        let path = Path::new(relative);
        let parts = path.components().collect::<Vec<_>>();
        if parts.len() < 2
            || parts
                .iter()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(PluginError::Invalid(
                "resource path must be relative and contained".into(),
            ));
        }
        let top = parts[0].as_os_str().to_string_lossy();
        if !matches!(top.as_ref(), "references" | "scripts" | "skills") {
            return Err(PluginError::Invalid(
                "resource is outside supported Skill assets".into(),
            ));
        }
        let extension = path
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or("");
        if !matches!(extension, "md" | "txt" | "json" | "py" | "sh" | "js" | "ts") {
            return Err(PluginError::Invalid(
                "resource is not a supported text file".into(),
            ));
        }
        let state = self.state.lock().await;
        let item = state
            .installed
            .get(plugin)
            .filter(|item| item.enabled)
            .ok_or_else(|| PluginError::NotFound(format!("enabled plugin {plugin}")))?;
        let base = self.root.join("packages").join(plugin).join(&item.digest);
        let canonical_base = fs::canonicalize(base)?;
        let canonical_path = fs::canonicalize(canonical_base.join(path))?;
        if !canonical_path.starts_with(&canonical_base) {
            return Err(PluginError::Invalid("resource escaped its package".into()));
        }
        let metadata = fs::symlink_metadata(&canonical_path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL {
            return Err(PluginError::Invalid(
                "resource is not a bounded regular file".into(),
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(canonical_path)?
            .take(MAX_SKILL + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SKILL {
            return Err(PluginError::Invalid("resource exceeds 64 KiB".into()));
        }
        String::from_utf8(bytes).map_err(|e| PluginError::Invalid(e.to_string()))
    }
}

fn valid_id(value: &str) -> Result<(), PluginError> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(PluginError::Invalid(format!(
            "unsafe plugin/skill identifier {value:?}"
        )));
    }
    Ok(())
}
fn validate_source(source: &PackageSource) -> Result<(), PluginError> {
    if source.source != "url"
        || source.kind != "zip"
        || source.sha256.len() != 64
        || !source.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(PluginError::Invalid(
            "only SHA-256 pinned URL zip packages are supported".into(),
        ));
    }
    let url = reqwest::Url::parse(&source.url).map_err(|e| PluginError::Invalid(e.to_string()))?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(PluginError::Invalid(
            "package URL must be plain HTTPS without credentials or custom port".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| PluginError::Invalid("URL has no host".into()))?;
    if host == "localhost" || host.ends_with(".local") || host.parse::<IpAddr>().is_ok() {
        return Err(PluginError::Invalid(
            "local or literal-IP package URLs are denied".into(),
        ));
    }
    Ok(())
}
async fn pinned_client(raw_url: &str) -> Result<reqwest::Client, PluginError> {
    let url = reqwest::Url::parse(raw_url).map_err(|e| PluginError::Invalid(e.to_string()))?;
    let host = url
        .host_str()
        .ok_or_else(|| PluginError::Invalid("URL has no host".into()))?;
    let address = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|e| PluginError::Operation(format!("package DNS failed: {e}")))?
        .find(|addr| public_ip(addr.ip()))
        .ok_or_else(|| PluginError::Invalid("package host has no public address".into()))?;
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(90))
        // Pin the validated address; a second DNS lookup must not turn the
        // user-imported catalog into a request to a private service.
        .resolve(host, SocketAddr::new(address.ip(), 443))
        .build()
        .map_err(|e| PluginError::Operation(e.to_string()))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || b == 2))
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] == 0x0010))
        }
    }
}
fn extract_zip(bytes: &[u8], root: &Path) -> Result<(), PluginError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| PluginError::Invalid(e.to_string()))?;
    if archive.len() > MAX_FILES {
        return Err(PluginError::Invalid("too many archive members".into()));
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut member = archive
            .by_index(index)
            .map_err(|e| PluginError::Invalid(e.to_string()))?;
        total = total.saturating_add(member.size());
        if total > MAX_EXTRACTED {
            return Err(PluginError::Invalid(
                "expanded archive exceeds 128 MiB".into(),
            ));
        }
        let relative = member
            .enclosed_name()
            .ok_or_else(|| PluginError::Invalid("unsafe archive path".into()))?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(PluginError::Invalid("unsafe archive path".into()));
        }
        let mode = member.unix_mode().unwrap_or(0);
        if (mode & 0o170000) == 0o120000 {
            return Err(PluginError::Invalid("archive symlink denied".into()));
        }
        let path = root.join(relative);
        if member.is_dir() {
            fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        std::io::copy(&mut member, &mut file)?;
    }
    Ok(())
}
fn find_package_root(root: &Path) -> Result<PathBuf, PluginError> {
    if root.join(".zcode-plugin/plugin.json").is_file()
        || root.join(".claude-plugin/plugin.json").is_file()
    {
        return Ok(root.into());
    }
    let candidates = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .collect::<Vec<_>>();
    if candidates.len() == 1 {
        let nested = candidates[0].path();
        if nested.join(".zcode-plugin/plugin.json").is_file()
            || nested.join(".claude-plugin/plugin.json").is_file()
        {
            return Ok(nested);
        }
    }
    Err(PluginError::Invalid(
        "plugin.json not found at archive root".into(),
    ))
}
fn inspect_capabilities(root: &Path, expected_name: &str) -> Result<Vec<String>, PluginError> {
    let manifest = if root.join(".zcode-plugin/plugin.json").is_file() {
        root.join(".zcode-plugin/plugin.json")
    } else {
        root.join(".claude-plugin/plugin.json")
    };
    let metadata = fs::metadata(&manifest)?;
    if metadata.len() > MAX_SKILL {
        return Err(PluginError::Invalid("manifest too large".into()));
    }
    let document: serde_json::Value = serde_json::from_slice(&fs::read(manifest)?)?;
    if document.get("name").and_then(serde_json::Value::as_str) != Some(expected_name) {
        return Err(PluginError::Invalid(
            "package name does not match catalog".into(),
        ));
    }
    let mut capabilities = Vec::new();
    for (directory, name) in [
        ("skills", "skills"),
        ("commands", "commands"),
        ("agents", "agents"),
        ("hooks", "hooks"),
        (".mcp.json", "mcp"),
    ] {
        if root.join(directory).exists() {
            capabilities.push(name.into());
        }
    }
    Ok(capabilities)
}
fn discover_skills(root: &Path) -> Result<Vec<SkillRecord>, PluginError> {
    let directory = root.join("skills");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        valid_id(&name)?;
        let relative = PathBuf::from("skills").join(&name).join("SKILL.md");
        let path = root.join(&relative);
        if !path.is_file() {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL {
            return Err(PluginError::Invalid(format!(
                "skill {name} is too large or unsafe"
            )));
        }
        let content = fs::read_to_string(path)?;
        let description = skill_description(&content).unwrap_or_else(|| name.clone());
        found.push(SkillRecord {
            name,
            description,
            relative_path: relative.to_string_lossy().into_owned(),
            sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}
fn skill_description(content: &str) -> Option<String> {
    if !content.starts_with("---\n") {
        return None;
    }
    content
        .lines()
        .skip(1)
        .take_while(|line| *line != "---")
        .find_map(|line| {
            line.strip_prefix("description:")
                .map(|value| value.trim().trim_matches('"').to_owned())
        })
        .filter(|value| !value.is_empty())
}
fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        + NEXT.fetch_add(1, Ordering::Relaxed) as u128
}
fn save_state(root: &Path, state: &State) -> Result<(), PluginError> {
    validate_state(state)?;
    let revision = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix("state-")?
                .strip_suffix(".json")?
                .parse::<u64>()
                .ok()
        })
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| PluginError::Invalid("plugin state revision overflow".into()))?;
    let name = format!("state-{revision:020}.json");
    let tmp = root.join(format!(".{name}.tmp"));
    let final_path = root.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    file.write_all(&serde_json::to_vec(state)?)?;
    file.sync_all()?;
    fs::rename(tmp, final_path)?;
    if let Ok(dir) = fs::File::open(root) {
        let _ = dir.sync_all();
    }
    let mut snapshots = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("state-")
                && e.file_name().to_string_lossy().ends_with(".json")
        })
        .map(|e| e.path())
        .collect::<Vec<_>>();
    snapshots.sort();
    if snapshots.len() > 10 {
        for old in &snapshots[..snapshots.len() - 10] {
            let _ = fs::remove_file(old);
        }
    }
    Ok(())
}
fn load_state(root: &Path) -> Result<State, PluginError> {
    let mut snapshots = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("state-")
                && e.file_name().to_string_lossy().ends_with(".json")
        })
        .map(|e| e.path())
        .collect::<Vec<_>>();
    snapshots.sort();
    for path in snapshots.iter().rev() {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(state) = serde_json::from_slice(&bytes) {
                if validate_state(&state).is_ok() {
                    return Ok(state);
                }
            }
        }
    }
    if snapshots.is_empty() {
        Ok(State::default())
    } else {
        Err(PluginError::Invalid(
            "all plugin state snapshots are unreadable".into(),
        ))
    }
}
fn validate_state(state: &State) -> Result<(), PluginError> {
    let mut names = BTreeSet::new();
    for item in &state.catalog {
        valid_id(&item.name)?;
        if !matches!(item.scope.as_str(), "public" | "personal") || !names.insert(&item.name) {
            return Err(PluginError::Invalid(
                "duplicate plugin or invalid catalog scope".into(),
            ));
        }
        validate_source(&item.source)?;
    }
    for (key, item) in &state.installed {
        valid_id(key)?;
        if key != &item.name
            || item.digest.len() != 64
            || !item.digest.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(PluginError::Invalid(
                "invalid installed plugin identity".into(),
            ));
        }
        if item
            .mcp_config_sha256
            .as_ref()
            .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()))
            || (item.mcp_enabled && item.mcp_config_sha256.is_none())
        {
            return Err(PluginError::Invalid(
                "invalid installed MCP configuration identity".into(),
            ));
        }
        for skill in &item.skills {
            valid_id(&skill.name)?;
            if skill.sha256.len() != 64
                || !skill.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || Path::new(&skill.relative_path)
                    != PathBuf::from("skills").join(&skill.name).join("SKILL.md")
            {
                return Err(PluginError::Invalid(
                    "invalid installed Skill record".into(),
                ));
            }
        }
    }
    Ok(())
}
fn cleanup_stale_packages(root: &Path, state: &State) {
    let packages = root.join("packages");
    if let Ok(names) = fs::read_dir(packages) {
        for name in names.filter_map(Result::ok) {
            let id = name.file_name().to_string_lossy().into_owned();
            if valid_id(&id).is_err() || !name.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Ok(digests) = fs::read_dir(name.path()) {
                for entry in digests.filter_map(Result::ok) {
                    let digest = entry.file_name().to_string_lossy().into_owned();
                    if digest.len() == 64
                        && digest.bytes().all(|c| c.is_ascii_hexdigit())
                        && !state
                            .installed
                            .get(&id)
                            .is_some_and(|item| item.digest == digest)
                        && entry.file_type().is_ok_and(|kind| kind.is_dir())
                    {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.filter_map(Result::ok) {
            if entry.file_name().to_string_lossy().starts_with(".stage-")
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_catalog_and_duplicates() {
        let invalid = PackageSource {
            source: "url".into(),
            kind: "zip".into(),
            url: "https://localhost/x.zip".into(),
            sha256: "a".repeat(64),
        };
        assert!(validate_source(&invalid).is_err());
        assert!(valid_id("../escape").is_err());
    }
    #[test]
    fn snapshot_recovers_from_partial_latest() {
        let root = std::env::temp_dir().join(format!("xh-plugin-test-{}", nonce()));
        fs::create_dir_all(&root).unwrap();
        save_state(&root, &State::default()).unwrap();
        fs::write(root.join("state-99999999999999999999.json"), b"{").unwrap();
        assert!(load_state(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_zip_traversal() {
        let root = std::env::temp_dir().join(format!("xh-plugin-zip-{}", nonce()));
        fs::create_dir_all(&root).unwrap();
        let mut output = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            zip.start_file("../escape", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        assert!(extract_zip(&output.into_inner(), &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn catalog_install_enable_read_restart_disable_uninstall() {
        let root = std::env::temp_dir().join(format!("xh-plugin-lifecycle-{}", nonce()));
        let skill_text = b"---\ndescription: Release safely\n---\nFollow the release checklist.";
        let mut output = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("demo/.zcode-plugin/plugin.json", options)
                .unwrap();
            zip.write_all(br#"{"name":"demo","version":"1.0"}"#)
                .unwrap();
            zip.start_file("demo/skills/ship/SKILL.md", options)
                .unwrap();
            zip.write_all(skill_text).unwrap();
            zip.start_file("demo/references/checklist.md", options)
                .unwrap();
            zip.write_all(b"Check CI before release.").unwrap();
            zip.start_file("demo/.mcp.json", options).unwrap();
            zip.write_all(br#"{"mcpServers":{"local":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}}"#).unwrap();
            zip.finish().unwrap();
        }
        let bytes = output.into_inner();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let entry = CatalogEntry {
            name: "demo".into(),
            scope: "public".into(),
            description: "Demo".into(),
            description_i18n: BTreeMap::new(),
            version: "1.0".into(),
            category: "tools".into(),
            icon: None,
            source: PackageSource {
                source: "url".into(),
                kind: "zip".into(),
                url: "https://example.com/demo.zip".into(),
                sha256: digest.clone(),
            },
        };
        let manager = PluginManager::open(root.clone()).unwrap();
        manager
            .import_catalog(&serde_json::json!({"plugins":[entry.clone()]}).to_string())
            .await
            .unwrap();
        let mut state = manager.state.lock().await;
        assert!(manager
            .publish_archive(
                "demo",
                &CatalogEntry {
                    source: PackageSource {
                        sha256: "0".repeat(64),
                        ..entry.source.clone()
                    },
                    ..entry.clone()
                },
                &bytes,
                &mut state
            )
            .is_err());
        assert!(state.installed.is_empty());
        manager
            .publish_archive("demo", &entry, &bytes, &mut state)
            .unwrap();
        drop(state);
        assert!(!manager.installed().await[0].enabled);
        assert!(!manager.installed().await[0].mcp_enabled);
        assert_eq!(
            manager.mcp_preview("demo").await.unwrap()[0].server,
            "local"
        );
        manager.set_mcp_enabled("demo", true).await.unwrap();
        assert_eq!(
            manager.mcp_server("demo", "local").await.unwrap().command,
            "node"
        );
        assert!(manager.read_skill("demo", "ship").await.is_err());
        manager.set_enabled("demo", true).await.unwrap();
        assert!(manager
            .read_skill("demo", "ship")
            .await
            .unwrap()
            .contains("release checklist"));
        assert!(manager
            .read_resource("demo", "references/checklist.md")
            .await
            .unwrap()
            .contains("Check CI"));
        assert!(manager
            .read_resource("demo", "../outside.txt")
            .await
            .is_err());
        let skill_path = root
            .join("packages/demo")
            .join(&digest)
            .join("skills/ship/SKILL.md");
        fs::write(&skill_path, b"tampered").unwrap();
        assert!(manager.read_skill("demo", "ship").await.is_err());
        fs::write(skill_path, skill_text).unwrap();
        let restarted = PluginManager::open(root.clone()).unwrap();
        assert_eq!(restarted.enabled_skills().await.len(), 1);
        assert_eq!(restarted.enabled_mcp_plugins().await, vec!["demo"]);
        let mcp_path = root.join("packages/demo").join(&digest).join(".mcp.json");
        let mcp_text = fs::read(&mcp_path).unwrap();
        fs::write(&mcp_path, b"{}").unwrap();
        assert!(restarted.mcp_server("demo", "local").await.is_err());
        fs::write(mcp_path, mcp_text).unwrap();
        assert!(restarted
            .import_catalog_scoped(
                &serde_json::json!({"plugins":[entry.clone()]}).to_string(),
                "personal"
            )
            .await
            .is_err());
        let personal = CatalogEntry {
            name: "other".into(),
            ..entry.clone()
        };
        restarted
            .import_catalog_scoped(
                &serde_json::json!({"plugins":[personal]}).to_string(),
                "personal",
            )
            .await
            .unwrap();
        assert_eq!(restarted.catalog().await.len(), 2);
        let newer = CatalogEntry {
            version: "2.0".into(),
            source: PackageSource {
                sha256: "b".repeat(64),
                ..entry.source.clone()
            },
            ..entry.clone()
        };
        restarted
            .import_catalog(&serde_json::json!({"plugins":[newer]}).to_string())
            .await
            .unwrap();
        assert_eq!(restarted.updates().await[0].available_version, "2.0");
        restarted.set_enabled("demo", false).await.unwrap();
        restarted.set_mcp_enabled("demo", false).await.unwrap();
        assert!(restarted.read_skill("demo", "ship").await.is_err());
        restarted.uninstall("demo").await.unwrap();
        assert!(PluginManager::open(root.clone())
            .unwrap()
            .installed()
            .await
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blocks_non_public_ip_ranges() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.2.4",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "fe80::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
    }
    #[tokio::test]
    #[ignore = "requires an explicit local catalog path and network access"]
    async fn live_pinned_marketplace_package() {
        let catalog_path = std::env::var("XHARNESS_TEST_MARKETPLACE").expect("set catalog path");
        let root = std::env::temp_dir().join(format!("xh-plugin-live-{}", nonce()));
        let manager = PluginManager::open(root.clone()).unwrap();
        manager
            .import_catalog(&fs::read_to_string(catalog_path).unwrap())
            .await
            .unwrap();
        let installed = manager.install("github").await.unwrap();
        assert!(!installed.skills.is_empty());
        manager.set_enabled("github", true).await.unwrap();
        assert!(!manager.read_skill("github", "pr").await.unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
