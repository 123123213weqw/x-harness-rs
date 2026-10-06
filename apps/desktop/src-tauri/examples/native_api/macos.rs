use block2::RcBlock;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage,
};
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSString};
use objc2_web_kit::WKWebView;
use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;

fn view(handle: &PlatformWebview) -> Result<&WKWebView, String> {
    let ptr = handle.inner().cast::<WKWebView>();
    if ptr.is_null() {
        return Err("WKWebView unavailable".into());
    }
    // SAFETY: Tauri owns the live WKWebView throughout with_webview; this
    // borrowed handle never leaves that main-thread closure.
    Ok(unsafe { &*ptr })
}
pub fn button(
    handle: PlatformWebview,
    x: f64,
    y: f64,
    pressed: bool,
    reply: Sender<Result<(), String>>,
) {
    let result = (|| {
        let view = view(&handle)?;
        let window = view.window().ok_or("WKWebView window missing")?;
        // Browser coordinates start at the upper left. An unflipped AppKit
        // view starts at the lower left; converting to window coordinates does
        // not itself change that input convention. Never infer the convention
        // from display scale or the outer window's dimensions.
        let flipped = view.isFlipped();
        let height = view.bounds().size.height;
        let local = NSPoint::new(x, if flipped { y } else { height - y });
        let point = view.convertPoint_toView(local, None);
        println!("NATIVE_INPUT_GEOMETRY flipped={flipped} height={height} browser=({x},{y}) window=({},{})", point.x, point.y);
        let kind = if pressed {
            NSEventType::LeftMouseDown
        } else {
            NSEventType::LeftMouseUp
        };
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,point,NSEventModifierFlags::empty(),0.0,window.windowNumber(),None,0,1,1.0)
            .ok_or("native mouse event unavailable")?;
        window.sendEvent(&event);
        Ok(())
    })();
    let _ = reply.send(result);
}
pub fn key_z(handle: PlatformWebview, pressed: bool, reply: Sender<Result<(), String>>) {
    let result = (|| {
        let view = view(&handle)?;
        let window = view.window().ok_or("WKWebView window missing")?;
        let text = NSString::from_str("z");
        let kind = if pressed {
            NSEventType::KeyDown
        } else {
            NSEventType::KeyUp
        };
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,NSPoint::new(0.0,0.0),NSEventModifierFlags::empty(),0.0,window.windowNumber(),None,&text,&text,false,6)
            .ok_or("native key event unavailable")?;
        window.sendEvent(&event);
        Ok(())
    })();
    let _ = reply.send(result);
}
pub fn snapshot(handle: PlatformWebview, reply: Sender<Result<Vec<u8>, String>>) {
    let Ok(view) = view(&handle) else {
        let _ = reply.send(Err("WKWebView unavailable".into()));
        return;
    };
    let reply = std::sync::Mutex::new(Some(reply));
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let result = (|| {
            if !error.is_null() || image.is_null() {
                return Err("WK snapshot failed".into());
            }
            let _mtm = MainThreadMarker::new().ok_or("snapshot callback is not on main thread")?;
            // SAFETY: WebKit supplies a live NSImage for this callback only.
            let image = unsafe { &*image };
            let tiff = image
                .TIFFRepresentation()
                .ok_or("snapshot pixels missing")?;
            let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                .ok_or("bitmap encoding failed")?;
            // SAFETY: an empty typed dictionary contains no mismatched property values.
            let png = unsafe {
                bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            }
            .ok_or("PNG encoding failed")?;
            Ok(png.to_vec())
        })();
        if let Some(reply) = reply.lock().unwrap().take() {
            let _ = reply.send(result);
        }
    });
    // SAFETY: block has exactly WebKit's NSImage/NSError completion signature;
    // WebKit copies it until completion. No borrowed Rust values are captured.
    unsafe {
        view.takeSnapshotWithConfiguration_completionHandler(None, &block);
    }
}
