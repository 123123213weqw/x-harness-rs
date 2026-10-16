//! Trusted atomic desktop authority; never an external RPC proxy.
use async_trait::async_trait;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};
use tokio_util::sync::CancellationToken;
use xharness_api::*;
use xharness_remote::*;
struct Host;
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("scope setup must not execute Agent");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no arbitrary response");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && (s == "s" || s == "new"))
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        let workspaces = ["w", "w2"]
            .into_iter()
            .filter(|w| q.workspaces.contains(*w))
            .map(|w| CatalogueWorkspace {
                id: w.into(),
                title: w.into(),
            })
            .collect();
        let mut sessions = Vec::new();
        for (w, s) in [
            ("w".to_owned(), "s".to_owned()),
            ("w".into(), "new".into()),
            ("w2".into(), "t".into()),
        ]
        .into_iter()
        .chain((0..30).map(|i| ("w".into(), format!("s-{i:02}"))))
        {
            let entry = CatalogueSession {
                workspace: w,
                id: s,
                title: None,
                running: false,
                restoring: false,
            };
            if q.workspaces.contains(&entry.workspace)
                && q.sessions.contains(&entry.id)
                && q.after.as_ref().is_none_or(|after| entry.cursor() > *after)
            {
                sessions.push(entry);
            }
        }
        sessions.sort_by_key(CatalogueSession::cursor);
        let next = if sessions.len() > 25 {
            sessions.truncate(25);
            sessions.last().map(CatalogueSession::cursor)
        } else {
            None
        };
        Ok(ScopedCataloguePage {
            workspaces,
            sessions,
            next,
        })
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global streams");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global streams");
    }
}
fn pair(
    id: &str,
    user: &str,
    revision: u64,
    generation: u64,
    session: &str,
) -> (Principal, Binding) {
    (
        Principal {
            id: id.into(),
            host: "h".into(),
            sender: Sender {
                channel: Channel::Telegram,
                account: "bot".into(),
                user: user.into(),
            },
            workspaces: BTreeSet::from(["w".into()]),
            sessions: BTreeSet::from([session.into()]),
            revision,
            revoked: false,
        },
        Binding {
            id: format!("b-{id}"),
            principal: id.into(),
            conversation: user.into(),
            workspace: "w".into(),
            session: session.into(),
            generation,
        },
    )
}
#[tokio::test]
async fn desktop_grant_cas_rolls_back_principal_on_invalid_binding_or_host_scope() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(d.path(), "h".into(), Arc::new(Host)).unwrap();
    let (p, b) = pair("p", "42", 1, 1, "s");
    g.configure_private_grant(p, b).await.unwrap();
    let (p, b) = pair("p", "42", 2, 9, "new");
    assert!(g.configure_private_grant(p, b).await.is_err());
    let page = g.grant_page(None).await.unwrap();
    assert_eq!(page.items[0].principal.revision, 1);
    assert_eq!(page.items[0].bindings[0].session, "s");
    let (p, b) = pair("bad", "43", 1, 1, "wrong");
    assert!(g.configure_private_grant(p, b).await.is_err());
    assert_eq!(g.grant_page(None).await.unwrap().items.len(), 1);
    let (p, b) = pair("second", "42", 1, 1, "s");
    assert!(matches!(
        g.configure_private_grant(p, b).await,
        Err(Error::IdentityConflict)
    ));
    g.revoke("p").await.unwrap();
    let (p, b) = pair("second", "42", 1, 1, "s");
    g.configure_private_grant(p, b).await.unwrap();
}
#[tokio::test]
async fn explicit_pagination_has_no_silent_scope_loss_and_survives_restart() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(d.path(), "h".into(), Arc::new(Host)).unwrap();
    for n in 0..27 {
        let (p, b) = pair(&format!("p-{n:02}"), &format!("user-{n}"), 1, 1, "s");
        g.configure_private_grant(p, b).await.unwrap();
    }
    let first = g.grant_page(None).await.unwrap();
    assert_eq!(first.items.len(), 25);
    assert_eq!(first.next.as_deref(), Some("p-24"));
    g.close().await.unwrap();
    let g = Gateway::open(d.path(), "h".into(), Arc::new(Host)).unwrap();
    let rest = g.grant_page(first.next).await.unwrap();
    assert_eq!(rest.items.len(), 2);
    assert!(rest.next.is_none());
}

