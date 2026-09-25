//! UI intent is transient and session-owned; no file bytes enter durable history.
use crate::BasicHost;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    display::{DisplayFile, DisplayOpen, DisplayRead, GitDiffScope},
    RpcError,
};
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

impl BasicHost {
    pub async fn read_display_file(
        &self,
        request: DisplayRead,
        cancellation: CancellationToken,
    ) -> Result<DisplayFile, RpcError> {
        if cancellation.is_cancelled() {
            return Err(RpcError::bad_request("file preview cancelled", json!([])));
        }
        if request.path.trim().is_empty()
            || request.path.len() > 4096
            || request.path.contains('\0')
        {
            return Err(RpcError::bad_request("invalid file path", json!([])));
        }
        let (cwd, permission) = {
            let state = self.state.read().await;
            let session = state
                .sessions
                .get(&request.session_id)
                .ok_or_else(|| RpcError::bad_request("session not found", json!([])))?;
            (
                session.cwd.clone(),
                session
                    .active_permission
                    .unwrap_or(session.permission_preset),
            )
        };
        // Resolve with the remote Host OS, never the browser's OS or cwd.
        let root = Path::new(&cwd);
        let base = match &request.relative_to {
            Some(base) if !base.is_empty() && base.len() <= 4096 && !base.contains('\0') => {
                let base = root.join(base);
                base.parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| RpcError::bad_request("invalid resource base", json!([])))?
            }
            Some(_) => return Err(RpcError::bad_request("invalid resource base", json!([]))),
            None => root.to_path_buf(),
        };
        if request.git_diff.is_some() && request.relative_to.is_some() {
            return Err(RpcError::bad_request(
                "Git diff cannot use a Markdown resource base",
                json!([]),
            ));
        }
        let path = normalize_path(base.join(&request.path))?;
        if let Some(scope) = request.git_diff {
            // The deployment cancels AND joins its managed child before returning.
            return self
                .agent_runtime
                .read_display_diff(&request.session_id, &cwd, &path, scope, cancellation)
                .await
                .map_err(|e| RpcError::bad_request(e, json!([])));
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(RpcError::bad_request("file preview cancelled", json!([]))),
            result = self.agent_runtime.read_display_file(&request.session_id, &cwd, permission, &path) => {
                // The runtime can cancel and complete in the same poll, after
                // the cancellation branch was polled Pending. Never project
                // those bytes merely because the read branch became Ready.
                if cancellation.is_cancelled() {
                    return Err(RpcError::bad_request("file preview cancelled", json!([])));
                }
                result.map_err(|e| RpcError::bad_request(e, json!([])))
            }
        }
    }
}
// Lexical resource parent normalization does not authorize an escape. The
// deployment's original no-follow FsService still enforces the workspace fence.
fn normalize_path(path: PathBuf) -> Result<PathBuf, RpcError> {
    use std::path::Component;
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if !result.pop() => {
                return Err(RpcError::bad_request(
                    "path escapes filesystem root",
                    json!([]),
                ))
            }
            Component::ParentDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

pub struct DisplayTool;
impl DisplayTool {
    pub fn for_host(host: &Arc<BasicHost>, session_id: &str) -> ToolSpec {
        let weak = Arc::downgrade(host);
        let session_id = session_id.to_owned();
        let definition=ToolDefinition::new(
            "display",
            "Show a file in this conversation's right-hand display panel. Pass a workspace-relative or absolute path. Markdown, PNG/JPEG/WebP/GIF, UTF-8 text/code and unified .diff/.patch files are supported. To show tracked workspace Git changes pass gitDiff working (index vs worktree), staged (HEAD vs index), or head (HEAD vs worktree), with path . or a workspace-relative file/directory. Git views exclude untracked files and are NOT this turn-only changes. This is read-only display for the user, not image input to the model. Returns requested, not proof the user saw it. Background sessions never steal focus. Use read to inspect content; do not embed full file contents here.",
            json!({"type":"object","additionalProperties":false,"properties":{
                "path":{"type":"string","minLength":1,"maxLength":4096},
                "gitDiff":{"type":"string","enum":[GitDiffScope::Working,GitDiffScope::Staged,GitDiffScope::Head]}
            },"required":["path"]}),
        );
        ToolSpec::new(definition, move |context| {
            let weak = weak.clone();
            let session_id = session_id.clone();
            async move {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Args {
                    path: String,
                    git_diff: Option<GitDiffScope>,
                }
                let args: Args = serde_json::from_value((*context.arguments).clone())
                    .map_err(|e| ToolHandlerError::new(e.to_string()))?;
                let host = weak
                    .upgrade()
                    .ok_or_else(|| ToolHandlerError::new("Host is shutting down"))?;
                let file = host
                    .read_display_file(
                        DisplayRead {
                            session_id: session_id.clone(),
                            path: args.path,
                            relative_to: None,
                            git_diff: args.git_diff,
                        },
                        context.cancellation.clone(),
                    )
                    .await
                    .map_err(|e| ToolHandlerError::new(e.message))?;
                if context.cancellation.is_cancelled() {
                    return Err(ToolHandlerError::new("display cancelled"));
                }
                let intent = DisplayOpen {
                    session_id,
                    path: file.path().into(),
                    git_diff: args.git_diff,
                };
                host.push_host(
                    json!({"type":"host/remote-event","event":"display/open","args":[intent]}),
                );
                Ok(ToolOutput::text(
                    json!({"status":"requested","path":file.path()}).to_string(),
                ))
            }
        })
        .with_timeout(Duration::from_secs(30))
    }
}

pub(crate) async fn read_rpc(
    host: &BasicHost,
    payload: &Value,
    cancellation: CancellationToken,
) -> Result<Value, RpcError> {
    let request: DisplayRead = serde_json::from_value(payload.clone())
        .map_err(|e| RpcError::bad_request(e.to_string(), json!([])))?;
    serde_json::to_value(host.read_display_file(request, cancellation).await?)
        .map_err(|e| RpcError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, PermissionPreset,
        RunningTurn,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use xharness_api::{ApiBackend, RpcId, RpcMethod};

    struct ReadyDisplayRuntime {
        reads: AtomicUsize,
        cancel_on_read: Option<CancellationToken>,
    }

    #[async_trait::async_trait]
    impl AgentRuntime for ReadyDisplayRuntime {
        fn has_available_route(&self) -> bool {
            false
        }

        fn can_route(&self, _: &crate::ModelRoute) -> bool {
            false
        }

        async fn start_turn(
            &self,
            _: AgentTurnRequest,
        ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
            panic!("a file preview must not start a model turn")
        }

        async fn read_display_file(
            &self,
            _: &str,
            _: &str,
            _: PermissionPreset,
            path: &Path,
        ) -> Result<DisplayFile, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if let Some(token) = &self.cancel_on_read {
                token.cancel();
            }
            // No await: cancellation and successful completion can become
            // Ready in this very poll, without any timers or scheduler race.
            Ok(DisplayFile::Text {
                path: path.to_str().unwrap().into(),
                text: "controlled preview bytes".into(),
            })
        }
    }

    async fn ready_host(
        cancel_on_read: Option<CancellationToken>,
    ) -> (Arc<BasicHost>, Arc<ReadyDisplayRuntime>) {
        let runtime = Arc::new(ReadyDisplayRuntime {
            reads: AtomicUsize::new(0),
            cancel_on_read,
        });
        let cwd = std::env::temp_dir();
        let host = BasicHost::with_agent_runtime(HostConfig::new(&cwd), runtime.clone());
        let created = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"sessionId":"s","cwd":cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(created.is_ok(), "{created:?}");
        (host, runtime)
    }

    fn request() -> DisplayRead {
        DisplayRead {
            session_id: "s".into(),
            path: "ready.txt".into(),
            relative_to: None,
            git_diff: None,
        }
    }

    #[tokio::test]
    async fn precancelled_preview_never_calls_ready_runtime() {
        let (host, runtime) = ready_host(None).await;
        let token = CancellationToken::new();
        token.cancel();
        let error = host.read_display_file(request(), token).await.unwrap_err();
        assert_eq!(error.message, "file preview cancelled");
        assert_eq!(runtime.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_after_admission_wins_before_ready_runtime_is_polled() {
        let (host, runtime) = ready_host(None).await;
        let token = CancellationToken::new();
        let state = host.state.write().await;
        let read = host.read_display_file(request(), token.clone());
        tokio::pin!(read);
        // Admit an uncancelled request, then hold it precisely at the session
        // read lock. On release, cancellation and runtime are both ready.
        assert!(futures::poll!(&mut read).is_pending());
        token.cancel();
        drop(state);
        assert_eq!(read.await.unwrap_err().message, "file preview cancelled");
        assert_eq!(runtime.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_inside_ready_runtime_cannot_return_preview_bytes() {
        let token = CancellationToken::new();
        let (host, runtime) = ready_host(Some(token.clone())).await;
        assert!(!token.is_cancelled());
        let error = host
            .read_display_file(request(), token.clone())
            .await
            .unwrap_err();
        assert!(token.is_cancelled());
        assert_eq!(error.message, "file preview cancelled");
        assert_eq!(runtime.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn uncancelled_ready_runtime_returns_preview_bytes() {
        let (host, runtime) = ready_host(None).await;
        let file = host
            .read_display_file(request(), CancellationToken::new())
            .await
            .unwrap();
        assert!(
            matches!(file, DisplayFile::Text { text, .. } if text == "controlled preview bytes")
        );
        assert_eq!(runtime.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn resource_parent_is_lexical_and_no_root_escape() {
        assert_eq!(
            normalize_path(PathBuf::from("/workspace/docs/../figure.png")).unwrap(),
            PathBuf::from("/workspace/figure.png")
        );
        assert!(normalize_path(PathBuf::from("/../../file")).is_err());
    }
}
