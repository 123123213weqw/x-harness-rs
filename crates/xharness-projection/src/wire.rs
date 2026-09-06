//! Owned Host -> UI DTOs. Never reuse an RPC failure for a lifecycle failure.
//! The schema export is test-only: no generator or validator runs in the Host.

use serde::{Deserialize, Serialize};
use xharness_session::TurnEndReason;

/// Lightweight lifecycle failure, not the RPC envelope's `details` contract.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct TurnFailure {
    pub code: String,
    pub message: String,
}

/// Current producer vocabulary. The exhaustive conversion below is the only
/// mapping from durable reasons; legacy reader aliases are not producer states.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TurnEndReasonWire {
    Completed,
    MaxTokens,
    Cancelled,
    MaxSteps,
    Error { error: TurnFailure },
}

impl From<&TurnEndReason> for TurnEndReasonWire {
    fn from(reason: &TurnEndReason) -> Self {
        match reason {
            TurnEndReason::Completed => Self::Completed,
            TurnEndReason::MaxTokens => Self::MaxTokens,
            TurnEndReason::Cancelled | TurnEndReason::UserInterrupted => Self::Cancelled,
            TurnEndReason::LimitReached => Self::MaxSteps,
            TurnEndReason::Failed { error, .. } => Self::Error {
                error: TurnFailure {
                    code: "LOOP_FAILED".into(),
                    message: error.clone(),
                },
            },
            TurnEndReason::Interrupted => Self::Error {
                error: TurnFailure {
                    code: "INTERRUPTED".into(),
                    message: "the previous Host stopped before this turn closed".into(),
                },
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct TurnEndData {
    pub turn: u32,
    pub reason: TurnEndReasonWire,
}

impl TurnEndData {
    pub fn from_durable(turn: u32, reason: &TurnEndReason) -> Self {
        Self {
            turn: turn.saturating_sub(1),
            reason: reason.into(),
        }
    }

    /// The legacy Core driver already uses zero-based browser coordinates.
    pub fn from_loop(turn: u32, status: xharness_core::LoopStatus, error: Option<&str>) -> Self {
        use xharness_core::LoopStatus;
        let reason = match status {
            LoopStatus::Completed => TurnEndReasonWire::Completed,
            LoopStatus::MaxTokens => TurnEndReasonWire::MaxTokens,
            LoopStatus::Cancelled => TurnEndReasonWire::Cancelled,
            LoopStatus::LimitReached => TurnEndReasonWire::MaxSteps,
            LoopStatus::Failed => TurnEndReasonWire::Error {
                error: TurnFailure {
                    code: "LOOP_FAILED".into(),
                    message: error.unwrap_or("loop failed").into(),
                },
            },
        };
        Self { turn, reason }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{collections::BTreeMap, path::Path};
    use xharness_session::{EventData, LoggedEvent, SessionEvent};

    // Explicit read-compatibility DTOs. These are included in the generated
    // client schema but cannot be emitted by the production mapping above.
    #[derive(schemars::JsonSchema, Serialize, Deserialize)]
    struct LegacyTurnFailure {
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<BTreeMap<String, Value>>,
    }
    #[derive(schemars::JsonSchema, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "kebab-case")]
    enum LegacyTurnEndReason {
        Aborted,
        Stop,
        Error {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            error: Option<LegacyTurnFailure>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            failure: Option<LegacyTurnFailure>,
        },
    }
    #[derive(schemars::JsonSchema, Serialize, Deserialize)]
    #[serde(untagged)]
    enum TurnEndReasonInput {
        Current(TurnEndReasonWire),
        Legacy(LegacyTurnEndReason),
    }
    #[derive(schemars::JsonSchema, Serialize, Deserialize)]
    struct TurnEndDataInput {
        turn: u32,
        reason: TurnEndReasonInput,
    }

    struct Route;
    impl crate::ProjectionRoute for Route {
        fn provider(&self) -> &str {
            "fixture"
        }
        fn model(&self) -> &str {
            "fixture"
        }
    }

    #[test]
    fn export_session_terminal_contract() {
        let cases = [
            (
                "completed",
                TurnEndReason::Completed,
                json!({"kind":"completed"}),
            ),
            (
                "max_tokens",
                TurnEndReason::MaxTokens,
                json!({"kind":"max-tokens"}),
            ),
            (
                "cancelled",
                TurnEndReason::Cancelled,
                json!({"kind":"cancelled"}),
            ),
            (
                "user_interrupted",
                TurnEndReason::UserInterrupted,
                json!({"kind":"cancelled"}),
            ),
            (
                "limit_reached",
                TurnEndReason::LimitReached,
                json!({"kind":"max-steps"}),
            ),
            (
                "failed",
                TurnEndReason::Failed {
                    error: "fixture failure".into(),
                    provider_failure: None,
                },
                json!({"kind":"error","error":{"code":"LOOP_FAILED","message":"fixture failure"}}),
            ),
            (
                "interrupted",
                TurnEndReason::Interrupted,
                json!({"kind":"error","error":{"code":"INTERRUPTED","message":"the previous Host stopped before this turn closed"}}),
            ),
        ];
        let sources = crate::ProjectionSources {
            prompts: BTreeMap::new(),
            compaction_commands: BTreeMap::new(),
        };
        let mut fixtures = Vec::new();
        for (name, reason, expected) in cases {
            // Exercise the exact public projection shared by Host live/history,
            // rather than constructing a web fixture by hand.
            let event = LoggedEvent {
                seq: 6,
                revision: xharness_session::Revision(7),
                timestamp_ms: 165000,
                event: SessionEvent::new(EventData::TurnEnd {
                    turn: 2,
                    reason: reason.clone(),
                }),
            };
            let live = crate::restored_web_event(&event, &Route, &sources, None, None);
            let history = crate::restored_web_event(
                &event,
                &Route,
                &sources,
                None,
                Some(&Default::default()),
            );
            assert_eq!(live, history);
            assert_eq!(live["data"], json!({"turn":1,"reason":expected}));
            assert_eq!(crate::web_turn_end(&reason), expected);
            let decoded: TurnEndData = serde_json::from_value(live["data"].clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), live["data"]);
            let _: TurnEndDataInput = serde_json::from_value(live["data"].clone()).unwrap();
            let driver_status = match reason {
                TurnEndReason::Completed => Some(xharness_core::LoopStatus::Completed),
                TurnEndReason::MaxTokens => Some(xharness_core::LoopStatus::MaxTokens),
                TurnEndReason::Cancelled | TurnEndReason::UserInterrupted => {
                    Some(xharness_core::LoopStatus::Cancelled)
                }
                TurnEndReason::LimitReached => Some(xharness_core::LoopStatus::LimitReached),
                TurnEndReason::Failed { .. } => Some(xharness_core::LoopStatus::Failed),
                TurnEndReason::Interrupted => None,
            };
            let driver = driver_status.map(|status| {
                let error = if let TurnEndReason::Failed { error, .. } = &reason {
                    Some(error.as_str())
                } else {
                    None
                };
                serde_json::to_value(TurnEndData::from_loop(1, status, error)).unwrap()
            });
            if let Some(driver) = &driver {
                assert_eq!(*driver, live["data"]);
            }
            fixtures.push(json!({"name":name,"live":live,"history":history,"driver":driver}));
        }
        for reason in [
            json!({"kind":"aborted"}),
            json!({"kind":"stop"}),
            json!({"kind":"error"}),
            json!({"kind":"error","failure":{"code":"OLD","message":"legacy","details":{}}}),
        ] {
            let _: TurnEndDataInput =
                serde_json::from_value(json!({"turn":1,"reason":reason})).unwrap();
        }
        if let Ok(directory) = std::env::var("XHARNESS_SESSION_TERMINAL_EXPORT") {
            let directory = Path::new(&directory);
            std::fs::create_dir_all(directory).unwrap();
            let schema = json!({"contract":"xharness-session-terminal-v1", "schemas": {
                "TurnEndData": schemars::schema_for!(TurnEndData),
                "TurnEndDataInput": schemars::schema_for!(TurnEndDataInput),
            }});
            std::fs::write(
                directory.join("session-terminal.schema.json"),
                serde_json::to_vec_pretty(&schema).unwrap(),
            )
            .unwrap();
            std::fs::write(
                directory.join("session-terminal.fixtures.json"),
                serde_json::to_vec_pretty(
                    &json!({"contract":"xharness-session-terminal-v1","cases":fixtures}),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn canonical_terminal_requires_failure_and_exact_coordinates() {
        for data in [
            json!({"turn":1,"reason":{"kind":"error"}}),
            json!({"turn":1,"reason":{"kind":"aborted"}}),
            json!({"turn":1,"reason":{"kind":"future"}}),
            json!({"turn":-1,"reason":{"kind":"completed"}}),
            json!({"turn":4294967296_u64,"reason":{"kind":"completed"}}),
        ] {
            assert!(serde_json::from_value::<TurnEndData>(data).is_err());
        }
        assert_eq!(
            TurnEndData::from_durable(1, &TurnEndReason::Completed).turn,
            0
        );
        assert_eq!(
            TurnEndData::from_durable(u32::MAX, &TurnEndReason::Completed).turn,
            u32::MAX - 1
        );
        let fallback = serde_json::to_value(TurnEndData::from_loop(
            0,
            xharness_core::LoopStatus::Failed,
            None,
        ))
        .unwrap();
        assert_eq!(fallback["reason"]["error"]["message"], "loop failed");
    }
}
