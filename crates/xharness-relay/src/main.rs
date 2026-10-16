use std::{net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use xharness_relay::{load_registered_hosts, serve, Config};

fn args() -> Result<Config, &'static str> {
    let mut bind: SocketAddr = "127.0.0.1:31368"
        .parse()
        .map_err(|_| "invalid default bind")?;
    let mut static_dir = None;
    let mut hosts_file = None;
    let mut public_origin = None;
    let mut allow_loopback_http = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => bind = args.next().ok_or("missing bind")?.parse().map_err(|_| "invalid bind")?,
            "--static-dir" => static_dir = Some(PathBuf::from(args.next().ok_or("missing static-dir")?)),
            "--hosts-file" => hosts_file = Some(PathBuf::from(args.next().ok_or("missing hosts-file")?)),
            "--public-origin" => public_origin = Some(args.next().ok_or("missing public-origin")?),
            "--allow-loopback-http" => allow_loopback_http = true,
            _ => return Err("usage: xharness-relay --bind IP:PORT --static-dir PATH --hosts-file PATH --public-origin HTTPS_ORIGIN [--allow-loopback-http]"),
        }
    }
    let registered = load_registered_hosts(&hosts_file.ok_or("hosts-file required")?)
        .map_err(|_| "registered-host file invalid or not private")?;
    Ok(Config {
        bind,
        static_dir: static_dir.ok_or("static-dir required")?,
        public_origin: public_origin.ok_or("public-origin required")?,
        allow_loopback_http,
        registered,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = args().map_err(std::io::Error::other)?;
    config.validate()?;
    let listener = TcpListener::bind(config.bind).await?;
    // No secrets, peer headers, pairing codes or request bodies in logs.
    eprintln!("xharness-relay listening on {}", listener.local_addr()?);
    let shutdown = CancellationToken::new();
    let signal = shutdown.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            if let Ok(mut term) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    serve(listener, config, shutdown).await?;
    Ok(())
}
