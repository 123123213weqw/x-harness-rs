use crate::{
    contract::invalid, Binding, BindingScope, CloudError, CloudResult, CloudTaskSpec, Counter,
    ErrorCode, Id, Support,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Accepted,
    Provisioning,
    Attached,
    Settling,
    Finished,
    Cancelled,
    Failed,
}

impl TaskPhase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestedOutcome {
    Finished,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settlement {
    pub requested_outcome: RequestedOutcome,
    pub operation_id: Id,
    /// Control accepts cancellation before VM seal; these are separate facts.
    pub sealed: bool,
    pub stop_proof: Option<StopProof>,
    pub retention_receipt_ref: Option<VersionedRetentionReceipt>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionedRetentionReceipt {
    pub receipt_id: Id,
    pub retained_manifest_sha256: crate::Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StopProof {
    NotStarted {
        prepare_quiesced: bool,
        no_executor_verified: bool,
    },
    Graceful {
        native_shutdown_verified: bool,
        execution_scope_quiet: bool,
        cleanup_errors: u32,
    },
    Forced {
        outside_vm_stop_verified: bool,
        unknown_effects_recorded: bool,
    },
}

/// Evidence is supplied by verified adapters, never interpreted from model text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionEvidence {
    pub goal_receipt_id: Id,
    pub session_revision: Counter,
    pub goal_accepted: bool,
    pub admission_sealed: bool,
    pub admitted_work_remaining: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskRecord {
    pub task_id: Id,
    pub owner_id: Id,
    pub spec: CloudTaskSpec,
    pub revision: Counter,
    pub phase: TaskPhase,
    pub binding: Binding,
    pub prepare_operation_id: Id,
    pub activate_operation_id: Id,
    pub activated: bool,
    pub settlement: Option<Settlement>,
    pub completion_evidence: Option<CompletionEvidence>,
    pub failure_reasons: Vec<String>,
}

/// Internal facts: their source and receipts must be verified before reduction.
/// This is not a public RPC or substitute for native Host Admission/Shutdown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskFact {
    PrepareAdmitted {
        operation_id: Id,
    },
    Prepared {
        operation_id: Id,
        ready: bool,
        bootstrap_prepared: bool,
        grant_committed: bool,
    },
    Activated {
        operation_id: Id,
    },
    FinishRequested {
        operation_id: Id,
        evidence: CompletionEvidence,
    },
    FailureRequested {
        operation_id: Id,
        reason: String,
    },
    CancelRequested {
        operation_id: Id,
    },
    Sealed {
        operation_id: Id,
    },
    StopVerified {
        operation_id: Id,
        proof: StopProof,
    },
    RetentionVerified {
        operation_id: Id,
        receipt: VersionedRetentionReceipt,
    },
    CleanupBlocked {
        operation_id: Id,
        reason: String,
    },
    CommitTerminal,
}

pub fn reduce_task(
    current: &TaskRecord,
    scope: &BindingScope,
    fact: &TaskFact,
) -> CloudResult<TaskRecord> {
    if current.revision.0 == 0
        || current.binding.scope.execution_epoch.0 == 0
        || current.binding.scope.task_id != current.task_id
        || (current.phase == TaskPhase::Settling && current.settlement.is_none())
    {
        return Err(invalid("inconsistent task state cannot be advanced"));
    }
    if &current.binding.scope != scope {
        return Err(CloudError::new(
            ErrorCode::OwnershipUnverified,
            "fact does not belong to current binding and epoch",
        ));
    }
    if current.phase.is_terminal() {
        return match fact {
            TaskFact::CancelRequested { .. } | TaskFact::CommitTerminal => Ok(current.clone()),
            _ => Err(invalid("terminal tasks cannot be reactivated or rewritten")),
        };
    }
    let mut next = current.clone();
    match fact {
        TaskFact::PrepareAdmitted { operation_id } => {
            if operation_id != &current.prepare_operation_id {
                return Err(invalid("prepare operation identity mismatch"));
            }
            match current.phase {
                TaskPhase::Accepted => next.phase = TaskPhase::Provisioning,
                TaskPhase::Provisioning => {}
                _ => return Err(invalid("prepare admission is out of phase")),
            }
        }
        TaskFact::Prepared {
            operation_id,
            ready,
            bootstrap_prepared,
            grant_committed,
        } => {
            if current.phase != TaskPhase::Provisioning
                || operation_id != &current.prepare_operation_id
                || !ready
                || !bootstrap_prepared
                || !grant_committed
            {
                return Err(invalid(
                    "prepared attachment requires verified Ready, bootstrap and execution grant",
                ));
            }
            next.phase = TaskPhase::Attached;
        }
        TaskFact::Activated { operation_id } => {
            if !matches!(current.phase, TaskPhase::Attached | TaskPhase::Settling)
                || operation_id != &current.activate_operation_id
            {
                return Err(invalid("activation is out of phase or has wrong identity"));
            }
            if current
                .settlement
                .as_ref()
                .is_some_and(|s| matches!(s.stop_proof, Some(StopProof::NotStarted { .. })))
            {
                return Err(invalid(
                    "activation receipt conflicts with verified not-started proof",
                ));
            }
            // Historical acknowledgement only: never change phase or unseal.
            next.activated = true;
        }
        TaskFact::FinishRequested {
            operation_id,
            evidence,
        } => {
            if current.phase != TaskPhase::Attached
                || !current.activated
                || !evidence.goal_accepted
                || !evidence.admission_sealed
                || evidence.admitted_work_remaining
            {
                return Err(invalid(
                    "completion requires authoritative Goal acceptance and sealed idle Admission",
                ));
            }
            next.completion_evidence = Some(evidence.clone());
            begin_settlement(&mut next, RequestedOutcome::Finished, operation_id);
            next.settlement.as_mut().expect("settlement created").sealed = true;
        }
        TaskFact::FailureRequested {
            operation_id,
            reason,
        } => {
            if reason.trim().is_empty() {
                return Err(invalid("failure reason is empty"));
            }
            if !next.failure_reasons.contains(reason) {
                next.failure_reasons.push(reason.clone());
            }
            begin_settlement(&mut next, RequestedOutcome::Failed, operation_id);
        }
        TaskFact::CancelRequested { operation_id } => {
            begin_settlement(&mut next, RequestedOutcome::Cancelled, operation_id);
        }
        TaskFact::Sealed { operation_id } => {
            settlement_mut(&mut next, operation_id)?.sealed = true;
        }
        TaskFact::StopVerified {
            operation_id,
            proof,
        } => {
            validate_stop(current, proof)?;
            let settlement = settlement_mut(&mut next, operation_id)?;
            if let Some(old) = &settlement.stop_proof {
                if old != proof {
                    return Err(invalid("stop proof is immutable once verified"));
                }
            }
            settlement.stop_proof = Some(proof.clone());
            settlement.blocked_reason = None;
        }
        TaskFact::RetentionVerified {
            operation_id,
            receipt,
        } => {
            let settlement = settlement_mut(&mut next, operation_id)?;
            if settlement.stop_proof.is_none() {
                return Err(invalid("retention cut requires verified stop"));
            }
            if let Some(old) = &settlement.retention_receipt_ref {
                if old != receipt {
                    return Err(invalid("retention cut is immutable once verified"));
                }
            }
            settlement.retention_receipt_ref = Some(receipt.clone());
        }
        TaskFact::CleanupBlocked {
            operation_id,
            reason,
        } => {
            if reason.trim().is_empty() {
                return Err(invalid("cleanup reason is empty"));
            }
            settlement_mut(&mut next, operation_id)?.blocked_reason = Some(reason.clone());
        }
        TaskFact::CommitTerminal => {
            let settlement = current
                .settlement
                .as_ref()
                .ok_or_else(|| invalid("task is not settling"))?;
            if current.phase != TaskPhase::Settling
                || settlement.stop_proof.is_none()
                || settlement.retention_receipt_ref.is_none()
                || settlement.blocked_reason.is_some()
                || (!settlement.sealed
                    && !matches!(settlement.stop_proof, Some(StopProof::NotStarted { .. })))
            {
                return Err(CloudError::new(
                    ErrorCode::CleanupIncomplete,
                    "terminal commit requires seal, stop and retention proofs",
                ));
            }
            next.phase = match settlement.requested_outcome {
                RequestedOutcome::Finished => TaskPhase::Finished,
                RequestedOutcome::Cancelled => TaskPhase::Cancelled,
                RequestedOutcome::Failed => TaskPhase::Failed,
            };
        }
    }
    if next != *current {
        next.revision = current.revision.next()?;
    }
    Ok(next)
}

fn begin_settlement(record: &mut TaskRecord, outcome: RequestedOutcome, operation_id: &Id) {
    if let Some(settlement) = &mut record.settlement {
        // Cancellation admitted before terminal CAS wins, without discarding
        // completion/failure evidence or changing the in-flight stop identity.
        if outcome == RequestedOutcome::Cancelled
            || (outcome == RequestedOutcome::Failed
                && settlement.requested_outcome == RequestedOutcome::Finished)
        {
            settlement.requested_outcome = outcome;
        }
    } else {
        record.settlement = Some(Settlement {
            requested_outcome: outcome,
            operation_id: operation_id.clone(),
            sealed: false,
            stop_proof: None,
            retention_receipt_ref: None,
            blocked_reason: None,
        });
    }
    record.phase = TaskPhase::Settling;
}

fn settlement_mut<'a>(
    record: &'a mut TaskRecord,
    operation_id: &Id,
) -> CloudResult<&'a mut Settlement> {
    if record.phase != TaskPhase::Settling {
        return Err(invalid("task is not settling"));
    }
    let settlement = record
        .settlement
        .as_mut()
        .ok_or_else(|| invalid("missing settlement"))?;
    if &settlement.operation_id != operation_id {
        return Err(invalid("settlement operation identity mismatch"));
    }
    Ok(settlement)
}

