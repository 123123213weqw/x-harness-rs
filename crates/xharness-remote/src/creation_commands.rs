//! Inbox-owned creation: immutable admission, native proof and revision transition.
use crate::{
    creation::creation_key,
    gateway::{authorize, digest},
    store, *,
};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use xharness_api::{ScopedSessionCreate, ScopedSessionCreated};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerCreated {
    pub previous_revision: u64,
    pub principal_revision: u64,
    pub binding: Binding,
    pub created: ScopedSessionCreated,
}
impl ControllerCreated {
    /// Structural receipt validation, never an authority or native proof.
    pub fn is_for_delivery(&self, d: &Delivery) -> bool {
        let Command::CreateSession { workspace } = &d.inbound.command else {
            return false;
        };
        let native = ScopedSessionCreate {
            workspace: workspace.clone(),
            request_key: self.created.request_key.clone(),
        };
        d.state == DeliveryState::Completed
            && d.principal == d.binding.principal
            && d.principal_revision > 0
            && self.previous_revision == d.principal_revision
            && Some(self.principal_revision) == d.principal_revision.checked_add(1)
            && self.binding == d.binding
            && self.binding.generation > 0
            && d.inbound.binding == d.binding.id
            && d.inbound.generation == d.binding.generation
            && native.is_bounded()
            && native.receipt() == self.created
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    delivery_sha: String,
    receipt: ControllerCreated,
    before: Principal,
    after: Principal,
    policy: CreationPolicy,
    creation: SessionCreation,
}
fn request(d: &Delivery) -> Result<SessionCreationRequest, Error> {
    let Command::CreateSession { workspace } = &d.inbound.command else {
        return Err(Error::Invalid("creation command"));
    };
    Ok(SessionCreationRequest {
        request_id: format!("inbox:{}", d.key),
        workspace: workspace.clone(),
    })
}
fn parent_key(host: &str, p: &Principal) -> String {
    digest(&json!(["creation-revision-v1", host, p.id, p.revision]))
}
fn proof_valid(
    tx: &Transaction<'_>,
    host: &str,
    d: &Delivery,
    proof: &Proof,
) -> Result<bool, Error> {
    let r = &proof.receipt;
    let c = &proof.creation;
    let mut expected = proof.before.clone();
    if expected.sessions.contains(&r.created.session) {
        return Ok(false);
    }
    expected.sessions.insert(r.created.session.clone());
    expected.revision = expected
        .revision
        .checked_add(1)
        .ok_or(Error::IdentityConflict)?;
    let native = ScopedSessionCreate {
        workspace: r.created.workspace.clone(),
        request_key: creation_key(host, &c.scope, &request(d)?.request_id)?,
    };
    Ok(r.is_for_delivery(d)
        && proof.delivery_sha == digest(&json!(d))
        && proof.before.host == host
        && proof.before.id == d.principal
        && proof.before.revision == d.principal_revision
        && authorize(&proof.before, &d.binding).is_ok()
        && expected == proof.after
        && !proof.after.revoked
        && proof.policy.principal == proof.before.id
        && proof.policy.principal_revision == proof.before.revision
        && proof.policy.generation > 0
        && proof.policy.workspaces.is_subset(&proof.before.workspaces)
        && proof.policy.workspaces.contains(&r.created.workspace)
        && c.state == SessionCreationState::Granted
        && c.created.as_ref() == Some(&r.created)
        && c.granted_revision == Some(r.principal_revision)
        && c.principal_revision == d.principal_revision
        && c.binding == d.binding
        && c.request == request(d)?
        && c.key == native.request_key
        && native.receipt() == r.created
        && c.scope
            == Subscription {
                principal: proof.before.id.clone(),
                sender: proof.before.sender.clone(),
                conversation: d.binding.conversation.clone(),
                binding: d.binding.id.clone(),
                generation: d.binding.generation,
            }
        && store::entity::<SessionCreation>(tx, "session-creation", &c.key)?.as_ref() == Some(c)
        && d.result.as_ref() == Some(&NativeCommandResult::success(serde_json::to_value(r)?)))
}
pub(crate) fn validate_dispatch(
    tx: &Transaction<'_>,
    d: &Delivery,
    p: &Principal,
    b: &Binding,
) -> Result<(), Error> {
    if !matches!(
        d.state,
        DeliveryState::Queued | DeliveryState::Dispatching | DeliveryState::Uncertain
    ) || d.principal != p.id
        || d.principal_revision != p.revision
        || d.binding != *b
        || store::delivery(tx, &d.key)?.as_ref() != Some(d)
    {
        return Err(Error::Unauthorized);
    }
    let earlier:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM inbox WHERE session=?1 AND seq<?2 AND state IN ('queued','dispatching','uncertain'))",params![d.binding.session,d.sequence],|r|r.get(0))?;
    if earlier {
        return Err(Error::SessionBlocked);
    }
    Ok(())
}
pub(crate) fn commit_grant(
    tx: &Transaction<'_>,
    host: &str,
    mut d: Delivery,
    before: Principal,
    after: Principal,
    policy: CreationPolicy,
    c: &SessionCreation,
) -> Result<(), Error> {
    if store::delivery(tx, &d.key)?.as_ref() != Some(&d) {
        return Err(Error::IdentityConflict);
    }
    let receipt = ControllerCreated {
        previous_revision: before.revision,
        principal_revision: after.revision,
        binding: d.binding.clone(),
        created: c.created.clone().ok_or(Error::IdentityConflict)?,
    };
    d.state = DeliveryState::Completed;
    d.reason = None;
    d.result = Some(NativeCommandResult::success(serde_json::to_value(
        &receipt,
    )?));
    let proof = Proof {
        delivery_sha: digest(&json!(d)),
        receipt,
        before,
        after,
        policy,
        creation: c.clone(),
    };
    if !proof_valid(tx, host, &d, &proof)? {
        return Err(Error::IdentityConflict);
    }
    store::put_entity(tx, "creation-command-proof", &d.key, &proof)?;
    store::put_entity(
        tx,
        "creation-revision",
        &parent_key(host, &proof.after),
        &d.key,
    )?;
    store::save(tx, &d)
}
pub(crate) fn reply_in_scope(
    tx: &Transaction<'_>,
    host: &str,
    d: &Delivery,
    p: &Principal,
    b: &Binding,
) -> Result<bool, Error> {
    let Some(proof) = store::entity::<Proof>(tx, "creation-command-proof", &d.key)? else {
        return Ok(false);
    };
    Ok(proof_valid(tx, host, d, &proof)?
        && proof.after == *p
        && proof.receipt.binding == *b
        && authorize(p, b).is_ok())
}
/// Only a certified additive grant can bridge projection provenance. Ordinary
/// desktop edits/revocation have no parent, and scope still authorizes every use.
pub(crate) fn projection_parent(
    tx: &Transaction<'_>,
    host: &str,
    p: &Principal,
) -> Result<Option<Principal>, Error> {
    let Some(key) = store::entity::<String>(tx, "creation-revision", &parent_key(host, p))? else {
        return Ok(None);
    };
    let proof: Proof =
        store::entity(tx, "creation-command-proof", &key)?.ok_or(Error::IdentityConflict)?;
    let d = store::delivery(tx, &key)?.ok_or(Error::IdentityConflict)?;
    if proof.after != *p || !proof_valid(tx, host, &d, &proof)? {
        return Err(Error::IdentityConflict);
    }
    Ok(Some(proof.before))
}
impl Gateway {
    pub(crate) async fn dispatch_create_command(
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
        tokio::spawn(async move {
            let session = g.session_gate(&initial.binding.session).await;
            let _fifo = session.lock_owned().await;
            let d = g
                .inspect(&initial.key)
                .await?
                .ok_or(Error::Invalid("unknown request"))?;
            if !matches!(
                d.state,
                DeliveryState::Queued | DeliveryState::Dispatching | DeliveryState::Uncertain
            ) {
                return Ok(d);
            }
            let id = d.principal.clone();
            let p: Principal = g
                .store
                .transaction(move |tx| {
                    store::entity(tx, "principal", &id)?.ok_or(Error::Unauthorized)
                })
                .await?;
            let scope = Subscription {
                principal: p.id.clone(),
                sender: p.sender,
                conversation: d.binding.conversation.clone(),
                binding: d.binding.id.clone(),
                generation: d.binding.generation,
            };
            let result = g
                .create_owned(scope, request(&d)?, permit, Some(d.clone()))
                .await;
            match result {
                Ok(_) | Err(Error::HostUnavailable) => {
                    g.inspect(&d.key).await?.ok_or(Error::IdentityConflict)
                }
                Err(
                    Error::Unauthorized
                    | Error::IdentityConflict
                    | Error::Capacity
                    | Error::Invalid(_),
                ) => {
                    let gate = g.principal_gate(&d.principal).await;
                    let guard = gate.write().await;
                    g.store
                        .transaction_fenced(guard, move |tx| {
                            let mut current =
                                store::delivery(tx, &d.key)?.ok_or(Error::IdentityConflict)?;
                            if matches!(
                                current.state,
                                DeliveryState::Queued
                                    | DeliveryState::Dispatching
                                    | DeliveryState::Uncertain
                            ) {
                                current.state = if current.state == DeliveryState::Queued {
                                    DeliveryState::Rejected
                                } else {
                                    DeliveryState::Uncertain
                                };
                                current.result = None;
                                current.reason =
                                    Some("creation-authority-or-capacity-unavailable".into());
                                store::save(tx, &current)?;
                            }
                            Ok(current)
                        })
                        .await
                }
                Err(e) => Err(e),
            }
        })
        .await
        .map_err(|_| Error::WorkerFailed)?
    }
    /// Receipt-only recovery has an independent bounded round-robin scan, so
    /// uncertain effects neither replay nor starve unrelated queued sessions.
    pub async fn creation_recovery_candidates(
        &self,
        after: Option<i64>,
    ) -> Result<Vec<Delivery>, Error> {
        self.store.transaction(move|tx|{
            let mut q=tx.prepare("SELECT body FROM inbox AS current WHERE state='uncertain' AND json_extract(body,'$.inbound.command.type')='create_session' AND seq>?1
              AND NOT EXISTS (SELECT 1 FROM inbox AS earlier WHERE earlier.session=current.session AND earlier.seq<current.seq AND earlier.state IN ('queued','dispatching','uncertain')) ORDER BY seq LIMIT 32")?;
            let rows=q.query_map([after.unwrap_or(0)],|r|r.get::<_,String>(0))?;
            rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::{
        collections::BTreeMap,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };
    use tokio_util::sync::CancellationToken;
    use xharness_api::{
        ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    };
    struct Host {
        calls: AtomicUsize,
        receipts: Mutex<BTreeMap<String, ScopedSessionCreated>>,
    }
    #[async_trait]
    impl ApiBackend for Host {
        async fn call(
            &self,
            _: RpcId,
            _: RpcMethod,
            _: serde_json::Value,
            _: CancellationToken,
        ) -> RpcResult {
            panic!("no generic call");
        }
        async fn respond(&self, _: ClientResponse) -> RpcReceipt {
            panic!("no respond");
        }
        fn host_events(&self) -> EventStream {
            panic!("no global events");
        }
        fn mux_events(&self) -> EventStream {
            panic!("no mux");
        }
        async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
            Ok(w == "w"
                && (s == "s"
                    || self
                        .receipts
                        .lock()
                        .unwrap()
                        .values()
                        .any(|r| r.session == s)))
        }
        async fn session_event_page(
            &self,
            _: &str,
            _: &str,
            after: Option<u64>,
        ) -> Result<ScopedEventPage, RpcError> {
            let n = after.unwrap_or(7);
            Ok(ScopedEventPage {
                start_seq: n,
                next_seq: n,
                head_seq: n,
                events: vec![],
            })
        }
        async fn create_scoped_session(
            &self,
            r: ScopedSessionCreate,
        ) -> Result<ScopedSessionCreated, RpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let created = r.receipt();
            self.receipts
                .lock()
                .unwrap()
                .insert(r.request_key, created.clone());
            Ok(created)
        }
        async fn scoped_session_creation_receipt(
            &self,
            r: ScopedSessionCreate,
        ) -> Result<Option<ScopedSessionCreated>, RpcError> {
            Ok(self.receipts.lock().unwrap().get(&r.request_key).cloned())
        }
    }
    async fn setup(g: &Gateway) -> Subscription {
        let sender = Sender {
            channel: Channel::Telegram,
            account: "123".into(),
            user: "42".into(),
        };
        g.set_principal(Principal {
            id: "p".into(),
            host: "h".into(),
            sender: sender.clone(),
            workspaces: ["w".into()].into(),
            sessions: ["s".into()].into(),
            revision: 1,
            revoked: false,
        })
        .await
        .unwrap();
        g.bind(Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "w".into(),
            session: "s".into(),
            generation: 1,
        })
        .await
        .unwrap();
        g.set_creation_policy(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["w".into()].into(),
        })
        .await
        .unwrap();
        Subscription {
            principal: "p".into(),
            sender,
            conversation: "42".into(),
            binding: "b".into(),
            generation: 1,
        }
    }
    #[tokio::test]
    async fn full_u64_creation_transition_needs_private_proof_and_exhausted_principal_can_be_revoked(
    ) {
        let root = tempfile::tempdir().unwrap();
        let h = Arc::new(Host {
            calls: AtomicUsize::new(0),
            receipts: Mutex::new(BTreeMap::new()),
        });
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let scope = setup(&g).await;
        g.store
            .transaction(|tx| {
                let mut p: Principal = store::entity(tx, "principal", "p")?.unwrap();
                p.revision = u64::MAX - 1;
                store::put_entity(tx, "principal", "p", &p)?;
                let mut cap: CreationPolicy = store::entity(tx, "creation-policy", "p")?.unwrap();
                cap.principal_revision = p.revision;
                store::put_entity(tx, "creation-policy", "p", &cap)
            })
            .await
            .unwrap();
        let l = g
            .acquire_account(Account {
                channel: Channel::Telegram,
                id: "123".into(),
            })
            .await
            .unwrap();
        let cp = g.projection_checkpoint(&l, scope.clone()).await.unwrap();
        g.advance_projection(
            &l,
            scope.clone(),
            cp,
            ProjectionUpdate {
                next_seq: 5,
                state: json!({"fixture":"preserved"}),
                retain: Default::default(),
                replies: vec![],
            },
        )
        .await
        .unwrap();
        let d = g
            .accept(
                "p",
                scope.sender.clone(),
                "42".into(),
                Inbound {
                    request_id: "maximum".into(),
                    binding: "b".into(),
                    generation: 1,
                    command: Command::CreateSession {
                        workspace: "w".into(),
                    },
                },
            )
            .await
            .unwrap();
        let done = g.dispatch(&d.key).await.unwrap();
        assert_eq!(done.principal_revision, u64::MAX - 1);
        assert_eq!(
            g.command_reply_candidate(&l, scope.clone()).await.unwrap(),
            Some(done.clone())
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        let key = done.key.clone();
        let proof: String = g
            .store
            .transaction(move |tx| {
                Ok(tx.query_row(
                    "SELECT body FROM entities WHERE kind='creation-command-proof' AND id=?1",
                    [key],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        let key = done.key.clone();
        g.store
            .transaction(move |tx| {
                tx.execute(
                    "DELETE FROM entities WHERE kind='creation-command-proof' AND id=?1",
                    [key],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(g
            .command_reply_candidate(&l, scope.clone())
            .await
            .unwrap()
            .is_none());
        assert!(matches!(
            g.projection_checkpoint(&l, scope.clone()).await,
            Err(Error::IdentityConflict)
        ));
        let plans = vec![ReplyPlan {
            id: "maximum-create".into(),
            body: ReplyBody {
                text: "Created".into(),
                buttons: vec![],
                attachment: None,
            },
            replace_of: None,
        }];
        assert!(g
            .enqueue_command_replies(&l, scope.clone(), done.clone(), plans.clone())
            .await
            .is_err());
        let key = done.key.clone();
        let mut bad: Proof = serde_json::from_str(&proof).unwrap();
        bad.delivery_sha = "not-original".into();
        g.store
            .transaction(move |tx| store::put_entity(tx, "creation-command-proof", &key, &bad))
            .await
            .unwrap();
        assert!(matches!(
            g.command_reply_candidate(&l, scope.clone()).await,
            Err(Error::Unauthorized)
        ));
        let key = done.key.clone();
        g.store
            .transaction(move |tx| {
                let p: Proof = serde_json::from_str(&proof)?;
                store::put_entity(tx, "creation-command-proof", &key, &p)
            })
            .await
            .unwrap();
        let cp = g.projection_checkpoint(&l, scope.clone()).await.unwrap();
        assert_eq!(cp.next_seq, 5);
        let out = g
            .enqueue_command_replies(&l, scope.clone(), done, plans)
            .await
            .unwrap();
        assert_eq!(out[0].principal_revision, u64::MAX);
        g.revoke("p").await.unwrap();
        let p: Principal = g
            .store
            .transaction(|tx| store::entity(tx, "principal", "p")?.ok_or(Error::IdentityConflict))
            .await
            .unwrap();
        assert!(p.revoked);
        assert_eq!(p.revision, u64::MAX);
        assert!(matches!(
            g.command_reply_candidate(&l, scope).await,
            Err(Error::Unauthorized)
        ));
        assert!(matches!(
            g.set_principal(Principal {
                revision: 1,
                revoked: false,
                ..p
            })
            .await,
            Err(Error::IdentityConflict)
        ));
    }
    #[tokio::test]
    async fn future_id_in_old_allowlist_cannot_certify_an_additive_creation_transition() {
        let root = tempfile::tempdir().unwrap();
        let h = Arc::new(Host {
            calls: AtomicUsize::new(0),
            receipts: Mutex::new(BTreeMap::new()),
        });
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let scope = setup(&g).await;
        let d = g
            .accept(
                "p",
                scope.sender.clone(),
                "42".into(),
                Inbound {
                    request_id: "future".into(),
                    binding: "b".into(),
                    generation: 1,
                    command: Command::CreateSession {
                        workspace: "w".into(),
                    },
                },
            )
            .await
            .unwrap();
        let key = creation_key("h", &scope, &request(&d).unwrap().request_id).unwrap();
        let session = ScopedSessionCreate {
            workspace: "w".into(),
            request_key: key,
        }
        .session_id();
        g.store
            .transaction(move |tx| {
                let mut p: Principal = store::entity(tx, "principal", "p")?.unwrap();
                p.sessions.insert(session);
                store::put_entity(tx, "principal", "p", &p)
            })
            .await
            .unwrap();
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Rejected
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    }
}
