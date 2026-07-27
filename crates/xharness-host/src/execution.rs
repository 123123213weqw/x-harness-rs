//! Optional deployment execution boundary, independent of cloud/SQL/transport.
//! Local embeddings leave it unset and retain the existing behavior.
use async_trait::async_trait;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    ModelCapabilities, ModelProvider, ProviderError, ProviderInputTokenCount, ProviderRequest,
    ProviderStream,
};
use xharness_tools::{
    AroundMiddleware, AroundNext, HandlerFuture, ToolExecutionContext, ToolExecutor,
    ToolHandlerError,
};

/// Checks current authoritative permission, not a captured startup boolean.
/// Implementations fail closed on missing/invalid authority; messages must not
/// include secrets. It gates NEW work; shutdown still owns in-flight cleanup.
pub trait ExecutionGate: Send + Sync + 'static {
    fn require_active(&self) -> Result<(), String>;
}
#[derive(Clone, Default)]
pub(crate) struct ExecutionBoundary(Arc<OnceLock<Arc<dyn ExecutionGate>>>);
impl ExecutionBoundary {
    pub fn install(&self, gate: Arc<dyn ExecutionGate>) -> Result<(), String> {
        self.0
            .set(gate)
            .map_err(|_| "execution gate already installed".to_owned())
    }
    pub fn check(&self) -> Result<(), String> {
        self.0.get().map_or(Ok(()), |gate| gate.require_active())
    }
    pub fn provider(&self, inner: Arc<dyn ModelProvider>) -> Arc<dyn ModelProvider> {
        match self.0.get() {
            None => inner,
            Some(gate) => Arc::new(GatedProvider {
                inner,
                gate: gate.clone(),
            }),
        }
    }
    pub fn executor(&self, inner: ToolExecutor) -> ToolExecutor {
        match self.0.get() {
            None => inner,
            Some(gate) => {
                inner.with_additional_around(Arc::new(GatedHandler { gate: gate.clone() }))
            }
        }
    }
}
struct GatedHandler {
    gate: Arc<dyn ExecutionGate>,
}
impl AroundMiddleware for GatedHandler {
    fn around(&self, context: ToolExecutionContext, next: AroundNext) -> HandlerFuture {
        let gate = self.gate.clone();
        Box::pin(async move {
            gate.require_active().map_err(ToolHandlerError::new)?;
            next.run(context).await
        })
    }
}
struct GatedProvider {
    inner: Arc<dyn ModelProvider>,
    gate: Arc<dyn ExecutionGate>,
}
#[async_trait]
impl ModelProvider for GatedProvider {
    fn provider_name(&self) -> &str {
        self.inner.provider_name()
    }
    fn model_name(&self) -> Option<&str> {
        self.inner.model_name()
    }
    fn input_counter_failed(&self) {
        self.inner.input_counter_failed();
    }
    fn estimate_input_tokens(&self, request: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        self.inner.estimate_input_tokens(request)
    }
    async fn capabilities(
        &self,
        cancellation: CancellationToken,
    ) -> Result<ModelCapabilities, ProviderError> {
        self.gate.require_active().map_err(ProviderError::new)?;
        self.inner.capabilities(cancellation).await
    }
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.gate.require_active().map_err(ProviderError::new)?;
        self.inner.count_input_tokens(request, cancellation).await
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.gate.require_active().map_err(ProviderError::new)?;
        self.inner.stream(request, cancellation).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use xharness_tools::{
        ToolDefinition, ToolFailureKind, ToolOutput, ToolRegistry, ToolRequest, ToolSpec,
    };
    struct Gate(AtomicBool);
    impl ExecutionGate for Gate {
        fn require_active(&self) -> Result<(), String> {
            if self.0.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("sealed fixture".into())
            }
        }
    }
    #[derive(Default)]
    struct Provider(AtomicUsize);
    #[async_trait]
    impl ModelProvider for Provider {
        fn provider_name(&self) -> &str {
            "fixture"
        }
        fn model_name(&self) -> Option<&str> {
            Some("model")
        }
        async fn capabilities(
            &self,
            _: CancellationToken,
        ) -> Result<ModelCapabilities, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ModelCapabilities::default())
        }
        async fn count_input_tokens(
            &self,
            _: &ProviderRequest,
            _: CancellationToken,
        ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        async fn stream(
            &self,
            _: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures::stream::empty()))
        }
    }
    fn request() -> ProviderRequest {
        ProviderRequest {
            messages: vec![],
            tools: vec![],
            step: 0,
            reasoning_effort: None,
            max_output_tokens: None,
            debug_scope: Default::default(),
        }
    }
    #[tokio::test]
    async fn held_provider_checks_authority_for_every_request_and_auxiliary_operation() {
        let boundary = ExecutionBoundary::default();
        let gate = Arc::new(Gate(AtomicBool::new(true)));
        boundary.install(gate.clone()).unwrap();
        let inner = Arc::new(Provider::default());
        let provider = boundary.provider(inner.clone());
        assert_eq!(provider.provider_name(), "fixture");
        assert_eq!(provider.model_name(), Some("model"));
        provider
            .capabilities(CancellationToken::new())
            .await
            .unwrap();
        provider
            .count_input_tokens(&request(), CancellationToken::new())
            .await
            .unwrap();
        let _ = provider
            .stream(request(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(inner.0.load(Ordering::SeqCst), 3);
        gate.0.store(false, Ordering::SeqCst);
        assert!(provider
            .capabilities(CancellationToken::new())
            .await
            .is_err());
        assert!(provider
            .count_input_tokens(&request(), CancellationToken::new())
            .await
            .is_err());
        assert!(provider
            .stream(request(), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(inner.0.load(Ordering::SeqCst), 3);
    }
    #[test]
    fn unset_local_boundary_returns_same_provider_and_gate_cannot_be_replaced() {
        let boundary = ExecutionBoundary::default();
        let inner: Arc<dyn ModelProvider> = Arc::new(Provider::default());
        assert!(Arc::ptr_eq(&inner, &boundary.provider(inner.clone())));
        assert!(boundary.check().is_ok());
        boundary
            .install(Arc::new(Gate(AtomicBool::new(false))))
            .unwrap();
        assert!(boundary.check().is_err());
        assert!(boundary
            .install(Arc::new(Gate(AtomicBool::new(true))))
            .is_err());
    }
    struct WaitingAround {
        entered: Arc<tokio::sync::Semaphore>,
        release: Arc<tokio::sync::Semaphore>,
    }
    impl AroundMiddleware for WaitingAround {
        fn around(&self, context: ToolExecutionContext, next: AroundNext) -> HandlerFuture {
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.add_permits(1);
                release.acquire().await.unwrap().forget();
                next.run(context).await
            })
        }
    }
    #[tokio::test]
    async fn final_gate_preserves_old_middleware_and_blocks_handler_after_wait() {
        let gate = Arc::new(Gate(AtomicBool::new(true)));
        let boundary = ExecutionBoundary::default();
        boundary.install(gate.clone()).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = Arc::new(ToolRegistry::new());
        let count = calls.clone();
        registry
            .register(ToolSpec::new(
                ToolDefinition::new("fixture", "fixture", serde_json::json!({"type":"object"})),
                move |_| {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolOutput::text("ran"))
                    }
                },
            ))
            .await
            .unwrap();
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let executor = boundary.executor(ToolExecutor::new(registry).with_around(vec![Arc::new(
            WaitingAround {
                entered: entered.clone(),
                release: release.clone(),
            },
        )]));
        let task =
            tokio::spawn(async move { executor.execute(ToolRequest::new("fixture", "{}")).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        gate.0.store(false, Ordering::SeqCst);
        release.add_permits(1);
        let result = task.await.unwrap();
        assert_eq!(result.failure.unwrap().kind, ToolFailureKind::Handler);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn active_tool_runs_normally_through_gate() {
        let boundary = ExecutionBoundary::default();
        boundary
            .install(Arc::new(Gate(AtomicBool::new(true))))
            .unwrap();
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(ToolSpec::new(
                ToolDefinition::new("fixture", "fixture", serde_json::json!({"type":"object"})),
                |_| async { Ok(ToolOutput::text("ran")) },
            ))
            .await
            .unwrap();
        let result = boundary
            .executor(ToolExecutor::new(registry))
            .execute(ToolRequest::new("fixture", "{}"))
            .await;
        assert!(result.is_ok());
    }
}
