//! Cold tool observations: references are scoped by the Store's session argument.
use crate::StoreError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_TOOL_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
pub const TOOL_ARCHIVE_THRESHOLD_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolArchiveRef {
    pub sha256: String,
    pub bytes: usize,
}

impl ToolArchiveRef {
    pub fn for_text(text: &str) -> Result<Self, StoreError> {
        if text.len() > MAX_TOOL_ARCHIVE_BYTES {
            return Err(StoreError::Backend {
                message: "tool result archive exceeds 32 MiB; original result was not saved".into(),
            });
        }
        Ok(Self {
            sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            bytes: text.len(),
        })
    }

    pub fn validate_key(key: &str) -> Result<(), StoreError> {
        if key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            Ok(())
        } else {
            Err(StoreError::Backend {
                message: "invalid tool archive reference".into(),
            })
        }
    }
}
