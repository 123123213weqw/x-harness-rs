use block2::RcBlock;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage,
    NSWindowStyleMask,
};
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSProcessInfo, NSString};
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

fn content_point(x: f64, y: f64, height: f64, flipped: bool, top: f64) -> Result<NSPoint, String> {
    if ![x, y, height, top].iter().all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || top < 0.0
        || height <= 0.0
        || y + top >= height
    {
        return Err("native browser point is outside its content viewport".into());
    }
    Ok(NSPoint::new(
        x,
        if flipped { y + top } else { height - y - top },
    ))
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
        // Tauri's focus request is queued. Inspect the native presentation and
        // acknowledge the owned responder in this exact dispatch closure; never
        // activate the app, show a hidden view or route into another responder.
        let hidden = view.isHiddenOrHasHiddenAncestor();
        let visible = view.visibleRect();
        let focused = !hidden && window.makeFirstResponder(Some(view));
        println!("NATIVE_INPUT_PRESENTATION hidden={hidden} visible=({},{},{},{}) window_visible={} key_window={} responder_accepted={focused}",
            visible.origin.x, visible.origin.y, visible.size.width, visible.size.height,
            window.isVisible(), window.isKeyWindow());
        if hidden || !focused {
            return Err("owned native browser is hidden or cannot accept focus".into());
        }
        // Match WebKit's automatic top-obscured-inset calculation using public
        // AppKit geometry. A full-size, opaque-titlebar child WebView can retain
        // a titlebar inset even below the titlebar: CSS clientY starts AFTER it.
        // convertPoint alone maps view coordinates, not this content origin.
        // Do not hardcode a titlebar height, apply a DPR multiplier, or use SPI.
        // WebKit/UIProcess/mac/PageClientImplMac.mm::computeAutomaticTopObscuredInset
        let top = if window
            .styleMask()
            .contains(NSWindowStyleMask::FullSizeContentView)
            && !window.titlebarAppearsTransparent()
            && view.enclosingScrollView().is_none()
        {
            window.updateConstraintsIfNeeded();
            view.convertRect_fromView(window.contentLayoutRect(), None)
                .origin
                .y
                .max(0.0)
        } else {
            0.0
        };
        let flipped = view.isFlipped();
        let bounds = view.bounds();
        let height = bounds.size.height;
        if x >= bounds.size.width {
            return Err("native browser point is outside its content viewport".into());
        }
        let local = content_point(x, y, height, flipped, top)?;
        let point = view.convertPoint_toView(local, None);
        println!("NATIVE_INPUT_GEOMETRY flipped={flipped} height={height} top_inset={top} browser=({x},{y}) window=({},{})", point.x, point.y);
        let kind = if pressed {
            NSEventType::LeftMouseDown
        } else {
            NSEventType::LeftMouseUp
        };
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,point,NSEventModifierFlags::empty(),NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,0,1,1.0)
            .ok_or("native mouse event unavailable")?;
        // Dispatch to the owned browser responder, not the outer application
        // window's hit-testing/current-responder routing. This is still an
        // NSEvent/WebKit native input path, never DOM dispatchEvent or OS input.
        if pressed {
            view.mouseDown(&event);
        } else {
            view.mouseUp(&event);
        }
        Ok(())
    })();
    let _ = reply.send(result);
}

#[cfg(test)]
mod tests {
    use super::content_point;

    #[test]
    fn css_points_follow_content_insets_not_titlebar_constants_or_dpr() {
        for (height, top) in [(560.0, 0.0), (560.0, 22.0), (560.0, 28.0), (900.0, 48.0)] {
            for flipped in [true, false] {
                let point = content_point(60.0, 35.0, height, flipped, top).unwrap();
                assert_eq!(point.x, 60.0);
                assert_eq!(
                    point.y,
                    if flipped {
                        35.0 + top
                    } else {
                        height - 35.0 - top
                    }
                );
            }
        }
    }

    #[test]
    fn malformed_and_outside_content_points_fail_before_input_dispatch() {
        for (x, y, height, top) in [
            (f64::NAN, 0.0, 560.0, 0.0),
            (0.0, f64::INFINITY, 560.0, 0.0),
            (-1.0, 0.0, 560.0, 0.0),
            (0.0, -1.0, 560.0, 0.0),
            (0.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 560.0, -1.0),
            (0.0, 532.0, 560.0, 28.0),
            (0.0, 0.0, 560.0, f64::NAN),
        ] {
            assert!(content_point(x, y, height, true, top).is_err());
        }
    }
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
            kind,NSPoint::new(0.0,0.0),NSEventModifierFlags::empty(),NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,&text,&text,false,6)
            .ok_or("native key event unavailable")?;
        if pressed {
            view.keyDown(&event);
        } else {
            view.keyUp(&event);
        }
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
