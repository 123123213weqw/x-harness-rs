#![allow(clippy::too_many_arguments)]

use std::{
    collections::BTreeMap,
    ffi::{c_double, c_int, c_uint, c_void},
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{process::Command, sync::Mutex};
use tokio_util::sync::CancellationToken;
use xharness_computer::{
    ComputerAction, ComputerDriver, ComputerError, ComputerOutput, ComputerRequest, MouseButton,
    Point, Screenshot,
};

use crate::geometry::{
    check_display_configuration, contains_point, CapturePlan, DisplayInfo, PixelSize,
};
use crate::input_guard::{
    check_frame_id, check_input_context, foreground_pid, frame_bound, same_bounds, window_id,
    InputContext, NativeWindow,
};
use crate::observation::{recover_snapshot, AccessibilitySnapshot, ObservationPlan, WindowBounds};
use crate::process_identity::process_start;

static NEXT_SCREENSHOT: AtomicU64 = AtomicU64::new(1);
static NEXT_FRAME: AtomicU64 = AtomicU64::new(1);

const ACCESSIBILITY_SNAPSHOT_SCRIPT: &str = include_str!("accessibility-snapshot.js");

const ACCESSIBILITY_COMMON_SCRIPT: &str = include_str!("accessibility-common.js");
const NODE_ACTION_SCRIPT: &str = include_str!("accessibility-node-action.js");

const FOREGROUND_SCRIPT: &str = include_str!("foreground-process.js");

const WINDOW_ACTION_SCRIPT: &str = r#"
function fail(message) { throw new Error(message); }
function setAttribute(window, name, value) {
  const attribute = window.attributes.byName(name);
  if (!attribute.exists()) fail(`window does not support ${name}`);
  attribute.value = value;
}
function run(argv) {
  const request = JSON.parse(argv[0]);
  const se = Application('System Events');
  const matches = se.applicationProcesses.whose({unixId: request.pid})();
  if (matches.length !== 1) fail('target process is no longer available');
  const process = matches[0];
  const windows = process.windows();
  const window = windows[request.index - 1];
  if (!window || !window.exists()) fail('target window is no longer available');
  switch (request.operation) {
    case 'focus': process.frontmost = true; setAttribute(window, 'AXFocused', true); break;
    case 'move': window.position = [request.x, request.y]; break;
    case 'resize': window.size = [request.width, request.height]; break;
    case 'minimize': setAttribute(window, 'AXMinimized', true); break;
    case 'maximize': {
      const action = window.actions.byName('AXZoomWindow');
      if (!action.exists()) fail('window does not support maximize');
      action.perform();
      break;
    }
    case 'fullscreen': setAttribute(window, 'AXFullScreen', true); break;
    case 'close': {
      const action = window.actions.byName('AXClose');
      if (!action.exists()) fail('window does not support close');
      action.perform();
      break;
    }
    default: fail('unsupported window operation');
  }
  return JSON.stringify({ok: true, surface_id: request.surface_id, operation: request.operation});
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Debug, Serialize)]
struct CGPoint {
    x: c_double,
    y: c_double,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Serialize)]
struct CGSize {
    width: c_double,
    height: c_double,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Serialize)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

type CGDirectDisplayId = c_uint;
type CGEventRef = *mut c_void;
type CGEventSourceRef = *mut c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGGetActiveDisplayList(
        max_displays: c_uint,
        active_displays: *mut CGDirectDisplayId,
        display_count: *mut c_uint,
    ) -> c_int;
    fn CGDisplayBounds(display: CGDirectDisplayId) -> CGRect;
    fn CGDisplayIsMain(display: CGDirectDisplayId) -> c_uint;
    fn CGDisplayCopyDisplayMode(display: CGDirectDisplayId) -> *mut c_void;
    fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: *mut c_void) -> usize;
    fn CGDisplayModeRelease(mode: *mut c_void);
    fn CGEventSourceCreate(state_id: c_int) -> CGEventSourceRef;
    fn CGEventCreateMouseEvent(
        source: CGEventSourceRef,
        event_type: c_uint,
        mouse_cursor_position: CGPoint,
        mouse_button: c_uint,
    ) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        virtual_key: u16,
        key_down: bool,
    ) -> CGEventRef;
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: c_uint, event: CGEventRef);
    fn CGEventCreateScrollWheelEvent(
        source: CGEventSourceRef,
        units: c_uint,
        wheel_count: c_uint,
        ...
    ) -> CGEventRef;
    fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> *const c_void;
    static kCGWindowOwnerPID: *const c_void;
    static kCGWindowNumber: *const c_void;
    static kCGWindowBounds: *const c_void;
    static kCGWindowLayer: *const c_void;
    static kCGWindowIsOnscreen: *const c_void;
    fn CFBooleanGetValue(value: *const c_void) -> bool;
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: *const c_void, kind: isize, value: *mut c_void) -> bool;
    fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
    fn CFRelease(object: *const c_void);
}

#[derive(Clone, Debug)]
struct NodeTarget {
    bounds: Option<WindowBounds>,
    window_id: Option<u32>,
    window_bounds: Option<WindowBounds>,
    identity: Value,
    pid: i64,
    root_kind: String,
    root_index: u32,
    path: Vec<usize>,
    actions: Vec<String>,
}

impl WindowBounds {
    fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
}

#[derive(Default)]
struct ObservationState {
    frame_id: Option<String>,
    input_context: Option<InputContext>,
    displays: Vec<DisplayInfo>,
    nodes: BTreeMap<String, NodeTarget>,
}

struct EventSource(CGEventSourceRef);

impl EventSource {
    fn new() -> Result<Self, ComputerError> {
        // SAFETY: CGEventSourceCreate returns an owned Core Foundation object
        // or null. The state id is the documented HID system state.
        let source = unsafe { CGEventSourceCreate(1) };
        if source.is_null() {
            Err(ComputerError::retryable(
                "event_source_failed",
                "macOS could not create an input event source",
            ))
        } else {
            Ok(Self(source))
        }
    }
}

