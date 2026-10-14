//! Actual disposable executable lifecycle; no platform, model or local desktop.
use std::sync::Arc;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::process::{Child, Command};
use xharness_host_app::remote_control::RemoteControl;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "xh-remote-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("state")).unwrap();
        std::fs::create_dir(root.join("workspace")).unwrap();
        Self(root)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn start(directory: &Directory, enabled: bool) -> (Child, String) {
    start_with_token(directory, enabled, true).await
}
async fn start_with_token(
    directory: &Directory,
    enabled: bool,
    desktop_token: bool,
) -> (Child, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xharness-host"));
    if desktop_token {
        command.args(["--desktop-token", "fixture-local-only-0000000000000000"]);
    }
    command
        .args([
            "--bind",
            "127.0.0.1:0",
            "--model",
            "unconfigured",
            "--remote-control",
            if enabled { "enabled" } else { "disabled" },
        ])
        .arg("--workspace")
        .arg(directory.0.join("workspace"))
        .arg("--state-dir")
        .arg(directory.0.join("state"))
        .arg("--ready-file")
        .arg(directory.0.join("ready.address"))
        .arg("--shutdown-file")
        .arg(directory.0.join("stop"))
        .env_remove("XHARNESS_DESKTOP_TOKEN")
        .env_remove("XHARNESS_REMOTE_CONTROL")
        .env_remove("XHARNESS_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("XHARNESS_PROVIDERS_FILE")
        .env_remove("XHARNESS_HOSTED_PERMIT_DIR")
        .env_remove("XHARNESS_HOSTED_BOOTSTRAP_FILE")
        .env_remove("XHARNESS_DEBUG_TRACE")
        .env_remove("XHARNESS_DEBUG_DIR")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let client = reqwest::Client::new();
    let address = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "disposable Host exited before ready"
            );
            if let Ok(address) = std::fs::read_to_string(directory.0.join("ready.address")) {
                let address = format!("http://{}", address.trim());
                if client
                    .get(format!("{address}/health/ready"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    break address;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("disposable Host readiness");
    (child, address)
}
async fn stop(directory: &Directory, child: &mut Child) {
    std::fs::write(directory.0.join("stop"), "stop").unwrap();
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        status.success(),
        "disposable Host failed graceful stop: {status}"
    );
}

#[tokio::test]
async fn enabled_supervisor_is_process_owned_private_and_reopens_after_graceful_stop() {
    let directory = Directory::new();
    let (mut child, address) = start(&directory, true).await;
    assert!(directory
        .0
        .join("state/remote-control/remote.sqlite")
        .exists());
    assert!(RemoteControl::start(
        &directory.0.join("state"),
        Arc::new(xharness_api::UnavailableBackend)
    )
    .is_err());
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{address}/api/remote/resolve"))
        .header(
            "x-xharness-desktop-token",
            "fixture-local-only-0000000000000000",
        )
        .json(&serde_json::json!({"type":"client-request","rpcId":"fixture","method":"remote/resolve","payload":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    stop(&directory, &mut child).await;
    let (mut child, _) = start(&directory, true).await;
    stop(&directory, &mut child).await;
}
#[tokio::test]
async fn disabled_supervisor_does_not_create_remote_state() {
    let directory = Directory::new();
    let (mut child, _) = start(&directory, false).await;
    assert!(!directory.0.join("state/remote-control").exists());
    stop(&directory, &mut child).await;
}

#[tokio::test]
async fn native_admin_is_mounted_only_for_opted_in_authenticated_desktop_process() {
    let client = reqwest::Client::new();
    for (enabled, desktop_token) in [(true, true), (false, true), (true, false)] {
        let directory = Directory::new();
        let (mut child, address) = start_with_token(&directory, enabled, desktop_token).await;
        let endpoint = format!("{address}/api/remote-control/manage");
        let request = || {
            client
                .post(&endpoint)
                .header("x-xharness-remote-admin", "v1")
                .json(&serde_json::json!({"type":"status"}))
        };
        let response = request()
            .header(
                "x-xharness-desktop-token",
                "fixture-local-only-0000000000000000",
            )
            .send()
            .await
            .unwrap();
        if enabled && desktop_token {
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert_eq!(response.headers()["cache-control"], "no-store");
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["ok"], true);
            assert_eq!(body["value"]["accounts"], serde_json::json!([]));
            assert!(!body.to_string().contains("fixture-local-only"));
            assert_eq!(
                request().send().await.unwrap().status(),
                reqwest::StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                request()
                    .header(
                        "x-xharness-desktop-token",
                        "fixture-local-only-0000000000000000"
                    )
                    .header("origin", "https://untrusted.invalid")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                reqwest::StatusCode::FORBIDDEN
            );
        } else {
            assert_eq!(
                response.status(),
                reqwest::StatusCode::NOT_FOUND,
                "enabled={enabled} desktop_token={desktop_token}"
            );
        }
        stop(&directory, &mut child).await;
    }
}
