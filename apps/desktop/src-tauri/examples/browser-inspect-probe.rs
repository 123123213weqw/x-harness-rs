//! Opt-in native callback smoke test. Run only on an isolated display/profile.
//! It starts no Host/model and does not use the user's browser/app data.

#[path = "../src/browser.rs"]
#[allow(dead_code)] // The probe intentionally omits persistence/download UI paths.
mod browser;
#[path = "../src/browser_bridge.rs"]
mod browser_bridge;
#[path = "../src/browser_delegation.rs"]
mod browser_delegation;
#[path = "../src/browser_inspect.rs"]
mod browser_inspect;
#[path = "../src/browser_perform.rs"]
mod browser_perform;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HTML: &str = r#"<!doctype html><main><h1>Native observation probe</h1><label for="answer">Answer</label><input id="answer" value="unchanged"><input type="password" value="private-native-secret"><button disabled>Unavailable</button><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button id="apply" onclick="document.querySelector('#status').textContent='Applied '+document.querySelector('#answer').value">Apply</button><p id="status">Not applied</p><p id="ipc">IPC pending</p></main>"#;

fn fixture() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture bind");
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut headers = [0; 4096];
            let _ = stream.read(&mut headers);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", HTML.len(), HTML);
        }
    });
    format!("http://{address}/")
}

async fn observe(app: &tauri::AppHandle, main: &tauri::Webview) -> Result<Value, String> {
    browser_inspect::desktop_browser_inspect(
        main.clone(),
        app.state(),
        "probe".into(),
        Default::default(),
    )
    .await
}

fn action(
    snapshot: &Value,
    label: &str,
    mut arguments: Value,
) -> Result<browser_perform::PerformRequest, String> {
    arguments["frame_id"] = snapshot["frame_id"].clone();
    arguments["ref"] = snapshot["nodes"]
        .as_array()
        .ok_or("missing nodes")?
        .iter()
        .find(|node| node["label"] == label)
        .ok_or("missing action target")?["ref"]
        .clone();
    serde_json::from_value(arguments).map_err(|error| error.to_string())
}

async fn perform(
    app: &tauri::AppHandle,
    main: &tauri::Webview,
    request: browser_perform::PerformRequest,
) -> Result<browser_perform::PerformResult, String> {
    browser_perform::desktop_browser_perform(main.clone(), app.state(), "probe".into(), request)
        .await
}

async fn bridge_call(
    connection: &browser_bridge::Connection,
    owner: &str,
    op: &str,
    arguments: Value,
) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(&connection.address)
        .await
        .map_err(|_| "bridge connection failed")?;
    let request = serde_json::to_vec(
        &json!({"token":connection.token,"owner":owner,"op":op,"arguments":arguments}),
    )
    .unwrap();
    stream
        .write_u32(request.len() as u32)
        .await
        .map_err(|_| "bridge header failed")?;
    stream
        .write_all(&request)
        .await
        .map_err(|_| "bridge request failed")?;
    let length = stream
        .read_u32()
        .await
        .map_err(|_| "bridge response failed")? as usize;
    if length > 65536 {
        return Err("bridge reply was not bounded".into());
    }
    let mut reply = vec![0; length];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|_| "bridge response interrupted")?;
    serde_json::from_slice(&reply).map_err(|_| "invalid bridge JSON".into())
}

