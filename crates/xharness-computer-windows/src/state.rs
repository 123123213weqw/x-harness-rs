//! Observation ownership, not an age-based lease. Native validity is checked
//! separately, immediately before input. Kept portable for offline regressions.
use crate::wire::{Frame, NodeTarget, Request, Surface};
use std::collections::BTreeMap;
use xharness_computer::{ComputerAction, ComputerError};

#[derive(Default)]
pub(crate) struct State {
    pub id: Option<String>,
    pub frame: Option<Frame>,
    pub nodes: BTreeMap<String, NodeTarget>,
    pub surfaces: BTreeMap<String, Surface>,
}

impl State {
    pub fn bind(&self, mut wire: Request) -> Result<Request, ComputerError> {
        let request = &wire.request;
        if matches!(
            request.action,
            ComputerAction::Observe | ComputerAction::Wait
        ) || (request.action == ComputerAction::Window
            && request.operation.as_deref() == Some("list"))
        {
            return Ok(wire);
        }
        if self.id.is_none() || self.frame.is_none() {
            return Err(ComputerError::retryable(
                "stale_frame",
                "no current observation; observe before operating; no input dispatched",
            ));
        }
        if request
            .frame_id
            .as_ref()
            .is_some_and(|id| Some(id) != self.id.as_ref())
        {
            return Err(ComputerError::retryable(
                "stale_frame",
                "frame does not belong to the current observation; observe again; no input dispatched",
            ));
        }
        wire.frame = self.frame.clone();
        if let Some(id) = &request.node_id {
            wire.node = Some(self.nodes.get(id).cloned().ok_or_else(|| {
                ComputerError::retryable(
                    "stale_node",
                    "node does not belong to the current observation; no input dispatched",
                )
            })?);
        }
        if let Some(id) = &request.surface_id {
            wire.surface = Some(self.surfaces.get(id).cloned().ok_or_else(|| {
                ComputerError::retryable(
                    "stale_surface",
                    "window does not belong to the current observation; no input dispatched",
                )
            })?);
        }
        Ok(wire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use xharness_computer::Region;

    fn request(value: Value) -> Request {
        Request {
            schema: 1,
            request: serde_json::from_value(value).unwrap(),
            frame: None,
            node: None,
            surface: None,
        }
    }

    fn observed() -> State {
        let surface = Surface {
            handle: 1,
            pid: 2,
            class: "fixture".into(),
            bounds: Region {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        };
        let node = NodeTarget {
            surface: surface.clone(),
            path: vec![0],
            runtime_id: vec![1, 2, 3],
        };
        State {
            id: Some("current".into()),
            frame: Some(Frame {
                desktop: surface.bounds,
                foreground: Some(surface.clone()),
            }),
            nodes: BTreeMap::from([("node".into(), node)]),
            surfaces: BTreeMap::from([("surface".into(), surface)]),
        }
    }

    #[test]
    fn inputs_require_an_owned_observation() {
        for args in [
            json!({"action":"move","x":1,"y":1}),
            json!({"action":"click","node_id":"node"}),
            json!({"action":"drag","path":[{"x":1,"y":1},{"x":2,"y":2}]}),
            json!({"action":"scroll","delta_y":120}),
            json!({"action":"type","text":"text"}),
            json!({"action":"keypress","keys":["a"]}),
            json!({"action":"window","operation":"focus","surface_id":"surface"}),
        ] {
            let error = State::default().bind(request(args.clone())).unwrap_err();
            assert_eq!(error.code, "stale_frame");
            assert!(observed().bind(request(args.clone())).is_ok());
            let mut foreign = request(args);
            foreign.request.frame_id = Some("previous".into());
            assert_eq!(observed().bind(foreign).unwrap_err().code, "stale_frame");
        }
    }

    #[test]
    fn node_and_surface_references_cannot_cross_observations() {
        for (args, code) in [
            (
                json!({"action":"click","node_id":"previous-node"}),
                "stale_node",
            ),
            (
                json!({"action":"window","operation":"focus","surface_id":"previous-surface"}),
                "stale_surface",
            ),
        ] {
            let state = observed();
            let error = state.bind(request(args)).unwrap_err();
            assert_eq!(error.code, code);
            assert!(error.message.contains("no input dispatched"));
            assert_eq!(state.id.as_deref(), Some("current"));
        }
    }

    #[test]
    fn reference_only_without_native_frame_is_rejected() {
        let mut state = observed();
        state.frame = None;
        assert_eq!(
            state
                .bind(request(
                    json!({"action":"click","frame_id":"current","x":1,"y":1})
                ))
                .unwrap_err()
                .code,
            "stale_frame"
        );
    }

    #[test]
    fn reads_and_wait_do_not_require_an_observation() {
        for args in [
            json!({"action":"observe"}),
            json!({"action":"window","operation":"list"}),
            json!({"action":"wait","duration_ms":1}),
        ] {
            let wire = State::default().bind(request(args)).unwrap();
            assert!(wire.frame.is_none() && wire.node.is_none() && wire.surface.is_none());
        }
    }

    #[test]
    fn binding_uses_current_native_targets_without_consuming_state() {
        let state = observed();
        let wire = state.bind(request(json!({"action":"click","frame_id":"current","node_id":"node","surface_id":"surface"}))).unwrap();
        assert_eq!(wire.frame.unwrap().foreground.unwrap().pid, 2);
        assert_eq!(wire.node.unwrap().runtime_id, vec![1, 2, 3]);
        assert_eq!(wire.surface.unwrap().handle, 1);
        assert_eq!(state.id.as_deref(), Some("current"));
        // Age is intentionally not represented in this policy. Native checks
        // must still run even for an immediately preceding observation.
    }
}