impl Drop for EventSource {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a non-null +1 object returned by
        // CGEventSourceCreate and is released exactly once here.
        unsafe { CFRelease(self.0.cast_const()) };
    }
}

struct Event(CGEventRef);

impl Event {
    fn mouse(
        source: &EventSource,
        event_type: u32,
        point: Point,
        button: u32,
    ) -> Result<Self, ComputerError> {
        // SAFETY: arguments are plain value types and `source` remains alive
        // for the lifetime of the returned event.
        let event = unsafe {
            CGEventCreateMouseEvent(
                source.0,
                event_type,
                CGPoint {
                    x: point.x,
                    y: point.y,
                },
                button,
            )
        };
        Self::owned(event)
    }

    fn key(source: &EventSource, key: u16, down: bool) -> Result<Self, ComputerError> {
        // SAFETY: source is valid and virtual key is passed by value.
        Self::owned(unsafe { CGEventCreateKeyboardEvent(source.0, key, down) })
    }

    fn scroll(source: &EventSource, vertical: i32, horizontal: i32) -> Result<Self, ComputerError> {
        // SAFETY: macOS documents two signed 32-bit variadic arguments when
        // wheel_count is two. Pixel units are used to preserve model deltas.
        Self::owned(unsafe { CGEventCreateScrollWheelEvent(source.0, 0, 2, vertical, horizontal) })
    }

    fn owned(event: CGEventRef) -> Result<Self, ComputerError> {
        if event.is_null() {
            Err(ComputerError::retryable(
                "event_create_failed",
                "macOS could not create an input event",
            ))
        } else {
            Ok(Self(event))
        }
    }

    fn flags(&self, flags: u64) {
        // SAFETY: self contains a live CGEvent.
        unsafe { CGEventSetFlags(self.0, flags) };
    }

    fn unicode(&self, units: &[u16]) {
        // SAFETY: the slice remains alive for the duration of the call.
        unsafe { CGEventKeyboardSetUnicodeString(self.0, units.len(), units.as_ptr()) };
    }

    fn post(&self) {
        // SAFETY: self contains a live CGEvent and HID tap is a documented
        // event posting location.
        unsafe { CGEventPost(0, self.0) };
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a non-null +1 object released exactly once.
        unsafe { CFRelease(self.0.cast_const()) };
    }
}

pub struct MacComputer {
    state: Mutex<ObservationState>,
}

impl Default for MacComputer {
    fn default() -> Self {
        Self::new()
    }
}

