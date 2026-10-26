//! Opt-in native callback smoke test. Run only on an isolated display/profile.
//! It starts no Host/model and does not use the user's browser/app data.

#[path = "../src/browser.rs"]
#[allow(dead_code)] // The probe intentionally omits persistence/download UI paths.
mod browser;
#[path = "../src/browser_activity.rs"]
mod browser_activity;
#[path = "../src/browser_bridge.rs"]
mod browser_bridge;
#[path = "../src/browser_delegation.rs"]
mod browser_delegation;
#[path = "../src/browser_inspect.rs"]
mod browser_inspect;
#[path = "../src/browser_lifecycle.rs"]
mod browser_lifecycle;
#[path = "../src/browser_native/mod.rs"]
mod browser_native;
#[path = "../src/browser_perform.rs"]
mod browser_perform;
#[path = "../src/browser_picker.rs"]
mod browser_picker;

#[path = "../src/lifecycle_trace.rs"]
mod lifecycle_trace;
mod native_api;
#[path = "../src/native_startup.rs"]
mod native_startup;
#[path = "probe_support/readiness.rs"]
mod readiness;
#[path = "probe_support/viewport.rs"]
mod viewport_probe;

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
            let mut headers = Vec::new();
            let mut chunk = [0; 1024];
            while headers.len() < 8192 && !headers.windows(4).any(|part| part == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => headers.extend_from_slice(&chunk[..length]),
                }
            }
            if !headers.windows(4).any(|part| part == b"\r\n\r\n") {
                continue;
            }
            let headers = String::from_utf8_lossy(&headers);
            let identity = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("user-agent")
                        .then(|| value.trim())
                })
                .unwrap_or_default();
            let identity = serde_json::to_string(identity)
                .unwrap()
                .replace('<', "\\u003c");
            let response = format!("{html}<script>window.probeHttpUserAgent={identity}</script>");
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
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
    let activity = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let observed = activity.clone();
    let activity_listener = app.listen_any("xharness-browser-activity", move |event| {
        if let Ok(value) = serde_json::from_str(event.payload()) {
            observed.lock().unwrap().push(value);
        }
    });
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
    app.unlisten(activity_listener);
    if id != cancelled_id {
        return Err("abandoned open cancelled a different request".into());
    }
    assert_activity_pairs(
        &activity.lock().unwrap(),
        "probe-owner",
        &format!("browser:{id}"),
    )?;
    println!("Native browser activity cancellation: balanced start/finish on abandoned authenticated socket");
    Ok(())
}

fn assert_activity_pairs(events: &[Value], owner: &str, tab: &str) -> Result<(), String> {
    let mut active = std::collections::HashMap::new();
    if events.len() < 2 {
        return Err("native browser activity events were missing".into());
    }
    for event in events {
        if event["backend"] != "embedded" || event["owner"] != owner || event["tabId"] != tab {
            return Err("native browser activity claimed a different backend/owner/tab".into());
        }
        let id = event["id"].as_str().ok_or("native activity ID missing")?;
        let operation = event["operation"]
            .as_str()
            .ok_or("native activity operation missing")?;
        match event["phase"].as_str() {
            Some("started") if !active.contains_key(id) => {
                active.insert(id, operation);
            }
            Some("finished") if active.remove(id) == Some(operation) => {}
            _ => return Err("native browser activity lifetime was unbalanced".into()),
        }
    }
    if !active.is_empty() {
        return Err("native browser activity remained running after invocation ended".into());
    }
    Ok(())
}

