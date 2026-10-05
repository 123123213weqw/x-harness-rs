use super::uia::Automation;
use super::{api, desktop, error, foreground, verify_surface, Cancellation, Result};
use crate::wire::{absolute_axis, Request};
use std::time::Duration;
use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    UI::{
        Accessibility::{IUIAutomationInvokePattern, UIA_InvokePatternId},
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};
use xharness_computer::{ComputerAction, ComputerError, MouseButton, Point};

fn keyboard(key: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
fn extended(key: u16) -> KEYBD_EVENT_FLAGS {
    if matches!(key, 0x21..=0x28 | 0x2d | 0x2e | 0x5b | 0x5c) {
        KEYEVENTF_EXTENDEDKEY
    } else {
        KEYBD_EVENT_FLAGS(0)
    }
}
fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
fn send(events: &[INPUT]) -> Result<()> {
    // SAFETY: slice size and INPUT discriminants match initialized union arms.
    let count = unsafe { SendInput(events, std::mem::size_of::<INPUT>() as i32) };
    if count as usize != events.len() {
        return Err(ComputerError { code:"outcome_unknown".into(), message:format!("Windows inserted {count}/{} input events; input may be blocked by UIPI or another controller; verify UI state, do not replay",events.len()),retryable:false });
    }
    Ok(())
}
struct Held {
    releases: Vec<INPUT>,
}
impl Held {
    fn new() -> Self {
        Self { releases: vec![] }
    }
    fn key(&mut self, key: u16) -> Result<()> {
        if unsafe { GetAsyncKeyState(i32::from(key)) } < 0 {
            return Err(error(
                "user_interrupted",
                "a requested key is already held; wait for user input to finish",
            ));
        }
        self.releases
            .push(keyboard(key, 0, extended(key) | KEYEVENTF_KEYUP));
        send(&[keyboard(key, 0, extended(key))])
    }
    fn button(&mut self, button: MouseButton) -> Result<()> {
        let (vk, down, up) = button_codes(button);
        if unsafe { GetAsyncKeyState(vk) } < 0 {
            return Err(error(
                "user_interrupted",
                "mouse button is already held by the user",
            ));
        }
        self.releases.push(mouse(up, 0, 0, 0));
        send(&[mouse(down, 0, 0, 0)])
    }
    fn release(&mut self) -> Result<()> {
        let result = self
            .releases
            .iter()
            .rev()
            .try_for_each(|event| send(std::slice::from_ref(event)));
        if result.is_ok() {
            self.releases.clear();
        }
        result
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        for input in self.releases.iter().rev() {
            let _ = send(std::slice::from_ref(input));
        }
    }
}
fn button_codes(button: MouseButton) -> (i32, MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        MouseButton::Left => (1, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (2, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (4, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}
fn move_pointer(point: Point) -> Result<()> {
    let bounds = desktop();
    send(&[mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        absolute_axis(point.x, bounds.x, bounds.width)?,
        absolute_axis(point.y, bounds.y, bounds.height)?,
        0,
    )])
}
fn keycode(name: &str) -> Result<u16> {
    let normalized = name.to_ascii_lowercase();
    let key = match normalized.as_str() {
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" | "option" => 0x12,
        "win" | "super" | "meta" | "cmd" | "command" => 0x5b,
        "enter" | "return" => 0x0d,
        "tab" => 0x09,
        "escape" | "esc" => 0x1b,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" => 0x2e,
        "insert" => 0x2d,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "arrowleft" | "left" => 0x25,
        "arrowup" | "up" => 0x26,
        "arrowright" | "right" => 0x27,
        "arrowdown" | "down" => 0x28,
        _ => {
            if let Some(number) = normalized
                .strip_prefix('f')
                .and_then(|v| v.parse::<u16>().ok())
                .filter(|n| (1..=24).contains(n))
            {
                return Ok(0x70 + number - 1);
            }
            let plain = normalized
                .strip_prefix("key")
                .or_else(|| normalized.strip_prefix("digit"))
                .unwrap_or(&normalized);
            if plain.len() == 1 && plain.as_bytes()[0].is_ascii_alphanumeric() {
                return Ok(u16::from(plain.as_bytes()[0].to_ascii_uppercase()));
            }
            return Err(ComputerError::invalid(format!(
                "unsupported Windows key: {name}"
            )));
        }
    };
    Ok(key)
}
fn modifiers(values: &[String]) -> Result<Vec<u16>> {
    let mut result = vec![];
    for value in values {
        let key = keycode(value)?;
        if ![0x10, 0x11, 0x12, 0x5b].contains(&key) {
            return Err(ComputerError::invalid("unsupported input modifier"));
        }
        if !result.contains(&key) {
            result.push(key);
        }
    }
    Ok(result)
}
fn require_foreground(request: &Request) -> Result<()> {
    let expected = request
        .frame
        .as_ref()
        .and_then(|f| f.foreground.as_ref())
        .ok_or_else(|| error("stale_frame", "observe the foreground before input"))?;
    let current = foreground()
        .ok_or_else(|| error("user_interrupted", "foreground application disappeared"))?;
    if current.handle != expected.handle || current.pid != expected.pid {
        return Err(error(
            "user_interrupted",
            "foreground changed during input; no further input sent",
        ));
    }
    Ok(())
}
pub(super) fn perform(
    automation: &Automation,
    request: &Request,
    cancel: &Cancellation,
) -> Result<()> {
    let r = &request.request;
    // Preflight the entire action before the first side effect.
    let modifier_keys = modifiers(&r.modifiers)?;
    let keys = r
        .keys
        .iter()
        .map(|k| keycode(k))
        .collect::<Result<Vec<_>>>()?;
    if r.path.len() > 512
        || r.text
            .as_ref()
            .is_some_and(|t| t.encode_utf16().count() > 32768)
        || r.duration_ms.is_some_and(|n| n > 30000)
    {
        return Err(ComputerError::invalid(
            "input exceeds bounded action budget",
        ));
    }
    if r.action == ComputerAction::Drag {
        let bounds = desktop();
        for p in &r.path {
            absolute_axis(p.x, bounds.x, bounds.width)?;
            absolute_axis(p.y, bounds.y, bounds.height)?;
        }
    }
    let element = request
        .node
        .as_ref()
        .map(|target| automation.resolve(target))
        .transpose()?;
    if let Some(element) = &element {
        if !api(unsafe { element.CurrentIsEnabled() })?.as_bool()
            || api(unsafe { element.CurrentIsOffscreen() })?.as_bool()
        {
            return Err(error("stale_node", "target is disabled or invisible"));
        }
        if api(unsafe { element.CurrentIsPassword() })?.as_bool() {
            return Err(ComputerError::invalid(
                "password controls are not operated by this adapter",
            ));
        }
    }
    let point = if let Some(element) = &element {
        let bounds = api(unsafe { element.CurrentBoundingRectangle() })?;
        if bounds.right <= bounds.left || bounds.bottom <= bounds.top {
            return Err(error("stale_node", "target has no visible bounds"));
        }
        Some(Point {
            x: f64::from(bounds.left) + f64::from(bounds.right - bounds.left) / 2.0,
            y: f64::from(bounds.top) + f64::from(bounds.bottom - bounds.top) / 2.0,
        })
    } else {
        r.x.zip(r.y).map(|(x, y)| Point { x, y })
    };
    if let Some(point) = point {
        let bounds = desktop();
        absolute_axis(point.x, bounds.x, bounds.width)?;
        absolute_axis(point.y, bounds.y, bounds.height)?;
    }
    cancel.check()?;
    if r.action == ComputerAction::Window {
        return window(request);
    }
    require_foreground(request)?;
    for key in [0x10, 0x11, 0x12, 0x5b, 0x5c, 1, 2, 4] {
        if unsafe { GetAsyncKeyState(key) } < 0 {
            return Err(error(
                "user_interrupted",
                "user modifier or mouse input is active; no input sent",
            ));
        }
    }
    let mut held = Held::new();
    for key in modifier_keys {
        held.key(key)?;
    }
    match r.action {
        ComputerAction::Move => {
            move_pointer(point.ok_or_else(|| ComputerError::invalid("missing pointer target"))?)?
        }
        ComputerAction::Click => {
            if let Some(element) = &element {
                if r.button == MouseButton::Left && r.count == 1 && r.modifiers.is_empty() {
                    if let Ok(pattern) = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    } {
                        // Invoke has been dispatched: no coordinate retry if its
                        // result is lost or fails after changing external state.
                        unsafe {pattern.Invoke()}.map_err(|_|ComputerError {code:"outcome_unknown".into(),message:"UIA invoke failed after dispatch; observe before deciding on another action".into(),retryable:false})?;
                        return Ok(());
                    }
                }
            }
            move_pointer(point.ok_or_else(|| ComputerError::invalid("missing click target"))?)?;
            for index in 0..r.count {
                cancel.check()?;
                if index > 0 {
                    cancel.sleep(Duration::from_millis(80))?;
                }
                let mut click = Held::new();
                click.button(r.button)?;
                click.release()?;
            }
        }
        ComputerAction::Drag => {
            move_pointer(r.path[0])?;
            held.button(r.button)?;
            let interval = Duration::from_millis(
                r.duration_ms.unwrap_or(600).max(1) / (r.path.len() - 1) as u64,
            );
            for point in r.path.iter().skip(1) {
                cancel.sleep(interval)?;
                require_foreground(request)?;
                move_pointer(*point)?;
            }
        }
        ComputerAction::Scroll => {
            if let Some(point) = point {
                move_pointer(point)?;
            }
            let x = r.delta_x.unwrap_or(0);
            let y = r.delta_y.unwrap_or(0);
            if y != 0 {
                send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, y.wrapping_neg() as u32)])?;
            }
            if x != 0 {
                send(&[mouse(MOUSEEVENTF_HWHEEL, 0, 0, x as u32)])?;
            }
        }
        ComputerAction::Type => {
            if let Some(element) = &element {
                api(unsafe { element.SetFocus() })?;
            }
            // UTF-16 surrogate units arrive as Unicode input. No clipboard is
            // read, overwritten or left containing user text.
            for unit in r.text.as_deref().unwrap_or("").encode_utf16() {
                cancel.check()?;
                require_foreground(request)?;
                send(&[
                    keyboard(0, unit, KEYEVENTF_UNICODE),
                    keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                ])?;
            }
        }
        ComputerAction::Keypress => {
            for key in keys {
                cancel.check()?;
                require_foreground(request)?;
                held.key(key)?;
            }
        }
        _ => return Err(ComputerError::invalid("unsupported dispatched action")),
    }
    held.release()
}
fn window(request: &Request) -> Result<()> {
    let r = &request.request;
    let target = request
        .surface
        .as_ref()
        .ok_or_else(|| error("stale_surface", "observe window list before window action"))?;
    let handle = verify_surface(target, false)?;
    match r.operation.as_deref() {
        Some("focus") => {
            if !unsafe { SetForegroundWindow(handle) }.as_bool()
                || foreground().is_none_or(|s| s.handle != target.handle)
            {
                return Err(error(
                    "focus_denied",
                    "Windows denied foreground activation; user focus is required",
                ));
            }
        }
        Some("move" | "resize") => {
            let bounds = super::surface(handle)
                .ok_or_else(|| error("stale_surface", "window disappeared"))?
                .bounds;
            let x = r.x.unwrap_or(bounds.x);
            let y = r.y.unwrap_or(bounds.y);
            let width = r.width.unwrap_or(bounds.width);
            let height = r.height.unwrap_or(bounds.height);
            if ![x, y, width, height]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1_000_000.0)
                || width <= 0.0
                || height <= 0.0
            {
                return Err(ComputerError::invalid("invalid window geometry"));
            }
            api(unsafe {
                SetWindowPos(
                    handle,
                    None,
                    x.round() as i32,
                    y.round() as i32,
                    width.round() as i32,
                    height.round() as i32,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
            })?;
        }
        Some("minimize") => unsafe {
            let _ = ShowWindow(handle, SW_MINIMIZE);
        },
        Some("maximize") => unsafe {
            let _ = ShowWindow(handle, SW_MAXIMIZE);
        },
        Some("close") => {
            api(unsafe { PostMessageW(Some(handle), WM_CLOSE, WPARAM(0), LPARAM(0)) })?
        }
        Some("fullscreen") => {
            return Err(ComputerError::invalid(
                "fullscreen is application-specific on Windows; use its observed menu or shortcut",
            ))
        }
        _ => return Err(ComputerError::invalid("unsupported window action")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_names_are_explicit() {
        assert_eq!(keycode("KeyA").unwrap(), 0x41);
        assert_eq!(keycode("Digit9").unwrap(), 0x39);
        assert_eq!(keycode("F24").unwrap(), 0x87);
        assert_eq!(keycode("ArrowDown").unwrap(), 0x28);
        for name in ["F25", "☃", "{ENTER}", "ctrl+a", ""] {
            assert!(keycode(name).is_err());
        }
    }
    #[test]
    fn modifiers_are_not_arbitrary_keys() {
        assert_eq!(
            modifiers(&["ctrl".into(), "control".into()]).unwrap(),
            vec![0x11]
        );
        assert!(modifiers(&["a".into()]).is_err());
    }
}
