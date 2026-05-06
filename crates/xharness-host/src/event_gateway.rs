//! Single publication boundary for live Host and Session events.
//!
//! Durable-to-Web reduction remains in `xharness-projection`; this gateway
//! owns carrier framing, channel selection and the shared frame vocabulary.

use serde_json::{json, Value};
use tokio::sync::broadcast;
use xharness_api::{RpcId, ServerRequest};
use xharness_projection::{project_session_event_view, project_web_event_view};
use xharness_session::{LoggedEvent, Session};

#[derive(Clone)]
pub(crate) struct EventGateway {
    mux: broadcast::Sender<ServerRequest>,
    host: broadcast::Sender<ServerRequest>,
}

impl EventGateway {
    pub(crate) fn new(capacity: usize) -> Self {
        let (mux, _) = broadcast::channel(capacity);
        let (host, _) = broadcast::channel(capacity);
        Self { mux, host }
    }

    pub(crate) fn subscribe_mux(&self) -> broadcast::Receiver<ServerRequest> {
        self.mux.subscribe()
    }

    pub(crate) fn subscribe_host(&self) -> broadcast::Receiver<ServerRequest> {
        self.host.subscribe()
    }

    pub(crate) fn publish_mux(&self, rpc_id: RpcId, payload: Value) {
        if let Ok(frame) = ServerRequest::frame(rpc_id, payload) {
            let _ = self.mux.send(frame);
        }
    }

    pub(crate) fn publish_host(&self, rpc_id: RpcId, payload: Value) {
        if let Ok(frame) = ServerRequest::frame(rpc_id, payload) {
            let _ = self.host.send(frame);
        }
    }

    pub(crate) fn session_event(session_id: &str, event: Value, view: Option<Value>) -> Value {
        let mut frame = json!({
            "type": "session/event",
            "sessionId": session_id,
            "event": event,
        });
        if let Some(view) = view {
            frame
                .as_object_mut()
                .expect("session event frame is an object")
                .insert("view".to_owned(), view);
        }
        frame
    }

    pub(crate) fn history_event(event: Value, view: Option<Value>) -> Value {
        let mut envelope = json!({"event": event});
        if let Some(view) = view {
            envelope
                .as_object_mut()
                .expect("history event envelope is an object")
                .insert("view".to_owned(), view);
        }
        envelope
    }

    pub(crate) fn durable_view(session: &Session, event: &LoggedEvent) -> Option<Value> {
        project_session_event_view(session, event)
    }

    pub(crate) fn live_view(event: &Value, history: &[Value]) -> Option<Value> {
        project_web_event_view(event, history)
    }

    pub(crate) fn projection(session_id: &str, key: &str, value: Value, seq: u64) -> Value {
        json!({
            "type": "session/projection",
            "sessionId": session_id,
            "key": key,
            "value": value,
            "seq": seq,
        })
    }

    pub(crate) fn queue(session_id: &str, items: Vec<Value>) -> Value {
        json!({
            "type": "session/queue",
            "sessionId": session_id,
            "items": items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_frame_vocabulary_is_shared_and_view_is_optional() {
        let without = EventGateway::session_event("s", json!({"seq": 1}), None);
        assert_eq!(without["type"], "session/event");
        assert!(without.get("view").is_none());
        let with =
            EventGateway::session_event("s", json!({"seq": 2}), Some(json!({"kind": "text"})));
        assert_eq!(with["view"]["kind"], "text");
        assert_eq!(
            EventGateway::history_event(json!({"seq": 2}), Some(json!({"kind": "text"})))["view"]
                ["kind"],
            "text"
        );
        assert_eq!(
            EventGateway::projection("s", "goal", Value::Null, 2)["seq"],
            2
        );
    }

    #[test]
    fn channel_selection_does_not_cross_publish() {
        let gateway = EventGateway::new(16);
        let mut mux = gateway.subscribe_mux();
        let mut host = gateway.subscribe_host();
        gateway.publish_mux(RpcId::new("m"), json!({"type": "mux"}));
        gateway.publish_host(RpcId::new("h"), json!({"type": "host"}));
        assert_eq!(mux.try_recv().unwrap().rpc_id.as_str(), "m");
        assert!(mux.try_recv().is_err());
        assert_eq!(host.try_recv().unwrap().rpc_id.as_str(), "h");
        assert!(host.try_recv().is_err());
    }
}
