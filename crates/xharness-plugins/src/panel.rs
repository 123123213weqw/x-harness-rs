//! Pinned optional UI resources. Installation never enables or executes a panel.
#![forbid(unsafe_code)]
use crate::{PluginError, PluginManager, MAX_SKILL};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelAsset {
    pub bytes: u64,
    pub sha256: String,
    pub mime: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelManifest {
    pub version: u32,
    pub server: String,
    pub resource_uri: String,
    pub entry: String,
    pub title: String,
    pub open_tool: String,
    pub assets: BTreeMap<String, PanelAsset>,
}
#[derive(Clone, Debug)]
pub struct VerifiedPanel {
    pub root: PathBuf,
    pub manifest: PanelManifest,
    pub digest: String,
}

fn invalid() -> PluginError {
    PluginError::Invalid("invalid or changed plugin panel resources".into())
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && !path.contains(['\\', '\0', ':', '?', '#'])
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
pub(crate) fn inspect(root: &Path, plugin: &str) -> Result<Option<String>, PluginError> {
    let path = root.join(".xharness-ui.json");
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path)?;
    if !meta.file_type().is_file() || meta.len() > MAX_SKILL {
        return Err(invalid());
    }
    let bytes = fs::read(path)?;
    let manifest: PanelManifest = serde_json::from_slice(&bytes)?;
    if manifest.version != 1
        || !crate::mcp_config::valid_server_id(&manifest.server)
        || !manifest
            .resource_uri
            .starts_with(&format!("ui://{plugin}/"))
        || manifest.title.is_empty()
        || manifest.title.len() > 100
        || !crate::mcp_config::valid_server_id(&manifest.open_tool)
        || manifest.assets.is_empty()
        || manifest.assets.len() > 128
        || !manifest.assets.contains_key(&manifest.entry)
    {
        return Err(invalid());
    }
    let verified = VerifiedPanel {
        root: root.to_owned(),
        manifest,
        digest: String::new(),
    };
    let mut total = 0u64;
    for (path, asset) in &verified.manifest.assets {
        total = total.saturating_add(asset.bytes);
        if !relative(path)
            || asset.bytes > 96 * 1024 * 1024
            || total > 128 * 1024 * 1024
            || asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || ![
                "text/html",
                "text/javascript",
                "application/wasm",
                "image/x-icon",
                "image/png",
                "application/json",
            ]
            .contains(&asset.mime.as_str())
        {
            return Err(invalid());
        }
        verified.open_asset(path)?;
    }
    if verified.manifest.assets[&verified.manifest.entry].mime != "text/html" {
        return Err(invalid());
    }
    Ok(Some(format!("{:x}", Sha256::digest(&bytes))))
}
impl VerifiedPanel {
    /// Hash the same file handle that the HTTP carrier will stream.
    pub fn open_asset(&self, path: &str) -> Result<(fs::File, PanelAsset), PluginError> {
        let asset = self.manifest.assets.get(path).ok_or_else(invalid)?.clone();
        let target = self.root.join(path);
        if !relative(path)
            || !fs::symlink_metadata(&target)?.file_type().is_file()
            || !fs::canonicalize(&target)?.starts_with(fs::canonicalize(&self.root)?)
        {
            return Err(invalid());
        }
        let mut file = fs::File::open(target)?;
        if file.metadata()?.len() != asset.bytes {
            return Err(invalid());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err(invalid());
        }
        file.rewind()?;
        Ok((file, asset))
    }
}
impl PluginManager {
    pub async fn has_panel(&self, plugin: &str) -> bool {
        self.state
            .lock()
            .await
            .installed
            .get(plugin)
            .is_some_and(|p| p.ui_config_sha256.is_some())
    }

    pub async fn panel(&self, plugin: &str) -> Result<VerifiedPanel, PluginError> {
        let state = self.state.lock().await;
        let item = state
            .installed
            .get(plugin)
            .filter(|item| item.mcp_enabled)
            .ok_or_else(|| PluginError::NotFound("plugin panel is not enabled".into()))?;
        let expected = item.ui_config_sha256.as_ref().ok_or_else(invalid)?;
        let root = self.root.join("packages").join(plugin).join(&item.digest);
        let path = root.join(".xharness-ui.json");
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_SKILL + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SKILL as usize || format!("{:x}", Sha256::digest(&bytes)) != *expected
        {
            return Err(invalid());
        }
        let manifest: PanelManifest = serde_json::from_slice(&bytes)?;
        Ok(VerifiedPanel {
            root,
            manifest,
            digest: item.digest.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn setup() -> PathBuf {
        let root = std::env::temp_dir().join(format!("xh-panel-assets-{}", crate::nonce()));
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/panel.html"), b"<html>editor</html>").unwrap();
        let meta = json!({"version":1,"server":"editor","resourceUri":"ui://demo/panel.html","entry":"dist/panel.html","title":"Editor","openTool":"open_editor","assets":{"dist/panel.html":{"bytes":19,"sha256":format!("{:x}",Sha256::digest(b"<html>editor</html>")),"mime":"text/html"}}});
        fs::write(root.join(".xharness-ui.json"), meta.to_string()).unwrap();
        root
    }
    #[test]
    fn absent_panel_remains_legacy_and_requires_no_resources() {
        let root = std::env::temp_dir().join(format!("xh-panel-absent-{}", crate::nonce()));
        fs::create_dir_all(&root).unwrap();
        assert!(inspect(&root, "demo").unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pinned_asset_changes_fail_closed() {
        let root = setup();
        assert!(inspect(&root, "demo").unwrap().is_some());
        fs::write(root.join("dist/panel.html"), b"<html>forged</html>").unwrap();
        assert!(inspect(&root, "demo").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn traversal_foreign_namespace_and_oversized_assets_rejected() {
        for (field, value) in [
            ("entry", json!("../escape")),
            ("resourceUri", json!("ui://foreign/panel.html")),
            ("version", json!(2)),
        ] {
            let root = setup();
            let p = root.join(".xharness-ui.json");
            let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
            v[field] = value;
            fs::write(p, v.to_string()).unwrap();
            assert!(inspect(&root, "demo").is_err());
            fs::remove_dir_all(root).unwrap();
        }
        assert!(!relative("../x"));
        assert!(!relative("a/../../x"));
        assert!(!relative("x\\y"));
        assert!(!relative("/absolute"));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_assets_never_stream() {
        let root = setup();
        fs::remove_file(root.join("dist/panel.html")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("dist/panel.html")).unwrap();
        assert!(inspect(&root, "demo").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
