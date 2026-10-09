//! Route resolution plus exact, durable per-call human confirmation.
//! No provider loop or new tool is introduced here.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Weak;
use xharness_agent::AgentOperation;
use xharness_session::{ApprovalOutcome, EventData, Session};
use xharness_tools::{GuardDecision, MiddlewareError, MonotonicGuard, ToolExecutionContext};

use crate::{state::ModelSelection, BasicHost, ModelDescriptor, ModelRoute};

const BINDING_PREFIX: &str = "xharness.agent-model-approval.v1:";

#[derive(Default, Clone)]
pub(super) struct ModelOverride {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}
impl ModelOverride {
    pub(super) fn is_empty(&self) -> bool {
        self.provider.is_none() && self.model.is_none() && self.reasoning_effort.is_none()
    }
    pub(super) fn operation(&self, task: &str, label: &Option<String>) -> AgentOperation {
        AgentOperation::Start {
            task: task.into(),
            label: label.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
        }
    }
    pub(super) fn resolve(
        &self,
        parent: &ModelSelection,
        catalog: &[ModelDescriptor],
    ) -> Result<ModelSelection, String> {
        let provider = self.provider.as_ref().unwrap_or(&parent.provider).clone();
        let model = self.model.as_ref().unwrap_or(&parent.model).clone();
        let mut selected = if provider == parent.provider && model == parent.model {
            parent.clone()
        } else {
            let descriptor = catalog.iter().find(|d| d.provider == provider && d.model == model)
                .ok_or_else(|| format!("unknown configured model route {provider}/{model}; use agent inspect to list available models"))?;
            ModelSelection {
                provider,
                model,
                reasoning_effort: descriptor
                    .reasoning
                    .as_ref()
                    .and_then(|r| r.default_effort.clone()),
                // The target registry owns its context budget, not the parent.
                context_window_tokens: None,
            }
        };
        if let Some(effort) = &self.reasoning_effort {
            selected.reasoning_effort = Some(effort.clone());
        }
        Ok(selected)
    }
    pub(super) fn check_replay(&self, admitted: &ModelSelection) -> Result<(), String> {
        if self
            .provider
            .as_ref()
            .is_some_and(|v| v != &admitted.provider)
            || self.model.as_ref().is_some_and(|v| v != &admitted.model)
            || self
                .reasoning_effort
                .as_ref()
                .is_some_and(|v| Some(v) != admitted.reasoning_effort.as_ref())
        {
            return Err("invocation id already used for a different child model selection".into());
        }
        Ok(())
    }
}

pub(super) fn same_selection(a: &ModelSelection, b: &ModelSelection) -> bool {
    a.provider == b.provider
        && a.model == b.model
        && a.reasoning_effort == b.reasoning_effort
        && a.context_window_tokens == b.context_window_tokens
}
fn fingerprint(operation: &AgentOperation) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(operation).expect("typed agent operation serializes"))
    )
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalBinding {
    caller: String,
    invocation: String,
    operation_sha256: String,
    user_request_seq: Option<u64>,
    parent: ModelSelection,
    selected: ModelSelection,
}
fn binding_reason(
    caller: &str,
    invocation: &str,
    operation: &AgentOperation,
    session: &Session,
    parent: &ModelSelection,
    selected: &ModelSelection,
) -> String {
    let binding = ApprovalBinding {
        caller: caller.into(),
        invocation: invocation.into(),
        operation_sha256: fingerprint(operation),
        user_request_seq: session.latest_user_request().map(|(seq, _)| seq),
        parent: parent.clone(),
        selected: selected.clone(),
    };
    format!(
        "{BINDING_PREFIX}{}",
        serde_json::to_string(&binding).expect("model binding serializes")
    )
}
fn parse_binding(reason: &str) -> Option<ApprovalBinding> {
    // Guards are composed monotonically; another guard may add another line.
    let mut lines = reason
        .lines()
        .filter_map(|line| line.strip_prefix(BINDING_PREFIX));
    let binding = serde_json::from_str(lines.next()?).ok()?;
    if lines.next().is_some() {
        return None;
    }
    Some(binding)
}