fn validate_stop(record: &TaskRecord, proof: &StopProof) -> CloudResult<()> {
    let settlement = record
        .settlement
        .as_ref()
        .ok_or_else(|| invalid("task is not settling"))?;
    let valid = match proof {
        StopProof::NotStarted {
            prepare_quiesced,
            no_executor_verified,
        } => !record.activated && *prepare_quiesced && *no_executor_verified,
        StopProof::Graceful {
            native_shutdown_verified,
            execution_scope_quiet,
            cleanup_errors,
        } => {
            settlement.sealed
                && *native_shutdown_verified
                && *execution_scope_quiet
                && *cleanup_errors == 0
        }
        StopProof::Forced {
            outside_vm_stop_verified,
            unknown_effects_recorded,
        } => {
            settlement.sealed
                && record.binding.external_stop_authorized
                && record.binding.external_stop_support == Support::Supported
                && *outside_vm_stop_verified
                && *unknown_effects_recorded
        }
    };
    if valid {
        Ok(())
    } else {
        Err(CloudError::new(
            ErrorCode::CleanupIncomplete,
            "stop proof is incomplete or unauthorized",
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPermit {
    Prepared,
    Active,
    Sealed,
}

/// Pure journal transition only. Disk persistence and checks at all Host entry
/// points are CLOUD-04 work; this type by itself does not stop an Agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermitRecord {
    pub scope: BindingScope,
    pub revision: Counter,
    pub permit: ExecutionPermit,
}

impl PermitRecord {
    pub fn transition(
        &self,
        scope: &BindingScope,
        expected: Counter,
        to: ExecutionPermit,
    ) -> CloudResult<Self> {
        if self.revision.0 == 0 || self.scope.execution_epoch.0 == 0 {
            return Err(invalid("unestablished permit journal cannot be advanced"));
        }
        if scope != &self.scope {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "permit binding mismatch",
            ));
        }
        if expected != self.revision {
            return Err(CloudError::new(
                ErrorCode::RevisionConflict,
                "permit revision conflict",
            ));
        }
        if self.permit == to {
            return Ok(self.clone());
        }
        if !matches!(
            (self.permit, to),
            (
                ExecutionPermit::Prepared,
                ExecutionPermit::Active | ExecutionPermit::Sealed
            ) | (ExecutionPermit::Active, ExecutionPermit::Sealed)
        ) {
            return Err(invalid("execution permit cannot move backwards or unseal"));
        }
        Ok(Self {
            revision: self.revision.next()?,
            permit: to,
            ..self.clone()
        })
    }
}
