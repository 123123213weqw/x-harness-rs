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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{process::Command, sync::Mutex};
use tokio_util::sync::CancellationToken;
use xharness_computer::{
    ComputerAction, ComputerDriver, ComputerError, ComputerOutput, ComputerRequest, MouseButton,
    Point, Region, Screenshot,
};

static NEXT_SCREENSHOT: AtomicU64 = AtomicU64::new(1);

const ACCESSIBILITY_SNAPSHOT_SCRIPT: &str = r#"
function safe(f, d) { try { return f(); } catch (_) { return d; } }
function clipped(value, limit) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}
function boolValue(f, fallback) {
  const value = safe(f, fallback);
  return value === null || value === undefined ? fallback : Boolean(value);
}
function attribute(element, name, fallback) {
  return safe(() => element.attributes.byName(name).value(), fallback);
}
function bounds(element) {
  const position = safe(() => element.position(), null);
  const size = safe(() => element.size(), null);
  if (!position || !size) return null;
  const result = {x: Number(position[0]), y: Number(position[1]), width: Number(size[0]), height: Number(size[1])};
  return Object.values(result).every(Number.isFinite) ? result : null;
}
function actionNames(element) {
  return safe(() => element.actions().map(action => clipped(action.name(), 80)).filter(Boolean), []);
}
function safeValue(element, role, subrole) {
  if (role === 'AXSecureTextField' || subrole === 'AXSecureTextField') return '<redacted>';
  if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXComboBox') return null;
  return clipped(safe(() => element.value(), null), 160);
}
function run(argv) {
  const options = argv.length ? JSON.parse(argv[0]) : {};
  const maxNodes = Math.max(1, Math.min(Number(options.max_nodes) || 220, 600));
  const maxDepth = Math.max(1, Math.min(Number(options.max_depth) || 8, 16));
  const maxVisited = maxNodes * 5;
  const se = Application('System Events');
  const result = {windows: [], nodes: [], truncated: false, visited: 0, max_nodes: maxNodes, max_depth: maxDepth};
  const processes = safe(() => se.applicationProcesses.whose({visible: true})(), []);
  processes.sort((left, right) => Number(safe(() => right.frontmost(), false)) - Number(safe(() => left.frontmost(), false)));

  function walk(element, context, parentId, path, depth) {
    if (result.nodes.length >= maxNodes || result.visited >= maxVisited) { result.truncated = true; return; }
    result.visited += 1;
    if (depth > maxDepth) { result.truncated = true; return; }
    const role = clipped(safe(() => element.role(), ''), 80) || 'AXUnknown';
    const subrole = null;
    const title = clipped(safe(() => element.title(), ''), 160);
    const name = title ? null : clipped(safe(() => element.name(), ''), 160);
    const description = name || title ? null : clipped(safe(() => element.description(), ''), 160);
    const help = null;
    const identifier = null;
    const actions = /^(AXButton|AXMenuItem|AXCheckBox|AXRadioButton|AXPopUpButton|AXLink)$/.test(role)
      ? actionNames(element) : [];
    const nodeId = `ax:${context.pid}:${context.root_kind[0]}${context.root_index}:${path.join('.') || 'root'}`;
    const nodeBounds = bounds(element);
    const label = title || name || description || help || identifier || null;
    const visible = true;
    const emit = role !== 'AXUnknown' || label || actions.length || nodeBounds;
    const nextParent = emit ? nodeId : parentId;
    if (emit) {
      result.nodes.push({
        node_id: nodeId,
        parent_id: parentId,
        surface_id: context.surface_id,
        pid: context.pid,
        root_kind: context.root_kind,
        root_index: context.root_index,
        path,
        role,
        subrole,
        label,
        description: description && description !== label ? description : null,
        identifier,
        value: null,
        enabled: true,
        focused: false,
        selected: false,
        visible,
        bounds: nodeBounds,
        actions,
        depth
      });
      if (result.nodes.length >= maxNodes) { result.truncated = true; return; }
    }
    const children = safe(() => element.uiElements(), []);
    for (let childIndex = 0; childIndex < children.length; childIndex++) {
      walk(children[childIndex], context, nextParent, path.concat([childIndex]), depth + 1);
      if (result.truncated && result.nodes.length >= maxNodes) return;
    }
  }

  for (const process of processes) {
    const pid = Number(safe(() => process.unixId(), 0)) || 0;
    const app = clipped(safe(() => process.name(), ''), 160) || '';
    const frontmost = boolValue(() => process.frontmost(), false);
    const windows = safe(() => process.windows(), []);
    for (let index = 0; index < windows.length; index++) {
      const window = windows[index];
      const windowBounds = bounds(window);
      if (!windowBounds) continue;
      const surfaceId = `mac:${pid}:${index + 1}`;
      const windowNodeId = `window:${pid}:${index + 1}`;
      result.windows.push({
        surface_id: surfaceId,
        node_id: windowNodeId,
        app,
        pid,
        window_index: index + 1,
        title: clipped(safe(() => window.name(), ''), 240) || '',
        frontmost,
        focused: boolValue(() => window.attributes.byName('AXFocused').value(), false),
        minimized: boolValue(() => window.attributes.byName('AXMinimized').value(), false),
        bounds: windowBounds
      });
      if (!boolValue(() => window.attributes.byName('AXMinimized').value(), false)) {
        const children = safe(() => window.uiElements(), []);
        const context = {pid, root_kind: 'window', root_index: index + 1, surface_id: surfaceId};
        for (let childIndex = 0; childIndex < children.length; childIndex++) {
          walk(children[childIndex], context, windowNodeId, [childIndex], 1);
          if (result.nodes.length >= maxNodes) break;
        }
      }
      if (result.nodes.length >= maxNodes) break;
    }
    if (result.nodes.length >= maxNodes) break;
    if (frontmost) {
      const menuBars = safe(() => process.menuBars(), []);
      for (let menuIndex = 0; menuIndex < menuBars.length; menuIndex++) {
        const context = {pid, root_kind: 'menu_bar', root_index: menuIndex + 1, surface_id: `mac:${pid}:menu`};
        walk(menuBars[menuIndex], context, `application:${pid}`, [], 0);
        if (result.nodes.length >= maxNodes) break;
      }
    }
    if (result.nodes.length >= maxNodes) break;
  }
  return JSON.stringify(result);
}
"#;

