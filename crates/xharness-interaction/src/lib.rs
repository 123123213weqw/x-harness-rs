//! Provider-neutral, durable user-question contracts.
//!
//! `ask_user_question` is registered through the ordinary XHarness Tool
//! Registry, but settles through a session-scoped external provider. This
//! keeps model-facing schemas unified while allowing the Host to persist a
//! question, release process resources, survive restart and later resume the
//! original tool call.

use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xharness_tools::{
    RegistryError, ToolConcurrency, ToolDefinition, ToolHandlerError, ToolOutput, ToolRegistry,
    ToolSpec,
};

pub const ASK_USER_QUESTION_TOOL: &str = "ask_user_question";
pub const MAX_QUESTIONS: usize = 3;
pub const MAX_OPTIONS_PER_QUESTION: usize = 3;
const MAX_ID_CHARS: usize = 64;
const MAX_HEADER_CHARS: usize = 40;
const MAX_QUESTION_CHARS: usize = 1_000;
const MAX_LABEL_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_CUSTOM_ANSWER_CHARS: usize = 8 * 1024;

const fn default_allow_custom() -> bool {
    true
}

/// Where an accepted answer remains visible after the current tool result.
///
/// Both variants are returned to the current model step. `AgentMarkdown`
/// additionally asks the Host's persistence adapter to write a normalized
/// note into its managed AGENTS.md memory section. No model-supplied path is
/// accepted by this contract.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerDestination {
    #[default]
    Context,
    AgentMarkdown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionSpec {
    pub id: String,
    pub header: String,
    pub question: String,
    /// Zero to three finite choices. A pure free-text question uses no
    /// options and sets `allow_custom=true`.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    /// Allow free text either as an alternative to a finite choice or as an
    /// additional qualification of the selected choice.
    #[serde(default = "default_allow_custom")]
    pub allow_custom: bool,
    /// Short-lived answers stay in the current context. Durable goals can be
    /// routed to the Host-managed AGENTS.md memory sink.
    #[serde(default)]
    pub destination: AnswerDestination,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskUserQuestionRequest {
    pub questions: Vec<QuestionSpec>,
}

impl AskUserQuestionRequest {
    pub fn validate(&self) -> Result<(), QuestionValidationError> {
        if self.questions.is_empty() || self.questions.len() > MAX_QUESTIONS {
            return Err(QuestionValidationError::QuestionCount {
                actual: self.questions.len(),
            });
        }
        let mut ids = BTreeMap::new();
        for (index, question) in self.questions.iter().enumerate() {
            validate_identifier(&question.id, format!("questions[{index}].id"))?;
            if ids.insert(question.id.as_str(), index).is_some() {
                return Err(QuestionValidationError::DuplicateQuestionId(
                    question.id.clone(),
                ));
            }
            validate_text(
                &question.header,
                MAX_HEADER_CHARS,
                format!("questions[{index}].header"),
            )?;
            validate_text(
                &question.question,
                MAX_QUESTION_CHARS,
                format!("questions[{index}].question"),
            )?;
            if question.options.len() > MAX_OPTIONS_PER_QUESTION {
                return Err(QuestionValidationError::OptionCount {
                    question_id: question.id.clone(),
                    actual: question.options.len(),
                });
            }
            if question.options.is_empty() && !question.allow_custom {
                return Err(QuestionValidationError::NoAnswerMode(question.id.clone()));
            }
            let mut option_ids = BTreeMap::new();
            let mut option_labels = BTreeMap::new();
            let mut recommended = 0usize;
            for (option_index, option) in question.options.iter().enumerate() {
                validate_identifier(
                    &option.id,
                    format!("questions[{index}].options[{option_index}].id"),
                )?;
                if option_ids
                    .insert(option.id.as_str(), option_index)
                    .is_some()
                {
                    return Err(QuestionValidationError::DuplicateOptionId {
                        question_id: question.id.clone(),
                        option_id: option.id.clone(),
                    });
                }
                if option_labels
                    .insert(option.label.trim(), option_index)
                    .is_some()
                {
                    return Err(QuestionValidationError::DuplicateOptionLabel {
                        question_id: question.id.clone(),
                        label: option.label.clone(),
                    });
                }
                validate_text(
                    &option.label,
                    MAX_LABEL_CHARS,
                    format!("questions[{index}].options[{option_index}].label"),
                )?;
                if let Some(description) = &option.description {
                    validate_optional_text(
                        description,
                        MAX_DESCRIPTION_CHARS,
                        format!("questions[{index}].options[{option_index}].description"),
                    )?;
                }
                recommended += usize::from(option.recommended);
            }
            if recommended > 1 {
                return Err(QuestionValidationError::MultipleRecommended(
                    question.id.clone(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswer {
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_option_id: Option<String>,
    /// May accompany a selection when the user wants to qualify it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveAction {
    /// Every question must contain a valid answer.
    Submit,
    /// Continue the same turn with any partial answers. Missing answers are
    /// reported to the model instead of turning into a tool error.
    Continue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus {
    Answered,
    PartiallyAnswered,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedAnswer {
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
    pub destination: AnswerDestination,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionResolution {
    pub status: ResolutionStatus,
    pub action: ResolveAction,
    pub answers: Vec<ResolvedAnswer>,
    pub unanswered_question_ids: Vec<String>,
}

impl QuestionResolution {
    pub fn requests_agent_markdown(&self) -> bool {
        self.answers
            .iter()
            .any(|answer| answer.destination == AnswerDestination::AgentMarkdown)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionInvocation {
    pub interaction_id: String,
    pub execution_id: String,
    pub request: AskUserQuestionRequest,
}

impl QuestionInvocation {
    pub fn new(execution_id: impl Into<String>, request: AskUserQuestionRequest) -> Self {
        let execution_id = execution_id.into();
        Self {
            interaction_id: format!("question:{execution_id}"),
            execution_id,
            request,
        }
    }
}

/// Persistable interaction vocabulary. `DraftUpdated` is internal state;
/// requested/resolved are also projected as the existing upstream Mux frames.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum QuestionEvent {
    #[serde(rename = "question/requested")]
    Requested { invocation: QuestionInvocation },
    #[serde(rename = "question/draft-updated")]
    DraftUpdated {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        answers: Vec<QuestionAnswer>,
    },
    #[serde(rename = "question/resolved")]
    Resolved {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        resolution: QuestionResolution,
    },
    #[serde(rename = "question/cancelled")]
    Cancelled {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum InteractionTerminal {
    Resolved(QuestionResolution),
    Cancelled(String),
}

/// Public, serialization-free view of an interaction's settlement state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuestionTerminalState {
    Pending,
    Resolved(QuestionResolution),
    Cancelled(String),
}

/// Pure state machine used by durable providers and UI tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionInteraction {
    invocation: QuestionInvocation,
    draft: BTreeMap<String, QuestionAnswer>,
    terminal: Option<InteractionTerminal>,
}

impl QuestionInteraction {
    pub fn new(invocation: QuestionInvocation) -> Result<Self, QuestionValidationError> {
        invocation.request.validate()?;
        Ok(Self {
            invocation,
            draft: BTreeMap::new(),
            terminal: None,
        })
    }

    pub fn invocation(&self) -> &QuestionInvocation {
        &self.invocation
    }

    pub fn draft(&self) -> Vec<QuestionAnswer> {
        self.invocation
            .request
            .questions
            .iter()
            .filter_map(|question| self.draft.get(&question.id).cloned())
            .collect()
    }

    pub fn terminal_state(&self) -> QuestionTerminalState {
        match &self.terminal {
            None => QuestionTerminalState::Pending,
            Some(InteractionTerminal::Resolved(resolution)) => {
                QuestionTerminalState::Resolved(resolution.clone())
            }
            Some(InteractionTerminal::Cancelled(reason)) => {
                QuestionTerminalState::Cancelled(reason.clone())
            }
        }
    }

    /// Merge a partial draft. Closing/minimizing the UI does not call another
    /// state transition, so the interaction remains pending with this draft.
    pub fn update_draft(
        &mut self,
        answers: Vec<QuestionAnswer>,
    ) -> Result<Vec<QuestionAnswer>, QuestionStateError> {
        self.ensure_pending()?;
        let mut incoming = BTreeMap::new();
        for answer in answers {
            if incoming.insert(answer.question_id.clone(), ()).is_some() {
                return Err(QuestionStateError::DuplicateAnswer(answer.question_id));
            }
            let question = self.question(&answer.question_id)?;
            validate_answer(question, &answer, true)?;
            if answer.selected_option_id.is_none()
                && answer
                    .custom_text
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .is_empty()
            {
                self.draft.remove(&answer.question_id);
            } else {
                self.draft.insert(answer.question_id.clone(), answer);
            }
        }
        Ok(self.draft())
    }

    /// UI dismissal is deliberately not a resolution. Draft and pending state
    /// remain intact so reopening or reconnecting can continue the question.
    pub fn dismiss(&self) -> Result<Vec<QuestionAnswer>, QuestionStateError> {
        self.ensure_pending()?;
        Ok(self.draft())
    }

    pub fn resolve(
        &mut self,
        action: ResolveAction,
        answers: Vec<QuestionAnswer>,
    ) -> Result<QuestionResolution, QuestionStateError> {
        if let Some(terminal) = &self.terminal {
            return match terminal {
                InteractionTerminal::Resolved(existing) => {
                    let requested = build_resolution(&self.invocation.request, action, answers)?;
                    if existing == &requested {
                        Ok(existing.clone())
                    } else {
                        Err(QuestionStateError::AlreadyResolved)
                    }
                }
                InteractionTerminal::Cancelled(_) => Err(QuestionStateError::Cancelled),
            };
        }
        self.update_draft(answers)?;
        let resolution = build_resolution(&self.invocation.request, action, self.draft())?;
        self.terminal = Some(InteractionTerminal::Resolved(resolution.clone()));
        Ok(resolution)
    }

    pub fn cancel(&mut self, reason: impl Into<String>) -> Result<(), QuestionStateError> {
        let reason = reason.into();
        match &self.terminal {
            None => {
                self.terminal = Some(InteractionTerminal::Cancelled(reason));
                Ok(())
            }
            Some(InteractionTerminal::Cancelled(existing)) if existing == &reason => Ok(()),
            Some(InteractionTerminal::Cancelled(_)) => Err(QuestionStateError::Cancelled),
            Some(InteractionTerminal::Resolved(_)) => Err(QuestionStateError::AlreadyResolved),
        }
    }

    fn question(&self, id: &str) -> Result<&QuestionSpec, QuestionStateError> {
        self.invocation
            .request
            .questions
            .iter()
            .find(|question| question.id == id)
            .ok_or_else(|| QuestionStateError::UnknownQuestion(id.to_owned()))
    }

    fn ensure_pending(&self) -> Result<(), QuestionStateError> {
        match self.terminal {
            None => Ok(()),
            Some(InteractionTerminal::Resolved(_)) => Err(QuestionStateError::AlreadyResolved),
            Some(InteractionTerminal::Cancelled(_)) => Err(QuestionStateError::Cancelled),
        }
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum QuestionValidationError {
    #[error("ask_user_question requires between 1 and 3 questions, got {actual}")]
    QuestionCount { actual: usize },
    #[error("question {question_id:?} allows at most 3 options, got {actual}")]
    OptionCount { question_id: String, actual: usize },
    #[error("duplicate question id {0:?}")]
    DuplicateQuestionId(String),
    #[error("question {question_id:?} has duplicate option id {option_id:?}")]
    DuplicateOptionId {
        question_id: String,
        option_id: String,
    },
    #[error("question {question_id:?} has duplicate option label {label:?}")]
    DuplicateOptionLabel { question_id: String, label: String },
    #[error("question {0:?} needs finite options or allowCustom=true")]
    NoAnswerMode(String),
    #[error("question {0:?} has more than one recommended option")]
    MultipleRecommended(String),
    #[error("{field} must be non-empty and at most {max} characters")]
    InvalidText { field: String, max: usize },
    #[error("{field} must be a 1-64 character ASCII identifier")]
    InvalidIdentifier { field: String },
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum QuestionStateError {
    #[error("unknown question {0:?}")]
    UnknownQuestion(String),
    #[error("question {0:?} appears more than once in one answer submission")]
    DuplicateAnswer(String),
    #[error("question {question_id:?} has unknown option {option_id:?}")]
    UnknownOption {
        question_id: String,
        option_id: String,
    },
    #[error("question {0:?} does not allow a custom answer")]
    CustomNotAllowed(String),
    #[error("question {0:?} custom answer exceeds 8192 characters")]
    CustomTooLong(String),
    #[error("submit requires answers for {0:?}")]
    MissingAnswers(Vec<String>),
    #[error("interaction is already resolved with a different result")]
    AlreadyResolved,
    #[error("interaction was cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("user-question provider failed: {message}")]
pub struct QuestionProviderError {
    pub message: String,
    pub retryable: bool,
}

impl QuestionProviderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

#[async_trait]
pub trait UserQuestionProvider: Send + Sync + 'static {
    /// Implementations must persist `question/requested` before waiting and
    /// persist `question/resolved` before returning. They may release all
    /// process resources while pending and rebuild from the session log.
    async fn ask(
        &self,
        invocation: QuestionInvocation,
        cancellation: CancellationToken,
    ) -> Result<QuestionResolution, QuestionProviderError>;
}

#[derive(Clone)]
pub struct AskUserQuestionTool {
    provider: Arc<dyn UserQuestionProvider>,
}

impl AskUserQuestionTool {
    pub fn new(provider: Arc<dyn UserQuestionProvider>) -> Self {
        Self { provider }
    }

    pub fn spec(&self) -> ToolSpec {
        let provider = Arc::clone(&self.provider);
        ToolSpec::new(tool_definition(), move |context| {
            let provider = Arc::clone(&provider);
            async move {
                let request: AskUserQuestionRequest =
                    serde_json::from_value(context.arguments.as_ref().clone())
                        .map_err(|error| ToolHandlerError::new(error.to_string()))?;
                request
                    .validate()
                    .map_err(|error| ToolHandlerError::new(error.to_string()))?;
                let invocation = QuestionInvocation::new(context.execution_id.as_str(), request);
                let resolution = provider
                    .ask(invocation.clone(), context.cancellation.clone())
                    .await
                    .map_err(|error| ToolHandlerError {
                        message: error.message,
                        retryable: error.retryable,
                    })?;
                let content = serde_json::to_string(&resolution)
                    .map_err(|error| ToolHandlerError::new(error.to_string()))?;
                Ok(ToolOutput {
                    content,
                    metadata: Some(json!({
                        "interactionId": invocation.interaction_id,
                        "status": resolution.status,
                        "requestsAgentMarkdown": resolution.requests_agent_markdown(),
                    })),
                })
            }
        })
        .with_concurrency(ToolConcurrency::Exclusive)
        .with_external_settlement()
        .requiring_standalone_batch()
    }

    pub async fn register(&self, registry: &ToolRegistry) -> Result<(), RegistryError> {
        registry.register(self.spec()).await?;
        Ok(())
    }
}

pub fn tool_definition() -> ToolDefinition {
    ToolDefinition::new(
        ASK_USER_QUESTION_TOOL,
        "Ask the user only when a user decision or unavailable fact blocks safe progress. Inspect available context and tools first. Ask 1-3 concise questions. For a boolean or finite decision, provide at most 3 choices; allowCustom lets the user provide or qualify an answer. Use destination=context for short-lived decisions and agent_markdown only for an explicitly durable goal. Call this tool alone, never in a batch with side-effecting tools.",
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "header": {"type": "string"},
                            "question": {"type": "string"},
                            "options": {
                                "type": "array",
                                "maxItems": 3,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "string"},
                                        "label": {"type": "string"},
                                        "description": {"type": "string"},
                                        "recommended": {"type": "boolean"}
                                    },
                                    "required": ["id", "label"],
                                    "additionalProperties": false
                                }
                            },
                            "allowCustom": {
                                "type": "boolean",
                                "default": true,
                                "description": "Whether the user may type their own answer; defaults to true."
                            },
                            "destination": {
                                "type": "string",
                                "enum": ["context", "agent_markdown"]
                            }
                        },
                        "required": ["id", "header", "question"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["questions"],
            "additionalProperties": false
        }),
    )
}

fn build_resolution(
    request: &AskUserQuestionRequest,
    action: ResolveAction,
    answers: Vec<QuestionAnswer>,
) -> Result<QuestionResolution, QuestionStateError> {
    let mut by_id = BTreeMap::new();
    for answer in answers {
        let question = request
            .questions
            .iter()
            .find(|question| question.id == answer.question_id)
            .ok_or_else(|| QuestionStateError::UnknownQuestion(answer.question_id.clone()))?;
        validate_answer(question, &answer, false)?;
        if by_id.insert(answer.question_id.clone(), answer).is_some() {
            return Err(QuestionStateError::DuplicateAnswer(question.id.clone()));
        }
    }

    let unanswered_question_ids = request
        .questions
        .iter()
        .filter(|question| !by_id.contains_key(&question.id))
        .map(|question| question.id.clone())
        .collect::<Vec<_>>();
    if action == ResolveAction::Submit && !unanswered_question_ids.is_empty() {
        return Err(QuestionStateError::MissingAnswers(unanswered_question_ids));
    }

    let resolved = request
        .questions
        .iter()
        .filter_map(|question| {
            let answer = by_id.get(&question.id)?;
            let selected_label = answer.selected_option_id.as_ref().and_then(|id| {
                question
                    .options
                    .iter()
                    .find(|option| option.id == *id)
                    .map(|option| option.label.clone())
            });
            Some(ResolvedAnswer {
                question_id: question.id.clone(),
                selected_option_id: answer.selected_option_id.clone(),
                selected_label,
                custom_text: answer
                    .custom_text
                    .as_ref()
                    .map(|text| text.trim().to_owned())
                    .filter(|text| !text.is_empty()),
                destination: question.destination,
            })
        })
        .collect::<Vec<_>>();
    let status = if resolved.is_empty() {
        ResolutionStatus::Skipped
    } else if unanswered_question_ids.is_empty() {
        ResolutionStatus::Answered
    } else {
        ResolutionStatus::PartiallyAnswered
    };
    Ok(QuestionResolution {
        status,
        action,
        answers: resolved,
        unanswered_question_ids,
    })
}

fn validate_answer(
    question: &QuestionSpec,
    answer: &QuestionAnswer,
    draft: bool,
) -> Result<(), QuestionStateError> {
    if let Some(option_id) = &answer.selected_option_id {
        if !question
            .options
            .iter()
            .any(|option| option.id == *option_id)
        {
            return Err(QuestionStateError::UnknownOption {
                question_id: question.id.clone(),
                option_id: option_id.clone(),
            });
        }
    }
    if let Some(text) = &answer.custom_text {
        if !text.trim().is_empty() && !question.allow_custom {
            return Err(QuestionStateError::CustomNotAllowed(question.id.clone()));
        }
        if text.chars().count() > MAX_CUSTOM_ANSWER_CHARS {
            return Err(QuestionStateError::CustomTooLong(question.id.clone()));
        }
    }
    let has_text = answer
        .custom_text
        .as_deref()
        .map(str::trim)
        .is_some_and(|text| !text.is_empty());
    if !draft && answer.selected_option_id.is_none() && !has_text {
        return Err(QuestionStateError::MissingAnswers(vec![question
            .id
            .clone()]));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: String) -> Result<(), QuestionValidationError> {
    if value.is_empty()
        || value.chars().count() > MAX_ID_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(QuestionValidationError::InvalidIdentifier { field });
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, field: String) -> Result<(), QuestionValidationError> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(QuestionValidationError::InvalidText { field, max });
    }
    Ok(())
}

fn validate_optional_text(
    value: &str,
    max: usize,
    field: String,
) -> Result<(), QuestionValidationError> {
    if value.chars().count() > max {
        return Err(QuestionValidationError::InvalidText { field, max });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_tools::{ToolExecutor, ToolRequest};

    fn question(id: &str, destination: AnswerDestination) -> QuestionSpec {
        QuestionSpec {
            id: id.to_owned(),
            header: "目标".to_owned(),
            question: "选择部署目标".to_owned(),
            options: vec![
                QuestionOption {
                    id: "tokyo".to_owned(),
                    label: "东京".to_owned(),
                    description: None,
                    recommended: true,
                },
                QuestionOption {
                    id: "local".to_owned(),
                    label: "本机".to_owned(),
                    description: None,
                    recommended: false,
                },
            ],
            allow_custom: true,
            destination,
        }
    }

    fn invocation(questions: Vec<QuestionSpec>) -> QuestionInvocation {
        QuestionInvocation::new("exec-1", AskUserQuestionRequest { questions })
    }

    fn answer(id: &str, option: &str) -> QuestionAnswer {
        QuestionAnswer {
            question_id: id.to_owned(),
            selected_option_id: Some(option.to_owned()),
            custom_text: None,
        }
    }

    #[test]
    fn request_limits_questions_options_and_recommended_choice() {
        let mut questions = vec![question("one", AnswerDestination::Context); 4];
        for (index, item) in questions.iter_mut().enumerate() {
            item.id = format!("q{index}");
        }
        assert!(matches!(
            AskUserQuestionRequest { questions }.validate(),
            Err(QuestionValidationError::QuestionCount { actual: 4 })
        ));

        let mut invalid = question("one", AnswerDestination::Context);
        invalid.options.push(QuestionOption {
            id: "third".to_owned(),
            label: "第三个".to_owned(),
            description: None,
            recommended: false,
        });
        invalid.options.push(QuestionOption {
            id: "fourth".to_owned(),
            label: "第四个".to_owned(),
            description: None,
            recommended: false,
        });
        assert!(matches!(
            AskUserQuestionRequest {
                questions: vec![invalid]
            }
            .validate(),
            Err(QuestionValidationError::OptionCount { actual: 4, .. })
        ));
    }

    #[test]
    fn finite_choice_can_include_qualifying_custom_text() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Submit,
                vec![QuestionAnswer {
                    question_id: "target".to_owned(),
                    selected_option_id: Some("tokyo".to_owned()),
                    custom_text: Some("使用 8443 端口".to_owned()),
                }],
            )
            .unwrap();
        assert_eq!(resolution.status, ResolutionStatus::Answered);
        assert_eq!(
            resolution.answers[0].selected_label.as_deref(),
            Some("东京")
        );
        assert_eq!(
            resolution.answers[0].custom_text.as_deref(),
            Some("使用 8443 端口")
        );
    }

    #[test]
    fn half_answered_draft_survives_dismiss_and_can_continue() {
        let mut interaction = QuestionInteraction::new(invocation(vec![
            question("target", AnswerDestination::Context),
            question("auth", AnswerDestination::Context),
        ]))
        .unwrap();
        interaction
            .update_draft(vec![answer("target", "tokyo")])
            .unwrap();
        assert_eq!(interaction.dismiss().unwrap().len(), 1);

        let resolution = interaction
            .resolve(ResolveAction::Continue, Vec::new())
            .unwrap();
        assert_eq!(resolution.status, ResolutionStatus::PartiallyAnswered);
        assert_eq!(resolution.unanswered_question_ids, vec!["auth"]);
    }

    #[test]
    fn continue_without_any_answer_is_a_successful_skip() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        let resolution = interaction
            .resolve(ResolveAction::Continue, Vec::new())
            .unwrap();
        assert_eq!(resolution.status, ResolutionStatus::Skipped);
        assert!(resolution.answers.is_empty());
        assert_eq!(resolution.unanswered_question_ids, vec!["target"]);
    }

    #[test]
    fn pure_custom_answer_is_supported_and_unknown_choice_is_rejected() {
        let mut free_text = question("details", AnswerDestination::Context);
        free_text.options.clear();
        let mut interaction = QuestionInteraction::new(invocation(vec![free_text])).unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Submit,
                vec![QuestionAnswer {
                    question_id: "details".to_owned(),
                    selected_option_id: None,
                    custom_text: Some("只部署 API，不部署网页".to_owned()),
                }],
            )
            .unwrap();
        assert_eq!(resolution.status, ResolutionStatus::Answered);

        let mut invalid = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        assert!(matches!(
            invalid.resolve(ResolveAction::Submit, vec![answer("target", "missing")]),
            Err(QuestionStateError::UnknownOption { .. })
        ));
    }

    #[test]
    fn cancellation_is_idempotent_and_prevents_late_answers() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        interaction.cancel("turn cancelled").unwrap();
        interaction.cancel("turn cancelled").unwrap();
        assert_eq!(
            interaction.resolve(ResolveAction::Submit, vec![answer("target", "tokyo")]),
            Err(QuestionStateError::Cancelled)
        );
        assert_eq!(
            interaction.cancel("different reason"),
            Err(QuestionStateError::Cancelled)
        );
    }

    #[test]
    fn one_submission_cannot_answer_the_same_question_twice() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        assert_eq!(
            interaction.resolve(
                ResolveAction::Submit,
                vec![answer("target", "tokyo"), answer("target", "local")],
            ),
            Err(QuestionStateError::DuplicateAnswer("target".to_owned()))
        );
    }

    #[test]
    fn submit_requires_all_answers_and_resolution_is_idempotent() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "target",
            AnswerDestination::Context,
        )]))
        .unwrap();
        assert!(matches!(
            interaction.resolve(ResolveAction::Submit, Vec::new()),
            Err(QuestionStateError::MissingAnswers(_))
        ));
        let expected = interaction
            .resolve(ResolveAction::Submit, vec![answer("target", "tokyo")])
            .unwrap();
        assert_eq!(
            interaction
                .resolve(ResolveAction::Submit, vec![answer("target", "tokyo")])
                .unwrap(),
            expected
        );
        assert_eq!(
            interaction.resolve(ResolveAction::Submit, vec![answer("target", "local")]),
            Err(QuestionStateError::AlreadyResolved)
        );
    }

    #[test]
    fn agent_markdown_is_a_managed_destination_not_a_model_path() {
        let mut interaction = QuestionInteraction::new(invocation(vec![question(
            "goal",
            AnswerDestination::AgentMarkdown,
        )]))
        .unwrap();
        let resolution = interaction
            .resolve(ResolveAction::Submit, vec![answer("goal", "tokyo")])
            .unwrap();
        assert!(resolution.requests_agent_markdown());
        let encoded = serde_json::to_string(&interaction.invocation().request).unwrap();
        assert!(!encoded.contains("path"));
    }

    struct ImmediateProvider;

    #[async_trait]
    impl UserQuestionProvider for ImmediateProvider {
        async fn ask(
            &self,
            invocation: QuestionInvocation,
            _cancellation: CancellationToken,
        ) -> Result<QuestionResolution, QuestionProviderError> {
            let mut interaction = QuestionInteraction::new(invocation)
                .map_err(|error| QuestionProviderError::new(error.to_string()))?;
            interaction
                .resolve(ResolveAction::Continue, Vec::new())
                .map_err(|error| QuestionProviderError::new(error.to_string()))
        }
    }

    #[tokio::test]
    async fn question_tool_reuses_registry_and_returns_structured_skip() {
        let registry = Arc::new(ToolRegistry::new());
        AskUserQuestionTool::new(Arc::new(ImmediateProvider))
            .register(&registry)
            .await
            .unwrap();
        let definitions = registry.definitions().await;
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, ASK_USER_QUESTION_TOOL);

        let result = ToolExecutor::new(registry)
            .execute(
                ToolRequest::new(
                    ASK_USER_QUESTION_TOOL,
                    serde_json::to_string(&AskUserQuestionRequest {
                        questions: vec![question("target", AnswerDestination::Context)],
                    })
                    .unwrap(),
                )
                .with_execution_id("durable-execution")
                .unwrap(),
            )
            .await;
        assert!(result.is_ok());
        let resolution: QuestionResolution =
            serde_json::from_str(&result.output.unwrap().content).unwrap();
        assert_eq!(resolution.status, ResolutionStatus::Skipped);
    }
}
