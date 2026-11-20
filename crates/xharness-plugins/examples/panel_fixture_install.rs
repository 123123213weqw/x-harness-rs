//! Offline acceptance setup: uses the production catalog/digest installer, never a bypass RPC.
use sha2::{Digest, Sha256};
use xharness_plugins::PluginManager;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let root = args.get(1).ok_or("plugin store path required")?;
    let bytes = std::fs::read(args.get(2).ok_or("verified plugin ZIP required")?)?;
    let manager = PluginManager::open(root.into())?;
    manager.import_catalog(&serde_json::json!({"plugins":[{"name":"wordcraft","scope":"personal","description":"isolated acceptance editor","descriptionI18n":{},"version":"0.1.0","category":"tools","icon":null,"source":{"source":"url","type":"zip","url":"https://example.com/wordcraft-acceptance.zip","sha256":format!("{:x}",Sha256::digest(&bytes))}}]}).to_string()).await?;
    let installed = manager
        .install_verified_archive("wordcraft", &bytes)
        .await?;
    assert!(!installed.enabled && !installed.mcp_enabled);
    assert!(manager.panel("wordcraft").await.is_err());
    println!("{}", serde_json::to_string(&installed)?);
    Ok(())
}
