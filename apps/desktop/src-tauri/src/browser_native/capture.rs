//! Output resolution policy only; never changes a view, page zoom or login state.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapturePlan {
    pub width: u32,
    pub height: u32,
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub css: (f64, f64),
}

impl CapturePlan {
    pub fn new(css: (f64, f64), native: (u32, u32)) -> Result<Self, String> {
        let (w, h) = css;
        if ![w, h]
            .iter()
            .all(|n| n.is_finite() && *n > 0.0 && *n <= 8192.0)
            || native.0 == 0
            || native.1 == 0
        {
            return Err("invalid browser capture geometry".into());
        }
        // Preserve already useful native density, restore at least one image
        // pixel per CSS pixel when possible, and retain the existing 1600 edge
        // budget. This is a renderer request, never bitmap interpolation.
        let density = (f64::from(native.0) / w).max(1.0).min(1600.0 / w.max(h));
        Ok(Self {
            css,
            width: (w * density).round().clamp(1.0, 1600.0) as u32,
            height: (h * density).round().clamp(1.0, 1600.0) as u32,
        })
    }
}

/// CDP's output also includes the native raster scale and page zoom. Both are
/// read from WebView2's controller, never from page-overridable JS properties.
#[cfg(any(windows, test))]
pub(super) fn chromium_parameters(
    plan: CapturePlan,
    metrics: &serde_json::Value,
    density: f64,
) -> Result<serde_json::Value, String> {
    let visual = &metrics["cssVisualViewport"];
    let x = visual["pageX"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100_000_000.0)
        .ok_or("invalid native capture scroll x")?;
    let y = visual["pageY"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100_000_000.0)
        .ok_or("invalid native capture scroll y")?;
    let pinch = visual["scale"]
        .as_f64()
        .filter(|n| n.is_finite() && (*n - 1.0).abs() < 0.01)
        .ok_or("pinch-scaled browser geometry requires a fresh unambiguous viewport")?;
    if !density.is_finite() || !(0.1..=16.0).contains(&density) {
        return Err("invalid native capture raster scale".into());
    }
    let scale = f64::from(plan.width) / (plan.css.0 * density);
    if !scale.is_finite() || !(0.01..=16.0).contains(&scale) {
        return Err("native capture scale exceeds budget".into());
    }
    let _ = pinch;
    Ok(
        serde_json::json!({"format":"png","captureBeyondViewport":false,"fromSurface":true,"clip":{"x":x,"y":y,"width":plan.css.0,"height":plan.css.1,"scale":scale}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_size_does_not_limit_evidence_resolution() {
        for native in [(320, 180), (426, 240), (852, 480)] {
            assert_eq!(
                CapturePlan::new((1280.0, 720.0), native).unwrap(),
                CapturePlan {
                    width: 1280,
                    height: 720,
                    css: (1280.0, 720.0)
                }
            );
        }
        assert_eq!(
            CapturePlan::new((1280.0, 721.0), (426, 240)).unwrap(),
            CapturePlan {
                width: 1280,
                height: 721,
                css: (1280.0, 721.0)
            }
        );
    }

    #[test]
    fn retains_existing_detail_within_the_shared_edge_budget() {
        // Native allocation height may include an obscured titlebar inset;
        // width is the stable density reference, not that extra vertical extent.
        assert_eq!(
            CapturePlan::new((1280.0, 720.0), (1280, 776))
                .unwrap()
                .width,
            1280
        );
        assert_eq!(
            CapturePlan::new((1280.0, 720.0), (1600, 900)).unwrap(),
            CapturePlan {
                width: 1600,
                height: 900,
                css: (1280.0, 720.0)
            }
        );
        assert_eq!(
            CapturePlan::new((1280.0, 720.0), (2560, 1440)).unwrap(),
            CapturePlan {
                width: 1600,
                height: 900,
                css: (1280.0, 720.0)
            }
        );
        assert_eq!(
            CapturePlan::new((720.0, 1280.0), (1440, 2560)).unwrap(),
            CapturePlan {
                width: 900,
                height: 1600,
                css: (720.0, 1280.0)
            }
        );
    }

    #[test]
    fn invalid_or_excessive_geometry_fails_before_native_allocation() {
        for css in [
            (f64::NAN, 720.0),
            (1280.0, f64::INFINITY),
            (0.0, 720.0),
            (-1.0, 720.0),
            (9000.0, 720.0),
        ] {
            assert!(CapturePlan::new(css, (426, 240)).is_err());
        }
        assert!(CapturePlan::new((1280.0, 720.0), (0, 240)).is_err());
    }

    #[test]
    fn chromium_capture_accounts_for_trusted_page_zoom_dpi_and_scroll() {
        for density in [0.25, 0.5, 1.0, 1.5, 2.0] {
            let plan = CapturePlan::new((1280.0, 720.0), (426, 240)).unwrap();
            let args = chromium_parameters(
                plan,
                &serde_json::json!({"cssVisualViewport":{"pageX":17,"pageY":900,"scale":1}}),
                density,
            )
            .unwrap();
            assert!(
                (args["clip"]["scale"].as_f64().unwrap() * 1280.0 * density - 1280.0).abs() < 0.001
            );
            assert_eq!(args["clip"]["y"].as_f64(), Some(900.0));
            assert_eq!(args["clip"]["width"], 1280.0);
            assert_eq!(args["fromSurface"], true);
        }
        let plan = CapturePlan::new((1280.0, 720.0), (426, 240)).unwrap();
        assert!(chromium_parameters(
            plan,
            &serde_json::json!({"cssVisualViewport":{"pageX":0,"pageY":0,"scale":2}}),
            1.0
        )
        .is_err());
        assert!(chromium_parameters(plan, &serde_json::json!({}), 1.0).is_err());
    }
}
