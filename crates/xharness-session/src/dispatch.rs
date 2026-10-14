//! Canonical automatic-admission projection; neither UI nor an actor cache
//! owns a second copy of the gate. A terminal failure itself closes the gate,
//! atomically with TurnEnd, including old journals without a pause event.
use crate::{EventData, InboxMessage, Session, TurnEndReason};

impl Session {
    /// Automatic input must wait for a human prompt or an explicit resume.
    /// Merely receiving role=user runtime context cannot reopen admission.
    pub fn dispatch_paused(&self) -> bool {
        let mut completed_after = false;
        for event in self.events().iter().rev() {
            match event.data() {
                EventData::AgentDispatchPaused { paused } => return *paused,
                EventData::TurnEnd {
                    reason:
                        TurnEndReason::Failed {
                            provider_failure, ..
                        },
                    ..
                } if !completed_after => {
                    // The existing Goal owner may retry classified transport
                    // failures with its durable deadline/backoff. Deterministic
                    // context/compaction failures have no retryable provider fact.
                    if provider_failure
                        .as_ref()
                        .is_some_and(|failure| failure.retryable)
                    {
                        // Supersede an older implicit failure, never an explicit
                        // stop written while this request was still finishing.
                        completed_after = true;
                    } else {
                        return true;
                    }
                }
                // A successful later turn proves an old failure was recovered.
                // This is needed for legacy journals; it never overrides an
                // explicit user stop. Pending receipts alone are not success.
                EventData::TurnEnd {
                    reason: TurnEndReason::Completed,
                    ..
                } => completed_after = true,
                // Forks copy conversation, not their parent's admission lock.
                EventData::SessionForkOrigin { .. } => return false,
                _ => {}
            }
        }
        false
    }
}

impl InboxMessage {
    /// Provenance is transport-owned metadata, never inferred from prose or
    /// model-facing role. None is the original public user-input API.
    pub fn is_user_authored(&self) -> bool {
        self.source.as_ref().is_none_or(|source| {
            // The Host stores the whole admission metadata envelope here;
            // the embedded API supplies provenance directly. Both are trusted
            // transport facts, neither is read from model-facing message text.
            source
                .get("source")
                .unwrap_or(source)
                .get("kind")
                .and_then(serde_json::Value::as_str)
                == Some("user")
        })
    }
}
