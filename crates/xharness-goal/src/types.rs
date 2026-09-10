use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
pub use xharness_session::{GoalBlockReason, GoalPhase, GoalSnapshot, Revision};

/// Proposed execution view around the existing authoritative GoalSnapshot.
/// This is NOT a v2 persisted event or a migration implementation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalDefinition {
    pub snapshot: GoalSnapshot,
    pub definition_revision: u64,
    pub acceptance_criteria: Vec<String>,
    pub execution_enabled: bool,
    pub verification: VerificationMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationMode {
    /// Accept a scoped, settled agent claim; this is not independent proof.
    AgentReport,
    UserConfirm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GoalEvidence {
    ToolResult {
        execution_id: String,
    },
    /// A reference only; decide never reads a path or executes a command.
    Artifact {
        reference: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalReportStatus {
    Progress,
    Blocked,
    Complete,
}

/// Host-bound report envelope. Identity fields must come from the authenticated
/// tool invocation, NOT be trusted directly from model-controlled arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalReport {
    pub goal_id: String,
    pub definition_revision: u64,
    pub turn: u32,
    pub report_id: String,
    pub status: GoalReportStatus,
    pub summary: String,
    pub remaining: Vec<String>,
    pub evidence: Vec<GoalEvidence>,
    pub blocked_reason: Option<GoalBlockReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalTurnOutcome {
    Completed,
    Cancelled,
    Failed,
    StepLimit,
    OutputLimit,
    OutcomeUnknown,
}

/// Latest settled Goal-owned turn for this activation/definition, if any.
/// Ordinary user turns must not be substituted for a Goal round.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalTurnResult {
    pub goal_id: String,
    pub definition_revision: u64,
    pub activation_epoch: u64,
    pub turn: u32,
    pub outcome: GoalTurnOutcome,
    pub report: Option<GoalReport>,
}

/// Trusted user/checker decision, scoped to the exact completion claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionReview {
    pub goal_id: String,
    pub definition_revision: u64,
    pub report_id: String,
    pub verdict: ReviewVerdict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Idle,
    Running,
    AwaitingApproval,
    AwaitingAnswer,
    NeedsRecovery,
}

/// Stable structured id; avoids delimiter collisions and random retry IDs.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationKey {
    pub goal_id: String,
    pub definition_revision: u64,
    pub activation_epoch: u64,
    pub cause: ContinuationCause,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContinuationCause {
    Initial,
    AfterTurn { turn: u32 },
}

/// Small consistent projection, assembled by a future Host/Runtime adapter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalObservation {
    pub goal: Option<GoalDefinition>,
    pub session_revision: Revision,
    pub activation_epoch: u64,
    pub runtime: RuntimeState,
    pub pending_user_input: bool,
    /// Only necessary Goal-owned dependencies, not every job in the session.
    pub unresolved_dependencies: bool,
    pub rounds_started: u64,
    pub latest_turn: Option<GoalTurnResult>,
    pub completion_review: Option<CompletionReview>,
    pub pending_intent: Option<ContinuationKey>,
    /// Durable receipts relevant to this goal; never inferred from callbacks.
    pub admitted_intents: BTreeSet<ContinuationKey>,
    /// Host-derived streak with neither a valid report nor a settled tool action.
    /// Reset on new activation/definition; no text-similarity judge involved.
    pub empty_report_rounds: u32,
    pub empty_report_limit: u32,
}

/// Revalidate ALL fields under the existing admission fence before mutation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalFence {
    pub session_revision: Revision,
    pub goal_id: String,
    pub goal_revision: u64,
    pub definition_revision: u64,
    pub activation_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GoalDecision {
    Idle {
        reason: IdleReason,
    },
    Wait {
        reason: WaitReason,
    },
    /// A stale unclaimed intention must be atomically removed before reconsidering.
    DiscardPending {
        fence: GoalFence,
        key: ContinuationKey,
    },
    Continue {
        fence: GoalFence,
        key: ContinuationKey,
        reason: ContinueReason,
    },
    Pause {
        fence: GoalFence,
        reason: PauseReason,
    },
    Block {
        fence: GoalFence,
        report_id: String,
        reason: GoalBlockReason,
    },
    Complete {
        fence: GoalFence,
        report_id: String,
        evidence: Vec<GoalEvidence>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdleReason {
    NoGoal,
    Disabled,
    Paused,
    Blocked,
    Complete,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    RuntimeBusy,
    Approval,
    Answer,
    Recovery,
    UserPriority,
    Dependencies,
    ContinuationPending,
    AlreadyAdmitted,
    CompletionConfirmation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinueReason {
    Initial,
    Progress,
    MissingReport,
    StaleReport,
    CompletionRejected,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    RoundBudget,
    Cancelled,
    ExecutionError,
    StepLimit,
    OutputLimit,
    OutcomeUnknown,
    ReportProtocolStalled,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("invalid goal contract: {field}")]
pub struct GoalContractError {
    pub field: &'static str,
}

pub(crate) fn require(ok: bool, field: &'static str) -> Result<(), GoalContractError> {
    if ok {
        Ok(())
    } else {
        Err(GoalContractError { field })
    }
}

impl GoalDefinition {
    pub fn validate(&self) -> Result<(), GoalContractError> {
        let g = &self.snapshot;
        require(!g.id.trim().is_empty(), "goal.id")?;
        require(!g.objective.trim().is_empty(), "goal.objective")?;
        require(
            g.revision > 0
                && self.definition_revision > 0
                && self.definition_revision <= g.revision,
            "goal.revision",
        )?;
        require(g.max_goal_rounds > 0, "goal.max_goal_rounds")?;
        require(
            self.acceptance_criteria
                .iter()
                .all(|s| !s.trim().is_empty()),
            "goal.acceptance_criteria",
        )?;
        require(
            (g.phase == GoalPhase::Blocked) == g.blocked_reason.is_some(),
            "goal.blocked_reason",
        )?;
        if let Some(r) = &g.blocked_reason {
            validate_block(r)?;
        }
        Ok(())
    }
}
fn validate_block(r: &GoalBlockReason) -> Result<(), GoalContractError> {
    require(
        !r.code.trim().is_empty() && !r.message.trim().is_empty(),
        "blocked_reason",
    )
}
impl GoalReport {
    pub fn validate(&self) -> Result<(), GoalContractError> {
        require(
            !self.goal_id.trim().is_empty() && self.definition_revision > 0 && self.turn > 0,
            "report.scope",
        )?;
        require(!self.report_id.trim().is_empty(), "report.id")?;
        require(!self.summary.trim().is_empty(), "report.summary")?;
        require(
            self.remaining.iter().all(|s| !s.trim().is_empty()),
            "report.remaining",
        )?;
        require(
            self.status != GoalReportStatus::Complete || self.remaining.is_empty(),
            "report.complete_with_remaining",
        )?;
        require(
            (self.status == GoalReportStatus::Blocked) == self.blocked_reason.is_some(),
            "report.blocked_reason",
        )?;
        if let Some(r) = &self.blocked_reason {
            validate_block(r)?;
        }
        require(
            self.evidence.iter().all(|e| match e {
                GoalEvidence::ToolResult { execution_id } => !execution_id.trim().is_empty(),
                GoalEvidence::Artifact { reference } => !reference.trim().is_empty(),
            }),
            "report.evidence",
        )
    }
}
