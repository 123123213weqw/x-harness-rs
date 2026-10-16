//! Durable saved Schedule commands. No new scheduler, dynamic RPC or Agent.
use crate::{
    creation::CreationPermit,
    gateway::{authorize, digest},
    store, *,
};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use xharness_api::{ScopedAutomationMutation, ScopedAutomationRead};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerAutomationRead {
    pub principal_revision: u64,
    pub binding_generation: u64,
    pub page: ScopedAutomationPage,
}
impl ControllerAutomationRead {
    pub fn is_for_delivery(&self, d: &Delivery) -> bool {
        let Command::AutomationRead { read } = &d.inbound.command else {
            return false;
        };
        d.state == DeliveryState::Completed
            && self.principal_revision == d.principal_revision
            && self.principal_revision > 0
            && self.binding_generation == d.binding.generation
            && self.binding_generation > 0
            && ScopedAutomationRead {
                workspace: d.binding.workspace.clone(),
                session: d.binding.session.clone(),
                read: read.clone(),
            }
            .admits(&self.page)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerAutomationControl {
    pub principal_revision: u64,
    pub binding_generation: u64,
    pub applied: ScopedAutomationApplied,
}
impl ControllerAutomationControl {
    pub fn is_for_delivery(&self, d: &Delivery) -> bool {
        let Command::AutomationControl { control } = &d.inbound.command else {
            return false;
        };
        d.state == DeliveryState::Completed
            && self.principal_revision == d.principal_revision
            && self.principal_revision > 0
            && self.binding_generation == d.binding.generation
            && self.binding_generation > 0
            && ScopedAutomationMutation {
                workspace: d.binding.workspace.clone(),
                session: d.binding.session.clone(),
                request_key: self.applied.request_key.clone(),
                control: control.clone(),
            }
            .admits(&self.applied)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attempt {
    identity: String,
    request: ScopedAutomationMutation,
    may_dispatch: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    delivery_sha: String,
    receipt: ControllerAutomationControl,
}
fn identity(d: &Delivery) -> String {
    digest(&json!([
        d.key,
        d.sequence,
        d.principal,
        d.principal_revision,
        d.binding,
        d.inbound
    ]))
}
fn native(host: &str, d: &Delivery) -> Result<ScopedAutomationMutation, Error> {
    let Command::AutomationControl { control } = &d.inbound.command else {
        return Err(Error::Invalid("automation control"));
    };
    let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
        "remote-automation-inbox-v1",
        host,
        identity(d)
    ]))?));
    Ok(ScopedAutomationMutation {
        workspace: d.binding.workspace.clone(),
        session: d.binding.session.clone(),
        request_key: key,
        control: control.clone(),
    })
}
pub(crate) fn reply_proven(tx: &Transaction<'_>, host: &str, d: &Delivery) -> Result<bool, Error> {
    let Some(proof) = store::entity::<Proof>(tx, "automation-proof", &d.key)? else {
        return Ok(false);
    };
    let Some(attempt) = store::entity::<Attempt>(tx, "automation-attempt", &d.key)? else {
        return Ok(false);
    };
    Ok(proof.delivery_sha == digest(&json!(d))
        && proof.receipt.is_for_delivery(d)
        && attempt.identity == identity(d)
        && !attempt.may_dispatch
        && attempt.request == native(host, d)?
        && attempt.request.admits(&proof.receipt.applied)
        && d.result.as_ref()
            == Some(&NativeCommandResult::success(serde_json::to_value(
                &proof.receipt,
            )?)))
}
impl Gateway {
    pub(crate) async fn dispatch_automation_read(
        &self,
        mut d: Delivery,
    ) -> Result<Delivery, Error> {
        let Command::AutomationRead { read } = &d.inbound.command else {
            return Err(Error::Invalid("automation read"));
        };
        let request = ScopedAutomationRead {
            workspace: d.binding.workspace.clone(),
            session: d.binding.session.clone(),
            read: read.clone(),
        };
        let scope = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&d.binding.workspace, &d.binding.session),
        )
        .await;
        if !matches!(scope, Ok(Ok(true))) {
            if matches!(scope, Ok(Ok(false))) {
                d.state = if d.state == DeliveryState::Queued {
                    DeliveryState::Rejected
                } else {
                    DeliveryState::Uncertain
                };
                d.reason = Some("automation-scope-changed".into());
                return self.persist(d).await;
            }
            return Ok(d);
        }
        d.state = DeliveryState::Dispatching;
        d = self.persist(d).await?;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_automation_read(request.clone()),
        )
        .await;
        d.state = DeliveryState::Completed;
        d.result = Some(match result {
            Ok(Ok(page)) if request.admits(&page) => {
                NativeCommandResult::success(serde_json::to_value(ControllerAutomationRead {
                    principal_revision: d.principal_revision,
                    binding_generation: d.binding.generation,
                    page,
                })?)
            }
            _ => {
                d.reason = Some("automation-read-unavailable".into());
                NativeCommandResult::failure(xharness_api::RpcError::internal(
                    "scoped automation read unavailable",
                ))
            }
        });
        self.persist(d).await
    }
    pub(crate) async fn dispatch_automation_control(
        self: &Arc<Self>,
        initial: Delivery,
    ) -> Result<Delivery, Error> {
        if !matches!(
            initial.state,
            DeliveryState::Queued | DeliveryState::Dispatching | DeliveryState::Uncertain
        ) {
            return Ok(initial);
        }
        let permit = self.creation_permit()?;
        let g = self.clone();
        tokio::spawn(async move { g.automation_control_owned(initial, permit).await })
            .await
            .map_err(|_| Error::WorkerFailed)?
    }
    async fn automation_control_owned(
        self: &Arc<Self>,
        initial: Delivery,
        permit: Arc<CreationPermit>,
    ) -> Result<Delivery, Error> {
        let session = self.session_gate(&initial.binding.session).await;
        let fifo = session.lock_owned().await;
        let gate = self.principal_gate(&initial.principal).await;
        let guard = gate.read_owned().await;
        // The native writer and final SQL share this fence. A deadline may journal
        // uncertainty, never release authority/FIFO/storage while a writer persists.
        let fence = Arc::new((guard, fifo, permit));
        let key = initial.key.clone();
        let host = self.host_id.clone();
        let (mut d, authorized) = self.store.transaction(move |tx| {
            let mut d = store::delivery(tx, &key)?.ok_or(Error::IdentityConflict)?;
            if !matches!(d.state, DeliveryState::Queued | DeliveryState::Dispatching | DeliveryState::Uncertain) {
                return Ok((d, false));
            }
            let earlier: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM inbox WHERE session=?1 AND seq<?2 AND state IN ('queued','dispatching','uncertain'))",
                params![d.binding.session, d.sequence], |r| r.get(0))?;
            if earlier { return Err(Error::SessionBlocked); }
            let principal = store::entity::<Principal>(tx, "principal", &d.principal)?;
            let binding = store::entity::<Binding>(tx, "binding", &d.binding.id)?;
            let valid = principal.as_ref().zip(binding.as_ref()).is_some_and(|(p, b)|
                p.host == host && p.revision == d.principal_revision && b == &d.binding && authorize(p,b).is_ok());
            if !valid {
                d.state = if d.state == DeliveryState::Queued { DeliveryState::Rejected } else { DeliveryState::Uncertain };
                d.reason = Some("automation-authority-changed".into());
                d.result = None;
                store::save(tx, &d)?;
            }
            Ok((d, valid))
        }).await?;
        if !authorized
            || !matches!(
                d.state,
                DeliveryState::Queued | DeliveryState::Dispatching | DeliveryState::Uncertain
            )
        {
            return Ok(d);
        }
        let scope = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&d.binding.workspace, &d.binding.session),
        )
        .await;
        if !matches!(scope, Ok(Ok(true))) {
            if matches!(scope, Ok(Ok(false))) {
                d.state = if d.state == DeliveryState::Queued {
                    DeliveryState::Rejected
                } else {
                    DeliveryState::Uncertain
                };
                d.reason = Some("automation-native-scope-changed".into());
                d.result = None;
                return self
                    .store
                    .transaction_fenced(fence, move |tx| {
                        store::save(tx, &d)?;
                        Ok(d)
                    })
                    .await;
            }
            return Ok(d);
        }
        let request = native(&self.host_id, &d)?;
        let expected = d.clone();
        let req = request.clone();
        let (current, attempt) = self
            .store
            .transaction(move |tx| {
                if store::delivery(tx, &expected.key)?.as_ref() != Some(&expected) {
                    return Err(Error::IdentityConflict);
                }
                let old = store::entity::<Attempt>(tx, "automation-attempt", &expected.key)?;
                let mut attempt = match old {
                    Some(a) if a.identity == identity(&expected) && a.request == req => a,
                    Some(_) => return Err(Error::IdentityConflict),
                    None if expected.state == DeliveryState::Queued => {
                        let n: usize = tx.query_row(
                            "SELECT count(*) FROM entities WHERE kind='automation-attempt'",
                            [],
                            |r| r.get(0),
                        )?;
                        if n >= MAX_RECORDS {
                            let mut rejected = expected;
                            rejected.state = DeliveryState::Rejected;
                            rejected.reason = Some("automation-attempt-capacity".into());
                            rejected.result = None;
                            store::save(tx, &rejected)?;
                            return Ok((rejected, None));
                        }
                        Attempt {
                            identity: identity(&expected),
                            request: req,
                            may_dispatch: true,
                        }
                    }
                    None => Attempt {
                        identity: identity(&expected),
                        request: req,
                        may_dispatch: false,
                    },
                };
                let mut d = expected;
                if d.state == DeliveryState::Uncertain {
                    attempt.may_dispatch = false;
                }
                if !attempt.may_dispatch && d.state == DeliveryState::Queued {
                    return Err(Error::IdentityConflict);
                }
                if d.state == DeliveryState::Queued {
                    d.state = DeliveryState::Dispatching;
                }
                store::put_entity(tx, "automation-attempt", &d.key, &attempt)?;
                store::save(tx, &d)?;
                Ok((d, Some(attempt)))
            })
            .await?;
        d = current;
        let Some(mut attempt) = attempt else {
            return Ok(d);
        };
        let original = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_automation_receipt(request.clone()),
        )
        .await;
        let mut proof = match original {
            Ok(Ok(Some(p))) if request.admits(&p) => Some(p),
            Ok(Ok(None)) if attempt.may_dispatch => {
                // Verify an existing active saved identity before the first control. Reads
                // can fail definitively without an effect; recovery never adopts state.
                let query = ScopedAutomationRead {
                    workspace: request.workspace.clone(),
                    session: request.session.clone(),
                    read: AutomationRead::View {
                        id: request.control.id().into(),
                    },
                };
                let view = tokio::time::timeout(
                    Duration::from_secs(2),
                    self.host.scoped_automation_read(query.clone()),
                )
                .await;
                if !matches!(&view,Ok(Ok(p)) if query.admits(p)&&matches!(p.entries[0].state,AutomationState::Scheduled|AutomationState::Overdue|AutomationState::Paused))
                {
                    attempt.may_dispatch = false;
                    d.state = DeliveryState::Completed;
                    d.reason = Some("automation-control-target-unavailable".into());
                    d.result = Some(NativeCommandResult::failure(
                        xharness_api::RpcError::internal("saved automation target unavailable"),
                    ));
                    return self
                        .store
                        .transaction_fenced(fence, move |tx| {
                            store::put_entity(tx, "automation-attempt", &d.key, &attempt)?;
                            store::save(tx, &d)?;
                            Ok(d)
                        })
                        .await;
                }
                // Seal replay before invoking the native effect. A process cut after
                // admission (even before the call starts) can only recover an original
                // receipt, never infer absence from the current automation state.
                attempt.may_dispatch = false;
                let sealed = attempt.clone();
                let expected = d.clone();
                self.store
                    .transaction_fenced(fence.clone(), move |tx| {
                        if store::delivery(tx, &expected.key)?.as_ref() != Some(&expected) {
                            return Err(Error::IdentityConflict);
                        }
                        store::put_entity(tx, "automation-attempt", &expected.key, &sealed)
                    })
                    .await?;
                let backend = self.host.clone();
                let native = request.clone();
                let owned = fence.clone();
                let mut writer = tokio::spawn(async move {
                    let _fence = owned;
                    backend.scoped_automation_control(native).await
                });
                match tokio::time::timeout(Duration::from_secs(2), &mut writer).await {
                    Ok(Ok(Ok(p))) if request.admits(&p) => match tokio::time::timeout(
                        Duration::from_secs(2),
                        self.host.scoped_automation_receipt(request.clone()),
                    )
                    .await
                    {
                        Ok(Ok(Some(original))) if original == p => Some(original),
                        _ => None,
                    },
                    _ => None,
                }
            }
            _ => None,
        };
        // Original proof can outlive native registration, never current authority.
        if proof.is_some()
            && !matches!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    self.host
                        .session_in_workspace(&d.binding.workspace, &d.binding.session)
                )
                .await,
                Ok(Ok(true))
            )
        {
            proof = None;
        }
        attempt.may_dispatch = false;
        self.store
            .transaction_fenced(fence, move |tx| {
                if store::delivery(tx, &d.key)?.as_ref() != Some(&d) {
                    return Err(Error::IdentityConflict);
                }
                store::put_entity(tx, "automation-attempt", &d.key, &attempt)?;
                if let Some(applied) = proof {
                    d.state = DeliveryState::Completed;
                    d.reason = None;
                    let receipt = ControllerAutomationControl {
                        principal_revision: d.principal_revision,
                        binding_generation: d.binding.generation,
                        applied,
                    };
                    d.result = Some(NativeCommandResult::success(serde_json::to_value(
                        &receipt,
                    )?));
                    let proof = Proof {
                        delivery_sha: digest(&json!(d)),
                        receipt,
                    };
                    store::put_entity(tx, "automation-proof", &d.key, &proof)?;
                } else {
                    d.state = DeliveryState::Uncertain;
                    d.reason = Some("automation-original-proof-unavailable".into());
                    d.result = None;
                }
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }
    /// One cursor covers all receipt-capable uncertain effects, bounded and fair.
    pub async fn native_effect_recovery_candidates(
        &self,
        after: Option<i64>,
    ) -> Result<Vec<Delivery>, Error> {
        self.store.transaction(move |tx| {
            let mut query = tx.prepare("SELECT body FROM inbox AS current WHERE state='uncertain' AND json_extract(body,'$.inbound.command.type') IN ('create_session','automation_control') AND seq>?1 AND NOT EXISTS (SELECT 1 FROM inbox AS earlier WHERE earlier.session=current.session AND earlier.seq<current.seq AND earlier.state IN ('queued','dispatching','uncertain')) ORDER BY seq LIMIT 32")?;
            let rows = query.query_map([after.unwrap_or(0)], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }
}
