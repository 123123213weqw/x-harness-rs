//! Pure navigation and authorization policy for direct child sessions.

use std::collections::BTreeMap;

use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubagentRecord {
    pub(crate) id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) running: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SubagentSnapshot {
    pub(crate) sessions: BTreeMap<String, SubagentRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChildAuthorizationError {
    ParentUnavailable,
    ChildNotFound,
    Unauthorized,
}

pub(crate) struct SubagentProcessor;

impl SubagentProcessor {
    pub(crate) fn list(snapshot: &SubagentSnapshot, parent: &str) -> Value {
        let entries = snapshot
            .sessions
            .values()
            .filter(|session| session.parent_id.as_deref() == Some(parent))
            .map(|session| {
                json!({
                    "kind": "child",
                    "id": session.id,
                    "mode": "continuable",
                    "activity": if session.running { "running" } else { "inactive" },
                    "hasChildren": snapshot.sessions.values().any(|candidate| {
                        candidate.parent_id.as_deref() == Some(session.id.as_str())
                    }),
                    "label": session.title.as_deref().unwrap_or(&session.id),
                })
            })
            .collect::<Vec<_>>();
        json!({
            "entries": entries,
            "parentAvailable": snapshot.sessions.contains_key(parent),
        })
    }

    pub(crate) fn authorize(
        snapshot: &SubagentSnapshot,
        parent: &str,
        child: &str,
    ) -> Result<(), ChildAuthorizationError> {
        if !snapshot.sessions.contains_key(parent) {
            return Err(ChildAuthorizationError::ParentUnavailable);
        }
        let record = snapshot
            .sessions
            .get(child)
            .ok_or(ChildAuthorizationError::ChildNotFound)?;
        if record.parent_id.as_deref() != Some(parent) {
            return Err(ChildAuthorizationError::Unauthorized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> SubagentSnapshot {
        SubagentSnapshot {
            sessions: [
                ("parent", None, None, false),
                ("child", Some("parent"), Some("Worker"), true),
                ("grandchild", Some("child"), None, false),
                ("other", None, None, false),
            ]
            .into_iter()
            .map(|(id, parent, title, running)| {
                (
                    id.to_owned(),
                    SubagentRecord {
                        id: id.to_owned(),
                        parent_id: parent.map(str::to_owned),
                        title: title.map(str::to_owned),
                        running,
                    },
                )
            })
            .collect(),
        }
    }

    #[test]
    fn list_projects_only_direct_children_and_nested_status() {
        let value = SubagentProcessor::list(&snapshot(), "parent");
        assert_eq!(value["parentAvailable"], true);
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0]["id"], "child");
        assert_eq!(value["entries"][0]["activity"], "running");
        assert_eq!(value["entries"][0]["hasChildren"], true);
        assert_eq!(value["entries"][0]["label"], "Worker");
    }

    #[test]
    fn authorization_distinguishes_all_failure_classes() {
        let snapshot = snapshot();
        assert_eq!(
            SubagentProcessor::authorize(&snapshot, "missing", "child"),
            Err(ChildAuthorizationError::ParentUnavailable)
        );
        assert_eq!(
            SubagentProcessor::authorize(&snapshot, "parent", "missing"),
            Err(ChildAuthorizationError::ChildNotFound)
        );
        assert_eq!(
            SubagentProcessor::authorize(&snapshot, "parent", "other"),
            Err(ChildAuthorizationError::Unauthorized)
        );
        assert_eq!(
            SubagentProcessor::authorize(&snapshot, "parent", "child"),
            Ok(())
        );
    }

    #[test]
    fn missing_parent_list_is_a_valid_empty_view() {
        let value = SubagentProcessor::list(&snapshot(), "missing");
        assert_eq!(value["parentAvailable"], false);
        assert!(value["entries"].as_array().unwrap().is_empty());
    }
}
