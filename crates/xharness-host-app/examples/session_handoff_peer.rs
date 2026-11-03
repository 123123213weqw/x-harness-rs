//! Explicit owner executable. No provision, reset, root, credential or execute RPC.
#![forbid(unsafe_code)]
use std::io::{BufRead, Read, Write};
use xharness_fs::{FsService, ObservationStore};
use xharness_host_app::{
    session_handoff::{Owner, Request},
    workspace_wire::Role,
};
use xharness_session_jsonl::handoff::MAX_HANDOFF_BYTES;
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<_> = std::env::args().skip(1).collect();
    if a.len() != 6 {
        return Err("state workspace control spool registration local|cloud required".into());
    }
    let role = match a[5].as_str() {
        "local" => Role::Local,
        "cloud" => Role::Cloud,
        _ => return Err("invalid owner role".into()),
    };
    let workspace = FsService::with_sync_control(&a[1], ObservationStore::default(), &a[2], &a[4])?;
    let owner = Owner::open(
        std::path::Path::new(&a[0]),
        &workspace,
        &FsService::new(&a[2])?,
        &FsService::new(&a[3])?,
        role,
    )
    .await?;
    let input = std::io::stdin();
    let mut input = input.lock();
    let output = std::io::stdout();
    let mut output = output.lock();
    loop {
        let mut bytes = Vec::new();
        Read::by_ref(&mut input)
            .take((MAX_HANDOFF_BYTES.div_ceil(3) * 4) as u64 + 65537)
            .read_until(b'\n', &mut bytes)?;
        if bytes.is_empty() {
            break;
        }
        if bytes.len() > MAX_HANDOFF_BYTES.div_ceil(3) * 4 + 65536 || !bytes.ends_with(b"\n") {
            return Err("native handoff frame limit".into());
        }
        let operation = serde_json::from_slice::<serde_json::Value>(&bytes)?
            .get("operation")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let response = match serde_json::from_slice::<Request>(&bytes) {
            Ok(r) => match owner.request(r).await {
                Ok(value) => serde_json::json!({"ok":true,"value":value}),
                Err(_) => serde_json::json!({"ok":false,"error":"native_state_rejected"}),
            },
            Err(_) => serde_json::json!({"ok":false,"error":"invalid_request"}),
        };
        // Native-owner test seam: stop AFTER durable work, BEFORE its reply.
        if response["ok"] == true
            && operation.is_some()
            && std::env::var("XHARNESS_HANDOFF_EXIT_AFTER").ok().as_deref() == operation.as_deref()
        {
            std::process::exit(86);
        }
        let bytes = serde_json::to_vec(&response)?;
        if bytes.len() > MAX_HANDOFF_BYTES.div_ceil(3) * 4 + 65536 {
            return Err("native handoff response limit".into());
        }
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("native session handoff failed; retain state for owner recovery");
        std::process::exit(1);
    }
}
