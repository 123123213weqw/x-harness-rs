use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use xharness_core::{
    AgentMessage, ContextPolicy, LoopCommand, LoopControlError, LoopEngine, LoopEvent, LoopRequest,
    LoopResult, LoopRun, ModelProvider,
};

use crate::SessionToolFactory;

/// Provider/model selection requested by one Host session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRoute {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

impl ModelRoute {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            reasoning_effort: None,
        }
    }
}

/// Complete provider-neutral input needed to start one Host turn.
#[derive(Clone, Debug)]
pub struct AgentTurnRequest {
    pub session_id: String,
    pub cwd: String,
    pub route: ModelRoute,
    pub messages: Vec<AgentMessage>,
}

/// A live turn owned by the Host driver. This seam prevents Web control-plane
/// code from depending on a particular loop or future long-lived Agent
/// implementation.
#[async_trait]
pub trait RunningTurn: Send + 'static {
    async fn next_event(&mut self) -> Option<LoopEvent>;

    async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError>;

    async fn result(&mut self) -> LoopResult;
}

#[async_trait]
impl RunningTurn for LoopRun {
    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.next().await
    }

    async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError> {
        LoopRun::send(self, command).await
    }

    async fn result(&mut self) -> LoopResult {
        LoopRun::result(self).await
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum AgentRuntimeError {
    #[error("model route {provider}/{model} is unavailable")]
    ModelUnavailable { provider: String, model: String },
    #[error("agent turn preparation failed: {message}")]
    Preparation { message: String },
}

/// Host-facing Agent execution seam. The Web Host owns queues and projections;
/// the runtime owns model routing, tool preparation, context policy and the
/// actual turn implementation.
#[async_trait]
pub trait AgentRuntime: Send + Sync + 'static {
    fn has_available_route(&self) -> bool;

    fn can_route(&self, route: &ModelRoute) -> bool;

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError>;
}

/// Adapter from the v0 [`LoopEngine`] to the Host-facing Agent runtime seam.
/// It is intentionally replaceable by a durable Agent/Inbox runtime later.
pub struct LoopAgentRuntime {
    provider_id: String,
    model_id: String,
    provider: Option<Arc<dyn ModelProvider>>,
    tool_factory: Arc<dyn SessionToolFactory>,
    context_policy: Arc<dyn ContextPolicy>,
}

impl LoopAgentRuntime {
    pub fn new(
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
        context_policy: Arc<dyn ContextPolicy>,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            provider,
            tool_factory,
            context_policy,
        }
    }
}

#[async_trait]
impl AgentRuntime for LoopAgentRuntime {
    fn has_available_route(&self) -> bool {
        self.provider.is_some()
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.provider.is_some()
            && route.provider == self.provider_id
            && route.model == self.model_id
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        if !self.can_route(&request.route) {
            return Err(AgentRuntimeError::ModelUnavailable {
                provider: request.route.provider,
                model: request.route.model,
            });
        }
        let provider = Arc::clone(self.provider.as_ref().expect("route checked provider"));
        let tools = self
            .tool_factory
            .tools(&request.session_id, &request.cwd)
            .await
            .map_err(|message| AgentRuntimeError::Preparation { message })?;
        let mut loop_request = LoopRequest::new(provider, request.messages);
        loop_request.session_id = Some(request.session_id);
        loop_request.tools = tools;
        loop_request.context_policy = Arc::clone(&self.context_policy);
        Ok(Box::new(LoopEngine.start(loop_request)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoTools;
    use xharness_core::IdentityContextPolicy;

    #[tokio::test]
    async fn unavailable_runtime_rejects_before_turn_construction() {
        let runtime = LoopAgentRuntime::new(
            "provider-a",
            "model-a",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
        );
        let route = ModelRoute::new("provider-a", "model-a");
        assert!(!runtime.has_available_route());
        assert!(!runtime.can_route(&route));
        let error = runtime
            .start_turn(AgentTurnRequest {
                session_id: "session".to_owned(),
                cwd: "/workspace".to_owned(),
                route,
                messages: vec![AgentMessage::user("hello")],
            })
            .await
            .err()
            .expect("missing provider must reject the turn");
        assert_eq!(
            error,
            AgentRuntimeError::ModelUnavailable {
                provider: "provider-a".to_owned(),
                model: "model-a".to_owned(),
            }
        );
    }
}
