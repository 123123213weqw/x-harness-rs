//! Owned Chrome/Edge only: no existing profile, session attachment or downloads.
#![forbid(unsafe_code)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    net::TcpStream,
    process::{Child, Command},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

pub fn candidates() -> Vec<PathBuf> {
    let mut files = Vec::new();
    #[cfg(target_os = "macos")]
    for name in ["Google Chrome", "Microsoft Edge"] {
        for root in [
            Some(PathBuf::from("/Applications")),
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications")),
        ]
        .into_iter()
        .flatten()
        {
            files.push(root.join(format!("{name}.app/Contents/MacOS/{name}")));
        }
    }
    #[cfg(windows)]
    for suffix in [
        "Google/Chrome/Application/chrome.exe",
        "Microsoft/Edge/Application/msedge.exe",
    ] {
        for variable in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(root) = std::env::var_os(variable) {
                files.push(PathBuf::from(root).join(suffix));
            }
        }
    }
    #[cfg(target_os = "linux")]
    files.extend(
        [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/opt/google/chrome/chrome",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/microsoft-edge",
            "/opt/microsoft/msedge/msedge",
        ]
        .map(PathBuf::from),
    );
    #[cfg(not(target_os = "macos"))]
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths).filter(|path| path.is_absolute()) {
            #[cfg(windows)]
            let names = ["chrome.exe", "msedge.exe"];
            #[cfg(not(windows))]
            let names = [
                "google-chrome-stable",
                "google-chrome",
                "microsoft-edge-stable",
                "microsoft-edge",
            ];
            files.extend(names.map(|name| directory.join(name)));
        }
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|file| file.is_file() && file.canonicalize().is_ok_and(|path| seen.insert(path)));
    files
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub struct Cdp {
    endpoint: String,
    socket: Option<Socket>,
    sequence: u64,
}
impl Cdp {
    pub fn new(endpoint: String) -> Self {
        Self {
            endpoint,
            socket: None,
            sequence: 0,
        }
    }
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        // Take ownership while awaiting: cancellation closes this connection.
        // A later read reconnects; an abandoned modifying command is never replayed.
        let mut socket = match self.socket.take() {
            Some(socket) => socket,
            None => {
                let config = WebSocketConfig::default()
                    .max_message_size(Some(12 * 1024 * 1024))
                    .max_frame_size(Some(12 * 1024 * 1024));
                tokio::time::timeout(
                    Duration::from_secs(3),
                    connect_async_with_config(&self.endpoint, Some(config), false),
                )
                .await
                .map_err(|_| "browser connection timed out")?
                .map_err(|_| "browser connection unavailable")?
                .0
            }
        };
        let operation = async {
            socket
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|_| "browser command send failed")?;
            let mut notifications = 0;
            while let Some(packet) = socket.next().await {
                let packet =
                    packet.map_err(|_| "browser connection lost; effect may be unknown")?;
                if let Message::Ping(data) = packet {
                    socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| "browser connection lost")?;
                    continue;
                }
                if let Message::Text(text) = packet {
                    let value: Value =
                        serde_json::from_str(&text).map_err(|_| "invalid browser response")?;
                    if value["id"].as_u64() == Some(id) {
                        if value.get("error").is_some() {
                            return Err("browser command rejected; observe before deciding".into());
                        }
                        return value
                            .get("result")
                            .cloned()
                            .ok_or_else(|| "missing browser result".into());
                    }
                }
                notifications += 1;
                if notifications > 256 {
                    return Err("browser notification budget exceeded".into());
                }
            }
            Err("browser connection closed".into())
        };
        let result = tokio::time::timeout(Duration::from_secs(8), operation)
            .await
            .map_err(|_| "browser command timed out; effect may be unknown".to_owned())?;
        if result.is_ok() {
            self.socket = Some(socket);
        }
        result
    }
    pub async fn evaluate(&mut self, expression: String) -> Result<Value, String> {
        let result = self.call("Runtime.evaluate", json!({"expression":expression,"returnByValue":true,"awaitPromise":true,"timeout":5000})).await?;
        if result.get("exceptionDetails").is_some() {
            return Err("page observation/action failed; page evidence is untrusted".into());
        }
        result["result"]
            .get("value")
            .cloned()
            .ok_or_else(|| "page result unavailable".into())
    }
}

