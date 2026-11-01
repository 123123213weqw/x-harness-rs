//! Replay validation retains identities, never copies pending message bodies.
#![forbid(unsafe_code)]
use crate::{InboxMessage, InboxSpliceOutcome, InboxTarget, MessageRole, Sequence, SessionError};
use std::collections::HashSet;

#[derive(Default)]
pub(crate) struct InboxValidation<'a> {
    next_turn: Vec<&'a str>,
    next_step: Vec<&'a str>,
    pending: HashSet<&'a str>,
    #[cfg(test)]
    membership_work: usize,
}

impl<'a> InboxValidation<'a> {
    pub(crate) fn apply(
        &mut self,
        seq: Sequence,
        target: InboxTarget,
        start: usize,
        removed_count: usize,
        inserted: &'a [InboxMessage],
        outcome: Option<InboxSpliceOutcome>,
    ) -> Result<(), SessionError> {
        let (list, other) = match target {
            InboxTarget::NextTurn => (&mut self.next_turn, &self.next_step),
            InboxTarget::NextStep => (&mut self.next_step, &self.next_turn),
        };
        let end =
            start
                .checked_add(removed_count)
                .ok_or_else(|| SessionError::InvalidInboxSplice {
                    seq,
                    message: "splice range overflow".to_owned(),
                })?;
        if start > list.len() || end > list.len() {
            return Err(SessionError::InvalidInboxSplice {
                seq,
                message: format!("range {start}..{end} exceeds {} pending items", list.len()),
            });
        }
        if outcome.is_some() && removed_count == 0 {
            return Err(SessionError::InvalidInboxSplice {
                seq,
                message: "discard outcome requires at least one removed message".to_owned(),
            });
        }
        // Preserve validation/error precedence, including replacement of the
        // same identity and removal/reinsertion in one atomic splice.
        for message in inserted {
            if message.id.is_empty() {
                return Err(SessionError::EmptyInboxMessageId { seq });
            }
            if message.message.role != MessageRole::User {
                return Err(SessionError::InvalidInboxMessageRole {
                    seq,
                    message_id: message.id.clone(),
                });
            }
            if message.message.id.as_deref() != Some(message.id.as_str()) {
                return Err(SessionError::InboxMessageIdMismatch {
                    seq,
                    message_id: message.id.clone(),
                });
            }
        }
        #[cfg(test)]
        {
            self.membership_work += removed_count + inserted.len();
        }
        for id in &list[start..end] {
            self.pending.remove(id);
        }
        for message in inserted {
            if !self.pending.insert(message.id.as_str()) {
                // Only invalid input pays for a full candidate scan. Preserve
                // exactly the old first-duplicate error order across both lists.
                let mut candidate = list[..start]
                    .iter()
                    .copied()
                    .chain(inserted.iter().map(|m| m.id.as_str()))
                    .chain(list[end..].iter().copied())
                    .chain(other.iter().copied());
                let mut seen = HashSet::new();
                let id = candidate
                    .find(|id| !seen.insert(*id))
                    .expect("incremental duplicate detection has a duplicate candidate");
                self.pending.clear();
                self.pending
                    .extend(list.iter().chain(other.iter()).copied());
                return Err(SessionError::DuplicateInboxMessage {
                    seq,
                    message_id: id.to_owned(),
                });
            }
        }
        list.splice(
            start..end,
            inserted.iter().map(|message| message.id.as_str()),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Frozen original validator for exact result/error-order comparison, not
    // an independent permissive oracle. Production never calls this path.
    fn reference(
        queues: (&mut Vec<InboxMessage>, &mut Vec<InboxMessage>),
        seq: Sequence,
        target: InboxTarget,
        start: usize,
        removed_count: usize,
        inserted: &[InboxMessage],
        outcome: Option<InboxSpliceOutcome>,
    ) -> Result<(), SessionError> {
        let (next_turn, next_step) = queues;
        let (target_inbox, other_inbox) = match target {
            InboxTarget::NextTurn => (next_turn, &*next_step),
            InboxTarget::NextStep => (next_step, &*next_turn),
        };
        let start = &start;
        let removed_count = &removed_count;
        let end =
            start
                .checked_add(*removed_count)
                .ok_or_else(|| SessionError::InvalidInboxSplice {
                    seq,
                    message: "splice range overflow".to_owned(),
                })?;
        if *start > target_inbox.len() || end > target_inbox.len() {
            return Err(SessionError::InvalidInboxSplice {
                seq,
                message: format!(
                    "range {start}..{end} exceeds {} pending items",
                    target_inbox.len()
                ),
            });
        }
        if outcome.is_some() && *removed_count == 0 {
            return Err(SessionError::InvalidInboxSplice {
                seq,
                message: "discard outcome requires at least one removed message".to_owned(),
            });
        }
        for message in inserted {
            if message.id.is_empty() {
                return Err(SessionError::EmptyInboxMessageId { seq });
            }
            if message.message.role != MessageRole::User {
                return Err(SessionError::InvalidInboxMessageRole {
                    seq,
                    message_id: message.id.clone(),
                });
            }
            if message.message.id.as_deref() != Some(message.id.as_str()) {
                return Err(SessionError::InboxMessageIdMismatch {
                    seq,
                    message_id: message.id.clone(),
                });
            }
        }
        let mut candidate = target_inbox.clone();
        candidate.splice(*start..end, inserted.iter().cloned());
        let mut ids = std::collections::HashSet::new();
        for message in candidate.iter().chain(other_inbox) {
            if !ids.insert(message.id.as_str()) {
                return Err(SessionError::DuplicateInboxMessage {
                    seq,
                    message_id: message.id.clone(),
                });
            }
        }
        *target_inbox = candidate;
        Ok(())
    }

    #[test]
    fn identities_match_original_for_both_queues_replacements_and_invalid_batches() {
        let turn = [
            InboxMessage::user("a", "first"),
            InboxMessage::user("b", "second"),
        ];
        let step = [InboxMessage::user("c", "third")];
        let mut wrong_role = InboxMessage::user("z", "bad role");
        wrong_role.message.role = MessageRole::Assistant;
        let mut wrong_id = InboxMessage::user("z", "bad identity");
        wrong_id.message.id = Some("different".into());
        let variants = vec![
            vec![],
            vec![InboxMessage::user("a", "replacement")],
            vec![InboxMessage::user("b", "replacement")],
            vec![InboxMessage::user("c", "cross-list")],
            vec![InboxMessage::user("d", "new")],
            vec![
                InboxMessage::user("d", "new"),
                InboxMessage::user("d", "duplicate"),
            ],
            vec![
                InboxMessage::user("c", "cross-first"),
                InboxMessage::user("b", "target-later"),
            ],
            vec![InboxMessage::user("", "empty")],
            vec![wrong_role],
            vec![wrong_id],
        ];
        let mut checked = 0;
        for turn_len in 0..=2 {
            for step_len in 0..=1 {
                for target in [InboxTarget::NextTurn, InboxTarget::NextStep] {
                    for start in [0, 1, 2, 3, usize::MAX] {
                        for count in [0, 1, 2, 3, usize::MAX] {
                            for inserted in &variants {
                                for outcome in [None, Some(InboxSpliceOutcome::Cancelled)] {
                                    let mut actual = InboxValidation::default();
                                    actual
                                        .apply(
                                            0,
                                            InboxTarget::NextTurn,
                                            0,
                                            0,
                                            &turn[..turn_len],
                                            None,
                                        )
                                        .unwrap();
                                    actual
                                        .apply(
                                            1,
                                            InboxTarget::NextStep,
                                            0,
                                            0,
                                            &step[..step_len],
                                            None,
                                        )
                                        .unwrap();
                                    let mut old_turn = turn[..turn_len].to_vec();
                                    let mut old_step = step[..step_len].to_vec();
                                    let expected = reference(
                                        (&mut old_turn, &mut old_step),
                                        2,
                                        target,
                                        start,
                                        count,
                                        inserted,
                                        outcome,
                                    );
                                    let result =
                                        actual.apply(2, target, start, count, inserted, outcome);
                                    assert_eq!(result,expected,"turn={turn_len}, step={step_len}, target={target:?}, start={start}, count={count}, inserted={inserted:?}");
                                    if result.is_ok() {
                                        assert_eq!(
                                            actual.next_turn,
                                            old_turn
                                                .iter()
                                                .map(|m| m.id.as_str())
                                                .collect::<Vec<_>>()
                                        );
                                        assert_eq!(
                                            actual.next_step,
                                            old_step
                                                .iter()
                                                .map(|m| m.id.as_str())
                                                .collect::<Vec<_>>()
                                        );
                                    } else {
                                        assert_eq!(
                                            actual.pending,
                                            turn[..turn_len]
                                                .iter()
                                                .chain(step[..step_len].iter())
                                                .map(|m| m.id.as_str())
                                                .collect()
                                        );
                                    }
                                    checked += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(checked, 6000);
    }

    #[test]
    fn valid_append_checks_only_changed_identities_not_every_pending_body() {
        let messages = (0..1000)
            .map(|n| InboxMessage::user(format!("input-{n}"), "x".repeat(16384)))
            .collect::<Vec<_>>();
        let mut state = InboxValidation::default();
        for (index, message) in messages.iter().enumerate() {
            state
                .apply(
                    index as u64,
                    InboxTarget::NextTurn,
                    index,
                    0,
                    std::slice::from_ref(message),
                    None,
                )
                .unwrap();
        }
        assert_eq!(state.membership_work, 1000);
        assert_eq!(state.next_turn.len(), 1000);
        assert_eq!(state.pending.len(), 1000);
        // Borrow exact source identities; no pending content allocation/copy.
        for (id, message) in state.next_turn.iter().zip(&messages) {
            assert!(std::ptr::eq(id.as_ptr(), message.id.as_ptr()));
        }
        state
            .apply(
                1000,
                InboxTarget::NextTurn,
                0,
                1000,
                &[],
                Some(InboxSpliceOutcome::Cancelled),
            )
            .unwrap();
        assert!(state.next_turn.is_empty() && state.pending.is_empty());
        assert_eq!(state.membership_work, 2000);
    }
}
