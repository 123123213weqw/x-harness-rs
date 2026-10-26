use gtk::{gdk, glib::translate::ToGlibPtr, prelude::*};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webkit2gtk::WebViewExt;

pub fn input(
    handle: PlatformWebview,
    request: super::InputRequest,
    viewport: (f64, f64),
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
                let (x, y) = crate::browser::viewport::content_point(
                    x,
                    y,
                    viewport,
                    (
                        f64::from(view.allocated_width()),
                        f64::from(view.allocated_height()),
                    ),
                )?;
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
            if reply.is_closed() {
                return;
            }
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

/// Wry's GtkBox child path packs expanding siblings and set_bounds is a no-op
/// there. Preserve the main renderer's box and place each guest in its own
/// precisely-sized overlay slot; no full-window transparent input shield.
pub fn layout(
    handle: PlatformWebview,
    rect: (f64, f64, f64, f64),
    reply: Sender<Result<(), String>>,
) {
    let result = (|| {
        let view = handle.inner();
        let parent = view.parent().ok_or("native browser has no GTK parent")?;
        let overlay = if let Ok(overlay) = parent.clone().downcast::<gtk::Overlay>() {
            if overlay.widget_name() != "xharness-browser-overlay" {
                return Err("unowned GTK browser overlay".into());
            }
            overlay
        } else {
            let container = parent
                .downcast::<gtk::Box>()
                .map_err(|_| "unsupported GTK browser parent")?;
            let outer = container.parent().ok_or("GTK browser parent is detached")?;
            let overlay = if let Ok(overlay) = outer.clone().downcast::<gtk::Overlay>() {
                if overlay.widget_name() != "xharness-browser-overlay" {
                    return Err("unowned GTK browser overlay".into());
                }
                overlay
            } else {
                let outer = outer
                    .downcast::<gtk::Container>()
                    .map_err(|_| "GTK browser root is not a container")?;
                // Do not guess packing order in a third-party compound layout.
                if outer.children().len() != 1 {
                    return Err("unsupported GTK browser root layout".into());
                }
                let overlay = gtk::Overlay::new();
                overlay.set_widget_name("xharness-browser-overlay");
                overlay.set_hexpand(true);
                overlay.set_vexpand(true);
                // GTK's default overlay allocation uses a child's natural size,
                // not a maximum size. Supply an exact slot for each owned guest.
                // Margins locate that slot; they are included in the allocation
                // and GTK subtracts them before allocating the WebView content.
                overlay.connect_get_child_position(|_, child| {
                    if !child.is::<webkit2gtk::WebView>() {
                        return None;
                    }
                    let (width, height) = child.size_request();
                    if width < 1 || height < 1 {
                        return None;
                    }
                    Some(gtk::Allocation::new(
                        0,
                        0,
                        width + child.margin_start(),
                        height + child.margin_top(),
                    ))
                });
                outer.remove(&container);
                overlay.add(&container);
                outer.add(&overlay);
                // Never show_all: that would expose other hidden browser tabs.
                overlay.show();
                overlay
            };
            container.remove(&view);
            overlay.add_overlay(&view);
            overlay
        };
        let (x, y, width, height) = rect;
        view.set_hexpand(false);
        view.set_vexpand(false);
        view.set_direction(gtk::TextDirection::Ltr);
        view.set_halign(gtk::Align::Start);
        view.set_valign(gtk::Align::Start);
        view.set_margin_start(x.round() as i32);
        view.set_margin_top(y.round() as i32);
        view.set_size_request(width.round() as i32, height.round() as i32);
        overlay.queue_resize();
        Ok(())
    })();
    let _ = reply.send(result);
}
