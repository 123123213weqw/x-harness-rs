//! Optional static tool metadata for UI servers. Reading never starts a process.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]
use crate::{PluginError, PluginManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::Read, path::Path};

// A package convention, not a model/caller-selected filesystem path.
const PATH: &str = "dist/tools.json";
const MAX_BYTES: u64 = 256 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
    #[serde(default, rename = "_meta", skip_serializing)]
    meta: Option<Value>,
}
fn invalid() -> PluginError {
    PluginError::Invalid(
        "invalid or changed static panel tool catalog; reinstall the verified plugin".into(),
    )
}
fn read(root: &Path) -> Result<Vec<u8>, PluginError> {
    let path = root.join(PATH);
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.file_type().is_file()
        || metadata.len() > MAX_BYTES
        || !fs::canonicalize(&path)?.starts_with(fs::canonicalize(root)?)
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES as usize {
        return Err(invalid());
    }
    Ok(bytes)
}
fn parse(bytes: &[u8]) -> Result<Vec<PanelTool>, PluginError> {
    let tools: Vec<PanelTool> = serde_json::from_slice(bytes)?;
    let mut names = BTreeSet::new();
    if tools.len() > 64
        || tools.iter().any(|tool| {
            tool.name.is_empty()
                || tool.name.len() > 128
                || !tool
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                || !names.insert(&tool.name)
                || !tool.input_schema.is_object()
                || tool.input_schema.to_string().len() > 32 * 1024
        })
    {
        return Err(invalid());
    }
    Ok(tools
        .into_iter()
        .filter(|tool| {
            !tool
                .meta
                .as_ref()
                .and_then(|m| m.get("ui"))
                .and_then(|ui| ui.get("visibility"))
                .and_then(Value::as_array)
                .is_some_and(|v| v.len() == 1 && v[0] == "app")
        })
        .map(|mut tool| {
            tool.description = tool.description.chars().take(2000).collect();
            tool
        })
        .collect())
}
pub(crate) fn inspect(root: &Path, has_panel: bool) -> Result<Option<String>, PluginError> {
    if !has_panel || !root.join(PATH).try_exists()? {
        return Ok(None);
    }
    let bytes = read(root)?;
    parse(&bytes)?;
    Ok(Some(format!("{:x}", Sha256::digest(&bytes))))
}
impl PluginManager {
    /// Pin captured from the catalog-verified archive, never from discovery.
    /// Older installations without a pin fail closed and may be reinstalled.
    pub async fn panel_tools(
        &self,
        plugin: &str,
        server: &str,
    ) -> Result<Vec<PanelTool>, PluginError> {
        let expected = self
            .state
            .lock()
            .await
            .installed
            .get(plugin)
            .filter(|p| p.mcp_enabled)
            .and_then(|p| p.panel_tools_sha256.clone())
            .ok_or_else(invalid)?;
        let panel = self.panel(plugin).await?;
        if panel.manifest.server != server {
            return Err(invalid());
        }
        let bytes = read(&panel.root)?;
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err(invalid());
        }
        Ok(parse(&bytes)?
            .into_iter()
            .filter(|t| t.name != panel.manifest.open_tool)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounded_validated_catalog_hides_app_tools_and_never_executes() {
        let valid = json!([
            {"name":"inspect","description":"Read","inputSchema":{"type":"object"}},
            {"name":"reply","inputSchema":{},"_meta":{"ui":{"visibility":["app"]}}}
        ]);
        let tools = parse(valid.to_string().as_bytes()).unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "inspect");
        assert!(serde_json::to_value(&tools[0])
            .unwrap()
            .get("_meta")
            .is_none());
        for bad in [
            json!({}),
            json!([valid[0].clone(), valid[0].clone()]),
            json!([{"name":"../evil","inputSchema":{}}]),
            json!([{"name":"bad","inputSchema":[]}]),
        ] {
            assert!(parse(bad.to_string().as_bytes()).is_err());
        }
        let many = (0..65)
            .map(|i| json!({"name":format!("t{i}"),"inputSchema":{}}))
            .collect::<Vec<_>>();
        assert!(parse(serde_json::to_vec(&many).unwrap().as_slice()).is_err());
        assert!(parse(
            json!([{"name":"large","inputSchema":{"description":"x".repeat(32*1024)}}])
                .to_string()
                .as_bytes()
        )
        .is_err());
        let long = parse(
            json!([{"name":"long","description":"文".repeat(2100),"inputSchema":{}}])
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(long[0].description.chars().count(), 2000);
        let root = std::env::temp_dir().join(format!("xh-static-tools-{}", crate::nonce()));
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join(PATH), valid.to_string()).unwrap();
        let pin = inspect(&root, true).unwrap().unwrap();
        assert_eq!(pin, format!("{:x}", Sha256::digest(read(&root).unwrap())));
        assert!(inspect(&root, false).unwrap().is_none());
        fs::write(root.join(PATH), vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert!(inspect(&root, true).is_err());
        #[cfg(unix)]
        {
            fs::remove_file(root.join(PATH)).unwrap();
            std::os::unix::fs::symlink("/etc/passwd", root.join(PATH)).unwrap();
            assert!(inspect(&root, true).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
