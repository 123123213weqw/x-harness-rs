//! In-process UI capability behind the existing lazy MCP gateway, on Web and
//! desktop alike. No external server, browser bridge or plugin installation.
use std::{
    sync::{Arc, Weak},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_api::display::{DisplayRead, GitDiffScope};
use xharness_host::BasicHost;
use xharness_tools::{validate_arguments, ToolDefinition, ToolHandlerError, ToolOutput};

pub(crate) const PLUGIN: &str = "builtin";
pub(crate) const SERVER: &str = "ui";

pub(crate) struct BuiltinUi {
    host: Weak<BasicHost>,
    owner: String,
}

impl BuiltinUi {
    pub(crate) fn new(host: &Arc<BasicHost>, owner: &str) -> Self {
        Self {
            host: Arc::downgrade(host),
            owner: owner.into(),
        }
    }

    pub(crate) fn definition() -> ToolDefinition {
        ToolDefinition::new(
            "display",
            "Show a file in this conversation's right-hand display panel. Pass a workspace-relative or absolute path. Markdown, PNG/JPEG/WebP/GIF, UTF-8 text/code and unified .diff/.patch files are supported. To show tracked workspace Git changes pass gitDiff working (index vs worktree), staged (HEAD vs index), or head (HEAD vs worktree), with path . or a workspace-relative file/directory. Git views exclude untracked files and are NOT this turn-only changes. This is read-only display for the user, not image input to the model. Returns requested, not proof the user saw it. Background sessions never steal focus. Use read to inspect content; do not embed full file contents here.",
            json!({"type":"object","additionalProperties":false,"properties":{
                "path":{"type":"string","minLength":1,"maxLength":4096},
                "gitDiff":{"type":"string","enum":[GitDiffScope::Working,GitDiffScope::Staged,GitDiffScope::Head]}
            },"required":["path"]}),
        )
    }

    pub(crate) async fn call(
        &self,
        tool: &str,
        parameters: Value,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, ToolHandlerError> {
        if tool != "display" {
            return Err(ToolHandlerError::new("unknown builtin UI tool"));
        }
        validate_arguments(&Self::definition().parameters, &parameters)
            .map_err(|e| ToolHandlerError::new(e.to_string()))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            path: String,
            git_diff: Option<GitDiffScope>,
        }
        let args: Args =
            serde_json::from_value(parameters).map_err(|e| ToolHandlerError::new(e.to_string()))?;
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| ToolHandlerError::new("Host is shutting down"))?;
        let token = cancellation.child_token();
        let open = host.request_display_open(
            DisplayRead {
                session_id: self.owner.clone(),
                path: args.path,
                relative_to: None,
                git_diff: args.git_diff,
            },
            token.clone(),
        );
        tokio::pin!(open);
        // Keep the former display deadline, not the external MCP server's 90s.
        // Cancel AND allow managed Git cleanup to settle before dropping it,
        // using the same five-second grace as the shared tool executor.
        let intent = tokio::select! {
            biased;
            result = &mut open => result.map_err(|e| ToolHandlerError::new(e.message))?,
            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                token.cancel();
                let _ = tokio::time::timeout(Duration::from_secs(5), &mut open).await;
                return Err(ToolHandlerError::new("display timed out"));
            }
        };
        Ok(ToolOutput::text(
            json!({"status":"requested","path":intent.path}).to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use xharness_api::{ApiBackend, RpcId, RpcMethod};
    use xharness_host::{
        AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, ModelRoute, RunningTurn,
    };

    #[derive(Default)]
    struct WaitingDiff {
        started: AtomicUsize,
        joined: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl AgentRuntime for WaitingDiff {
        fn has_available_route(&self) -> bool {
            false
        }
        fn can_route(&self, _: &ModelRoute) -> bool {
            false
        }
        async fn start_turn(
            &self,
            _: AgentTurnRequest,
        ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
            panic!("UI display must not start a model turn")
        }
        async fn read_display_diff(
            &self,
            _: &str,
            _: &str,
            _: &Path,
            _: GitDiffScope,
            cancellation: CancellationToken,
        ) -> Result<xharness_api::display::DisplayFile, String> {
            self.started.fetch_add(1, Ordering::SeqCst);
            cancellation.cancelled().await;
            self.joined.fetch_add(1, Ordering::SeqCst);
            Err("fixture diff cancelled and joined".into())
        }
    }
    async fn fixture() -> (Arc<BasicHost>, Arc<WaitingDiff>, BuiltinUi) {
        let runtime = Arc::new(WaitingDiff::default());
        let cwd = std::env::temp_dir();
        let host = BasicHost::with_agent_runtime(HostConfig::new(&cwd), runtime.clone());
        let result = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"sessionId":"s","cwd":cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(result.is_ok(), "{result:?}");
        let ui = BuiltinUi::new(&host, "s");
        (host, runtime, ui)
    }

    #[tokio::test(start_paused = true)]
    async fn ui_keeps_thirty_second_deadline_and_joins_diff_before_returning() {
        let (host, runtime, ui) = fixture().await;
        let mut events = host.host_events();
        let cancellation = CancellationToken::new();
        let call = ui.call(
            "display",
            json!({"path":".","gitDiff":"working"}),
            &cancellation,
        );
        tokio::pin!(call);
        assert!(futures::poll!(&mut call).is_pending());
        assert_eq!(runtime.started.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(29)).await;
        assert!(futures::poll!(&mut call).is_pending());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(call.await.unwrap_err().message, "display timed out");
        assert_eq!(runtime.joined.load(Ordering::SeqCst), 1);
        use futures::StreamExt;
        assert!(
            futures::poll!(events.next()).is_pending(),
            "timeout must not emit a display intent"
        );
    }

    #[tokio::test]
    async fn parent_cancellation_joins_diff_and_never_emits_an_intent() {
        let (host, runtime, ui) = fixture().await;
        let mut events = host.host_events();
        let cancellation = CancellationToken::new();
        let call = ui.call(
            "display",
            json!({"path":".","gitDiff":"working"}),
            &cancellation,
        );
        tokio::pin!(call);
        assert!(futures::poll!(&mut call).is_pending());
        cancellation.cancel();
        assert!(call
            .await
            .unwrap_err()
            .message
            .contains("cancelled and joined"));
        assert_eq!(runtime.joined.load(Ordering::SeqCst), 1);
        use futures::StreamExt;
        assert!(futures::poll!(events.next()).is_pending());
    }
}
