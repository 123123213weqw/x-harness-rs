//! Explicit server-only chain acceptance. Real browser/MCP/Host/media pipeline;
//! the scripted provider only inspects requests and is not a model-quality test.
#![forbid(unsafe_code)]

use std::{
    io::{Cursor, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_core::{FinishReason, ModelProvider, ProviderEvent, ProviderRequest};
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, SessionToolFactory,
};
use xharness_mcp::McpRuntime;
use xharness_plugins::PluginManager;
use xharness_session::{ContentBlock, EventData, Store};
use xharness_tools::{ToolExecutor, ToolRegistry};

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct ScriptedProvider {
    url: String,
    requests: Mutex<Vec<ProviderRequest>>,
}
#[async_trait]
impl ModelProvider for ScriptedProvider {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
        let step = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len()
        };
        let arguments = match step {
            1 => Some(json!({"action":"navigate","url":self.url})),
            2 => Some(json!({"action":"screenshot"})),
            _ => None,
        };
        let events = if let Some(arguments) = arguments {
            vec![Ok(ProviderEvent::ToolCallDelta { index: 0, id: format!("browser-call-{step}"), name: "plugin_mcp".into(),
                arguments_delta: json!({"action":"call","plugin":"browser-chain-fixture","server":"browser","tool":"browser","arguments":arguments}).to_string() }),
                Ok(ProviderEvent::Completed { finish_reason: Some(FinishReason::ToolCalls), usage: None, provider_items: Vec::new() })]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("chain inspected".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
struct BrowserTools {
    host: OnceLock<Weak<BasicHost>>,
    manager: Arc<PluginManager>,
    mcp: Arc<McpRuntime>,
}
#[async_trait]
impl SessionToolFactory for BrowserTools {
    async fn executor(
        &self,
        session: &str,
        _: &str,
        _: xharness_host::PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let binding = super::bind(
            Some(self.manager.clone()),
            Some(self.mcp.clone()),
            None,
            None,
            session.into(),
            true,
            Some(Arc::new(crate::computer_media::Sink {
                host: self.host.get().ok_or("test Host not installed")?.clone(),
                session: session.into(),
            })),
        );
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(binding.spec)
            .await
            .map_err(|error| error.to_string())?;
        Ok(ToolExecutor::new(registry).with_guards(vec![binding.guard]))
    }
}
async fn rpc(host: &BasicHost, method: RpcMethod, args: Value) -> Value {
    let result = host
        .call(
            RpcId::new(method.to_string()),
            method,
            args,
            CancellationToken::new(),
        )
        .await;
    let RpcResult::Success { value: Some(value) } = result else {
        panic!("{method}: {result:?}");
    };
    xharness_api::protocol::TypedRpcResponse::decode(method, &value).unwrap();
    value
}
async fn install(root: &Root, url: &str, launcher: PathBuf) -> Arc<PluginManager> {
    let config = json!({"mcpServers":{"browser":{"type":"stdio","command":"node","args":[launcher],"env":{
        "XHARNESS_BROWSER_ALLOWED_ORIGINS":json!([url]).to_string(),
        "XHARNESS_BROWSER_ARTIFACT_ROOT":root.0.join("browser-artifacts")
    }}}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        (
            ".claude-plugin/plugin.json",
            json!({"name":"browser-chain-fixture","version":"1.0.0"}).to_string(),
        ),
        (".mcp.json", config.to_string()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let manager = Arc::new(PluginManager::open(root.0.join("plugins")).unwrap());
    manager.import_catalog(&json!({"plugins":[{"name":"browser-chain-fixture","version":"1.0.0","source":{
        "source":"url","type":"zip","url":"https://example.invalid/browser-chain.zip","sha256":format!("{:x}", Sha256::digest(&bytes))
    }}]}).to_string()).await.unwrap();
    let installed = manager
        .install_verified_archive("browser-chain-fixture", &bytes)
        .await
        .unwrap();
    assert!(!installed.enabled && !installed.mcp_enabled);
    // This is an MCP-only package. Skill enablement is a separate capability
    // and must not be invented just to make a transport acceptance pass.
    let enabled = manager
        .set_mcp_enabled("browser-chain-fixture", true)
        .await
        .unwrap();
    assert!(!enabled.enabled && enabled.mcp_enabled);
    manager
}

#[tokio::test]
#[ignore = "explicit isolated server acceptance: requires built browser-use plugin and Playwright Chromium; no model credentials"]
async fn real_browser_mcp_image_reaches_provider_request_and_durable_history() {
    assert_eq!(
        std::env::var("XHARNESS_BROWSER_TEST_SERVER").as_deref(),
        Ok("1"),
        "run only on the isolated server"
    );
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    let plugin = repository.join("plugins/browser-use");
    assert!(
        plugin.join("dist/protocol.js").is_file(),
        "build browser-use before this explicit acceptance"
    );
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        Root(std::env::temp_dir().join(format!("xh-browser-chain-{}-{nonce}", std::process::id())));
    std::fs::create_dir(&root.0).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        let routes = axum::Router::new().route("/", axum::routing::get(|| async {
            axum::response::Html("<!doctype html><title>Browser chain fixture</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(20,40,60)}#marker{width:120px;height:60px;background:rgb(255,0,0)}</style><div id=marker></div><h1>Browser chain fixture</h1>")
        }));
        axum::serve(listener, routes).await.unwrap();
    });
    let manager = install(&root, &origin, plugin.join("server.mjs")).await;
    let mcp = McpRuntime::new();
    let provider = Arc::new(ScriptedProvider {
        url: format!("{origin}/"),
        requests: Mutex::new(Vec::new()),
    });
    let tools = Arc::new(BrowserTools {
        host: OnceLock::new(),
        manager,
        mcp: mcp.clone(),
    });
    let store =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "p",
        "m",
        Some(provider.clone()),
        tools.clone(),
        Arc::new(xharness_core::IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        32,
    ));
    let mut registry = xharness_host::ModelRegistry::new();
    registry
        .register(xharness_host::RegisteredModel::new(
            xharness_host::ModelDescriptor::new("p", "Scripted provider", "m", "Chain inspector")
                .with_image_input(
                    Some(true),
                    json!({"state":"supported","source":"test-fixture"}),
                ),
            provider.clone(),
        ))
        .unwrap();
    runtime.replace_model_registry(registry);
    let mut config = HostConfig::new(&root.0);
    config.home = root.0.clone();
    config.provider_id = "p".into();
    config.model_id = "m".into();
    config.attachment_store = Arc::new(
        xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap(),
    );
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    tools.host.set(Arc::downgrade(&host)).unwrap();
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":root.0})).await;
    let sid = created["sessionId"].as_str().unwrap();
    rpc(&host, RpcMethod::SessionPrompt, json!({"sessionId":sid,"mode":"queue","content":[{"type":"text","text":"Capture and inspect the local fixture"}]})).await;
    let settled = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let session = store.load(sid).await.unwrap().unwrap();
            if session
                .events()
                .iter()
                .any(|event| matches!(event.data(), EventData::TurnEnd { .. }))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    // Always stop this isolated browser before assertions about the evidence.
    let graceful = runtime.shutdown(Duration::from_secs(3)).await.is_graceful();
    mcp.shutdown().await;
    fixture.abort();
    assert!(graceful);
    settled.expect("browser chain did not settle within its acceptance budget");
    let attachment = {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            3,
            "navigate, screenshot, then scripted inspection"
        );
        let images: Vec<_> = requests[2]
            .messages
            .iter()
            .filter(|message| message.role == xharness_core::Role::Tool)
            .flat_map(|message| &message.content_blocks)
            .filter_map(|block| match block {
                ContentBlock::Image { attachment } => Some(attachment),
                _ => None,
            })
            .collect();
        assert_eq!(
            images.len(),
            1,
            "actual provider input must contain one image, not textified base64"
        );
        images[0].clone()
    };
    assert_eq!(attachment.session_id, sid);
    assert_eq!((attachment.width, attachment.height), (1280, 800));
    let resolved = host
        .attachment_store()
        .resolve(sid, &attachment.id)
        .await
        .unwrap();
    let pixels = image::load_from_memory(&resolved.data).unwrap().to_rgb8();
    assert_eq!(
        pixels.get_pixel(20, 20).0,
        [255, 0, 0],
        "PNG must contain rendered page pixels"
    );
    assert_eq!(pixels.get_pixel(500, 500).0, [20, 40, 60]);
    assert!(host
        .attachment_store()
        .resolve("other-session", &attachment.id)
        .await
        .is_err());
    store.flush(sid).await.unwrap();
    let live = rpc(&host, RpcMethod::SessionHistory, json!({"sessionId":sid})).await;
    let encoded = live.to_string();
    assert!(encoded.contains(&attachment.id));
    assert!(!encoded.contains("iVBOR") && !encoded.contains("data:image"));
    let reopened =
        xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap();
    let restored = xharness_attachments::AttachmentStore::resolve(&reopened, sid, &attachment.id)
        .await
        .unwrap();
    assert_eq!(restored.data.as_slice(), resolved.data.as_slice());
    // This is real Chromium -> stdio MCP -> real Host attachment sink ->
    // fake provider input/history evidence. It does NOT evaluate LLM decisions.
}