pub struct Process {
    child: Option<Child>,
    // The helper holds the browser lifetime; dropping its stdin revokes the lease.
    _profile: Option<tempfile::TempDir>,
    pub cdp: Cdp,
}
impl Process {
    pub async fn launch(binary: &std::path::Path) -> Result<Self, String> {
        let profile = tempfile::Builder::new()
            .prefix("xharness-owned-browser-")
            .tempdir()
            .map_err(|_| "browser profile creation failed")?;
        let executable = std::env::current_exe().map_err(|_| "owned browser helper unavailable")?;
        let mut command = Command::new(executable);
        command
            .arg(super::helper::FLAG)
            .arg(binary)
            .arg(profile.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW, not elevation.
        let child = command
            .spawn()
            .map_err(|_| "installed Chrome/Edge could not start")?;
        let mut process = Self {
            child: Some(child),
            _profile: Some(profile),
            cdp: Cdp::new(String::new()),
        };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| "browser bootstrap unavailable")?;
        let ready = async {
            loop {
                if process
                    .child
                    .as_mut()
                    .ok_or("browser process unavailable")?
                    .try_wait()
                    .map_err(|_| "browser process unavailable")?
                    .is_some()
                {
                    return Err("installed browser exited during startup".to_owned());
                }
                let file = tokio::fs::read_to_string(
                    process
                        ._profile
                        .as_ref()
                        .ok_or("browser profile unavailable")?
                        .path()
                        .join("DevToolsActivePort"),
                )
                .await;
                if let Ok(file) = file {
                    if let Some(port) = file
                        .lines()
                        .next()
                        .and_then(|line| line.parse::<u16>().ok())
                        .filter(|port| *port != 0)
                    {
                        if let Ok(mut response) = client
                            .get(format!("http://127.0.0.1:{port}/json/list"))
                            .send()
                            .await
                        {
                            let mut body = Vec::new();
                            while let Some(chunk) = response
                                .chunk()
                                .await
                                .map_err(|_| "browser discovery interrupted")?
                            {
                                if body.len().saturating_add(chunk.len()) > 64 * 1024 {
                                    return Err("browser discovery exceeds budget".into());
                                }
                                body.extend_from_slice(&chunk);
                            }
                            let tabs: Vec<Value> = serde_json::from_slice(&body)
                                .map_err(|_| "invalid browser discovery")?;
                            if let Some(tab) = tabs
                                .iter()
                                .find(|tab| tab["type"] == "page" && tab["url"] == "about:blank")
                            {
                                let id = tab["id"]
                                    .as_str()
                                    .filter(|id| {
                                        id.len() <= 128
                                            && id
                                                .bytes()
                                                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                                    })
                                    .ok_or("invalid browser target")?;
                                return Ok(format!("ws://127.0.0.1:{port}/devtools/page/{id}"));
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let endpoint = tokio::time::timeout(Duration::from_secs(12), ready)
            .await
            .map_err(|_| "browser startup timed out")??;
        process.cdp = Cdp::new(endpoint);
        process.cdp.call("Emulation.setDeviceMetricsOverride", json!({"width":1280,"height":720,"deviceScaleFactor":1,"mobile":false,"dontSetVisibleSize":false})).await?;
        // No download tool is exposed: deny writes to the user's Downloads.
        process
            .cdp
            .call("Page.setDownloadBehavior", json!({"behavior":"deny"}))
            .await?;
        Ok(process)
    }
    pub async fn close(mut self) -> Result<(), String> {
        // Browser.close lets renderers/cache writers exit before profile removal.
        // Its connection may close without an ACK; only child.wait proves exit.
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.cdp.call("Browser.close", json!({})),
        )
        .await;
        let child = self.child.as_mut().ok_or("browser process unavailable")?;
        child.stdin.take(); // Revoke the helper lease even if Browser.close failed.
        match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return Err("browser exit unavailable".into()),
            // Do not kill the helper: it must finish reaping Chrome. Drop keeps
            // its profile if exit cannot yet be confirmed, rather than orphaning
            // Chrome or removing files while browser writers are still alive.
            Err(_) => return Err("owned browser cleanup still pending".into()),
        }
        self.child.take();
        if let Some(profile) = self._profile.take() {
            let path = profile.keep();
            tokio::task::spawn_blocking(move || cleanup_profile(path))
                .await
                .map_err(|_| "browser cleanup unavailable")??;
        }
        Ok(())
    }
}

// Cancellation during launch/close must reap the exact child before removing its
// profile. Never block the UI executor or sweep unrelated browser processes.
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let profile = self._profile.take();
            child.stdin.take();
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                let reaped = loop {
                    if let Ok(Some(_)) = child.try_wait() {
                        break true;
                    }
                    if std::time::Instant::now() >= deadline {
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                };
                if reaped {
                    if let Some(profile) = profile {
                        let _ = cleanup_profile(profile.keep());
                    }
                } else if let Some(profile) = profile {
                    // Keep rather than delete a possibly still-live profile.
                    let _ = profile.keep();
                    eprintln!("owned browser cleanup did not confirm process exit");
                }
            });
        }
    }
}