async fn delegation_probe(app: &tauri::AppHandle, main: &tauri::Webview) -> Result<(), String> {
    let origin = main
        .app_handle()
        .state::<browser::BrowserState>()
        .inspection_target("probe")?
        .0
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    let state = app.state::<browser_bridge::BrowserBridge>();
    let connection = state.start(app).await?;
    let wrong = browser_bridge::Connection {
        address: connection.address.clone(),
        token: "bad".repeat(22),
    };
    if bridge_call(&wrong, "parent", "list", json!({}))
        .await
        .is_ok()
    {
        return Err("native bridge accepted an invalid private credential".into());
    }
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    if browser_delegation::desktop_browser_delegate(
        guest,
        app.state(),
        "probe".into(),
        Some("parent".into()),
        true,
        Some(origin.clone()),
    )
    .await
    .is_ok()
    {
        return Err("guest page granted itself browser control".into());
    }

    if bridge_call(connection, "parent", "list", json!({})).await?["result"]["available"] != false {
        return Err("native bridge appeared before user delegation".into());
    }
    if browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("parent".into()),
        true,
        Some("https://changed.example".into()),
    )
    .await
    .is_ok()
    {
        return Err("late UI confirmation granted an unreviewed origin".into());
    }
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("parent".into()),
        false,
        Some(origin.clone()),
    )
    .await?;
    let status = browser_delegation::desktop_browser_access(
        main.clone(),
        app.state(),
        "probe".into(),
        "parent".into(),
    )
    .await?;
    let status = serde_json::to_value(status).map_err(|e| e.to_string())?;
    if status["origin"] != origin
        || status["grant"]["allowActions"] != false
        || status["grant"]["remainingMs"].as_u64().unwrap_or(0) == 0
    {
        return Err("UI access receipt did not reflect native read-only lease".into());
    }
    let status = browser_delegation::desktop_browser_access(
        main.clone(),
        app.state(),
        "probe".into(),
        "child".into(),
    )
    .await?;
    if !serde_json::to_value(status).map_err(|e| e.to_string())?["grant"].is_null() {
        return Err("UI status leaked another session's lease".into());
    }
    if bridge_call(connection, "child", "observe", json!({})).await?["ok"] != false {
        return Err("subagent inherited browser consent".into());
    }
    let view = bridge_call(connection, "parent", "observe", json!({})).await?;
    if view["ok"] != true {
        return Err("delegated observation failed".into());
    }
    let request = serde_json::to_value(action(
        &view["result"],
        "Answer",
        json!({"action":"fill","text":"bridge-value"}),
    )?)
    .unwrap();
    if bridge_call(connection, "parent", "perform", request).await?["ok"] != false {
        return Err("read-only grant admitted an effect".into());
    }
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("parent".into()),
        true,
        Some(origin.clone()),
    )
    .await?;
    let view = bridge_call(connection, "parent", "observe", json!({})).await?;
    let request = serde_json::to_value(action(
        &view["result"],
        "Answer",
        json!({"action":"fill","text":"bridge-value"}),
    )?)
    .unwrap();
    // An automatic visible-context renewal must not consume an observed frame.
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("parent".into()),
        true,
        Some(origin.clone()),
    )
    .await?;
    let result = bridge_call(connection, "parent", "perform", request.clone()).await?;
    if result["result"]["effect"] != "applied" {
        return Err("delegated action did not produce a receipt".into());
    }
    if bridge_call(connection, "parent", "perform", request).await?["ok"] != false {
        return Err("bridge replayed an already consumed action".into());
    }
    let actual = bridge_call(connection, "parent", "observe", json!({})).await?;
    if !actual["result"]["nodes"].as_array().is_some_and(|nodes| {
        nodes
            .iter()
            .any(|node| node["label"] == "Answer" && node["value"] == "bridge-value")
    }) {
        return Err("bridge receipt was not backed by actual native page state".into());
    }
    let restore = serde_json::to_value(action(
        &actual["result"],
        "Answer",
        json!({"action":"fill","text":"unchanged"}),
    )?)
    .unwrap();
    bridge_call(connection, "parent", "perform", restore).await?;
    browser::desktop_browser_activate(main.clone(), app.state(), None).await?;
    browser::desktop_browser_activate(main.clone(), app.state(), Some("probe".into())).await?;
    if bridge_call(connection, "parent", "list", json!({})).await?["result"]["available"] != false {
        return Err("hide/reselect resurrected browser consent".into());
    }
    println!("Private native bridge passed: exact chat binding, read-only denial, frame-preserving renewal, real fill, consumed-frame denial, hide/reselect revocation (no model)");
    Ok(())
}