impl MacComputer {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ObservationState::default()),
        }
    }

    async fn observe(
        &self,
        request: &ComputerRequest,
        cancellation: &CancellationToken,
    ) -> Result<ComputerOutput, ComputerError> {
        // A failed/cancelled replacement observation must not leave its old
        // frame/targets usable. Only publish a new state after all checks pass.
        *self.state.lock().await = ObservationState::default();
        let displays = display_info()?;
        let native_windows = native_window_inventory()?;
        let input_context = read_input_context(&native_windows, cancellation).await?;
        let capture_plan = if request.include_screenshot.unwrap_or(false) {
            Some(CapturePlan::new(&displays, request.region)?)
        } else {
            None
        };
        let permissions = permission_status();
        let plan = ObservationPlan::for_request(request);
        let snapshot_result = if plan.needs_snapshot && permissions.accessibility {
            accessibility_snapshot(plan, input_context.pid, cancellation).await
        } else if plan.needs_snapshot {
            Err(ComputerError::unavailable(
                "permission_required: enable Accessibility for XHarness in System Settings > Privacy & Security",
            ))
        } else {
            Ok(AccessibilitySnapshot::empty(plan.max_nodes, plan.max_depth))
        };
        // Read failures are observation metadata, not a reason to discard an
        // independently requested screenshot. Cancellation must still abort.
        let (snapshot, accessibility_error) = recover_snapshot(snapshot_result, plan)?;
        if cancellation.is_cancelled() {
            return Err(ComputerError::retryable(
                "cancelled",
                "computer observation cancelled",
            ));
        }
        // Opaque, non-repeating across executor instances and Host restarts.
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| {
                ComputerError::retryable(
                    "clock_unavailable",
                    "cannot create an observation identity",
                )
            })?;
        let frame_id = format!(
            "mac-frame-{}-{}-{}",
            std::process::id(),
            epoch.as_nanos(),
            NEXT_FRAME.fetch_add(1, Ordering::Relaxed)
        );
        let mut nodes = BTreeMap::new();
        for window in &snapshot.windows {
            nodes.insert(
                window.node_id.clone(),
                NodeTarget {
                    bounds: Some(window.bounds),
                    window_id: window_id(&native_windows,window.pid,window.bounds),
                    window_bounds: Some(window.bounds),
                    identity: json!({"role":"AXWindow","subrole":null,"label":window.title,"identifier":null}),
                    pid: window.pid,
                    root_kind: "window".into(),
                    root_index: window.window_index,
                    path: Vec::new(),
                    actions: Vec::new(),
                },
            );
        }
        for node in &snapshot.nodes {
            let window = snapshot.windows.iter().find(|window| {
                window.pid == node.pid
                    && window.window_index == node.root_index
                    && node.root_kind == "window"
            });
            nodes.insert(
                node.node_id.clone(),
                NodeTarget {
                    bounds: node.bounds,
                    window_id: window.and_then(|w| window_id(&native_windows,w.pid,w.bounds)),
                    window_bounds: window.map(|w| w.bounds),
                    identity: json!({"role":node.role,"subrole":node.subrole,"label":node.label,"identifier":node.identifier}),
                    pid: node.pid,
                    root_kind: node.root_kind.clone(),
                    root_index: node.root_index,
                    path: node.path.clone(),
                    actions: node.actions.clone(),
                },
            );
        }
        let screenshot = if let Some(capture_plan) = &capture_plan {
            if !permissions.screen_recording {
                return Err(ComputerError::unavailable(
                    "permission_required: enable Screen Recording for XHarness in System Settings > Privacy & Security",
                ));
            }
            Some(capture_png(capture_plan, cancellation).await?)
        } else {
            None
        };
        if cancellation.is_cancelled() {
            return Err(ComputerError::retryable(
                "cancelled",
                "computer observation cancelled",
            ));
        }
        let screenshot_geometry = match (&capture_plan, &screenshot) {
            (Some(plan), Some(screenshot)) => Some(plan.metadata(&screenshot.png)?),
            _ => None,
        };
        check_display_configuration(&displays, &display_info()?)?;
        let current_windows = native_window_inventory()?;
        if read_input_context(&current_windows, cancellation).await? != input_context {
            return Err(ComputerError::retryable(
                "stale_frame",
                "foreground application or window changed during observation; observe again",
            ));
        }
        // Optional background window inventory is not an atomic snapshot. Only
        // roots whose controls were actually traversed may invalidate this frame.
        for (_, target) in nodes
            .iter()
            .filter(|(id, target)| id.starts_with("ax:") && target.root_kind == "window")
        {
            if let (Some(id), Some(rect)) = (target.window_id, target.window_bounds) {
                if window_id(&current_windows, target.pid, rect) != Some(id) {
                    return Err(ComputerError::retryable(
                        "stale_node",
                        "window changed during observation; observe again",
                    ));
                }
            }
        }
        // Publish only a completed observation. Even a degraded observation
        // replaces old AX targets: never retain nodes from an earlier frame.
        *self.state.lock().await = ObservationState {
            frame_id: Some(frame_id.clone()),
            input_context: Some(input_context),
            displays: displays.clone(),
            nodes,
        };
        let accessibility_status = if accessibility_error.is_some() {
            "unavailable"
        } else if !plan.needs_snapshot {
            "not_requested"
        } else if snapshot.truncated {
            "partial"
        } else if !plan.include_nodes {
            "windows_only"
        } else {
            "complete"
        };
        let value = json!({
            "ok": true,
            "action": "observe",
            "frame_id": frame_id,
            "coordinate_space": "macos_logical_points",
            "displays": displays,
            "surfaces": snapshot.windows,
            "accessibility": {
                "nodes": snapshot.nodes,
                "truncated": snapshot.truncated,
                "visited": snapshot.visited,
                "max_nodes": snapshot.max_nodes,
                "max_depth": snapshot.max_depth,
                "status": accessibility_status,
                "truncation_reasons": snapshot.truncation_reasons,
                "elapsed_ms": snapshot.elapsed_ms,
                "scope": snapshot.scope,
                "inventory_complete": snapshot.inventory_complete,
                "search": snapshot.search,
                "error": accessibility_error.map(|error| json!({
                    "code": error.code, "message": error.message, "retryable": error.retryable
                }))
            },
            "permissions": permissions,
            "screenshot_included": screenshot.is_some(),
            "screenshot": screenshot_geometry
        });
        Ok(ComputerOutput { value, screenshot })
    }

    async fn checked_target(
        &self,
        request: &ComputerRequest,
    ) -> Result<Option<NodeTarget>, ComputerError> {
        self.check_frame(request.frame_id.as_deref()).await?;
        if let Some(node_id) = &request.node_id {
            let state = self.state.lock().await;
            return state.nodes.get(node_id).cloned().map(Some).ok_or_else(|| {
                ComputerError::retryable(
                    "stale_node",
                    "the referenced accessibility node is no longer available; observe again",
                )
            });
        }
        Ok(None)
    }

    async fn checked_point(
        &self,
        request: &ComputerRequest,
        cancellation: &CancellationToken,
    ) -> Result<Point, ComputerError> {
        let point = if let Some(target) = self.checked_target(request).await? {
            node_action(
                request.node_id.as_deref().unwrap_or_default(),
                &target,
                "validate",
                cancellation,
            )
            .await?;
            target.bounds.map(WindowBounds::center).ok_or_else(|| {
                ComputerError::retryable(
                    "node_has_no_bounds",
                    "the referenced accessibility node has no clickable bounds; observe again or use a semantic action",
                )
            })?
        } else {
            Point {
                x: request.x.unwrap_or_default(),
                y: request.y.unwrap_or_default(),
            }
        };
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(ComputerError::invalid("coordinates must be finite"));
        }
        self.check_points(&[point]).await?;
        Ok(point)
    }

    async fn check_points(&self, points: &[Point]) -> Result<(), ComputerError> {
        let state = self.state.lock().await;
        if points
            .iter()
            .any(|point| !contains_point(&state.displays, *point))
        {
            return Err(ComputerError::retryable(
                "point_outside_displays",
                "input point is outside the observed displays (or in a gap); use logical desktop coordinates and observe again",
            ));
        }
        Ok(())
    }

    async fn check_frame(&self, frame_id: Option<&str>) -> Result<(), ComputerError> {
        let state = self.state.lock().await;
        check_frame_id(state.frame_id.as_deref(), frame_id)?;
        check_display_configuration(&state.displays, &display_info()?)?;
        Ok(())
    }

    async fn act(
        &self,
        request: &ComputerRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value, ComputerError> {
        if cancellation.is_cancelled() {
            return Err(ComputerError::retryable(
                "cancelled",
                "computer action cancelled",
            ));
        }
        // One admission point for every physical input, including raw typing,
        // keypress and unpositioned scroll. No native event precedes this fence.
        if frame_bound(request.action) {
            self.check_frame(request.frame_id.as_deref()).await?;
            if request.node_id.is_none() {
                let expected = self.state.lock().await.input_context.clone();
                let current = read_input_context(&native_window_inventory()?, cancellation).await?;
                check_input_context(expected.as_ref(), &current)?;
            }
        }
        if !permission_status().accessibility {
            return Err(ComputerError::unavailable(
                "permission_required: enable Accessibility for XHarness in System Settings > Privacy & Security",
            ));
        }
        match request.action {
            ComputerAction::Move => {
                let point = self.checked_point(request, cancellation).await?;
                post_move(point, modifier_flags(&request.modifiers)?)?;
                Ok(json!({"ok":true,"action":"move","point":point}))
            }
            ComputerAction::Click => {
                if request.button == MouseButton::Left
                    && request.count == 1
                    && request.modifiers.is_empty()
                    && request.node_id.is_some()
                {
                    if let Some(target) = self.checked_target(request).await? {
                        if target.actions.iter().any(|action| action == "AXPress") {
                            node_action(
                                request.node_id.as_deref().unwrap_or_default(),
                                &target,
                                "AXPress",
                                cancellation,
                            )
                            .await?;
                            return Ok(json!({
                                "ok": true,
                                "action": "click",
                                "node_id": request.node_id,
                                "method": "accessibility"
                            }));
                        }
                    }
                }
                let point = self.checked_point(request, cancellation).await?;
                post_click(
                    point,
                    request.button,
                    request.count,
                    modifier_flags(&request.modifiers)?,
                    cancellation,
                )
                .await?;
                Ok(
                    json!({"ok":true,"action":"click","point":point,"button":request.button,"count":request.count,"method":"coordinates"}),
                )
            }
            ComputerAction::Drag => {
                self.check_frame(request.frame_id.as_deref()).await?;
                self.check_points(&request.path).await?;
                post_drag(
                    &request.path,
                    request.button,
                    request.duration_ms.unwrap_or(500).clamp(50, 10_000),
                    modifier_flags(&request.modifiers)?,
                    cancellation,
                )
                .await?;
                Ok(json!({"ok":true,"action":"drag","points":request.path.len()}))
            }
            ComputerAction::Scroll => {
                if request.node_id.is_some() {
                    post_move(self.checked_point(request, cancellation).await?, 0)?;
                } else if let (Some(x), Some(y)) = (request.x, request.y) {
                    self.check_frame(request.frame_id.as_deref()).await?;
                    self.check_points(&[Point { x, y }]).await?;
                    post_move(Point { x, y }, 0)?;
                }
                post_scroll(
                    request.delta_x.unwrap_or(0),
                    request.delta_y.unwrap_or(0),
                    modifier_flags(&request.modifiers)?,
                )?;
                Ok(
                    json!({"ok":true,"action":"scroll","delta_x":request.delta_x.unwrap_or(0),"delta_y":request.delta_y.unwrap_or(0)}),
                )
            }
            ComputerAction::Type => {
                if request.node_id.is_some() {
                    let target = self.checked_target(request).await?.ok_or_else(|| {
                        ComputerError::retryable(
                            "stale_node",
                            "the referenced accessibility node is no longer available; observe again",
                        )
                    })?;
                    node_action(
                        request.node_id.as_deref().unwrap_or_default(),
                        &target,
                        "focus",
                        cancellation,
                    )
                    .await?;
                    if read_input_context(&native_window_inventory()?, cancellation)
                        .await?
                        .pid
                        != target.pid
                    {
                        return Err(ComputerError::retryable(
                            "stale_node",
                            "target process did not acquire foreground focus; observe again",
                        ));
                    }
                }
                post_text(request.text.as_deref().unwrap_or_default(), cancellation).await?;
                Ok(
                    json!({"ok":true,"action":"type","characters":request.text.as_deref().unwrap_or_default().chars().count()}),
                )
            }
            ComputerAction::Keypress => {
                post_keypress(&request.keys, &request.modifiers)?;
                Ok(json!({"ok":true,"action":"keypress","keys":request.keys}))
            }
            ComputerAction::Wait => {
                let duration = Duration::from_millis(request.duration_ms.unwrap_or(1_000));
                tokio::select! {
                    _ = cancellation.cancelled() => return Err(ComputerError::retryable("cancelled", "computer wait cancelled")),
                    _ = tokio::time::sleep(duration) => {}
                }
                Ok(json!({"ok":true,"action":"wait","duration_ms":duration.as_millis()}))
            }
            ComputerAction::Window => window_action(request, cancellation).await,
            ComputerAction::Observe => unreachable!("observe is handled separately"),
        }
    }
}

