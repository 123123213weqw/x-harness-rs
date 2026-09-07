// Included ONLY in a disposable Unix base build; NEVER in the signed candidate.
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
    let mut child=Command::new(std::env::var("XHARNESS_REHEARSAL_PYTHON").expect("isolated system Python")).args(["-E", "-c",r#"import sys,json,urllib.request
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
pub fn tls_client(client: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    assert!(root().join("ISOLATED_UNIX_UPDATE_ONLY").is_file());
    let pem = fs::read(root().join("ca.pem")).expect("isolated TLS root");
    let certificate = reqwest::Certificate::from_pem(&pem).expect("valid isolated TLS root");
    client.no_proxy().tls_certs_merge([certificate])
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
    assert!(root().join("ISOLATED_UNIX_UPDATE_ONLY").is_file());
    host_running(&app);
    record(json!({"bootVersion":env!("CARGO_PKG_VERSION"),"pid":std::process::id()}));
    for file in [
        "workspace/保留-fixture.txt",
        "state/preserved.txt",
        "config/preserved.txt",
    ] {
        assert_eq!(
            fs::read_to_string(root().join(file)).unwrap(),
            "preserve-through-update\n"
        );
    }
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read(root().join("rehearsal.json")).unwrap()).unwrap();
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        config["base_version"].as_str().unwrap()
    );
    assert!(updater::desktop_download_update(app.clone(), app.state())
        .await
        .is_err());
    host_running(&app);
    record(json!({"downloadBeforeCheckRejected":true}));
    session_rpc(
        &app,
        "session.create",
        json!({"sessionId":"unix-update-preserved-session"}),
    );
    session_rpc(
        &app,
        "session.rename",
        json!({"sessionId":"unix-update-preserved-session", "title":"Unix 更新保留测试"}),
    );
    let sessions = session_rpc(&app, "session.list", json!({}));
    assert!(sessions.to_string().contains("Unix 更新保留测试"));
    let models = session_rpc(
        &app,
        "session.models",
        json!({"sessionId":"unix-update-preserved-session"}),
    );
    assert!(models.to_string().contains("fixture-model"));
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
    record(json!({"installBeforeDownloadRejected":true}));
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
    // Snapshot only synthetic journal bytes and owned ready-file paths, never
    // the production token. The untouched target uses its normal debug trace
    // and ready files to prove restart + real session restoration externally.
    let snapshot = std::process::Command::new(std::env::var("XHARNESS_REHEARSAL_PYTHON").unwrap())
        .args([
            "-E",
            "-c",
            r#"import os,json,pathlib,base64
r=pathlib.Path(os.environ['XHARNESS_REHEARSAL_ROOT'])
j=r/'state/sessions/unix-update-preserved-session.jsonl'
print(json.dumps({'installConfirmed':True,'journalBase64':base64.b64encode(j.read_bytes()).decode(),
'readyFiles':[str(p) for d in ['cache','home'] for p in (r/d).rglob('ready-*.address')]}))"#,
        ])
        .output()
        .unwrap();
    assert!(snapshot.status.success());
    record(serde_json::from_slice(&snapshot.stdout).unwrap());
    updater::desktop_install_update(app.clone(), app.state(), true)
        .await
        .unwrap();
    panic!("successful install must restart the process");
}
