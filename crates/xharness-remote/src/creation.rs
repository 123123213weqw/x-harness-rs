//! Explicit create capability and durable original-creator reconciliation.
//! No generic RPC, model, arbitrary cwd, or automatic binding switch.
use crate::{gateway::valid_id, store, subscription::scope_in_transaction, *};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use xharness_api::{ScopedSessionCreate, ScopedSessionCreated};

pub(crate) const CREATION_WORKERS: usize = 32;

pub(crate) struct CreationPermit {
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    idle: Arc<tokio::sync::Notify>,
}
impl Drop for CreationPermit {
    fn drop(&mut self) {
        drop(self.slot.take());
        self.idle.notify_waiters();
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreationPolicy {
    pub principal: String,
    pub principal_revision: u64,
    pub generation: u64,
    pub workspaces: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCreationRequest {
    pub request_id: String,
    pub workspace: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCreationState {
    Dispatching,
    Uncertain,
    Granted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCreation {
    pub key: String,
    pub request: SessionCreationRequest,
    /// Immutable authentication at first admission, not rewritten after grants.
    pub scope: Subscription,
    pub principal_revision: u64,
    pub binding: Binding,
    pub state: SessionCreationState,
    pub created: Option<ScopedSessionCreated>,
    pub granted_revision: Option<u64>,
}
impl Gateway {
    /// Trusted desktop composition only. Default is no policy and no create
    /// permission. A normal principal edit invalidates the old revision policy.
    /// Explicit removal is an empty workspace set, with a generation CAS.
    pub async fn set_creation_policy(&self, policy: CreationPolicy) -> Result<(), Error> {
        valid_id(&policy.principal)?;
        for id in &policy.workspaces {
            valid_id(id)?;
        }
        if policy.workspaces.len() > 256 {
            return Err(Error::Capacity);
        }
        let gate = self.principal_gate(&policy.principal).await;
        let guard = gate.write().await;
        let host = self.host_id.clone();
        self.store
            .transaction_fenced(guard, move |tx| {
                let principal: Principal = store::entity(tx, "principal", &policy.principal)?
                    .ok_or(Error::Unauthorized)?;
                if principal.revoked
                    || principal.host != host
                    || principal.revision != policy.principal_revision
                    || !policy.workspaces.is_subset(&principal.workspaces)
                {
                    return Err(Error::Unauthorized);
                }
                let previous: Option<CreationPolicy> =
                    store::entity(tx, "creation-policy", &policy.principal)?;
                let generation = previous.map_or(Some(1), |old| old.generation.checked_add(1));
                if generation != Some(policy.generation) {
                    return Err(Error::IdentityConflict);
                }
                store::put_entity(tx, "creation-policy", &policy.principal, &policy)
            })
            .await
    }

    /// Authenticated transport supplies scope. The journal commits before the
    /// native effect; disconnecting drops only the waiter, not this owned task.
    /// At most 32 owned attempts; each native operation is bounded to 2 seconds.
    /// Reusing the same identity with another workspace is always a conflict.
    pub async fn controller_create(
        self: &Arc<Self>,
        scope: Subscription,
        request: SessionCreationRequest,
    ) -> Result<SessionCreation, Error> {
        for id in [
            &scope.principal,
            &scope.sender.account,
            &scope.sender.user,
            &scope.conversation,
            &scope.binding,
            &request.request_id,
            &request.workspace,
        ] {
            valid_id(id)?;
        }
        let permit = self.creation_permit()?;
        let gateway = self.clone();
        tokio::spawn(async move { gateway.create_owned(scope, request, permit, None).await })
            .await
            .map_err(|_| Error::WorkerFailed)?
    }

    pub(crate) fn creation_permit(&self) -> Result<Arc<CreationPermit>, Error> {
        let slot = self.creations.clone().try_acquire_owned().map_err(|_| {
            if self.creations.is_closed() {
                Error::Closed
            } else {
                Error::Capacity
            }
        })?;
        Ok(Arc::new(CreationPermit {
            slot: Some(slot),
            idle: self.creation_idle.clone(),
        }))
    }
    pub(crate) async fn create_owned(
        &self,
        scope: Subscription,
        request: SessionCreationRequest,
        permit: Arc<CreationPermit>,
        command: Option<Delivery>,
    ) -> Result<SessionCreation, Error> {
        let gate = self.principal_gate(&scope.principal).await;
        let guard = gate.write().await;
        let host = self.host_id.clone();
        let check = scope.clone();
        let req = request.clone();
        let key = creation_key(&host, &scope, &request.request_id)?;
        let record_key = key.clone();
        let (principal, binding, policy, mut record, command) = self
            .store
            .transaction(move |tx| {
                let (principal, binding) = scope_in_transaction(tx, &host, &check)?;
                let mut command = command;
                if command.is_some()
                    && principal.sessions.contains(
                        &ScopedSessionCreate {
                            workspace: req.workspace.clone(),
                            request_key: record_key.clone(),
                        }
                        .session_id(),
                    )
                {
                    return Err(Error::IdentityConflict);
                }
                if let Some(d) = &command {
                    crate::creation_commands::validate_dispatch(tx, d, &principal, &binding)?;
                }
                let old: Option<SessionCreation> =
                    store::entity(tx, "session-creation", &record_key)?;
                if old.as_ref().is_some_and(|old| old.request != req) {
                    return Err(Error::IdentityConflict);
                }
                let policy: Option<CreationPolicy> =
                    store::entity(tx, "creation-policy", &principal.id)?;
                if let Some(record) = &old {
                    if record.state == SessionCreationState::Granted {
                        if command.is_some() {
                            return Err(Error::IdentityConflict);
                        }
                        let created = record.created.as_ref().ok_or(Error::IdentityConflict)?;
                        if !principal.workspaces.contains(&created.workspace)
                            || !principal.sessions.contains(&created.session)
                        {
                            return Err(Error::Unauthorized);
                        }
                        return Ok((principal, binding, policy, record.clone(), None));
                    }
                    if record.principal_revision != principal.revision || record.binding != binding
                    {
                        return Err(Error::Unauthorized);
                    }
                }
                let policy = policy.ok_or(Error::Unauthorized)?;
                if policy.principal_revision != principal.revision
                    || !policy.workspaces.contains(&req.workspace)
                    || !principal.workspaces.contains(&req.workspace)
                {
                    return Err(Error::Unauthorized);
                }
                // Reserve grant capacity before any native creation or recovery.
                if principal.sessions.len() >= 4096 || principal.revision == u64::MAX {
                    return Err(Error::Capacity);
                }
                if command
                    .as_ref()
                    .is_some_and(|d| d.state != DeliveryState::Queued)
                    && old.is_none()
                {
                    return Err(Error::IdentityConflict);
                }
                let mut record = match old {
                    Some(record) => record,
                    None => {
                        let count: usize = tx.query_row(
                            "SELECT count(*) FROM entities WHERE kind='session-creation'",
                            [],
                            |r| r.get(0),
                        )?;
                        if count >= MAX_RECORDS {
                            return Err(Error::Capacity);
                        }
                        let record = SessionCreation {
                            key: record_key.clone(),
                            request: req,
                            scope: check,
                            principal_revision: principal.revision,
                            binding: binding.clone(),
                            state: SessionCreationState::Dispatching,
                            created: None,
                            granted_revision: None,
                        };
                        store::put_entity(tx, "session-creation", &record_key, &record)?;
                        record
                    }
                };
                if let Some(d) = &mut command {
                    if d.state == DeliveryState::Uncertain
                        && record.state == SessionCreationState::Dispatching
                    {
                        record.state = SessionCreationState::Uncertain;
                        store::put_entity(tx, "session-creation", &record.key, &record)?;
                    }
                    if d.state == DeliveryState::Queued {
                        d.state = DeliveryState::Dispatching;
                        store::save(tx, d)?;
                    }
                }
                Ok((principal, binding, Some(policy), record, command))
            })
            .await?;
        let baseline = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&binding.workspace, &binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !baseline {
            return Err(Error::Unauthorized);
        }
        let native = ScopedSessionCreate {
            workspace: request.workspace.clone(),
            request_key: key.clone(),
        };
        let original = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_session_creation_receipt(native.clone()),
        )
        .await;
        let mut proof = match original {
            Ok(Ok(Some(proof))) if proof == native.receipt() => Some(proof),
            Ok(Ok(None)) if record.state == SessionCreationState::Dispatching => {
                // A wait deadline must not cancel a writer while its blocking
                // append still owns work. Keep native admission and the drain
                // slot until the actual effect settles; timeout journals uncertainty.
                let backend = self.host.clone();
                let request = native.clone();
                let writer_slot = permit.clone();
                let mut writer = tokio::spawn(async move {
                    let _slot = writer_slot;
                    backend.create_scoped_session(request).await
                });
                let result = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
                match result {
                    Ok(Ok(Ok(created))) if created == native.receipt() => {
                        // Recheck the authoritative original receipt AND current
                        // native registration; a backend success alone is not proof.
                        match tokio::time::timeout(
                            Duration::from_secs(2),
                            self.host.scoped_session_creation_receipt(native.clone()),
                        )
                        .await
                        {
                            Ok(Ok(Some(proof))) if proof == created => Some(proof),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(created) = &proof {
            // A durable original receipt does not make an unregistered/deleted
            // target usable. Registration remains the native Host's authority.
            let owned = tokio::time::timeout(
                Duration::from_secs(2),
                self.host
                    .session_in_workspace(&created.workspace, &created.session),
            )
            .await;
            if !matches!(owned, Ok(Ok(true))) {
                proof = None;
            }
        }
        if record.state == SessionCreationState::Granted {
            return if proof.is_some() {
                Ok(record)
            } else {
                Err(Error::HostUnavailable)
            };
        }
        let host = self.host_id.clone();
        self.store
            .transaction_fenced((guard, permit), move |tx| {
                let (current, current_binding) = scope_in_transaction(tx, &host, &scope)?;
                if current != principal || current_binding != binding {
                    return Err(Error::Unauthorized);
                }
                let persisted: SessionCreation =
                    store::entity(tx, "session-creation", &key)?.ok_or(Error::IdentityConflict)?;
                if persisted != record {
                    return Err(Error::IdentityConflict);
                }
                let Some(created) = proof else {
                    record.state = SessionCreationState::Uncertain;
                    store::put_entity(tx, "session-creation", &key, &record)?;
                    if let Some(mut d) = command {
                        d.state = DeliveryState::Uncertain;
                        d.reason = Some("creation-proof-unavailable".into());
                        d.result = None;
                        store::save(tx, &d)?;
                    }
                    return Ok(record);
                };
                let mut policy = policy.ok_or(Error::Unauthorized)?;
                let current_policy: CreationPolicy =
                    store::entity(tx, "creation-policy", &principal.id)?
                        .ok_or(Error::Unauthorized)?;
                if policy != current_policy {
                    return Err(Error::Unauthorized);
                }
                let before = principal.clone();
                let before_policy = policy.clone();
                let mut principal = principal;
                principal.sessions.insert(created.session.clone());
                principal.revision = principal.revision.checked_add(1).ok_or(Error::Capacity)?;
                policy.principal_revision = principal.revision;
                record.state = SessionCreationState::Granted;
                record.created = Some(created);
                record.granted_revision = Some(principal.revision);
                // Exact grant + rotated capability revision + creation receipt are
                // one FULL transaction. Binding and immutable ingress remain unchanged.
                store::put_entity(tx, "principal", &principal.id, &principal)?;
                store::put_entity(tx, "creation-policy", &principal.id, &policy)?;
                store::put_entity(tx, "session-creation", &key, &record)?;
                if let Some(d) = command {
                    crate::creation_commands::commit_grant(
                        tx,
                        &host,
                        d,
                        before,
                        principal,
                        before_policy,
                        &record,
                    )?;
                }
                Ok(record)
            })
            .await
    }
}
pub(crate) fn creation_key(
    host: &str,
    scope: &Subscription,
    request: &str,
) -> Result<String, Error> {
    let mut hash = Sha256::new();
    hash.update(b"xharness-remote-create-v1\0");
    hash.update(serde_json::to_vec(&(
        host,
        &scope.principal,
        &scope.sender,
        &scope.conversation,
        request,
    ))?);
    Ok(hex::encode(hash.finalize()))
}
