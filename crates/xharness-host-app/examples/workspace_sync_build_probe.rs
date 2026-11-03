//! Remote Linux acceptance only. No installed Host, browser command or local
//! Rust compilation: this takes explicit fresh native owner fixture paths.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#[cfg(target_os = "linux")]
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use tokio_util::sync::CancellationToken;
    use xharness_cloud::{Counter, Id};
    use xharness_fs::{FsService, ObservationStore};
    use xharness_host_app::{
        workspace_build::{NativeBuildCommand, RemoteBuildRunner},
        workspace_wire::{Participant, Role},
    };
    use xharness_process::SpawnSpec;
    if std::env::var("XHARNESS_REMOTE_RUST").as_deref() != Ok("1") {
        return Err("remote owner build acceptance only".into());
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 8 {
        return Err(
            "workspace control spool registration snapshot cache journal rustc required".into(),
        );
    }
    let files =
        FsService::with_sync_control(&args[0], ObservationStore::default(), &args[1], &args[3])?;
    let participant = Participant::open(&files, &FsService::new(&args[2])?, Role::Cloud)?;
    let snapshot = Arc::new(participant.seal_cloud_snapshot(&FsService::new(&args[4])?)?);
    let runner = RemoteBuildRunner::provision(
        FsService::new(&args[6])?,
        FsService::new(&args[5])?,
        Id::new("cloud")?,
        Counter(1),
    )?;
    let job = Id::new("wire-build-probe")?;
    let artifact = format!(
        "artifacts/{:x}/program",
        Sha256::digest(job.as_str().as_bytes())
    );
    let rustc = std::fs::canonicalize(PathBuf::from(&args[7]))?;
    let toolchain = rustc
        .parent()
        .and_then(|p| p.parent())
        .ok_or("native toolchain missing")?
        .to_path_buf();
    let command=NativeBuildCommand {
        spec:SpawnSpec::new("/bin/sh",PathBuf::from(&args[4])).args(["-c","mkdir -p \"${OUT%/*}\" && test ! -e .env && \"$RUSTC\" --edition=2021 main.rs -o \"$OUT\" && \"$OUT\""])
            .env("PATH","/usr/bin:/bin").env("OUT",PathBuf::from(&args[5]).join(&artifact).display().to_string()).env("RUSTC",rustc.display().to_string()).timeout(Duration::from_secs(30)),
        read_only_roots:vec![toolchain],artifacts:vec![artifact.clone()],
    };
    let receipt = runner
        .run(job.clone(), snapshot, command, &CancellationToken::new())
        .await?;
    if !receipt.success {
        return Err("native checkpoint build failed".into());
    }
    let bytes = runner.artifact(&job, &artifact)?;
    println!(
        "{}",
        serde_json::to_string(
            &serde_json::json!({"success":true,"checkpoint":receipt.checkpoint,"stdout":receipt.stdout,"artifact_bytes":bytes.len(),"artifact_sha256":format!("{:x}",Sha256::digest(&bytes)),"local_fallback":false})
        )?
    );
    Ok(())
}
#[tokio::main]
async fn main() {
    #[cfg(target_os = "linux")]
    if run().await.is_err() {
        eprintln!("native synchronized checkpoint build acceptance failed");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("remote Linux acceptance only");
        std::process::exit(1);
    }
}
