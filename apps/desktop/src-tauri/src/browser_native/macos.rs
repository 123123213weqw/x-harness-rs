use block2::RcBlock;
use objc2::{msg_send, sel, AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage,
    NSTrackingAreaOptions, NSWindowStyleMask,
};
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSProcessInfo, NSRect, NSSize, NSString};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
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

fn top_content_inset(view: &WKWebView) -> Result<f64, String> {
    let window = view.window().ok_or("WKWebView window missing")?;
    Ok(
        if window
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
        },
    )
}

pub fn content_inset(handle: PlatformWebview) -> Result<f64, String> {
    top_content_inset(view(&handle)?)
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
fn pointer(
    handle: &PlatformWebview,
    x: f64,
    y: f64,
    viewport: (f64, f64),
    phase: u8,
) -> Result<(), String> {
    (|| {
        let view = view(handle)?;
        let window = view.window().ok_or("WKWebView window missing")?;
        // Tauri's focus request is queued. Inspect the native presentation and
        // acknowledge the owned responder in this exact dispatch closure; never
        // activate the app, show a hidden view or route into another responder.
        let hidden = view.isHiddenOrHasHiddenAncestor();
        let focused = !hidden && window.makeFirstResponder(Some(view));
        if hidden || !focused {
            return Err("owned native browser is hidden or cannot accept focus".into());
        }
        // Match WebKit's automatic top-obscured-inset calculation using public
        // AppKit geometry. A full-size, opaque-titlebar child WebView can retain
        // a titlebar inset even below the titlebar: CSS clientY starts AFTER it.
        // convertPoint alone maps view coordinates, not this content origin.
        // Do not hardcode a titlebar height, apply a DPR multiplier, or use SPI.
        // WebKit/UIProcess/mac/PageClientImplMac.mm::computeAutomaticTopObscuredInset
        let top = top_content_inset(view)?;
        let flipped = view.isFlipped();
        let bounds = view.bounds();
        let height = bounds.size.height;
        let (x, y) = crate::browser::viewport::content_point(
            x,
            y,
            viewport,
            (bounds.size.width, height - top),
        )?;
        if x >= bounds.size.width {
            return Err("native browser point is outside its content viewport".into());
        }
        let local = content_point(x, y, height, flipped, top)?;
        let point = view.convertPoint_toView(local, None);
        let kind = match phase {
            0 => NSEventType::LeftMouseDown,
            1 => NSEventType::LeftMouseUp,
            _ => NSEventType::MouseMoved,
        };
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,point,NSEventModifierFlags::empty(),NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,0,1,1.0)
            .ok_or("native mouse event unavailable")?;
        // Dispatch to the owned browser responder, not the outer application
        // window's hit-testing/current-responder routing. This is still an
        // NSEvent/WebKit native input path, never DOM dispatchEvent or OS input.
        match phase {
            0 => view.mouseDown(&event),
            1 => view.mouseUp(&event),
            _ => {
                // WebKit intentionally routes hover via an AppKit tracking-area
                // owner, not WKWebView.mouseMoved (the latter is inherited/no-op).
                // Follow the public trackingAreas/owner contract. No class-name
                // dependency, private selector, window/app routing or OS input.
                view.updateTrackingAreas();
                let mut delivered = false;
                for area in view.trackingAreas().iter() {
                    if !area.options().contains(NSTrackingAreaOptions::MouseMoved) {
                        continue;
                    }
                    let Some(owner) = area.owner() else {
                        continue;
                    };
                    // SAFETY: NSObject's fixed public selector query; no model
                    // values select a target or message. Owner is retained here.
                    let responds: bool =
                        unsafe { msg_send![&*owner, respondsToSelector:sel!(mouseMoved:)] };
                    if responds {
                        // SAFETY: AppKit documents the tracking owner's standard
                        // void mouseMoved:(NSEvent*) callback. Both objects live
                        // on this UI thread throughout the synchronous message.
                        let _: () = unsafe { msg_send![&*owner, mouseMoved:&*event] };
                        delivered = true;
                        break;
                    }
                }
                if !delivered {
                    return Err("native browser hover tracking unavailable".into());
                }
            }
        }
        Ok(())
    })()
}

