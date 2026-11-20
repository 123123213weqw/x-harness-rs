//! Pure geometry policy, shared by native capture and platform-independent tests.
#![forbid(unsafe_code)]

use serde::Serialize;
use serde_json::{json, Value};
use xharness_computer::{ComputerError, Point, Region};

use crate::observation::WindowBounds;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct DisplayInfo {
    pub(crate) display_id: u32,
    pub(crate) primary: bool,
    pub(crate) bounds: WindowBounds,
    pub(crate) pixels: PixelSize,
    pub(crate) scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(crate) struct PixelSize {
    pub(crate) width: usize,
    pub(crate) height: usize,
}

pub(crate) fn check_display_configuration(
    observed: &[DisplayInfo],
    current: &[DisplayInfo],
) -> Result<(), ComputerError> {
    if observed != current {
        return Err(ComputerError::retryable(
            "display_configuration_changed",
            "display layout or resolution changed; observe again before input",
        ));
    }
    Ok(())
}

pub(crate) fn contains_point(displays: &[DisplayInfo], point: Point) -> bool {
    displays.iter().any(|display| {
        let b = display.bounds;
        point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height
    })
}

#[derive(Debug)]
pub(crate) struct CapturePlan {
    pub(crate) region: Region,
    pub(crate) display_id: u32,
    pub(crate) display_number: usize,
    pub(crate) cropped: bool,
}

impl CapturePlan {
    pub(crate) fn new(
        displays: &[DisplayInfo],
        region: Option<Region>,
    ) -> Result<Self, ComputerError> {
        let cropped = region.is_some();
        let (index, display, region) = if let Some(region) = region {
            // Use exactly the integer rectangle passed to screencapture, not
            // the unrounded caller rectangle, in the returned transformation.
            let region = Region {
                x: region.x.round(),
                y: region.y.round(),
                width: region.width.round(),
                height: region.height.round(),
            };
            if [region.x, region.y, region.width, region.height]
                .iter()
                .any(|value| !value.is_finite() || value.abs() > i32::MAX as f64)
                || region.width < 1.0
                || region.height < 1.0
            {
                return Err(ComputerError::invalid(
                    "screenshot region must round to a finite, nonempty desktop rectangle",
                ));
            }
            let (index, display) = displays
                .iter()
                .enumerate()
                .find(|(_, display)| {
                    let b = display.bounds;
                    region.x >= b.x
                        && region.y >= b.y
                        && region.x + region.width <= b.x + b.width
                        && region.y + region.height <= b.y + b.height
                })
                .ok_or_else(|| {
                    ComputerError::retryable(
                        "screenshot_region_unmapped",
                        "capture one display at a time: region crosses a display edge or an off-screen gap; observe the displays and request a smaller region",
                    )
                })?;
            (index, display, region)
        } else {
            let (index, display) = displays
                .iter()
                .enumerate()
                .find(|(_, display)| display.primary)
                .ok_or_else(|| {
                    ComputerError::retryable("display_query_failed", "no main display")
                })?;
            let b = display.bounds;
            (
                index,
                display,
                Region {
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                },
            )
        };
        Ok(Self {
            region,
            display_id: display.display_id,
            // screencapture -D is a one-based active-display number, NOT a CG ID.
            display_number: index + 1,
            cropped,
        })
    }

    pub(crate) fn metadata(&self, png: &[u8]) -> Result<Value, ComputerError> {
        if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
            return Err(ComputerError::retryable(
                "screenshot_decode_failed",
                "invalid PNG header",
            ));
        }
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        if width == 0 || height == 0 {
            return Err(ComputerError::retryable(
                "screenshot_decode_failed",
                "empty PNG dimensions",
            ));
        }
        Ok(json!({
            "display_id": self.display_id,
            "coordinate_space": "macos_logical_points",
            "region": self.region,
            "pixels": {"width": width, "height": height},
            "pixel_to_desktop": {
                "origin_x": self.region.x, "origin_y": self.region.y,
                "scale_x": self.region.width / f64::from(width),
                "scale_y": self.region.height / f64::from(height)
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn displays() -> Vec<DisplayInfo> {
        vec![
            DisplayInfo {
                display_id: 2,
                primary: true,
                bounds: WindowBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 2560.0,
                    height: 1440.0,
                },
                pixels: PixelSize {
                    width: 2560,
                    height: 1440,
                },
                scale: 1.0,
            },
            DisplayInfo {
                display_id: 1,
                primary: false,
                bounds: WindowBounds {
                    x: -1470.0,
                    y: 0.0,
                    width: 1470.0,
                    height: 956.0,
                },
                pixels: PixelSize {
                    width: 2940,
                    height: 1912,
                },
                scale: 2.0,
            },
        ]
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut data = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        data.extend(width.to_be_bytes());
        data.extend(height.to_be_bytes());
        data
    }
    #[test]
    fn main_capture_is_explicit_and_cg_id_is_not_display_number() {
        let plan = CapturePlan::new(&displays(), None).unwrap();
        assert_eq!(plan.display_id, 2);
        assert_eq!(plan.display_number, 1);
        assert!(!plan.cropped);
        assert_eq!(
            plan.metadata(&png(2560, 1440)).unwrap()["pixel_to_desktop"]["scale_x"],
            1.0
        );
    }
    #[test]
    fn negative_origin_retina_crop_maps_image_pixels_to_logical_points() {
        let region = Region {
            x: -1400.0,
            y: 80.0,
            width: 64.0,
            height: 64.0,
        };
        let plan = CapturePlan::new(&displays(), Some(region)).unwrap();
        assert_eq!(plan.display_id, 1);
        assert_eq!(plan.display_number, 2);
        assert!(plan.cropped);
        let metadata = plan.metadata(&png(128, 128)).unwrap();
        assert_eq!(
            metadata["pixel_to_desktop"],
            json!({"origin_x":-1400.0,"origin_y":80.0,"scale_x":0.5,"scale_y":0.5})
        );
    }
    #[test]
    fn external_crop_uses_measured_png_not_a_global_scale() {
        let region = Region {
            x: 80.0,
            y: 80.0,
            width: 64.0,
            height: 64.0,
        };
        let plan = CapturePlan::new(&displays(), Some(region)).unwrap();
        assert_eq!(
            plan.metadata(&png(64, 64)).unwrap()["pixel_to_desktop"]["scale_x"],
            1.0
        );
    }
    #[test]
    fn ambiguous_cross_display_and_offscreen_crops_fail_closed() {
        for region in [
            Region {
                x: -20.0,
                y: 80.0,
                width: 64.0,
                height: 64.0,
            },
            Region {
                x: -1400.0,
                y: 1000.0,
                width: 64.0,
                height: 64.0,
            },
        ] {
            assert_eq!(
                CapturePlan::new(&displays(), Some(region))
                    .unwrap_err()
                    .code,
                "screenshot_region_unmapped"
            );
        }
    }
    #[test]
    fn crop_rounding_is_explicit_and_never_becomes_zero_or_overflows() {
        let plan = CapturePlan::new(
            &displays(),
            Some(Region {
                x: -1400.2,
                y: 80.6,
                width: 64.1,
                height: 64.0,
            }),
        )
        .unwrap();
        assert_eq!(plan.region.x, -1400.0);
        assert_eq!(plan.region.y, 81.0);
        for width in [0.1, f64::NAN, f64::INFINITY, 1e30] {
            assert!(CapturePlan::new(
                &displays(),
                Some(Region {
                    x: 0.0,
                    y: 0.0,
                    width,
                    height: 64.0
                })
            )
            .is_err());
        }
    }
    #[test]
    fn topology_comparison_detects_scale_origin_and_unplug_changes() {
        let original = displays();
        assert!(check_display_configuration(&original, &original).is_ok());
        let mut changed = original.clone();
        changed[1].scale = 1.0;
        let error = check_display_configuration(&original, &changed).unwrap_err();
        assert_eq!(error.code, "display_configuration_changed");
        assert!(error.retryable);
        let mut changed = original.clone();
        changed[1].bounds.x = 2560.0;
        let error = check_display_configuration(&original, &changed).unwrap_err();
        assert_eq!(error.code, "display_configuration_changed");
        assert!(error.retryable);
        let mut changed = original.clone();
        changed.pop();
        let error = check_display_configuration(&original, &changed).unwrap_err();
        assert_eq!(error.code, "display_configuration_changed");
        assert!(error.retryable);
    }
    #[test]
    fn pointer_checks_use_each_display_not_the_enclosing_union() {
        assert!(contains_point(
            &displays(),
            Point {
                x: -1400.0,
                y: 80.0
            }
        ));
        assert!(contains_point(
            &displays(),
            Point {
                x: 2559.0,
                y: 1439.0
            }
        ));
        assert!(!contains_point(
            &displays(),
            Point {
                x: -1400.0,
                y: 1000.0
            }
        ));
        assert!(!contains_point(&displays(), Point { x: 2560.0, y: 0.0 }));
    }
    #[test]
    fn invalid_png_never_publishes_a_guessed_transform() {
        let plan = CapturePlan::new(&displays(), None).unwrap();
        for data in [vec![], vec![0; 24], png(0, 64), png(64, 0)] {
            assert_eq!(
                plan.metadata(&data).unwrap_err().code,
                "screenshot_decode_failed"
            );
        }
    }
}
