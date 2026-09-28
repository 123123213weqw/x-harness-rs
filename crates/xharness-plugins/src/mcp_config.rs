//! Read an installed plugin's pinned `.mcp.json` without executing it.
//! Only local stdio entries are accepted in this first transport stage.

use crate::PluginError;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct McpServerSpec {
    pub plugin: String,
    pub server: String,
    pub digest: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerPreview {
    pub server: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    /// For each child variable, show the source without exposing its value.
    /// A plugin must not be able to hide a Host secret behind an innocuous key.
    pub env_sources: BTreeMap<String, String>,
}

impl McpServerSpec {
    pub fn preview(&self) -> McpServerPreview {
        McpServerPreview {
            server: self.server.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env_keys: self.env.keys().cloned().collect(),
            env_sources: self
                .env
                .iter()
                .map(|(key, value)| {
                    let source = if value == "${CLAUDE_PLUGIN_ROOT}" || value == "${PLUGIN_ROOT}" {
                        "plugin root".to_owned()
                    } else if value.starts_with("${") && value.ends_with('}') {
                        format!("Host environment: {}", &value[2..value.len() - 1])
                    } else {
                        "literal value in plugin configuration".to_owned()
                    };
                    (key.clone(), source)
                })
                .collect(),
        }
    }
    /// Resolve explicit `${NAME}` references only at launch time, never in
    /// persisted state or user-visible preview. No ambient env is inherited.
    pub fn resolved_env(&self) -> Result<BTreeMap<String, String>, PluginError> {
        self.env
            .iter()
            .map(|(key, value)| {
                let value = if value == "${CLAUDE_PLUGIN_ROOT}" || value == "${PLUGIN_ROOT}" {
                    self.cwd.to_string_lossy().into_owned()
                } else if value.starts_with("${") && value.ends_with('}') {
                    let name = &value[2..value.len() - 1];
                    if !valid_env_key(name) {
                        return Err(PluginError::Invalid(
                            "invalid MCP environment reference".into(),
                        ));
                    }
                    std::env::var(name).map_err(|_| {
                        PluginError::Invalid(format!(
                            "MCP environment variable {name} is not configured"
                        ))
                    })?
                } else {
                    value.clone()
                };
                Ok((key.clone(), value))
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct Document {
    #[serde(rename = "mcpServers")]
    servers: BTreeMap<String, Server>,
}
#[derive(Deserialize)]
struct Server {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

pub(crate) fn valid_server_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
fn valid_env_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit()))
}
fn expand_root(value: &str, root: &Path) -> Result<String, PluginError> {
    if value.len() > 4096 || value.contains('\0') {
        return Err(PluginError::Invalid(
            "MCP command token is too large or contains NUL".into(),
        ));
    }
    let root = root
        .to_str()
        .ok_or_else(|| PluginError::Invalid("plugin path is not UTF-8".into()))?;
    let result = value
        .replace("${CLAUDE_PLUGIN_ROOT}", root)
        .replace("${PLUGIN_ROOT}", root);
    if result.contains("${") {
        return Err(PluginError::Invalid(
            "unsupported MCP command interpolation".into(),
        ));
    }
    Ok(result)
}

pub(crate) fn parse(
    plugin: &str,
    digest: &str,
    root: &Path,
    bytes: &[u8],
) -> Result<Vec<McpServerSpec>, PluginError> {
    let document: Document = serde_json::from_slice(bytes)?;
    if document.servers.is_empty() || document.servers.len() > 8 {
        return Err(PluginError::Invalid(
            "MCP config must have 1 to 8 servers".into(),
        ));
    }
    document
        .servers
        .into_iter()
        .map(|(name, server)| {
            if !valid_server_id(&name) {
                return Err(PluginError::Invalid("unsafe MCP server name".into()));
            }
            if server.kind.as_deref().is_some_and(|kind| kind != "stdio")
                || server.command.is_none()
            {
                return Err(PluginError::Invalid(format!(
                    "MCP server {name} is not stdio"
                )));
            }
            if server.args.len() > 64 || server.env.len() > 64 {
                return Err(PluginError::Invalid(
                    "MCP arguments or environment exceed 64 entries".into(),
                ));
            }
            let command = expand_root(server.command.as_deref().unwrap_or_default(), root)?;
            if command.is_empty() {
                return Err(PluginError::Invalid("empty MCP command".into()));
            }
            let args = server
                .args
                .iter()
                .map(|arg| expand_root(arg, root))
                .collect::<Result<Vec<_>, _>>()?;
            for (key, value) in &server.env {
                if !valid_env_key(key) || value.len() > 4096 || value.contains('\0') {
                    return Err(PluginError::Invalid(
                        "invalid MCP environment key or value".into(),
                    ));
                }
            }
            Ok(McpServerSpec {
                plugin: plugin.into(),
                server: name,
                digest: digest.into(),
                command,
                args,
                env: server.env,
                cwd: root.to_path_buf(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stdio_config_rejects_remote_and_interpolation() {
        let root = Path::new("/tmp/plugin");
        let ok = parse("demo", "abcd", root, br#"{"mcpServers":{"local":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"],"env":{"TOKEN":"${TOKEN}"}}}}"#).unwrap();
        assert_eq!(ok[0].server, "local");
        assert_eq!(ok[0].args, vec!["/tmp/plugin/server.js"]);
        assert_eq!(ok[0].preview().env_keys, vec!["TOKEN"]);
        assert_eq!(
            ok[0].preview().env_sources["TOKEN"],
            "Host environment: TOKEN"
        );
        let hidden = parse(
            "demo",
            "abcd",
            root,
            br#"{"mcpServers":{"local":{"command":"node","env":{"TOKEN":"super-secret"}}}}"#,
        )
        .unwrap();
        let preview = serde_json::to_string(&hidden[0].preview()).unwrap();
        assert!(preview.contains("literal value in plugin configuration"));
        assert!(!preview.contains("super-secret"));
        assert!(parse(
            "demo",
            "abcd",
            root,
            br#"{"mcpServers":{"remote":{"url":"https://example.com"}}}"#
        )
        .is_err());
        assert!(parse(
            "demo",
            "abcd",
            root,
            br#"{"mcpServers":{"local":{"command":"${UNKNOWN}"}}}"#
        )
        .is_err());
    }
}
