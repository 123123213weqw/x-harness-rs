// Included ONLY in the disposable Linux update rehearsal source tree.
// Calls production commands; never shipped in normal desktop binaries.
use crate::{sidecar, updater, DesktopState};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

fn root() -> PathBuf {
    PathBuf::from(std::env::var_os("XHARNESS_REHEARSAL_ROOT").expect("isolated rehearsal root"))
}
fn record(value: serde_json::Value) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root().join("events.jsonl"))
        .unwrap();
    writeln!(f, "{value}").unwrap();
    f.sync_all().unwrap();
}
fn mode(value: &str) {
    fs::write(root().join("mode"), value).unwrap();
}
fn phase(snapshot: impl serde::Serialize, expected: &str) {
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["phase"], expected);
    record(value);
}
fn host_running(app: &AppHandle) {
    let status =
        serde_json::to_value(sidecar::desktop_status(app.state::<DesktopState>())).unwrap();
    assert_eq!(status["hostRunning"], true);
    assert_eq!(status["updaterConfigured"], true);
}
fn session_rpc(app: &AppHandle, method: &str, payload: serde_json::Value) -> serde_json::Value {
    use std::process::{Command, Stdio};
    let state = app.state::<DesktopState>();
    let endpoint = state.endpoint.lock().unwrap().clone().unwrap();
    let mut child=Command::new("python3").args(["-c",r#"import sys,json,urllib.request
x=json.load(sys.stdin)
b=json.dumps({'type':'client-request','rpcId':'rehearsal','method':x['method'],'payload':x['payload']}).encode()
r=urllib.request.Request(x['endpoint'].rstrip('/')+'/api/'+x['method'],data=b,headers={'Content-Type':'application/json','x-xharness-desktop-token':x['token']})
print(urllib.request.urlopen(r,timeout=10).read().decode())"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    serde_json::to_writer(
        child.stdin.take().unwrap(),
        &json!({"endpoint":endpoint,"token":state.token,"method":method,"payload":payload}),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["result"]["ok"], true);
    result
}
pub async fn run(app: AppHandle) {
    let result = tokio::spawn(exercise(app.clone())).await;
    if let Err(error) = result {
        record(json!({"failed":error.to_string()}));
        let _ = sidecar::graceful_stop(&app).await;
        app.exit(1);
    }
}
async fn exercise(app: AppHandle) {
    assert!(root().join("ISOLATED_TEST_ONLY").is_file());
    host_running(&app);
    record(json!({"bootVersion":env!("CARGO_PKG_VERSION"),"pid":std::process::id()}));
    for file in [
        "workspace/preserved.txt",
        "state/preserved.txt",
        "config/preserved.txt",
    ] {
        assert_eq!(
            fs::read_to_string(root().join(file)).unwrap(),
            "preserve-through-update\n"
        );
    }
    if env!("CARGO_PKG_VERSION") == "0.0.902" {
        let sessions = session_rpc(&app, "session.list", json!({}));
        assert!(sessions
            .to_string()
            .contains("linux-update-preserved-session"));
        record(json!({"persistedSessionRestored":true}));
        mode("normal");
        phase(
            updater::desktop_check_update(app.clone(), app.state())
                .await
                .unwrap(),
            "up-to-date",
        );
        sidecar::graceful_stop(&app).await.unwrap();
        record(json!({"complete":true,"version":"0.0.902","dataPreserved":true}));
        app.exit(0);
        return;
    }
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.0.901");
    session_rpc(
        &app,
        "session.create",
        json!({"sessionId":"linux-update-preserved-session"}),
    );
    record(json!({"persistedSessionCreated":true}));
    mode("unavailable");
    assert!(updater::desktop_check_update(app.clone(), app.state())
        .await
        .is_err());
    host_running(&app);
    record(json!({"checkFailureKeepsHost":true}));
    mode("normal");
    let first_app = app.clone();
    let first = tokio::spawn(async move {
        updater::desktop_check_update(first_app.clone(), first_app.state()).await
    });
    let b = updater::desktop_check_update(app.clone(), app.state()).await;
    let a = first.await.unwrap();
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    phase(a.or(b).unwrap(), "available");
    record(json!({"concurrentCheckRejected":true}));
    assert!(
        updater::desktop_install_update(app.clone(), app.state(), true)
            .await
            .is_err()
    );
    host_running(&app);
    mode("tampered");
    assert!(updater::desktop_download_update(app.clone(), app.state())
        .await
        .is_err());
    host_running(&app);
    record(json!({"tamperedPackageRejected":true}));
    mode("normal");
    phase(
        updater::desktop_download_update(app.clone(), app.state())
            .await
            .unwrap(),
        "downloaded",
    );
    host_running(&app);
    assert!(
        updater::desktop_install_update(app.clone(), app.state(), false)
            .await
            .is_err()
    );
    host_running(&app);
    record(json!({"unconfirmedInstallRejected":true}));
    phase(updater::desktop_update_status(app.state()), "downloaded");
    record(json!({"installConfirmed":true}));
    updater::desktop_install_update(app.clone(), app.state(), true)
        .await
        .unwrap();
    panic!("successful install must restart the process");
}
