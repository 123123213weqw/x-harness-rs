use crate::{runtime::ModelRoute, BasicHost};
use xharness_api::{
    ApiBackend, MuxFrame, RpcError, RpcId, ScopedEventPage, MAX_SCOPED_EVENTS,
    MAX_SCOPED_EVENT_BYTES,
};
pub(super) async fn page(
    host: &BasicHost,
    workspace: &str,
    id: &str,
    after: Option<u64>,
) -> Result<ScopedEventPage, RpcError> {
    if !host.agent_runtime.has_authoritative_sessions() {
        return Err(RpcError::internal(
            "durable events require authoritative sessions",
        ));
    }
    if !host.session_in_workspace(workspace, id).await? {
        return Err(RpcError::internal("session scope unavailable"));
    }
    let (known, route) = {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::internal("session unavailable"))?;
        (
            session.next_event_seq(),
            ModelRoute {
                provider: session.model.provider.clone(),
                model: session.model.model.clone(),
                reasoning_effort: session.model.reasoning_effort.clone(),
                context_window_tokens: session.model.context_window_tokens,
            },
        )
    };
    let durable = host
        .agent_runtime
        .authoritative_session(id)
        .await
        .map_err(|_| RpcError::internal("durable events unavailable"))?
        .ok_or_else(|| RpcError::internal("durable session unavailable"))?;
    if durable.next_seq() < known || durable.header().id != id {
        return Err(RpcError::internal(
            "durable event identity or cursor regressed",
        ));
    }
    let head = durable.next_seq();
    let start = after.unwrap_or(head);
    if start > head {
        return Err(RpcError::internal(
            "event cursor ahead of authoritative journal",
        ));
    }
    if start == head {
        return Ok(ScopedEventPage {
            start_seq: start,
            next_seq: start,
            head_seq: head,
            events: vec![],
        });
    }
    let start_index =
        usize::try_from(start).map_err(|_| RpcError::internal("event cursor range"))?;
    let end = start_index
        .saturating_add(MAX_SCOPED_EVENTS)
        .min(durable.events().len());
    let projected =
        xharness_projection::project_session_event_range(&durable, &route, start_index, end);
    let mut events = Vec::new();
    let mut bytes = 0usize;
    for (index, event) in projected.into_iter().enumerate() {
        let seq = start + index as u64;
        let frame = MuxFrame::SessionEvent {
            session_id: id.into(),
            event,
            view: None,
        }
        .into_server_request(RpcId::new(format!("remote-event-{seq}")));
        let size = serde_json::to_vec(&frame)
            .map_err(|_| RpcError::internal("event encoding"))?
            .len();
        if bytes.saturating_add(size) > MAX_SCOPED_EVENT_BYTES - 1024 {
            if events.is_empty() {
                return Err(RpcError::internal("event exceeds scoped page budget"));
            }
            break;
        }
        bytes += size;
        events.push(frame);
    }
    let page = ScopedEventPage {
        start_seq: start,
        next_seq: start + events.len() as u64,
        head_seq: durable.next_seq(),
        events,
    };
    if !page.is_scoped(id, after) {
        return Err(RpcError::internal("invalid durable event page"));
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentRuntime, DurableLoopAgentRuntime, HostConfig, NoTools};
    use serde_json::json;
    use std::{sync::Arc, time::Duration};
    use tokio_util::sync::CancellationToken;
    use xharness_agent::MemoryLeaseManager;
    use xharness_api::{RpcMethod, RpcResult};
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream,
    };
    use xharness_session::{EventData, MemorySessionStore, SessionTitleSource, Store};
    struct Provider;
    #[async_trait::async_trait]
    impl ModelProvider for Provider {
        fn provider_name(&self) -> &str {
            "fixture"
        }
        fn model_name(&self) -> Option<&str> {
            Some("fixture")
        }
        async fn stream(
            &self,
            _: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            Ok(Box::pin(futures::stream::iter([
                Ok(ProviderEvent::TextDelta("actual native text 🧪".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ])))
        }
    }
    #[tokio::test]
    async fn scoped_durable_events_preserve_native_deltas_history_sequence_and_page_boundaries() {
        let root =
            std::env::temp_dir().join(format!("xh-native-forward-events-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(MemorySessionStore::default());
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "fixture",
            "fixture",
            Some(Arc::new(Provider)),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let mut config = HostConfig::new(&root);
        config.provider_id = "fixture".into();
        config.model_id = "fixture".into();
        config.auto_titles = false;
        let host = BasicHost::with_agent_runtime(config, runtime.clone());
        let created = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"workspaceId":"workspace-default","sessionId":"s"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }), "{created:?}");
        let probe = host
            .session_event_page("workspace-default", "s", None)
            .await
            .unwrap();
        assert!(probe.events.is_empty());
        let prompt=host.call(RpcId::new("prompt"),RpcMethod::SessionPrompt,json!({"sessionId":"s","mode":"queue","content":[{"type":"text","text":"fixture output"}]}),CancellationToken::new()).await;
        assert!(matches!(prompt, RpcResult::Success { .. }), "{prompt:?}");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let page = host
                    .session_event_page("workspace-default", "s", Some(0))
                    .await
                    .unwrap();
                if page
                    .events
                    .iter()
                    .any(|f| f.payload["event"]["type"] == "turn/end")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let page = host
            .session_event_page("workspace-default", "s", Some(0))
            .await
            .unwrap();
        assert!(page
            .events
            .iter()
            .any(|f| f.payload["event"]["type"] == "assistant/chunk"));
        let final_frame = page
            .events
            .iter()
            .find(|f| f.payload["event"]["type"] == "assistant/message")
            .unwrap();
        assert_eq!(
            final_frame.payload["event"]["data"]["message"]["content"][0]["text"],
            "actual native text 🧪"
        );
        let history = host
            .call(
                RpcId::new("history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":"s"}),
                CancellationToken::new(),
            )
            .await;
        if let RpcResult::Success { value: Some(value) } = history {
            assert!(value["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["event"] == final_frame.payload["event"]));
        } else {
            panic!("history unavailable");
        }
        let cut = store.load("s").await.unwrap().unwrap();
        store
            .append(
                "s",
                cut.revision(),
                (0..300)
                    .map(|i| {
                        EventData::SessionTitle {
                            title: format!("title-{i}"),
                            message_seqs: vec![],
                            source: SessionTitleSource::User,
                        }
                        .into()
                    })
                    .collect(),
            )
            .await
            .unwrap();
        host.sync_authoritative_session("s").await.unwrap();
        let first = host
            .session_event_page("workspace-default", "s", Some(0))
            .await
            .unwrap();
        assert_eq!(first.events.len(), 128);
        assert!(first.has_more());
        let second = host
            .session_event_page("workspace-default", "s", Some(first.next_seq))
            .await
            .unwrap();
        assert_eq!(second.events.len(), 128);
        assert!(second.is_scoped("s", Some(first.next_seq)));
        assert!(host
            .session_event_page("unregistered", "s", Some(0))
            .await
            .is_err());
        assert!(host
            .session_event_page("workspace-default", "s", Some(u64::MAX))
            .await
            .is_err());
        let ephemeral = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        assert!(ephemeral
            .session_event_page("workspace-default", "s", None)
            .await
            .is_err());
        runtime.shutdown(Duration::from_secs(1)).await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
