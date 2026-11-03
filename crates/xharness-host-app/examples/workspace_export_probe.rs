//! Isolated read-only cross-machine acceptance fixture, never an installed Host.
#![forbid(unsafe_code)]
use std::{fs, io::Write, path::PathBuf};
use xharness_cloud::Id;
use xharness_fs::{FsService, ObservationStore};
use xharness_host_app::{
    workspace_executor::{ExecutorError, WorkspacePair},
    workspace_export::WorkspaceExport,
};

fn entropy() -> Result<String, Box<dyn std::error::Error>> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(ExecutorError::Entropy)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("one empty private fixture root is required")?,
    );
    let native_root = FsService::new(&root)?;
    native_root.sync_lease()?.validate_private_root()?;
    if fs::read_dir(&root)?.next().is_some() {
        return Err("probe root must be empty".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["source", "peer", "control-source", "control-peer"] {
            fs::create_dir(root.join(name))?;
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700))?;
        }
    }
    let source_id = entropy()?;
    let peer_id = entropy()?;
    let token = entropy()?;
    for (name, nonce) in [("source", &source_id), ("peer", &peer_id)] {
        FsService::new(root.join(name))?.provision_sync_control(
            &FsService::new(root.join(format!("control-{name}")))?,
            nonce,
        )?;
    }
    let source = FsService::with_sync_control(
        root.join("source"),
        ObservationStore::default(),
        root.join("control-source"),
        &source_id,
    )?;
    let peer = FsService::with_sync_control(
        root.join("peer"),
        ObservationStore::default(),
        root.join("control-peer"),
        &peer_id,
    )?;
    WorkspacePair::new(
        &source,
        &peer,
        Id::new("export-probe")?,
        Id::new("source")?,
        Id::new("peer")?,
    )?
    .register_new_pair()?;
    fs::create_dir(root.join("source/中文"))?;
    let bytes: Vec<_> = (0..524_299).map(|i| (i % 251) as u8).collect();
    fs::write(root.join("source/中文/payload.bin"), bytes)?;
    fs::write(root.join("source/.env"), b"excluded_probe_secret")?;
    source
        .sync_control()
        .ok_or("control missing")?
        .0
        .sync_lease()?
        .put_record_once("export-auth", token.as_bytes())?;
    let export = WorkspaceExport::new(source, token)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let ready = serde_json::to_vec(
        &serde_json::json!({"address":address.to_string(), "scope":export.scope(), "source_registration":source_id}),
    )?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(root.join("ready.json"))?;
    file.write_all(&ready)?;
    file.sync_all()?;
    fs::File::open(&root)?.sync_all()?;
    println!("WORKSPACE_READ_PROBE_READY");
    axum::serve(listener, export.router(address)?)
        .with_graceful_shutdown(async {
            if tokio::signal::ctrl_c().await.is_err() {
                eprintln!("workspace read probe shutdown signal unavailable");
            }
        })
        .await?;
    Ok(())
}
