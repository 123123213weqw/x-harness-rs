//! Compatibility tombstone for the retired built-in Code Review workspace.
//! Deliberately owns no model work, credentials, session state or review storage.
#![forbid(unsafe_code)]
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

use xharness_api::RpcError;

pub(crate) fn retired() -> RpcError {
    RpcError::bad_request(
        "Built-in Code Review has been retired; use normal chat or GitHub PR review",
        serde_json::json!([]),
    )
}

#[cfg(test)]
mod tests {
    use crate::{
        BasicHost, DurableLoopAgentRuntime, GitHubBackend, HostConfig, ModelDescriptor,
        ModelRegistry, ModelRoute, NoTools, RegisteredModel,
    };
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio_util::sync::CancellationToken;
    use xharness_agent::MemoryLeaseManager;
    use xharness_api::{ApiBackend, RpcError, RpcId};
    use xharness_core::{
        IdentityContextPolicy, ModelProvider, ProviderError, ProviderRequest, ProviderStream,
    };
    use xharness_session::MemorySessionStore;

    #[derive(Default)]
    struct Provider(AtomicUsize);
    #[async_trait]
    impl ModelProvider for Provider {
        async fn count_input_tokens(
            &self,
            _: &ProviderRequest,
            _: CancellationToken,
        ) -> Result<Option<xharness_token::ProviderInputTokenCount>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        async fn stream(
            &self,
            _: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::new("unexpected retired feature inference"))
        }
    }
    struct Backend {
        reads: AtomicUsize,
        history_reads: AtomicUsize,
        writes: AtomicUsize,
        receipts: Vec<Value>,
    }
    #[async_trait]
    impl GitHubBackend for Backend {
        async fn read(
            &self,
            endpoint: &str,
            _: &Value,
            _: CancellationToken,
        ) -> Result<Value, RpcError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            assert_eq!(endpoint, "github/auth");
            Ok(json!({"account":"alice"}))
        }
        async fn save_review(&self, _: &Value, _: &Value) -> Result<(), RpcError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Err(RpcError::internal("retired storage must not be invoked"))
        }
        async fn review_history(&self, _: &Value) -> Result<Vec<Value>, RpcError> {
            self.history_reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.receipts.clone())
        }
    }
    fn host(installed: bool) -> (Arc<BasicHost>, Arc<Provider>, Arc<Backend>) {
        let provider = Arc::new(Provider::default());
        let backend = Arc::new(Backend {
            reads: AtomicUsize::new(0),
            history_reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            receipts: vec![json!({"id":"old-run","status":"failed","text":"retained"})],
        });
        let mut registry = ModelRegistry::new();
        registry
            .register(RegisteredModel::new(
                ModelDescriptor::new("test", "Test", "model", "Model"),
                provider.clone(),
            ))
            .unwrap();
        let runtime = Arc::new(
            DurableLoopAgentRuntime::from_registry(
                ModelRoute::new("test", "model"),
                registry,
                Arc::new(NoTools),
                Arc::new(IdentityContextPolicy),
                Arc::new(MemorySessionStore::default()),
                Arc::new(MemoryLeaseManager::default()),
                64,
            )
            .unwrap(),
        );
        let host = BasicHost::with_agent_runtime(HostConfig::new(std::env::temp_dir()), runtime);
        if installed {
            host.install_github(backend.clone()).unwrap();
        }
        (host, provider, backend)
    }

    #[tokio::test]
    async fn retired_review_routes_fail_before_credentials_model_or_storage() {
        for installed in [false, true] {
            let (h, p, b) = host(installed);
            let old = b.receipts.clone();
            for endpoint in [
                "github/review-models",
                "github/review-start",
                "github/review-status",
                "github/review-cancel",
                "github/review-history",
                "github/review-future",
            ] {
                for payload in [
                    Value::Null,
                    json!({"args":"malformed"}),
                    json!({"args":{"account":"alice","repository":"alice/project","number":7,"sha":"a".repeat(40),"provider":"test","model":"model","mode":"review","sessionId":"missing"}}),
                ] {
                    for cancelled in [false, true] {
                        let token = CancellationToken::new();
                        if cancelled {
                            token.cancel();
                        }
                        let result = h
                            .call_dynamic(RpcId::new("retired"), endpoint, payload.clone(), token)
                            .await
                            .unwrap();
                        let wire = serde_json::to_value(result).unwrap();
                        assert_eq!(wire["ok"], false);
                        assert_eq!(wire["error"]["code"], "bad-request");
                        assert!(wire["error"]["message"]
                            .as_str()
                            .unwrap()
                            .contains("Code Review has been retired"));
                    }
                }
            }
            // No background worker may be scheduled after the RPC returns either.
            tokio::task::yield_now().await;
            assert_eq!(p.0.load(Ordering::SeqCst), 0);
            assert_eq!(b.reads.load(Ordering::SeqCst), 0);
            assert_eq!(b.history_reads.load(Ordering::SeqCst), 0);
            assert_eq!(b.writes.load(Ordering::SeqCst), 0);
            assert_eq!(b.receipts, old);
            assert!(h.state.read().await.sessions.is_empty());
        }
    }

    #[tokio::test]
    async fn generic_github_read_seam_and_retired_chat_binding_are_unchanged() {
        let (h, p, b) = host(true);
        let result = h
            .call_dynamic(
                RpcId::new("read"),
                "github/auth",
                json!({"args":{}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire["ok"], true);
        assert_eq!(wire["value"]["account"], "alice");
        for endpoint in ["github/chat-get", "github/chat-set"] {
            let result = h
                .call_dynamic(
                    RpcId::new("old-chat"),
                    endpoint,
                    json!({"args":{"sessionId":"missing"}}),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(serde_json::to_value(result).unwrap()["ok"], false);
        }
        assert_eq!(b.reads.load(Ordering::SeqCst), 1);
        assert_eq!(b.writes.load(Ordering::SeqCst), 0);
        assert_eq!(b.history_reads.load(Ordering::SeqCst), 0);
        assert_eq!(p.0.load(Ordering::SeqCst), 0);
    }
}
