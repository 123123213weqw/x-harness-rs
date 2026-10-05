use super::{
    api, clipped, desktop, error, foreground, hwnd, rect, screen, verify_surface, window_title,
    windows, Cancellation, Result,
};
use crate::{
    observation::{self, Metadata},
    wire::{self, Frame, NodeTarget, Reply, Surface},
};
use serde_json::{json, Value};
use std::{
    cmp::Reverse,
    collections::{BTreeSet, BinaryHeap},
    time::{Duration, Instant},
};
use windows::Win32::{
    System::{
        Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY},
        Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
    },
    UI::Accessibility::*,
};
use xharness_computer::ComputerRequest;

pub(super) struct Automation {
    instance: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    cache: IUIAutomationCacheRequest,
}
impl Automation {
    pub(super) fn new() -> Result<Self> {
        // SAFETY: caller initialized this worker thread MTA. Objects stay on
        // that thread until they drop before CoUninitialize.
        unsafe {
            let instance: IUIAutomation =
                api(CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))?;
            let walker = api(instance.ControlViewWalker())?;
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
                UIA_AutomationIdPropertyId,
            ] {
                api(cache.AddProperty(id))?;
            }
            Ok(Self {
                instance,
                walker,
                cache,
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
    pub(super) fn observe(
        &self,
        request: &ComputerRequest,
        cancel: &Cancellation,
    ) -> Result<(Reply, Vec<u8>)> {
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
        if observation::intersection(region, desktop_bounds) != Some(region) {
            return Err(ComputerError::invalid(
                "capture region is outside the physical desktop",
            ));
        }
        let viewport = frame
            .foreground
            .as_ref()
            .and_then(|front| observation::intersection(region, front.bounds));
        let (max_nodes, max_depth) = wire::budget(request.detail.as_deref());
        let mut traversal = Traversal {
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
                self.walk(root, front, &mut traversal)?;
            }
        }
        let metadata: Vec<_> = traversal
            .candidates
            .iter()
            .map(|c| c.metadata.clone())
            .collect();
        let selection = observation::select(&metadata, viewport, max_nodes);
        if selection.omitted > 0 {
            traversal.reasons.insert("node_limit");
        }
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
            // Recheck after provider calls; never expose a cached password label
            // or value if the provider changed its classification mid-snapshot.
            let password = candidate.password
                || unsafe { element.CurrentIsPassword() }
                    .map(|v| v.as_bool())
                    .unwrap_or(true);
            if password {
                value = Some("<redacted>".to_owned());
                value_state = "redacted";
            }
            let runtime = if !context_only && !password {
                runtime_id(element).ok()
            } else {
                None
            };
            let mut actions = vec![];
            if runtime.is_some() && candidate.enabled && in_region && !password {
                actions.push("focus");
                if unsafe {
                    element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                }
                .is_ok()
                {
                    actions.push("invoke");
                }
            }
            nodes.push(json!({"node_id":id,"parent_id":candidate.metadata.parent.map(|p|node_id(&candidate.surface,p)),"surface_id":wire::surface_id(&candidate.surface),"role":candidate.role,"label":if password {"<redacted>"} else if context_only {""} else {&candidate.label},"bounds":candidate.metadata.bounds,"enabled":candidate.enabled,"visible":candidate.metadata.visible,"focused":candidate.metadata.focused,"in_region":in_region,"context_only":context_only,"value":value,"value_state":value_state,"value_truncated":value_truncated && !password,"actions":actions,"depth":candidate.metadata.depth}));
            if let Some(runtime_id) = runtime {
                targets.push((
                    id,
                    NodeTarget {
                        surface: candidate.surface.clone(),
                        path: candidate.path.clone(),
                        runtime_id,
                    },
                ));
            }
        }
        cancel.check()?;
        let png = if request.include_screenshot == Some(true) {
            screen::screenshot(region)?
        } else {
            vec![]
        };
        cancel.check()?;
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
        let value = json!({"platform":"windows","coordinate_space":"physical_desktop_pixels","displays":screen::displays()?,"surfaces":window_values,"permissions":{"interactive_desktop":true,"elevation":"unchanged","secure_desktop":false},"accessibility":{"nodes":nodes,"truncated":!traversal.reasons.is_empty(),"truncation_reasons":traversal.reasons,"visited":traversal.candidates.len(),"max_visited":max_nodes*5,"returned":nodes.len(),"eligible":selection.eligible,"omitted":selection.omitted,"max_nodes":max_nodes,"max_depth":max_depth,"scope":"foreground_window","selection_policy":"visible_breadth_first","region":region,"viewport":viewport},"screenshot_included":!png.is_empty(),"screenshot_bounds":region});
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
            let first = unsafe {
                self.walker
                    .GetFirstChildElementBuildCache(&element, &self.cache)
            };
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
                match unsafe {
                    self.walker
                        .GetNextSiblingElementBuildCache(&child, &self.cache)
                } {
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
    label: String,
    role: &'static str,
}
struct Traversal<'a> {
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
        // SAFETY: cache was populated by BuildCache on the same MTA; denied
        // password metadata is redacted, never treated as a non-password.
        unsafe {
            let password = element
                .CachedIsPassword()
                .map(|v| v.as_bool())
                .unwrap_or(true);
            let role = element
                .CachedControlType()
                .map(|v| role_name(v.0))
                .unwrap_or("unknown");
            let label = if password {
                "<redacted>".into()
            } else {
                element
                    .CachedName()
                    .map(|n| clipped(&n.to_string()))
                    .unwrap_or_default()
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
                label,
                role,
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
    }
}
fn node_id(surface: &Surface, index: usize) -> String {
    format!("uia:{}:{index}", wire::surface_id(surface))
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
                let truncated = text.chars().filter(|c| !c.is_control()).count() > 240;
                (Some(clipped(&text)), "known", truncated)
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
