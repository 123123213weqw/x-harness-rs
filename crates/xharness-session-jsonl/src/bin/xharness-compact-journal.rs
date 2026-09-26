//! Explicit one-session, in-place storage migration. Run against a backed-up
//! state directory; this binary never enumerates or rewrites other sessions.
use std::{env, process::ExitCode};

use xharness_session_jsonl::JsonlSessionStore;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 || args[1] != "--root" || args[3] != "--session" {
        eprintln!("usage: xharness-compact-journal --root <sessions-dir> --session <id>");
        return ExitCode::FAILURE;
    }
    let store = match JsonlSessionStore::new(&args[2]) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("open session store: {error}");
            return ExitCode::FAILURE;
        }
    };
    match store.compress_cold_session(&args[4]).await {
        Ok(report) => {
            println!(
                "session={} changed={} bytes_before={} bytes_after={} batches_compressed={}",
                args[4],
                report.changed,
                report.bytes_before,
                report.bytes_after,
                report.batches_compressed
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("compress session {:?}: {error}", args[4]);
            ExitCode::FAILURE
        }
    }
}
