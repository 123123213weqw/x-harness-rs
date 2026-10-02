//! Bridge the existing file tools to the Host-owned workspace memory capability.
use async_trait::async_trait;
use std::sync::{Arc, Weak};
use tokio::sync::Mutex;
use xharness_coding_tools::{FileMountProvider, MountedFile};
use xharness_tools::ToolHandlerError;

pub(crate) struct Mount {
    pub host: Weak<xharness_host::BasicHost>,
    pub session: String,
    // Keep the observation ledger alive across this executor's read/edit calls.
    pub filesystem: Mutex<Option<Arc<xharness_fs::FsService>>>,
}
#[async_trait]
impl FileMountProvider for Mount {
    async fn resolve(
        &self,
        path: &str,
        _writing: bool,
    ) -> Result<Option<MountedFile>, ToolHandlerError> {
        if !path.starts_with("memory:") {
            return Ok(None);
        }
        if path != xharness_host::MEMORY_URI {
            return Err(ToolHandlerError::new(
                "only memory://MEMORY.md in the current workspace is available",
            ));
        }
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| ToolHandlerError::new("memory Host is unavailable"))?;
        // Recheck live mode on every invocation, including old executors.
        let fs = host
            .memory_filesystem(&self.session)
            .await
            .map_err(ToolHandlerError::new)?;
        let target = fs
            .resolve("MEMORY.md")
            .map_err(|e| ToolHandlerError::new(e.to_string()))?;
        *self.filesystem.lock().await = Some(fs.clone());
        Ok(Some(MountedFile {
            filesystem: fs,
            target,
            max_bytes: xharness_host::MEMORY_MAX_BYTES,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeToolFactory, WebRuntime};
    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{BasicHost, HostConfig, NoTools, PermissionPreset, SessionToolFactory};
    use xharness_tools::{ToolExecutor, ToolRequest};
    async fn call(executor: &ToolExecutor, tool: &str, args: Value) -> xharness_tools::ToolResult {
        executor
            .execute(ToolRequest::new(tool, args.to_string()))
            .await
    }
    async fn memory(host: &BasicHost, payload: Value) -> Value {
        match host
            .call_dynamic(
                RpcId::new(format!("memory-{}", payload["action"])),
                "workspace/memory",
                payload,
                CancellationToken::new(),
            )
            .await
            .unwrap()
        {
            RpcResult::Success { value: Some(v) } => v,
            other => panic!("{other:?}"),
        }
    }
    #[tokio::test]
    async fn native_file_tools_memory_cas_scope_limits_and_live_revocation() {
        let root = crate::tests::TempWorkspace::new();
        let other = crate::tests::TempWorkspace::new();
        let mut config = HostConfig::new(&root.0);
        config.memory_dir = Some(root.0.join("app-data-memory"));
        let host = BasicHost::new(config, None, Arc::new(NoTools));
        for (id, path) in [("a", &root.0), ("b", &other.0)] {
            assert!(host
                .call(
                    RpcId::new(format!("create-{id}")),
                    RpcMethod::SessionCreate,
                    json!({"sessionId":id,"cwd":path}),
                    CancellationToken::new()
                )
                .await
                .is_ok());
        }
        let factory = NativeToolFactory::new(WebRuntime::default());
        factory.bind_agent_host(&host).unwrap();
        let executor = factory
            .executor(
                "a",
                &root.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let names = executor
            .registry()
            .definitions()
            .await
            .into_iter()
            .map(|d| d.name)
            .collect::<Vec<_>>();
        assert!(!names.iter().any(|n| n.contains("memory")));
        let uri = xharness_host::MEMORY_URI;
        assert!(call(&executor, "read", json!({"path":uri})).await.is_ok());
        assert!(call(
            &executor,
            "write",
            json!({"path":uri,"content":"fact alpha"})
        )
        .await
        .is_ok());
        // A different session in this same workspace has no model observation;
        // the injected/Settings preview is not enough to authorize a write.
        assert!(host
            .call(
                RpcId::new("create-c"),
                RpcMethod::SessionCreate,
                json!({"sessionId":"c","cwd":root.0}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        let blind = factory
            .executor(
                "c",
                &root.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let _ = memory(&host, json!({"sessionId":"c","action":"view"})).await;
        assert!(!call(
            &blind,
            "edit",
            json!({"path":uri,"old":"alpha","new":"blind"})
        )
        .await
        .is_ok());
        assert!(call(&executor, "read", json!({"path":uri})).await.is_ok());
        assert!(call(
            &executor,
            "edit",
            json!({"path":uri,"old":"alpha","new":"beta"})
        )
        .await
        .is_ok());
        let other_executor = factory
            .executor(
                "b",
                &other.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let empty = call(&other_executor, "read", json!({"path":uri})).await;
        assert!(empty.is_ok());
        assert!(format!("{empty:?}").contains("absent"));
        for path in [
            "memory://../settings.json",
            "memory://settings.json",
            "memory://other/MEMORY.md",
        ] {
            assert!(!call(&executor, "read", json!({"path":path})).await.is_ok());
            assert!(
                !call(&executor, "write", json!({"path":path,"content":"x"}))
                    .await
                    .is_ok()
            );
        }
        assert!(!call(
            &executor,
            "write",
            json!({"path":uri,"content":"x".repeat(xharness_host::MEMORY_MAX_BYTES+1)})
        )
        .await
        .is_ok());
        let view = memory(&host, json!({"sessionId":"a","action":"view"})).await;
        // UI edits invalidate the model's prior observation.
        memory(
            &host,
            json!({"sessionId":"a","action":"save","version":view["version"],"content":"external"}),
        )
        .await;
        assert!(
            !call(&executor, "write", json!({"path":uri,"content":"stale"}))
                .await
                .is_ok()
        );
        memory(&host,json!({"sessionId":"a","action":"configure","mode":"off","settingsVersion":view["settingsVersion"]})).await;
        assert!(!call(&executor, "read", json!({"path":uri})).await.is_ok());
        assert!(!call(
            &executor,
            "write",
            json!({"path":uri,"content":"after-off"})
        )
        .await
        .is_ok());
        std::fs::write(
            root.0.join("ordinary.txt"),
            "ordinary file remains readable",
        )
        .unwrap();
        assert!(call(&executor, "read", json!({"path":"ordinary.txt"}))
            .await
            .is_ok());
        assert!(!root.0.join("MEMORY.md").exists());
        host.stop_background_listeners();
    }
    #[tokio::test]
    async fn settings_wire_routes_match_client_and_do_not_duplicate_notes_in_rpc_debug() {
        let root = crate::tests::TempWorkspace::new();
        let mut config = HostConfig::new(&root.0);
        config.memory_dir = Some(root.0.join("memory"));
        let host = BasicHost::new(config, None, Arc::new(NoTools));
        assert!(host
            .call(
                RpcId::new("create-http"),
                RpcMethod::SessionCreate,
                json!({"sessionId":"http","cwd":root.0}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        let sink = Arc::new(xharness_debug::MemoryDebugSink::default());
        let backend: Arc<dyn ApiBackend> = host.clone();
        let router = xharness_server::api_router_with_debug(
            backend,
            xharness_debug::DebugRecorder::new(sink.clone()),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = CancellationToken::new();
        let task = tokio::spawn(xharness_server::serve(
            listener,
            router,
            stop.clone().cancelled_owned(),
        ));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        async fn post(
            client: &reqwest::Client,
            base: &str,
            endpoint: &str,
            id: &str,
            payload: Value,
        ) -> Value {
            let response=client.post(format!("{base}/api/{endpoint}"))
                .json(&json!({"type":"client-request","rpcId":id,"method":endpoint,"payload":payload}))
                .send().await.unwrap();
            assert!(response.status().is_success());
            let response: Value = response.json().await.unwrap();
            assert_eq!(response["result"]["ok"], true, "{response}");
            response["result"]["value"].clone()
        }
        let list = post(&client, &base, "workspace.list", "list", json!({})).await;
        let id = &list["items"][0]["workspaceId"];
        assert!(id.is_string());
        let view = post(
            &client,
            &base,
            "workspace/memory",
            "view",
            json!({"workspaceId":id,"action":"view"}),
        )
        .await;
        assert_eq!(view["mode"], "manual");
        post(&client,&base,"workspace/memory","save",json!({"workspaceId":id,"action":"save","version":view["version"],"content":"PRIVATE_WORKSPACE_NOTE"})).await;
        let saved = post(
            &client,
            &base,
            "workspace/memory",
            "read",
            json!({"workspaceId":id,"action":"view"}),
        )
        .await;
        assert_eq!(saved["content"], "PRIVATE_WORKSPACE_NOTE");
        let debug = serde_json::to_string(&sink.events().await).unwrap();
        assert!(!debug.contains("PRIVATE_WORKSPACE_NOTE"));
        assert!(debug.contains("bodyOmitted"));
        drop(client);
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        host.stop_background_listeners();
    }
}