pub fn input(
    handle: PlatformWebview,
    request: super::InputRequest,
    viewport: (f64, f64),
    reply: Sender<Result<(), String>>,
) {
    use super::InputRequest;
    match request {
        InputRequest::Click { x, y, .. } => {
            let result = pointer(&handle, x, y, viewport, 0)
                .and_then(|_| pointer(&handle, x, y, viewport, 1));
            let _ = reply.send(result);
        }
        InputRequest::Move { x, y, .. } => {
            let _ = reply.send(pointer(&handle, x, y, viewport, 2));
        }
        InputRequest::Key { key, modifiers, .. } => {
            let result = (|| {
                let view = view(&handle)?;
                let window = view.window().ok_or("WK window unavailable")?;
                if view.isHiddenOrHasHiddenAncestor() || !window.makeFirstResponder(Some(view)) {
                    return Err("owned browser cannot accept focus".into());
                }
                let spec = super::key_spec(&key)?;
                let mask = modifiers
                    .iter()
                    .fold(NSEventModifierFlags::empty(), |mask, m| {
                        mask | match m.as_str() {
                            "Shift" => NSEventModifierFlags::Shift,
                            "Control" => NSEventModifierFlags::Control,
                            "Alt" => NSEventModifierFlags::Option,
                            "Meta" => NSEventModifierFlags::Command,
                            _ => NSEventModifierFlags::empty(),
                        }
                    });
                let text = NSString::from_str(&if mask.contains(NSEventModifierFlags::Shift)
                    && key.len() == 1
                {
                    spec.text.to_uppercase()
                } else {
                    spec.text.clone()
                });
                let unmodified = NSString::from_str(&spec.text);
                for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
                    let event=NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(kind,NSPoint::new(0.0,0.0),mask,NSProcessInfo::processInfo().systemUptime(),window.windowNumber(),None,&text,&unmodified,false,spec.mac).ok_or("native key event unavailable")?;
                    if kind == NSEventType::KeyDown {
                        view.keyDown(&event);
                    } else {
                        view.keyUp(&event);
                    }
                }
                Ok(())
            })();
            let _ = reply.send(result);
        }
    }
}
pub fn snapshot(handle: PlatformWebview, reply: Sender<Result<Vec<u8>, String>>) {
    let Ok(view) = view(&handle) else {
        let _ = reply.send(Err("WKWebView unavailable".into()));
        return;
    };
    let bounds = view.bounds();
    let top = match top_content_inset(view) {
        Ok(top) => top,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let height = bounds.size.height - top;
    if !height.is_finite() || height <= 0.0 {
        let _ = reply.send(Err("native snapshot content geometry unavailable".into()));
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err("native snapshot is not on UI thread".into()));
        return;
    };
    // SAFETY: snapshot configuration is initialized on its required main thread.
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    // WK software snapshots start at CSS content origin even when native input
    // starts below an obscured inset. Crop the extra bottom extent, NOT the top:
    // CI pixels put the CSS marker at y=120 in a 560px image/532px CSS viewport.
    // SAFETY: finite public view-contained CGRect, main-thread native object.
    unsafe {
        configuration.setRect(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(bounds.size.width, height),
        ));
    }
    let reply = std::sync::Mutex::new(Some(reply));
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(reply) = reply.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        if reply.is_closed() {
            return;
        }
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
        let _ = reply.send(result);
    });
    // SAFETY: block has exactly WebKit's NSImage/NSError completion signature;
    // WebKit copies it until completion. No borrowed Rust values are captured.
    unsafe {
        view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block);
    }
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