#[async_trait]
impl ComputerDriver for MacComputer {
    async fn execute(
        &self,
        request: ComputerRequest,
        cancellation: CancellationToken,
    ) -> Result<ComputerOutput, ComputerError> {
        request.validate()?;
        if request.action == ComputerAction::Observe {
            return self.observe(&request, &cancellation).await;
        }
        if request.action == ComputerAction::Window && request.operation.as_deref() == Some("list")
        {
            let mut output = self.observe(&request, &cancellation).await?;
            if let Some(object) = output.value.as_object_mut() {
                object.insert("requested_action".into(), json!("window"));
                object.insert("operation".into(), json!("list"));
            }
            return Ok(output);
        }
        // Reject an ambiguous crop before input is posted, not only when the
        // requested post-action observation tries to capture it.
        if request.wants_observation_after() && request.include_screenshot.unwrap_or(false) {
            CapturePlan::new(&display_info()?, request.region)?;
        }
        let mut action = self.act(&request, &cancellation).await?;
        if frame_bound(request.action) {
            if let Some(value) = action.as_object_mut() {
                value.insert("effect_verified".into(), json!(false));
            }
        }
        if request.wants_observation_after() {
            let mut observation = request.clone();
            observation.action = ComputerAction::Observe;
            let mut result = self.observe(&observation, &cancellation).await?;
            if let Some(object) = result.value.as_object_mut() {
                object.insert("performed".into(), action);
            }
            Ok(result)
        } else {
            Ok(ComputerOutput::value(action))
        }
    }
}

#[derive(Serialize)]
struct PermissionStatus {
    accessibility: bool,
    screen_recording: bool,
}

