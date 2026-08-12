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
#[path = "../src/browser_lifecycle.rs"]
mod browser_lifecycle;
#[path = "../src/browser_perform.rs"]
mod browser_perform;

mod native_api;
#[path = "../src/native_startup.rs"]
mod native_startup;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

const HTML: &str = r#"<!doctype html><main><h1>Native observation probe</h1><label for="answer">Answer</label><input id="answer" value="unchanged"><input type="password" value="private-native-secret"><button disabled>Unavailable</button><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button id="apply" onclick="document.querySelector('#status').textContent='Applied '+document.querySelector('#answer').value">Apply</button><p id="status">Not applied</p><p id="ipc">IPC pending</p></main><script>
window.probeEvents=[];
for(const type of ['click','input','keydown'])document.addEventListener(type,event=>probeEvents.push({type,trusted:event.isTrusted}),true);
</script>"#;

fn serve_fixture(html: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture bind");
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut headers = [0; 4096];
            let _ = stream.read(&mut headers);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
        }
    });
    format!("http://{address}/")
}
fn fixture() -> String {
    // Different ports are different origins; no CORS relaxation or proxy.
    let child = serve_fixture(
        r#"<!doctype html><style>body{margin:0}button{position:absolute;left:0;top:0;width:150px;height:44px}</style><button id='child' onclick="parent.postMessage({kind:'native-child',trusted:event.isTrusted},'*')">Cross-origin private button</button>"#.into(),
    );
    serve_fixture(format!(
        "{HTML}<iframe id='cross-origin' src='{child}'></iframe>"
    ))
}

async fn evidence(guest: &tauri::Webview, expression: &str) -> Result<Value, String> {
    let raw = browser_inspect::evaluate(guest, format!("JSON.stringify({expression})")).await?;
    browser_inspect::decode_callback(&raw)
}

async fn abandoned_open_probe(
    app: &tauri::AppHandle,
    connection: &browser_bridge::Connection,
    url: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let (opened, receive_open) = tokio::sync::oneshot::channel();
    let opened = std::sync::Mutex::new(Some(opened));
    let open_listener = app.listen_any("xharness-browser-control-open", move |event| {
        let value: Value = serde_json::from_str(event.payload()).unwrap();
        if let Some(sender) = opened.lock().unwrap().take() {
            let _ = sender.send(value["requestId"].as_str().unwrap().to_owned());
        }
    });
    let (cancelled, receive_cancel) = tokio::sync::oneshot::channel();
    let cancelled = std::sync::Mutex::new(Some(cancelled));
    let cancel_listener = app.listen_any("xharness-browser-control-cancel", move |event| {
        let id: String = serde_json::from_str(event.payload()).unwrap();
        if let Some(sender) = cancelled.lock().unwrap().take() {
            let _ = sender.send(id);
        }
    });
    let mut stream = tokio::net::TcpStream::connect(&connection.address)
        .await
        .map_err(|_| "cancel probe connect failed")?;
    let bytes = serde_json::to_vec(&json!({"token":connection.token,"owner":"probe-owner","op":"control","arguments":{"action":"open","url":url}})).unwrap();
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|_| "cancel probe write failed")?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| "cancel probe write failed")?;
    let id = tokio::time::timeout(Duration::from_secs(3), receive_open)
        .await
        .map_err(|_| "cancel probe open event missing")?
        .map_err(|_| "cancel probe receiver closed")?;
    drop(stream);
    let cancelled_id = tokio::time::timeout(Duration::from_secs(3), receive_cancel)
        .await
        .map_err(|_| "abandoned socket did not cancel UI open")?
        .map_err(|_| "cancel probe receiver closed")?;
    app.unlisten(open_listener);
    app.unlisten(cancel_listener);
    if id != cancelled_id {
        return Err("abandoned open cancelled a different request".into());
    }
    Ok(())
}

