use serde::{Deserialize, Serialize};
use serde_json::Value;
use xharness_computer::{ComputerAction, ComputerError, ComputerRequest};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WindowInfo {
    pub(crate) surface_id: String,
    pub(crate) node_id: String,
    pub(crate) app: String,
    pub(crate) pid: i64,
    pub(crate) window_index: u32,
    pub(crate) title: String,
    pub(crate) frontmost: bool,
    pub(crate) focused: bool,
    pub(crate) minimized: bool,
    pub(crate) bounds: WindowBounds,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(crate) struct WindowBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AxNode {
    pub(crate) node_id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) surface_id: String,
    #[serde(skip_serializing)]
    pub(crate) pid: i64,
    #[serde(skip_serializing)]
    pub(crate) root_kind: String,
    #[serde(skip_serializing)]
    pub(crate) root_index: u32,
    #[serde(skip_serializing)]
    pub(crate) path: Vec<usize>,
    pub(crate) role: String,
    pub(crate) subrole: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) identifier: Option<String>,
    pub(crate) value: Option<Value>,
    pub(crate) enabled: bool,
    pub(crate) focused: bool,
    pub(crate) selected: bool,
    pub(crate) visible: bool,
    pub(crate) bounds: Option<WindowBounds>,
    pub(crate) actions: Vec<String>,
    pub(crate) depth: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AccessibilitySnapshot {
    pub(crate) windows: Vec<WindowInfo>,
    pub(crate) nodes: Vec<AxNode>,
    pub(crate) truncated: bool,
    pub(crate) visited: usize,
    pub(crate) max_nodes: usize,
    pub(crate) max_depth: usize,
    #[serde(default)]
    pub(crate) truncation_reasons: Vec<String>,
    #[serde(default)]
    pub(crate) elapsed_ms: u64,
}

impl AccessibilitySnapshot {
    pub(crate) fn empty(max_nodes: usize, max_depth: usize) -> Self {
        Self {
            windows: Vec::new(),
            nodes: Vec::new(),
            truncated: false,
            visited: 0,
            max_nodes,
            max_depth,
            truncation_reasons: Vec::new(),
            elapsed_ms: 0,
        }
    }
}

/// A window list never traverses controls. Disabling AX on observe still avoids
/// the subprocess entirely; window/list requests still enumerate windows.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ObservationPlan {
    pub(crate) needs_snapshot: bool,
    pub(crate) include_nodes: bool,
    pub(crate) max_nodes: usize,
    pub(crate) max_depth: usize,
}

impl ObservationPlan {
    pub(crate) fn for_request(request: &ComputerRequest) -> Self {
        let window_list = request.action == ComputerAction::Window
            && request.operation.as_deref() == Some("list");
        let (max_nodes, max_depth) = accessibility_budget(request.detail.as_deref());
        Self {
            needs_snapshot: window_list || request.include_accessibility,
            include_nodes: !window_list && request.include_accessibility,
            max_nodes,
            max_depth,
        }
    }

    pub(crate) fn options(self) -> Value {
        serde_json::json!({
            "max_nodes": self.max_nodes,
            "max_depth": self.max_depth,
            "include_nodes": self.include_nodes,
            // Leave headroom under the independent 12s subprocess watchdog.
            "time_budget_ms": 8_000
        })
    }
}

pub(crate) fn accessibility_budget(detail: Option<&str>) -> (usize, usize) {
    match detail {
        Some("low") => (80, 4),
        Some("semantic") => (300, 10),
        Some("high") => (500, 12),
        _ => (220, 8),
    }
}

