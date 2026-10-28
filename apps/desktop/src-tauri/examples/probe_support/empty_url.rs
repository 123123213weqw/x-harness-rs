//! A real, never-navigated WKWebView is the deterministic nil-URL fixture.
//! No Host, model, user profile, navigation, or synthetic Objective-C swizzling.
use serde_json::json;
use tauri::Manager;

pub async fn run(app: &tauri::AppHandle) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = handle
                // The preceding probes can leave multiple child WebViews.
                // The native Window still exists, but is not a WebviewWindow.
                .get_window("main")
                .ok_or("native URL probe window missing")?;
            // Deliberately omit both with_url and with_html. On macOS the
            // resulting WKWebView has no committed document and URL == nil.
            let empty = wry::WebViewBuilder::new()
                .with_visible(false)
                .build_as_child(&window)
                .map_err(|error| error.to_string())?;
            for _ in 0..32 {
                match empty.url() {
                    Err(wry::Error::Io(error))
                        if error.kind() == std::io::ErrorKind::NotFound
                            && error.to_string() == "WKWebView URL is not available" => {}
                    other => {
                        return Err(format!(
                            "never-navigated WKWebView must return the nil-URL error: {other:?}"
                        ));
                    }
                }
            }
            drop(empty);
            if handle.get_window("main").is_none() {
                return Err("nil-URL reads lost the main window".into());
            }
            Ok(json!({
                "passed": true,
                "nil_url_reads": 32,
                "result": "recoverable_not_found",
                "main_alive": true,
                "test_only": true
            }))
        })();
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(10), receive)
        .await
        .map_err(|_| "nil-URL probe timed out")?
        .map_err(|_| "nil-URL probe callback lost")??;
    println!("EMPTY_WEBVIEW_URL_EVIDENCE {receipt}");
    Ok(())
}