#[tokio::test]
async fn complete_scope_policy_transaction_paginates_and_rolls_back_every_version() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(d.path(), "h".into(), Arc::new(Host)).unwrap();
    let (mut p, b) = pair("p", "42", 1, 1, "s");
    p.workspaces.insert("w2".into());
    p.sessions.extend((0..30).map(|i| format!("s-{i:02}")));
    p.sessions.insert("t".into());
    let policy = CreationPolicy {
        principal: p.id.clone(),
        principal_revision: 1,
        generation: 1,
        workspaces: BTreeSet::new(),
    };
    let first = g
        .configure_private_scopes(p.clone(), b.clone(), Some(policy.clone()))
        .await
        .unwrap();
    assert_eq!(first.principal.sessions.len(), 32);
    assert_eq!(first.creation_policy.as_ref(), Some(&policy)); // explicit default off
    let mut p2 = p.clone();
    p2.revision = 2;
    let mut b2 = b.clone();
    b2.generation = 2;
    let enabled = CreationPolicy {
        principal_revision: 2,
        generation: 2,
        workspaces: BTreeSet::from(["w2".into()]),
        ..policy.clone()
    };
    let mut wrong = enabled.clone();
    wrong.generation = 99;
    assert!(matches!(
        g.configure_private_scopes(p2.clone(), b2.clone(), Some(wrong))
            .await,
        Err(Error::IdentityConflict)
    ));
    let mut wrong = enabled.clone();
    wrong.workspaces.insert("foreign".into());
    assert!(matches!(
        g.configure_private_scopes(p2.clone(), b2.clone(), Some(wrong))
            .await,
        Err(Error::Unauthorized)
    ));
    let mut foreign = p2.clone();
    foreign.sessions.insert("foreign".into());
    assert!(g
        .configure_private_scopes(foreign, b2.clone(), Some(enabled.clone()))
        .await
        .is_err());
    let mut bad_binding = b2.clone();
    bad_binding.workspace = "w2".into(); // s belongs only to w
    assert!(g
        .configure_private_scopes(p2.clone(), bad_binding, Some(enabled.clone()))
        .await
        .is_err());
    assert_eq!(g.grant_page(None).await.unwrap().items, [first]);
    let second = g
        .configure_private_scopes(p2, b2, Some(enabled.clone()))
        .await
        .unwrap();
    assert_eq!(second.creation_policy.as_ref(), Some(&enabled));
    // Legacy single-session edit never silently carries active creation authority.
    let (p3, b3) = pair("p", "42", 3, 3, "s");
    g.configure_private_grant(p3, b3).await.unwrap();
    let stale = g.grant_page(None).await.unwrap().items.remove(0);
    assert_eq!(stale.principal.revision, 3);
    assert_eq!(stale.creation_policy.as_ref(), Some(&enabled));
    g.close().await.unwrap();
    let g = Gateway::open(d.path(), "h".into(), Arc::new(Host)).unwrap();
    assert_eq!(g.grant_page(None).await.unwrap().items, [stale]);
    let (p4, b4) = pair("p", "42", 4, 4, "s");
    let disabled = CreationPolicy {
        principal_revision: 4,
        generation: 3,
        workspaces: BTreeSet::new(),
        ..policy
    };
    let final_entry = g
        .configure_private_scopes(p4, b4, Some(disabled.clone()))
        .await
        .unwrap();
    assert_eq!(final_entry.creation_policy, Some(disabled));
    g.close().await.unwrap();
}