pub(super) struct SelectionGuard {
    pub host: Weak<BasicHost>,
    pub caller: String,
}
#[async_trait]
impl MonotonicGuard for SelectionGuard {
    async fn evaluate(
        &self,
        context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError> {
        if context.definition.name != "agent" {
            return Ok(GuardDecision::Allow);
        }
        let operation: AgentOperation = serde_json::from_value((*context.arguments).clone())
            .map_err(|e| MiddlewareError::new(e.to_string()))?;
        operation.validate().map_err(MiddlewareError::new)?;
        let AgentOperation::Start {
            provider,
            model,
            reasoning_effort,
            ..
        } = &operation
        else {
            return Ok(GuardDecision::Allow);
        };
        let overrides = ModelOverride {
            provider: provider.clone(),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
        };
        if overrides.is_empty() {
            return Ok(GuardDecision::Allow);
        }
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| MiddlewareError::new("agent host is shutting down"))?;
        let parent = {
            let state = host.state.read().await;
            let parent = state
                .sessions
                .get(&self.caller)
                .ok_or_else(|| MiddlewareError::new("calling agent does not exist"))?;
            if parent.delegated {
                return Ok(GuardDecision::deny("children cannot start agents"));
            }
            let id = super::identity(&self.caller, context.execution_id.as_str());
            if state.sessions.get(&id).is_some_and(|s| {
                s.delegated && s.parent_session_id.as_deref() == Some(&self.caller)
            }) {
                // An admitted start is replayed, never rerouted; handler checks
                // the original receipt even if today's parent changed.
                return Ok(GuardDecision::Allow);
            }
            parent.model.clone()
        };
        let selected = overrides
            .resolve(&parent, &host.agent_runtime.model_catalog())
            .map_err(MiddlewareError::new)?;
        if !host.agent_runtime.can_route(&ModelRoute {
            provider: selected.provider.clone(),
            model: selected.model.clone(),
            reasoning_effort: selected.reasoning_effort.clone(),
            context_window_tokens: selected.context_window_tokens,
        }) {
            return Ok(GuardDecision::deny(
                "selected child model or reasoning effort is unavailable",
            ));
        }
        if same_selection(&parent, &selected) {
            return Ok(GuardDecision::Allow);
        }
        let session = host
            .agent_runtime
            .authoritative_session(&self.caller)
            .await
            .map_err(|e| MiddlewareError::new(e.to_string()))?
            .ok_or_else(|| {
                MiddlewareError::new("model override requires a durable user confirmation")
            })?;
        // Keep task/label in the operation hash, not duplicated in audit reason.
        Ok(GuardDecision::require_approval(binding_reason(
            &self.caller,
            context.execution_id.as_str(),
            &operation,
            &session,
            &parent,
            &selected,
        )))
    }
}

/// Host hard gate: a fake ApprovalProvider or an "authorized" tool argument
/// cannot replace the durable asked + allowed-once pair for this exact call.
pub(super) fn require_approval(
    session: &Session,
    caller: &str,
    invocation: &str,
    operation: &AgentOperation,
    parent: &ModelSelection,
    selected: &ModelSelection,
) -> Result<(), String> {
    let missing = || {
        "child model selection is user-controlled; this exact override requires the user's confirmation before admission".to_owned()
    };
    if session.events().iter().any(
        |e| matches!(e.data(),EventData::ToolResult { result,.. } if result.call_id==invocation),
    ) {
        return Err(missing());
    }
    let call = session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::ToolCall { call, .. } if call.id == invocation && call.name == "agent" => {
                Some(call)
            }
            _ => None,
        })
        .ok_or_else(missing)?;
    let recorded: AgentOperation =
        serde_json::from_str(&call.arguments_json).map_err(|_| missing())?;
    if &recorded != operation {
        return Err(missing());
    }
    let (asked_seq, approval_id, binding) = session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::ApprovalAsked {
                id,
                tool_name,
                call_id: Some(call_id),
                reason,
            } if tool_name == "agent" && call_id == invocation => Some((e.seq, id, reason)),
            _ => None,
        })
        .ok_or_else(missing)?;
    // Never fall back to an older grant if the latest request lost its binding.
    let binding = binding
        .as_deref()
        .and_then(parse_binding)
        .ok_or_else(missing)?;
    if binding.caller != caller
        || binding.invocation != invocation
        || binding.operation_sha256 != fingerprint(operation)
        || binding.user_request_seq != session.latest_user_request().map(|(seq, _)| seq)
        || !same_selection(&binding.parent, parent)
        || !same_selection(&binding.selected, selected)
    {
        return Err("child model confirmation is stale or does not match this exact operation; request fresh confirmation".into());
    }
    let approved = session.events().iter().any(|e| e.seq>asked_seq && matches!(e.data(),EventData::ApprovalDecided { id,outcome:ApprovalOutcome::AllowedOnce } if id==approval_id));
    if !approved {
        return Err(missing());
    }
    Ok(())
}

