//! Deployment adapter for the optional desktop bridge. Host/Core stay unaware
//! of Tauri. Owner comes from SessionToolFactory, never model parameters.
use std::{net::SocketAddr, time::Duration};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

pub(crate) const PLUGIN: &str = "@xharness/native-browser";
pub(crate) const SERVER: &str = "webview";

pub struct NativeBrowser {
    address: SocketAddr,
    token: String,
}
impl NativeBrowser {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::configuration(
            std::env::var("XHARNESS_NATIVE_BROWSER_ADDRESS").ok(),
            std::env::var("XHARNESS_NATIVE_BROWSER_TOKEN").ok(),
        )
    }
    fn configuration(
        address: Option<String>,
        token: Option<String>,
    ) -> Result<Option<Self>, String> {
        match (address, token) {
            (None, None) => Ok(None),
            (Some(address), Some(token)) => {
                let address: SocketAddr = address
                    .parse()
                    .map_err(|_| "invalid native browser address")?;
                if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                    || address.port() == 0
                    || token.len() != 64
                    || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err("invalid native browser configuration".into());
                }
                Ok(Some(Self { address, token }))
            }
            _ => Err("incomplete native browser configuration".into()),
        }
    }
    async fn request(
        &self,
        owner: &str,
        op: &str,
        arguments: Value,
        cancelled: &CancellationToken,
    ) -> Result<Value, String> {
        let timeout = if op == "control" && arguments["action"] == "open" {
            35
        } else {
            14
        };
        let call = async {
            let bytes = serde_json::to_vec(
                &json!({"token":self.token,"owner":owner,"op":op,"arguments":arguments}),
            )
            .map_err(|_| "invalid native browser request")?;
            if bytes.len() > 32 * 1024 {
                return Err("native browser request exceeds byte limit".into());
            }
            let mut stream = TcpStream::connect(self.address)
                .await
                .map_err(|_| "native browser bridge unavailable")?;
            stream
                .write_u32(bytes.len() as u32)
                .await
                .map_err(|_| "native browser write failed")?;
            stream
                .write_all(&bytes)
                .await
                .map_err(|_| "native browser write failed")?;
            let length = stream
                .read_u32()
                .await
                .map_err(|_| "native browser response unavailable")?
                as usize;
            if length == 0 || length > 64 * 1024 {
                return Err("invalid native browser reply length".into());
            }
            let mut reply = vec![0; length];
            stream
                .read_exact(&mut reply)
                .await
                .map_err(|_| "native browser reply interrupted")?;
            let reply: Value =
                serde_json::from_slice(&reply).map_err(|_| "invalid native browser reply")?;
            match reply.get("ok").and_then(Value::as_bool) {
                Some(true) => reply
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "missing native browser result".into()),
                Some(false) => Err(reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("native browser request denied")
                    .chars()
                    .take(500)
                    .collect()),
                None => Err("invalid native browser reply contract".into()),
            }
        };
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err("native browser call cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(timeout), call) => result.map_err(|_| "native browser callback timed out")?,
        }
    }
    pub(crate) async fn available(&self, owner: &str, cancelled: &CancellationToken) -> bool {
        self.request(owner, "list", json!({}), cancelled)
            .await
            .is_ok_and(|reply| reply["available"] == true)
    }
    pub(crate) async fn call(
        &self,
        owner: &str,
        tool: &str,
        arguments: Map<String, Value>,
        cancelled: &CancellationToken,
    ) -> Result<Value, String> {
        let op = match tool {
            "control" => "control",
            "observe" => "observe",
            "perform" => "perform",
            _ => return Err("unknown native browser tool".into()),
        };
        let result = match self.request(owner, op, Value::Object(arguments), cancelled).await {
            Ok(result) => result,
            Err(error) if op == "perform" || op == "control" => return Err(format!("native browser effect: unknown; {error}; do not replay automatically; observe actual state before deciding")),
            Err(error) => return Err(error),
        };
        // MCP result conventions remain authoritative for UI success/failure.
        Ok(
            json!({"isError":(op == "perform" && result.get("ok") != Some(&Value::Bool(true))) || result.get("ok") == Some(&Value::Bool(false)),"content":[{"type":"text","text":result.to_string()}]}),
        )
    }
}

