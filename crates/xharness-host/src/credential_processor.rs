//! Pure credential-reference policy for the Host RPC boundary.
//!
//! Secret values are accepted only for an explicit memory mutation and never
//! enter the state snapshot, response or error details. OS/keychain access and
//! model-registry activation remain side effects of the RPC adapter.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};
use xharness_api::{RpcError, RpcErrorCode};

#[derive(Clone, Debug, Default)]
pub(crate) struct CredentialStateView {
    pub(crate) stored_references: BTreeSet<String>,
    pub(crate) environment_references: BTreeSet<String>,
}

#[derive(Debug)]
pub(crate) enum CredentialMemoryMutation {
    Set { reference: String, value: String },
    Unset { reference: String },
}

pub(crate) struct CredentialProcessor {
    state: CredentialStateView,
}

impl CredentialProcessor {
    pub(crate) fn new(state: CredentialStateView) -> Self {
        Self { state }
    }

    pub(crate) fn validate_reference(reference: &str) -> Result<(), RpcError> {
        let mut chars = reference.chars();
        let Some(first) = chars.next() else {
            return Err(bad_request("credential reference is empty"));
        };
        if !(first == '_' || first.is_ascii_alphabetic())
            || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            return Err(bad_request(
                "credential reference must match [A-Za-z_][A-Za-z0-9_]*",
            ));
        }
        Ok(())
    }

    pub(crate) fn describe(&self, references: &[String]) -> Value {
        let credentials = references
            .iter()
            .map(|reference| {
                let environment = self.state.environment_references.contains(reference);
                let stored = self.state.stored_references.contains(reference);
                (
                    reference.clone(),
                    json!({
                        "configured": environment || stored,
                        "source": if environment { Some("env") } else if stored { Some("memory") } else { None },
                        "writable": !environment,
                    }),
                )
            })
            .collect::<Map<_, _>>();
        json!({"credentials": credentials})
    }

    pub(crate) fn set(
        &self,
        reference: String,
        value: String,
    ) -> Result<CredentialMemoryMutation, RpcError> {
        Self::validate_reference(&reference)?;
        if self.state.environment_references.contains(&reference) {
            return Err(credential_rejected(&reference));
        }
        Ok(CredentialMemoryMutation::Set { reference, value })
    }

    pub(crate) fn unset(&self, reference: String) -> Result<CredentialMemoryMutation, RpcError> {
        Self::validate_reference(&reference)?;
        if self.state.environment_references.contains(&reference) {
            return Err(credential_rejected(&reference));
        }
        Ok(CredentialMemoryMutation::Unset { reference })
    }
}

fn credential_rejected(reference: &str) -> RpcError {
    RpcError {
        code: RpcErrorCode::CredentialRejected,
        message: "an environment credential shadows this reference".to_owned(),
        details: json!({"ref": reference}),
    }
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processor() -> CredentialProcessor {
        CredentialProcessor::new(CredentialStateView {
            stored_references: ["MEMORY_KEY".to_owned()].into_iter().collect(),
            environment_references: ["ENV_KEY".to_owned()].into_iter().collect(),
        })
    }

    #[test]
    fn reference_validation_preserves_the_public_contract() {
        for valid in ["A", "_A", "API_KEY_2"] {
            CredentialProcessor::validate_reference(valid).unwrap();
        }
        for invalid in ["", "2KEY", "API-KEY", "密钥"] {
            let error = CredentialProcessor::validate_reference(invalid).unwrap_err();
            assert_eq!(error.code, RpcErrorCode::BadRequest);
        }
    }

    #[test]
    fn describe_exposes_only_configuration_metadata() {
        let described = processor().describe(&[
            "ENV_KEY".to_owned(),
            "MEMORY_KEY".to_owned(),
            "MISSING".to_owned(),
        ]);
        assert_eq!(described["credentials"]["ENV_KEY"]["source"], "env");
        assert_eq!(described["credentials"]["ENV_KEY"]["writable"], false);
        assert_eq!(described["credentials"]["MEMORY_KEY"]["source"], "memory");
        assert_eq!(described["credentials"]["MISSING"]["configured"], false);
        assert!(!described.to_string().contains("secret"));
    }

    #[test]
    fn environment_shadow_rejects_set_and_unset_without_secret_echo() {
        let secret = "do-not-echo".to_owned();
        let error = processor()
            .set("ENV_KEY".to_owned(), secret.clone())
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::CredentialRejected);
        assert!(!serde_json::to_string(&error).unwrap().contains(&secret));
        assert_eq!(
            processor().unset("ENV_KEY".to_owned()).unwrap_err().code,
            RpcErrorCode::CredentialRejected
        );
    }

    #[test]
    fn memory_mutations_are_explicit_and_responses_carry_no_values() {
        let set = processor()
            .set("NEW_KEY".to_owned(), "secret".to_owned())
            .unwrap();
        assert!(matches!(
            set,
            CredentialMemoryMutation::Set { reference, value }
                if reference == "NEW_KEY" && value == "secret"
        ));
        let unset = processor().unset("MEMORY_KEY".to_owned()).unwrap();
        assert!(matches!(
            unset,
            CredentialMemoryMutation::Unset { reference } if reference == "MEMORY_KEY"
        ));
    }
}
