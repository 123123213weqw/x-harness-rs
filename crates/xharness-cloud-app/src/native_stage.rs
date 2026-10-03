//! Controller/native boundary. A trusted deployment port owns the concrete VM
//! service and verified external stop/retention; this adapter owns no model Loop.
use crate::*;
use async_trait::async_trait;
use std::{sync::Arc, time::Duration};
use xharness_cloud::*;

#[async_trait]
pub trait NativeHostLifecycle: Send + Sync {
    /// Must reserve an exactly task-bound Goal manifest and idempotently ensure
    /// the original Host service runs. Never submit a second user prompt.
    async fn ensure_prepared(&self, operation: &StageOperation) -> CloudResult<()>;
    /// Seal -> original shutdown -> verified external stop -> retention.
    /// A native Stop receipt alone is NOT a whole-VM stop proof.
    async fn settle(&self, operation: &StageOperation) -> CloudResult<StageObservation>;
    /// Read-only recovery. Must not restart a VM, Host or model work.
    async fn inspect_settlement(
        &self,
        operation: &StageOperation,
    ) -> CloudResult<Option<StageObservation>>;
}
/// One adapter per fixed environment binding. Uses durable native evidence for
/// Prepare/Activate, and a separately verified lifecycle port for Settle.
pub struct NativeStageExecutor {
    journal: Arc<NativePermitJournal>,
    lifecycle: Arc<dyn NativeHostLifecycle>,
}
impl NativeStageExecutor {
    pub fn new(journal: Arc<NativePermitJournal>, lifecycle: Arc<dyn NativeHostLifecycle>) -> Self {
        Self { journal, lifecycle }
    }
    fn verify_binding(&self, op: &StageOperation) -> CloudResult<NativePermitSnapshot> {
        let head = self.journal.snapshot()?;
        if head.specification.binding != op.task.binding || op.intent.scope != op.task.binding.scope
        {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "native stage binding differs from controller task",
            ));
        }
        Ok(head)
    }
    fn inspect_native(&self, op: &StageOperation) -> CloudResult<Option<StageObservation>> {
        let head = self.verify_binding(op)?;
        let Some(bootstrap) = self.journal.bootstrap()? else {
            return Ok(None);
        };
        if bootstrap.intent.operation_id != op.task.prepare_operation_id
            || bootstrap.intent.root_session_id != op.task.binding.root_session_id
            || bootstrap.intent.task_spec_fingerprint != op.task.spec.fingerprint()?.as_str()
        {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "native bootstrap differs from controller task",
            ));
        }
        if !bootstrap.applied || head.launch_generation == Counter(0) {
            return Ok(None);
        }
        let launch = self.journal.launch(head.launch_generation)?;
        let outcome = match op.intent.kind {
            IntentKind::Prepare
                if op.intent.operation_id == bootstrap.intent.operation_id
                    && matches!(
                        launch.phase,
                        NativeLaunchPhase::PreparedReady | NativeLaunchPhase::Ready
                    )
                    && head.permit.permit != ExecutionPermit::Sealed =>
            {
                StageOutcome::Prepared {
                    ready: true,
                    bootstrap_prepared: true,
                }
            }
            IntentKind::Activate
                if op.intent.operation_id == op.task.activate_operation_id
                    && head.permit.permit == ExecutionPermit::Active
                    && launch.phase == NativeLaunchPhase::Ready =>
            {
                // Active phase without this exact command is not an ack.
                self.journal.activation_receipt(&op.intent.operation_id)?;
                StageOutcome::Activated
            }
            _ => return Ok(None),
        };
        Ok(Some(StageObservation {
            operation_id: op.intent.operation_id.clone(),
            scope: op.intent.scope.clone(),
            outcome,
        }))
    }
    async fn await_native(&self, op: &StageOperation) -> CloudResult<StageObservation> {
        // Caller controller supplies the bounded timeout. A timeout remains
        // unknown and goes to inspect(), never another launch/initial message.
        loop {
            if let Some(value) = self.inspect_native(op)? {
                return Ok(value);
            }
            let head = self.verify_binding(op)?;
            if head.permit.permit == ExecutionPermit::Sealed {
                return Err(CloudError::new(
                    ErrorCode::RuntimeUnavailable,
                    "native stage was sealed",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
#[async_trait]
impl StageExecutor for NativeStageExecutor {
    async fn execute(&self, op: &StageOperation) -> CloudResult<StageObservation> {
        self.verify_binding(op)?;
        match op.intent.kind {
            IntentKind::Prepare => {
                if let Some(receipt) = self.inspect_native(op)? {
                    return Ok(receipt);
                }
                if op.intent.operation_id != op.task.prepare_operation_id {
                    return Err(CloudError::new(
                        ErrorCode::InvalidRequest,
                        "incorrect prepare operation",
                    ));
                }
                self.lifecycle.ensure_prepared(op).await?;
                self.await_native(op).await
            }
            IntentKind::Activate => {
                if op.intent.operation_id != op.task.activate_operation_id {
                    return Err(CloudError::new(
                        ErrorCode::InvalidRequest,
                        "incorrect activation operation",
                    ));
                }
                // Verify prepared task identity before admitting execution.
                let mut prepare = op.clone();
                prepare.intent.operation_id = op.task.prepare_operation_id.clone();
                prepare.intent.kind = IntentKind::Prepare;
                if self.inspect_native(&prepare)?.is_none() {
                    return Err(CloudError::new(
                        ErrorCode::RuntimeUnavailable,
                        "original Host has no prepared Goal receipt",
                    ));
                }
                self.journal.transition(&NativePermitCommand {
                    operation_id: op.intent.operation_id.clone(),
                    scope: op.intent.scope.clone(),
                    expected_revision: Counter(1),
                    to: ExecutionPermit::Active,
                })?;
                self.await_native(op).await
            }
            IntentKind::Settle => self.lifecycle.settle(op).await,
        }
    }
    async fn inspect(&self, op: &StageOperation) -> CloudResult<Option<StageObservation>> {
        self.verify_binding(op)?;
        if op.intent.kind == IntentKind::Settle {
            self.lifecycle.inspect_settlement(op).await
        } else {
            self.inspect_native(op)
        }
    }
}
