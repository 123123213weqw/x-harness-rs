//! Shared setup only for fixtures with the exact h/p/b/42 identity.
//! Fault backends, effects, leases, policies and assertions stay in each test.
use xharness_remote::{Binding, Gateway, Principal, Sender, Subscription};

pub async fn install_scope(
    gateway: &Gateway,
    sender: Sender,
    workspaces: &[&str],
    sessions: &[&str],
    bound: (&str, &str),
) -> Subscription {
    assert_eq!(sender.user, "42");
    gateway
        .set_principal(Principal {
            id: "p".into(),
            host: "h".into(),
            sender: sender.clone(),
            workspaces: workspaces.iter().map(|id| (*id).into()).collect(),
            sessions: sessions.iter().map(|id| (*id).into()).collect(),
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
            workspace: bound.0.into(),
            session: bound.1.into(),
            generation: 1,
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
