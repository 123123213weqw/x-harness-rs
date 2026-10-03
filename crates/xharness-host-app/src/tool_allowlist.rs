//! Deployment-level restriction, applied before registry construction.
//! A missing restriction preserves normal production behavior; an explicitly
//! empty list exposes no tools. This is not a model-side schema filter.

use std::collections::BTreeSet;
use xharness_tools::{ToolDefinition, ToolSpec};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolAllowlist(BTreeSet<String>);

impl ToolAllowlist {
    pub fn parse(value: &str) -> Result<Self, String> {
        let mut names = BTreeSet::new();
        if !value.is_empty() {
            for name in value.split(',') {
                if name.is_empty()
                    || name.len() > 128
                    || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    return Err("tool allowlist requires comma-separated tool names".into());
                }
                names.insert(name.to_owned());
            }
        }
        Ok(Self(names))
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.0.contains(name)
    }

    pub(crate) fn apply(&self, specs: &mut Vec<ToolSpec>) {
        specs.retain(|spec| self.0.contains(&spec.definition.name));
    }

    // Host-owned tools are registered after the native factory returns. Check
    // availability only once that final registry is ready for the model loop.
    pub(crate) fn validate(&self, definitions: &[ToolDefinition]) -> Result<(), String> {
        for name in &self.0 {
            if !definitions
                .iter()
                .any(|definition| &definition.name == name)
            {
                return Err(format!(
                    "allowlisted tool {name:?} is unavailable under this session policy"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_deployment_names_and_explicit_empty_selection() {
        assert_eq!(
            ToolAllowlist::parse("computer,read,computer")
                .unwrap()
                .0
                .len(),
            2
        );
        assert!(ToolAllowlist::parse("").unwrap().0.is_empty());
        for value in [",", "computer,", " computer", "read,*", "a-b", "a/b"] {
            assert!(ToolAllowlist::parse(value).is_err(), "{value}");
        }
        assert!(ToolAllowlist::parse(&"a".repeat(129)).is_err());
    }

    #[test]
    fn missing_capability_fails_closed_instead_of_silently_changing_the_suite() {
        assert!(ToolAllowlist::parse("computer")
            .unwrap()
            .validate(&[])
            .is_err());
        assert!(ToolAllowlist::parse("").unwrap().validate(&[]).is_ok());
    }
}
