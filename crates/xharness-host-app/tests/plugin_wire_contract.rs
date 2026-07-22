//! Produce real native plugin replies and shared serde DTOs for the checked UI.
//! Isolated temp state, verified in-memory archive; no public downloads, MCP
//! process launch, user state, model API or application restart.
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Arc};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcResult};
use xharness_host::{BasicHost, HostConfig, NoTools};
use xharness_host_app::NativePluginBackend;
use xharness_mcp::McpRuntime;
use xharness_plugins::{
    CatalogEntry, InstalledPlugin, McpServerPreview, PackageSource, PluginManager, PluginUpdate,
    SkillRecord,
};
use zip::{write::SimpleFileOptions, ZipWriter};

struct TempRoot(PathBuf);
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn archive() -> Vec<u8> {
    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, content) in [
        (
            "wire-test/.claude-plugin/plugin.json",
            r#"{"name":"wire-test","version":"0.1.0","description":"Wire contract"}"#,
        ),
        (
            "wire-test/skills/wire-demo/SKILL.md",
            "---\nname: wire-demo\ndescription: Wire fixture\n---\nFixture only.\n",
        ),
        (
            "wire-test/.mcp.json",
            r#"{"mcpServers":{"wire":{"command":"node","args":["server.js"],"env":{"WIRE_TOKEN":"${WIRE_TOKEN}"}}}}"#,
        ),
    ] {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
async fn reply(host: &BasicHost, endpoint: &str, args: Value) -> Value {
    serde_json::to_value(
        host.call_dynamic(
            RpcId::new(format!("wire-{endpoint}")),
            endpoint,
            json!({"args":args}),
            CancellationToken::new(),
        )
        .await
        .expect("plugin endpoint is registered"),
    )
    .unwrap()
}

#[tokio::test]
async fn plugin_center_wire_contract() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = TempRoot(
        std::env::temp_dir().join(format!("xh-plugin-wire-{}-{nonce}", std::process::id())),
    );
    let manager = Arc::new(PluginManager::open(root.0.join("plugins")).unwrap());
    let host = BasicHost::new(HostConfig::new(&root.0), None, Arc::new(NoTools));
    host.install_plugins(Arc::new(NativePluginBackend::new(
        Arc::clone(&manager),
        McpRuntime::new(),
    )))
    .unwrap();
    let bytes = archive();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let source = PackageSource {
        source: "url".into(),
        kind: "zip".into(),
        url: "https://example.com/wire.zip".into(),
        sha256: digest.clone(),
    };
    let catalog = CatalogEntry {
        name: "wire-test".into(),
        scope: "personal".into(),
        description: "Wire contract".into(),
        description_i18n: BTreeMap::from([("zh-CN".into(), "协议测试".into())]),
        version: "0.1.0".into(),
        category: "tests".into(),
        icon: None,
        source: source.clone(),
    };
    let mut calls = Vec::new();
    let empty = reply(&host, "plugins/catalog", json!({})).await;
    assert_eq!(empty["value"]["plugins"], json!([]));
    calls.push(json!({"endpoint":"plugins/catalog","args":{},"result":empty}));
    let content = json!({"plugins":[catalog]}).to_string();
    let import_args = json!({"content":content,"scope":"personal"});
    let imported = reply(&host, "plugins/importCatalog", import_args.clone()).await;
    assert_eq!(imported["value"]["plugins"][0]["name"], "wire-test");
    calls.push(json!({"endpoint":"plugins/importCatalog","args":import_args,"result":imported}));
    let initial: InstalledPlugin = manager
        .install_verified_archive("wire-test", &bytes)
        .await
        .unwrap();
    assert!(
        !initial.enabled && !initial.mcp_enabled,
        "installation grants no authority"
    );
    // Shared InstalledPlugin DTO for install. Network installation is not used.
    calls.push(json!({"endpoint":"plugins/install","args":{"name":"wire-test"},"result":RpcResult::success(json!({"plugin":initial})),"producer":"shared-installed-dto"}));
    for (endpoint, args) in [
        ("plugins/catalog", json!({})),
        ("plugins/installed", json!({})),
        ("plugins/mcpPreview", json!({"name":"wire-test"})),
        ("plugins/enable", json!({"name":"wire-test"})),
        ("plugins/disable", json!({"name":"wire-test"})),
        ("plugins/mcpEnable", json!({"name":"wire-test"})),
        ("plugins/mcpDisable", json!({"name":"wire-test"})),
    ] {
        let result = reply(&host, endpoint, args.clone()).await;
        assert_eq!(result["ok"], true, "{endpoint}: {result}");
        calls.push(json!({"endpoint":endpoint,"args":args,"result":result}));
    }
    let latest = CatalogEntry {
        version: "0.2.0".into(),
        source: PackageSource {
            sha256: "b".repeat(64),
            ..source.clone()
        },
        ..catalog.clone()
    };
    manager
        .import_catalog_scoped(&json!({"plugins":[latest]}).to_string(), "personal")
        .await
        .unwrap();
    let updates = reply(&host, "plugins/updates", json!({})).await;
    assert_eq!(updates["value"]["updates"][0]["availableVersion"], "0.2.0");
    calls.push(json!({"endpoint":"plugins/updates","args":{},"result":updates}));
    let failed = reply(
        &host,
        "plugins/importCatalog",
        json!({"content":"not-json","scope":"personal"}),
    )
    .await;
    assert_eq!(failed["ok"], false);
    calls.push(json!({"endpoint":"plugins/importCatalog","args":{"content":"not-json","scope":"personal"},"result":failed}));
    let missing = reply(
        &host,
        "plugins/mcpPreview",
        json!({"name":"missing-plugin"}),
    )
    .await;
    assert_eq!(missing["ok"], false);
    calls.push(
        json!({"endpoint":"plugins/mcpPreview","args":{"name":"missing-plugin"},"result":missing}),
    );
    let uninstalled = reply(&host, "plugins/uninstall", json!({"name":"wire-test"})).await;
    assert_eq!(uninstalled["value"]["ok"], true);
    calls.push(
        json!({"endpoint":"plugins/uninstall","args":{"name":"wire-test"},"result":uninstalled}),
    );
    assert!(manager.installed().await.is_empty());
    let sample_skill: SkillRecord = initial.skills[0].clone();
    let update = PluginUpdate {
        name: "wire-test".into(),
        installed_version: "0.1.0".into(),
        available_version: "0.2.0".into(),
        available_digest: "b".repeat(64),
    };
    let preview = McpServerPreview {
        server: "wire".into(),
        command: "node".into(),
        args: vec!["server.js".into()],
        env_keys: vec!["WIRE_TOKEN".into()],
        env_sources: BTreeMap::from([("WIRE_TOKEN".into(), "WIRE_TOKEN".into())]),
    };
    let fixtures = json!({"contract":"plugin-center-v1","types":{
        "catalog":catalog,"source":source,"installed":initial,"skill":sample_skill,
        "update":update,"preview":preview
    },"calls":calls});
    if let Some(path) = std::env::var_os("XHARNESS_PLUGIN_WIRE_FIXTURE") {
        fs::write(path, serde_json::to_vec_pretty(&fixtures).unwrap()).unwrap();
    }
    assert!(fixtures["calls"].as_array().unwrap().len() >= 14);
}
