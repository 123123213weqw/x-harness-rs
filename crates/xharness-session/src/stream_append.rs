//! Opaque validation cursor for observational events over a validated prefix.
#![forbid(unsafe_code)]

use crate::{
    AppendReceipt, EventData, LoggedEvent, Revision, Sequence, Session, SessionError, SessionEvent,
};

/// A disposable, constant-size semantic cut, created only from a valid Session.
/// It never represents executable/model history and is deliberately not
/// serializable. Stores must bind it to the exact authoritative file identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamAppendCursor {
    revision: Revision,
    next_seq: Sequence,
    step: Option<(u32, u32, bool)>,
}

impl Session {
    /// Retain only the scope needed to validate observational stream appends.
    /// Structural transitions still require the ordinary complete validator.
    pub fn stream_append_cursor(&self) -> StreamAppendCursor {
        self.stream_cursor.clone()
    }
}

impl StreamAppendCursor {
    pub(crate) fn from_validated(revision: Revision, events: &[LoggedEvent]) -> Self {
        let mut step = None;
        let mut assistant_seen = false;
        for event in events.iter().rev() {
            match event.data() {
                EventData::StepStart { turn, step: number } => {
                    step = Some((*turn, *number, assistant_seen));
                    break;
                }
                EventData::AssistantMessage { .. } => assistant_seen = true,
                EventData::StepEnd { .. }
                | EventData::TurnEnd { .. }
                | EventData::TurnStart { .. } => break,
                _ => {}
            }
        }
        Self {
            revision,
            next_seq: events.len() as u64,
            step,
        }
    }
    /// Prepare the same receipt as Session::append_batch_at, without retaining
    /// or revalidating its immutable prefix. None means a structural/mixed
    /// batch: the storage owner MUST fall back to complete Session validation.
    /// The cursor advances only when its returned cut is committed by storage.
    pub fn prepare_append(
        &self,
        expected_revision: Revision,
        events: &[SessionEvent],
        timestamp_ms: u64,
    ) -> Result<Option<(Self, AppendReceipt)>, SessionError> {
        if !events.iter().all(|event| {
            matches!(
                event.data(),
                EventData::AssistantChunk { .. } | EventData::ModelReception { .. }
            )
        }) {
            return Ok(None);
        }
        if expected_revision != self.revision {
            return Err(SessionError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        let revision = if events.is_empty() {
            self.revision
        } else {
            Revision(
                self.revision
                    .0
                    .checked_add(1)
                    .ok_or(SessionError::RevisionOverflow)?,
            )
        };
        let next_seq = self
            .next_seq
            .checked_add(events.len() as u64)
            .ok_or(SessionError::RevisionOverflow)?;
        let mut staged = Vec::with_capacity(events.len());
        for (offset, event) in events.iter().enumerate() {
            let seq = self.next_seq + offset as u64;
            match event.data() {
                EventData::AssistantChunk { turn, step, .. }
                | EventData::ModelReception { turn, step, .. } => {
                    validate_scope(seq, *turn, *step, self.step)?;
                }
                _ => unreachable!("structural batches returned None above"),
            }
            staged.push(LoggedEvent {
                seq,
                revision,
                timestamp_ms,
                event: event.clone(),
            });
        }
        let receipt = AppendReceipt {
            previous_revision: self.revision,
            revision,
            first_seq: self.next_seq,
            last_seq: staged.last().map(|event| event.seq),
            events: staged,
        };
        Ok(Some((
            Self {
                revision,
                next_seq,
                step: self.step,
            },
            receipt,
        )))
    }
}

/// One semantic rule shared with the full authoritative validator. These two
/// observational variants change no other lifecycle/goal/tool/inbox state.
pub(crate) fn validate_scope(
    seq: Sequence,
    turn: u32,
    step: u32,
    scope: Option<(u32, u32, bool)>,
) -> Result<(), SessionError> {
    let error = |message: &str| SessionError::InvalidLifecycle {
        seq,
        message: message.into(),
    };
    let Some((open_turn, open_step, assistant_seen)) = scope else {
        return Err(error("assistant/chunk requires an open step"));
    };
    if open_turn != turn || open_step != step {
        return Err(error(
            "assistant/chunk coordinates do not match the open step",
        ));
    }
    if assistant_seen {
        return Err(error("assistant/chunk cannot follow assistant/message"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssistantChunk, Message, ModelReception, SessionHeader, TurnEndReason};

    // Independent oracle: restore the complete candidate log, never call the
    // optimized append path while testing that path's semantic equivalence.
    fn full_append(
        prefix: &Session,
        expected: Revision,
        events: &[SessionEvent],
    ) -> Result<AppendReceipt, SessionError> {
        if expected != prefix.revision() {
            return Err(SessionError::RevisionConflict {
                expected,
                actual: prefix.revision(),
            });
        }
        let revision = if events.is_empty() {
            expected
        } else {
            Revision(
                expected
                    .0
                    .checked_add(1)
                    .ok_or(SessionError::RevisionOverflow)?,
            )
        };
        let staged = events
            .iter()
            .enumerate()
            .map(|(offset, event)| LoggedEvent {
                seq: prefix.next_seq() + offset as u64,
                revision,
                timestamp_ms: 123,
                event: event.clone(),
            })
            .collect::<Vec<_>>();
        let mut all = prefix.events().to_vec();
        all.extend(staged.iter().cloned());
        Session::restore(prefix.header().clone(), revision, all)?;
        Ok(AppendReceipt {
            previous_revision: expected,
            revision,
            first_seq: prefix.next_seq(),
            last_seq: staged.last().map(|e| e.seq),
            events: staged,
        })
    }

    #[test]
    fn cursor_matches_complete_validation_at_every_lifecycle_boundary() {
        let mut session = Session::new(SessionHeader::new("differential")).unwrap();
        let mut prefixes = vec![session.clone()];
        for event in [
            EventData::TurnStart { turn: 1 },
            EventData::StepStart { turn: 1, step: 1 },
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("done"),
                usage: None,
            },
            EventData::StepEnd { turn: 1, step: 1 },
            EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
            },
        ] {
            session.append(session.revision(), event).unwrap();
            prefixes.push(session.clone());
        }
        for prefix in prefixes {
            for (turn, step) in [(0, 0), (1, 0), (1, 1), (1, 2), (2, 1)] {
                let chunk: SessionEvent = EventData::AssistantChunk {
                    turn,
                    step,
                    chunk: AssistantChunk::TextDelta("hello".into()),
                }
                .into();
                let reception: SessionEvent = EventData::ModelReception {
                    turn,
                    step,
                    reception: ModelReception {
                        attempt: 0,
                        start_ms: 1,
                        first_delta_ms: Some(2),
                        elapsed_ms: 3,
                        reception_ms: 2,
                        estimated_units: 1,
                        estimated_reasoning_units: 0,
                        finished: true,
                        output_tokens: Some(1),
                        reasoning_tokens: Some(0),
                        samples: vec![],
                    },
                }
                .into();
                for events in [
                    vec![],
                    vec![chunk.clone()],
                    vec![reception.clone()],
                    vec![chunk.clone(), reception.clone()],
                ] {
                    for expected in [prefix.revision(), Revision(999)] {
                        let reference = full_append(&prefix, expected, &events);
                        let observed = prefix
                            .stream_append_cursor()
                            .prepare_append(expected, &events, 123)
                            .map(|v| v.unwrap().1);
                        assert_eq!(
                            observed,
                            reference,
                            "scope {turn}/{step}, revision {:?}",
                            prefix.revision()
                        );
                        assert_eq!(
                            prefix
                                .clone()
                                .append_batch_at(expected, events.clone(), 123),
                            reference
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn mixed_batches_require_full_validation_and_cursor_is_transactional() {
        let mut session = Session::new(SessionHeader::new("mixed")).unwrap();
        session
            .append_batch(
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                ],
            )
            .unwrap();
        let cursor = session.stream_append_cursor();
        let event: SessionEvent = EventData::AssistantChunk {
            turn: 1,
            step: 1,
            chunk: AssistantChunk::TextDelta("x".into()),
        }
        .into();
        let bad: SessionEvent = EventData::AssistantChunk {
            turn: 2,
            step: 1,
            chunk: AssistantChunk::TextDelta("bad".into()),
        }
        .into();
        assert!(cursor
            .prepare_append(session.revision(), &[event.clone(), bad], 1)
            .is_err());
        assert!(cursor
            .prepare_append(
                session.revision(),
                &[
                    event.clone(),
                    EventData::StepEnd { turn: 1, step: 1 }.into()
                ],
                1
            )
            .unwrap()
            .is_none());
        let (next, receipt) = cursor
            .prepare_append(session.revision(), std::slice::from_ref(&event), 1)
            .unwrap()
            .unwrap();
        assert_eq!(receipt.first_seq, 2);
        assert_eq!(cursor.revision, Revision(1));
        assert_eq!(next.revision, Revision(2));
    }
}