// Owned array + borrowed dictionaries/numbers. Core Graphics defines the
// required entry types; no app-controlled pointer or Objective-C cast is used.
fn native_window_inventory() -> Result<Vec<NativeWindow>, ComputerError> {
    // SAFETY: option 16 excludes desktop elements, includes on/offscreen windows;
    // Copy returns a retained CFArray that stays alive through all borrowed reads.
    let array = unsafe { CGWindowListCopyWindowInfo(16, 0) };
    if array.is_null() {
        return Err(ComputerError::retryable(
            "window_identity_unavailable",
            "cannot read native window identities",
        ));
    }
    // SAFETY: non-null +1 array from Core Graphics, released below on every path.
    let count = unsafe { CFArrayGetCount(array) };
    let result = (|| {
        if !(0..=10000).contains(&count) {
            return Err(ComputerError::retryable(
                "window_identity_unavailable",
                "native window inventory exceeds its limit",
            ));
        }
        let mut windows = Vec::new();
        for index in 0..count {
            let mut pid = 0_i64;
            let mut id = 0_i64;
            let mut layer = 0_i64;
            let mut onscreen = false;
            let mut rect = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: 0.0,
                    height: 0.0,
                },
            };
            // SAFETY: in-bounds CFArray of CGWindow dictionaries, whose required
            // OwnerPID/Number/Bounds entries have the documented CFNumber/dict types.
            let valid = unsafe {
                let dict = CFArrayGetValueAtIndex(array, index);
                let p = CFDictionaryGetValue(dict, kCGWindowOwnerPID);
                let n = CFDictionaryGetValue(dict, kCGWindowNumber);
                let b = CFDictionaryGetValue(dict, kCGWindowBounds);
                let l = CFDictionaryGetValue(dict, kCGWindowLayer);
                let o = CFDictionaryGetValue(dict, kCGWindowIsOnscreen);
                if !o.is_null() {
                    onscreen = CFBooleanGetValue(o);
                }
                !l.is_null()
                    && CFNumberGetValue(l, 4, (&mut layer as *mut i64).cast())
                    && !p.is_null()
                    && !n.is_null()
                    && !b.is_null()
                    && CFNumberGetValue(p, 4, (&mut pid as *mut i64).cast())
                    && CFNumberGetValue(n, 4, (&mut id as *mut i64).cast())
                    && CGRectMakeWithDictionaryRepresentation(b, &mut rect)
            };
            if valid && pid > 0 {
                if let Ok(id) = u32::try_from(id) {
                    if id > 0 {
                        windows.push(NativeWindow {
                            id,
                            pid,
                            layer,
                            onscreen,
                            bounds: WindowBounds {
                                x: rect.origin.x,
                                y: rect.origin.y,
                                width: rect.size.width,
                                height: rect.size.height,
                            },
                        });
                    }
                }
            }
        }
        Ok(windows)
    })();
    // SAFETY: balances the single Copy above after all borrowed references expire.
    unsafe { CFRelease(array) };
    result
}

async fn read_input_context(
    windows: &[NativeWindow],
    cancellation: &CancellationToken,
) -> Result<InputContext, ComputerError> {
    let output = run_osascript_with_timeout(
        FOREGROUND_SCRIPT,
        None,
        cancellation,
        Duration::from_secs(2),
    )
    .await?;
    let pid = foreground_pid(&output)?;
    // LaunchServices may never know how this app was started. Always use one
    // kernel identity source for both LS and direct-exec apps, avoiding a source
    // switch when optional application metadata arrives later.
    let mut context = InputContext {
        pid: i64::from(pid),
        process_start: process_start(pid)?,
        window_id: None,
        bounds: None,
    };
    if let Some(window) = windows
        .iter()
        .find(|w| w.pid == context.pid && w.onscreen && w.layer == 0)
    {
        context.window_id = Some(window.id);
        context.bounds = Some(window.bounds);
    }
    Ok(context)
}

fn permission_status() -> PermissionStatus {
    // SAFETY: these parameterless system probes have no ownership effects.
    unsafe {
        PermissionStatus {
            accessibility: AXIsProcessTrusted(),
            screen_recording: CGPreflightScreenCaptureAccess(),
        }
    }
}

