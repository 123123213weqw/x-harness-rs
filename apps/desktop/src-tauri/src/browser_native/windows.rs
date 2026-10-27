use ::windows::core::{HSTRING, PCWSTR};
use base64::Engine;
use serde_json::{json, Value};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;

fn cdp(
    handle: &PlatformWebview,
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
async fn completed(
    receiver: tokio::sync::oneshot::Receiver<Result<Value, String>>,
) -> Result<Value, String> {
    tokio::time::timeout(std::time::Duration::from_secs(8), receiver)
        .await
        .map_err(|_| "native protocol callback timed out")?
        .map_err(|_| "native protocol callback closed")?
}
pub fn input(
    handle: PlatformWebview,
    request: super::InputRequest,
    _viewport: (f64, f64),
    reply: Sender<Result<(), String>>,
) {
    use super::InputRequest;
    // CDP input coordinates are CSS pixels already; do not apply native zoom or DPR.
    let methods = match request {
        InputRequest::Click { x, y, .. } => vec![
            (
                "Input.dispatchMouseEvent",
                json!({"type":"mousePressed","x":x,"y":y,"button":"left","buttons":1,"clickCount":1}),
            ),
            (
                "Input.dispatchMouseEvent",
                json!({"type":"mouseReleased","x":x,"y":y,"button":"left","buttons":0,"clickCount":1}),
            ),
        ],
        InputRequest::Move { x, y, .. } => vec![(
            "Input.dispatchMouseEvent",
            json!({"type":"mouseMoved","x":x,"y":y,"button":"none","buttons":0}),
        )],
        InputRequest::Key { key, modifiers, .. } => {
            let spec = match super::key_spec(&key) {
                Ok(spec) => spec,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            let mask = modifiers.iter().fold(0, |mask, m| {
                mask | match m.as_str() {
                    "Alt" => 1,
                    "Control" => 2,
                    "Meta" => 4,
                    "Shift" => 8,
                    _ => 0,
                }
            });
            let text = if mask & 7 == 0 && key.len() == 1 {
                if mask & 8 != 0 {
                    key.to_uppercase()
                } else {
                    key.clone()
                }
            } else if key == "Enter" && mask & 7 == 0 {
                "\r".into()
            } else if key == "Space" && mask & 7 == 0 {
                " ".into()
            } else {
                String::new()
            };
            let code = if key.len() == 1 {
                format!("Key{}", key.to_uppercase())
            } else {
                key.clone()
            };
            let display_key = if key == "Space" {
                " ".into()
            } else if key.len() == 1 && mask & 8 != 0 {
                key.to_uppercase()
            } else {
                key.clone()
            };
            vec![
                (
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyDown","key":display_key,"code":code,"modifiers":mask,"windowsVirtualKeyCode":spec.windows,"nativeVirtualKeyCode":spec.windows,"text":text,"unmodifiedText":text}),
                ),
                (
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyUp","key":display_key,"code":code,"modifiers":mask,"windowsVirtualKeyCode":spec.windows,"nativeVirtualKeyCode":spec.windows}),
                ),
            ]
        }
    };
    // Queue the entire balanced gesture in this UI turn. WebView2 preserves
    // protocol call ordering; no COM apartment object crosses an await.
    let mut receivers = Vec::new();
    for (method, args) in methods {
        let (tx, rx) = tokio::sync::oneshot::channel();
        cdp(&handle, method, args, tx);
        receivers.push(rx);
    }
    tauri::async_runtime::spawn(async move {
        let mut result = Ok(());
        for receiver in receivers {
            if let Err(error) = completed(receiver).await.map(|_| ()) {
                result = Err(error);
            }
        }
        let _ = reply.send(result);
    });
}
pub fn snapshot(handle: PlatformWebview, reply: Sender<Result<Vec<u8>, String>>) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    cdp(
        &handle,
        "Page.captureScreenshot",
        json!({"format":"png","captureBeyondViewport":false}),
        tx,
    );
    tauri::async_runtime::spawn(async move {
        let response = completed(rx).await;
        if reply.is_closed() {
            return;
        }
        let result = response.and_then(|v| {
            base64::engine::general_purpose::STANDARD
                .decode(v["data"].as_str().ok_or("missing PNG")?)
                .map_err(|_| "invalid native PNG".to_string())
        });
        let _ = reply.send(result);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn protocol_receipt_flattens_timeout_channel_and_native_result_layers() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(Ok(json!({}))).unwrap();
        assert_eq!(completed(rx).await.unwrap(), json!({}));
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(Err("native failure".into())).unwrap();
        assert_eq!(completed(rx).await.unwrap_err(), "native failure");
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(tx);
        assert!(completed(rx).await.unwrap_err().contains("closed"));
    }
}
