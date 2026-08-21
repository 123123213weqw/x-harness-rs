//! Deterministic, provider-neutral system prompt assembly.
//!
//! The model-visible prompt and its audit metadata are built from the same
//! ordered section list.  Host/UI state is never accepted as proof that a
//! prompt reached a provider: the resulting [`PromptAssembly`] travels with
//! the prepared loop request and is recorded beside each request header.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Stable grammar/version of the minimal assembler.
pub const PROMPT_ASSEMBLER_VERSION: &str = "xharness-prompt/v1";

/// One ordered model-facing system section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptSection {
    pub id: String,
    pub version: String,
    pub content: String,
}

impl PromptSection {
    pub fn new(
        id: impl Into<String>,
        version: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            version: version.into(),
            content: content.into(),
        }
    }

    /// Give mutable user-authored content an honest version without inventing
    /// a database revision: the version is the complete content hash.
    pub fn content_addressed(id: impl Into<String>, content: impl Into<String>) -> Self {
        let content = content.into();
        Self::new(
            id,
            format!("sha256:{}", sha256(content.as_bytes())),
            content,
        )
    }
}

/// Log-safe reference to one assembled section. The content is represented by
/// a hash because the final system string is already captured by RequestHeader.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSectionAudit {
    pub id: String,
    pub version: String,
    pub content_sha256: String,
}

/// Metadata sufficient to identify and verify a model-visible prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAudit {
    pub assembler_version: String,
    pub assembly_id: String,
    pub system_sha256: String,
    pub sections: Vec<PromptSectionAudit>,
}

/// Immutable output passed to the loop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptAssembly {
    system: String,
    audit: PromptAudit,
}

impl PromptAssembly {
    pub fn system(&self) -> &str {
        &self.system
    }

    pub fn audit(&self) -> &PromptAudit {
        &self.audit
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum PromptError {
    #[error("prompt section {index} has an empty id")]
    EmptyId { index: usize },
    #[error("prompt section {id:?} has an empty version")]
    EmptyVersion { id: String },
    #[error("prompt section id {id:?} is duplicated")]
    DuplicateId { id: String },
    #[error("prompt section {id:?} has empty content")]
    EmptyContent { id: String },
}

/// Minimal ordered assembler. Registration/scope/provider plugins are added by
/// the later registry layer; this type already freezes byte-for-byte joining
/// and audit semantics used by the daily coding-agent path.
#[derive(Clone, Copy, Debug, Default)]
pub struct PromptAssembler;

impl PromptAssembler {
    pub fn assemble(
        &self,
        sections: impl IntoIterator<Item = PromptSection>,
    ) -> Result<PromptAssembly, PromptError> {
        let sections = sections.into_iter().collect::<Vec<_>>();
        let mut ids = HashSet::with_capacity(sections.len());
        let mut system_parts = Vec::with_capacity(sections.len());
        let mut audits = Vec::with_capacity(sections.len());

        for (index, section) in sections.into_iter().enumerate() {
            let id = section.id.trim().to_owned();
            if id.is_empty() {
                return Err(PromptError::EmptyId { index });
            }
            let version = section.version.trim().to_owned();
            if version.is_empty() {
                return Err(PromptError::EmptyVersion { id });
            }
            if !ids.insert(id.clone()) {
                return Err(PromptError::DuplicateId { id });
            }
            let content = section.content.trim().to_owned();
            if content.is_empty() {
                return Err(PromptError::EmptyContent { id });
            }
            audits.push(PromptSectionAudit {
                id,
                version,
                content_sha256: sha256(content.as_bytes()),
            });
            system_parts.push(content);
        }

        let system = system_parts.join("\n\n");
        let system_sha256 = sha256(system.as_bytes());
        let mut identity = Vec::new();
        identity.extend_from_slice(PROMPT_ASSEMBLER_VERSION.as_bytes());
        identity.push(0);
        for section in &audits {
            identity.extend_from_slice(section.id.as_bytes());
            identity.push(0);
            identity.extend_from_slice(section.version.as_bytes());
            identity.push(0);
            identity.extend_from_slice(section.content_sha256.as_bytes());
            identity.push(0xff);
        }
        identity.extend_from_slice(system_sha256.as_bytes());
        let assembly_id = format!("sha256:{}", sha256(&identity));

        Ok(PromptAssembly {
            system,
            audit: PromptAudit {
                assembler_version: PROMPT_ASSEMBLER_VERSION.to_owned(),
                assembly_id,
                system_sha256,
                sections: audits,
            },
        })
    }
}

fn sha256(value: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(value);
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_assembly_is_byte_stable_and_auditable_without_duplicate_content() {
        let sections = vec![
            PromptSection::new("identity", "1", "  You are X.  "),
            PromptSection::content_addressed("preset", "Inspect precisely."),
        ];
        let first = PromptAssembler.assemble(sections.clone()).unwrap();
        let second = PromptAssembler.assemble(sections).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.system(), "You are X.\n\nInspect precisely.");
        assert_eq!(first.audit().sections.len(), 2);
        assert!(first.audit().assembly_id.starts_with("sha256:"));
        let encoded = serde_json::to_value(first.audit()).unwrap();
        assert!(encoded.get("system").is_none());
        assert_eq!(encoded["sections"][0]["id"], "identity");
    }

    #[test]
    fn section_identity_and_content_are_strict() {
        let duplicate = PromptAssembler.assemble([
            PromptSection::new("same", "1", "a"),
            PromptSection::new("same", "2", "b"),
        ]);
        assert!(matches!(duplicate, Err(PromptError::DuplicateId { .. })));
        assert!(matches!(
            PromptAssembler.assemble([PromptSection::new("empty", "1", " \n ")]),
            Err(PromptError::EmptyContent { .. })
        ));
    }

    #[test]
    fn order_changes_system_and_assembly_identity() {
        let assembler = PromptAssembler;
        let a = PromptSection::new("a", "1", "A");
        let b = PromptSection::new("b", "1", "B");
        let left = assembler.assemble([a.clone(), b.clone()]).unwrap();
        let right = assembler.assemble([b, a]).unwrap();
        assert_ne!(left.system(), right.system());
        assert_ne!(left.audit().assembly_id, right.audit().assembly_id);
    }
}
