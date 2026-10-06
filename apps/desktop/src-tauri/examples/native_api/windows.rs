use base64::Engine;
use serde_json::{json, Value};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::{HSTRING, PCWSTR};

fn cdp(
    handle: PlatformWebview,
    method: &str,
    parameters: Value,
    reply: Sender<Result<Value, String>>,
) {
    // SAFETY: Tauri invokes this closure on the owning WebView2 UI thread.
    // COM objects and callback are not sent to another apartment. The callback
    // owns its sender; a timeout cannot resolve a subsequent operation.
    let result = unsafe { handle.controller().CoreWebView2() };
    let Ok(view) = result else {
        let _ = reply.send(Err("WebView2 unavailable".into()));
        return;
    };
    let method = HSTRING::from(method);
    let arguments = HSTRING::from(parameters.to_string());
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
            let value = if status.is_ok() {
                serde_json::from_str(&result).map_err(|_| "invalid CDP evidence".to_string())
            } else {
                Err("native CDP operation failed".into())
            };
            let _ = reply.send(value);
            Ok(())
        }));
    // SAFETY: nul-terminated HSTRINGs remain live for the synchronous COM call;
    // WebView2 retains the handler for asynchronous completion.
    let _ = unsafe {
        view.CallDevToolsProtocolMethod(
            PCWSTR(method.as_ptr()),
            PCWSTR(arguments.as_ptr()),
            &callback,
        )
    };
}
pub fn button(
    handle: PlatformWebview,
    x: f64,
    y: f64,
    pressed: bool,
    reply: Sender<Result<(), String>>,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    cdp(
        handle,
        "Input.dispatchMouseEvent",
        json!({"type":if pressed {"mousePressed"} else {"mouseReleased"},"x":x,"y":y,"button":"left","clickCount":1}),
        tx,
    );
    tauri::async_runtime::spawn(async move {
        let _ = reply.send(
            rx.await
                .map_err(|_| "mouse callback closed".to_string())
                .and_then(|r| r)
                .map(|_| ()),
        );
    });
}
pub fn key_z(handle: PlatformWebview, pressed: bool, reply: Sender<Result<(), String>>) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    cdp(
        handle,
        "Input.dispatchKeyEvent",
        json!({
            "type": if pressed {"keyDown"} else {"keyUp"},
            "key":"z","code":"KeyZ","windowsVirtualKeyCode":90,"nativeVirtualKeyCode":90,
            "text": if pressed {"z"} else {""},"unmodifiedText":if pressed {"z"} else {""}
        }),
        tx,
    );
    tauri::async_runtime::spawn(async move {
        let _ = reply.send(
            rx.await
                .map_err(|_| "native key callback closed".to_string())
                .and_then(|r| r)
                .map(|_| ()),
        );
    });
}
pub fn snapshot(handle: PlatformWebview, reply: Sender<Result<Vec<u8>, String>>) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    cdp(
        handle,
        "Page.captureScreenshot",
        json!({"format":"png","captureBeyondViewport":false}),
        tx,
    );
    tauri::async_runtime::spawn(async move {
        let result = rx
            .await
            .map_err(|_| "native screenshot callback closed".to_string())
            .and_then(|r| r)
            .and_then(|v| {
                base64::engine::general_purpose::STANDARD
                    .decode(v["data"].as_str().ok_or("missing PNG")?)
                    .map_err(|_| "invalid native PNG".to_string())
            });
        let _ = reply.send(result);
    });
}
