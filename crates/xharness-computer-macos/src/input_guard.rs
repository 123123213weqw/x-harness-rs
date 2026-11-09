//! Pure input admission rules shared by native dispatch and Linux tests.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use xharness_computer::{ComputerAction, ComputerError};

use crate::observation::WindowBounds;

pub(crate) fn frame_bound(action: ComputerAction) -> bool {
    matches!(
        action,
        ComputerAction::Move
            | ComputerAction::Click
            | ComputerAction::Drag
            | ComputerAction::Scroll
            | ComputerAction::Type
            | ComputerAction::Keypress
    )
}

pub(crate) fn check_frame_id(
    expected: Option<&str>,
    supplied: Option<&str>,
) -> Result<(), ComputerError> {
    if supplied.is_none() || expected != supplied {
        return Err(ComputerError::retryable(
            "stale_frame",
            "the referenced frame is stale; call computer observe again",
        ));
    }
    Ok(())
}

/// Exact kernel epoch seconds/microseconds; never a nullable or rounded date.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessStart {
    seconds: u64,
    microseconds: u64,
}

impl ProcessStart {
    pub(crate) fn new(seconds: u64, microseconds: u64) -> Result<Self, ComputerError> {
        if seconds == 0 || microseconds >= 1_000_000 {
            return Err(ComputerError::retryable(
                "input_context_unavailable",
                "invalid kernel process start identity; observe again",
            ));
        }
        Ok(Self {
            seconds,
            microseconds,
        })
    }
}

#[derive(Deserialize)]
struct ForegroundProcess {
    pid: i64,
}

