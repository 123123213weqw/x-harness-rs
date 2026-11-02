//! Opt-in personal environment gateway. Does not start or alter an Agent Loop.
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
use std::{io, path::Path};
use xharness_host_app::environment_gateway::{EnvironmentGateway, GatewayConfig};
fn main() -> io::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}
async fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err(io::Error::other(
            "usage: xharness-environment-gateway <private-config.json> <web-dist>",
        ));
    }
    let config = GatewayConfig::read(Path::new(&args[0]))?;
    let mut gateway = EnvironmentGateway::start(config, args[1].clone().into()).await?;
    let outcome = tokio::select! {
        result = gateway.wait_failure() => result,
        result = tokio::signal::ctrl_c() => result,
    };
    let shutdown = gateway.shutdown().await;
    outcome.and(shutdown)
}
