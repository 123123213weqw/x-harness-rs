//! Repair old automatic 32K snapshots using receipts, not numeric guesses.
//! Explicit or ambiguous human preferences remain untouched.
use serde_json::json;
use xharness_session::{EventData, Session, SessionEvent};
const LEGACY_BUDGET: u64 = 32_768;

fn latest_selection(session: &Session, before_ms: u64) -> Option<usize> {
    session.events().iter().rposition(|e| {
        e.timestamp_ms <= before_ms && matches!(e.data(), EventData::SessionModelSelected { .. })
    })
}
pub(crate) fn needs_legacy_check(session: &Session) -> bool {
    latest_selection(session, u64::MAX).is_some_and(|n| {
        matches!(
            session.events()[n].data(),
            EventData::SessionModelSelected {
                context_window_tokens: Some(LEGACY_BUDGET),
                ..
            }
        )
    })
}
fn automatic(session: &Session, mut index: usize) -> bool {
    // Iterative backward traversal: long histories cannot overflow the stack.
    loop {
        let event = &session.events()[index];
        let EventData::SessionModelSelected {
            provider,
            model,
            reasoning_effort,
            context_window_tokens,
        } = event.data()
        else {
            return false;
        };
        if context_window_tokens.is_none() {
            return true;
        }
        let receipt = session.events()[index + 1..]
            .iter()
            .take_while(|next| next.revision == event.revision)
            .find_map(|next| match next.data() {
                EventData::SessionMutationCommitted { receipt }
                    if receipt.method == "session.selectModel" =>
                {
                    Some(receipt)
                }
                _ => None,
            });
        let Some(receipt) = receipt else {
            return false;
        };
        let mut variants =
            vec![json!({"sessionId":session.header().id,"provider":provider,"model":model})];
        variants.push(json!({"sessionId":session.header().id,"provider":provider,"model":model,"reasoningEffort":null}));
        if let Some(effort) = reasoning_effort {
            variants.push(json!({"sessionId":session.header().id,"provider":provider,"model":model,"reasoningEffort":effort}));
        }
        if !variants.iter().any(|p| {
            xharness_control::mutation_fingerprint("session.selectModel", p) == receipt.fingerprint
        }) {
            return false;
        }
        // Same-route effort edits preserve an earlier explicit capacity choice.
        if let Some(prior) = session.events()[..index]
            .iter()
            .rposition(|e| matches!(e.data(), EventData::SessionModelSelected { .. }))
        {
            if let EventData::SessionModelSelected {
                provider: p,
                model: m,
                context_window_tokens: c,
                ..
            } = session.events()[prior].data()
            {
                if p == provider && m == model && c == context_window_tokens {
                    index = prior;
                    continue;
                }
            }
        }
        return true;
    }
}
pub(crate) fn legacy_repair(session: &Session, parent: Option<&Session>) -> Option<SessionEvent> {
    let index = latest_selection(session, u64::MAX)?;
    let EventData::SessionModelSelected {
        provider,
        model,
        reasoning_effort,
        context_window_tokens: Some(LEGACY_BUDGET),
    } = session.events()[index].data()
    else {
        return None;
    };
    let delegated = session
        .events()
        .iter()
        .enumerate()
        .find_map(|(n, e)| match e.data() {
            EventData::AgentDelegated {
                parent_session_id, ..
            } => Some((n, e.timestamp_ms, parent_session_id)),
            _ => None,
        });
    let proven = if let Some((delegation_index, created_at, parent_id)) = delegated {
        // No later child override, no substitution of the parent's current route.
        if index >= delegation_index {
            return None;
        }
        let parent = parent.filter(|p| &p.header().id == parent_id)?;
        // Millisecond ties cannot prove which selection preceded creation.
        if parent.events().iter().any(|e| {
            e.timestamp_ms == created_at
                && matches!(e.data(), EventData::SessionModelSelected { .. })
        }) {
            return None;
        }
        let n = latest_selection(parent, created_at)?;
        match parent.events()[n].data() {
            EventData::SessionModelSelected {
                provider: p,
                model: m,
                reasoning_effort: r,
                context_window_tokens: c,
            } => {
                p == provider
                    && m == model
                    && r == reasoning_effort
                    && *c == Some(LEGACY_BUDGET)
                    && automatic(parent, n)
            }
            _ => false,
        }
    } else {
        automatic(session, index)
    };
    proven.then(|| {
        EventData::SessionModelSelected {
            provider: provider.clone(),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            context_window_tokens: None,
        }
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{SessionHeader, SessionMutationReceipt};
    fn selected(provider: &str) -> SessionEvent {
        EventData::SessionModelSelected {
            provider: provider.into(),
            model: "m".into(),
            reasoning_effort: None,
            context_window_tokens: Some(LEGACY_BUDGET),
        }
        .into()
    }
    fn change(session: &mut Session, provider: &str, explicit: bool, at: u64) {
        let mut payload = json!({"sessionId":session.header().id,"provider":provider,"model":"m"});
        if explicit {
            payload["contextWindowTokens"] = json!(LEGACY_BUDGET);
        }
        let receipt = SessionMutationReceipt {
            rpc_id: format!("select-{}", session.next_seq()),
            method: "session.selectModel".into(),
            fingerprint: xharness_control::mutation_fingerprint("session.selectModel", &payload),
            response: json!({}),
            response_event_seq_field: None,
        };
        session
            .append_batch_at(
                session.revision(),
                vec![
                    selected(provider),
                    EventData::SessionMutationCommitted { receipt }.into(),
                ],
                at,
            )
            .unwrap();
    }
    #[test]
    fn receipt_proves_default_but_preserves_explicit_and_ambiguous_choices() {
        let mut auto = Session::new(SessionHeader::new("auto")).unwrap();
        change(&mut auto, "p", false, 1);
        let repair = legacy_repair(&auto, None).unwrap();
        auto.append(auto.revision(), repair).unwrap();
        assert!(legacy_repair(&auto, None).is_none());
        let mut user = Session::new(SessionHeader::new("user")).unwrap();
        change(&mut user, "p", true, 1);
        change(&mut user, "p", false, 2);
        assert!(legacy_repair(&user, None).is_none());
        let mut ambiguous = Session::new(SessionHeader::new("ambiguous")).unwrap();
        ambiguous
            .append(ambiguous.revision(), selected("p"))
            .unwrap();
        assert!(legacy_repair(&ambiguous, None).is_none());
    }
    #[test]
    fn child_uses_historical_parent_proof_not_current_route_or_equal_numbers() {
        for explicit in [false, true] {
            let mut parent = Session::new(SessionHeader::new("parent")).unwrap();
            change(&mut parent, "p", explicit, 1);
            let mut child = Session::new(SessionHeader::new("child")).unwrap();
            child
                .append_batch_at(
                    child.revision(),
                    vec![
                        selected("p"),
                        EventData::AgentDelegated {
                            parent_session_id: "parent".into(),
                            invocation_id: "i".into(),
                            task: "review".into(),
                        }
                        .into(),
                    ],
                    2,
                )
                .unwrap();
            change(&mut parent, "different-route", true, 3);
            assert_eq!(legacy_repair(&child, Some(&parent)).is_some(), !explicit);
            assert!(legacy_repair(&child, None).is_none());
            change(&mut child, "p", true, 4);
            assert!(legacy_repair(&child, Some(&parent)).is_none());
        }
    }

    #[tokio::test]
    async fn full_host_restore_repairs_existing_child_append_only_and_idempotently() {
        use std::sync::Arc;
        use xharness_session::{MemorySessionStore, Revision, Store};
        for explicit in [false, true] {
            let store = Arc::new(MemorySessionStore::default());
            let mut parent = Session::new(SessionHeader::new("parent")).unwrap();
            change(&mut parent, "p", explicit, 1);
            store.create(parent.header().clone()).await.unwrap();
            store
                .append(
                    "parent",
                    Revision::ZERO,
                    parent.events().iter().map(|e| e.event.clone()).collect(),
                )
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(3)).await;
            store.create(SessionHeader::new("child")).await.unwrap();
            store
                .append(
                    "child",
                    Revision::ZERO,
                    vec![
                        selected("p"),
                        EventData::AgentDelegated {
                            parent_session_id: "parent".into(),
                            invocation_id: "i".into(),
                            task: "preserve this task".into(),
                        }
                        .into(),
                    ],
                )
                .await
                .unwrap();
            let before = store.load("child").await.unwrap().unwrap();
            let config = crate::HostConfig::new(std::env::temp_dir());
            let host = crate::BasicHost::without_provider(config.clone());
            let durable: Arc<dyn Store> = store.clone();
            host.restore_from_store(durable).await.unwrap();
            let after = store.load("child").await.unwrap().unwrap();
            assert_eq!(&after.events()[..before.events().len()], before.events());
            assert_eq!(
                after.events().len(),
                before.events().len() + usize::from(!explicit)
            );
            assert_eq!(
                crate::restore::restored_route(&after, &config).context_window_tokens,
                if explicit { Some(LEGACY_BUDGET) } else { None }
            );
            let restarted = crate::BasicHost::without_provider(config);
            let durable: Arc<dyn Store> = store.clone();
            restarted.restore_from_store(durable).await.unwrap();
            assert_eq!(
                store.load("child").await.unwrap().unwrap().revision(),
                after.revision()
            );
        }
    }

    #[test]
    #[ignore = "metadata-only real journal acceptance; no transcript or tool bodies"]
    fn actual_legacy_metadata_proves_inherited_automatic_budget() {
        let path = std::env::var("XHARNESS_CONTEXT_MIGRATION_FIXTURE").unwrap();
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let restore = |value: &serde_json::Value| {
            Session::restore(
                serde_json::from_value(value["header"].clone()).unwrap(),
                xharness_session::Revision(value["revision"].as_u64().unwrap()),
                serde_json::from_value(value["events"].clone()).unwrap(),
            )
            .unwrap()
        };
        let parent = restore(&fixture["parent"]);
        for value in fixture["children"].as_array().unwrap() {
            let mut child = restore(value);
            let before = child.events().to_vec();
            let repair = legacy_repair(&child, Some(&parent))
                .expect("real receipt must prove automatic inheritance");
            child.append(child.revision(), repair).unwrap();
            assert_eq!(&child.events()[..before.len()], &before);
            assert!(legacy_repair(&child, Some(&parent)).is_none());
        }
    }
}
