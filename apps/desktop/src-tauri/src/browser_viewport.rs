//! Layout policy only. Native views, snapshots and input share CSS viewport
//! coordinates; physical image pixels and sidebar dimensions are not CSS units.
#![forbid(unsafe_code)]

use super::BrowserBounds;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Presentation {
    pub pane: BrowserBounds,
    pub bounds: BrowserBounds,
    pub zoom: f64,
    pub viewport: Option<Viewport>,
}

impl Presentation {
    pub fn new(pane: BrowserBounds, viewport: Option<Viewport>) -> Result<Self, String> {
        if !pane.valid() {
            return Err("invalid browser pane bounds".into());
        }
        let Some(target) = viewport else {
            return Ok(Self {
                pane,
                bounds: pane,
                zoom: 1.0,
                viewport,
            });
        };
        if !(320..=3840).contains(&target.width) || !(240..=2160).contains(&target.height) {
            return Err("browser viewport dimensions are outside supported limits".into());
        }
        Self::fit(pane, target, 0.0)
    }

    pub fn with_inset(self, inset: f64) -> Result<Self, String> {
        match self.viewport {
            Some(target) => Self::fit(self.pane, target, inset),
            None => Ok(self),
        }
    }

    fn fit(pane: BrowserBounds, target: Viewport, inset: f64) -> Result<Self, String> {
        if !inset.is_finite() || inset < 0.0 || inset >= pane.height {
            return Err("native browser content inset unavailable".into());
        }
        let zoom = (pane.width / f64::from(target.width))
            .min((pane.height - inset) / f64::from(target.height))
            .min(1.0);
        // Do not silently clamp zoom: that would claim a viewport we cannot fit.
        if zoom < 0.1 {
            return Err("browser pane is too small for the selected viewport".into());
        }
        let width = f64::from(target.width) * zoom;
        let height = f64::from(target.height) * zoom + inset;
        Ok(Self {
            pane,
            bounds: BrowserBounds {
                x: pane.x + (pane.width - width) / 2.0,
                y: pane.y + (pane.height - height) / 2.0,
                width,
                height,
            },
            zoom,
            viewport: Some(target),
        })
    }

    pub fn verify(self, width: f64, height: f64) -> Result<(), String> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err("browser viewport geometry unavailable".into());
        }
        if let Some(target) = self.viewport {
            // Native allocation rounds to whole view pixels. At low zoom this
            // can account for several CSS pixels, but not a responsive reflow.
            let tolerance = 2.0 / self.zoom;
            if (width - f64::from(target.width)).abs() > tolerance
                || (height - f64::from(target.height)).abs() > tolerance
            {
                return Err(
                    "browser viewport has not settled; synchronize the pane and observe again"
                        .into(),
                );
            }
        }
        Ok(())
    }
}

/// AppKit/GDK take local native content points. CDP takes CSS points already
/// and must not use this conversion. DPR is deliberately not multiplied here.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
pub(crate) fn content_point(
    x: f64,
    y: f64,
    css: (f64, f64),
    native: (f64, f64),
) -> Result<(f64, f64), String> {
    let (width, height) = css;
    let (native_width, native_height) = native;
    if ![x, y, width, height, native_width, native_height]
        .iter()
        .all(|n| n.is_finite())
        || width <= 0.0
        || height <= 0.0
        || native_width <= 0.0
        || native_height <= 0.0
        || x < 0.0
        || y < 0.0
        || x >= width
        || y >= height
    {
        return Err("point outside browser content viewport".into());
    }
    Ok((x * native_width / width, y * native_height / height))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pane(width: f64, height: f64) -> BrowserBounds {
        BrowserBounds {
            x: 10.0,
            y: 20.0,
            width,
            height,
        }
    }
    #[test]
    fn fit_preserves_desktop_layout_and_letterboxes() {
        let target = Some(Viewport {
            width: 1280,
            height: 720,
        });
        for (w, h) in [(426.0, 900.0), (800.0, 400.0), (1920.0, 1080.0)] {
            let fitted = Presentation::new(pane(w, h), target).unwrap();
            assert!(fitted.bounds.width <= w && fitted.bounds.height <= h);
            assert!((fitted.bounds.width / fitted.zoom - 1280.0).abs() < 0.001);
            assert!((fitted.bounds.height / fitted.zoom - 720.0).abs() < 0.001);
            assert!(fitted.verify(1280.0, 720.0).is_ok());
            assert!(fitted.verify(426.0, 720.0).is_err());
        }
        assert_eq!(
            Presentation::new(pane(426.0, 900.0), None).unwrap().bounds,
            pane(426.0, 900.0)
        );
    }
    #[test]
    fn native_titlebar_inset_is_not_a_css_crop() {
        let fitted = Presentation::new(
            pane(426.0, 200.0),
            Some(Viewport {
                width: 1280,
                height: 720,
            }),
        )
        .unwrap()
        .with_inset(28.0)
        .unwrap();
        assert!((fitted.bounds.height - 200.0).abs() < 0.001);
        assert!(((fitted.bounds.height - 28.0) / fitted.zoom - 720.0).abs() < 0.001);
        assert!(fitted.with_inset(f64::NAN).is_err());
        assert!(fitted.with_inset(200.0).is_err());
    }
    #[test]
    fn input_maps_css_edges_without_dpr_or_letterbox_offset() {
        let css = (1280.0, 720.0);
        let native = (426.0, 239.625);
        assert_eq!(
            content_point(640.0, 360.0, css, native).unwrap(),
            (213.0, 119.8125)
        );
        assert_eq!(content_point(0.0, 0.0, css, native).unwrap(), (0.0, 0.0));
        for (x, y) in [(1280.0, 0.0), (0.0, 720.0), (-1.0, 2.0), (f64::NAN, 0.0)] {
            assert!(content_point(x, y, css, native).is_err());
        }
    }
    #[test]
    fn rejects_unsupported_or_unfittable_sizes() {
        for target in [
            Viewport {
                width: 0,
                height: 720,
            },
            Viewport {
                width: 1280,
                height: 9999,
            },
        ] {
            assert!(Presentation::new(pane(426.0, 900.0), Some(target)).is_err());
        }
        assert!(Presentation::new(
            pane(40.0, 40.0),
            Some(Viewport {
                width: 1280,
                height: 720
            })
        )
        .is_err());
        assert!(Presentation::new(pane(f64::INFINITY, 400.0), None).is_err());
    }
}
