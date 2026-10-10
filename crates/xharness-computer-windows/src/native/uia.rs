use super::{
    api, clipped, desktop, error, foreground, hwnd, rect, screen, verify_surface, window_title,
    windows, Cancellation, Result,
};
use crate::{
    observation::{self, Metadata},
    wire::{self, Frame, NodeSnapshot, NodeTarget, Reply, Surface},
};
use serde_json::json;
use std::{
    cmp::Reverse,
    collections::{BTreeSet, BinaryHeap},
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::POINT,
    System::{
        Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY},
        Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
        Variant::{VARIANT, VT_BOOL},
    },
    UI::{
        Accessibility::*,
        WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT},
    },
};
use xharness_computer::ComputerRequest;

pub(super) struct Automation {
    instance: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    cache: IUIAutomationCacheRequest,
    view: &'static str,
}
impl Automation {
    pub(super) fn new() -> Result<Self> {
        // SAFETY: caller initialized this worker thread MTA. Objects stay on
        // that thread until they drop before CoUninitialize.
        unsafe {
            let instance: IUIAutomation =
                api(CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))?;
            let walker = api(instance.ControlViewWalker())?;
            let view = "control";
            #[cfg(feature = "native-acceptance")]
            let (walker, view) = if std::env::args_os()
                .any(|arg| arg == "--uia-visible-view-experiment")
            {
                // A logical UIA view, NOT a client-side subtree prune. The
                // same walker resolves action paths, with live runtime/PID
                // identity checks unchanged. Unknown provider values still
                // require native compatibility acceptance before rollout.
                let offscreen = api(instance
                    .CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(true)))?;
                let not_offscreen = api(instance.CreateNotCondition(&offscreen))?;
                let condition = api(instance
                    .CreateAndCondition(&api(instance.ControlViewCondition())?, &not_offscreen))?;
                (
                    api(instance.CreateTreeWalker(&condition))?,
                    "visible_control_experiment",
                )
            } else {
                (walker, view)
            };
            let cache = api(instance.CreateCacheRequest())?;
            api(cache.SetTreeScope(TreeScope_Element))?;
            for id in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsInvokePatternAvailablePropertyId,
            ] {
                api(cache.AddProperty(id))?;
            }
            Ok(Self {
                instance,
                walker,
                cache,
                view,
            })
        }
    }
    pub(super) fn resolve(&self, target: &NodeTarget) -> Result<IUIAutomationElement> {
        verify_surface(&target.surface, false)?;
        let mut element =
            api(unsafe { self.instance.ElementFromHandle(hwnd(target.surface.handle)) })?;
        if target.path.len() > wire::MAX_TREE_DEPTH {
            return Err(error("stale_node", "invalid UIA node path"));
        }
        for &index in &target.path {
            if index > 1000 {
                return Err(error("stale_node", "invalid UIA sibling index"));
            }
            element = resolve_child(
                unsafe { self.walker.GetFirstChildElement(&element) },
                "GetFirstChildElement",
            )?;
            for _ in 0..index {
                element = resolve_child(
                    unsafe { self.walker.GetNextSiblingElement(&element) },
                    "GetNextSiblingElement",
                )?;
            }
        }
        if runtime_id(&element)? != target.runtime_id {
            return Err(error("stale_node", "UIA node was replaced; observe again"));
        }
        // UIA element can migrate across windows; its process must still match.
        let pid = api(unsafe { element.CurrentProcessId() })?;
        if pid <= 0 || pid as u32 != target.surface.pid {
            return Err(error("stale_node", "UIA process identity changed"));
        }
        Ok(element)
    }
    /// Recheck target semantics and an actual desktop hit-test. InvokePattern
    /// is not evidence that a node is exposed: providers may invoke controls
    /// behind same-window overlays. Unknown hit-test data is fail-closed.
    /// This is a bounded preflight, NOT an atomic transaction with arbitrary UI.
    pub(super) fn verify_target(
        &self,
        element: &IUIAutomationElement,
        target: &NodeTarget,
        cancel: &Cancellation,
    ) -> Result<()> {
        cancel.check()?;
        verify_surface(&target.surface, true)?;
        let live = live_snapshot(element)?;
        target.snapshot.verify(&live)?;
        if !api(unsafe { element.CurrentIsEnabled() })?.as_bool()
            || api(unsafe { element.CurrentIsOffscreen() })?.as_bool()
            || api(unsafe { element.CurrentIsPassword() })?.as_bool()
        {
            return Err(error(
                "stale_node",
                "target is disabled, invisible or protected; no input dispatched",
            ));
        }
        let bounds = live.bounds;
        wire::absolute_axis(bounds.x + bounds.width / 2.0, desktop().x, desktop().width)?;
        wire::absolute_axis(
            bounds.y + bounds.height / 2.0,
            desktop().y,
            desktop().height,
        )?;
        let point = POINT {
            x: (bounds.x + bounds.width / 2.0).floor() as i32,
            y: (bounds.y + bounds.height / 2.0).floor() as i32,
        };
        // Reject another top-level window, even when the foreground is intact.
        let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
        if root != hwnd(target.surface.handle) {
            return Err(error(
                "target_occluded",
                "target center is covered by another window; no input dispatched",
            ));
        }
        let mut hit = api(unsafe { self.instance.ElementFromPoint(point) })?;
        let walker = api(unsafe { self.instance.RawViewWalker() })?;
        for _ in 0..=wire::MAX_TREE_DEPTH {
            cancel.check()?;
            if api(unsafe { self.instance.CompareElements(&hit, element) })?.as_bool() {
                // Provider calls can take time; recheck identity/semantics after
                // hit-testing as well. No cached COM object crosses a worker.
                if runtime_id(element)? != target.runtime_id {
                    return Err(error(
                        "stale_node",
                        "target identity changed during preflight; no input dispatched",
                    ));
                }
                target.snapshot.verify(&live_snapshot(element)?)?;
                if foreground().is_none_or(|s| {
                    s.handle != target.surface.handle || s.pid != target.surface.pid
                }) || api(unsafe { element.CurrentProcessId() })? as u32 != target.surface.pid
                    || !api(unsafe { element.CurrentIsEnabled() })?.as_bool()
                    || api(unsafe { element.CurrentIsOffscreen() })?.as_bool()
                    || api(unsafe { element.CurrentIsPassword() })?.as_bool()
                {
                    return Err(error("stale_node", "target visibility, protection or foreground changed during preflight; no input dispatched"));
                }
                return Ok(());
            }
            // A hit descendant (e.g. a button's text) is acceptable; a sibling
            // overlay or ancestor container is not. Null/error never means hit.
            match unsafe { walker.GetParentElement(&hit) } {
                Ok(parent) => hit = parent,
                Err(_) => break,
            }
        }
        Err(error("target_occluded", "target center does not hit the recorded node or its descendant; observe again; no input dispatched"))
    }
    pub(super) fn observe(
        &self,
        request: &ComputerRequest,
        cancel: &Cancellation,
    ) -> Result<(Reply, Vec<u8>)> {
        let started = Instant::now();
        let desktop_bounds = desktop();
        let frame = Frame {
            desktop: desktop_bounds,
            foreground: foreground(),
        };
        let surfaces = windows()?;
        let window_values: Vec<_> = surfaces.iter().map(|s| json!({"surface_id":wire::surface_id(s),"pid":s.pid,"app":s.class,"title":window_title(hwnd(s.handle)),"bounds":s.bounds,"frontmost":frame.foreground.as_ref().is_some_and(|f| f.handle==s.handle),"focused":frame.foreground.as_ref().is_some_and(|f| f.handle==s.handle),"minimized":unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd(s.handle)) }.as_bool()})).collect();
        // Validate before contacting a provider. The same physical rectangle
        // filters accessibility content and crops the optional screenshot.
        let region = request.region.unwrap_or(desktop_bounds);
        if !observation::contained(region, desktop_bounds) {
            return Err(ComputerError::invalid(
                "capture region is outside the physical desktop",
            ));
        }
        let viewport = frame
            .foreground
            .as_ref()
            .and_then(|front| observation::intersection(region, front.bounds));
        let window_ms = started.elapsed().as_millis();
        let discovery_started = Instant::now();
        let (max_nodes, max_depth) = wire::budget(request.detail.as_deref());
        let mut traversal = Traversal {
            metrics: Metrics::default(),
            candidates: vec![],
            pending: BinaryHeap::new(),
            reasons: BTreeSet::new(),
            max_nodes,
            max_depth,
            viewport,
            deadline: Instant::now() + Duration::from_secs(10),
            cancel,
        };
        if request.include_accessibility && viewport.is_some() {
            // COM pointers never leave this worker MTA. Foreground only;
            // offscreen ancestors are deferred, not assumed to have no children.
            if let Some(front) = &frame.foreground {
                let root_started = Instant::now();
                let root = unsafe {
                    self.instance
                        .ElementFromHandleBuildCache(hwnd(front.handle), &self.cache)
                }
                .map_err(|e| {
                    error(
                        "accessibility_unavailable",
                        &format!(
                            "ElementFromHandleBuildCache failed: 0x{:08x}",
                            e.code().0 as u32
                        ),
                    )
                })?;
                traversal.metrics.root_us += root_started.elapsed().as_micros();
                self.walk(root, front, &mut traversal)?;
            }
        }
        let discovery_ms = discovery_started.elapsed().as_millis();
        let selection_started = Instant::now();
        let metadata: Vec<_> = traversal
            .candidates
            .iter()
            .map(|c| c.metadata.clone())
            .collect();
        let selection = observation::select(&metadata, viewport, max_nodes);
        if selection.omitted > 0 {
            traversal.reasons.insert("node_limit");
        }
        let selection_ms = selection_started.elapsed().as_millis();
        let materialization_started = Instant::now();
        let mut nodes = vec![];
        let mut targets = vec![];
        for &index in &selection.indices {
            if traversal.stopped()? {
                break;
            }
            let candidate = &traversal.candidates[index];
            let element = &candidate.element;
            let in_region = candidate.metadata.in_scope(viewport);
            let context_only = !in_region || !candidate.metadata.meaningful;
            let id = node_id(&candidate.surface, index);
            // No Value/Text cache: only selected, visible, non-password inputs
            // get a lazy ValuePattern read. Unknown is not an empty value.
            let value_started = Instant::now();
            let (mut value, mut value_state, value_truncated) = if !context_only
                && !candidate.password
                && matches!(candidate.role, "edit" | "combobox")
            {
                read_value(element, viewport)
            } else if candidate.password {
                (Some("<redacted>".to_owned()), "redacted", false)
            } else {
                (None, "not_applicable", false)
            };
            traversal.metrics.value_us += value_started.elapsed().as_micros();
            // Recheck after provider calls; never expose a cached password label
            // or value if the provider changed its classification mid-snapshot.
            let password_started = Instant::now();
            let password = candidate.password
                || unsafe { element.CurrentIsPassword() }
                    .map(|v| v.as_bool())
                    .unwrap_or(true);
            traversal.metrics.password_check_us += password_started.elapsed().as_micros();
            if password {
                value = Some("<redacted>".to_owned());
                value_state = "redacted";
            }
            let runtime_started = Instant::now();
            let runtime = if !context_only && !password {
                runtime_id(element).ok()
            } else {
                None
            };
            traversal.metrics.runtime_id_us += runtime_started.elapsed().as_micros();
            let pattern_started = Instant::now();
            let mut actions = vec![];
            if runtime.is_some()
                && candidate.snapshot.is_some()
                && candidate.enabled
                && in_region
                && !password
            {
                actions.push("focus");
                if candidate.invoke_available.is_some() {
                    traversal.metrics.invoke_cache_hits += 1;
                } else {
                    traversal.metrics.invoke_live_fallbacks += 1;
                }
                // Availability is snapshot metadata, not permission to invoke.
                // The input path still resolves identity and obtains the live
                // pattern immediately before dispatch. Unknown cache entries
                // fall back to the old live query, never to a guessed false.
                if invoke_available(candidate.invoke_available, || unsafe {
                    element
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .is_ok()
                }) {
                    actions.push("invoke");
                }
            }
            traversal.metrics.pattern_us += pattern_started.elapsed().as_micros();
            nodes.push(json!({"node_id":id,"parent_id":candidate.metadata.parent.map(|p|node_id(&candidate.surface,p)),"surface_id":wire::surface_id(&candidate.surface),"role":candidate.role,"label":if password {"<redacted>"} else if context_only {""} else {&candidate.label},"bounds":candidate.metadata.bounds,"enabled":candidate.enabled,"visible":candidate.metadata.visible,"focused":candidate.metadata.focused,"in_region":in_region,"context_only":context_only,"value":value,"value_state":value_state,"value_truncated":value_truncated && !password,"actions":actions,"depth":candidate.metadata.depth}));
            if let (Some(runtime_id), Some(snapshot)) = (runtime, candidate.snapshot.clone()) {
                targets.push((
                    id,
                    NodeTarget {
                        surface: candidate.surface.clone(),
                        path: candidate.path.clone(),
                        runtime_id,
                        snapshot,
                    },
                ));
            }
        }
        let materialization_ms = materialization_started.elapsed().as_millis();
        cancel.check()?;
        let screenshot_started = Instant::now();
        let png = if request.include_screenshot == Some(true) {
            screen::screenshot(region)?
        } else {
            vec![]
        };
        let screenshot_ms = screenshot_started.elapsed().as_millis();
        cancel.check()?;
        let validation_started = Instant::now();
        // Validate after PNG encoding too: tree, image and action frame must
        // not refer to different foreground windows or display geometries.
        if foreground().map(|s| (s.handle, s.pid, s.bounds))
            != frame
                .foreground
                .as_ref()
                .map(|s| (s.handle, s.pid, s.bounds))
            || desktop() != frame.desktop
        {
            return Err(error(
                "stale_frame",
                "desktop changed during observation; observe again",
            ));
        }
        let validation_ms = validation_started.elapsed().as_millis();
        let timings = json!({"window_ms":window_ms,"discovery_ms":discovery_ms,"root_ms":traversal.metrics.root_us/1000,"child_navigation_ms":traversal.metrics.child_navigation_us/1000,"cached_metadata_ms":traversal.metrics.cached_metadata_us/1000,"selection_ms":selection_ms,"materialization_ms":materialization_ms,"password_check_ms":traversal.metrics.password_check_us/1000,"runtime_id_ms":traversal.metrics.runtime_id_us/1000,"pattern_ms":traversal.metrics.pattern_us/1000,"value_ms":traversal.metrics.value_us/1000,"screenshot_ms":screenshot_ms,"validation_ms":validation_ms,"total_ms":started.elapsed().as_millis(),"first_child_calls":traversal.metrics.first_child_calls,"next_sibling_calls":traversal.metrics.next_sibling_calls,"invoke_cache_hits":traversal.metrics.invoke_cache_hits,"invoke_live_fallbacks":traversal.metrics.invoke_live_fallbacks});
        let value = json!({"platform":"windows","coordinate_space":"physical_desktop_pixels","displays":screen::displays()?,"surfaces":window_values,"permissions":{"interactive_desktop":true,"elevation":"unchanged","secure_desktop":false},"accessibility":{"nodes":nodes,"truncated":!traversal.reasons.is_empty(),"truncation_reasons":traversal.reasons,"visited":traversal.candidates.len(),"max_visited":max_nodes*5,"returned":nodes.len(),"selected":selection.indices.len(),"eligible":selection.eligible,"omitted":selection.omitted,"max_nodes":max_nodes,"max_depth":max_depth,"scope":"foreground_window","selection_policy":"visible_breadth_first","tree_view":self.view,"timings":timings,"region":region,"viewport":viewport},"screenshot_included":!png.is_empty(),"screenshot_bounds":region});
        Ok((
            Reply {
                schema: 1,
                value,
                error: None,
                frame: Some(frame),
                nodes: targets,
                surfaces: surfaces
                    .into_iter()
                    .map(|s| (wire::surface_id(&s), s))
                    .collect(),
                png_len: png.len(),
            },
            png,
        ))
    }
    fn walk(
        &self,
        root: IUIAutomationElement,
        surface: &Surface,
        state: &mut Traversal<'_>,
    ) -> Result<()> {
        state.discover(root, surface, vec![], None);
        while let Some(Reverse((_, _, index))) = state.pending.pop() {
            if state.discovery_stopped()? {
                break;
            }
            let candidate = &state.candidates[index];
            let element = candidate.element.clone();
            let path = candidate.path.clone();
            // SAFETY: all UIA interfaces and cache requests live on this MTA.
            let navigation_started = Instant::now();
            state.metrics.first_child_calls += 1;
            let first = unsafe {
                self.walker
                    .GetFirstChildElementBuildCache(&element, &self.cache)
            };
            state.metrics.child_navigation_us += navigation_started.elapsed().as_micros();
            let mut child = match first {
                Ok(child) => child,
                Err(e) => {
                    state.provider_error(&e);
                    continue;
                }
            };
            if path.len() >= state.max_depth {
                state.reasons.insert("depth_limit");
                continue;
            }
            for sibling in 0..1000 {
                if state.discovery_stopped()? {
                    break;
                }
                if state.candidates.len() >= state.max_nodes * 5 {
                    state.reasons.insert("visit_limit");
                    break;
                }
                let mut child_path = path.clone();
                child_path.push(sibling);
                state.discover(child.clone(), surface, child_path, Some(index));
                if state.discovery_stopped()? {
                    break;
                }
                let navigation_started = Instant::now();
                state.metrics.next_sibling_calls += 1;
                let next = unsafe {
                    self.walker
                        .GetNextSiblingElementBuildCache(&child, &self.cache)
                };
                state.metrics.child_navigation_us += navigation_started.elapsed().as_micros();
                match next {
                    Ok(next) => child = next,
                    Err(e) => {
                        state.provider_error(&e);
                        break;
                    }
                }
                if sibling == 999 {
                    state.reasons.insert("sibling_limit");
                }
            }
            if state.candidates.len() >= state.max_nodes * 5 && !state.pending.is_empty() {
                state.reasons.insert("visit_limit");
                break;
            }
        }
        Ok(())
    }
}
struct Candidate {
    element: IUIAutomationElement,
    surface: Surface,
    path: Vec<u32>,
    metadata: Metadata,
    password: bool,
    enabled: bool,
    invoke_available: Option<bool>,
    label: String,
    role: &'static str,
    snapshot: Option<NodeSnapshot>,
}
fn invoke_available(cached: Option<bool>, live: impl FnOnce() -> bool) -> bool {
    cached.unwrap_or_else(live)
}
fn decode_availability(value: &VARIANT) -> Option<bool> {
    // Do not coerce a missing/default/non-boolean provider result to false.
    (value.vt() == VT_BOOL)
        .then(|| bool::try_from(value).ok())
        .flatten()
}
#[derive(Default)]
struct Metrics {
    root_us: u128,
    value_us: u128,
    child_navigation_us: u128,
    cached_metadata_us: u128,
    password_check_us: u128,
    runtime_id_us: u128,
    pattern_us: u128,
    first_child_calls: usize,
    next_sibling_calls: usize,
    invoke_cache_hits: usize,
    invoke_live_fallbacks: usize,
}
struct Traversal<'a> {
    metrics: Metrics,
    candidates: Vec<Candidate>,
    pending: BinaryHeap<Reverse<(u8, usize, usize)>>,
    reasons: BTreeSet<&'static str>,
    max_nodes: usize,
    max_depth: usize,
    viewport: Option<xharness_computer::Region>,
    deadline: Instant,
    cancel: &'a Cancellation,
}
impl Traversal<'_> {
    fn stopped(&mut self) -> Result<bool> {
        self.cancel.check()?;
        if Instant::now() >= self.deadline {
            self.reasons.insert("time_limit");
            return Ok(true);
        }
        Ok(false)
    }
    fn discovery_stopped(&mut self) -> Result<bool> {
        self.cancel.check()?;
        // Reserve two seconds of the existing ten-second cooperative budget
        // for materializing the selected snapshot, instead of returning an
        // empty tree whenever a large provider exhausts discovery time.
        if Instant::now() >= self.deadline - Duration::from_secs(2) {
            self.reasons.insert("time_limit");
            return Ok(true);
        }
        Ok(false)
    }
    fn provider_error(&mut self, error: &windows::core::Error) {
        // windows-rs represents a successful null COM child (end of tree)
        // as an error with S_OK. Non-zero failures are NOT tree completeness.
        if error.code().0 != 0 {
            self.reasons.insert("provider_error");
        }
    }
    fn discover(
        &mut self,
        element: IUIAutomationElement,
        surface: &Surface,
        path: Vec<u32>,
        parent: Option<usize>,
    ) {
        let metadata_started = Instant::now();
        // SAFETY: cache was populated by BuildCache on the same MTA; denied
        // password metadata is redacted, never treated as a non-password.
        unsafe {
            let password = element
                .CachedIsPassword()
                .map(|v| v.as_bool())
                .unwrap_or(true);
            let control_type = element.CachedControlType().ok().map(|v| v.0);
            let role = control_type.map(role_name).unwrap_or("unknown");
            let invoke_available = element
                .GetCachedPropertyValueEx(UIA_IsInvokePatternAvailablePropertyId, true)
                .ok()
                .and_then(|value| decode_availability(&value));
            let full_name = (!password)
                .then(|| element.CachedName().ok().map(|n| n.to_string()))
                .flatten();
            let label = if password {
                "<redacted>".into()
            } else {
                full_name.as_deref().map(clipped).unwrap_or_default()
            };
            let metadata = Metadata {
                parent,
                depth: path.len(),
                bounds: element.CachedBoundingRectangle().ok().map(rect),
                visible: element
                    .CachedIsOffscreen()
                    .map(|v| !v.as_bool())
                    .unwrap_or(false),
                focused: element
                    .CachedHasKeyboardFocus()
                    .map(|v| v.as_bool())
                    .unwrap_or(false),
                meaningful: !label.is_empty()
                    || matches!(
                        role,
                        "edit"
                            | "button"
                            | "checkbox"
                            | "combobox"
                            | "radio"
                            | "hyperlink"
                            | "slider"
                            | "listitem"
                            | "menuitem"
                            | "tabitem"
                    ),
            };
            let snapshot = full_name
                .as_deref()
                .zip(control_type)
                .zip(metadata.bounds)
                .map(|((name, role), bounds)| NodeSnapshot::new(name, role, bounds));
            let index = self.candidates.len();
            self.pending
                .push(Reverse(metadata.priority(self.viewport, index)));
            self.candidates.push(Candidate {
                element,
                surface: surface.clone(),
                path,
                metadata,
                password,
                enabled: false,
                invoke_available,
                label,
                role,
                snapshot,
            });
            // Read enabled independently: containers' enabled state does not
            // imply anything about a child.
            let candidate = &mut self.candidates[index];
            candidate.enabled = candidate
                .element
                .CachedIsEnabled()
                .map(|v| v.as_bool())
                .unwrap_or(false);
        }
        self.metrics.cached_metadata_us += metadata_started.elapsed().as_micros();
    }
}
fn node_id(surface: &Surface, index: usize) -> String {
    format!("uia:{}:{index}", wire::surface_id(surface))
}
fn live_snapshot(element: &IUIAutomationElement) -> Result<NodeSnapshot> {
    // SAFETY: live reads remain in the disposable worker's MTA.
    unsafe {
        Ok(NodeSnapshot::new(
            &api(element.CurrentName())?.to_string(),
            api(element.CurrentControlType())?.0,
            rect(api(element.CurrentBoundingRectangle())?),
        ))
    }
}
fn resolve_child(
    value: windows::core::Result<IUIAutomationElement>,
    stage: &str,
) -> Result<IUIAutomationElement> {
    value.map_err(|e| {
        error(
            if e.code().0 == 0 {
                "stale_node"
            } else {
                "native_api_failed"
            },
            &format!(
                "UIA {stage} could not resolve recorded node path: 0x{:08x}; observe again",
                e.code().0 as u32
            ),
        )
    })
}
fn read_value(
    element: &IUIAutomationElement,
    viewport: Option<xharness_computer::Region>,
) -> (Option<String>, &'static str, bool) {
    // SAFETY: live provider reads are performed only on this worker MTA.
    // Password/visibility classification is checked before and after the read.
    unsafe {
        let allowed = || {
            element
                .CurrentIsPassword()
                .map(|v| !v.as_bool())
                .unwrap_or(false)
                && element
                    .CurrentIsOffscreen()
                    .map(|v| !v.as_bool())
                    .unwrap_or(false)
                && element
                    .CurrentBoundingRectangle()
                    .ok()
                    .map(rect)
                    .zip(viewport)
                    .is_some_and(|(a, b)| observation::intersection(a, b).is_some())
        };
        if !allowed() {
            return (None, "unknown", false);
        }
        let value = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue());
        match value {
            Ok(value) if allowed() => {
                let text = value.to_string();
                let (bounded, truncated) = observation::bounded_value(&text);
                (Some(bounded), "known", truncated)
            }
            _ => (None, "unknown", false),
        }
    }
}
struct Array(*mut SAFEARRAY);
impl Drop for Array {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                let _ = SafeArrayDestroy(self.0);
            }
        }
    }
}
fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>> {
    let array = Array(api(unsafe { element.GetRuntimeId() })?);
    if array.0.is_null() {
        return Err(error("stale_node", "UIA runtime ID is unavailable"));
    }
    let low = api(unsafe { SafeArrayGetLBound(array.0, 1) })?;
    let high = api(unsafe { SafeArrayGetUBound(array.0, 1) })?;
    if high < low || i64::from(high) - i64::from(low) > 63 {
        return Err(error("stale_node", "invalid UIA runtime ID length"));
    }
    let mut result = vec![];
    for index in low..=high {
        let mut number = 0i32;
        api(unsafe { SafeArrayGetElement(array.0, &index, (&mut number as *mut i32).cast()) })?;
        result.push(number);
    }
    Ok(result)
}
fn role_name(value: i32) -> &'static str {
    match value {
        50000 => "button",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "hyperlink",
        50007 => "listitem",
        50008 => "list",
        50009 => "menu",
        50011 => "menuitem",
        50012 => "progress",
        50013 => "radio",
        50014 => "scrollbar",
        50015 => "slider",
        50018 => "tab",
        50019 => "tabitem",
        50020 => "text",
        50021 => "toolbar",
        50023 => "tree",
        50024 => "treeitem",
        50030 => "document",
        50032 => "window",
        50033 => "pane",
        50036 => "table",
        _ => "control",
    }
}
use xharness_computer::ComputerError;

#[cfg(test)]
mod tests {
    use super::{decode_availability, invoke_available, VARIANT};

    #[test]
    fn only_boolean_cache_values_are_authoritative() {
        for expected in [true, false] {
            assert_eq!(
                decode_availability(&VARIANT::from(expected)),
                Some(expected)
            );
        }
        for value in [
            VARIANT::default(),
            VARIANT::from(0i32),
            VARIANT::from("false"),
        ] {
            assert_eq!(decode_availability(&value), None);
        }
    }

    #[test]
    fn known_availability_does_not_contact_provider_again() {
        for expected in [true, false] {
            assert_eq!(
                invoke_available(Some(expected), || panic!("redundant live read")),
                expected
            );
        }
    }

    #[test]
    fn unknown_availability_retains_live_query_semantics() {
        for expected in [true, false] {
            let mut calls = 0;
            assert_eq!(
                invoke_available(None, || {
                    calls += 1;
                    expected
                }),
                expected
            );
            assert_eq!(calls, 1);
        }
    }
}
