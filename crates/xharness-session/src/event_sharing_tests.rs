#![forbid(unsafe_code)]
use super::*;
use crate::{Revision, Session, SessionHeader, SessionTitleSource};

fn title(value: &str) -> SessionEvent {
    EventData::SessionTitle {
        title: value.into(),
        message_seqs: vec![],
        source: SessionTitleSource::User,
    }
    .into()
}

#[test]
fn shared_payload_keeps_the_exact_legacy_json_and_detaches_on_mutation() {
    let original = title("Unicode Δ✓, C:\\tmp, newline\n, quote\"");
    let expected = serde_json::to_value(original.data()).unwrap();
    let mut clone = original.clone();
    assert!(Arc::ptr_eq(&original.0, &clone.0));
    assert_eq!(serde_json::to_value(&clone).unwrap(), expected);
    let EventData::SessionTitle { title, .. } = clone.data_mut() else {
        panic!("title")
    };
    *title = "changed".into();
    assert!(!Arc::ptr_eq(&original.0, &clone.0));
    assert_eq!(serde_json::to_value(&original).unwrap(), expected);
    let decoded: SessionEvent = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(serde_json::to_value(decoded.into_data()).unwrap(), expected);
    assert_ne!(clone, original);
}

#[test]
fn appending_with_a_retained_snapshot_shares_prefix_payloads_not_mutable_values() {
    let mut session = Session::new(SessionHeader::new("sharing")).unwrap();
    for index in 0..128 {
        session
            .append(session.revision(), title(&format!("title {index}")))
            .unwrap();
    }
    let old = session.clone();
    let old_wire = serde_json::to_value(old.events()).unwrap();
    session
        .append(session.revision(), title("new tail"))
        .unwrap();
    assert_eq!(old.next_seq(), 128);
    assert_eq!(session.next_seq(), 129);
    for (prior, current) in old.events().iter().zip(session.events()) {
        assert!(Arc::ptr_eq(&prior.event.0, &current.event.0));
    }
    assert_eq!(serde_json::to_value(old.events()).unwrap(), old_wire);
    // Editing a detached inspection cannot alter either authoritative cut.
    let mut inspection = session.events().to_vec();
    let EventData::SessionTitle { title, .. } = inspection[0].event.data_mut() else {
        panic!("title")
    };
    *title = "inspection only".into();
    assert_eq!(serde_json::to_value(old.events()).unwrap(), old_wire);
    assert_ne!(inspection[0], session.events()[0]);
    assert_eq!(
        Session::restore(old.header().clone(), Revision(128), old.events().to_vec()).unwrap(),
        old
    );
}

#[test]
fn shared_large_payload_clones_only_ownership_and_unique_extraction_reuses_allocation() {
    let event = SessionEvent::new(EventData::AssistantChunk {
        turn: 1,
        step: 1,
        chunk: AssistantChunk::TextDelta("x".repeat(1024 * 1024)),
    });
    let copies = (0..512).map(|_| event.clone()).collect::<Vec<_>>();
    assert!(copies.iter().all(|copy| Arc::ptr_eq(&event.0, &copy.0)));
    assert_eq!(Arc::strong_count(&event.0), 513);
    drop(copies);
    let pointer = match event.data() {
        EventData::AssistantChunk {
            chunk: AssistantChunk::TextDelta(text),
            ..
        } => text.as_ptr(),
        _ => unreachable!(),
    };
    let EventData::AssistantChunk {
        chunk: AssistantChunk::TextDelta(text),
        ..
    } = event.into_data()
    else {
        panic!("chunk")
    };
    assert_eq!(text.as_ptr(), pointer);
}
