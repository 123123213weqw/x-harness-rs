//! Forward, unfurled durable event cuts. Not a bounded live-cache history tail.
use crate::ServerRequest;
use serde::{Deserialize, Serialize};
pub const MAX_SCOPED_EVENTS: usize = 128;
pub const MAX_SCOPED_EVENT_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedEventPage {
    pub start_seq: u64,
    pub next_seq: u64,
    pub head_seq: u64,
    pub events: Vec<ServerRequest>,
}
impl ScopedEventPage {
    pub fn has_more(&self) -> bool {
        self.next_seq < self.head_seq
    }
    pub fn is_scoped(&self, session: &str, after: Option<u64>) -> bool {
        self.events.len() <= MAX_SCOPED_EVENTS
            && self.next_seq <= self.head_seq
            && self.start_seq.checked_add(self.events.len() as u64) == Some(self.next_seq)
            && after.map_or(
                self.start_seq == self.head_seq && self.events.is_empty(),
                |a| a == self.start_seq,
            )
            && (!self.has_more() || !self.events.is_empty())
            && self.events.iter().enumerate().all(|(i, e)| {
                e.method == "session/event"
                    && e.payload["type"] == "session/event"
                    && e.payload["sessionId"].as_str() == Some(session)
                    && e.payload["event"]["seq"].as_u64() == Some(self.start_seq + i as u64)
            })
    }
}