fn display_info() -> Result<Vec<DisplayInfo>, ComputerError> {
    let mut ids = [0_u32; 32];
    let mut count = 0_u32;
    // SAFETY: ids has capacity for max_displays entries and count is writable.
    let status = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if status != 0 || count as usize > ids.len() {
        return Err(ComputerError::retryable(
            "display_query_failed",
            format!("CGGetActiveDisplayList failed with status {status}"),
        ));
    }
    ids[..count as usize]
        .iter()
        .map(|id| {
            // SAFETY: IDs came directly from CGGetActiveDisplayList. Copy returns
            // a retained mode; all getters below run before its single release.
            let (bounds, primary, mode) = unsafe {
                (
                    CGDisplayBounds(*id),
                    CGDisplayIsMain(*id) != 0,
                    CGDisplayCopyDisplayMode(*id),
                )
            };
            if mode.is_null() {
                return Err(ComputerError::retryable(
                    "display_query_failed",
                    "display mode unavailable; observe again",
                ));
            }
            // CGDisplayPixelsWide can report logical mode dimensions on Retina.
            // Use the backing-pixel dimensions, not the legacy width/height API.
            // SAFETY: mode is the non-null +1 object above; released exactly once.
            let pixels = unsafe {
                let pixels = PixelSize {
                    width: CGDisplayModeGetPixelWidth(mode),
                    height: CGDisplayModeGetPixelHeight(mode),
                };
                CGDisplayModeRelease(mode);
                pixels
            };
            if bounds.size.width <= 0.0
                || bounds.size.height <= 0.0
                || pixels.width == 0
                || pixels.height == 0
            {
                return Err(ComputerError::retryable(
                    "display_query_failed",
                    "empty display geometry; observe again",
                ));
            }
            Ok(DisplayInfo {
                display_id: *id,
                primary,
                bounds: WindowBounds {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
                pixels,
                scale: pixels.width as f64 / bounds.size.width,
            })
        })
        .collect()
}

async fn accessibility_snapshot(
    plan: ObservationPlan,
    foreground_pid: i64,
    cancellation: &CancellationToken,
) -> Result<AccessibilitySnapshot, ComputerError> {
    let mut options = plan.options();
    options["frontmost_pid"] = json!(foreground_pid);
    let output = run_osascript_with_timeout(
        &format!("{ACCESSIBILITY_COMMON_SCRIPT}\n{ACCESSIBILITY_SNAPSHOT_SCRIPT}"),
        Some(&options),
        cancellation,
        Duration::from_secs(12),
    )
    .await?;
    serde_json::from_str(&output).map_err(|error| {
        ComputerError::retryable(
            "accessibility_decode_failed",
            format!("could not decode macOS accessibility snapshot: {error}"),
        )
    })
}

async fn node_action(
    node_id: &str,
    target: &NodeTarget,
    operation: &str,
    cancellation: &CancellationToken,
) -> Result<Value, ComputerError> {
    let windows = native_window_inventory()?;
    let foreground_window_id = windows
        .iter()
        .find(|w| w.pid == target.pid && w.onscreen && w.layer == 0)
        .map(|w| w.id);
    // Only the target rectangle's candidates cross the subprocess boundary.
    // Two entries prove ambiguity; never serialize an unbounded desktop list.
    let windows: Vec<_> = windows
        .into_iter()
        .filter(|window| {
            window.pid == target.pid
                && target
                    .window_bounds
                    .is_some_and(|rect| same_bounds(rect, window.bounds))
        })
        .take(2)
        .collect();
    let input = json!({
        "node_id": node_id,
        "pid": target.pid,
        "root_kind": target.root_kind,
        "root_index": target.root_index,
        "path": target.path,
        "window_id":target.window_id,
        "window_bounds":target.window_bounds,
        "windows":windows,
        "foreground_window_id":foreground_window_id,
        "identity":target.identity,
        "bounds":target.bounds,
        "operation": operation
    });
    let output = run_osascript(
        &format!("{ACCESSIBILITY_COMMON_SCRIPT}\n{NODE_ACTION_SCRIPT}"),
        Some(&input),
        cancellation,
    )
    .await?;
    let value: Value = serde_json::from_str(&output).map_err(|error| {
        ComputerError::retryable(
            "accessibility_action_decode_failed",
            format!("could not decode macOS accessibility action: {error}"),
        )
    })?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = match value["error"]["code"].as_str() {
            Some("target_disabled") => "target_disabled",
            Some("target_obscured") => "target_obscured",
            _ => "stale_node",
        };
        return Err(ComputerError::retryable(
            code,
            "accessibility target changed, is blocked, or cannot be verified; observe again",
        ));
    }
    Ok(value)
}

async fn window_action(
    request: &ComputerRequest,
    cancellation: &CancellationToken,
) -> Result<Value, ComputerError> {
    let surface = request.surface_id.as_deref().unwrap_or_default();
    let mut parts = surface.split(':');
    if parts.next() != Some("mac") {
        return Err(ComputerError::invalid("invalid macOS surface_id"));
    }
    let pid: i64 = parts
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ComputerError::invalid("invalid macOS surface pid"))?;
    let index: u32 = parts
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ComputerError::invalid("invalid macOS window index"))?;
    if parts.next().is_some() {
        return Err(ComputerError::invalid("invalid macOS surface_id"));
    }
    let input = json!({
        "surface_id": surface,
        "pid": pid,
        "index": index,
        "operation": request.operation,
        "x": request.x,
        "y": request.y,
        "width": request.width,
        "height": request.height
    });
    let output = run_osascript(WINDOW_ACTION_SCRIPT, Some(&input), cancellation).await?;
    serde_json::from_str(&output).map_err(|error| {
        ComputerError::retryable(
            "window_action_decode_failed",
            format!("could not decode macOS window action: {error}"),
        )
    })
}

async fn run_osascript(
    script: &str,
    input: Option<&Value>,
    cancellation: &CancellationToken,
) -> Result<String, ComputerError> {
    run_osascript_with_timeout(script, input, cancellation, Duration::from_secs(8)).await
}

