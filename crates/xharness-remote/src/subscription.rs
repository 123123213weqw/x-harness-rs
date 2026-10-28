//! Scoped pull-based streams. No queue grows when a controller is slow; the
//! Host's bounded broadcast reports a gap, and history must be restored.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::{
    gateway::{authorize, valid_id, ResultBudget},
    store, *,
};
use futures::{Stream, StreamExt};
use std::{pin::Pin, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_api::{MuxFrame, ServerRequest};

pub type RemoteEventStream = Pin<Box<dyn Stream<Item = Result<ServerRequest, Error>> + Send>>;

/// Identity fields come from the verified transport/controller, not user JSON.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subscription {
    pub principal: String,
    pub sender: Sender,
    pub conversation: String,
    pub binding: String,
    pub generation: u64,
}

impl Gateway {
    pub async fn subscribe(
        self: &Arc<Self>,
        request: Subscription,
        disconnect: CancellationToken,
    ) -> Result<RemoteEventStream, Error> {
        for id in [
            &request.principal,
            &request.sender.account,
            &request.sender.user,
            &request.conversation,
            &request.binding,
        ] {
            valid_id(id)?;
        }
        let permit = self
            .subscriptions
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Capacity)?;
        let (principal, binding) = self.subscription_scope(&request).await?;
        let mut source = self
            .host
            .session_events(&binding.workspace, &binding.session)
            .await
            .map_err(|_| Error::HostUnavailable)?;
        let gateway = self.clone();
        Ok(Box::pin(async_stream::stream! {
            let _permit = permit;
            let mut tick = tokio::time::interval(Duration::from_millis(200));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let frame = tokio::select! {
                    biased;
                    _ = disconnect.cancelled() => break,
                    frame = source.next() => match frame { Some(frame) => Some(frame), None => break },
                    _ = tick.tick() => None,
                };
                // Check native workspace ownership first, then check the latest
                // principal/binding immediately before admitting each frame.
                // Idle subscribers perform the same check on the bounded timer.
                let scope = tokio::select! {
                    biased;
                    _ = disconnect.cancelled() => break,
                    result = gateway.current_subscription_scope(&request, &binding) => result,
                };
                match scope {
                    Ok((current, current_binding)) if current == principal && current_binding == binding => {},
                    Ok(_) | Err(Error::Unauthorized) => { yield Err(Error::Unauthorized); break; },
                    Err(error) => { yield Err(error); break; },
                }
                if let Some(frame) = frame {
                    match canonical_frame(frame, &binding.session) {
                        Ok(canonical) => yield Ok(canonical),
                        Err(error) => { yield Err(error); break; },
                    }
                }
            }
        }))
    }

    async fn current_subscription_scope(
        &self,
        request: &Subscription,
        binding: &Binding,
    ) -> Result<(Principal, Binding), Error> {
        let scope = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&binding.workspace, &binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !scope {
            return Err(Error::Unauthorized);
        }
        self.subscription_scope(request).await
    }

    async fn subscription_scope(
        &self,
        request: &Subscription,
    ) -> Result<(Principal, Binding), Error> {
        let gate = self.principal_gate(&request.principal).await;
        // next() may be interrupted while this pull-stream query is paused.
        // Do not retain a reader across await: a writer + another reader from
        // that same observer would otherwise wait on the paused stream forever.
        let epoch = gate.epoch();
        let request = request.clone();
        let host = self.host_id.clone();
        let scope = self
            .store
            .transaction(move |tx| scope_in_transaction(tx, &host, &request))
            .await?;
        // Non-awaiting commit-point check. A pending writer or an intervening
        // completed/cancelled write invalidates the cached snapshot, even if
        // its SQL result finished before the caller resumed polling the stream.
        let _guard = gate.try_read()?;
        if gate.epoch() != epoch {
            return Err(Error::StreamGap);
        }
        Ok(scope)
    }
}

pub(crate) fn canonical_frame(frame: ServerRequest, session: &str) -> Result<ServerRequest, Error> {
    if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES), &frame).is_err() {
        return Err(Error::Invalid("stream frame exceeds budget"));
    }
    valid_id(frame.rpc_id.as_str()).map_err(|_| Error::Invalid("stream identity"))?;
    // Reconstruct the typed envelope to drop unexpected outer payload fields.
    let parsed = serde_json::from_value::<MuxFrame>(frame.payload)
        .map_err(|_| Error::Invalid("stream frame shape"))?;
    if matches!(parsed, MuxFrame::StreamError { .. }) {
        return Err(Error::StreamGap); // Never leak unscoped diagnostics.
    }
    let canonical = parsed.into_server_request(frame.rpc_id);
    if canonical.method != frame.method || canonical.payload["sessionId"].as_str() != Some(session)
    {
        return Err(Error::Invalid("unscoped Host frame"));
    }
    Ok(canonical)
}

