use gtk::{gdk, glib::translate::ToGlibPtr, prelude::*};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webkit2gtk::WebViewExt;

pub fn input(
    handle: PlatformWebview,
    request: super::InputRequest,
    reply: Sender<Result<(), String>>,
) {
    use super::InputRequest;
    let view = handle.inner();
    let result = (|| {
        if !view.is_visible() || !view.is_mapped() {
            return Err("owned browser view is hidden".into());
        }
        let window = view.window().ok_or("GTK view is unrealized")?;
        let seat = view
            .display()
            .default_seat()
            .ok_or("GDK seat unavailable")?;
        view.grab_focus();
        match request {
            InputRequest::Click { x, y, .. } | InputRequest::Move { x, y, .. } => {
                if x >= f64::from(view.allocated_width()) || y >= f64::from(view.allocated_height())
                {
                    return Err("point outside browser viewport".into());
                }
                if matches!(request, InputRequest::Move { .. }) {
                    let mut event = gdk::Event::new(gdk::EventType::MotionNotify)
                        .downcast::<gdk::EventMotion>()
                        .map_err(|_| "invalid GDK motion")?;
                    event.set_device(seat.pointer().as_ref());
                    let raw = event.as_mut();
                    raw.window = window.to_glib_full();
                    raw.x = x;
                    raw.y = y;
                    raw.time = 0;
                    raw.send_event = 1;
                    let _ = view.event(&event);
                } else {
                    for kind in [gdk::EventType::ButtonPress, gdk::EventType::ButtonRelease] {
                        let mut event = gdk::Event::new(kind)
                            .downcast::<gdk::EventButton>()
                            .map_err(|_| "invalid GDK button")?;
                        event.set_device(seat.pointer().as_ref());
                        let raw = event.as_mut();
                        raw.window = window.to_glib_full();
                        raw.x = x;
                        raw.y = y;
                        raw.button = 1;
                        raw.time = 0;
                        raw.send_event = 1;
                        let _ = view.event(&event);
                    }
                }
            }
            InputRequest::Key { key, modifiers, .. } => {
                let spec = super::key_spec(&key)?;
                let mask = modifiers
                    .iter()
                    .fold(gdk::ModifierType::empty(), |mask, m| {
                        mask | match m.as_str() {
                            "Shift" => gdk::ModifierType::SHIFT_MASK,
                            "Control" => gdk::ModifierType::CONTROL_MASK,
                            "Alt" => gdk::ModifierType::MOD1_MASK,
                            "Meta" => gdk::ModifierType::META_MASK,
                            _ => gdk::ModifierType::empty(),
                        }
                    });
                let keyval = if mask.contains(gdk::ModifierType::SHIFT_MASK) && key.len() == 1 {
                    spec.gdk - 32
                } else {
                    spec.gdk
                };
                let mapping = gdk::Keymap::for_display(&view.display())
                    .ok_or("GDK keymap unavailable")?
                    .entries_for_keyval(keyval);
                for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
                    let mut event = gdk::Event::new(kind)
                        .downcast::<gdk::EventKey>()
                        .map_err(|_| "invalid GDK key")?;
                    event.set_device(seat.keyboard().as_ref());
                    let raw = event.as_mut();
                    raw.window = window.to_glib_full();
                    raw.keyval = keyval;
                    raw.state = mask.bits();
                    raw.time = 0;
                    raw.send_event = 1;
                    if let Some(entry) = mapping.first() {
                        raw.hardware_keycode = entry.keycode() as u16;
                        raw.group = entry.group() as u8;
                    }
                    let _ = view.event(&event);
                }
            }
        }
        Ok(())
    })();
    let _ = reply.send(result);
}
pub fn snapshot(handle: PlatformWebview, reply: Sender<Result<Vec<u8>, String>>) {
    handle.inner().snapshot(
        webkit2gtk::SnapshotRegion::Visible,
        webkit2gtk::SnapshotOptions::NONE,
        None::<&gtk::gio::Cancellable>,
        move |result| {
            let result = result
                .map_err(|_| "WebKitGTK snapshot failed".to_string())
                .and_then(|surface| {
                    let mut bytes = Vec::new();
                    surface
                        .write_to_png(&mut bytes)
                        .map_err(|_| "native PNG encoding failed".to_string())?;
                    Ok(bytes)
                });
            let _ = reply.send(result);
        },
    );
}
