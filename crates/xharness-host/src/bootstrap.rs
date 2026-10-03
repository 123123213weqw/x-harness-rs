//! Trusted, provider-neutral bootstrap of one original Goal journal. No wakeup,
//! tools, credentials or model request. The caller owns the Store's writer lease
//! and must durably reserve the identity before allowing an empty-header retry.
use crate::{goal_processor::GoalProcessor, PermissionPreset};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use xharness_session::{
    EventData, GoalChange, GoalChangeKind, GoalSnapshotChange, SessionHeader,
    SessionMutationReceipt, Store,
};

const METHOD: &str = "host.bootstrap-goal/v1";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalBootstrapSpec {
    pub operation_id: String,
    pub session_id: String,
    pub goal_id: String,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub max_goal_rounds: u64,
    pub created_at_ms: u64,
    pub workspace: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub permission: PermissionPreset,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalBootstrapReceipt {
    pub operation_id: String,
    pub session_id: String,
    pub goal_id: String,
    pub fingerprint: String,
}
fn invalid() -> String {
    "Goal bootstrap identity, state or configuration is invalid".into()
}
impl GoalBootstrapSpec {
    pub fn fingerprint(&self) -> Result<String, String> {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && !s.starts_with('.')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        if ![&self.operation_id, &self.session_id, &self.goal_id]
            .iter()
            .all(|s| id(s))
            || self.objective.trim().is_empty()
            || self.objective.len() > 65536
            || self.acceptance_criteria.len() > 64
            || self
                .acceptance_criteria
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > 8192)
            || self.max_goal_rounds == 0
            || !std::path::Path::new(&self.workspace).is_absolute()
            || self.provider.trim().is_empty()
            || self.model.trim().is_empty()
            || self.context_window_tokens == Some(0)
        {
            return Err(invalid());
        }
        let data = serde_json::to_vec(self).map_err(|_| invalid())?;
        if data.len() > 256 * 1024 {
            return Err(invalid());
        }
        Ok(format!("{:x}", Sha256::digest(data)))
    }
}
/// Returns the ORIGINAL receipt even after the Goal was edited, stopped or
/// completed. Never resets route/preferences, emits UserInput, or wakes runtime.
pub async fn prepare_goal_session(
    store: &dyn Store,
    spec: &GoalBootstrapSpec,
    reserved_empty_header: bool,
) -> Result<GoalBootstrapReceipt, String> {
    let fingerprint = spec.fingerprint()?;
    let expected = GoalBootstrapReceipt {
        operation_id: spec.operation_id.clone(),
        session_id: spec.session_id.clone(),
        goal_id: spec.goal_id.clone(),
        fingerprint: fingerprint.clone(),
    };
    let old = store.load(&spec.session_id).await.map_err(|_| invalid())?;
    if let Some(session) = &old {
        for e in session.events() {
            if let EventData::SessionMutationCommitted { receipt } = e.data() {
                if receipt.rpc_id == spec.operation_id || receipt.method == METHOD {
                    if receipt.rpc_id != spec.operation_id
                        || receipt.method != METHOD
                        || receipt.fingerprint != fingerprint
                        || receipt.response
                            != serde_json::to_value(&expected).map_err(|_| invalid())?
                    {
                        return Err(invalid());
                    }
                    return Ok(expected);
                }
            }
        }
        if !reserved_empty_header
            || !session.events().is_empty()
            || session.header().created_at_ms != spec.created_at_ms
            || session.header().cwd.as_deref() != Some(spec.workspace.as_str())
        {
            return Err(invalid());
        }
    }
    let session = match old {
        Some(session) => session,
        None => store
            .create(SessionHeader {
                version: 1,
                id: spec.session_id.clone(),
                created_at_ms: spec.created_at_ms,
                cwd: Some(spec.workspace.clone()),
            })
            .await
            .map_err(|_| invalid())?,
    };
    let mutation = GoalProcessor::create(
        true,
        None,
        spec.goal_id.clone(),
        spec.objective.clone(),
        spec.max_goal_rounds,
        spec.created_at_ms,
    )
    .map_err(|_| invalid())?;
    let goal = mutation.goal;
    let mut events = crate::rpc::permission_events(spec.permission);
    events.push(
        EventData::SessionModelSelected {
            provider: spec.provider.clone(),
            model: spec.model.clone(),
            reasoning_effort: spec.reasoning_effort.clone(),
            context_window_tokens: spec.context_window_tokens,
        }
        .into(),
    );
    events.push(
        EventData::GoalChange {
            change: GoalChange::Snapshot(GoalSnapshotChange {
                kind: GoalChangeKind::GoalChange,
                version: 1,
                operation: mutation.operation,
                goal: goal.snapshot(),
                rounds_started: 0,
                created_at: goal.created_at,
                updated_at: goal.updated_at,
            }),
        }
        .into(),
    );
    events.push(crate::goals::enable_event(
        goal.snapshot(),
        0,
        None,
        spec.acceptance_criteria.clone(),
    )?);
    events.push(
        EventData::SessionMutationCommitted {
            receipt: SessionMutationReceipt {
                rpc_id: spec.operation_id.clone(),
                method: METHOD.into(),
                fingerprint,
                response: serde_json::to_value(&expected).map_err(|_| invalid())?,
                response_event_seq_field: None,
            },
        }
        .into(),
    );
    store
        .append(&spec.session_id, session.revision(), events)
        .await
        .map_err(|_| invalid())?;
    store.flush(&spec.session_id).await.map_err(|_| invalid())?;
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{MemorySessionStore, SessionEvent};
    fn spec() -> GoalBootstrapSpec {
        GoalBootstrapSpec {
            operation_id: "prepare-1".into(),
            session_id: "root-1".into(),
            goal_id: "goal-1".into(),
            objective: "Build and verify a small task".into(),
            acceptance_criteria: vec!["tests pass".into()],
            max_goal_rounds: u64::MAX,
            created_at_ms: 123,
            workspace: std::env::temp_dir()
                .join("bootstrap-workspace")
                .to_str()
                .unwrap()
                .into(),
            provider: "provider".into(),
            model: "model".into(),
            reasoning_effort: None,
            context_window_tokens: Some(32768),
            permission: PermissionPreset::DangerFullAccess,
        }
    }
    #[tokio::test]
    async fn bootstrap_is_one_goal_batch_without_user_message_and_replays_after_edit() {
        let store = MemorySessionStore::default();
        let spec = spec();
        let receipt = prepare_goal_session(&store, &spec, false).await.unwrap();
        let session = store.load(&spec.session_id).await.unwrap().unwrap();
        assert_eq!(session.revision().0, 1);
        assert_eq!(
            session
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::GoalChange { .. }))
                .count(),
            1
        );
        assert_eq!(
            session
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::GoalExecution { .. }))
                .count(),
            1
        );
        assert!(session
            .events()
            .iter()
            .all(|e| !matches!(e.data(), EventData::UserMessage { .. })));
        let edit: SessionEvent = EventData::SessionModelSelected {
            provider: "new".into(),
            model: "new".into(),
            reasoning_effort: None,
            context_window_tokens: None,
        }
        .into();
        store
            .append(&spec.session_id, session.revision(), vec![edit])
            .await
            .unwrap();
        assert_eq!(
            prepare_goal_session(&store, &spec, true).await.unwrap(),
            receipt
        );
        assert_eq!(
            store
                .load(&spec.session_id)
                .await
                .unwrap()
                .unwrap()
                .revision()
                .0,
            2
        );
    }
    #[tokio::test]
    async fn conflicting_bootstrap_does_not_modify_journal() {
        let store = MemorySessionStore::default();
        let original = spec();
        prepare_goal_session(&store, &original, false)
            .await
            .unwrap();
        for change in 0..4 {
            let mut spec = original.clone();
            match change {
                0 => spec.operation_id = "other".into(),
                1 => spec.objective = "other".into(),
                2 => spec.goal_id = "other".into(),
                _ => spec.provider = "other".into(),
            };
            assert!(prepare_goal_session(&store, &spec, true).await.is_err());
        }
        assert_eq!(
            store
                .load(&original.session_id)
                .await
                .unwrap()
                .unwrap()
                .revision()
                .0,
            1
        );
    }
    #[tokio::test]
    async fn empty_header_recovery_requires_reserved_identity_and_exact_header() {
        let store = MemorySessionStore::default();
        let spec = spec();
        store
            .create(SessionHeader {
                version: 1,
                id: spec.session_id.clone(),
                created_at_ms: spec.created_at_ms,
                cwd: Some(spec.workspace.clone()),
            })
            .await
            .unwrap();
        assert!(prepare_goal_session(&store, &spec, false).await.is_err());
        let mut bad = spec.clone();
        bad.created_at_ms += 1;
        assert!(prepare_goal_session(&store, &bad, true).await.is_err());
        prepare_goal_session(&store, &spec, true).await.unwrap();
    }
    #[tokio::test]
    async fn foreign_nonempty_journal_is_never_adopted() {
        let store = MemorySessionStore::default();
        let spec = spec();
        let session = store
            .create(SessionHeader {
                version: 1,
                id: spec.session_id.clone(),
                created_at_ms: spec.created_at_ms,
                cwd: Some(spec.workspace.clone()),
            })
            .await
            .unwrap();
        store
            .append(
                &spec.session_id,
                session.revision(),
                vec![EventData::PermissionPreset {
                    preset: "workspace-write".into(),
                }
                .into()],
            )
            .await
            .unwrap();
        assert!(prepare_goal_session(&store, &spec, true).await.is_err());
    }
    #[test]
    fn bootstrap_schema_and_bounds_are_strict() {
        let spec = spec();
        assert!(spec.fingerprint().is_ok());
        for change in 0..6 {
            let mut spec = spec.clone();
            match change {
                0 => spec.max_goal_rounds = 0,
                1 => spec.session_id = "../root".into(),
                2 => spec.objective = " ".into(),
                3 => spec.context_window_tokens = Some(0),
                4 => spec.acceptance_criteria = vec!["ok".into(); 65],
                _ => spec.objective = "a".repeat(65537),
            };
            assert!(spec.fingerprint().is_err());
        }
        let mut value = serde_json::to_value(&spec).unwrap();
        value["api_key"] = serde_json::json!("not-a-key");
        assert!(serde_json::from_value::<GoalBootstrapSpec>(value).is_err());
    }
}