pub(crate) fn recover_snapshot(
    result: Result<AccessibilitySnapshot, ComputerError>,
    plan: ObservationPlan,
) -> Result<(AccessibilitySnapshot, Option<ComputerError>), ComputerError> {
    match result {
        Ok(snapshot) => Ok((snapshot, None)),
        Err(error) if error.code == "cancelled" => Err(error),
        Err(error)
            if matches!(
                error.code.as_str(),
                "osascript_timeout"
                    | "osascript_spawn_failed"
                    | "accessibility_decode_failed"
                    | "accessibility_action_failed"
                    | "unavailable"
            ) =>
        {
            // A timed out/nonresponsive application must not prevent visual
            // observation. The explicit error is returned to the model/UI.
            let mut snapshot = AccessibilitySnapshot::empty(plan.max_nodes, plan.max_depth);
            snapshot.truncated = true;
            snapshot.truncation_reasons.push(error.code.clone());
            Ok((snapshot, Some(error)))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan(input: Value) -> ObservationPlan {
        ObservationPlan::for_request(&serde_json::from_value(input).unwrap())
    }

    #[test]
    fn window_list_never_requests_controls_even_with_default_ax() {
        for include in [None, Some(false), Some(true)] {
            let mut request = json!({"action":"window", "operation":"list"});
            if let Some(include) = include {
                request["include_accessibility"] = json!(include);
            }
            let plan = plan(request);
            assert!(plan.needs_snapshot);
            assert!(!plan.include_nodes);
            assert_eq!(plan.options()["include_nodes"], false);
        }
    }

    #[test]
    fn screenshot_only_does_not_start_ax_and_normal_observe_keeps_nodes() {
        let screenshot = plan(
            json!({"action":"observe", "include_accessibility":false, "include_screenshot":true}),
        );
        assert!(!screenshot.needs_snapshot);
        assert!(!screenshot.include_nodes);
        let observe = plan(json!({"action":"observe"}));
        assert!(observe.needs_snapshot);
        assert!(observe.include_nodes);
        assert_eq!(observe.options()["time_budget_ms"], 8_000);
    }

    #[test]
    fn detail_budgets_remain_compatible() {
        assert_eq!(accessibility_budget(Some("low")), (80, 4));
        assert_eq!(accessibility_budget(None), (220, 8));
        assert_eq!(accessibility_budget(Some("semantic")), (300, 10));
        assert_eq!(accessibility_budget(Some("high")), (500, 12));
    }

    #[test]
    fn ax_failures_are_explicit_degraded_observations_not_cancellation() {
        let plan = plan(json!({"action":"observe"}));
        for code in [
            "osascript_timeout",
            "osascript_spawn_failed",
            "accessibility_decode_failed",
            "accessibility_action_failed",
            "unavailable",
        ] {
            let original = ComputerError::retryable(code, "fixture");
            let (snapshot, error) = recover_snapshot(Err(original.clone()), plan).unwrap();
            assert_eq!(error, Some(original));
            assert!(snapshot.truncated);
            assert!(snapshot.nodes.is_empty());
            assert!(snapshot.windows.is_empty());
            assert_eq!(snapshot.truncation_reasons, vec![code]);
        }
        let invalid = ComputerError::invalid("fixture");
        assert_eq!(
            recover_snapshot(Err(invalid.clone()), plan).unwrap_err(),
            invalid
        );
        let original = ComputerError::retryable("cancelled", "cancelled");
        assert_eq!(
            recover_snapshot(Err(original.clone()), plan).unwrap_err(),
            original
        );
    }

    #[test]
    fn soft_budget_preserves_completed_targets_and_old_snapshots_decode() {
        let plan = plan(json!({"action":"observe"}));
        let legacy = json!({"windows":[],"nodes":[],"truncated":false,"visited":0,"max_nodes":80,"max_depth":4});
        let snapshot: AccessibilitySnapshot = serde_json::from_value(legacy.clone()).unwrap();
        assert!(snapshot.truncation_reasons.is_empty());
        assert_eq!(snapshot.elapsed_ms, 0);
        assert_eq!(
            (snapshot.visited, snapshot.max_nodes, snapshot.max_depth),
            (0, 80, 4)
        );
        let mut partial = legacy;
        partial["truncated"] = json!(true);
        partial["truncation_reasons"] = json!(["time_budget"]);
        partial["elapsed_ms"] = json!(8_010);
        partial["nodes"] = json!([{
            "node_id":"ax:42:w1:0", "parent_id":"window:42:1", "surface_id":"mac:42:1",
            "pid":42, "root_kind":"window", "root_index":1, "path":[0],
            "role":"AXButton", "subrole":null, "label":"Save", "description":null,
            "identifier":null, "value":null, "enabled":true, "focused":false,
            "selected":false, "visible":true, "bounds":null, "actions":["AXPress"], "depth":1
        }]);
        let snapshot = serde_json::from_value(partial).unwrap();
        let (snapshot, error) = recover_snapshot(Ok(snapshot), plan).unwrap();
        assert!(error.is_none());
        assert_eq!(snapshot.nodes.len(), 1);
        assert_eq!(snapshot.nodes[0].path, vec![0]);
        assert_eq!(snapshot.nodes[0].pid, 42);
        assert_eq!(snapshot.nodes[0].root_kind, "window");
        assert_eq!(snapshot.nodes[0].root_index, 1);
        assert_eq!(snapshot.truncation_reasons, vec!["time_budget"]);
        let projected = serde_json::to_value(&snapshot.nodes[0]).unwrap();
        assert!(projected.get("path").is_none());
        assert!(projected.get("pid").is_none());
    }
}
