//! Read-only GitHub feature seam. Authentication and network/process ownership
//! belong to native composition, not Agent tools or model settings.
use crate::BasicHost;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::RpcError;

#[async_trait]
pub trait GitHubBackend: Send + Sync {
    /// Presentation-only query. The Host resolves a registered workspace; no
    /// client-chosen path, shell, credentials or model tools cross this seam.
    async fn project_status(
        &self,
        _cwd: &str,
        _cancellation: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal(
            "Project GitHub status is unavailable in this Host build",
        ))
    }

    async fn save_review(&self, _target: &Value, _run: &Value) -> Result<(), RpcError> {
        Err(RpcError::internal("Review persistence unavailable"))
    }
    async fn review_history(&self, _target: &Value) -> Result<Vec<Value>, RpcError> {
        Ok(Vec::new())
    }

    async fn read(
        &self,
        endpoint: &str,
        payload: &Value,
        cancellation: CancellationToken,
    ) -> Result<Value, RpcError>;
}
impl BasicHost {
    pub fn install_github(&self, backend: Arc<dyn GitHubBackend>) -> Result<(), String> {
        self.github
            .set(backend)
            .map_err(|_| "GitHub backend already installed".into())
    }
}

impl BasicHost {
    pub(crate) async fn project_github_status(
        &self,
        payload: &Value,
        cancellation: CancellationToken,
    ) -> Result<Value, RpcError> {
        if cancellation.is_cancelled() {
            return Err(RpcError::bad_request(
                "Project status cancelled",
                serde_json::json!([]),
            ));
        }
        let object = payload
            .as_object()
            .ok_or_else(|| RpcError::bad_request("Expected workspaceId", serde_json::json!([])))?;
        let id = object
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control))
            .ok_or_else(|| RpcError::bad_request("Invalid workspaceId", serde_json::json!([])))?;
        if object.len() != 1 {
            return Err(RpcError::bad_request(
                "Only workspaceId is accepted",
                serde_json::json!([]),
            ));
        }
        let cwd = self
            .state
            .read()
            .await
            .workspaces
            .get(id)
            .map(|w| w.path.clone())
            .ok_or_else(|| RpcError::bad_request("Workspace not found", serde_json::json!([])))?;
        let backend = self.github.get().ok_or_else(|| {
            RpcError::internal("GitHub integration is unavailable in this Host build")
        })?;
        let value = backend.project_status(&cwd, cancellation.clone()).await?;
        if cancellation.is_cancelled() {
            return Err(RpcError::bad_request(
                "Project status cancelled",
                serde_json::json!([]),
            ));
        }
        // Removing/replacing a workspace while the network is in flight must
        // not project another registration's result.
        if self
            .state
            .read()
            .await
            .workspaces
            .get(id)
            .is_none_or(|w| w.path != cwd)
        {
            return Err(RpcError::bad_request(
                "Workspace changed; refresh status",
                serde_json::json!([]),
            ));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod project_tests {
    use super::*;
    use crate::{HostConfig, NoTools};
    use serde_json::json;
    use std::sync::Mutex;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    struct Backend(Mutex<Vec<String>>);
    #[async_trait]
    impl GitHubBackend for Backend {
        async fn read(&self, _: &str, _: &Value, _: CancellationToken) -> Result<Value, RpcError> {
            panic!("must use project-only seam")
        }
        async fn project_status(&self, cwd: &str, _: CancellationToken) -> Result<Value, RpcError> {
            self.0.lock().unwrap().push(cwd.into());
            Ok(json!({"kind":"no_pr","ci":"none"}))
        }
    }
    #[tokio::test]
    async fn project_route_only_accepts_registered_workspace_and_does_not_create_sessions() {
        let root = std::env::temp_dir();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        let backend = Arc::new(Backend(Mutex::new(vec![])));
        host.install_github(backend.clone()).unwrap();
        let workspace = host
            .call(
                RpcId::new("workspace"),
                RpcMethod::WorkspaceCreate,
                json!({"path":root}),
                CancellationToken::new(),
            )
            .await;
        let id = match workspace {
            RpcResult::Success { value: Some(v) } => {
                v["workspace"]["workspaceId"].as_str().unwrap().to_owned()
            }
            v => panic!("{v:?}"),
        };
        for payload in [
            json!({}),
            json!({"workspaceId":"missing"}),
            json!({"workspaceId":id,"path":"/untrusted"}),
            json!({"workspaceId":id,"args":{"cmd":"mutate"}}),
        ] {
            assert!(matches!(
                host.call_dynamic(
                    RpcId::new("invalid"),
                    "github/project-status",
                    payload,
                    CancellationToken::new()
                )
                .await,
                Some(RpcResult::Failure { .. })
            ));
        }
        assert!(backend.0.lock().unwrap().is_empty());
        let reply = host
            .call_dynamic(
                RpcId::new("valid"),
                "github/project-status",
                json!({"workspaceId":id}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(reply, Some(RpcResult::Success { .. })));
        assert_eq!(
            backend.0.lock().unwrap().as_slice(),
            [std::fs::canonicalize(root).unwrap().to_string_lossy()]
        );
        assert!(
            host.state.read().await.sessions.is_empty(),
            "query does not hydrate/start model work"
        );
    }
}

#[cfg(test)]
mod project_race_tests {
    use super::*;
    use crate::{HostConfig, NoTools};
    use serde_json::json;
    use tokio::sync::Notify;
    struct Gate {
        entered: Notify,
        release: Notify,
    }
    #[async_trait]
    impl GitHubBackend for Gate {
        async fn read(&self, _: &str, _: &Value, _: CancellationToken) -> Result<Value, RpcError> {
            panic!("wrong seam")
        }
        async fn project_status(&self, _: &str, _: CancellationToken) -> Result<Value, RpcError> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(json!({"kind":"no_pr","ci":"none"}))
        }
    }
    #[tokio::test]
    async fn removal_during_read_and_cancel_never_publish_success() {
        for cancel in [false, true] {
            let host = BasicHost::new(
                HostConfig::new(std::env::temp_dir()),
                None,
                Arc::new(NoTools),
            );
            let gate = Arc::new(Gate {
                entered: Notify::new(),
                release: Notify::new(),
            });
            host.install_github(gate.clone()).unwrap();
            // Use a registered metadata row without starting any session.
            let id = "workspace-fixture";
            host.state.write().await.workspaces.insert(
                id.into(),
                crate::state::WorkspaceRecord {
                    workspace_id: id.into(),
                    path: std::env::temp_dir().to_string_lossy().into_owned(),
                    title: "Fixture".into(),
                    session_ids: vec![],
                    created_at: "0".into(),
                    updated_at: "0".into(),
                },
            );
            let cancellation = CancellationToken::new();
            let task = {
                let host = host.clone();
                let cancellation = cancellation.clone();
                tokio::spawn(async move {
                    host.project_github_status(&json!({"workspaceId":id}), cancellation)
                        .await
                })
            };
            gate.entered.notified().await;
            if cancel {
                cancellation.cancel()
            } else {
                host.state.write().await.workspaces.remove(id);
            }
            gate.release.notify_one();
            assert!(task.await.unwrap().is_err());
            assert!(host.state.read().await.sessions.is_empty());
        }
    }
}
