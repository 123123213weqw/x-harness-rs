use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

const ACTIVITY_WATCHDOG: Duration = Duration::from_secs(70);
const MAX_CALL_ID_LEN: usize = 160;
const MAX_ACTIVITY_TEXT_LEN: usize = 160;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopComputerActivityRequest {
    call_id: String,
    active: bool,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivitySnapshot {
    mode: ActivityMode,
    text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivityMode {
    View,
    Control,
}

#[derive(Clone, Debug)]
struct ActivityEntry {
    serial: u64,
    snapshot: ActivitySnapshot,
}

struct ActivityUpdate {
    snapshot: Option<ActivitySnapshot>,
    watchdog: Option<(String, u64)>,
}

#[derive(Default)]
pub struct DesktopComputerActivityState {
    entries: Mutex<HashMap<String, ActivityEntry>>,
    serial: AtomicU64,
}

impl DesktopComputerActivityState {
    fn apply(&self, request: DesktopComputerActivityRequest) -> Result<ActivityUpdate, String> {
        validate_call_id(&request.call_id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "computer activity state is unavailable".to_owned())?;
        let watchdog = if request.active {
            let snapshot = ActivitySnapshot {
                mode: parse_mode(&request.mode)?,
                text: validate_text(request.text)?,
            };
            let serial = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
            entries.insert(request.call_id.clone(), ActivityEntry { serial, snapshot });
            Some((request.call_id, serial))
        } else {
            entries.remove(&request.call_id);
            None
        };
        Ok(ActivityUpdate {
            snapshot: latest(&entries),
            watchdog,
        })
    }

    fn expire(&self, call_id: &str, serial: u64) -> Option<Option<ActivitySnapshot>> {
        let mut entries = self.entries.lock().ok()?;
        if entries.get(call_id).map(|entry| entry.serial) != Some(serial) {
            return None;
        }
        entries.remove(call_id);
        Some(latest(&entries))
    }

    fn clear(&self) -> Option<ActivitySnapshot> {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
        None
    }
}

fn latest(entries: &HashMap<String, ActivityEntry>) -> Option<ActivitySnapshot> {
    entries
        .values()
        .max_by_key(|entry| entry.serial)
        .map(|entry| entry.snapshot.clone())
}

fn validate_call_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_CALL_ID_LEN || value.chars().any(char::is_control) {
        return Err("computer activity callId is invalid".to_owned());
    }
    Ok(())
}

fn validate_text(value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_ACTIVITY_TEXT_LEN
        || value.chars().any(char::is_control)
    {
        return Err("computer activity text is invalid".to_owned());
    }
    Ok(value.to_owned())
}

fn parse_mode(value: &str) -> Result<ActivityMode, String> {
    match value {
        "view" => Ok(ActivityMode::View),
        "control" => Ok(ActivityMode::Control),
        _ => Err("computer activity mode must be view or control".to_owned()),
    }
}

#[tauri::command]
pub fn desktop_set_computer_activity(
    app: AppHandle,
    state: State<'_, DesktopComputerActivityState>,
    request: DesktopComputerActivityRequest,
) -> Result<(), String> {
    let update = state.apply(request)?;
    render(&app, update.snapshot);
    if let Some((call_id, serial)) = update.watchdog {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(ACTIVITY_WATCHDOG).await;
            let state = handle.state::<DesktopComputerActivityState>();
            if let Some(snapshot) = state.expire(&call_id, serial) {
                render(&handle, snapshot);
            }
        });
    }
    Ok(())
}

pub fn clear(app: &AppHandle) {
    let snapshot = app.state::<DesktopComputerActivityState>().clear();
    render(app, snapshot);
}

