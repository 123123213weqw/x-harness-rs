//! Fixed native tools carry their argument schemas in every model request.
//! Dynamic foreign MCP tools remain lazy and keep their separate namespace.
#![forbid(unsafe_code)]

use crate::native_browser::{self, NativeBrowser};
use serde_json::{Map, Value};
use std::sync::Arc;
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

pub(super) fn is_direct(name: &str) -> bool {
    matches!(
        name,
        "browser_control"
            | "browser_observe"
            | "browser_perform"
            | "browser_input"
            | "browser_screenshot"
            | "browser_request"
            | "browser_read_response"
    )
}

pub(super) async fn invoke(
    native: &NativeBrowser,
    headless: bool,
    owner: &str,
    tool: &str,
    parameters: Map<String, Value>,
    media: Option<&Arc<dyn xharness_computer::ComputerMediaSink>>,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ToolOutput, ToolHandlerError> {
    super::contract::validate_native(headless, tool, &Value::Object(parameters.clone()))?;
    if tool == "screenshot" {
        let media = media.ok_or_else(|| super::error("browser attachment service unavailable"))?;
        return native
            .screenshot(owner, parameters, media.as_ref(), cancellation)
            .await;
    }
    super::call_output(
        native
            .call(owner, tool, parameters, cancellation)
            .await
            .map_err(super::error)?,
    )
}

pub(super) fn specs(
    native: Arc<NativeBrowser>,
    owner: String,
    media: Option<Arc<dyn xharness_computer::ComputerMediaSink>>,
) -> Vec<ToolSpec> {
    native_browser::tools()
        .into_iter()
        .map(|d| {
            let tool = d["name"].as_str().unwrap_or_default().to_owned();
            let webview_only = matches!(tool.as_str(), "request" | "read_response");
            let description = if webview_only {
                d["description"].as_str().unwrap_or_default().to_owned()
            } else {
                native_browser::headless_tools()
                    .iter()
                    .find(|t| t["name"] == tool)
                    .and_then(|t| t["description"].as_str())
                    .unwrap_or_default()
                    .to_owned()
            };
            let definition = ToolDefinition::new(
                format!("browser_{tool}"),
                format!("Typed native browser tool; no discovery required. {description}"),
                super::contract::direct_schema(&d["inputSchema"], webview_only),
            );
            let native = native.clone();
            let owner = owner.clone();
            let media = media.clone();
            ToolSpec::new(definition, move |context| {
                let native = native.clone();
                let owner = owner.clone();
                let media = media.clone();
                let tool = tool.clone();
                async move {
                    let mut parameters = context
                        .arguments
                        .as_object()
                        .cloned()
                        .ok_or_else(|| super::error("browser arguments must be an object"))?;
                    let backend = parameters
                        .remove("backend")
                        .ok_or_else(|| super::error("browser backend required"))?;
                    let headless = match backend.as_str() {
                        Some(native_browser::HEADLESS_SERVER) if !webview_only => true,
                        Some(native_browser::SERVER) => false,
                        _ => {
                            return Err(super::error(
                                "invalid browser backend; no backend was selected or changed",
                            ))
                        }
                    };
                    let background = native.headless();
                    let selected = if headless {
                        &background
                    } else {
                        native.as_ref()
                    };
                    invoke(
                        selected,
                        headless,
                        &owner,
                        &tool,
                        parameters,
                        media.as_ref(),
                        &context.cancellation,
                    )
                    .await
                }
            })
            .with_timeout(std::time::Duration::from_secs(45))
        })
        .collect()
}