pub(crate) fn tools() -> Vec<Value> {
    vec![
        json!({"name":"control","description":"Discover this desktop browser even with zero tabs (action=status), or open an HTTP(S) page from scratch (action=open,url). Open expands this chat's sidebar and waits for native load and binding, returning state=ready and the actual URL. Then observe, perform, and observe to verify. Requires this chat to be visible; a background chat never steals focus. Do not claim trusted native input, cross-origin iframe traversal, screenshot or recording: these capabilities are explicitly unsupported in status. No arbitrary script or tab/owner override.","inputSchema":{"oneOf":[
            {"type":"object","additionalProperties":false,"properties":{"action":{"const":"status"}},"required":["action"]},
            {"type":"object","additionalProperties":false,"properties":{"action":{"const":"open"},"url":{"type":"string","maxLength":4096}},"required":["action","url"]}
        ]}}),
        json!({"name":"observe","description":"Read the visible native tab bound to this chat; choose observe to inspect, then perform for an action when the task needs it. Bounded untrusted DOM evidence and one-shot refs; no OS input or screenshots. Page/main/dialog scopes; Follow next_text_offset, next_node_offset and per-select next_option_offset when non-null.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"scope":{"type":"string","enum":["page","main","dialog"]},"text_offset":{"type":"integer","minimum":0,"maximum":1000000},"node_offset":{"type":"integer","minimum":0,"maximum":1000000},"option_offset":{"type":"integer","minimum":0,"maximum":1000000}}}}),
        json!({"name":"perform","description":"One DOM click/fill/select/scroll with the latest observed frame_id. Frame consumed even if callback is lost. Unknown effect requires observing before any retry. Applied is not task success. No script, selector, arbitrary tab, credentials or native OS input.","inputSchema":{"oneOf":[
            action_schema("click", json!({"ref":{"type":"string"}}), vec!["ref"]),
            action_schema("fill", json!({"ref":{"type":"string"},"text":{"type":"string","maxLength":16000}}), vec!["ref","text"]),
            action_schema("select", json!({"ref":{"type":"string"},"value":{"type":"string","maxLength":500}}), vec!["ref","value"]),
            action_schema("scroll", json!({"delta_y":{"type":"integer","minimum":-5000,"maximum":5000}}), vec!["delta_y"])
        ]}}),
    ]
}
fn action_schema(action: &str, extra: Value, mut required: Vec<&str>) -> Value {
    let mut properties = extra.as_object().unwrap().clone();
    properties.insert("action".into(), json!({"const":action}));
    properties.insert(
        "frame_id".into(),
        json!({"type":"string","pattern":"^[0-9a-fA-F]{32}$"}),
    );
    required.extend(["action", "frame_id"]);
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_never_accepts_external_targets_or_incomplete_credentials() {
        assert!(NativeBrowser::configuration(None, None).unwrap().is_none());
        for addr in [
            "0.0.0.0:1234",
            "[::1]:1234",
            "192.168.2.1:1234",
            "127.0.0.1:0",
        ] {
            assert!(NativeBrowser::configuration(Some(addr.into()), Some("a".repeat(64))).is_err());
        }
        assert!(NativeBrowser::configuration(Some("127.0.0.1:1234".into()), None).is_err());
        assert!(
            NativeBrowser::configuration(Some("127.0.0.1:1234".into()), Some("a".repeat(64)))
                .unwrap()
                .is_some()
        );
        assert!(!tools()
            .iter()
            .any(|tool| tool.to_string().contains("token")));
    }
    #[tokio::test]
    async fn zero_tab_discovery_and_control_use_same_private_bridge_and_frozen_owner() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let browser = NativeBrowser {
            address: listener.local_addr().unwrap(),
            token: "a".repeat(64),
        };
        let server = tokio::spawn(async move {
            for op in ["list", "control"] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let length = stream.read_u32().await.unwrap() as usize;
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["owner"], "chat-owner");
                assert_eq!(request["op"], op);
                if op == "control" {
                    assert_eq!(request["arguments"]["action"], "open");
                }
                let result = if op == "list" {
                    json!({"available":true,"bound":false})
                } else {
                    json!({"ok":true,"state":"ready","effect":"applied","tab_id":"browser:actual","url":"https://example.com/"})
                };
                let reply = serde_json::to_vec(&json!({"ok":true,"result":result})).unwrap();
                stream.write_u32(reply.len() as u32).await.unwrap();
                stream.write_all(&reply).await.unwrap();
            }
        });
        assert!(
            browser
                .available("chat-owner", &CancellationToken::new())
                .await
        );
        let parameters = json!({"action":"open","url":"https://example.com/"})
            .as_object()
            .unwrap()
            .clone();
        let result = browser
            .call(
                "chat-owner",
                "control",
                parameters,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["isError"], false);
        let receipt: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(receipt["state"], "ready");
        server.await.unwrap();
        assert!(tools().iter().any(|tool| tool["name"] == "control"));
    }

    #[tokio::test]
    async fn predispatch_rejection_preserves_not_started_and_tool_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let browser = NativeBrowser {
            address: listener.local_addr().unwrap(),
            token: "a".repeat(64),
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let length = stream.read_u32().await.unwrap() as usize;
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes).await.unwrap();
            let reply = serde_json::to_vec(&json!({"ok":true,"result":{"ok":false,"effect":"not_started","message":"invalid native action arguments"}})).unwrap();
            stream.write_u32(reply.len() as u32).await.unwrap();
            stream.write_all(&reply).await.unwrap();
        });
        let result = browser
            .call("owner", "perform", Map::new(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result["isError"], true);
        let receipt: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(receipt["effect"], "not_started");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn cancelled_action_has_unknown_effect_and_never_connects() {
        let browser =
            NativeBrowser::configuration(Some("127.0.0.1:1".into()), Some("a".repeat(64)))
                .unwrap()
                .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(browser
            .call("owner", "perform", Map::new(), &cancel)
            .await
            .unwrap_err()
            .contains("effect: unknown"));
        assert!(!browser.available("owner", &cancel).await);
    }
    #[tokio::test]
    async fn actual_framed_transport_captures_owner_and_rejects_oversize_reply() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let browser = NativeBrowser::configuration(
            Some(listener.local_addr().unwrap().to_string()),
            Some("a".repeat(64)),
        )
        .unwrap()
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let length = stream.read_u32().await.unwrap() as usize;
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["owner"], "captured-session");
            assert_eq!(
                request["arguments"]["owner"],
                "model-cannot-override-session"
            );
            stream.write_u32(65537).await.unwrap();
        });
        let error = browser
            .call(
                "captured-session",
                "perform",
                json!({"owner":"model-cannot-override-session"})
                    .as_object()
                    .unwrap()
                    .clone(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.contains("effect: unknown"));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn one_lazy_tool_uses_captured_owner_and_projects_uncertain_effect_as_failure() {
        use std::sync::Arc;
        use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let browser = Arc::new(NativeBrowser {
            address: listener.local_addr().unwrap(),
            token: "a".repeat(64),
        });
        let server = tokio::spawn(async move {
            for index in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let length = stream.read_u32().await.unwrap() as usize;
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["owner"], "session-from-runtime");
                assert_eq!(request["token"], "a".repeat(64));
                let result = match index {
                    0 | 1 => {
                        assert_eq!(request["op"], "list");
                        json!({"available":true})
                    }
                    2 => {
                        assert_eq!(request["op"], "observe");
                        json!({"text":"fixture state", "source":{"untrusted":true}})
                    }
                    _ => {
                        assert_eq!(request["op"], "perform");
                        json!({"ok":false,"effect":"unknown","message":"callback lost"})
                    }
                };
                let reply = serde_json::to_vec(&json!({"ok":true,"result":result})).unwrap();
                stream.write_u32(reply.len() as u32).await.unwrap();
                stream.write_all(&reply).await.unwrap();
            }
        });
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(
                crate::plugin_mcp::spec(
                    None,
                    xharness_mcp::McpRuntime::new(),
                    Some(browser),
                    "session-from-runtime".into(),
                )
                .requiring_approval(false),
            )
            .await
            .unwrap();
        let executor = ToolExecutor::new(registry);
        let list = executor
            .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
            .await;
        assert!(list.is_ok());
        assert!(list.output.unwrap().content.contains(PLUGIN));
        let describe = executor
            .execute(ToolRequest::new(
                "plugin_mcp",
                json!({"action":"describe","plugin":PLUGIN,"server":SERVER,"tool":"observe"})
                    .to_string(),
            ))
            .await;
        let schema = describe.output.unwrap().content;
        assert!(schema.contains("inputSchema"));
        assert!(!schema.contains(&"a".repeat(64)));
        let observe = executor.execute(ToolRequest::new("plugin_mcp", json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"observe","owner":"ignored-model-owner","arguments":{}}).to_string())).await;
        assert!(observe.is_ok());
        assert!(observe.output.unwrap().content.contains("fixture state"));
        let invalid = executor.execute(ToolRequest::new("plugin_mcp", json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"perform","arguments":["click"]}).to_string())).await;
        assert!(!invalid.is_ok());
        assert_eq!(
            invalid.failure.unwrap().kind,
            xharness_tools::ToolFailureKind::InvalidArguments
        );
        let perform = executor.execute(ToolRequest::new("plugin_mcp", json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"perform","arguments":{"action":"click"}}).to_string())).await;
        assert!(!perform.is_ok());
        let failure = perform.failure.unwrap();
        assert!(!failure.retryable);
        assert!(failure.message.contains("unknown"));
        server.await.unwrap();
    }
}
