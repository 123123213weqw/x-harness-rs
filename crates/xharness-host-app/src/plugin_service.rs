use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use xharness_host::PluginBackend;
use xharness_plugins::PluginManager;

pub struct NativePluginBackend(pub Arc<PluginManager>);

#[async_trait]
impl PluginBackend for NativePluginBackend {
    async fn call(&self, endpoint: &str, payload: &Value) -> Result<Value, String> {
        let args = payload.get("args").unwrap_or(payload);
        match endpoint {
            "plugins/catalog" => Ok(json!({"plugins": self.0.catalog().await})),
            "plugins/installed" => Ok(json!({"plugins": self.0.installed().await})),
            "plugins/updates" => Ok(json!({"updates": self.0.updates().await})),
            "plugins/importCatalog" => {
                let content = required(args, "content")?;
                let scope = args
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("public");
                let items = self
                    .0
                    .import_catalog_scoped(content, scope)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"plugins": items}))
            }
            "plugins/install" => {
                let item = self
                    .0
                    .install(required(args, "name")?)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"plugin": item}))
            }
            "plugins/enable" | "plugins/disable" => {
                let item = self
                    .0
                    .set_enabled(required(args, "name")?, endpoint == "plugins/enable")
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"plugin": item}))
            }
            "plugins/uninstall" => {
                self.0
                    .uninstall(required(args, "name")?)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"ok": true}))
            }
            "plugins/skills" => Ok(json!({"skills": self.0.enabled_skills().await.into_iter()
                .map(|(plugin, skill)| json!({"plugin":plugin,"skill":skill})).collect::<Vec<_>>()})),
            _ => Err(format!("unsupported plugin endpoint {endpoint}")),
        }
    }
}
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_api::{ApiBackend, RpcId};
    use xharness_host::{BasicHost, HostConfig, NoTools};

    #[tokio::test]
    async fn mounted_dynamic_plugin_routes_read_and_mutate_catalog() {
        let root = std::env::temp_dir().join(format!("xh-plugin-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let manager = Arc::new(PluginManager::open(root.join("plugins")).unwrap());
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        host.install_plugins(Arc::new(NativePluginBackend(manager)))
            .unwrap();
        let result = host
            .call_dynamic(
                RpcId::new("catalog-1"),
                "plugins/catalog",
                json!({"args":{}}),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap()["value"]["plugins"],
            json!([])
        );
        let content = json!({"plugins":[{"name":"demo","description":"demo","version":"1.0","source":{
            "source":"url","type":"zip","url":"https://example.com/demo.zip","sha256":"a".repeat(64)
        }}]}).to_string();
        let imported = host
            .call_dynamic(
                RpcId::new("catalog-2"),
                "plugins/importCatalog",
                json!({"args":{"content":content}}),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(imported).unwrap()["value"]["plugins"][0]["name"],
            "demo"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
