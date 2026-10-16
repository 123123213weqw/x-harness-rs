//! Version-one bounded forwarding only. No desktop credentials or arbitrary RPC.
use serde::{
    de::{Error as _, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::Value;
use std::fmt;
use xharness_remote::{CatalogueCursor, Command};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PENDING_REQUESTS: usize = 32;

/// No derived Debug on any secret-bearing envelope. Secrets are never URL fields.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Secret(String);
impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Secret {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !(32..=512).contains(&value.len()) || value.bytes().any(|b| !b.is_ascii_graphic()) {
            return Err("invalid secret shape");
        }
        Ok(Self(value))
    }
}
impl From<Secret> for String {
    fn from(value: Secret) -> Self {
        value.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MobileRequest {
    Pair {
        code: Secret,
        name: String,
    },
    Authenticated {
        device: String,
        secret: Secret,
        action: MobileAction,
    },
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MobileAction {
    Status,
    Catalogue {
        after: Option<CatalogueCursor>,
    },
    Command {
        request_id: String,
        generation: u64,
        command: Command,
    },
    Delivery {
        key: String,
    },
    Snapshot,
    Events {
        after: Option<u64>,
    },
}
// Serde's internally-tagged *unit* variants consume and ignore residual map
// fields even with deny_unknown_fields. Empty struct wire variants enforce the
// closed shape while preserving the public unit-variant Rust API and wire tag.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum MobileActionWire {
    Status {},
    Catalogue {
        after: Option<CatalogueCursor>,
    },
    Command {
        request_id: String,
        generation: u64,
        #[serde(deserialize_with = "closed_command")]
        command: Command,
    },
    Delivery {
        key: String,
    },
    Snapshot {},
    Events {
        after: Option<u64>,
    },
}
impl<'de> Deserialize<'de> for MobileAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match MobileActionWire::deserialize(deserializer)? {
            MobileActionWire::Status {} => Self::Status,
            MobileActionWire::Catalogue { after } => Self::Catalogue { after },
            MobileActionWire::Command {
                request_id,
                generation,
                command,
            } => Self::Command {
                request_id,
                generation,
                command,
            },
            MobileActionWire::Delivery { key } => Self::Delivery { key },
            MobileActionWire::Snapshot {} => Self::Snapshot,
            MobileActionWire::Events { after } => Self::Events { after },
        })
    }
}
// Preserve rejection of duplicate fields while inspecting the few shared unit
// variants. Deserializing directly to serde_json::Value would silently keep the
// last duplicate and erase the evidence before the typed command parser runs.
struct ClosedValue(Value);
impl<'de> Deserialize<'de> for ClosedValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ClosedVisitor;
        impl<'de> Visitor<'de> for ClosedVisitor {
            type Value = ClosedValue;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON without duplicate object fields")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(ClosedValue(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(ClosedValue(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(ClosedValue(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(ClosedValue(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|n| ClosedValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(ClosedValue(value.into()))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(ClosedValue(value.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(ClosedValue(value)) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(ClosedValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(A::Error::custom("duplicate mobile command field"));
                    }
                    let ClosedValue(value) = map.next_value()?;
                    values.insert(key, value);
                }
                Ok(ClosedValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(ClosedVisitor)
    }
}
fn closed_command<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Command, D::Error> {
    let ClosedValue(value) = ClosedValue::deserialize(deserializer)?;
    // The shared ingress includes two internally-tagged units. Reject residual
    // fields here without changing its existing trusted library representation.
    if value.get("type").and_then(Value::as_str) == Some("cancel")
        && value.as_object().is_none_or(|map| map.len() != 1)
    {
        return Err(D::Error::custom("unknown cancellation field"));
    }
    if value.get("type").and_then(Value::as_str) == Some("answer_interaction") {
        let answer = &value["answer"];
        if answer.get("type").and_then(Value::as_str) == Some("cancel_question")
            && answer.as_object().is_none_or(|map| map.len() != 1)
        {
            return Err(D::Error::custom("unknown question cancellation field"));
        }
    }
    serde_json::from_value(value).map_err(|_| D::Error::custom("invalid mobile command"))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unauthorized,
    PairExpired,
    PairConsumed,
    Conflict,
    Capacity,
    HostUnavailable,
    HostOffline,
    StreamGap,
    StorageUnavailable,
    Timeout,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobileResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorCode>,
}
impl MobileResponse {
    pub fn success(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    pub fn failure(error: ErrorCode) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}
/// Pair success result is this exact shape. Relay removes `secret` before HTTP response.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairedDevice {
    pub host: String,
    pub device: String,
    pub secret: Secret,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostFrame {
    Hello {
        host: String,
        key: Secret,
    },
    Response {
        id: String,
        response: MobileResponse,
    },
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RelayFrame {
    Ready,
    Request { id: String, request: MobileRequest },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum RelayFrameWire {
    Ready {},
    Request { id: String, request: MobileRequest },
}
impl<'de> Deserialize<'de> for RelayFrame {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match RelayFrameWire::deserialize(deserializer)? {
            RelayFrameWire::Ready {} => Self::Ready,
            RelayFrameWire::Request { id, request } => Self::Request { id, request },
        })
    }
}
