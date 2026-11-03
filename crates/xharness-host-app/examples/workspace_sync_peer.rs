//! Isolated native owner CLI. SSH authentication is the write authority; this
//! executable is not reachable through the readonly HTTP endpoint or Web UI.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
use std::io::{BufRead, Read, Write};
use xharness_fs::{FsService, ObservationStore};
use xharness_host_app::workspace_wire::{Binding, Participant, Request, Role, MAX_WIRE_BYTES};
fn code(error: &xharness_host_app::workspace_executor::ExecutorError) -> &'static str {
    use xharness_host_app::workspace_executor::ExecutorError;
    match error {
        ExecutorError::Domain(e) if e.code == xharness_cloud::ErrorCode::RevisionConflict => {
            "conflict"
        }
        ExecutorError::DeletionDisabled => "deletion_disabled",
        ExecutorError::BatchLimit | ExecutorError::CheckpointLimit => "limit",
        ExecutorError::Unregistered => "unregistered",
        ExecutorError::Native(xharness_fs::workspace_apply::ApplyError::Busy) => "busy",
        ExecutorError::Native(xharness_fs::workspace_apply::ApplyError::Changed) => {
            "source_or_target_changed"
        }
        ExecutorError::Inventory(_) => "inventory_rejected",
        _ => "native_state_rejected",
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 6 {
        return Err("mode workspace control spool registration role required".into());
    }
    let role = match args[5].as_str() {
        "local" => Role::Local,
        "cloud" => Role::Cloud,
        _ => return Err("invalid native role".into()),
    };
    let service = if args[0] == "provision" {
        let s = FsService::new(&args[1])?;
        s.provision_sync_control(&FsService::new(&args[2])?, &args[4])?;
        FsService::with_sync_control(&args[1], ObservationStore::default(), &args[2], &args[4])?
    } else {
        FsService::with_sync_control(&args[1], ObservationStore::default(), &args[2], &args[4])?
    };
    let peer = Participant::open(&service, &FsService::new(&args[3])?, role)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    match args[0].as_str() {
        "provision" => {
            serde_json::to_writer(&mut output, peer.descriptor())?;
            output.write_all(b"\n")?;
        }
        "bind" => {
            let mut bytes = Vec::new();
            Read::by_ref(&mut input)
                .take(MAX_WIRE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_WIRE_BYTES {
                return Err("binding limit".into());
            }
            peer.bind_new(&serde_json::from_slice::<Binding>(&bytes)?)?;
            output.write_all(b"{\"bound\":true}\n")?;
        }
        "serve" => loop {
            let mut bytes = Vec::new();
            Read::by_ref(&mut input)
                .take(MAX_WIRE_BYTES as u64 + 1)
                .read_until(b'\n', &mut bytes)?;
            if bytes.is_empty() {
                break;
            }
            if bytes.len() > MAX_WIRE_BYTES || !bytes.ends_with(b"\n") {
                return Err("request frame limit".into());
            }
            let operation = serde_json::from_slice::<serde_json::Value>(&bytes)?
                .get("operation")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let response = match serde_json::from_slice::<Request>(&bytes) {
                Ok(request) => match peer.request(request) {
                    Ok(value) => serde_json::json!({"ok":true,"value":value}),
                    Err(error) => serde_json::json!({"ok":false,"error":code(&error)}),
                },
                Err(_) => serde_json::json!({"ok":false,"error":"invalid_request"}),
            };
            // Owner-only acceptance fault seam: real process exit after durable
            // work but before its reply, never controlled by a wire request.
            if response.get("ok") == Some(&serde_json::Value::Bool(true))
                && std::env::var("XHARNESS_SYNC_PEER_EXIT_AFTER")
                    .ok()
                    .as_deref()
                    == operation.as_deref()
                && operation.is_some()
            {
                std::process::exit(86);
            }
            let encoded = serde_json::to_vec(&response)?;
            if encoded.len() > MAX_WIRE_BYTES {
                return Err("response frame limit".into());
            }
            output.write_all(&encoded)?;
            output.write_all(b"\n")?;
            output.flush()?;
        },
        _ => return Err("unknown native owner operation".into()),
    }
    output.flush()?;
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("native workspace sync peer failed; retain state for owner recovery");
        std::process::exit(1);
    }
}