pub(crate) fn scope_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    host: &str,
    request: &Subscription,
) -> Result<(Principal, Binding), Error> {
    let p: Principal =
        store::entity(tx, "principal", &request.principal)?.ok_or(Error::Unauthorized)?;
    let b: Binding = store::entity(tx, "binding", &request.binding)?.ok_or(Error::Unauthorized)?;
    authorize(&p, &b)?;
    if p.host != host
        || p.sender != request.sender
        || b.conversation != request.conversation
        || b.generation != request.generation
    {
        return Err(Error::Unauthorized);
    }
    Ok((p, b))
}

#[cfg(test)]
mod paused_pull_tests {
    use super::*;
    use async_trait::async_trait;
    use xharness_api::{ApiBackend, EventStream, MuxFrame, RpcError, RpcId, RpcMethod, RpcResult};
    struct Host;
    #[async_trait]
    impl ApiBackend for Host {
        async fn call(
            &self,
            _: RpcId,
            _: RpcMethod,
            _: serde_json::Value,
            _: CancellationToken,
        ) -> RpcResult {
            panic!("no dispatch");
        }
        async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
            Ok(w == "w" && s == "s")
        }
        async fn session_events(&self, _: &str, _: &str) -> Result<EventStream, RpcError> {
            Ok(Box::pin(
                futures::stream::iter([MuxFrame::SessionSubscribed {
                    session_id: "s".into(),
                    last_seq: 0,
                }
                .into_server_request(RpcId::new("baseline"))])
                .chain(futures::stream::pending()),
            ))
        }
        async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
            panic!("no respond");
        }
        fn mux_events(&self) -> EventStream {
            panic!("no global mux");
        }
        fn host_events(&self) -> EventStream {
            panic!("no global Host stream");
        }
    }
    #[tokio::test]
    async fn paused_pull_query_cannot_hold_revoke_lock_or_emit_pre_write_authorization() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = Gateway::open(dir.path(), "h".into(), Arc::new(Host)).unwrap();
        let sender = Sender {
            channel: Channel::Telegram,
            account: "bot".into(),
            user: "42".into(),
        };
        gateway
            .set_principal(Principal {
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
        gateway
            .bind(Binding {
                id: "b".into(),
                principal: "p".into(),
                conversation: "42".into(),
                workspace: "w".into(),
                session: "s".into(),
                generation: 1,
            })
            .await
            .unwrap();
        let mut stream = gateway
            .subscribe(
                Subscription {
                    principal: "p".into(),
                    sender,
                    conversation: "42".into(),
                    binding: "b".into(),
                    generation: 1,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = {
            let store = gateway.store.clone();
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
        // Force the real stream to pause in its SQL authorization await, not
        // merely in an unrelated native I/O fixture. Dropping next() retains
        // the stream's internal future, as a refresh-select does in production.
        {
            let mut next = Box::pin(stream.next());
            assert!(futures::poll!(&mut next).is_pending());
        }
        release_tx.send(()).unwrap();
        held.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), gateway.revoke("p"))
            .await
            .expect("paused pull retained policy reader")
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(outcome, Err(Error::Unauthorized | Error::StreamGap)),
            "cached authorization was emitted: {outcome:?}"
        );
        assert!(stream.next().await.is_none());
    }
    #[tokio::test]
    async fn cancelled_authority_writer_stays_fenced_until_queued_sql_commit() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = Gateway::open(dir.path(), "h".into(), Arc::new(Host)).unwrap();
        gateway
            .set_principal(Principal {
                id: "p".into(),
                host: "h".into(),
                sender: Sender {
                    channel: Channel::Telegram,
                    account: "bot".into(),
                    user: "42".into(),
                },
                workspaces: ["w".into()].into(),
                sessions: ["s".into()].into(),
                revision: 1,
                revoked: false,
            })
            .await
            .unwrap();
        let gate = gateway.principal_gate("p").await;
        let before = gate.epoch();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = {
            let store = gateway.store.clone();
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
        let revoke = {
            let g = gateway.clone();
            tokio::spawn(async move { g.revoke("p").await })
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            while gate.try_read().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        revoke.abort();
        assert!(revoke.await.unwrap_err().is_cancelled());
        let retained = gate.try_read().is_err();
        let while_pending = gate.epoch();
        // Always release the fixture SQL blocker before assertions, so even a
        // failed negative-control implementation cannot hang runtime teardown.
        release_tx.send(()).unwrap();
        held.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let revoked = gateway
                    .store
                    .transaction(|tx| {
                        Ok(store::entity::<Principal>(tx, "principal", "p")?
                            .unwrap()
                            .revoked)
                    })
                    .await
                    .unwrap();
                if revoked && gate.try_read().is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            retained,
            "cancelled caller released an uncommitted authority writer"
        );
        assert_eq!(
            while_pending, before,
            "epoch advanced before the queued commit"
        );
        assert!(gate.epoch() > before);
    }
}
