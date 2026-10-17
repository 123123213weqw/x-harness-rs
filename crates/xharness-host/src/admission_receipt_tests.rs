//! Durable receipt lookup after eviction, restart and legacy checkpoint migration.
#![forbid(unsafe_code)]
use super::*;
use xharness_session::{InboxMessage, InboxTarget};

#[tokio::test]
async fn evicted_and_oversized_receipts_preserve_exact_retry_conflict_and_fork_binding() {
    let (host, store) = fixture().await;
    let mut inserted = (0..400)
        .map(|n| {
            let mut input =
                InboxMessage::user(format!("receipt-{n:04}"), "private-body".repeat(1024));
            input.source =
                Some(json!({"rpcSessionId":ID,"rpcFingerprint":format!("fingerprint-{n}")}));
            input
        })
        .collect::<Vec<_>>();
    let oversized = "large-id".repeat(10000);
    let mut input = InboxMessage::user(&oversized, "oversized body");
    input.source = Some(json!({"rpcSessionId":ID,"rpcFingerprint":"oversized-fingerprint"}));
    inserted.push(input);
    let mut foreign = InboxMessage::user("foreign-receipt", "parent body");
    foreign.source =
        Some(json!({"rpcSessionId":"another-parent","rpcFingerprint":"foreign-fingerprint"}));
    inserted.push(foreign);
    let count = inserted.len();
    let journal = store.load(ID).await.unwrap().unwrap();
    store
        .append(
            ID,
            journal.revision(),
            vec![
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start: 0,
                    removed_count: 0,
                    inserted,
                    outcome: None,
                }
                .into(),
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start: 0,
                    removed_count: count,
                    inserted: vec![],
                    outcome: None,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    for _ in 0..2 {
        let restarted = BasicHost::with_agent_runtime(
            HostConfig::new(std::env::temp_dir()),
            Arc::new(SnapshotRuntime(store.clone())),
        );
        restarted.restore_from_store(store.clone()).await.unwrap();
        {
            let state = restarted.state.read().await;
            let cache = &state.sessions[ID].admissions;
            assert!(cache.get("receipt-0000").is_none());
            assert!(cache.get(&oversized).is_none());
            let encoded = serde_json::to_string(cache).unwrap();
            assert!(encoded.len() < 64 * 1024);
            assert!(!encoded.contains("private-body"));
        }
        for (id, fingerprint) in [
            ("receipt-0000", "fingerprint-0"),
            (oversized.as_str(), "oversized-fingerprint"),
        ] {
            assert!(
                crate::rpc::turn::duplicate_admission(&restarted, ID, id, fingerprint)
                    .await
                    .unwrap()
            );
            assert!(
                crate::rpc::turn::duplicate_admission(&restarted, ID, id, "different")
                    .await
                    .is_err()
            );
        }
        assert!(!crate::rpc::turn::duplicate_admission(
            &restarted,
            ID,
            "foreign-receipt",
            "foreign-fingerprint"
        )
        .await
        .unwrap());
        assert!(!crate::rpc::turn::duplicate_admission(
            &restarted,
            ID,
            "new-receipt",
            "new-fingerprint"
        )
        .await
        .unwrap());
    }
    let journal = store.load(ID).await.unwrap().unwrap();
    assert!(serde_json::to_string(journal.events())
        .unwrap()
        .contains("private-body"));
    drop(host);
}

#[tokio::test]
async fn missing_journal_and_unknown_cached_fingerprint_never_replay() {
    let (host, store) = fixture().await;
    host.state
        .write()
        .await
        .sessions
        .get_mut(ID)
        .unwrap()
        .admissions
        .insert(
            "legacy-unknown".into(),
            crate::admission_cache::AdmissionReceipt { fingerprint: None },
        );
    assert!(
        crate::rpc::turn::duplicate_admission(&host, ID, "legacy-unknown", "new")
            .await
            .is_err()
    );
    store.delete_session_data(ID).await.unwrap();
    assert!(
        crate::rpc::turn::duplicate_admission(&host, ID, "evicted-or-new", "new")
            .await
            .is_err()
    );
}
