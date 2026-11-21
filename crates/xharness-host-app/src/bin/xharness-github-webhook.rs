//! Optional standalone receiver; never started by the desktop or its updater.
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 2 || arguments[0] != "--config" {
        return Err("usage: xharness-github-webhook --config /absolute/private/config.json".into());
    }
    // The entry macro inserts its own expect-lint override. Keep the strict
    // production forbid fence and construct the runtime explicitly instead.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| std::io::Error::other("GitHub receiver runtime unavailable"))?;
    runtime
        .block_on(xharness_host_app::github_events::serve_receiver(
            std::path::Path::new(&arguments[1]),
        ))
        .map_err(|_| std::io::Error::other("GitHub webhook receiver failed; check private configuration, state ownership and listener"))?;
    Ok(())
}
