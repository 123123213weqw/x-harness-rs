//! Trusted settings CAS and native-connection revision fence fixtures.
use std::{collections::BTreeMap, sync::Arc};
use xharness_remote::*;
fn settings(id: &str, revision: u64, enabled: bool) -> AccountSettings {
    AccountSettings {
        account: Account {
            channel: Channel::Telegram,
            id: id.into(),
        },
        revision,
        enabled,
        credentials: BTreeMap::from([("bot_token".into(), format!("REMOTE_TOKEN_{revision}"))]),
    }
}
#[tokio::test]
async fn settings_cas_preserves_cursor_and_fences_slow_old_connector() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    let s = settings("123456", 1, true);
    let legacy = g.acquire_account(s.account.clone()).await.unwrap();
    g.receive(
        legacy.clone(),
        "1".into(),
        "a".repeat(64),
        "2".into(),
        ReceiveInput::Reject {
            code: RejectionCode::Unsupported,
        },
    )
    .await
    .unwrap();
    g.set_account_settings(s.clone()).await.unwrap();
    assert!(g.account_checkpoint(&legacy).await.is_err());
    assert!(g.acquire_account(s.account.clone()).await.is_err());
    let current = g
        .acquire_configured_account(s.account.clone(), 1)
        .await
        .unwrap();
    assert_eq!(current.cursor, "2");
    g.set_account_settings(s.clone()).await.unwrap();
    assert_eq!(g.account_checkpoint(&current).await.unwrap(), current);
    let disabled = settings("123456", 2, false);
    g.set_account_settings(disabled.clone()).await.unwrap();
    assert!(g
        .acquire_configured_account(s.account.clone(), 1)
        .await
        .is_err());
    assert!(g
        .acquire_configured_account(s.account.clone(), 2)
        .await
        .is_err());
    assert!(g.account_checkpoint(&current).await.is_err());
    assert!(g.set_account_settings(s).await.is_err());
    assert_eq!(g.account_settings().await.unwrap(), vec![disabled]);
}
#[tokio::test]
async fn malformed_secret_fields_and_reference_capacity_fail_without_partial_change() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    let mut bad = settings("bot", 1, true);
    bad.credentials
        .insert("bot_token".into(), "123456:THIS_IS_A_SECRET".into());
    assert!(g.set_account_settings(bad).await.is_err());
    for n in 0..MAX_ACCOUNTS {
        g.set_account_settings(settings(&n.to_string(), 1, false))
            .await
            .unwrap();
    }
    assert!(matches!(
        g.set_account_settings(settings("overflow", 1, true)).await,
        Err(Error::Capacity)
    ));
    assert_eq!(g.account_settings().await.unwrap().len(), MAX_ACCOUNTS);
    assert!(serde_json::from_str::<AccountSettings>(r#"{"account":{"channel":"telegram","id":"1"},"enabled":true,"revision":1,"credentials":{},"token":"SECRET"}"#).is_err());
}
#[tokio::test]
async fn cleanup_queue_never_deletes_a_shared_active_reference() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    g.set_account_settings(settings("first", 1, false))
        .await
        .unwrap();
    g.set_account_settings(settings("second", 1, false))
        .await
        .unwrap();
    g.set_account_settings(settings("first", 2, false))
        .await
        .unwrap();
    assert!(g.pending_credential_cleanup().await.unwrap().is_empty());
    assert!(matches!(
        g.finish_credential_cleanup("REMOTE_TOKEN_1").await,
        Err(Error::IdentityConflict)
    ));
    g.set_account_settings(settings("second", 2, false))
        .await
        .unwrap();
    assert_eq!(
        g.pending_credential_cleanup().await.unwrap(),
        vec!["REMOTE_TOKEN_1"]
    );
    g.finish_credential_cleanup("REMOTE_TOKEN_1").await.unwrap();
    assert!(g.pending_credential_cleanup().await.unwrap().is_empty());
}

#[tokio::test]
async fn native_deletion_claim_prevents_reference_reactivation_and_is_durable() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    g.stage_credential_reference("REMOTE_STAGED").await.unwrap();
    g.claim_credential_cleanup("REMOTE_STAGED").await.unwrap();
    let mut s = settings("bot", 1, false);
    s.credentials
        .insert("bot_token".into(), "REMOTE_STAGED".into());
    assert!(matches!(
        g.set_account_settings(s.clone()).await,
        Err(Error::IdentityConflict)
    ));
    g.finish_credential_cleanup("REMOTE_STAGED").await.unwrap();
    g.close().await.unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    assert!(matches!(
        g.set_account_settings(s).await,
        Err(Error::IdentityConflict)
    ));
    assert!(matches!(
        g.stage_credential_reference("REMOTE_STAGED").await,
        Err(Error::IdentityConflict)
    ));
}
