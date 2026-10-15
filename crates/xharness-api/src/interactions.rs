//! Trusted in-process scoped interaction seam, NOT an HTTP/RPC method.
use crate::ServerRequest;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedInteraction {
    /// Fresh native pending-instance identity; changes even when RPC ids are reused.
    pub nonce: String,
    pub frame: ServerRequest,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedQuestionAnswer {
    pub id: String,
    pub selected: Option<String>,
    pub custom: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScopedInteractionAnswer {
    Approval { allowed: bool },
    Question { answers: Vec<ScopedQuestionAnswer> },
    CancelQuestion,
}
impl ScopedInteractionAnswer {
    pub fn is_bounded(&self) -> bool {
        match self {
            Self::Approval { .. } | Self::CancelQuestion => true,
            Self::Question { answers } => {
                !answers.is_empty()
                    && answers.len() <= 32
                    && answers.iter().all(|a| {
                        !a.id.is_empty()
                            && a.id.len() <= 512
                            && !a.id.chars().any(char::is_control)
                            && a.selected
                                .as_ref()
                                .is_none_or(|s| !s.is_empty() && s.len() <= 4096)
                            && a.custom.as_ref().is_none_or(|s| s.len() <= 64 * 1024)
                    })
            }
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopedInteractionReceipt {
    Accepted,
    /// Definitely stale before any native response effect.
    Stale,
    /// Definitely invalid before any native response effect.
    Invalid,
    /// A native decision/append might have happened; MUST NOT replay.
    Uncertain,
}