async fn run_osascript_with_timeout(
    script: &str,
    input: Option<&Value>,
    cancellation: &CancellationToken,
    timeout: Duration,
) -> Result<String, ComputerError> {
    let mut command = Command::new("/usr/bin/osascript");
    command
        .arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(input) = input {
        command.arg(input.to_string());
    }
    let child = command.output();
    let output = tokio::select! {
        _ = cancellation.cancelled() => return Err(ComputerError::retryable("cancelled", "computer action cancelled")),
        result = tokio::time::timeout(timeout, child) => match result {
            Ok(result) => result.map_err(|error| ComputerError::retryable("osascript_spawn_failed", error.to_string()))?,
            Err(_) => return Err(ComputerError::retryable("osascript_timeout", "macOS Accessibility request timed out")),
        }
    };
    if !output.status.success() {
        return Err(ComputerError::retryable(
            "accessibility_action_failed",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn capture_png(
    plan: &CapturePlan,
    cancellation: &CancellationToken,
) -> Result<Screenshot, ComputerError> {
    let directory = private_runtime_directory()?;
    let path = directory.join(format!(
        "capture-{}.png",
        NEXT_SCREENSHOT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut command = Command::new("/usr/sbin/screencapture");
    command.arg("-x").arg("-t").arg("png");
    if plan.cropped {
        let region = plan.region;
        command.arg("-R").arg(format!(
            "{},{},{},{}",
            region.x.round() as i64,
            region.y.round() as i64,
            region.width.round() as i64,
            region.height.round() as i64
        ));
    } else {
        // Explicitly capture one known display; never imply a multi-screen
        // screenshot when only the primary screen's image is returned.
        command.arg("-D").arg(plan.display_number.to_string());
    }
    command.arg(&path).stdin(Stdio::null()).kill_on_drop(true);
    let result = tokio::select! {
        _ = cancellation.cancelled() => Err(ComputerError::retryable("cancelled", "screenshot cancelled")),
        result = tokio::time::timeout(Duration::from_secs(8), command.output()) => match result {
            Ok(Ok(output)) if output.status.success() => Ok(()),
            Ok(Ok(output)) => Err(ComputerError::retryable("screenshot_failed", String::from_utf8_lossy(&output.stderr).trim().to_owned())),
            Ok(Err(error)) => Err(ComputerError::retryable("screenshot_spawn_failed", error.to_string())),
            Err(_) => Err(ComputerError::retryable("screenshot_timeout", "macOS screenshot timed out")),
        }
    };
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    let png = tokio::fs::read(&path)
        .await
        .map_err(|error| ComputerError::retryable("screenshot_read_failed", error.to_string()));
    let _ = tokio::fs::remove_file(&path).await;
    Ok(Screenshot {
        png: png?,
        label: "macOS desktop observation".into(),
    })
}

fn private_runtime_directory() -> Result<PathBuf, ComputerError> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!("xharness-computer-{}", std::process::id()));
    std::fs::create_dir_all(&path)
        .map_err(|error| ComputerError::retryable("temp_dir_failed", error.to_string()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        ComputerError::retryable("temp_dir_permissions_failed", error.to_string())
    })?;
    Ok(path)
}

fn button_codes(button: MouseButton) -> (u32, u32, u32, u32) {
    match button {
        MouseButton::Left => (0, 1, 2, 6),
        MouseButton::Right => (1, 3, 4, 7),
        MouseButton::Middle => (2, 25, 26, 27),
    }
}

fn modifier_flags(modifiers: &[String]) -> Result<u64, ComputerError> {
    modifiers.iter().try_fold(0_u64, |flags, modifier| {
        let flag = match modifier.to_ascii_lowercase().as_str() {
            "shift" => 0x0002_0000,
            "control" | "ctrl" => 0x0004_0000,
            "option" | "alt" => 0x0008_0000,
            "command" | "cmd" | "meta" => 0x0010_0000,
            other => {
                return Err(ComputerError::invalid(format!(
                    "unsupported modifier {other:?}"
                )))
            }
        };
        Ok(flags | flag)
    })
}

fn post_move(point: Point, flags: u64) -> Result<(), ComputerError> {
    let source = EventSource::new()?;
    let event = Event::mouse(&source, 5, point, 0)?;
    event.flags(flags);
    event.post();
    Ok(())
}

async fn post_click(
    point: Point,
    button: MouseButton,
    count: u8,
    flags: u64,
    cancellation: &CancellationToken,
) -> Result<(), ComputerError> {
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        post_click_blocking(point, button, count, flags, &cancellation)
    })
    .await
    .map_err(|error| ComputerError::retryable("input_task_failed", error.to_string()))?
}

fn post_click_blocking(
    point: Point,
    button: MouseButton,
    count: u8,
    flags: u64,
    cancellation: &CancellationToken,
) -> Result<(), ComputerError> {
    let source = EventSource::new()?;
    let (button, down, up, _) = button_codes(button);
    for _ in 0..count {
        if cancellation.is_cancelled() {
            return Err(ComputerError::retryable("cancelled", "click cancelled"));
        }
        let down = Event::mouse(&source, down, point, button)?;
        down.flags(flags);
        down.post();
        let up = Event::mouse(&source, up, point, button)?;
        up.flags(flags);
        up.post();
        std::thread::sleep(Duration::from_millis(75));
    }
    Ok(())
}

async fn post_drag(
    path: &[Point],
    button: MouseButton,
    duration_ms: u64,
    flags: u64,
    cancellation: &CancellationToken,
) -> Result<(), ComputerError> {
    let path = path.to_vec();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        post_drag_blocking(&path, button, duration_ms, flags, &cancellation)
    })
    .await
    .map_err(|error| ComputerError::retryable("input_task_failed", error.to_string()))?
}

fn post_drag_blocking(
    path: &[Point],
    button: MouseButton,
    duration_ms: u64,
    flags: u64,
    cancellation: &CancellationToken,
) -> Result<(), ComputerError> {
    let source = EventSource::new()?;
    let (button, down, up, dragged) = button_codes(button);
    let start = path[0];
    let down_event = Event::mouse(&source, down, start, button)?;
    down_event.flags(flags);
    down_event.post();
    let interval = Duration::from_millis(duration_ms / (path.len() - 1) as u64);
    let mut outcome = Ok(());
    for point in &path[1..] {
        if cancellation.is_cancelled() {
            outcome = Err(ComputerError::retryable("cancelled", "drag cancelled"));
            break;
        }
        match Event::mouse(&source, dragged, *point, button) {
            Ok(event) => {
                event.flags(flags);
                event.post();
            }
            Err(error) => {
                outcome = Err(error);
                break;
            }
        }
        std::thread::sleep(interval);
    }
    // Always release the button, including cancellation and partial failure.
    let last = path.last().copied().unwrap_or(start);
    if let Ok(event) = Event::mouse(&source, up, last, button) {
        event.flags(flags);
        event.post();
    }
    outcome
}

fn post_scroll(horizontal: i32, vertical: i32, flags: u64) -> Result<(), ComputerError> {
    let source = EventSource::new()?;
    let event = Event::scroll(&source, vertical, horizontal)?;
    event.flags(flags);
    event.post();
    Ok(())
}

async fn post_text(text: &str, cancellation: &CancellationToken) -> Result<(), ComputerError> {
    let text = text.to_owned();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || post_text_blocking(&text, &cancellation))
        .await
        .map_err(|error| ComputerError::retryable("input_task_failed", error.to_string()))?
}

fn post_text_blocking(text: &str, cancellation: &CancellationToken) -> Result<(), ComputerError> {
    let source = EventSource::new()?;
    let units: Vec<u16> = text.encode_utf16().collect();
    for chunk in units.chunks(20) {
        if cancellation.is_cancelled() {
            return Err(ComputerError::retryable("cancelled", "typing cancelled"));
        }
        let down = Event::key(&source, 0, true)?;
        down.unicode(chunk);
        down.post();
        let up = Event::key(&source, 0, false)?;
        up.unicode(chunk);
        up.post();
    }
    Ok(())
}