async fn probe(app: &tauri::AppHandle, url: String) -> Result<(), String> {
    let main = app.get_webview("main").ok_or("missing main view")?;
    browser::desktop_browser_bounds(
        main.clone(),
        app.state(),
        serde_json::from_value(json!({"x":0,"y":0,"width":780,"height":560})).unwrap(),
    )
    .await?;
    browser::desktop_browser_activate(main.clone(), app.state(), Some("probe".into())).await?;
    browser::desktop_browser_navigate(app.clone(), main.clone(), app.state(), "probe".into(), url)
        .await?;
    let mut observation = Value::Null;
    for _ in 0..50 {
        match browser_inspect::desktop_browser_inspect(
            main.clone(),
            app.state(),
            "probe".into(),
            Default::default(),
        )
        .await
        {
            Ok(value)
                if value["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("Native observation probe")) =>
            {
                observation = value;
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    if observation.is_null() {
        return Err("native callback did not produce fixture evidence".into());
    }
    delegation_probe(app, &main).await?;
    observation = observe(app, &main).await?;
    let nodes = observation["nodes"].as_array().ok_or("missing nodes")?;
    if !nodes
        .iter()
        .any(|x| x["label"] == "Answer" && x["value"] == "unchanged")
        || observation.to_string().contains("private-native-secret")
    {
        return Err("native callback failed read-only/redaction contract".into());
    }
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    if browser_inspect::desktop_browser_inspect(
        guest.clone(),
        app.state(),
        "probe".into(),
        Default::default(),
    )
    .await
    .is_ok()
    {
        return Err("guest caller was incorrectly authorized".into());
    }
    guest
        .eval(
            r#"if (window.__TAURI__?.core?.invoke) {
      window.__TAURI__.core.invoke('desktop_browser_inspect', {tabId:'probe',request:{}})
        .then(()=>document.querySelector('#ipc').textContent='IPC incorrectly allowed')
        .catch(()=>document.querySelector('#ipc').textContent='IPC denied');
    } else { document.querySelector('#ipc').textContent='IPC unavailable'; }"#,
        )
        .map_err(|e| e.to_string())?;
    let mut denied = false;
    for _ in 0..50 {
        let value = browser_inspect::desktop_browser_inspect(
            main.clone(),
            app.state(),
            "probe".into(),
            Default::default(),
        )
        .await?;
        let text = value["text"].as_str().unwrap_or("");
        if text.contains("IPC denied") || text.contains("IPC unavailable") {
            denied = true;
            break;
        }
        if text.contains("IPC incorrectly allowed") {
            return Err("native IPC capability leaked to guest".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !denied {
        return Err("guest IPC check did not settle".into());
    }
    let snapshot = observe(app, &main).await?;
    let fill = json!({"action":"fill","text":"native action"});
    if browser_perform::desktop_browser_perform(
        guest.clone(),
        app.state(),
        "probe".into(),
        action(&snapshot, "Answer", fill.clone())?,
    )
    .await
    .is_ok()
    {
        return Err("guest action caller was incorrectly authorized".into());
    }
    if !perform(app, &main, action(&snapshot, "Answer", fill.clone())?)
        .await?
        .ok
    {
        return Err("native fill was not applied".into());
    }
    if perform(app, &main, action(&snapshot, "Answer", fill)?)
        .await
        .is_ok()
    {
        return Err("consumed native frame allowed duplicate action".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["label"] == "Answer" && node["value"] == "native action")
    {
        return Err("native fill did not change the actual page input".into());
    }
    if !perform(
        app,
        &main,
        action(&snapshot, "Choice", json!({"action":"select","value":"b"}))?,
    )
    .await?
    .ok
    {
        return Err("native select was not applied".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["label"] == "Choice" && node["value"] == "b")
    {
        return Err("native select did not change actual selection".into());
    }
    if !perform(
        app,
        &main,
        action(&snapshot, "Apply", json!({"action":"click"}))?,
    )
    .await?
    .ok || !observe(app, &main).await?["text"]
        .as_str()
        .unwrap_or("")
        .contains("Applied native action")
    {
        return Err("native click did not update the actual page".into());
    }
    let snapshot = observe(app, &main).await?;
    guest.eval("document.querySelector('#apply').replaceWith(document.querySelector('#apply').cloneNode(true))").map_err(|error| error.to_string())?;
    if perform(
        app,
        &main,
        action(&snapshot, "Apply", json!({"action":"click"}))?,
    )
    .await?
    .effect
        != browser_perform::Effect::NotStarted
    {
        return Err("identical replacement DOM node incorrectly accepted an action".into());
    }
    let snapshot = observe(app, &main).await?;
    guest
        .eval("document.querySelector('#answer').value='user edit'")
        .map_err(|error| error.to_string())?;
    if perform(
        app,
        &main,
        action(
            &snapshot,
            "Answer",
            json!({"action":"fill","text":"overwrite"}),
        )?,
    )
    .await?
    .effect
        != browser_perform::Effect::NotStarted
    {
        return Err("native action overwrote an intervening user edit".into());
    }
    let snapshot = observe(app, &main).await?;
    guest
        .eval("document.querySelector('#answer').dispatchEvent=()=>{throw Error('after-effect failure')}")
        .map_err(|error| error.to_string())?;
    if perform(
        app,
        &main,
        action(
            &snapshot,
            "Answer",
            json!({"action":"fill","text":"partial effect"}),
        )?,
    )
    .await?
    .effect
        != browser_perform::Effect::Unknown
    {
        return Err("after-effect native failure was incorrectly classified".into());
    }
    if perform(
        app,
        &main,
        action(
            &snapshot,
            "Answer",
            json!({"action":"fill","text":"blind replay"}),
        )?,
    )
    .await
    .is_ok()
    {
        return Err("after-effect native failure allowed blind replay".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["label"] == "Answer" && node["value"] == "partial effect")
    {
        return Err("after-effect failure did not preserve actual page-state evidence".into());
    }
    guest
        .eval("delete document.querySelector('#answer').dispatchEvent")
        .map_err(|error| error.to_string())?;
    if !perform(
        app,
        &main,
        action(
            &snapshot,
            "Answer",
            json!({"action":"fill","text":"user edit"}),
        )?,
    )
    .await?
    .ok
    {
        return Err("native action did not recover after re-observation".into());
    }
    let snapshot = observe(app, &main).await?;
    // A seven-second blocked renderer exceeds the six-second callback wait.
    // The queued action expires at five seconds and must not execute later.
    guest
        .eval("{ const end=performance.now()+7000; while(performance.now()<end){} }")
        .map_err(|error| error.to_string())?;
    let delayed = action(
        &snapshot,
        "Answer",
        json!({"action":"fill","text":"forgotten effect"}),
    )?;
    if perform(app, &main, delayed).await?.effect != browser_perform::Effect::Unknown {
        return Err("missing native callback was not reported as uncertain".into());
    }
    if perform(
        app,
        &main,
        action(
            &snapshot,
            "Answer",
            json!({"action":"fill","text":"blind retry"}),
        )?,
    )
    .await
    .is_ok()
    {
        return Err("uncertain action frame could be blindly replayed".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["label"] == "Answer" && node["value"] == "user edit")
    {
        return Err("expired queued action executed after callback timeout".into());
    }
    // Hold the guest JS thread briefly, then change selection while the native
    // callback is pending. A completed read must not leak a stale hidden page.
    guest
        .eval("{ const end=performance.now()+300; while(performance.now()<end){} }")
        .map_err(|e| e.to_string())?;
    let inspect_app = app.clone();
    let inspect_main = main.clone();
    let pending = tauri::async_runtime::spawn(async move {
        browser_inspect::desktop_browser_inspect(
            inspect_main,
            inspect_app.state(),
            "probe".into(),
            Default::default(),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    browser::desktop_browser_activate(main.clone(), app.state(), None).await?;
    browser::desktop_browser_activate(main.clone(), app.state(), Some("probe".into())).await?;
    if pending.await.map_err(|e| e.to_string())?.is_ok() {
        return Err("hide/reselect revived a pending observation".into());
    }
    if perform(
        app,
        &main,
        action(&snapshot, "Apply", json!({"action":"click"}))?,
    )
    .await
    .is_ok()
    {
        return Err("hide/reselect revived an old action frame".into());
    }
    browser::desktop_browser_activate(main.clone(), app.state(), None).await?;
    if browser_inspect::desktop_browser_inspect(
        main,
        app.state(),
        "probe".into(),
        Default::default(),
    )
    .await
    .is_ok()
    {
        return Err("hidden tab was incorrectly inspected".into());
    }
    println!("Native Tauri DOM probe passed: observation, fill/select/click actual state, guest denial, duplicate/replacement/user-edit guards, callback timeout/expired action, hidden/hide-reselect races (no model/OS input)");
    Ok(())
}

fn main() {
    let url = fixture();
    let mut context = tauri::generate_context!();
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).expect("native probe entropy");
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    context.config_mut().identifier = format!("com.xlang.xharness.browser-inspect-probe.r{nonce}");
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .manage(browser_bridge::BrowserBridge::default())
        .invoke_handler(tauri::generate_handler![
            browser_delegation::desktop_browser_delegate,
            browser_delegation::desktop_browser_access,
            browser_inspect::desktop_browser_inspect,
            browser_perform::desktop_browser_perform
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Native browser observation probe")
                .inner_size(800.0, 600.0)
                .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    tokio::time::timeout(Duration::from_secs(45), probe(&handle, url)).await;
                let success = matches!(&result, Ok(Ok(())));
                if !success {
                    eprintln!("Native observation probe failed: {result:?}");
                }
                browser::close_all(&handle);
                handle.exit(if success { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .expect("native probe startup");
    app.run(|_, _| {});
}
