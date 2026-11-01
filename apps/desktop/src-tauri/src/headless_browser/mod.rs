//! Chat-owned background browser. Presentation never grants/revokes control.
#![forbid(unsafe_code)]
mod helper;
mod process;
pub use helper::run_if_requested as run_helper;
#[cfg(test)]
mod tests;
use process::Process;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const SCRIPT: &str = include_str!("../browser_observe.js");
const GEOMETRY: &str = "(()=>{const key=Symbol.for('xharness.headless.geometry');if(!window[key]){const state={n:0};window[key]=state;new MutationObserver(()=>state.n++).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});}return JSON.stringify([location.href,scrollX,scrollY,innerWidth,innerHeight,window[key].n]);})()";
const MAX_SESSIONS: usize = 4;
pub fn installed_available() -> bool {
    !process::candidates().is_empty()
}
#[derive(Default)]
pub struct Browsers {
    sessions: Mutex<HashMap<String, Arc<Slot>>>,
}
#[derive(Default)]
struct Slot {
    retired: AtomicBool,
    pending: AtomicBool,
    id: std::sync::Mutex<Option<String>>,
    instance: Mutex<Option<Instance>>,
    preview: Mutex<Option<tokio::task::JoinHandle<Result<Value, String>>>>,
}
struct OpenLease(Arc<Slot>);
impl Drop for OpenLease {
    fn drop(&mut self) {
        self.0.pending.store(false, Ordering::SeqCst);
    }
}
struct Frame {
    id: String,
    stamp: String,
    created: Instant,
}
struct Instance {
    process: Process,
    id: String,
    frame: Option<Frame>,
    release: Option<Value>,
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "browser entropy unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn rejected(message: &str) -> Value {
    json!({"ok":false,"effect":"not_started","message":message})
}
impl Browsers {
    pub async fn shutdown(&self) {
        let owners: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for owner in owners {
            if self.close(&owner).await.is_err() {
                eprintln!("owned browser shutdown cleanup failed");
            }
        }
    }
    async fn slot(&self, owner: &str, create: bool) -> Result<Arc<Slot>, String> {
        if owner.is_empty() || owner.len() > 128 {
            return Err("invalid browser owner".into());
        }
        let mut sessions = self.sessions.lock().await;
        if let Some(slot) = sessions.get(owner) {
            return Ok(slot.clone());
        }
        if !create {
            return Err("no browser bound to this chat; open a page first".into());
        }
        sessions.retain(|_, slot| {
            slot.pending.load(Ordering::SeqCst)
                || slot
                    .instance
                    .try_lock()
                    .map_or(true, |state| state.is_some())
        });
        if sessions.len() >= MAX_SESSIONS {
            return Err(
                "background browser capacity reached; explicitly close an idle chat browser".into(),
            );
        }
        let slot = Arc::new(Slot::default());
        slot.pending.store(true, Ordering::SeqCst);
        sessions.insert(owner.into(), slot.clone());
        Ok(slot)
    }
    pub async fn status(&self, owner: &str) -> Value {
        let bound = match self.slot(owner, false).await {
            Ok(slot) => {
                slot.id.lock().ok().is_some_and(|id| id.is_some())
                    && !slot.retired.load(Ordering::SeqCst)
            }
            Err(_) => false,
        };
        json!({"available":!process::candidates().is_empty(),"bound":bound,"engine":"chromium-headless","version":1,
            "session":"chat-owned-independent-profile","capabilities":{"open":true,"close":true,"observe":true,"dom_actions":true,"browser_input_actions":["click","move","key"],"native_input":true,"cross_origin_pointer":true,"screenshot":true,"hidden_tab_actions":true,"recording":false,"global_os_input":false,"cross_origin_frames":false},
            "constraints":["new isolated Chrome/Edge instance; no existing login/profile inherited","one page per chat, at most four live chats; close releases its browser","sidebar is optional preview; it does not authorize or own the browser","DOM refs are one-shot; screenshot/input use CSS viewport coordinates"]})
    }
    pub async fn close(&self, owner: &str) -> Result<Value, String> {
        self.close_tab(owner, None).await
    }
    pub async fn close_tab(&self, owner: &str, expected: Option<&str>) -> Result<Value, String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(expected) = expected {
            let slot = sessions.get(owner).ok_or("browser already closed")?;
            if slot
                .id
                .lock()
                .map_err(|_| "browser identity unavailable")?
                .as_deref()
                != Some(expected)
            {
                return Err("stale browser closure refused".into());
            }
        }
        let slot = sessions.remove(owner);
        drop(sessions);
        let Some(slot) = slot else {
            return Ok(json!({"ok":true,"effect":"applied","closed":true}));
        };
        slot.retired.store(true, Ordering::SeqCst);
        let id = slot
            .id
            .lock()
            .map_err(|_| "browser identity unavailable")?
            .clone();
        let mut instance = slot.instance.lock().await;
        if let Some(instance) = instance.take() {
            instance.process.close().await?;
        }
        Ok(json!({"ok":true,"effect":"applied","closed":true,"tab_id":id}))
    }
    pub async fn dispatch(
        &self,
        owner: &str,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if operation == "list" {
            if arguments != json!({}) {
                return Err("list takes no arguments".into());
            }
            return Ok(self.status(owner).await);
        }
        if operation == "control" {
            let request: crate::browser_lifecycle::ControlRequest =
                serde_json::from_value(arguments)
                    .map_err(|_| "invalid browser control arguments")?;
            return match request {
                crate::browser_lifecycle::ControlRequest::Status {} => Ok(self.status(owner).await),
                crate::browser_lifecycle::ControlRequest::Close {} => self.close(owner).await,
                crate::browser_lifecycle::ControlRequest::Open { url } => {
                    self.open(owner, url).await
                }
            };
        }
        let slot = self.slot(owner, false).await?;
        let mut guard = slot.instance.lock().await;
        if slot.retired.load(Ordering::SeqCst) {
            return Err("browser session was closed".into());
        }
        let instance = guard.as_mut().ok_or("browser is not ready")?;
        instance.release_pending().await?;
        match operation {
            "observe" => instance.observe(arguments).await,
            "screenshot" => {
                if arguments != json!({}) {
                    return Err("screenshot takes no arguments".into());
                }
                instance.screenshot().await
            }
            "perform" => instance.perform(arguments).await,
            "input" => instance.input(arguments).await,
            _ => Err("unknown background browser operation".into()),
        }
    }
    async fn open(&self, owner: &str, url: String) -> Result<Value, String> {
        let url = crate::browser::web_url(&url)?.to_string();
        let slot = self.slot(owner, true).await?;
        let _lease = OpenLease(slot.clone());
        let mut guard = slot.instance.lock().await;
        if slot.retired.load(Ordering::SeqCst) {
            return Err("browser open cancelled by closure".into());
        }
        if guard.is_none() {
            let mut selected = None;
            for binary in process::candidates().into_iter().take(4) {
                if let Ok(process) = Process::launch(&binary).await {
                    selected = Some(process);
                    break;
                }
            }
            let process=selected.ok_or("no compatible local Chrome/Edge started; install Chrome or Edge; no browser downloaded or backend switched")?;
            if slot.retired.load(Ordering::SeqCst) {
                return Err("browser open cancelled by closure".into());
            }
            let instance = Instance {
                process,
                id: format!("headless:{}", nonce()?),
                frame: None,
                release: None,
            };
            *slot.id.lock().map_err(|_| "browser identity unavailable")? =
                Some(instance.id.clone());
            *guard = Some(instance);
        }
        let instance = guard.as_mut().ok_or("browser unavailable")?;
        instance.release_pending().await?;
        instance.frame = None;
        let receipt = instance
            .process
            .cdp
            .call("Page.navigate", json!({"url":url}))
            .await?;
        if receipt.get("errorText").is_some() {
            return Err("browser navigation failed; inspect before retrying".into());
        }
        let loader = receipt["loaderId"].as_str().map(str::to_owned);
        let ready = async {
            loop {
                // Page.navigate can acknowledge before the new document commits.
                // A previously ready document must not satisfy this navigation.
                let tree = instance
                    .process
                    .cdp
                    .call("Page.getFrameTree", json!({}))
                    .await?;
                let frame = &tree["frameTree"]["frame"];
                if loader
                    .as_deref()
                    .is_some_and(|id| frame["loaderId"].as_str() != Some(id))
                {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
                let result = instance
                    .process
                    .cdp
                    .evaluate(
                        "JSON.stringify({url:location.href,ready:document.readyState!=='loading'})"
                            .into(),
                    )
                    .await?;
                let state: Value =
                    serde_json::from_str(result.as_str().ok_or("invalid page state")?)
                        .map_err(|_| "invalid page state")?;
                if state["ready"] == true
                    && state["url"] == frame["url"]
                    && (loader.is_some() || state["url"] == url)
                    && state["url"] != "about:blank"
                {
                    return Ok::<Value, String>(state);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let state = tokio::time::timeout(Duration::from_secs(15), ready)
            .await
            .map_err(|_| "navigation readiness timed out; effect unknown")??;
        let actual = state["url"].as_str().ok_or("missing browser URL")?;
        crate::browser::web_url(actual)?;
        Ok(
            json!({"ok":true,"effect":"applied","state":"ready","tab_id":instance.id,"url":actual,"engine":"chromium-headless","preview_optional":true}),
        )
    }
    /// Only an explicit visible-preview request captures JPEG; no hidden timer
    /// exists in Rust. Skip a busy control operation rather than queue behind it.
    pub async fn preview(&self, owner: &str, expected: &str) -> Result<Value, String> {
        let slot = self.slot(owner, false).await?;
        if slot.retired.load(Ordering::SeqCst)
            || slot
                .id
                .lock()
                .map_err(|_| "browser identity unavailable")?
                .as_deref()
                != Some(expected)
        {
            return Err("preview target closed".into());
        }
        let Ok(mut pending) = slot.preview.try_lock() else {
            return Ok(json!({"busy":true}));
        };
        if pending.is_none() {
            let Ok(guard) = slot.instance.try_lock() else {
                return Ok(json!({"busy":true}));
            };
            let instance = guard.as_ref().ok_or("preview target closed")?;
            if instance.release.is_some() {
                return Ok(json!({"busy":true}));
            }
            let cdp = instance.process.preview_cdp.clone();
            let id = instance.id.clone();
            // The spawned read owns its connection until completion. Timing out
            // only the caller's wait must not cancel an in-flight screenshot:
            // Chrome can reset global emulation if that session disconnects.
            *pending = Some(tokio::spawn(async move {
                preview_image(&mut *cdp.lock().await, &id).await
            }));
        }
        let task = pending.as_mut().ok_or("preview read unavailable")?;
        let result = match tokio::time::timeout(Duration::from_millis(350), task).await {
            Err(_) => return Ok(json!({"busy":true})),
            Ok(result) => result.map_err(|_| "preview read unavailable".to_owned()),
        };
        pending.take();
        if slot.retired.load(Ordering::SeqCst) {
            return Err("preview target closed".into());
        }
        result?
    }
}
impl Instance {
    async fn release_pending(&mut self) -> Result<(), String> {
        if let Some(params) = self.release.clone() {
            let method = if params["type"] == "keyUp" {
                "Input.dispatchKeyEvent"
            } else {
                "Input.dispatchMouseEvent"
            };
            self.process.cdp.call(method, params).await?;
            self.release = None;
        }
        Ok(())
    }

    async fn stamp(&mut self) -> Result<String, String> {
        self.process
            .cdp
            .evaluate(GEOMETRY.into())
            .await?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "browser geometry unavailable".into())
    }
    async fn observe(&mut self, arguments: Value) -> Result<Value, String> {
        // Retry only an invalidated read, never an input or DOM effect. Async
        // iframe messages often settle between the geometry samples.
        for attempt in 0..3 {
            match self.observe_once(arguments.clone()).await {
                Err(error) if error == "observation invalidated; observe again" && attempt < 2 => {
                    continue
                }
                result => return result,
            }
        }
        Err("observation invalidated; observe again".into())
    }
    async fn observe_once(&mut self, arguments: Value) -> Result<Value, String> {
        let request: crate::browser_inspect::InspectRequest =
            serde_json::from_value(arguments).map_err(|_| "invalid observation arguments")?;
        request.validate()?;
        self.frame = None;
        let mut args = serde_json::to_value(request).map_err(|_| "invalid observation")?;
        let id = nonce()?;
        args["frame_id"] = json!(id);
        let before = self.stamp().await?;
        let raw = self
            .process
            .cdp
            .evaluate(format!("({SCRIPT})({args})"))
            .await?;
        let result: Value = serde_json::from_str(raw.as_str().ok_or("invalid page observation")?)
            .map_err(|_| "invalid page observation")?;
        if result.get("error").is_some()
            || result["frame_id"] != id
            || result.to_string().len() > 8192
            || self.stamp().await? != before
        {
            return Err("observation invalidated; observe again".into());
        }
        self.frame = Some(Frame {
            id,
            stamp: before,
            created: Instant::now(),
        });
        Ok(result)
    }
    async fn consume(&mut self, id: &str) -> Result<(), String> {
        let frame = self
            .frame
            .take()
            .ok_or("stale observation frame; observe again")?;
        if frame.id != id
            || frame.created.elapsed() > Duration::from_secs(60)
            || self.stamp().await? != frame.stamp
        {
            return Err("stale observation geometry; observe again".into());
        }
        Ok(())
    }
    async fn perform(&mut self, arguments: Value) -> Result<Value, String> {
        let request: crate::browser_perform::PerformRequest =
            serde_json::from_value(arguments.clone()).map_err(|_| "invalid browser DOM action")?;
        request.validate()?;
        if let Err(message) = self.consume(request.frame()).await {
            return Ok(rejected(&message));
        }
        let mut args = arguments;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock unavailable")?
            .as_millis();
        args["deadline_epoch_ms"] = json!(now + 5000);
        let raw = self
            .process
            .cdp
            .evaluate(format!("({SCRIPT})({args})"))
            .await?;
        serde_json::from_str(
            raw.as_str()
                .ok_or("action result unavailable; effect unknown")?,
        )
        .map_err(|_| "action result invalid; effect unknown".into())
    }
    async fn screenshot(&mut self) -> Result<Value, String> {
        self.frame = None;
        let before = self.stamp().await?;
        let cdp = &mut self.process.cdp;
        let metrics = cdp.call("Page.getLayoutMetrics", json!({})).await?;
        let viewport = &metrics["visualViewport"];
        let x = viewport["pageX"].as_f64().ok_or("missing viewport x")?;
        let y = viewport["pageY"].as_f64().ok_or("missing viewport y")?;
        let scale = viewport["scale"]
            .as_f64()
            .filter(|scale| *scale > 0.0 && *scale <= 10.0)
            .ok_or("invalid viewport scale")?;
        let image = cdp.call("Page.captureScreenshot", json!({"format":"png","optimizeForSpeed":true,"captureBeyondViewport":false,"fromSurface":true,"clip":{"x":x,"y":y,"width":1280.0/scale,"height":720.0/scale,"scale":scale}})).await?;
        let data = image["data"]
            .as_str()
            .filter(|data| data.len() <= 11 * 1024 * 1024)
            .ok_or("browser image exceeds budget")?;
        use base64::Engine;
        let header = base64::engine::general_purpose::STANDARD
            .decode(data.get(..32).ok_or("incomplete PNG")?)
            .map_err(|_| "invalid PNG")?;
        if header.len() != 24
            || header[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
            || header[16..20] != 1280u32.to_be_bytes()
            || header[20..24] != 720u32.to_be_bytes()
        {
            return Err("browser screenshot did not preserve full viewport".into());
        }
        let stamp = before;
        if self.stamp().await? != stamp {
            return Err("screenshot geometry changed; capture again".into());
        }
        let id = nonce()?;
        self.frame = Some(Frame {
            id: id.clone(),
            stamp,
            created: Instant::now(),
        });
        Ok(
            json!({"frame_id":id,"viewport":{"width":1280,"height":720},"image":{"width":1280,"height":720},"png_base64":data}),
        )
    }
    async fn input(&mut self, arguments: Value) -> Result<Value, String> {
        use crate::browser_native::InputRequest;
        let request: InputRequest =
            serde_json::from_value(arguments).map_err(|_| "invalid browser input")?;
        request.validate()?;
        if let Err(message) = self.consume(request.frame()).await {
            return Ok(rejected(&message));
        }
        match request {
            InputRequest::Click { x, y, .. } | InputRequest::Move { x, y, .. }
                if x >= 1280.0 || y >= 720.0 =>
            {
                return Ok(rejected("point outside CSS viewport"))
            }
            InputRequest::Move { x, y, .. } => {
                self.process
                    .cdp
                    .call(
                        "Input.dispatchMouseEvent",
                        json!({"type":"mouseMoved","x":x,"y":y}),
                    )
                    .await?;
            }
            InputRequest::Click { x, y, .. } => {
                self.release = Some(
                    json!({"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1}),
                );
                self.process
                    .cdp
                    .call(
                        "Input.dispatchMouseEvent",
                        json!({"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1}),
                    )
                    .await?;
                self.release_pending().await?;
            }
            InputRequest::Key { key, modifiers, .. } => {
                let spec = crate::browser_native::key_spec(&key)?;
                let bits = modifiers.iter().fold(0, |bits, key| {
                    bits | match key.as_str() {
                        "Alt" => 1,
                        "Control" => 2,
                        "Meta" => 4,
                        "Shift" => 8,
                        _ => 0,
                    }
                });
                let text = if modifiers.iter().any(|key| key != "Shift") {
                    String::new()
                } else if modifiers.contains(&"Shift".into()) {
                    spec.text.to_uppercase()
                } else {
                    spec.text
                };
                let key_value = if key.len() == 1 {
                    if modifiers.contains(&"Shift".into()) {
                        key.to_uppercase()
                    } else {
                        key.clone()
                    }
                } else {
                    key.clone()
                };
                self.release = Some(
                    json!({"type":"keyUp","key":key_value,"windowsVirtualKeyCode":spec.windows,"modifiers":bits}),
                );
                self.process.cdp.call("Input.dispatchKeyEvent",json!({"type":"keyDown","key":key_value,"windowsVirtualKeyCode":spec.windows,"modifiers":bits,"text":text})).await?;
                self.release_pending().await?;
            }
        }
        Ok(json!({"ok":true,"effect":"applied"}))
    }
}

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

async fn preview_image(cdp: &mut process::Cdp, id: &str) -> Result<Value, String> {
    let metrics = cdp.call("Page.getLayoutMetrics", json!({})).await?;
    let viewport = &metrics["visualViewport"];
    let x = viewport["pageX"].as_f64().ok_or("missing viewport x")?;
    let y = viewport["pageY"].as_f64().ok_or("missing viewport y")?;
    let scale = viewport["scale"]
        .as_f64()
        .filter(|scale| *scale > 0.0 && *scale <= 10.0)
        .ok_or("invalid viewport scale")?;
    let image = cdp.call("Page.captureScreenshot", json!({"format":"jpeg","quality":65,"optimizeForSpeed":true,"captureBeyondViewport":false,"fromSurface":true,"clip":{"x":x,"y":y,"width":1280.0/scale,"height":720.0/scale,"scale":scale*0.5}})).await?;
    let data = image["data"]
        .as_str()
        .filter(|data| data.len() <= 2 * 1024 * 1024)
        .ok_or("browser preview exceeds budget")?;
    let info = cdp
        .evaluate("JSON.stringify({url:location.href,title:document.title.slice(0,160)})".into())
        .await?;
    let info: Value = serde_json::from_str(info.as_str().ok_or("preview page unavailable")?)
        .map_err(|_| "preview page unavailable")?;
    Ok(
        json!({"image":data,"mime":"image/jpeg","width":640,"height":360,"viewport":{"width":1280,"height":720},"tabId":id,"url":info["url"],"title":info["title"]}),
    )
}