fn render(app: &AppHandle, snapshot: Option<ActivitySnapshot>) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || macos::render(snapshot));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, snapshot);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;

    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBackingStoreType, NSBox, NSBoxType, NSColor, NSFont, NSPanel, NSScreen,
        NSStatusWindowLevel, NSTextField, NSWindowCollectionBehavior, NSWindowSharingType,
        NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use super::{ActivityMode, ActivitySnapshot};

    const PANEL_WIDTH: f64 = 420.0;
    const PANEL_HEIGHT: f64 = 36.0;
    const PANEL_TOP_MARGIN: f64 = 12.0;

    thread_local! {
        static OVERLAY: RefCell<Option<ComputerActivityOverlay>> = const { RefCell::new(None) };
    }

    struct ComputerActivityOverlay {
        panel: Retained<NSPanel>,
        dot: Retained<NSBox>,
        label: Retained<NSTextField>,
    }

    impl ComputerActivityOverlay {
        fn new(mtm: MainThreadMarker) -> Self {
            let frame = NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(PANEL_WIDTH, PANEL_HEIGHT),
            );
            let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
                NSPanel::alloc(mtm),
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            );
            panel.setFloatingPanel(true);
            panel.setBecomesKeyOnlyIfNeeded(true);
            panel.setOpaque(false);
            panel.setBackgroundColor(Some(&NSColor::clearColor()));
            panel.setHasShadow(true);
            panel.setLevel(NSStatusWindowLevel);
            panel.setIgnoresMouseEvents(true);
            panel.setHidesOnDeactivate(false);
            panel.setCanHide(false);
            panel.setMovable(false);
            // SAFETY: this retained panel stays owned by the thread-local
            // overlay, so AppKit must not release it independently on close.
            unsafe { panel.setReleasedWhenClosed(false) };
            panel.setSharingType(NSWindowSharingType::None);
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );

            let background = NSBox::initWithFrame(NSBox::alloc(mtm), frame);
            background.setBoxType(NSBoxType::Custom);
            background.setBorderWidth(1.0);
            background.setCornerRadius(PANEL_HEIGHT / 2.0);
            background.setBorderColor(&NSColor::colorWithSRGBRed_green_blue_alpha(
                1.0, 1.0, 1.0, 0.18,
            ));
            background.setFillColor(&NSColor::colorWithSRGBRed_green_blue_alpha(
                0.094, 0.094, 0.106, 0.94,
            ));

            let dot_frame = NSRect::new(NSPoint::new(14.0, 14.0), NSSize::new(8.0, 8.0));
            let dot = NSBox::initWithFrame(NSBox::alloc(mtm), dot_frame);
            dot.setBoxType(NSBoxType::Custom);
            dot.setBorderWidth(0.0);
            dot.setCornerRadius(4.0);
            dot.setFillColor(&NSColor::systemOrangeColor());

            let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
            label.setFrame(NSRect::new(
                NSPoint::new(31.0, 9.0),
                NSSize::new(PANEL_WIDTH - 45.0, 18.0),
            ));
            label.setTextColor(Some(&NSColor::whiteColor()));
            label.setFont(Some(&NSFont::systemFontOfSize(12.0)));

            background.addSubview(&dot);
            background.addSubview(&label);
            panel.setContentView(Some(&background));

            Self { panel, dot, label }
        }

        fn show(&self, snapshot: &ActivitySnapshot, mtm: MainThreadMarker) {
            self.label
                .setStringValue(&NSString::from_str(&snapshot.text));
            let dot_color = match snapshot.mode {
                ActivityMode::View => NSColor::systemOrangeColor(),
                ActivityMode::Control => NSColor::systemPinkColor(),
            };
            self.dot.setFillColor(&dot_color);
            if let Some(screen) = NSScreen::mainScreen(mtm) {
                let visible = screen.visibleFrame();
                self.panel.setFrameOrigin(NSPoint::new(
                    visible.origin.x + (visible.size.width - PANEL_WIDTH) / 2.0,
                    visible.origin.y + visible.size.height - PANEL_HEIGHT - PANEL_TOP_MARGIN,
                ));
            }
            self.panel.orderFrontRegardless();
        }

        fn hide(&self) {
            self.panel.orderOut(None);
        }
    }

    pub(super) fn render(snapshot: Option<ActivitySnapshot>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        OVERLAY.with_borrow_mut(|slot| {
            if slot.is_none() && snapshot.is_some() {
                *slot = Some(ComputerActivityOverlay::new(mtm));
            }
            if let Some(overlay) = slot.as_ref() {
                match snapshot.as_ref() {
                    Some(snapshot) => overlay.show(snapshot, mtm),
                    None => overlay.hide(),
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        call_id: &str,
        active: bool,
        mode: &str,
        text: &str,
    ) -> DesktopComputerActivityRequest {
        DesktopComputerActivityRequest {
            call_id: call_id.to_owned(),
            active,
            mode: mode.to_owned(),
            text: text.to_owned(),
        }
    }

    #[test]
    fn newest_activity_wins_and_previous_resumes_after_completion() {
        let state = DesktopComputerActivityState::default();
        let update = state
            .apply(request("observe", true, "view", "viewing"))
            .unwrap();
        assert_eq!(update.snapshot.unwrap().text, "viewing");
        let update = state
            .apply(request("click", true, "control", "controlling"))
            .unwrap();
        assert_eq!(update.snapshot.unwrap().mode, ActivityMode::Control);
        let update = state.apply(request("click", false, "", "")).unwrap();
        assert_eq!(update.snapshot.unwrap().text, "viewing");
    }

    #[test]
    fn stale_watchdog_cannot_expire_refreshed_call() {
        let state = DesktopComputerActivityState::default();
        let first = state.apply(request("same", true, "view", "first")).unwrap();
        let second = state
            .apply(request("same", true, "control", "second"))
            .unwrap();
        let (_, first_serial) = first.watchdog.unwrap();
        let (_, second_serial) = second.watchdog.unwrap();
        assert_eq!(state.expire("same", first_serial), None);
        assert_eq!(
            state.expire("same", second_serial),
            Some(None),
            "the current generation expires exactly once"
        );
    }

    #[test]
    fn bridge_rejects_unbounded_or_unknown_content() {
        let state = DesktopComputerActivityState::default();
        assert!(state.apply(request("", true, "view", "ok")).is_err());
        assert!(state.apply(request("call", true, "other", "ok")).is_err());
        assert!(state
            .apply(request(
                "call",
                true,
                "view",
                &"x".repeat(MAX_ACTIVITY_TEXT_LEN + 1),
            ))
            .is_err());
    }
}