pub(super) fn cleanup_profile(path: PathBuf) -> Result<(), String> {
    // Only the TempDir created and retained by this exact Process reaches here.
    for attempt in 0..10 {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt < 9 => std::thread::sleep(Duration::from_millis(20 * (attempt + 1))),
            Err(_) => return Err("owned browser profile cleanup failed".into()),
        }
    }
    Err("owned browser profile cleanup failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_command_reconnects_without_replaying_an_effect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = Cdp::new(format!(
            "ws://{}/devtools/page/test",
            listener.local_addr().unwrap()
        ));
        let (admitted, started) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
            let command = first.next().await.unwrap().unwrap();
            let packet: Value = serde_json::from_str(command.to_text().unwrap()).unwrap();
            assert_eq!(packet["method"], "Input.dispatchMouseEvent");
            admitted.send(()).unwrap();
            let _ = first.next().await; // Cancellation closes the old connection.
            let (stream, _) = listener.accept().await.unwrap();
            let mut second = tokio_tungstenite::accept_async(stream).await.unwrap();
            let command = second.next().await.unwrap().unwrap();
            let packet: Value = serde_json::from_str(command.to_text().unwrap()).unwrap();
            assert_eq!(packet["method"], "Runtime.evaluate");
            assert_eq!(packet["id"], 2);
            second
                .send(Message::Text(
                    json!({"id":2,"result":{"fresh":true}}).to_string().into(),
                ))
                .await
                .unwrap();
        });
        {
            let effect = client.call("Input.dispatchMouseEvent", json!({"type":"mousePressed"}));
            tokio::pin!(effect);
            tokio::select! { _=started=>{},result=&mut effect=>panic!("effect should remain pending: {result:?}") }
        }
        assert!(client.socket.is_none());
        assert_eq!(
            client.call("Runtime.evaluate", json!({})).await.unwrap()["fresh"],
            true
        );
        server.await.unwrap();
    }
    #[test]
    fn cleanup_is_idempotent_and_removes_only_the_supplied_owned_directory() {
        let root = tempfile::Builder::new()
            .prefix("xharness-owned-browser-")
            .tempdir()
            .unwrap();
        std::fs::create_dir(root.path().join("cache")).unwrap();
        std::fs::write(root.path().join("cache/item"), b"fixture").unwrap();
        let path = root.keep();
        cleanup_profile(path.clone()).unwrap();
        assert!(!path.exists());
        cleanup_profile(path).unwrap();
    }
}
