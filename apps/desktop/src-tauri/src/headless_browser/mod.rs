//! Tauri presentation adapters; browser processes and commands live in the shared runtime.
use serde_json::{json, Value};
pub use xharness_browser::{installed_available, run_helper, Browsers};

#[tauri::command]
pub async fn desktop_headless_preview(
    caller: tauri::Webview,
    state: tauri::State<'_, Browsers>,
    owner: String,
    tab_id: String,
) -> Result<Value, String> {
    crate::browser::ensure_main(&caller)?;
    state.preview(&owner, &tab_id).await
}
#[tauri::command]
pub async fn desktop_headless_control(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, Browsers>,
    owner: String,
    arguments: Value,
    tab_id: Option<String>,
) -> Result<Value, String> {
    use tauri::Emitter;
    crate::browser::ensure_main(&caller)?;
    let closing = arguments["action"] == "close";
    let result = if closing {
        state
            .close_tab(
                &owner,
                Some(
                    tab_id
                        .as_deref()
                        .ok_or("explicit UI close requires its exact tab")?,
                ),
            )
            .await?
    } else {
        state.dispatch(&owner, "control", arguments).await?
    };
    if result["ok"] == true {
        let _ = app.emit_to(
            "main",
            "xharness-headless-page",
            json!({"owner":owner,"closed":closing,"tabId":result["tab_id"],"url":result["url"]}),
        );
    }
    Ok(result)
}