/// Manual UI uses the same approval card, with a useful route/effort label.
pub(crate) fn confirmation_reason(session: &Session, approval_id: &str) -> Option<String> {
    let binding = session.events().iter().rev().find_map(|e| match e.data() {
        EventData::ApprovalAsked {
            id,
            reason: Some(reason),
            ..
        } if id == approval_id => parse_binding(reason),
        _ => None,
    })?;
    let effort = binding
        .selected
        .reasoning_effort
        .as_deref()
        .unwrap_or("provider default");
    Some(format!("Create this child agent with {}/{} (reasoning: {effort}) instead of {}/{} (reasoning: {}). Confirm only if you requested this choice; the parent model stays unchanged.",
        binding.selected.provider,binding.selected.model,binding.parent.provider,binding.parent.model,binding.parent.reasoning_effort.as_deref().unwrap_or("provider default")))
}
pub(crate) fn human_confirmation_call(call: &xharness_core::ToolCall) -> bool {
    call.name == "agent"
        && serde_json::from_str::<AgentOperation>(&call.arguments_json).is_ok_and(|op| {
            matches!(op,AgentOperation::Start { provider,model,reasoning_effort,.. }
        if provider.is_some() || model.is_some() || reasoning_effort.is_some())
        })
}

pub(super) fn admitted_model(session: &Session) -> Option<ModelSelection> {
    let boundary = session
        .events()
        .iter()
        .position(|e| matches!(e.data(), EventData::AgentDelegated { .. }))?;
    session.events()[..boundary]
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::SessionModelSelected {
                provider,
                model,
                reasoning_effort,
                context_window_tokens,
            } => Some(ModelSelection {
                provider: provider.clone(),
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
                context_window_tokens: *context_window_tokens,
            }),
            _ => None,
        })
}
pub(super) fn catalog_view(catalog: &[ModelDescriptor]) -> Value {
    Value::Array(catalog.iter().map(|d|json!({"provider":d.provider,"model":d.model,
        "reasoning_efforts":d.reasoning.as_ref().map(|r|r.efforts.iter().map(|e|e.id.as_str()).collect::<Vec<_>>()).unwrap_or_default(),
        "default_reasoning_effort":d.reasoning.as_ref().and_then(|r|r.default_effort.as_deref())})).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_core::AgentMessage;
    use xharness_session::{SessionHeader, ToolCall};
    fn parent() -> ModelSelection {
        ModelSelection {
            provider: "p".into(),
            model: "main".into(),
            reasoning_effort: Some("high".into()),
            context_window_tokens: Some(200_000),
        }
    }
    fn catalog() -> Vec<ModelDescriptor> {
        vec![
            ModelDescriptor::new("p", "P", "small", "Small").with_reasoning(
                crate::ModelReasoning::new(vec![
                    crate::ModelReasoningEffort::new("off", "Off"),
                    crate::ModelReasoningEffort::new("vendor-3", "Custom"),
                ])
                .with_default("off"),
            ),
        ]
    }
    fn operation() -> AgentOperation {
        ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .operation("review", &None)
    }
    fn approved(outcome: Option<ApprovalOutcome>) -> Session {
        let mut session = Session::new(SessionHeader::new("caller")).unwrap();
        let call = ToolCall {
            id: "call".into(),
            name: "agent".into(),
            arguments_json: serde_json::to_string(&operation()).unwrap(),
            ..Default::default()
        };
        let mut message = AgentMessage::assistant("");
        message.tool_calls.push(call.clone());
        session
            .append_batch(
                session.revision(),
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: AgentMessage::user("use small"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message,
                        usage: None,
                    }
                    .into(),
                    EventData::ToolCall {
                        turn: 1,
                        step: 1,
                        call,
                    }
                    .into(),
                ],
            )
            .unwrap();
        let selected = ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .unwrap();
        let reason = binding_reason(
            "caller",
            "call",
            &operation(),
            &session,
            &parent(),
            &selected,
        );
        session
            .append(
                session.revision(),
                EventData::ApprovalAsked {
                    id: "approval".into(),
                    tool_name: "agent".into(),
                    call_id: Some("call".into()),
                    reason: Some(reason),
                },
            )
            .unwrap();
        if let Some(outcome) = outcome {
            session
                .append(
                    session.revision(),
                    EventData::ApprovalDecided {
                        id: "approval".into(),
                        outcome,
                    },
                )
                .unwrap();
        }
        session
    }
    #[test]
    fn route_defaults_and_custom_efforts_remain_provider_owned() {
        assert!(same_selection(
            &parent(),
            &ModelOverride::default()
                .resolve(&parent(), &catalog())
                .unwrap()
        ));
        let selected = ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .unwrap();
        assert_eq!(selected.reasoning_effort.as_deref(), Some("off"));
        assert_eq!(selected.context_window_tokens, None);
        let selected = ModelOverride {
            reasoning_effort: Some("low".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .unwrap();
        assert_eq!(selected.context_window_tokens, Some(200_000));
        assert!(ModelOverride {
            model: Some("unknown".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .is_err());
    }
    #[test]
    fn only_exact_allowed_once_can_admit_a_changed_route() {
        let selected = ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .unwrap();
        for outcome in [
            None,
            Some(ApprovalOutcome::Rejected),
            Some(ApprovalOutcome::Cancelled),
            Some(ApprovalOutcome::Unavailable),
        ] {
            assert!(require_approval(
                &approved(outcome),
                "caller",
                "call",
                &operation(),
                &parent(),
                &selected
            )
            .is_err());
        }
        let session = approved(Some(ApprovalOutcome::AllowedOnce));
        require_approval(
            &session,
            "caller",
            "call",
            &operation(),
            &parent(),
            &selected,
        )
        .unwrap();
        for (caller, call) in [("other", "call"), ("caller", "other")] {
            assert!(
                require_approval(&session, caller, call, &operation(), &parent(), &selected)
                    .is_err()
            );
        }
        let mut changed = parent();
        changed.reasoning_effort = Some("low".into());
        assert!(require_approval(
            &session,
            "caller",
            "call",
            &operation(),
            &changed,
            &selected
        )
        .is_err());
        let mut changed = selected.clone();
        changed.reasoning_effort = Some("vendor-3".into());
        assert!(require_approval(
            &session,
            "caller",
            "call",
            &operation(),
            &parent(),
            &changed
        )
        .is_err());
        assert!(require_approval(
            &session,
            "caller",
            "call",
            &ModelOverride {
                model: Some("small".into()),
                ..Default::default()
            }
            .operation("different task", &None),
            &parent(),
            &selected
        )
        .is_err());
        // A legally recorded approval for a different user-request cut is
        // stale. Do not invent a UserMessage in the middle of an open step.
        let mut events = session.events().to_vec();
        for event in &mut events {
            if let EventData::ApprovalAsked {
                reason: Some(reason),
                ..
            } = event.event.data_mut()
            {
                let mut binding = parse_binding(reason).unwrap();
                binding.user_request_seq = Some(999);
                *reason = format!(
                    "{BINDING_PREFIX}{}",
                    serde_json::to_string(&binding).unwrap()
                );
            }
        }
        let stale = Session::restore(session.header().clone(), session.revision(), events).unwrap();
        assert!(
            require_approval(&stale, "caller", "call", &operation(), &parent(), &selected).is_err()
        );
    }
    #[test]
    fn newer_or_settled_approval_cannot_reuse_an_older_grant() {
        let selected = ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .resolve(&parent(), &catalog())
        .unwrap();
        for reason in [
            None,
            Some("ordinary approval without a model binding".into()),
        ] {
            let mut session = approved(Some(ApprovalOutcome::AllowedOnce));
            session
                .append(
                    session.revision(),
                    EventData::ApprovalAsked {
                        id: "new-approval".into(),
                        tool_name: "agent".into(),
                        call_id: Some("call".into()),
                        reason,
                    },
                )
                .unwrap();
            assert!(require_approval(
                &session,
                "caller",
                "call",
                &operation(),
                &parent(),
                &selected
            )
            .is_err());
        }
        let mut session = approved(Some(ApprovalOutcome::AllowedOnce));
        let reason = binding_reason(
            "caller",
            "call",
            &operation(),
            &session,
            &parent(),
            &selected,
        );
        assert!(parse_binding(&format!("{reason}\n{reason}")).is_none());
        session
            .append(
                session.revision(),
                EventData::ApprovalAsked {
                    id: "new-approval".into(),
                    tool_name: "agent".into(),
                    call_id: Some("call".into()),
                    reason: Some(reason),
                },
            )
            .unwrap();
        session
            .append(
                session.revision(),
                EventData::ApprovalDecided {
                    id: "new-approval".into(),
                    outcome: ApprovalOutcome::Rejected,
                },
            )
            .unwrap();
        assert!(require_approval(
            &session,
            "caller",
            "call",
            &operation(),
            &parent(),
            &selected
        )
        .is_err());
        let mut session = approved(Some(ApprovalOutcome::AllowedOnce));
        session
            .append(
                session.revision(),
                EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: xharness_session::ToolResultData::error("call", "cancelled"),
                },
            )
            .unwrap();
        assert!(require_approval(
            &session,
            "caller",
            "call",
            &operation(),
            &parent(),
            &selected
        )
        .is_err());
    }
    #[test]
    fn original_model_receipt_ignores_later_user_changes_and_legacy_absence() {
        let mut session = Session::new(SessionHeader::new("child")).unwrap();
        let event = |model: &str| EventData::SessionModelSelected {
            provider: "p".into(),
            model: model.into(),
            reasoning_effort: Some("high".into()),
            context_window_tokens: Some(200_000),
        };
        let delegated = EventData::AgentDelegated {
            parent_session_id: "caller".into(),
            invocation_id: "call".into(),
            task: "review".into(),
        };
        session
            .append_batch(
                session.revision(),
                vec![
                    event("main").into(),
                    delegated.clone().into(),
                    event("small").into(),
                ],
            )
            .unwrap();
        assert!(same_selection(
            &admitted_model(&session).unwrap(),
            &parent()
        ));
        let mut legacy = Session::new(SessionHeader::new("legacy")).unwrap();
        legacy.append(legacy.revision(), delegated).unwrap();
        assert!(admitted_model(&legacy).is_none());
        ModelOverride {
            model: Some("main".into()),
            reasoning_effort: Some("high".into()),
            ..Default::default()
        }
        .check_replay(&parent())
        .unwrap();
        assert!(ModelOverride {
            model: Some("small".into()),
            ..Default::default()
        }
        .check_replay(&parent())
        .is_err());
    }
    #[test]
    fn observed_catalog_and_binding_text_do_not_grant_permission() {
        let view = catalog_view(&catalog());
        assert_eq!(view[0]["reasoning_efforts"], json!(["off", "vendor-3"]));
        assert_eq!(view[0].as_object().unwrap().len(), 4);
        let call = xharness_core::ToolCall {
            name: "agent".into(),
            arguments_json: serde_json::to_string(&operation()).unwrap(),
            ..Default::default()
        };
        assert!(human_confirmation_call(&call));
        let reason = confirmation_reason(&approved(None), "approval").unwrap();
        assert!(reason.contains("p/small"));
    }
}
