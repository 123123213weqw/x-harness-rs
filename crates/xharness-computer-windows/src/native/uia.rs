use super::{
    api, clipped, desktop, error, foreground, hwnd, rect, screen, verify_surface, window_title,
    windows, Cancellation, Result,
};
use crate::wire::{self, Frame, NodeTarget, Reply, Surface};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
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
        if target.path.len() > 12 {
            return Err(error("stale_node", "invalid UIA node path"));
        }
        for &index in &target.path {
            if index > 1000 {
                return Err(error("stale_node", "invalid UIA sibling index"));
            }
            element = api(unsafe { self.walker.GetFirstChildElement(&element) })?;
            for _ in 0..index {
                element = api(unsafe { self.walker.GetNextSiblingElement(&element) })?;
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
        let (max_nodes, max_depth) = wire::budget(request.detail.as_deref());
        let mut traversal = Traversal {
            nodes: vec![],
            targets: vec![],
            visited: 0,
            max_nodes,
            max_depth,
            truncated: false,
            deadline: Instant::now() + Duration::from_secs(10),
            cancel,
        };
        if request.include_accessibility {
            // Enumerating every desktop provider can stall or disclose unrelated
            // apps. Snapshot only the observed foreground window's control view.
            if let Some(front) = &frame.foreground {
                if let Ok(root) = unsafe {
                    self.instance
                        .ElementFromHandleBuildCache(hwnd(front.handle), &self.cache)
                } {
                    self.walk(root, front, vec![], None, &mut traversal)?;
                } else {
                    return Err(error(
                        "accessibility_unavailable",
                        "foreground UIA provider is unavailable",
                    ));
                }
            }
        }
        cancel.check()?;
        // A slow snapshot must not become a frame of a different foreground app.
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
        let region = request.region.unwrap_or(desktop_bounds);
        if ![region.x, region.y, region.width, region.height]
            .iter()
            .all(|n| n.is_finite())
            || region.x < desktop_bounds.x
            || region.y < desktop_bounds.y
            || region.x + region.width > desktop_bounds.x + desktop_bounds.width
            || region.y + region.height > desktop_bounds.y + desktop_bounds.height
        {
            return Err(ComputerError::invalid(
                "capture region is outside the physical desktop",
            ));
        }
        let png = if request.include_screenshot == Some(true) {
            screen::screenshot(region)?
        } else {
            vec![]
        };
        let value = json!({"platform":"windows","coordinate_space":"physical_desktop_pixels","displays":screen::displays()?,"surfaces":window_values,"permissions":{"interactive_desktop":true,"elevation":"unchanged","secure_desktop":false},"accessibility":{"nodes":traversal.nodes,"truncated":traversal.truncated,"visited":traversal.visited,"max_nodes":max_nodes,"max_depth":max_depth,"scope":"foreground_window"},"screenshot_included":!png.is_empty(),"screenshot_bounds":region});
        Ok((
            Reply {
                schema: 1,
                value,
                error: None,
                frame: Some(frame),
                nodes: traversal.targets,
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
        element: IUIAutomationElement,
        surface: &Surface,
        path: Vec<u32>,
        parent_id: Option<String>,
        state: &mut Traversal<'_>,
    ) -> Result<()> {
        state.cancel.check()?;
        if state.nodes.len() >= state.max_nodes
            || state.visited >= state.max_nodes * 5
            || Instant::now() >= state.deadline
        {
            state.truncated = true;
            return Ok(());
        }
        state.visited += 1;
        if path.len() > state.max_depth {
            state.truncated = true;
            return Ok(());
        }
        let id = format!("uia:{}:{}", wire::surface_id(surface), state.nodes.len());
        // Cache request batches provider reads. Never request Value/Text content;
        // password labels fail closed even if a provider denies that property.
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
            let bounds = element.CachedBoundingRectangle().ok().map(rect);
            let enabled = element
                .CachedIsEnabled()
                .map(|v| v.as_bool())
                .unwrap_or(false);
            let visible = element
                .CachedIsOffscreen()
                .map(|v| !v.as_bool())
                .unwrap_or(false);
            let runtime = runtime_id(&element).ok();
            let mut actions = vec![];
            if runtime.is_some() && enabled && visible && !password {
                actions.push("focus");
                if element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .is_ok()
                {
                    actions.push("invoke");
                }
            }
            state.nodes.push(json!({"node_id":id,"parent_id":parent_id,"surface_id":wire::surface_id(surface),"role":role,"label":label,"bounds":bounds,"enabled":enabled,"visible":visible,"focused":element.CachedHasKeyboardFocus().map(|v|v.as_bool()).unwrap_or(false),"value":if password {Some("<redacted>")} else {None},"actions":actions,"depth":path.len()}));
            if let Some(runtime_id) = runtime {
                state.targets.push((
                    id.clone(),
                    NodeTarget {
                        surface: surface.clone(),
                        path: path.clone(),
                        runtime_id,
                    },
                ));
            }
            if path.len() == state.max_depth {
                state.truncated = true;
                return Ok(());
            }
            let Ok(mut child) = self
                .walker
                .GetFirstChildElementBuildCache(&element, &self.cache)
            else {
                return Ok(());
            };
            for index in 0..1000 {
                let mut child_path = path.clone();
                child_path.push(index);
                self.walk(child.clone(), surface, child_path, Some(id.clone()), state)?;
                if state.nodes.len() >= state.max_nodes
                    || state.visited >= state.max_nodes * 5
                    || Instant::now() >= state.deadline
                {
                    state.truncated = true;
                    break;
                }
                match self
                    .walker
                    .GetNextSiblingElementBuildCache(&child, &self.cache)
                {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
                if index == 999 {
                    state.truncated = true;
                }
            }
        }
        Ok(())
    }
}
struct Traversal<'a> {
    nodes: Vec<Value>,
    targets: Vec<(String, NodeTarget)>,
    visited: usize,
    max_nodes: usize,
    max_depth: usize,
    truncated: bool,
    deadline: Instant,
    cancel: &'a Cancellation,
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