async fn lifecycle_probe(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let connection_state = app.state::<browser_bridge::BrowserBridge>();
    let connection = connection_state.start(app).await?;
    let empty = bridge_call(connection, "probe-owner", "list", json!({})).await?;
    if empty["result"]["available"] != true || empty["result"]["bound"] != false {
        return Err("zero-tab browser discovery failed".into());
    }
    let denied = bridge_call(
        connection,
        "probe-owner",
        "control",
        json!({"action":"eval","script":"private-input"}),
    )
    .await?;
    if denied["result"]["ok"] != false
        || denied["result"]["effect"] != "not_started"
        || denied.to_string().contains("private-input")
    {
        return Err("invalid control did not return a sanitized predispatch denial".into());
    }
    abandoned_open_probe(app, connection, url).await?;
    // A native test-owned UI adapter uses exactly the production pane commands.
    // React sidebar expansion is tested separately, not falsely claimed here.
    let handle = app.clone();
    let listener = app.listen_any("xharness-browser-control-open", move |event| {
        let value: Value = serde_json::from_str(event.payload()).unwrap();
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            let caller = app.get_webview("main").unwrap();
            let request_id = value["requestId"].as_str().unwrap().to_owned();
            let tab_id = format!("browser:{request_id}");
            let owner = value["owner"].as_str().unwrap().to_owned();
            let url = value["url"].as_str().unwrap().to_owned();
            browser::desktop_browser_bounds(
                caller.clone(),
                app.state(),
                serde_json::from_value(json!({"x":0,"y":0,"width":780,"height":560})).unwrap(),
            )
            .await
            .unwrap();
            browser::desktop_browser_activate(caller.clone(), app.state(), Some(tab_id.clone()))
                .await
                .unwrap();
            browser::desktop_browser_navigate(
                app.clone(),
                caller.clone(),
                app.state(),
                tab_id.clone(),
                url,
            )
            .await
            .unwrap();
            if owner == "interrupted-owner" {
                browser_lifecycle::desktop_browser_control_reply(
                    app.clone(),
                    caller.clone(),
                    app.state(),
                    request_id,
                    browser_lifecycle::ControlReply::Failed {},
                )
                .await
                .unwrap();
                browser::desktop_browser_close(caller, app.state(), tab_id)
                    .await
                    .unwrap();
                return;
            }
            for _ in 0..100 {
                let (guest, _) = app
                    .state::<browser::BrowserState>()
                    .inspection_target(&tab_id)
                    .unwrap();
                let origin = guest.url().unwrap().origin().ascii_serialization();
                let _ = browser_delegation::desktop_browser_delegate(
                    caller.clone(),
                    app.state(),
                    tab_id.clone(),
                    Some(owner.clone()),
                    true,
                    Some(origin),
                )
                .await;
                if browser_lifecycle::desktop_browser_control_reply(
                    app.clone(),
                    caller.clone(),
                    app.state(),
                    request_id.clone(),
                    browser_lifecycle::ControlReply::Ready {
                        tab_id: tab_id.clone(),
                    },
                )
                .await
                .unwrap()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
    });
    let opened = bridge_call(
        connection,
        "probe-owner",
        "control",
        json!({"action":"open","url":url}),
    )
    .await?;
    if opened["result"]["state"] != "ready" {
        return Err("native open did not reach ready".into());
    }
    let view = bridge_call(connection, "probe-owner", "observe", json!({})).await?;
    let fill = serde_json::to_value(action(
        &view["result"],
        "Answer",
        json!({"action":"fill","text":"opened-through-control"}),
    )?)
    .unwrap();
    let receipt = bridge_call(connection, "probe-owner", "perform", fill).await?;
    let view = bridge_call(connection, "probe-owner", "observe", json!({})).await?;
    if receipt["result"]["effect"] != "applied"
        || !view["result"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["value"] == "opened-through-control")
    {
        return Err("zero-tab native action lacked verified actual result".into());
    }
    let interrupted = bridge_call(
        connection,
        "interrupted-owner",
        "control",
        json!({"action":"open","url":url}),
    )
    .await?;
    app.unlisten(listener);
    if interrupted["result"]["ok"] != false || interrupted["result"]["effect"] != "unknown" {
        return Err("closing an admitted native navigation incorrectly claimed not_started".into());
    }
    let main = app.get_webview("main").unwrap();
    browser::desktop_browser_close(
        main,
        app.state(),
        opened["result"]["tab_id"].as_str().unwrap().into(),
    )
    .await?;
    println!("Native lifecycle probe passed: zero-tab discovery -> abandoned-socket cancellation -> open -> native load/binding -> observe -> fill -> observe verification (test UI adapter, no model)");
    Ok(())
}

async fn native_api_probe(app: &tauri::AppHandle) -> Result<(), String> {
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    guest.set_focus().map_err(|_| "native probe focus failed")?;
    evidence(&guest, r#"(() => {
      window.nativeEvents=[];window.nativeChild=null;window.nativeClicked=false;
      const input=document.querySelector('#answer');input.value='';input.style='position:fixed;left:20px;top:20px;width:200px;height:30px';
      input.addEventListener('input',e=>nativeEvents.push({type:e.type,trusted:e.isTrusted}));
      for(const kind of ['keydown','keyup'])input.addEventListener(kind,e=>nativeEvents.push({type:e.type,trusted:e.isTrusted,key:e.key}));
      const button=document.createElement('button');button.id='native-probe';button.textContent='Native API target';button.style='position:fixed;left:400px;top:100px;width:150px;height:44px';button.onclick=e=>{nativeClicked=e.isTrusted;nativeEvents.push({type:e.type,trusted:e.isTrusted})};document.body.append(button);
      const frame=document.querySelector('#cross-origin');frame.style='position:fixed;left:400px;top:170px;width:200px;height:100px;border:0';
      window.addEventListener('message',e=>{if(e.source===frame.contentWindow&&e.data?.kind==='native-child')nativeChild=e.data.trusted});
      const marker=document.createElement('div');marker.id='native-marker';marker.style='position:fixed;left:20px;top:120px;width:100px;height:100px;background:rgb(255,0,0)';document.body.append(marker);
      return true;
    })()"#).await?;
    let button_error = native_api::click(&guest, 450.0, 120.0).await.err();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let input_error = native_api::click(&guest, 60.0, 35.0).await.err();
    let key_error = native_api::key_z(&guest).await.err();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let child_error = native_api::click(&guest, 450.0, 190.0).await.err();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let result = evidence(&guest, "({clicked:nativeClicked,input:document.querySelector('#answer').value,events:nativeEvents,child:nativeChild,dpr:devicePixelRatio})").await?;
    let keyboard_verified = input_error.is_none()
        && key_error.is_none()
        && result["input"] == "z"
        && result["events"].as_array().is_some_and(|events| {
            ["input", "keydown", "keyup"].iter().all(|kind| {
                events
                    .iter()
                    .any(|event| event["type"] == *kind && event["trusted"] == true)
            })
        });
    let mut screenshots = Vec::new();
    for (index, color) in ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)"]
        .iter()
        .enumerate()
    {
        evidence(&guest,&format!("(() => {{document.querySelector('#native-marker').style.background={};return true}})()",json!(color))).await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        match native_api::snapshot(&guest).await {
            Ok(png) => {
                let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
                let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
                if let Some(root) = std::env::var_os("XHARNESS_NATIVE_API_EVIDENCE") {
                    let path = std::path::PathBuf::from(root);
                    std::fs::create_dir_all(&path).map_err(|_| "probe PNG directory failed")?;
                    std::fs::write(path.join(format!("snapshot-{index}.png")), &png)
                        .map_err(|_| "probe PNG write failed")?;
                }
                screenshots.push(json!({"index":index,"width":width,"height":height,"bytes":png.len(),"status":"captured"}));
            }
            Err(error) => screenshots.push(json!({"index":index,"status":"failed","error":error})),
        }
    }
    // API feasibility only: owned disposable view, never a production grant.
    // Change the marker while hidden so a stale cached image cannot pass.
    guest.hide().map_err(|_| "probe hide failed")?;
    let background_script = evidence(&guest,
        "(() => {document.querySelector('#native-marker').style.background='rgb(255,255,0)';return true})()")
        .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let hidden_snapshot = match native_api::snapshot(&guest).await {
        Ok(png) => {
            if let Some(root) = std::env::var_os("XHARNESS_NATIVE_API_EVIDENCE") {
                std::fs::write(
                    std::path::PathBuf::from(root).join("snapshot-hidden.png"),
                    &png,
                )
                .map_err(|_| "hidden probe PNG write failed")?;
            }
            json!({"status":"captured","width":u32::from_be_bytes(png[16..20].try_into().unwrap()),
                "height":u32::from_be_bytes(png[20..24].try_into().unwrap()),"bytes":png.len()})
        }
        Err(error) => json!({"status":"failed","error":error}),
    };
    guest
        .show()
        .map_err(|_| "probe restore visibility failed")?;
    println!(
        "NATIVE_API_EVIDENCE {}",
        json!({"platform":std::env::consts::OS,"test_only":true,
        "production_enabled":false,"native_mouse":{"passed":button_error.is_none()&&result["clicked"]==true,"error":button_error},
        "native_keyboard":{"passed":keyboard_verified,"focus_error":input_error,"error":key_error},
        "cross_origin_pointer":{"passed":child_error.is_none()&&result["child"]==true,"error":child_error},
        "cross_origin_frame_traversal":{"status":"not_implemented"},
        "screenshots":screenshots,"observed":result,
        "recording":{"status":"frame_sequence_only; not a production video recorder"},
        "hidden_background":{"status":"test_only; production delegation still denies hidden tabs",
            "script_executed":background_script==true,"snapshot":hidden_snapshot}})
    );
    Ok(())
}

