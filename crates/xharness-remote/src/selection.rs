//! Inbox-owned route transitions. Original authenticated deliveries never mutate.
use crate::{
    gateway::{authorize, digest, PolicyWriteGuard},
    store,
    subscription::scope_in_transaction,
    *,
};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use xharness_api::ScopedCatalogueQuery;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerSelection {
    pub principal_revision: u64,
    pub previous_binding: Binding,
    pub binding: Binding,
}
impl ControllerSelection {
    /// Closed structural receipt check only. The journal proof and live scope
    /// must also match before any reply can be enqueued or sent.
    pub fn is_for_delivery(&self, d: &Delivery) -> bool {
        let Command::Select { target } = &d.inbound.command else {
            return false;
        };
        let mut expected = d.binding.clone();
        if expected.workspace != target.workspace || expected.session != target.session {
            let Some(next) = expected.generation.checked_add(1) else {
                return false;
            };
            expected.generation = next;
            expected.workspace = target.workspace.clone();
            expected.session = target.session.clone();
        }
        [
            &d.principal,
            &self.binding.id,
            &self.binding.principal,
            &self.binding.conversation,
            &target.workspace,
            &target.session,
        ]
        .into_iter()
        .all(|id| crate::gateway::valid_id(id).is_ok())
            && d.principal == d.binding.principal
            && d.binding.generation > 0
            && d.state == DeliveryState::Completed
            && self.principal_revision > 0
            && self.principal_revision == d.principal_revision
            && self.previous_binding == d.binding
            && self.binding == expected
            && d.inbound.binding == d.binding.id
            && d.inbound.generation == d.binding.generation
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    delivery_sha: String,
    selection: ControllerSelection,
}
pub(crate) fn reply_in_scope(
    tx: &Transaction<'_>,
    d: &Delivery,
    p: &Principal,
    b: &Binding,
) -> Result<bool, Error> {
    let Some(proof) = store::entity::<Proof>(tx, "selection-receipt", &d.key)? else {
        return Ok(false);
    };
    let Some(NativeCommandResult::Success { value: Some(value) }) = &d.result else {
        return Ok(false);
    };
    Ok(proof.selection.is_for_delivery(d)
        && proof.delivery_sha == digest(&json!(d))
        && serde_json::to_value(&proof.selection)? == *value
        && proof.selection.binding == *b
        && d.principal == p.id
        && d.principal_revision == p.revision
        && authorize(p, b).is_ok())
}
impl Gateway {
    /// Caller already owns the original session FIFO; exclusively fence policy
    /// once, never upgrade or recursively acquire the fair lock.
    pub(crate) async fn dispatch_selection(
        &self,
        initial: Delivery,
        guard: PolicyWriteGuard,
    ) -> Result<Delivery, Error> {
        let key = initial.key;
        let host = self.host_id.clone();
        let (d,principal)=self.store.transaction(move|tx|{
            let mut d=store::delivery(tx,&key)?.ok_or(Error::Invalid("unknown request"))?;
            if !matches!(d.state,DeliveryState::Queued|DeliveryState::Dispatching) {return Ok((d,None));}
            let earlier:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM inbox WHERE session=?1 AND seq<?2 AND state IN ('queued','dispatching','uncertain'))",params![d.binding.session,d.sequence],|r|r.get(0))?;
            if earlier {return Err(Error::SessionBlocked);}
            let p=store::entity::<Principal>(tx,"principal",&d.principal)?;
            let b=store::entity::<Binding>(tx,"binding",&d.binding.id)?;
            let valid=p.as_ref().zip(b.as_ref()).is_some_and(|(p,b)|p.host==host&&p.revision==d.principal_revision&&*b==d.binding&&authorize(p,b).is_ok());
            // No selection ever commits Dispatching: its entire effect is one
            // journal transaction. An unexpected legacy state fails closed.
            if !valid || d.state==DeliveryState::Dispatching {
                d.state=if d.state==DeliveryState::Dispatching {DeliveryState::Uncertain}else{DeliveryState::Rejected};
                d.reason=Some("selection-authorization-changed".into());store::save(tx,&d)?;return Ok((d,None));
            }
            Ok((d,p))
        }).await?;
        let Some(principal) = principal else {
            return Ok(d);
        };
        let Command::Select { target } = &d.inbound.command else {
            return Err(Error::Invalid("selection command"));
        };
        let target = target.clone();
        if !principal.workspaces.contains(&target.workspace)
            || !principal.sessions.contains(&target.session)
        {
            return self
                .reject_selection(d, "selection-target-outside-grant", guard)
                .await;
        }
        if (d.binding.workspace != target.workspace || d.binding.session != target.session)
            && d.binding.generation.checked_add(1).is_none()
        {
            return self
                .reject_selection(d, "selection-generation-exhausted", guard)
                .await;
        }
        let query = ScopedCatalogueQuery {
            workspaces: [target.workspace.clone()].into(),
            sessions: [target.session.clone()].into(),
            after: None,
        };
        let page = match tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_catalogue(query.clone()),
        )
        .await
        {
            Ok(Ok(page)) if query.admits(&page) => page,
            _ => return self.fail_selection(d, guard).await,
        };
        if page.sessions.len() != 1 {
            return self
                .reject_selection(d, "selection-target-unavailable", guard)
                .await;
        }
        let mut selected = d.binding.clone();
        if selected.workspace != target.workspace || selected.session != target.session {
            selected.generation = selected
                .generation
                .checked_add(1)
                .ok_or(Error::IdentityConflict)?;
            selected.workspace = target.workspace;
            selected.session = target.session;
        }
        let receipt = ControllerSelection {
            principal_revision: principal.revision,
            previous_binding: d.binding.clone(),
            binding: selected.clone(),
        };
        let host = self.host_id.clone();
        self.store
            .transaction_fenced(guard, move |tx| {
                if store::delivery(tx, &d.key)?.as_ref() != Some(&d) {
                    return Err(Error::IdentityConflict);
                }
                let scope = Subscription {
                    principal: principal.id.clone(),
                    sender: principal.sender.clone(),
                    conversation: d.binding.conversation.clone(),
                    binding: d.binding.id.clone(),
                    generation: d.binding.generation,
                };
                let (p, b) = scope_in_transaction(tx, &host, &scope)?;
                if p != principal || b != d.binding {
                    return Err(Error::Unauthorized);
                }
                if selected != b {
                    crate::projection::seed_selected_projection(tx, &host, &scope, &p, &selected)?;
                }
                let mut done = d;
                done.state = DeliveryState::Completed;
                done.result = Some(NativeCommandResult::success(serde_json::to_value(
                    &receipt,
                )?));
                done.reason = None;
                store::put_entity(tx, "binding", &selected.id, &selected)?;
                store::put_entity(
                    tx,
                    "selection-receipt",
                    &done.key,
                    &Proof {
                        delivery_sha: digest(&json!(done)),
                        selection: receipt,
                    },
                )?;
                store::save(tx, &done)?;
                Ok(done)
            })
            .await
    }
    async fn fail_selection(
        &self,
        mut d: Delivery,
        guard: PolicyWriteGuard,
    ) -> Result<Delivery, Error> {
        d.state = DeliveryState::Completed;
        d.reason = Some("selection-target-read-unavailable".into());
        d.result = Some(NativeCommandResult::failure(
            xharness_api::RpcError::internal("scoped selection unavailable"),
        ));
        self.store
            .transaction_fenced(guard, move |tx| {
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }
    async fn reject_selection(
        &self,
        mut d: Delivery,
        reason: &'static str,
        guard: PolicyWriteGuard,
    ) -> Result<Delivery, Error> {
        d.state = DeliveryState::Rejected;
        d.reason = Some(reason.into());
        self.store
            .transaction_fenced(guard, move |tx| {
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use xharness_api::{
        ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    };
    struct Host {
        entered: Notify,
        release: Notify,
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
            panic!("no generic calls");
        }
        async fn respond(&self, _: ClientResponse) -> RpcReceipt {
            panic!("no response");
        }
        fn mux_events(&self) -> EventStream {
            panic!("no mux");
        }
        fn host_events(&self) -> EventStream {
            panic!("no global events");
        }
        async fn session_in_workspace(&self, _: &str, _: &str) -> Result<bool, RpcError> {
            Ok(true)
        }
        async fn session_event_page(
            &self,
            _: &str,
            _: &str,
            after: Option<u64>,
        ) -> Result<ScopedEventPage, RpcError> {
            let n = after.unwrap_or(8);
            Ok(ScopedEventPage {
                start_seq: n,
                next_seq: n,
                head_seq: n,
                events: vec![],
            })
        }
        async fn scoped_catalogue(
            &self,
            q: ScopedCatalogueQuery,
        ) -> Result<ScopedCataloguePage, RpcError> {
            self.entered.notify_one();
            self.release.notified().await;
            let target = q.sessions.iter().next().unwrap().clone();
            Ok(ScopedCataloguePage {
                workspaces: q
                    .workspaces
                    .into_iter()
                    .map(|w| CatalogueWorkspace {
                        id: w,
                        title: "Native".into(),
                    })
                    .collect(),
                sessions: vec![CatalogueSession {
                    workspace: "w".into(),
                    id: target,
                    title: None,
                    running: false,
                    restoring: false,
                }],
                next: None,
            })
        }
    }
    fn scope_for_test_sender() -> Sender {
        Sender {
            channel: Channel::Telegram,
            account: "123".into(),
            user: "42".into(),
        }
    }
    async fn setup(g: &Gateway) -> Sender {
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
            sessions: ["original".into(), "target".into()].into(),
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
            session: "original".into(),
            generation: 1,
        })
        .await
        .unwrap();
        sender
    }
    #[tokio::test]
    async fn cancelled_selection_commit_retains_writer_and_commits_binding_proof_result_together() {
        let root = tempfile::tempdir().unwrap();
        let h = Arc::new(Host {
            entered: Notify::new(),
            release: Notify::new(),
        });
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let sender = setup(&g).await;
        let original_scope = Subscription {
            principal: "p".into(),
            sender: sender.clone(),
            conversation: "42".into(),
            binding: "b".into(),
            generation: 1,
        };
        let initial_lease = g
            .acquire_account(Account {
                channel: Channel::Telegram,
                id: "123".into(),
            })
            .await
            .unwrap();
        g.projection_checkpoint(&initial_lease, original_scope)
            .await
            .unwrap();
        let d = g
            .accept(
                "p",
                sender.clone(),
                "42".into(),
                Inbound {
                    request_id: "select".into(),
                    binding: "b".into(),
                    generation: 1,
                    command: Command::Select {
                        target: SessionSelection {
                            workspace: "w".into(),
                            session: "target".into(),
                        },
                    },
                },
            )
            .await
            .unwrap();
        let gate = g.principal_gate("p").await;
        let before = gate.epoch();
        let mut dispatch = Box::pin(g.dispatch(&d.key));
        tokio::select! {biased; _=h.entered.notified()=>{}, result=&mut dispatch=>panic!("metadata not paused: {result:?}")};
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = {
            let store = g.store.clone();
            tokio::spawn(async move {
                store
                    .transaction(move |_| {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .await
            })
        };
        entered_rx.await.unwrap();
        h.release.notify_one();
        // Poll the *same* native continuation synchronously to its final SQL
        // await. The Host returns ready and the SQL mutex is held: the owned
        // write guard has now moved into the queued blocking job, not its caller.
        assert!(futures::poll!(&mut dispatch).is_pending());
        drop(dispatch);
        let retained = gate.try_read().is_err();
        let pending_epoch = gate.epoch();
        release_tx.send(()).unwrap();
        held.await.unwrap().unwrap();
        let done = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let d = g.inspect(&d.key).await.unwrap().unwrap();
                if d.state == DeliveryState::Completed {
                    break d;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(retained);
        assert_eq!(pending_epoch, before);
        // SQL completion can become observable just before the detached worker
        // drops its policy guard. Synchronize on that guard, as real readers do.
        let read_guard = tokio::time::timeout(Duration::from_secs(3), gate.read())
            .await
            .expect("selection policy writer was not released after commit");
        assert!(gate.epoch() > before);
        drop(read_guard);
        let scope = Subscription {
            principal: "p".into(),
            sender,
            conversation: "42".into(),
            binding: "b".into(),
            generation: 2,
        };
        let l = g
            .acquire_account(Account {
                channel: Channel::Telegram,
                id: "123".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            g.command_reply_candidate(&l, scope.clone()).await.unwrap(),
            Some(done.clone())
        );
        assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
        // A structurally valid result alone cannot stand in for the FULL proof.
        let key = done.key.clone();
        let proof: String = g
            .store
            .transaction(move |tx| {
                Ok(tx.query_row(
                    "SELECT body FROM entities WHERE kind='selection-receipt' AND id=?1",
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
                    "DELETE FROM entities WHERE kind='selection-receipt' AND id=?1",
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
        let plans = vec![ReplyPlan {
            id: "proof-result".into(),
            body: ReplyBody {
                text: "Selected".into(),
                buttons: vec![],
                attachment: None,
            },
            replace_of: None,
        }];
        assert!(matches!(
            g.enqueue_command_replies(&l, scope.clone(), done.clone(), plans.clone())
                .await,
            Err(Error::IdentityConflict)
        ));
        let key = done.key.clone();
        let mut bad: Proof = serde_json::from_str(&proof).unwrap();
        bad.delivery_sha = "not-the-original-delivery".into();
        g.store
            .transaction(move |tx| store::put_entity(tx, "selection-receipt", &key, &bad))
            .await
            .unwrap();
        assert!(matches!(
            g.command_reply_candidate(&l, scope.clone()).await,
            Err(Error::Unauthorized)
        ));
        let key = done.key.clone();
        g.store
            .transaction(move |tx| {
                let proof: Proof = serde_json::from_str(&proof)?;
                store::put_entity(tx, "selection-receipt", &key, &proof)
            })
            .await
            .unwrap();
        assert_eq!(
            g.enqueue_command_replies(&l, scope, done, plans)
                .await
                .unwrap()
                .len(),
            1
        );
        let (resume_id, resume_body): (String, String) = g
            .store
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT id,body FROM entities WHERE kind='projection-resume'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .await
            .unwrap();
        let id = resume_id.clone();
        g.store.transaction(move|tx|{tx.execute("UPDATE entities SET body=json_set(body,'$.binding.conversation','foreign') WHERE kind='projection-resume' AND id=?1",[id])?;Ok(())}).await.unwrap();
        let back = g
            .accept(
                "p",
                scope_for_test_sender(),
                "42".into(),
                Inbound {
                    request_id: "back".into(),
                    binding: "b".into(),
                    generation: 2,
                    command: Command::Select {
                        target: SessionSelection {
                            workspace: "w".into(),
                            session: "original".into(),
                        },
                    },
                },
            )
            .await
            .unwrap();
        h.release.notify_one();
        assert!(matches!(
            g.dispatch(&back.key).await,
            Err(Error::IdentityConflict)
        ));
        assert_eq!(g.inspect(&back.key).await.unwrap(), Some(back.clone()));
        let route = g
            .resolve_sender(scope_for_test_sender(), "42".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(route.binding.generation, 2);
        assert_eq!(route.binding.session, "target");
        g.store
            .transaction(move |tx| {
                tx.execute(
                    "UPDATE entities SET body=?1 WHERE kind='projection-resume' AND id=?2",
                    params![resume_body, resume_id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        h.release.notify_one();
        let selected = g.dispatch(&back.key).await.unwrap();
        assert_eq!(selected.state, DeliveryState::Completed);
    }
    #[tokio::test]
    async fn selection_reply_scope_preserves_full_u64_generations_and_exhaustion_is_terminal() {
        let root = tempfile::tempdir().unwrap();
        let h = Arc::new(Host {
            entered: Notify::new(),
            release: Notify::new(),
        });
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let sender = setup(&g).await;
        g.store
            .transaction(|tx| {
                let mut p: Principal = store::entity(tx, "principal", "p")?.unwrap();
                p.revision = u64::MAX - 1;
                store::put_entity(tx, "principal", "p", &p)?;
                let mut b: Binding = store::entity(tx, "binding", "b")?.unwrap();
                b.generation = u64::MAX - 1;
                store::put_entity(tx, "binding", "b", &b)
            })
            .await
            .unwrap();
        let inbound = |id: &str, generation, session: &str| Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation,
            command: Command::Select {
                target: SessionSelection {
                    workspace: "w".into(),
                    session: session.into(),
                },
            },
        };
        let d = g
            .accept(
                "p",
                sender.clone(),
                "42".into(),
                inbound("large", u64::MAX - 1, "target"),
            )
            .await
            .unwrap();
        h.release.notify_one();
        let done = g.dispatch(&d.key).await.unwrap();
        assert_eq!(done.principal_revision, u64::MAX - 1);
        let scope = Subscription {
            principal: "p".into(),
            sender: sender.clone(),
            conversation: "42".into(),
            binding: "b".into(),
            generation: u64::MAX,
        };
        let l = g
            .acquire_account(Account {
                channel: Channel::Telegram,
                id: "123".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            g.command_reply_candidate(&l, scope.clone()).await.unwrap(),
            Some(done.clone())
        );
        g.enqueue_command_replies(
            &l,
            scope.clone(),
            done,
            vec![ReplyPlan {
                id: "large-scope".into(),
                body: ReplyBody {
                    text: "Selected".into(),
                    buttons: vec![],
                    attachment: None,
                },
                replace_of: None,
            }],
        )
        .await
        .unwrap();
        let d = g
            .accept(
                "p",
                sender,
                "42".into(),
                inbound("exhausted", u64::MAX, "original"),
            )
            .await
            .unwrap();
        let rejected = g.dispatch(&d.key).await.unwrap();
        assert_eq!(rejected.state, DeliveryState::Rejected);
        assert_eq!(
            rejected.reason.as_deref(),
            Some("selection-generation-exhausted")
        );
        assert_eq!(
            g.command_reply_candidate(&l, scope).await.unwrap(),
            Some(rejected)
        );
    }
}
