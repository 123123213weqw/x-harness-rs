//! Stable native creation identity. Trusted composition only, never a public RPC.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedSessionCreate {
    pub workspace: String,
    /// Domain-separated gateway fingerprint; never a controller-supplied session ID.
    pub request_key: String,
}
impl ScopedSessionCreate {
    pub fn is_bounded(&self) -> bool {
        !self.workspace.is_empty()
            && self.workspace.len() <= 512
            && !self.workspace.chars().any(char::is_control)
            && self.request_key.len() == 64
            && self
                .request_key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    pub fn session_id(&self) -> String {
        format!("remote-{}", self.request_key)
    }
    pub fn receipt_id(&self) -> String {
        format!("remote-create-{}", self.request_key)
    }
    pub fn receipt(&self) -> ScopedSessionCreated {
        ScopedSessionCreated {
            workspace: self.workspace.clone(),
            session: self.session_id(),
            request_key: self.request_key.clone(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedSessionCreated {
    pub workspace: String,
    pub session: String,
    pub request_key: String,
}
