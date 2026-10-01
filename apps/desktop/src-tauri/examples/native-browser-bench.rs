//! Disposable main-renderer + genuine child WebView harness. No model driver,
//! fixture manipulation, production state, or OS input lives in this example.
#[path = "../src/browser.rs"]
#[allow(dead_code)]
mod browser;
#[path = "../src/browser_bridge.rs"]
mod browser_bridge;
#[path = "../src/browser_delegation.rs"]
mod browser_delegation;
#[path = "../src/browser_inspect.rs"]
mod browser_inspect;
#[path = "../src/browser_perform.rs"]
mod browser_perform;

use std::io::Write;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        3,
        "expected loopback main URL and private ready path"
    );
    let url = url::Url::parse(&args[1]).expect("benchmark main URL");
    assert!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    );
    let ready = std::path::PathBuf::from(&args[2]);
    let mut context = tauri::generate_context!();
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).expect("benchmark entropy");
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    context.config_mut().identifier = format!("com.xlang.xharness.native-bench.r{nonce}");
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .manage(browser_bridge::BrowserBridge::default())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                browser::close_all(webview.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            browser::desktop_browser_restore,
            browser::desktop_browser_persist,
            browser::desktop_browser_navigate,
            browser::desktop_browser_activate,
            browser::desktop_browser_bounds,
            browser::desktop_browser_action,
            browser::desktop_browser_close,
            browser_delegation::desktop_browser_delegate,
            browser_delegation::desktop_browser_access,
            browser_inspect::desktop_browser_inspect,
            browser_perform::desktop_browser_perform
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("XHarness isolated native browser benchmark")
                .inner_size(1100.0, 820.0)
                .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result: Result<(), String> = async {
                    let state = app.state::<browser_bridge::BrowserBridge>();
                    let connection = state.start(&app).await?;
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut file = options
                        .open(ready)
                        .map_err(|_| "private ready file unavailable")?;
                    let bytes = serde_json::to_vec(&serde_json::json!({
                        "address": connection.address, "token": connection.token
                    }))
                    .map_err(|_| "ready serialization failed")?;
                    file.write_all(&bytes)
                        .and_then(|_| file.sync_all())
                        .map_err(|_| "ready checkpoint failed")?;
                    Ok(())
                }
                .await;
                if result.is_err() {
                    eprintln!("native benchmark bridge setup failed");
                    app.exit(1);
                }
            });
            Ok(())
        })
        .run(context)
        .expect("disposable native benchmark runtime");
}