const NODE_ACTION_SCRIPT: &str = r#"
function fail(message) { throw new Error(message); }
function run(argv) {
  const request = JSON.parse(argv[0]);
  const se = Application('System Events');
  const matches = se.applicationProcesses.whose({unixId: request.pid})();
  if (matches.length !== 1) fail('target process is no longer available');
  const process = matches[0];
  process.frontmost = true;
  let current;
  if (request.root_kind === 'window') current = process.windows()[request.root_index - 1];
  else if (request.root_kind === 'menu_bar') current = process.menuBars()[request.root_index - 1];
  else fail('unsupported accessibility root');
  if (!current || !current.exists()) fail('accessibility root is no longer available');
  for (const index of request.path) {
    const children = current.uiElements();
    current = children[index];
    if (!current || !current.exists()) fail('accessibility node is stale');
  }
  if (request.operation === 'focus') {
    const focused = current.attributes.byName('AXFocused');
    if (!focused.exists()) fail('node does not support focus');
    focused.value = true;
  } else {
    const action = current.actions.byName(request.operation);
    if (!action.exists()) fail(`node does not support ${request.operation}`);
    action.perform();
  }
  return JSON.stringify({ok: true, node_id: request.node_id, operation: request.operation});
}
"#;

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
    fn CGDisplayPixelsWide(display: CGDirectDisplayId) -> usize;
    fn CGDisplayPixelsHigh(display: CGDirectDisplayId) -> usize;
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
    fn CFRelease(object: *const c_void);
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WindowInfo {
    surface_id: String,
    node_id: String,
    app: String,
    pid: i64,
    window_index: u32,
    title: String,
    frontmost: bool,
    focused: bool,
    minimized: bool,
    bounds: WindowBounds,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct WindowBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AxNode {
    node_id: String,
    parent_id: Option<String>,
    surface_id: String,
    #[serde(skip_serializing)]
    pid: i64,
    #[serde(skip_serializing)]
    root_kind: String,
    #[serde(skip_serializing)]
    root_index: u32,
    #[serde(skip_serializing)]
    path: Vec<usize>,
    role: String,
    subrole: Option<String>,
    label: Option<String>,
    description: Option<String>,
    identifier: Option<String>,
    value: Option<Value>,
    enabled: bool,
    focused: bool,
    selected: bool,
    visible: bool,
    bounds: Option<WindowBounds>,
    actions: Vec<String>,
    depth: u32,
}

#[derive(Debug, Deserialize)]
struct AccessibilitySnapshot {
    windows: Vec<WindowInfo>,
    nodes: Vec<AxNode>,
    truncated: bool,
    visited: usize,
    max_nodes: usize,
    max_depth: usize,
}

impl AccessibilitySnapshot {
    fn empty(max_nodes: usize, max_depth: usize) -> Self {
        Self {
            windows: Vec::new(),
            nodes: Vec::new(),
            truncated: false,
            visited: 0,
            max_nodes,
            max_depth,
        }
    }
}

#[derive(Clone, Debug)]
struct NodeTarget {
    bounds: Option<WindowBounds>,
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
    next_frame: AtomicU64,
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
            next_frame: AtomicU64::new(1),
        }
    }

    async fn observe(
        &self,
        request: &ComputerRequest,
        cancellation: &CancellationToken,
    ) -> Result<ComputerOutput, ComputerError> {
        let displays = display_info()?;
        let permissions = permission_status();
        let (max_nodes, max_depth) = accessibility_budget(request.detail.as_deref());
        let (snapshot, accessibility_error) = if request.include_accessibility
            && permissions.accessibility
        {
            match accessibility_snapshot(max_nodes, max_depth, cancellation).await {
                Ok(snapshot) => (snapshot, None),
                Err(error) if error.retryable && request.include_screenshot.unwrap_or(false) => (
                    AccessibilitySnapshot::empty(max_nodes, max_depth),
                    Some(error.code),
                ),
                Err(error) => return Err(error),
            }
        } else {
            (AccessibilitySnapshot::empty(max_nodes, max_depth), None)
        };
        let frame_id = format!(
            "mac-frame-{}",
            self.next_frame.fetch_add(1, Ordering::Relaxed)
        );
        let mut nodes = BTreeMap::new();
        for window in &snapshot.windows {
            nodes.insert(
                window.node_id.clone(),
                NodeTarget {
                    bounds: Some(window.bounds),
                    pid: window.pid,
                    root_kind: "window".into(),
                    root_index: window.window_index,
                    path: Vec::new(),
                    actions: Vec::new(),
                },
            );
        }
        for node in &snapshot.nodes {
            nodes.insert(
                node.node_id.clone(),
                NodeTarget {
                    bounds: node.bounds,
                    pid: node.pid,
                    root_kind: node.root_kind.clone(),
                    root_index: node.root_index,
                    path: node.path.clone(),
                    actions: node.actions.clone(),
                },
            );
        }
        *self.state.lock().await = ObservationState {
            frame_id: Some(frame_id.clone()),
            nodes,
        };
        let screenshot = if request.include_screenshot.unwrap_or(false) {
            if !permissions.screen_recording {
                return Err(ComputerError::unavailable(
                    "permission_required: enable Screen Recording for XHarness in System Settings > Privacy & Security",
                ));
            }
            Some(capture_png(request.region, cancellation).await?)
        } else {
            None
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
                "error": accessibility_error
            },
            "permissions": permissions,
            "screenshot_included": screenshot.is_some()
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

    async fn checked_point(&self, request: &ComputerRequest) -> Result<Point, ComputerError> {
        if let Some(target) = self.checked_target(request).await? {
            return target.bounds.map(WindowBounds::center).ok_or_else(|| {
                ComputerError::retryable(
                    "node_has_no_bounds",
                    "the referenced accessibility node has no clickable bounds; observe again or use a semantic action",
                )
            });
        }
        let point = Point {
            x: request.x.unwrap_or_default(),
            y: request.y.unwrap_or_default(),
        };
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(ComputerError::invalid("coordinates must be finite"));
        }
        Ok(point)
    }

    async fn check_frame(&self, frame_id: Option<&str>) -> Result<(), ComputerError> {
        let state = self.state.lock().await;
        if frame_id != state.frame_id.as_deref() {
            return Err(ComputerError::retryable(
                "stale_frame",
                "the referenced frame is stale; call computer observe again",
            ));
        }
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
        if !permission_status().accessibility {
            return Err(ComputerError::unavailable(
                "permission_required: enable Accessibility for XHarness in System Settings > Privacy & Security",
            ));
        }
        match request.action {
            ComputerAction::Move => {
                let point = self.checked_point(request).await?;
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
                let point = self.checked_point(request).await?;
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
                    post_move(self.checked_point(request).await?, 0)?;
                } else if let (Some(x), Some(y)) = (request.x, request.y) {
                    self.check_frame(request.frame_id.as_deref()).await?;
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
        let action = self.act(&request, &cancellation).await?;
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

fn permission_status() -> PermissionStatus {
    // SAFETY: these parameterless system probes have no ownership effects.
    unsafe {
        PermissionStatus {
            accessibility: AXIsProcessTrusted(),
            screen_recording: CGPreflightScreenCaptureAccess(),
        }
    }
}

fn display_info() -> Result<Vec<Value>, ComputerError> {
    let mut ids = [0_u32; 32];
    let mut count = 0_u32;
    // SAFETY: ids has capacity for max_displays entries and count is writable.
    let status = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if status != 0 {
        return Err(ComputerError::retryable(
            "display_query_failed",
            format!("CGGetActiveDisplayList failed with status {status}"),
        ));
    }
    Ok(ids[..count as usize]
        .iter()
        .enumerate()
        .map(|(index, id)| {
            // SAFETY: IDs came directly from CGGetActiveDisplayList.
            let bounds = unsafe { CGDisplayBounds(*id) };
            // SAFETY: same display ID validity as above.
            let pixels = unsafe { (CGDisplayPixelsWide(*id), CGDisplayPixelsHigh(*id)) };
            json!({
                "display_id": id,
                "primary": index == 0,
                "bounds": {"x":bounds.origin.x,"y":bounds.origin.y,"width":bounds.size.width,"height":bounds.size.height},
                "pixels": {"width":pixels.0,"height":pixels.1},
                "scale": if bounds.size.width > 0.0 { pixels.0 as f64 / bounds.size.width } else { 1.0 }
            })
        })
        .collect())
}

fn accessibility_budget(detail: Option<&str>) -> (usize, usize) {
    match detail {
        Some("low") => (40, 3),
        Some("semantic") => (60, 5),
        Some("high") => (100, 7),
        _ => (60, 5),
    }
}

async fn accessibility_snapshot(
    max_nodes: usize,
    max_depth: usize,
    cancellation: &CancellationToken,
) -> Result<AccessibilitySnapshot, ComputerError> {
    let options = json!({"max_nodes": max_nodes, "max_depth": max_depth});
    let output = run_osascript_with_timeout(
        ACCESSIBILITY_SNAPSHOT_SCRIPT,
        Some(&options),
        cancellation,
        Duration::from_secs(15),
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
    let input = json!({
        "node_id": node_id,
        "pid": target.pid,
        "root_kind": target.root_kind,
        "root_index": target.root_index,
        "path": target.path,
        "operation": operation
    });
    let output = run_osascript(NODE_ACTION_SCRIPT, Some(&input), cancellation).await?;
    serde_json::from_str(&output).map_err(|error| {
        ComputerError::retryable(
            "accessibility_action_decode_failed",
            format!("could not decode macOS accessibility action: {error}"),
        )
    })
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
    region: Option<Region>,
    cancellation: &CancellationToken,
) -> Result<Screenshot, ComputerError> {
    let directory = private_runtime_directory()?;
    let path = directory.join(format!(
        "capture-{}.png",
        NEXT_SCREENSHOT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut command = Command::new("/usr/sbin/screencapture");
    command.arg("-x").arg("-t").arg("png");
    if let Some(region) = region {
        command.arg("-R").arg(format!(
            "{},{},{},{}",
            region.x.round() as i64,
            region.y.round() as i64,
            region.width.round() as i64,
            region.height.round() as i64
        ));
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
        assert_eq!(accessibility_budget(Some("low")), (40, 3));
        assert_eq!(accessibility_budget(None), (60, 5));
        assert_eq!(accessibility_budget(Some("auto")), (60, 5));
        assert_eq!(accessibility_budget(Some("semantic")), (60, 5));
        assert_eq!(accessibility_budget(Some("high")), (100, 7));
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
