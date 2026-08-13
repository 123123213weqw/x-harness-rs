use gtk::{gdk, glib::translate::ToGlibPtr, prelude::*};
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;
use webkit2gtk::WebViewExt;

type Reply = Sender<Result<(), String>>;
pub fn button(handle: PlatformWebview, x: f64, y: f64, pressed: bool, reply: Reply) {
    let view = handle.inner();
    let result = (|| {
        let window = view.window().ok_or("GTK view is unrealized")?;
        let pointer = view
            .display()
            .default_seat()
            .and_then(|seat| seat.pointer());
        view.grab_focus();
        let kind = if pressed {
            gdk::EventType::ButtonPress
        } else {
            gdk::EventType::ButtonRelease
        };
        let mut event = gdk::Event::new(kind)
            .downcast::<gdk::EventButton>()
            .map_err(|_| "invalid GDK event")?;
        event.set_device(pointer.as_ref());
        let raw = event.as_mut();
        // to_glib_full retains the window for gdk_event_free. Never store
        // a borrowed window pointer in an owning GDK event.
        raw.window = window.to_glib_full();
        raw.x = x;
        raw.y = y;
        raw.button = 1;
        raw.time = 0; // GDK_CURRENT_TIME, a sentinel rather than a wall-clock timestamp.
        raw.send_event = 1;
        let _ = view.event(&event);
        Ok(())
    })();
    let _ = reply.send(result);
}
pub fn key_z(handle: PlatformWebview, pressed: bool, reply: Reply) {
    let view = handle.inner();
    let result = (|| {
        let window = view.window().ok_or("GTK view is unrealized")?;
        let keyboard = view
            .display()
            .default_seat()
            .and_then(|seat| seat.keyboard());
        let kind = if pressed {
            gdk::EventType::KeyPress
        } else {
            gdk::EventType::KeyRelease
        };
        let mut event = gdk::Event::new(kind)
            .downcast::<gdk::EventKey>()
            .map_err(|_| "invalid GDK key")?;
        event.set_device(keyboard.as_ref());
        let raw = event.as_mut();
        raw.window = window.to_glib_full();
        raw.time = 0; // GDK_CURRENT_TIME.
        raw.keyval = u32::from(b'z');
        raw.send_event = 1;
        let _ = view.event(&event);
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
