//! Presentation-only lifetime of an authenticated model browser invocation.
//! Dropping a cancelled/timed-out future also emits the matching finish. This
//! observer never schedules input, changes delegation or claims an effect.
#![forbid(unsafe_code)]

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Operation {
    Open,
    Close,
    Observe,
    Perform,
    Screenshot,
    Input,
    Request,
    #[serde(rename = "read_response")]
    ReadResponse,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Started,
    Finished,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActivityEvent {
    id: String,
    backend: &'static str,
    owner: String,
    tab_id: String,
    operation: Operation,
    phase: Phase,
}

pub(super) struct Activity<F: Fn(&ActivityEvent)> {
    event: ActivityEvent,
    emit: F,
}

impl<F: Fn(&ActivityEvent)> Activity<F> {
    pub(super) fn start(owner: &str, tab_id: &str, operation: Operation, emit: F) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let event = ActivityEvent {
            id: NEXT.fetch_add(1, Ordering::Relaxed).to_string(),
            backend: "embedded",
            owner: owner.into(),
            tab_id: tab_id.into(),
            operation,
            phase: Phase::Started,
        };
        emit(&event);
        Self { event, emit }
    }
}

impl<F: Fn(&ActivityEvent)> Drop for Activity<F> {
    fn drop(&mut self) {
        self.event.phase = Phase::Finished;
        (self.emit)(&self.event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, time::Duration};

    #[test]
    fn response_reads_use_the_same_operation_name_as_the_tool_and_ui() {
        assert_eq!(serde_json::to_value(Operation::Request).unwrap(), "request");
        assert_eq!(
            serde_json::to_value(Operation::ReadResponse).unwrap(),
            "read_response"
        );
    }

    #[test]
    fn overlapping_calls_have_distinct_ids_and_finish_only_their_own_tab() {
        let events = RefCell::new(Vec::new());
        let emit = |event: &ActivityEvent| events.borrow_mut().push(event.clone());
        let first = Activity::start("chat-a", "browser:1", Operation::Observe, emit);
        let second = Activity::start("chat-b", "browser:2", Operation::Input, emit);
        assert_ne!(first.event.id, second.event.id);
        drop(first);
        drop(second);
        let events = events.borrow();
        for (start, end) in [(0, 2), (1, 3)] {
            assert_eq!(events[start].id, events[end].id);
            assert_eq!(events[start].owner, events[end].owner);
            assert_eq!(events[start].tab_id, events[end].tab_id);
            assert_eq!(events[start].operation, events[end].operation);
            assert_eq!(events[start].phase, Phase::Started);
            assert_eq!(events[end].phase, Phase::Finished);
        }
        let wire = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(wire["backend"], "embedded");
        assert_eq!(wire["tabId"], "browser:1");
        assert_eq!(wire.as_object().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn timeout_drops_the_observer_without_claiming_success_or_leaving_it_running() {
        let events = RefCell::new(Vec::new());
        let work = async {
            let _activity = Activity::start("chat", "browser:1", Operation::Perform, |event| {
                events.borrow_mut().push(event.clone());
            });
            std::future::pending::<()>().await;
        };
        assert!(tokio::time::timeout(Duration::from_millis(1), work)
            .await
            .is_err());
        let events = events.borrow();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, events[1].id);
        assert_eq!(events[1].phase, Phase::Finished);
        assert!(!serde_json::to_string(&events[1])
            .unwrap()
            .contains("success"));
    }
}
