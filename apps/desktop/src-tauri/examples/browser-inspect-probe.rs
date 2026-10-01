//! Opt-in native callback smoke test. Run only on an isolated display/profile.
//! It starts no Host/model and does not use the user's browser/app data.

#[path = "../src/browser.rs"]
#[allow(dead_code)] // The probe intentionally omits persistence/download UI paths.
mod browser;
#[path = "../src/browser_inspect.rs"]
mod browser_inspect;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HTML: &str = r#"<!doctype html><main><h1>Native observation probe</h1><label for="answer">Answer</label><input id="answer" value="unchanged"><input type="password" value="private-native-secret"><button disabled>Unavailable</button><p id="ipc">IPC pending</p></main>"#;

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
    if pending.await.map_err(|e| e.to_string())?.is_ok() {
        return Err(
            "selection changed while inspection was pending but stale evidence escaped".into(),
        );
    }
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
    println!("Native Tauri observation probe passed: real callback, redaction, unchanged input, guest denial, hidden-tab denial, pending-selection race");
    Ok(())
}

fn main() {
    let url = fixture();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.xlang.xharness.browser-inspect-probe".into();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            browser_inspect::desktop_browser_inspect
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
