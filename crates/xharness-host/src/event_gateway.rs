//! Single publication boundary for live Host and Session events.
//!
//! Durable-to-Web reduction remains in `xharness-projection`; this gateway
//! owns carrier framing, channel selection and the shared frame vocabulary.

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

use serde_json::{json, Map, Value};
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
        Self::publish(&self.mux, rpc_id, payload, "mux");
    }

    pub(crate) fn publish_host(&self, rpc_id: RpcId, payload: Value) {
        Self::publish(&self.host, rpc_id, payload, "host");
    }

    fn publish(
        sender: &broadcast::Sender<ServerRequest>,
        rpc_id: RpcId,
        payload: Value,
        channel: &'static str,
    ) {
        let frame = match ServerRequest::frame(rpc_id.clone(), payload) {
            Ok(frame) => frame,
            Err(error) => {
                // Framing failure must be visible to both the owning stream and
                // operations. Never put the malformed payload into diagnostics.
                eprintln!(
                    "XHARNESS_FAILURE {}",
                    json!({"event":"event_frame_failure", "channel":channel, "code":"invalid_event_frame"})
                );
                ServerRequest::new(
                    rpc_id,
                    "stream/error",
                    json!({"type":"stream/error", "error":error}),
                )
            }
        };
        if sender.send(frame).is_err() {
            // A broadcast SendError means exactly zero live subscribers, not a
            // failed durable write. Live frames are intentionally disposable;
            // reconnect reconstructs from authoritative history. Do not retry,
            // log normal disconnected clients as faults, or imply delivery.
        }
    }

    pub(crate) fn session_event(session_id: &str, event: Value, view: Option<Value>) -> Value {
        let mut frame = Map::from_iter([
            ("type".to_owned(), json!("session/event")),
            ("sessionId".to_owned(), json!(session_id)),
            ("event".to_owned(), event),
        ]);
        if let Some(view) = view {
            frame.insert("view".to_owned(), view);
        }
        Value::Object(frame)
    }

    pub(crate) fn history_event(event: Value, view: Option<Value>) -> Value {
        let mut envelope = Map::from_iter([("event".to_owned(), event)]);
        if let Some(view) = view {
            envelope.insert("view".to_owned(), view);
        }
        Value::Object(envelope)
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
    #[test]
    fn malformed_events_produce_a_stream_failure_instead_of_disappearing() {
        let gateway = EventGateway::new(16);
        let mut mux = gateway.subscribe_mux();
        let mut host = gateway.subscribe_host();
        for channel in ["mux", "host"] {
            let payload = json!({"secret":"not a valid event"});
            if channel == "mux" {
                gateway.publish_mux(RpcId::new("bad"), payload);
            } else {
                gateway.publish_host(RpcId::new("bad"), payload);
            }
            let frame = if channel == "mux" {
                mux.try_recv().unwrap()
            } else {
                host.try_recv().unwrap()
            };
            assert_eq!(frame.method, "stream/error");
            assert_eq!(frame.rpc_id.as_str(), "bad");
            assert_eq!(frame.payload["error"]["code"], "internal");
            assert!(!frame.payload.to_string().contains("secret"));
        }
    }

    #[test]
    fn disconnected_live_channel_has_no_false_delivery_or_replay() {
        let gateway = EventGateway::new(16);
        gateway.publish_host(RpcId::new("offline"), json!({"type":"host/session-status"}));
        let mut connected = gateway.subscribe_host();
        assert!(connected.try_recv().is_err());
        gateway.publish_host(RpcId::new("online"), json!({"type":"host/session-status"}));
        assert_eq!(connected.try_recv().unwrap().rpc_id.as_str(), "online");
    }
}