async fn hard_capability_probe(app: &tauri::AppHandle) -> Result<(), String> {
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    let view = observe(app, &app.get_webview("main").unwrap()).await?;
    if view["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["label"] == "Cross-origin private button")
    {
        return Err("top document unexpectedly advertised cross-origin refs".into());
    }
    let observed = evidence(&guest, r#"(() => {
      const result={events:window.probeEvents,frameReadable:false};
      try { result.frameReadable=Boolean(document.querySelector('#cross-origin').contentWindow.document.body); }
      catch(error){result.frameError=error.name;}
      return result;
    })()"#).await?;
    if observed["frameReadable"] != false || observed["frameError"] != "SecurityError" {
        return Err("cross-origin negative control did not encounter the SOP boundary".into());
    }
    let events = observed["events"]
        .as_array()
        .ok_or("missing event evidence")?;
    if !events.iter().any(|e| e["type"] == "click") || events.iter().any(|e| e["trusted"] == true) {
        return Err("DOM action trusted-input negative control failed".into());
    }
    println!(
        "HARD_CAPABILITY_EVIDENCE {}",
        json!({
          "platform":std::env::consts::OS,"engine":"native-tauri-system-webview",
          "trusted_input":{"status":"not_implemented","observed_dom_events":events},
          "cross_origin_frames":{"status":"not_implemented","top_document_probe":observed["frameError"]},
          "screenshot":{"status":"not_implemented"},"recording":{"status":"not_implemented"},
          "hidden_tab_actions":{"status":"unsupported_by_current_policy","verified_by_hidden_tab_guard":true},
          "parity_gate":"blocked; DOM actions are not native input; no claim of full ZCode parity"
        })
    );
    Ok(())
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

    if bridge_call(connection, "parent", "list", json!({})).await?["result"]["bound"] != false {
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
    let denied = bridge_call(connection, "parent", "perform", request).await?;
    if denied["result"]["ok"] != false || denied["result"]["effect"] != "not_started" {
        return Err("read-only denial did not report an unstarted action".into());
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
    let malformed = bridge_call(
        connection,
        "parent",
        "perform",
        json!({"action":"eval","script":"document.querySelector('#answer').value='forbidden'"}),
    )
    .await?;
    if malformed["result"]["ok"] != false || malformed["result"]["effect"] != "not_started" {
        return Err("invalid schema was classified as an uncertain effect".into());
    }
    // The following valid fill uses the SAME frame: the rejected request neither
    // scheduled arbitrary JS nor consumed the observation capability.
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
    let replay = bridge_call(connection, "parent", "perform", request).await?;
    if replay["result"]["ok"] != false || replay["result"]["effect"] != "not_started" {
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
    if bridge_call(connection, "parent", "list", json!({})).await?["result"]["bound"] != false {
        return Err("hide/reselect resurrected browser consent".into());
    }
    println!("Private native bridge passed: exact chat binding, read-only denial, frame-preserving renewal, real fill, consumed-frame denial, hide/reselect revocation (no model)");
    Ok(())
}

async fn probe(app: &tauri::AppHandle, url: String) -> Result<(), String> {
    lifecycle_probe(app, &url).await?;
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
    // DOM setters bypass native modal input blocking unless the fixed action
    // function enforces it. Open after observing to exercise that race too.
    let before_modal = observe(app, &main).await?;
    guest
        .eval(r#"document.body.insertAdjacentHTML('beforeend','<dialog id="modal"><label for="modal-edit">Modal field</label><input id="modal-edit"><button id="modal-close" onclick="this.closest(\'dialog\').close()">Close modal</button></dialog>');document.querySelector('#modal').showModal()"#)
        .map_err(|error| error.to_string())?;
    if perform(
        app,
        &main,
        action(
            &before_modal,
            "Answer",
            json!({"action":"fill","text":"behind modal"}),
        )?,
    )
    .await?
    .effect
        != browser_perform::Effect::NotStarted
    {
        return Err("native action bypassed a newly opened modal".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"].as_array().unwrap().iter().any(|node| {
        node["label"] == "Answer" && node["value"] == "native action" && node["disabled"] == true
    }) {
        return Err("modal observation exposed actionable background or changed its value".into());
    }
    if !perform(
        app,
        &main,
        action(
            &snapshot,
            "Modal field",
            json!({"action":"fill","text":"inside modal"}),
        )?,
    )
    .await?
    .ok
    {
        return Err("modal guard incorrectly blocked its own input".into());
    }
    let snapshot = observe(app, &main).await?;
    if !snapshot["nodes"].as_array().unwrap().iter().any(|node| {
        node["label"] == "Modal field"
            && node["value"] == "inside modal"
            && node["disabled"] == false
    }) {
        return Err("native modal fill did not change actual page state".into());
    }
    perform(
        app,
        &main,
        action(&snapshot, "Close modal", json!({"action":"click"}))?,
    )
    .await?;
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
    hard_capability_probe(app).await?;
    native_api_probe(app).await?;
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
    println!("Native Tauri DOM probe passed: observation, fill/select/click actual state, guest denial, duplicate/replacement/user-edit guards, callback timeout/expired action, hidden/hide-reselect races (no model/global OS input)");
    Ok(())
}

fn main() {
    native_startup::prepare().expect("native probe prerequisites failed");
    let completion = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completed = completion.clone();
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
        .manage(browser_lifecycle::BrowserLifecycle::default())
        .invoke_handler(tauri::generate_handler![
            browser_lifecycle::desktop_browser_control_reply,
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
            let completed = completed.clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    tokio::time::timeout(Duration::from_secs(120), probe(&handle, url)).await;
                let success = matches!(&result, Ok(Ok(())));
                completed.store(success, std::sync::atomic::Ordering::SeqCst);
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
    std::process::exit(if completion.load(std::sync::atomic::Ordering::SeqCst) {
        0
    } else {
        1
    });
}
