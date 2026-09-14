//! Trusted review fixtures, no native/model calls and no automatic replay.
mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_remote::*;
struct Host;
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("review cannot run a native command")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("review cannot answer a native interaction")
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global events")
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events")
    }
}
async fn setup() -> (tempfile::TempDir, Arc<Gateway>) {
    let dir = tempfile::tempdir().unwrap();
    let g = Gateway::open(dir.path(), "h".into(), Arc::new(Host)).unwrap();
    support::install_scope(&g, sender(), &["w"], &["s"], ("w", "s")).await;
    (dir, g)
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "123".into(),
        user: "42".into(),
    }
}
async fn uncertain(dir: &std::path::Path, g: &Gateway, id: &str, command: Command) -> Delivery {
    let mut d = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: id.into(),
                binding: "b".into(),
                generation: 1,
                command,
            },
        )
        .await
        .unwrap();
    d.state = DeliveryState::Uncertain;
    d.reason = Some("PRIVATE_NATIVE_DIAGNOSTIC".into());
    // Durable fault cut before trusted recovery, never a production endpoint.
    let db = rusqlite::Connection::open(dir.join("remote.sqlite")).unwrap();
    db.execute(
        "UPDATE inbox SET state='uncertain',body=?1 WHERE key=?2",
        rusqlite::params![serde_json::to_string(&d).unwrap(), d.key],
    )
    .unwrap();
    d
}
fn review(identity: &InboxRecoveryIdentity, resolution: RecoveryResolution) -> RecoveryReview {
    RecoveryReview {
        delivery_key: identity.key.clone(),
        actor: "authenticated-desktop".into(),
        evidence_sha256: "a".repeat(64),
        resolution,
    }
}
#[tokio::test]
async fn metadata_page_is_exact_ordered_bounded_and_omits_every_private_command_field() {
    let (dir, g) = setup().await;
    let mut originals = vec![];
    for n in 0..26 {
        originals.push(
            uncertain(
                dir.path(),
                &g,
                &format!("read-{n}"),
                Command::Prompt {
                    mode: PromptMode::Queue,
                    content: vec![Content::Text {
                        text: "PRIVATE_INPUT_AND_MEDIA".into(),
                    }],
                    client_time_zone: None,
                },
            )
            .await,
        );
    }
    let page = g.uncertain_inbox(0).await.unwrap();
    assert_eq!(page.items.len(), 25);
    assert_eq!(page.next, Some(originals[24].sequence));
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("PRIVATE_"));
    assert!(!encoded.contains("content"));
    assert!(!encoded.contains("request_id"));
    for (e, d) in page.items.iter().zip(&originals) {
        assert_eq!(e.identity.key, d.key);
        assert_eq!(e.identity.principal_revision, 1);
        assert_eq!(e.identity.binding, d.binding);
        assert_eq!(e.command, InboxCommand::Prompt);
        assert!(e.observed_accepted_allowed);
        assert_eq!(e.interaction, None);
        assert_eq!(e.identity.identity_sha256.len(), 64);
    }
    let tail = g.uncertain_inbox(page.next.unwrap()).await.unwrap();
    assert_eq!(tail.items.len(), 1);
    assert_eq!(tail.items[0].identity.key, originals[25].key);
    assert_eq!(tail.next, None);
    assert_eq!(
        g.inspect(&originals[0].key).await.unwrap().unwrap(),
        originals[0]
    );
    g.close().await.unwrap();
}
#[tokio::test]
async fn stale_identity_scope_sequence_version_and_digest_cannot_commit_a_review() {
    let (dir, g) = setup().await;
    let d = uncertain(dir.path(), &g, "stale", Command::Cancel).await;
    let good = g.uncertain_inbox(0).await.unwrap().items.remove(0).identity;
    for n in 0..6 {
        let mut bad = good.clone();
        match n {
            0 => bad.sequence += 1,
            1 => bad.principal_revision += 1,
            2 => bad.binding.generation += 1,
            3 => bad.binding.session = "foreign".into(),
            4 => bad.identity_sha256 = "f".repeat(64),
            _ => bad.binding.conversation = "foreign".into(),
        };
        assert!(matches!(
            g.resolve_inbox(bad, review(&good, RecoveryResolution::AbandonWithoutReplay))
                .await,
            Err(Error::IdentityConflict)
        ));
    }
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
    assert_eq!(g.inspect(&d.key).await.unwrap().unwrap(), d);
    g.close().await.unwrap();
}
#[tokio::test]
async fn exact_review_is_idempotent_append_once_and_reopened_without_native_replay() {
    let (dir, g) = setup().await;
    let d = uncertain(dir.path(), &g, "idem", Command::Cancel).await;
    let expected = g.uncertain_inbox(0).await.unwrap().items.remove(0).identity;
    let r = review(&expected, RecoveryResolution::ObservedAccepted);
    let (a, b) = tokio::join!(
        g.resolve_inbox(expected.clone(), r.clone()),
        g.resolve_inbox(expected.clone(), r.clone())
    );
    let a = a.unwrap();
    assert_eq!(a, b.unwrap());
    assert_eq!(a.identity, expected);
    assert_eq!(a.audit.current, DeliveryState::Completed);
    assert_eq!(
        g.recovery_audit(&d.key).await.unwrap(),
        vec![a.audit.clone()]
    );
    assert!(g.uncertain_inbox(0).await.unwrap().items.is_empty());
    assert!(matches!(
        g.resolve_inbox(
            expected.clone(),
            review(&expected, RecoveryResolution::VerifiedNotApplied)
        )
        .await,
        Err(Error::IdentityConflict)
    ));
    g.close().await.unwrap();
    let g = Gateway::open(dir.path(), "h".into(), Arc::new(Host)).unwrap();
    assert_eq!(g.resolve_inbox(expected, r).await.unwrap(), a);
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    g.close().await.unwrap();
}
#[tokio::test]
async fn native_completion_between_preview_and_review_wins_without_a_second_audit() {
    let (dir, g) = setup().await;
    let mut d = uncertain(dir.path(), &g, "race", Command::Cancel).await;
    let expected = g.uncertain_inbox(0).await.unwrap().items.remove(0).identity;
    d.state = DeliveryState::Completed;
    d.result = Some(NativeCommandResult::success(json!({"accepted":true})));
    let db = rusqlite::Connection::open(dir.path().join("remote.sqlite")).unwrap();
    db.execute(
        "UPDATE inbox SET state='completed',body=?1 WHERE key=?2",
        rusqlite::params![serde_json::to_string(&d).unwrap(), d.key],
    )
    .unwrap();
    drop(db);
    assert!(matches!(
        g.resolve_inbox(
            expected.clone(),
            review(&expected, RecoveryResolution::AbandonWithoutReplay)
        )
        .await,
        Err(Error::Invalid(_))
    ));
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
    assert_eq!(g.inspect(&d.key).await.unwrap().unwrap(), d);
    g.close().await.unwrap();
}
#[tokio::test]
async fn native_mutations_require_original_receipts_even_through_exact_desktop_review() {
    for command in [
        Command::CreateSession {
            workspace: "w".into(),
        },
        Command::AutomationControl {
            control: AutomationControl::Pause { id: "saved".into() },
        },
    ] {
        let (dir, g) = setup().await;
        let d = uncertain(dir.path(), &g, "protected", command).await;
        let e = g.uncertain_inbox(0).await.unwrap().items.remove(0);
        assert!(!e.observed_accepted_allowed);
        assert!(matches!(
            g.resolve_inbox(
                e.identity.clone(),
                review(&e.identity, RecoveryResolution::ObservedAccepted)
            )
            .await,
            Err(Error::Invalid(_))
        ));
        assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
        g.resolve_inbox(
            e.identity.clone(),
            review(&e.identity, RecoveryResolution::AbandonWithoutReplay),
        )
        .await
        .unwrap();
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Abandoned
        );
        g.close().await.unwrap();
    }
}
#[tokio::test]
async fn cursors_evidence_and_closed_expected_shape_fail_before_review() {
    let (dir, g) = setup().await;
    let d = uncertain(dir.path(), &g, "closed", Command::Cancel).await;
    assert!(matches!(
        g.uncertain_inbox(-1).await,
        Err(Error::Invalid(_))
    ));
    let e = g.uncertain_inbox(0).await.unwrap().items.remove(0).identity;
    let mut r = review(&e, RecoveryResolution::VerifiedNotApplied);
    r.evidence_sha256 = "PRIVATE_NOT_EVIDENCE".into();
    assert!(matches!(
        g.resolve_inbox(e.clone(), r).await,
        Err(Error::Invalid(_))
    ));
    let mut raw = serde_json::to_value(e).unwrap();
    raw["binding"]["cwd"] = json!("PRIVATE_CWD");
    assert!(serde_json::from_value::<InboxRecoveryIdentity>(raw).is_err());
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
    g.close().await.unwrap();
}
