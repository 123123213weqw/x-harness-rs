//! A user prompt sent after a failed turn must still run its own turn and reach
//! the browser.
//!
//! Live report: "前面已经 fail，后面发了消息；有可能模型还在回答，但是前端不显示".
//! The Host is the only projection site (`run_turn` observes the durable turn and
//! `sync_authoritative_session` publishes the frames), so a prompt whose driving
//! run never publishes frames stays invisible even while the runtime keeps
//! answering it. These assert both halves separately: the durable session proves
//! the model answered, the mux proves the browser was told.
//!
//! They cover the two orderings a user can produce: a prompt sent after the
//! failure already landed, and a prompt queued while the failing turn is still
//! inside the provider.

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::stream;
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{MemorySessionStore, Store};

use crate::{
    runtime::{AgentRuntime, DurableLoopAgentRuntime},
    BasicHost, HostConfig, NoTools,
};

/// Fails the first provider request, then answers every later one.
struct FailFirstTurn {
    attempts: AtomicUsize,
}

#[async_trait]
impl ModelProvider for FailFirstTurn {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            // Non-retryable: the first turn must reach `TurnEndReason::Failed`.
            return Ok(Box::pin(stream::iter([Err(ProviderError::new(
                "synthetic provider failure",
            ))])));
        }
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("answered".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            }),
        ])))
    }
}