fn post_keypress(keys: &[String], extra_modifiers: &[String]) -> Result<(), ComputerError> {
    let mut tokens = Vec::new();
    for key in keys {
        tokens.extend(key.split('+').filter(|part| !part.is_empty()));
    }
    let mut modifiers = extra_modifiers.to_vec();
    let mut ordinary = Vec::new();
    for token in tokens {
        match token.to_ascii_lowercase().as_str() {
            "shift" | "control" | "ctrl" | "option" | "alt" | "command" | "cmd" | "meta" => {
                modifiers.push(token.to_owned())
            }
            _ => ordinary.push(token),
        }
    }
    if ordinary.len() != 1 {
        return Err(ComputerError::invalid(
            "keypress requires exactly one non-modifier key",
        ));
    }
    let key = key_code(ordinary[0])?;
    let flags = modifier_flags(&modifiers)?;
    let source = EventSource::new()?;
    let down = Event::key(&source, key, true)?;
    down.flags(flags);
    down.post();
    let up = Event::key(&source, key, false)?;
    up.flags(flags);
    up.post();
    Ok(())
}

fn key_code(key: &str) -> Result<u16, ComputerError> {
    let normalized = key.to_ascii_lowercase();
    let code = match normalized.as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "return" | "enter" => 36,
        "l" => 37,
        "j" => 38,
        "'" => 39,
        "k" => 40,
        ";" => 41,
        "\\" => 42,
        "," => 43,
        "/" => 44,
        "n" => 45,
        "m" => 46,
        "." => 47,
        "tab" => 48,
        "space" => 49,
        "`" => 50,
        "backspace" | "delete" => 51,
        "escape" | "esc" => 53,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f3" => 99,
        "f8" => 100,
        "f9" => 101,
        "f11" => 103,
        "f10" => 109,
        "f12" => 111,
        "home" => 115,
        "pageup" => 116,
        "forwarddelete" => 117,
        "f4" => 118,
        "end" => 119,
        "f2" => 120,
        "pagedown" => 121,
        "f1" => 122,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return Err(ComputerError::invalid(format!("unsupported key {key:?}"))),
    };
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::accessibility_budget;

    #[tokio::test]
    async fn invalid_keyboard_frames_fail_before_permission_or_event_dispatch() {
        let driver = MacComputer::new();
        for request in [
            json!({"action":"keypress","keys":["unsupported-key"],"frame_id":"invented","observe_after":"never"}),
            json!({"action":"type","text":"","frame_id":"invented","observe_after":"never"}),
            json!({"action":"type","text":"","observe_after":"never"}),
            json!({"action":"scroll","delta_y":1,"frame_id":"invented","observe_after":"never"}),
        ] {
            let error = driver
                .execute(
                    serde_json::from_value(request).unwrap(),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "stale_frame");
        }
    }

    #[test]
    fn surface_ids_are_not_accepted_loosely() {
        let request = ComputerRequest {
            action: ComputerAction::Window,
            surface_id: Some("not-a-surface".into()),
            frame_id: None,
            node_id: None,
            x: None,
            y: None,
            button: MouseButton::Left,
            count: 1,
            modifiers: Vec::new(),
            path: Vec::new(),
            duration_ms: None,
            text: None,
            keys: Vec::new(),
            delta_x: None,
            delta_y: None,
            detail: None,
            region: None,
            include_screenshot: Some(false),
            include_accessibility: true,
            observe_after: Default::default(),
            operation: Some("focus".into()),
            width: None,
            height: None,
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(window_action(&request, &CancellationToken::new()))
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn key_and_modifier_maps_cover_normal_shortcuts() {
        assert_eq!(key_code("Enter").unwrap(), 36);
        assert_eq!(key_code("ArrowDown").err().unwrap().code, "invalid_request");
        assert_eq!(
            modifier_flags(&["CMD".into(), "shift".into()]).unwrap(),
            0x0012_0000
        );
    }

    #[test]
    fn accessibility_detail_has_bounded_budgets() {
        assert_eq!(accessibility_budget(Some("low")), (80, 4));
        assert_eq!(accessibility_budget(None), (220, 8));
        assert_eq!(accessibility_budget(Some("auto")), (220, 8));
        assert_eq!(accessibility_budget(Some("semantic")), (300, 10));
        assert_eq!(accessibility_budget(Some("high")), (500, 12));
    }

    #[test]
    fn accessibility_snapshot_decodes_internal_target_metadata() {
        let snapshot: AccessibilitySnapshot = serde_json::from_value(json!({
            "windows": [],
            "nodes": [{
                "node_id": "ax:42:w1:0.2",
                "parent_id": "window:42:1",
                "surface_id": "mac:42:1",
                "pid": 42,
                "root_kind": "window",
                "root_index": 1,
                "path": [0, 2],
                "role": "AXButton",
                "subrole": null,
                "label": "Save",
                "description": null,
                "identifier": "save-button",
                "value": null,
                "enabled": true,
                "focused": false,
                "selected": false,
                "visible": true,
                "bounds": {"x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0},
                "actions": ["AXPress"],
                "depth": 2
            }],
            "truncated": false,
            "visited": 1,
            "max_nodes": 80,
            "max_depth": 4
        }))
        .unwrap();
        let node = &snapshot.nodes[0];
        assert_eq!(node.pid, 42);
        assert_eq!(node.path, vec![0, 2]);
        assert_eq!(node.bounds.unwrap().center(), Point { x: 25.0, y: 40.0 });
        assert!(node.actions.iter().any(|action| action == "AXPress"));

        let projected = serde_json::to_value(node).unwrap();
        assert!(projected.get("pid").is_none());
        assert!(projected.get("path").is_none());
        assert!(projected.get("root_kind").is_none());
    }
}