async fn lifecycle_probe(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let connection_state = app.state::<browser_bridge::BrowserBridge>();
    let connection = connection_state.start(app).await?;
    assert!(connection_state.is_started());
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
        let admitted_at = tokio::time::Instant::now();
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
                None,
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
            let started = tokio::time::Instant::now();
            let ready_delay = std::env::var("XHARNESS_NATIVE_PROBE_READY_DELAY_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| matches!(value, 0 | 6000))
                .unwrap_or(0);
            // Poll acknowledgement, never replay navigation/input. Reserve a
            // short interval to report failure before the production deadline.
            let result = readiness::wait(
                browser_lifecycle::OPEN_TIMEOUT
                    .saturating_sub(admitted_at.elapsed() + Duration::from_millis(250)),
                Duration::from_millis(50),
                || async {
                    if started.elapsed() < Duration::from_millis(ready_delay) {
                        return Err("test-owned Ready acknowledgement delayed".into());
                    }
                    let (guest, _) = app
                        .state::<browser::BrowserState>()
                        .inspection_target(&tab_id)?;
                    let origin = guest
                        .url()
                        .map_err(|_| "native URL unavailable")?
                        .origin()
                        .ascii_serialization();
                    browser_delegation::desktop_browser_delegate(
                        caller.clone(),
                        app.state(),
                        tab_id.clone(),
                        Some(owner.clone()),
                        true,
                        Some(origin),
                    )
                    .await?;
                    // Preserve the exact production readiness checks and expose
                    // their reason rather than reducing all failures to false.
                    app.state::<browser::BrowserState>()
                        .loaded_receipt(&owner, &tab_id)?;
                    browser_lifecycle::desktop_browser_control_reply(
                        app.clone(),
                        caller.clone(),
                        app.state(),
                        request_id.clone(),
                        browser_lifecycle::ControlReply::Ready {
                            tab_id: tab_id.clone(),
                        },
                    )
                    .await
                },
            )
            .await;
            if let Err(error) = result {
                eprintln!("Native lifecycle readiness failed: {error}");
                let _ = browser_lifecycle::desktop_browser_control_reply(
                    app.clone(),
                    caller,
                    app.state(),
                    request_id,
                    browser_lifecycle::ControlReply::Failed {},
                )
                .await;
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
        return Err(format!(
            "native open did not reach ready: ok={}, state={}, error={}",
            opened["ok"], opened["result"]["state"], opened["error"]
        ));
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

    // A foreign owner cannot close the selected tab or trigger any UI request.
    let denied_close = bridge_call(
        connection,
        "other-owner",
        "control",
        json!({"action":"close"}),
    )
    .await?;
    if denied_close["result"]["effect"] != "not_started" {
        return Err("foreign owner close was not rejected before dispatch".into());
    }
    let close_app = app.clone();
    let close_listener = app.listen_any("xharness-browser-control-close", move |event| {
        let value: Value = serde_json::from_str(event.payload()).unwrap();
        let app = close_app.clone();
        tauri::async_runtime::spawn(async move {
            let main = app.get_webview("main").unwrap();
            let id = value["requestId"].as_str().unwrap().to_owned();
            let tab = value["tabId"].as_str().unwrap().to_owned();
            // An early/forged receipt must not turn a live tab into success.
            assert!(!browser_lifecycle::desktop_browser_control_reply(
                app.clone(),
                main.clone(),
                app.state(),
                id.clone(),
                browser_lifecycle::ControlReply::Closed {
                    tab_id: tab.clone()
                }
            )
            .await
            .unwrap());
            assert!(!browser_lifecycle::desktop_browser_control_reply(
                app.clone(),
                main.clone(),
                app.state(),
                id.clone(),
                browser_lifecycle::ControlReply::Closed {
                    tab_id: "unrelated".into()
                }
            )
            .await
            .unwrap());
            browser::desktop_browser_close(main.clone(), app.state(), tab.clone())
                .await
                .unwrap();
            assert!(browser_lifecycle::desktop_browser_control_reply(
                app.clone(),
                main,
                app.state(),
                id,
                browser_lifecycle::ControlReply::Closed { tab_id: tab }
            )
            .await
            .unwrap());
        });
    });
    let closed = bridge_call(
        connection,
        "probe-owner",
        "control",
        json!({"action":"close"}),
    )
    .await?;
    app.unlisten(close_listener);
    if closed["result"]["state"] != "closed"
        || closed["result"]["tab_id"] != opened["result"]["tab_id"]
    {
        return Err(format!(
            "native close lacked exact confirmed target: {closed}"
        ));
    }
    if bridge_call(connection, "probe-owner", "observe", json!({})).await?["ok"] != false
        || bridge_call(
            connection,
            "probe-owner",
            "control",
            json!({"action":"status"}),
        )
        .await?["result"]["bound"]
            != false
    {
        return Err("closed tab retained observation/binding access".into());
    }
    // Closing again is not permission to close a different tab.
    if bridge_call(
        connection,
        "probe-owner",
        "control",
        json!({"action":"close"}),
    )
    .await?["result"]["effect"]
        != "not_started"
    {
        return Err("repeated close was not scoped to the now-absent target".into());
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
    println!("Native lifecycle probe passed: zero-tab discovery -> abandoned-socket cancellation -> open -> native load/binding -> observe -> fill -> observe verification -> owner-scoped close -> revoked access (test UI adapter, no model)");
    Ok(())
}

async fn native_api_probe(app: &tauri::AppHandle) -> Result<(), String> {
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    guest.set_focus().map_err(|_| "native probe focus failed")?;
    evidence(&guest, r#"(() => {
      window.nativeEvents=[];window.nativePointers=[];window.nativeChild=null;window.nativeClicked=false;
      for(const kind of ['mousedown','mouseup','click'])document.addEventListener(kind,e=>{if(nativePointers.length<30)nativePointers.push({type:e.type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,id:e.target.id})},true);
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
    // A native click acknowledgement is dispatch, not WebKit's cross-process
    // focus/IME acknowledgement. Observe actual focus without replaying input;
    // never send a key to the wrong control just because the callback returned.
    let focus_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let focus_observed = loop {
        if evidence(&guest, "document.activeElement?.id === 'answer'").await? == true {
            break true;
        }
        if tokio::time::Instant::now() >= focus_deadline {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let key_error = if input_error.is_none() && focus_observed {
        native_api::key_z(&guest).await.err()
    } else {
        Some("native input focus was not observed; key not dispatched".into())
    };
    tokio::time::sleep(Duration::from_millis(120)).await;
    let child_error = native_api::click(&guest, 450.0, 190.0).await.err();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let result = evidence(&guest, "({clicked:nativeClicked,input:document.querySelector('#answer').value,events:nativeEvents,pointers:nativePointers,child:nativeChild,dpr:devicePixelRatio})").await?;
    let pointer_coordinates_verified = result["pointers"].as_array().is_some_and(|events| {
        [("native-probe", 450.0, 120.0), ("answer", 60.0, 35.0)]
            .iter()
            .all(|(id, x, y)| {
                events.iter().any(|event| {
                    event["type"] == "click"
                        && event["trusted"] == true
                        && event["id"] == *id
                        && event["x"]
                            .as_f64()
                            .is_some_and(|actual| (actual - x).abs() <= 1.0)
                        && event["y"]
                            .as_f64()
                            .is_some_and(|actual| (actual - y).abs() <= 1.0)
                })
            })
    });
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
        "production_enabled":false,"native_mouse":{"passed":button_error.is_none()&&result["clicked"]==true&&pointer_coordinates_verified,"error":button_error,"coordinates_verified":pointer_coordinates_verified},
        "native_keyboard":{"passed":keyboard_verified,"focus_error":input_error,"focus_observed":focus_observed,"error":key_error},
        "cross_origin_pointer":{"passed":child_error.is_none()&&result["child"]==true,"error":child_error},
        "cross_origin_frame_traversal":{"status":"not_implemented"},
        "screenshots":screenshots,"observed":result,
        "recording":{"status":"frame_sequence_only; not a production video recorder"},
        "hidden_background":{"status":"test_only; production delegation still denies hidden tabs",
            "script_executed":background_script==true,"snapshot":hidden_snapshot}})
    );
    Ok(())
}

// Exercise the production private bridge, not just the feasibility adapters.
async fn component_picker_probe(
    app: &tauri::AppHandle,
    main: &tauri::Webview,
    guest: &tauri::Webview,
) -> Result<(), String> {
    use base64::Engine;
    let request = || browser_picker::PickRequest::Start {
        owner: "production-probe".into(),
    };
    if browser_picker::desktop_browser_pick(guest.clone(), app.state(), "probe".into(), request())
        .await
        .is_ok()
    {
        return Err("guest armed a privileged component picker".into());
    }
    evidence(guest, "(() => {nativeClicked=false;return true})()").await?;
    let armed =
        browser_picker::desktop_browser_pick(main.clone(), app.state(), "probe".into(), request())
            .await?;
    let token = armed["token"]
        .as_str()
        .ok_or("missing picker lease")?
        .to_owned();
    // Test-owned, view-local native event injection, never global OS input.
    native_api::click(guest, 450.0, 120.0).await?;
    let mut selected = Value::Null;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        selected = browser_picker::desktop_browser_pick(
            main.clone(),
            app.state(),
            "probe".into(),
            browser_picker::PickRequest::Poll {
                token: token.clone(),
            },
        )
        .await?;
        if selected["status"] != "pending" {
            break;
        }
    }
    if selected["status"] != "selected"
        || selected["selection"]["elements"][0]["id"] != "native-probe"
        || evidence(guest, "nativeClicked").await? != false
    {
        return Err("native component selection failed or triggered a page action".into());
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(
            selected["image"]["png_base64"]
                .as_str()
                .ok_or("missing picker PNG")?,
        )
        .map_err(|_| "invalid picker PNG")?;
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("picker screenshot is not native PNG".into());
    }
    if let Some(root) = std::env::var_os("XHARNESS_NATIVE_API_EVIDENCE") {
        std::fs::write(
            std::path::PathBuf::from(root).join("component-selection.png"),
            &png,
        )
        .map_err(|_| "picker evidence write failed")?;
    }
    if browser_picker::desktop_browser_pick(
        main.clone(),
        app.state(),
        "probe".into(),
        browser_picker::PickRequest::Poll { token },
    )
    .await
    .is_ok()
    {
        return Err("component selection was consumable twice".into());
    }
    println!(
        "COMPONENT_PICKER_EVIDENCE {}",
        json!({"passed":true,"selector":selected["selection"]["elements"][0]["selector"],"bounds":selected["selection"]["bounds"],"viewport":selected["selection"]["viewport"],"screenshot":"native_png","page_action_suppressed":true,"guest_ipc":"denied","duplicate_lease":"denied"})
    );
    Ok(())
}

async fn production_native_probe(app: &tauri::AppHandle) -> Result<(), String> {
    use base64::Engine;
    let main = app.get_webview("main").ok_or("main unavailable")?;
    let (guest, inspector) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    let origin = guest
        .url()
        .map_err(|_| "guest URL unavailable")?
        .origin()
        .ascii_serialization();
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("production-probe".into()),
        true,
        Some(origin),
    )
    .await?;
    let bridge = app.state::<browser_bridge::BrowserBridge>();
    let connection = bridge.start(app).await?;
    let status = bridge_call(connection, "production-probe", "list", json!({})).await?;
    if status["result"]["capabilities"]["native_input"] != true
        || status["result"]["capabilities"]["screenshot"] != true
    {
        return Err("production capabilities missing".into());
    }
    evidence(&guest,"(() => {document.querySelector('#native-marker').style.background='rgb(255,0,0)';return true})()").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let capture = bridge_call(connection, "production-probe", "screenshot", json!({})).await?;
    let frame = capture["result"]["frame_id"]
        .as_str()
        .ok_or("missing screenshot frame")?;
    let png = base64::engine::general_purpose::STANDARD
        .decode(
            capture["result"]["png_base64"]
                .as_str()
                .ok_or("missing production PNG")?,
        )
        .map_err(|_| "invalid production PNG")?;
    if png.len() < 24 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("production snapshot was not native PNG".into());
    }
    if let Some(root) = std::env::var_os("XHARNESS_NATIVE_API_EVIDENCE") {
        std::fs::write(std::path::PathBuf::from(root).join("production.png"), &png)
            .map_err(|_| "production PNG write failed")?;
    }
    let captured_viewport = capture["result"]["viewport"].clone();
    if bridge_call(connection, "other-owner", "screenshot", json!({})).await?["ok"] != false {
        return Err("screenshot leaked across owners".into());
    }
    let click = json!({"action":"click","frame_id":frame,"x":60,"y":35});
    let receipt = bridge_call(connection, "production-probe", "input", click.clone()).await?;
    if receipt["result"]["effect"] != "applied" {
        return Err(format!("production pointer not applied: {receipt}"));
    }
    if bridge_call(connection, "production-probe", "input", click).await?["result"]["effect"]
        != "not_started"
    {
        return Err("native input allowed duplicate frame".into());
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while evidence(&guest, "document.activeElement?.id==='answer'").await? != true {
        if tokio::time::Instant::now() > deadline {
            return Err("native input focus not observed".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    evidence(
        &guest,
        "(() => {document.querySelector('#answer').value='';nativeEvents=[];return true})()",
    )
    .await?;
    let observation = bridge_call(connection, "production-probe", "observe", json!({})).await?;
    let key = bridge_call(
        connection,
        "production-probe",
        "input",
        json!({"action":"key","frame_id":observation["result"]["frame_id"],"key":"z"}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    if key["result"]["effect"] != "applied"
        || evidence(&guest, "document.querySelector('#answer').value").await? != "z"
        || evidence(&guest,"nativeEvents.some(e=>e.type==='keydown'&&e.trusted)&&nativeEvents.some(e=>e.type==='keyup'&&e.trusted)").await?!=true
    {
        return Err("production key did not affect actual field".into());
    }
    let observation = bridge_call(connection, "production-probe", "observe", json!({})).await?;
    let shifted=bridge_call(connection,"production-probe","input",json!({"action":"key","frame_id":observation["result"]["frame_id"],"key":"z","modifiers":["Shift"]})).await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    if shifted["result"]["effect"] != "applied"
        || evidence(&guest, "document.querySelector('#answer').value").await? != "zZ"
    {
        return Err("production shifted key did not affect field".into());
    }
    evidence(&guest,"(() => {window.hovered=false;document.querySelector('#native-probe').addEventListener('mousemove',e=>window.hovered=e.isTrusted);return true})()").await?;
    let observation = bridge_call(connection, "production-probe", "observe", json!({})).await?;
    let moved = bridge_call(
        connection,
        "production-probe",
        "input",
        json!({"action":"move","frame_id":observation["result"]["frame_id"],"x":450,"y":120}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    if moved["result"]["effect"] != "applied" || evidence(&guest, "hovered").await? != true {
        return Err("production hover did not produce trusted event".into());
    }
    let capture = bridge_call(connection, "production-probe", "screenshot", json!({})).await?;
    evidence(&guest, "(() => {nativeChild=null;return true})()").await?;
    let child = bridge_call(
        connection,
        "production-probe",
        "input",
        json!({"action":"click","frame_id":capture["result"]["frame_id"],"x":450,"y":190}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    if child["result"]["effect"] != "applied" || evidence(&guest, "nativeChild").await? != true {
        return Err("production cross-origin pointer failed".into());
    }
    let capture = bridge_call(connection, "production-probe", "screenshot", json!({})).await?;
    inspector.invalidate();
    if bridge_call(
        connection,
        "production-probe",
        "input",
        json!({"action":"click","frame_id":capture["result"]["frame_id"],"x":450,"y":120}),
    )
    .await?["result"]["effect"]
        != "not_started"
    {
        return Err("native input accepted stale epoch".into());
    }
    browser::desktop_browser_activate(main.clone(), app.state(), None).await?;
    if bridge_call(connection, "production-probe", "screenshot", json!({})).await?["ok"] != false {
        return Err("hidden native snapshot accepted".into());
    }
    browser::desktop_browser_activate(main, app.state(), Some("probe".into())).await?;
    let main = app.get_webview("main").ok_or("main unavailable")?;
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        "probe".into(),
        Some("production-probe".into()),
        true,
        Some(
            guest
                .url()
                .map_err(|_| "guest URL unavailable")?
                .origin()
                .ascii_serialization(),
        ),
    )
    .await?;
    viewport_probe::run(app, &guest).await?;
    // Picker intentionally swallows the release click for a short guard window.
    // Run it last so that guard cannot consume the next probe's first action.
    component_picker_probe(app, &main, &guest).await?;
    println!(
        "PRODUCTION_NATIVE_EVIDENCE {}",
        json!({"passed":true,"screenshot":"native_png","viewport":captured_viewport,"input":"actual_field_zZ","hover":"trusted_mousemove","cross_origin_pointer":"trusted_child_click","duplicate_frame":"denied","stale_epoch":"denied","hidden":"denied","wrong_owner":"denied"})
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
          "trusted_input":{"status":"production_input; perform remains DOM-only","observed_dom_events":events},
          "cross_origin_frames":{"status":"not_implemented","top_document_probe":observed["frameError"]},
          "screenshot":{"status":"production_native_viewport"},"recording":{"status":"not_implemented"},
          "hidden_tab_actions":{"status":"unsupported_by_current_policy","verified_by_hidden_tab_guard":true},
          "parity_gate":"partial; cross-origin DOM traversal/recording remain absent; no full browser parity claim"
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
        .ok_or_else(|| format!("missing action target {label:?}"))?["ref"]
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
    if length
        > if op == "screenshot" {
            12 * 1024 * 1024
        } else {
            65536
        }
    {
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
    let activity = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let observed = activity.clone();
    let listener = app.listen_any("xharness-browser-activity", move |event| {
        if let Ok(value) = serde_json::from_str(event.payload()) {
            observed.lock().unwrap().push(value);
        }
    });
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
    if !activity.lock().unwrap().is_empty() {
        return Err("invalid private credentials created browser activity".into());
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
    let before_foreign = activity.lock().unwrap().len();
    if bridge_call(connection, "child", "observe", json!({})).await?["ok"] != false {
        return Err("subagent inherited browser consent".into());
    }
    if activity.lock().unwrap().len() != before_foreign {
        return Err("an unbound owner illuminated another chat's browser".into());
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
    app.unlisten(listener);
    assert_activity_pairs(&activity.lock().unwrap(), "parent", "probe")?;
    println!("Native browser activity ownership: invalid credential and foreign owner do not emit activity; authenticated calls have balanced exact-tab lifetimes");
    println!("Private native bridge passed: exact chat binding, read-only denial, frame-preserving renewal, real fill, consumed-frame denial, hide/reselect revocation (no model)");
    Ok(())
}

/// Native geometry regression: use production pane commands, not a browser
/// mock. Hidden tabs retain old native rectangles until activation refreshes
/// them. The callback also checks the real document viewport after rendering.
#[cfg(windows)]
async fn bounds_probe(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let main = app.get_webview("main").ok_or("missing main view")?;
    let window = app.get_window("main").ok_or("missing main window")?;
    let mut cases = Vec::new();
    for (name, tab, rect, create) in [
        ("initial-a", "bounds-a", [16.0, 24.0, 320.0, 240.0], true),
        ("initial-b", "bounds-b", [280.0, 84.0, 400.0, 320.0], true),
        (
            "resize-active-b",
            "bounds-b",
            [210.0, 72.0, 540.0, 410.0],
            false,
        ),
        (
            "reselect-hidden-a",
            "bounds-a",
            [210.0, 72.0, 540.0, 410.0],
            false,
        ),
        (
            "reopen-after-hidden-layout",
            "bounds-a",
            [360.0, 60.0, 380.0, 350.0],
            false,
        ),
        (
            "reselect-hidden-b",
            "bounds-b",
            [360.0, 60.0, 380.0, 350.0],
            false,
        ),
        (
            "position-only-sidebar-shift",
            "bounds-a",
            [220.0, 60.0, 380.0, 350.0],
            false,
        ),
    ] {
        if name == "reopen-after-hidden-layout" {
            browser::desktop_browser_activate(main.clone(), app.state(), None).await?;
        }
        browser::desktop_browser_bounds(
            main.clone(),
            app.state(),
            serde_json::from_value(
                json!({"x":rect[0],"y":rect[1],"width":rect[2],"height":rect[3]}),
            )
            .unwrap(),
            None,
        )
        .await?;
        browser::desktop_browser_activate(main.clone(), app.state(), Some(tab.into())).await?;
        if create {
            browser::desktop_browser_navigate(
                app.clone(),
                main.clone(),
                app.state(),
                tab.into(),
                url.into(),
            )
            .await?;
        }
        let (guest, _) = app
            .state::<browser::BrowserState>()
            .inspection_target(tab)?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let mut sample = Value::Null;
        let mut matched = false;
        for _ in 0..60 {
            let position = guest.position().map_err(|error| error.to_string())?;
            let size = guest.size().map_err(|error| error.to_string())?;
            let logical_position = position.to_logical::<f64>(scale);
            let logical_size = size.to_logical::<f64>(scale);
            let viewport = match evidence(
                &guest,
                "({width:innerWidth,height:innerHeight,ratio:devicePixelRatio})",
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    // Initial navigation can abandon an evaluation callback.
                    // Retry read-only sampling, never the navigation/action.
                    sample = json!({"case":name,"passed":false,"callback_error":error});
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            // Windows positions are relative to the parent client area. Other
            // native backends can report screen-relative positions; the size
            // and viewport assertions apply everywhere, but do not fake those
            // different origin contracts into a cross-platform position pass.
            let position_matches = !cfg!(windows)
                || ((logical_position.x - rect[0]).abs() <= 1.0
                    && (logical_position.y - rect[1]).abs() <= 1.0);
            matched = position_matches
                && (logical_size.width - rect[2]).abs() <= 1.0
                && (logical_size.height - rect[3]).abs() <= 1.0
                && viewport["width"]
                    .as_f64()
                    .is_some_and(|v| (v - rect[2]).abs() <= 2.0)
                && viewport["height"]
                    .as_f64()
                    .is_some_and(|v| (v - rect[3]).abs() <= 2.0);
            sample = json!({"case":name,"tab":tab,"expected_logical":rect,"scale_factor":scale,
                "native_physical":[position.x,position.y,size.width,size.height],"viewport":viewport,
                "position_asserted":cfg!(windows),"passed":matched});
            if matched {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        println!("BROWSER_BOUNDS_CASE {sample}");
        if !matched {
            return Err(format!("native browser bounds mismatch: {sample}"));
        }
        cases.push(sample);
    }
    browser::desktop_browser_close(main.clone(), app.state(), "bounds-a".into()).await?;
    browser::desktop_browser_close(main, app.state(), "bounds-b".into()).await?;
    println!(
        "BROWSER_BOUNDS_EVIDENCE {}",
        json!({"passed":true,"cases":cases,"test_only":true,"host_or_model_started":false})
    );
    Ok(())
}

async fn probe(app: &tauri::AppHandle, url: String) -> Result<(), String> {
    #[cfg(windows)]
    bounds_probe(app, &url).await?;
    if std::env::var("XHARNESS_NATIVE_PROBE_BOUNDS_ONLY").as_deref() == Ok("1") {
        #[cfg(windows)]
        return Ok(());
        #[cfg(not(windows))]
        return Err("Windows bounds fixture cannot certify another native backend".into());
    }
    lifecycle_probe(app, &url).await?;
    subframe_navigation_probe(app).await?;
    let main = app.get_webview("main").ok_or("missing main view")?;
    browser::desktop_browser_bounds(
        main.clone(),
        app.state(),
        serde_json::from_value(json!({"x":0,"y":0,"width":780,"height":560})).unwrap(),
        None,
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
    let (guest, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("probe")?;
    let identity = evidence(
        &guest,
        "({http:window.probeHttpUserAgent,js:navigator.userAgent})",
    )
    .await?;
    let native = evidence(&main, "navigator.userAgent").await?;
    println!(
        "USER_AGENT_EVIDENCE {}",
        json!({"main":native,"guest":identity,"first_request_matches_js":identity["http"].is_string() && identity["http"] == identity["js"],"test_only":true})
    );
    if !identity["http"].is_string() || identity["http"] != identity["js"] {
        return Err("guest HTTP and JavaScript browser identities differ".into());
    }
    #[cfg(target_os = "macos")]
    {
        let guest_ua = identity["js"].as_str().ok_or("missing guest identity")?;
        if !guest_ua.starts_with(native.as_str().ok_or("missing main identity")?)
            || !guest_ua
                .split_whitespace()
                .any(|token| token.starts_with("Version/"))
            || !guest_ua
                .split_whitespace()
                .any(|token| token.starts_with("Safari/"))
        {
            return Err(
                "macOS guest identity did not preserve WebKit and include Safari version".into(),
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    if identity["js"] != native {
        return Err("non-macOS browser identity was unexpectedly changed".into());
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
    production_native_probe(app).await?;
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

// The real native engine, not a mocked URL event. A post-load iframe must not
// replace the address, unbind the owner or reset a completed top-level load.
async fn subframe_navigation_probe(app: &tauri::AppHandle) -> Result<(), String> {
    let tab_id = "navigation-probe";
    let main = app.get_webview("main").ok_or("missing main view")?;
    let top = serve_fixture("<!doctype html><title>Top-level navigation fixture</title><h1>Top page</h1><button>Top action</button>".into());
    let cross = serve_fixture("<!doctype html><h1>Cross-origin child</h1>".into());
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = std::sync::Arc::clone(&events);
    let listener = app.listen_any("xharness-browser-event", move |event| {
        let payload: Value = serde_json::from_str(event.payload()).unwrap();
        if payload["tabId"] == "navigation-probe" {
            captured.lock().unwrap().push(payload);
        }
    });
    browser::desktop_browser_activate(main.clone(), app.state(), Some(tab_id.into())).await?;
    browser::desktop_browser_navigate(
        app.clone(),
        main.clone(),
        app.state(),
        tab_id.into(),
        top.clone(),
    )
    .await?;
    let (guest, inspector) = app
        .state::<browser::BrowserState>()
        .inspection_target(tab_id)?;
    if browser::desktop_browser_page_state(guest.clone(), app.state(), tab_id.into())
        .await
        .is_ok()
    {
        return Err("guest caller was authorized to sample shell browser state".into());
    }
    for _ in 0..100 {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "loaded")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let origin = url::Url::parse(&top)
        .unwrap()
        .origin()
        .ascii_serialization();
    browser_delegation::desktop_browser_delegate(
        main.clone(),
        app.state(),
        tab_id.into(),
        Some("frame-owner".into()),
        true,
        Some(origin),
    )
    .await?;
    app.state::<browser::BrowserState>()
        .loaded_receipt("frame-owner", tab_id)?;
    for (index, destination) in [format!("{top}same-origin"), cross].iter().enumerate() {
        let snapshot = browser_inspect::desktop_browser_inspect(
            main.clone(),
            app.state(),
            tab_id.into(),
            Default::default(),
        )
        .await?;
        let epoch = inspector
            .navigation_epoch
            .load(std::sync::atomic::Ordering::SeqCst);
        events.lock().unwrap().clear();
        guest.eval(format!("{{const frame=document.createElement('iframe');frame.onload=()=>document.body.dataset.frameLoaded='{}';frame.src={};document.body.append(frame)}}",index,serde_json::to_string(destination).unwrap())).map_err(|error|error.to_string())?;
        let marker = index.to_string();
        let mut settled = false;
        for _ in 0..100 {
            if evidence(&guest, "({loaded:document.body.dataset.frameLoaded})").await?["loaded"]
                .as_str()
                == Some(marker.as_str())
            {
                settled = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !settled {
            return Err("subframe fixture did not load".into());
        }
        if guest.url().map_err(|error| error.to_string())?.as_str() != top
            || events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "url" && event["value"] != top)
        {
            return Err("subframe navigation polluted the top-level address".into());
        }
        app.state::<browser::BrowserState>()
            .loaded_receipt("frame-owner", tab_id)
            .map_err(|error| format!("subframe navigation reset readiness/binding: {error}"))?;
        let page = serde_json::to_value(
            browser::desktop_browser_page_state(main.clone(), app.state(), tab_id.into()).await?,
        )
        .unwrap();
        if page["url"] != top || page["loaded"] != true {
            return Err("authoritative page sample used a child URL or readiness".into());
        }
        // Conservative ref invalidation remains intact where the native engine
        // reports the iframe policy. The owner/origin grant is NOT invalidated.
        if inspector
            .navigation_epoch
            .load(std::sync::atomic::Ordering::SeqCst)
            != epoch
            && inspector
                .claim(snapshot["frame_id"].as_str().unwrap(), None)
                .is_ok()
        {
            return Err("navigation policy retained a stale action frame".into());
        }
    }
    events.lock().unwrap().clear();
    guest
        .eval("location.hash='native-fragment'")
        .map_err(|error| error.to_string())?;
    let expected = format!("{top}#native-fragment");
    let mut hash_settled = false;
    for _ in 0..100 {
        let page = serde_json::to_value(
            browser::desktop_browser_page_state(main.clone(), app.state(), tab_id.into()).await?,
        )
        .unwrap();
        if page["url"] == expected
            && page["loaded"] == true
            && events.lock().unwrap().iter().any(|event| {
                event["kind"] == "navigation-policy"
                    || (event["kind"] == "url" && event["value"] == expected)
            })
        {
            hash_settled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !hash_settled {
        return Err(
            "same-document navigation did not expose an authoritative location hint".into(),
        );
    }
    app.state::<browser::BrowserState>()
        .loaded_receipt("frame-owner", tab_id)?;
    app.unlisten(listener);
    browser::desktop_browser_close(main, app.state(), tab_id.into()).await?;
    println!(
        "SUBFRAME_NAVIGATION_EVIDENCE {}",
        json!({"same_origin":"passed","cross_origin":"passed","same_document":"passed","top_level_address":"preserved","loaded_owner_receipt":"preserved","guest_caller":"denied","test_only":true})
    );
    Ok(())
}

fn main() {
    native_startup::prepare().expect("native probe prerequisites failed");
    let completion = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completed = completion.clone();
    let url = fixture();
    // The Rust adapter owns lifecycle events. Loading the production React UI
    // here introduces a second adapter that may reject the probe's fake owner.
    let shell = url::Url::parse(&serve_fixture(
        "<!doctype html><title>Native probe shell</title>".into(),
    ))
    .expect("probe shell URL");
    let mut context = tauri::generate_context!();
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).expect("native probe entropy");
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    context.config_mut().identifier = format!("com.xlang.xharness.browser-inspect-probe.r{nonce}");
    context.config_mut().app.windows.clear();
    let trace_records = std::sync::Arc::new(std::sync::Mutex::new(Vec::<
        xharness_diagnostics::Record,
    >::new()));
    let collect = trace_records.clone();
    let app = tauri::Builder::default()
        .manage(lifecycle_trace::LifecycleTrace(std::sync::Arc::new(move |record|collect.lock().unwrap().push(record))))
        .manage(browser::BrowserState::default())
        .manage(browser_bridge::BrowserBridge::default())
        .manage(browser_lifecycle::BrowserLifecycle::default())
        .invoke_handler(tauri::generate_handler![
            browser_lifecycle::desktop_browser_control_reply,
            browser_delegation::desktop_browser_delegate,
            browser_delegation::desktop_browser_access,
            browser_inspect::desktop_browser_inspect,
            browser_picker::desktop_browser_pick,
            browser_perform::desktop_browser_perform
        ])
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(shell))
                .title("Native browser observation probe")
                .inner_size(800.0, 600.0);
            #[cfg(target_os = "macos")]
            let window =
                if std::env::var("XHARNESS_NATIVE_PROBE_TITLEBAR").as_deref() == Ok("overlay") {
                    window
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true)
                } else {
                    window
                };
            window.build()?;
            let handle = app.handle().clone();
            let completed = completed.clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    tokio::time::timeout(Duration::from_secs(120), probe(&handle, url)).await;
                let records=trace_records.lock().unwrap();
                let created=records.iter().filter(|r|r.browser_event==Some(xharness_diagnostics::BrowserEvent::Created)).count();
                let closed=records.iter().filter(|r|r.browser_event==Some(xharness_diagnostics::BrowserEvent::CloseAccepted)).count();
                let main_alive=handle.get_window("main").is_some();
                let lifecycle_passed=main_alive && created>0 && closed>0;
                drop(records);
                println!("BROWSER_LIFECYCLE_EVIDENCE {}",json!({"passed":lifecycle_passed,"main_alive":main_alive,"created":created,"close_accepted":closed,"test_only":true}));
                let success = matches!(&result, Ok(Ok(()))) && lifecycle_passed;
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