pub(crate) fn foreground_pid(raw: &str) -> Result<i32, ComputerError> {
    let value: ForegroundProcess = serde_json::from_str(raw).map_err(|_| {
        ComputerError::retryable(
            "input_context_unavailable",
            "cannot read foreground application PID",
        )
    })?;
    let pid = i32::try_from(value.pid).map_err(|_| {
        ComputerError::retryable(
            "input_context_unavailable",
            "foreground PID is outside the native range",
        )
    })?;
    if pid <= 0 {
        return Err(ComputerError::retryable(
            "input_context_unavailable",
            "invalid foreground application PID",
        ));
    }
    Ok(pid)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InputContext {
    pub(crate) pid: i64,
    pub(crate) process_start: ProcessStart,
    pub(crate) window_id: Option<u32>,
    pub(crate) bounds: Option<WindowBounds>,
}

pub(crate) fn check_input_context(
    expected: Option<&InputContext>,
    current: &InputContext,
) -> Result<(), ComputerError> {
    if expected != Some(current) {
        return Err(ComputerError::retryable(
            "stale_frame",
            "foreground application or window changed; observe again",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct NativeWindow {
    pub(crate) id: u32,
    pub(crate) pid: i64,
    pub(crate) layer: i64,
    pub(crate) onscreen: bool,
    pub(crate) bounds: WindowBounds,
}

pub(crate) fn same_bounds(a: WindowBounds, b: WindowBounds) -> bool {
    [
        (a.x, b.x),
        (a.y, b.y),
        (a.width, b.width),
        (a.height, b.height),
    ]
    .iter()
    .all(|(a, b)| a.is_finite() && b.is_finite() && (a - b).abs() < 0.5)
}

/// Never guess between overlapping identical windows, even in the same process.
pub(crate) fn window_id(windows: &[NativeWindow], pid: i64, bounds: WindowBounds) -> Option<u32> {
    let mut matches = windows
        .iter()
        .filter(|window| window.pid == pid && same_bounds(window.bounds, bounds));
    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_physical_input_requires_a_frame_including_unpositioned_input() {
        for action in [
            ComputerAction::Move,
            ComputerAction::Click,
            ComputerAction::Drag,
            ComputerAction::Scroll,
            ComputerAction::Type,
            ComputerAction::Keypress,
        ] {
            assert!(frame_bound(action));
        }
        for action in [
            ComputerAction::Observe,
            ComputerAction::Window,
            ComputerAction::Wait,
        ] {
            assert!(!frame_bound(action));
        }
    }
    #[test]
    fn missing_unknown_and_old_frames_fail_before_native_dispatch() {
        for (expected, supplied) in [
            (None, None),
            (None, Some("invented")),
            (Some("new"), None),
            (Some("new"), Some("old")),
        ] {
            assert_eq!(
                check_frame_id(expected, supplied).unwrap_err().code,
                "stale_frame"
            );
        }
        assert!(check_frame_id(Some("new"), Some("new")).is_ok());
    }
    #[test]
    fn changed_application_launch_window_or_geometry_rejects_raw_input() {
        let current = InputContext {
            pid: 7,
            process_start: ProcessStart::new(123, 456_789).unwrap(),
            window_id: Some(42),
            bounds: Some(WindowBounds {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 500.0,
            }),
        };
        assert!(check_input_context(Some(&current), &current).is_ok());
        assert!(check_input_context(None, &current).is_err());
        for changed in [
            InputContext {
                pid: 8,
                ..current.clone()
            },
            InputContext {
                process_start: ProcessStart::new(123, 456_790).unwrap(),
                ..current.clone()
            },
            InputContext {
                window_id: Some(43),
                ..current.clone()
            },
            InputContext {
                bounds: None,
                ..current.clone()
            },
            InputContext {
                bounds: Some(WindowBounds {
                    x: 1.0,
                    ..current.bounds.unwrap()
                }),
                ..current.clone()
            },
        ] {
            assert_eq!(
                check_input_context(Some(&current), &changed)
                    .unwrap_err()
                    .code,
                "stale_frame"
            );
        }
    }

    #[test]
    fn pid_is_independent_of_nullable_launchservices_metadata() {
        for raw in [r#"{"pid":42}"#, r#"{"pid":42,"launched_at":null}"#] {
            assert_eq!(foreground_pid(raw).unwrap(), 42);
        }
        for raw in [
            "{}",
            r#"{"pid":null}"#,
            r#"{"pid":-1}"#,
            r#"{"pid":0}"#,
            r#"{"pid":1.5}"#,
            r#"{"pid":2147483648}"#,
            r#"{"pid":"42"}"#,
        ] {
            assert_eq!(
                foreground_pid(raw).unwrap_err().code,
                "input_context_unavailable"
            );
        }
    }

    #[test]
    fn process_start_never_uses_a_zero_or_invalid_fallback() {
        assert!(ProcessStart::new(123, 0).is_ok());
        assert!(ProcessStart::new(0, 0).is_err());
        assert!(ProcessStart::new(123, 1_000_000).is_err());
    }

    #[test]
    fn window_binding_uses_unique_os_id_not_window_index_title_or_geometry_alone() {
        let rect = WindowBounds {
            x: -900.0,
            y: 10.0,
            width: 640.0,
            height: 500.0,
        };
        let w = NativeWindow {
            id: 42,
            pid: 7,
            layer: 0,
            onscreen: true,
            bounds: rect,
        };
        assert_eq!(window_id(std::slice::from_ref(&w), 7, rect), Some(42));
        assert_eq!(window_id(std::slice::from_ref(&w), 8, rect), None);
        assert_eq!(window_id(&[], 7, rect), None);
        let replacement = NativeWindow {
            id: 43,
            ..w.clone()
        };
        assert_ne!(
            window_id(std::slice::from_ref(&replacement), 7, rect),
            Some(42)
        );
        assert_eq!(window_id(&[w, replacement], 7, rect), None);
        assert!(!same_bounds(
            rect,
            WindowBounds {
                x: f64::NAN,
                ..rect
            }
        ));
        assert!(!same_bounds(
            rect,
            WindowBounds {
                x: rect.x + 1.0,
                ..rect
            }
        ));
    }
}