#[tokio::test]
async fn a_prompt_after_a_failed_turn_is_still_projected_to_the_browser() {
    use serde_json::json;
    use xharness_api::RpcId;

    const ID: &str = "fail-then-prompt";
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(FailFirstTurn {
            attempts: AtomicUsize::new(0),
        })),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(std::env::temp_dir());
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    let mut frames = host.event_gateway.subscribe_mux();
    host.session_create(&json!({"sessionId": ID}))
        .await
        .unwrap();

    let admission = |id: &str| crate::driver::PromptAdmission {
        rpc_id: RpcId::new(id),
        session_id: ID.into(),
        mode: "queue".into(),
        text: id.into(),
        content: vec![json!({"type":"text","text":id})],
        source: json!({"kind":"user"}),
        fingerprint: None,
    };
    let turn_ends = |session: &xharness_session::Session| {
        session
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                xharness_session::EventData::TurnEnd { turn, reason } => {
                    Some((*turn, format!("{reason:?}")))
                }
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let settle = |expected: usize| {
        let store = Arc::clone(&store);
        async move {
            tokio::time::timeout(Duration::from_secs(10), async move {
                loop {
                    let session = store.load(ID).await.unwrap().unwrap();
                    let ends = session
                        .events()
                        .iter()
                        .filter(|event| {
                            matches!(event.data(), xharness_session::EventData::TurnEnd { .. })
                        })
                        .count();
                    if ends >= expected {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
        }
    };

    host.enqueue_prompt(admission("first")).await.unwrap();
    settle(1).await.expect("the first turn must settle");
    let session = store.load(ID).await.unwrap().unwrap();
    let first = turn_ends(&session);
    assert!(
        first
            .first()
            .is_some_and(|(_, reason)| reason.contains("Failed")),
        "the first turn must fail: {first:?}"
    );

    host.enqueue_prompt(admission("second")).await.unwrap();
    settle(2)
        .await
        .expect("a prompt sent after a failed turn must still run its own turn");
    let session = store.load(ID).await.unwrap().unwrap();
    let ends = turn_ends(&session);
    assert_eq!(ends.len(), 2, "{ends:?}");

    // Durable turn 2 is Web turn 1 (`web_turn` is one-based to zero-based).
    let mut assistant_turns = Vec::new();
    let mut end_turns = Vec::new();
    let observed = tokio::time::timeout(Duration::from_secs(10), async {
        while assistant_turns.is_empty() {
            match frames.try_recv() {
                Ok(frame) if frame.payload["type"] == "session/event" => {
                    let event = &frame.payload["event"];
                    match event["type"].as_str() {
                        Some("assistant/message") => {
                            assistant_turns.push(event["data"]["turn"].as_u64())
                        }
                        Some("turn/end") => end_turns.push((
                            event["data"]["turn"].as_u64(),
                            event["data"]["reason"]["kind"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        )),
                        _ => {}
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    tokio::task::yield_now().await
                }
                Err(error) => panic!("mux subscription ended: {error:?}"),
            }
        }
    })
    .await;
    observed.expect("the browser must be told about the turn that ran after the failure");
    assert!(
        assistant_turns.contains(&Some(1)),
        "the answer to the prompt sent after the failure never reached the browser: \
         assistant web turns {assistant_turns:?}, turn endings {end_turns:?}"
    );
    assert!(
        end_turns.contains(&(Some(0), "error".to_owned())),
        "the failed turn must still be displayed as failed: {end_turns:?}"
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}

/// Blocks the first provider request until it is released, then fails it.
struct FailFirstTurnWhenReleased {
    attempts: AtomicUsize,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl ModelProvider for FailFirstTurnWhenReleased {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            let release = Arc::clone(&self.release);
            return Ok(Box::pin(async_stream::stream! {
                release.notified().await;
                yield Err(ProviderError::new("synthetic provider failure"));
            }));
        }
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("answered".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            }),
        ])))
    }
}

/// Reproduction: the next prompt usually arrives *while* the previous turn is
/// still failing. Its observer is then subscribed before that turn's terminal
/// broadcasts, so it must not mistake them for its own outcome.
#[tokio::test]
async fn a_prompt_queued_during_a_failing_turn_is_still_projected_to_the_browser() {
    use serde_json::json;
    use xharness_api::RpcId;

    const ID: &str = "fail-while-queued";
    let release = Arc::new(tokio::sync::Notify::new());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(FailFirstTurnWhenReleased {
            attempts: AtomicUsize::new(0),
            release: Arc::clone(&release),
        })),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(std::env::temp_dir());
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    let mut frames = host.event_gateway.subscribe_mux();
    host.session_create(&json!({"sessionId": ID}))
        .await
        .unwrap();

    let admission = |id: &str| crate::driver::PromptAdmission {
        rpc_id: RpcId::new(id),
        session_id: ID.into(),
        mode: "queue".into(),
        text: id.into(),
        content: vec![json!({"type":"text","text":id})],
        source: json!({"kind":"user"}),
        fingerprint: None,
    };
    let turn_count = |session: &xharness_session::Session| {
        session
            .events()
            .iter()
            .filter(|event| matches!(event.data(), xharness_session::EventData::TurnStart { .. }))
            .count()
    };
    let settle = |expected: usize| {
        let store = Arc::clone(&store);
        async move {
            tokio::time::timeout(Duration::from_secs(10), async move {
                loop {
                    let session = store.load(ID).await.unwrap().unwrap();
                    let ends = session
                        .events()
                        .iter()
                        .filter(|event| {
                            matches!(event.data(), xharness_session::EventData::TurnEnd { .. })
                        })
                        .count();
                    if ends >= expected {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
        }
    };

    host.enqueue_prompt(admission("first")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let session = store.load(ID).await.unwrap().unwrap();
            if turn_count(&session) == 1 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the first turn must start before the second prompt is queued");

    // Queued while turn 1 is still inside the provider, exactly like a user who
    // types again before the failure lands.
    host.enqueue_prompt(admission("second")).await.unwrap();
    release.notify_one();
    settle(2)
        .await
        .expect("the prompt queued during the failure must still run its own turn");

    let mut assistant_turns = Vec::new();
    let mut end_turns = Vec::new();
    let observed = tokio::time::timeout(Duration::from_secs(10), async {
        while !assistant_turns.contains(&Some(1)) {
            match frames.try_recv() {
                Ok(frame) if frame.payload["type"] == "session/event" => {
                    let event = &frame.payload["event"];
                    match event["type"].as_str() {
                        Some("assistant/message") => {
                            assistant_turns.push(event["data"]["turn"].as_u64())
                        }
                        Some("turn/end") => end_turns.push((
                            event["data"]["turn"].as_u64(),
                            event["data"]["reason"]["kind"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        )),
                        _ => {}
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    tokio::task::yield_now().await
                }
                Err(error) => panic!("mux subscription ended: {error:?}"),
            }
        }
    })
    .await;
    observed
        .expect("the browser must be told about a prompt queued while the previous turn failed");
    assert!(
        end_turns.contains(&(Some(0), "error".to_owned())),
        "the failed turn must still be displayed as failed: {end_turns:?}"
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}
