use ::windows::core::{Interface, HSTRING, PCWSTR};
use base64::Engine;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;

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
pub fn snapshot(
    handle: PlatformWebview,
    plan: super::capture::CapturePlan,
    reply: Sender<Result<Vec<u8>, String>>,
) {
    type Reply = Rc<RefCell<Option<Sender<Result<Vec<u8>, String>>>>>;
    fn finish(reply: &Reply, result: Result<Vec<u8>, String>) {
        if let Some(tx) = reply.borrow_mut().take() {
            let _ = tx.send(result);
        }
    }
    let reply = Rc::new(RefCell::new(Some(reply)));
    // SAFETY: the controller and all callbacks stay on the owning UI apartment.
    // Only the final byte vector crosses the oneshot; no COM object is sent to
    // an async worker. Read native scale without changing zoom/DPI/emulation.
    let setup = (|| unsafe {
        let controller = handle.controller();
        let mut zoom = 0.0;
        controller
            .ZoomFactor(&mut zoom)
            .map_err(|_| "native browser zoom unavailable")?;
        let controller3 = controller
            .cast::<ICoreWebView2Controller3>()
            .map_err(|_| "native browser raster scale unavailable")?;
        let mut raster = 0.0;
        controller3
            .RasterizationScale(&mut raster)
            .map_err(|_| "native browser raster scale unavailable")?;
        let view = controller
            .CoreWebView2()
            .map_err(|_| "native browser unavailable")?;
        // Page.Viewport uses DIP, whereas our frame/input coordinates use CSS.
        // Keep the trusted page zoom separate from native raster density.
        Ok::<_, &str>((view, zoom, raster))
    })();
    let (view, zoom, raster) = match setup {
        Ok(v) => v,
        Err(e) => {
            finish(&reply, Err(e.into()));
            return;
        }
    };
    let captured_view = view.clone();
    let pending = reply.clone();
    let metrics_callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, text| {
            if pending.borrow().as_ref().is_none_or(|tx| tx.is_closed()) {
                return Ok(());
            }
            let args = (|| {
                if status.is_err() {
                    return Err("native capture metrics unavailable".to_string());
                }
                let metrics: Value =
                    serde_json::from_str(&text).map_err(|_| "invalid native capture metrics")?;
                super::capture::chromium_parameters(plan, &metrics, zoom, raster)
            })();
            let args = match args {
                Ok(v) => v,
                Err(e) => {
                    finish(&pending, Err(e));
                    return Ok(());
                }
            };
            let output = pending.clone();
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, text| {
                    if output.borrow().as_ref().is_none_or(|tx| tx.is_closed()) {
                        return Ok(());
                    }
                    let result = (|| {
                        if status.is_err() {
                            return Err("native screenshot unavailable".to_string());
                        }
                        let value: Value = serde_json::from_str(&text)
                            .map_err(|_| "invalid native screenshot result")?;
                        let data = value["data"]
                            .as_str()
                            .filter(|v| v.len() <= 12 * 1024 * 1024)
                            .ok_or("native screenshot exceeds byte budget")?;
                        let png = base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .map_err(|_| "invalid native PNG")?;
                        super::capture::validate_chromium_dimensions(plan, &png)?;
                        Ok(png)
                    })();
                    finish(&output, result);
                    Ok(())
                },
            ));
            let method = HSTRING::from("Page.captureScreenshot");
            let args = HSTRING::from(args.to_string());
            // SAFETY: synchronous COM dispatch on this same UI callback apartment;
            // WebView2 owns the completion handler until its terminal callback.
            if unsafe {
                captured_view.CallDevToolsProtocolMethod(
                    PCWSTR(method.as_ptr()),
                    PCWSTR(args.as_ptr()),
                    &callback,
                )
            }
            .is_err()
            {
                finish(&pending, Err("native screenshot dispatch failed".into()));
            }
            Ok(())
        }));
    let method = HSTRING::from("Page.getLayoutMetrics");
    let args = HSTRING::from("{}");
    // SAFETY: UI-thread COM object and live nul-terminated strings.
    if unsafe {
        view.CallDevToolsProtocolMethod(
            PCWSTR(method.as_ptr()),
            PCWSTR(args.as_ptr()),
            &metrics_callback,
        )
    }
    .is_err()
    {
        finish(&reply, Err("native capture metrics dispatch failed".into()));
    }
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
