use super::{api, error, rect, Result};
use crate::wire::MAX_PNG;
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use windows::Win32::{Foundation::LPARAM, Graphics::Gdi::*, UI::HiDpi::*};
use xharness_computer::Region;

pub(super) fn displays() -> Result<Vec<Value>> {
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _: HDC,
        _: *mut windows::Win32::Foundation::RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        // SAFETY: pointer is valid for synchronous monitor enumeration only.
        let entries = unsafe { &mut *(data.0 as *mut Vec<Value>) };
        if entries.len() >= 32 {
            return false.into();
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let mut x = 96;
            let mut y = 96;
            let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) };
            let bounds = rect(info.rcMonitor);
            entries.push(json!({"id":format!("win-monitor:{:x}",monitor.0 as usize),"bounds":bounds,"physical_pixels":{"width":bounds.width,"height":bounds.height},"scale":f64::from(x)/96.0,"dpi":{"x":x,"y":y},"primary":info.dwFlags & 1 != 0}));
        }
        true.into()
    }
    let mut entries = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM((&mut entries as *mut Vec<Value>) as isize),
        )
    };
    if !ok.as_bool() && entries.len() < 32 {
        return Err(error("capture_failed", "cannot enumerate displays"));
    }
    Ok(entries)
}

struct Capture {
    source: HDC,
    target: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Capture {
    fn drop(&mut self) {
        // Restore the selected object BEFORE releasing the bitmap and DC.
        unsafe {
            if !self.previous.0.is_null() {
                SelectObject(self.target, self.previous);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.target.0.is_null() {
                let _ = DeleteDC(self.target);
            }
            if !self.source.0.is_null() {
                ReleaseDC(None, self.source);
            }
        }
    }
}

pub(super) fn screenshot(region: Region) -> Result<Vec<u8>> {
    let width = region.width.round() as i32;
    let height = region.height.round() as i32;
    if width < 1 || height < 1 || i64::from(width) * i64::from(height) > 16_777_216 {
        return Err(error(
            "capture_budget_exceeded",
            "capture exceeds 16 megapixels; specify a smaller region",
        ));
    }
    let mut owned = Capture {
        source: HDC::default(),
        target: HDC::default(),
        bitmap: HBITMAP::default(),
        previous: HGDIOBJ::default(),
    };
    // SAFETY: capture owns all GDI resources and buffers; RAII covers every
    // failure. Dimensions are checked before allocation and native use.
    unsafe {
        owned.source = GetDC(None);
        if owned.source.0.is_null() {
            return Err(error("capture_failed", "cannot acquire desktop DC"));
        }
        owned.target = CreateCompatibleDC(Some(owned.source));
        if owned.target.0.is_null() {
            return Err(error("capture_failed", "cannot create capture DC"));
        }
        owned.bitmap = CreateCompatibleBitmap(owned.source, width, height);
        if owned.bitmap.0.is_null() {
            return Err(error("capture_failed", "cannot create capture bitmap"));
        }
        owned.previous = SelectObject(owned.target, HGDIOBJ(owned.bitmap.0));
        if owned.previous.0.is_null() || owned.previous.0 as isize == -1 {
            owned.previous = HGDIOBJ::default();
            return Err(error("capture_failed", "cannot select capture bitmap"));
        }
        api(BitBlt(
            owned.target,
            0,
            0,
            width,
            height,
            Some(owned.source),
            region.x.round() as i32,
            region.y.round() as i32,
            SRCCOPY | CAPTUREBLT,
        ))?;
        SelectObject(owned.target, owned.previous);
        owned.previous = HGDIOBJ::default();
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        if GetDIBits(
            owned.source,
            owned.bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        ) != height
        {
            return Err(error("capture_failed", "incomplete desktop capture"));
        }
        for pixel in pixels.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let mut output = Vec::new();
        PngEncoder::new(&mut output)
            .write_image(
                &pixels,
                width as u32,
                height as u32,
                ExtendedColorType::Rgba8,
            )
            .map_err(|_| error("capture_failed", "PNG encoding failed"))?;
        if output.len() > MAX_PNG {
            return Err(error(
                "capture_budget_exceeded",
                "PNG exceeds attachment transport budget",
            ));
        }
        Ok(output)
    }
}
