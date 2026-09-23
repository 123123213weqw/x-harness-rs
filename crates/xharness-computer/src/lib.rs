//! Provider-neutral Computer Use contract.
//!
//! The model sees one `computer` tool. Platform adapters implement the
//! physical operations, while the Host owns image persistence and projection.
//! This keeps provider schemas, macOS APIs and attachment storage independent.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_tools::{
    ToolConcurrency, ToolDefinition, ToolExecutionContext, ToolHandlerError, ToolOutput, ToolSpec,
};

pub const COMPUTER_TOOL_NAME: &str = "computer";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    Observe,
    Move,
    Click,
    Drag,
    Scroll,
    Type,
    Keypress,
    Wait,
    Window,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObserveAfter {
    Never,
    #[default]
    Auto,
    Always,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComputerRequest {
    pub action: ComputerAction,
    #[serde(default)]
    pub surface_id: Option<String>,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub button: MouseButton,
    #[serde(default = "default_click_count")]
    pub count: u8,
    #[serde(default)]
    pub modifiers: Vec<String>,
    #[serde(default)]
    pub path: Vec<Point>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub delta_x: Option<i32>,
    #[serde(default)]
    pub delta_y: Option<i32>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub region: Option<Region>,
    #[serde(default)]
    pub include_screenshot: Option<bool>,
    #[serde(default = "default_true")]
    pub include_accessibility: bool,
    #[serde(default)]
    pub observe_after: ObserveAfter,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

fn default_click_count() -> u8 {
    1
}

fn default_true() -> bool {
    true
}

impl ComputerRequest {
    pub fn validate(&self) -> Result<(), ComputerError> {
        let point = || {
            if self.node_id.is_none() && (self.x.is_none() || self.y.is_none()) {
                Err(ComputerError::invalid(
                    "action requires node_id or both x and y",
                ))
            } else {
                Ok(())
            }
        };
        if self.node_id.is_some() && self.frame_id.is_none() {
            return Err(ComputerError::invalid(
                "node_id requires the frame_id returned by observe",
            ));
        }
        match self.action {
            ComputerAction::Observe => {
                if let Some(region) = self.region {
                    if !region.x.is_finite()
                        || !region.y.is_finite()
                        || !region.width.is_finite()
                        || !region.height.is_finite()
                        || region.width <= 0.0
                        || region.height <= 0.0
                    {
                        return Err(ComputerError::invalid(
                            "region must contain finite positive width and height",
                        ));
                    }
                }
                if let Some(detail) = &self.detail {
                    if !matches!(detail.as_str(), "auto" | "low" | "high" | "semantic") {
                        return Err(ComputerError::invalid(
                            "detail must be auto, low, high, or semantic",
                        ));
                    }
                }
            }
            ComputerAction::Move | ComputerAction::Click => {
                point()?;
                if self.frame_id.is_none() {
                    return Err(ComputerError::invalid(
                        "pointer actions require the frame_id returned by observe",
                    ));
                }
            }
            ComputerAction::Drag => {
                if self.frame_id.is_none() {
                    return Err(ComputerError::invalid(
                        "drag requires the frame_id returned by observe",
                    ));
                }
                if self.path.len() < 2 {
                    return Err(ComputerError::invalid(
                        "drag requires a path containing at least two points",
                    ));
                }
                if self
                    .path
                    .iter()
                    .any(|point| !point.x.is_finite() || !point.y.is_finite())
                {
                    return Err(ComputerError::invalid("drag path must be finite"));
                }
            }
            ComputerAction::Scroll => {
                if self.delta_x.unwrap_or(0) == 0 && self.delta_y.unwrap_or(0) == 0 {
                    return Err(ComputerError::invalid(
                        "scroll requires non-zero delta_x or delta_y",
                    ));
                }
                if (self.x.is_some() || self.y.is_some()) && self.frame_id.is_none() {
                    return Err(ComputerError::invalid(
                        "positioned scroll requires the frame_id returned by observe",
                    ));
                }
            }
            ComputerAction::Type => {
                if self.text.is_none() {
                    return Err(ComputerError::invalid("type requires text"));
                }
            }
            ComputerAction::Keypress => {
                if self.keys.is_empty() {
                    return Err(ComputerError::invalid("keypress requires non-empty keys"));
                }
            }
            ComputerAction::Wait => {
                let duration = self.duration_ms.unwrap_or(1_000);
                if duration == 0 || duration > 30_000 {
                    return Err(ComputerError::invalid(
                        "wait duration_ms must be between 1 and 30000",
                    ));
                }
            }
            ComputerAction::Window => {
                let operation = self
                    .operation
                    .as_deref()
                    .ok_or_else(|| ComputerError::invalid("window requires operation"))?;
                if !matches!(
                    operation,
                    "list"
                        | "focus"
                        | "move"
                        | "resize"
                        | "minimize"
                        | "maximize"
                        | "fullscreen"
                        | "close"
                ) {
                    return Err(ComputerError::invalid("unsupported window operation"));
                }
                if operation != "list" && self.surface_id.is_none() {
                    return Err(ComputerError::invalid(
                        "window operation requires surface_id",
                    ));
                }
                if operation == "move" && (self.x.is_none() || self.y.is_none()) {
                    return Err(ComputerError::invalid("window move requires x and y"));
                }
                if operation == "resize" && (self.width.is_none() || self.height.is_none()) {
                    return Err(ComputerError::invalid(
                        "window resize requires width and height",
                    ));
                }
            }
        }
        if !(1..=3).contains(&self.count) {
            return Err(ComputerError::invalid(
                "click count must be between 1 and 3",
            ));
        }
        Ok(())
    }

    pub fn wants_observation_after(&self) -> bool {
        match self.observe_after {
            ObserveAfter::Always => true,
            ObserveAfter::Never => false,
            ObserveAfter::Auto => matches!(
                self.action,
                ComputerAction::Click
                    | ComputerAction::Drag
                    | ComputerAction::Scroll
                    | ComputerAction::Type
                    | ComputerAction::Keypress
                    | ComputerAction::Window
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComputerOutput {
    pub value: Value,
    pub screenshot: Option<Screenshot>,
}

impl ComputerOutput {
    pub fn value(value: Value) -> Self {
        Self {
            value,
            screenshot: None,
        }
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct ComputerError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ComputerError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_request".into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable".into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
        }
    }
}

#[async_trait]
pub trait ComputerDriver: Send + Sync {
    async fn execute(
        &self,
        request: ComputerRequest,
        cancellation: CancellationToken,
    ) -> Result<ComputerOutput, ComputerError>;
}

#[async_trait]
pub trait ComputerMediaSink: Send + Sync {
    async fn supports_images(&self) -> bool;

    async fn project_png(
        &self,
        summary: String,
        screenshot: Screenshot,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolHandlerError>;
}

pub struct ComputerTool {
    driver: Arc<dyn ComputerDriver>,
    media: Option<Arc<dyn ComputerMediaSink>>,
}

impl ComputerTool {
    pub fn new(driver: Arc<dyn ComputerDriver>) -> Self {
        Self {
            driver,
            media: None,
        }
    }

    pub fn with_media_sink(mut self, sink: Arc<dyn ComputerMediaSink>) -> Self {
        self.media = Some(sink);
        self
    }

    pub fn spec(self) -> ToolSpec {
        let driver = self.driver;
        let media = self.media;
        ToolSpec::new(definition(), move |context: ToolExecutionContext| {
            let driver = Arc::clone(&driver);
            let media = media.clone();
            async move {
                validate_argument_shape(context.arguments.as_ref())?;
                let mut request: ComputerRequest = serde_json::from_value((*context.arguments).clone())
                    .map_err(|error| ToolHandlerError::new(format!("invalid computer arguments: {error}")))?;
                request
                    .validate()
                    .map_err(|error| ToolHandlerError::new(format!("{}: {}", error.code, error.message)))?;
                let supports_images = match &media {
                    Some(media) => media.supports_images().await,
                    None => false,
                };
                match request.include_screenshot {
                    Some(true) if !supports_images => {
                        return Err(ToolHandlerError::new(
                            "current model does not declare image input; use detail=semantic or switch to a vision model",
                        ));
                    }
                    None => {
                        request.include_screenshot = Some(
                            supports_images && request.detail.as_deref() != Some("semantic"),
                        )
                    }
                    _ => {}
                }
                let output = driver
                    .execute(request, context.cancellation.clone())
                    .await
                    .map_err(|error| ToolHandlerError {
                        message: format!("{}: {}", error.code, error.message),
                        retryable: error.retryable,
                    })?;
                let summary = serde_json::to_string(&output.value)
                    .map_err(|error| ToolHandlerError::new(error.to_string()))?;
                match (output.screenshot, media) {
                    (Some(screenshot), Some(media)) => {
                        media.project_png(summary, screenshot, context.cancellation).await
                    }
                    (Some(_), None) => Err(ToolHandlerError::new(
                        "computer screenshot produced without an attachment sink",
                    )),
                    (None, _) => Ok(ToolOutput::text(summary)),
                }
            }
        })
        .with_timeout(Duration::from_secs(60))
        .with_concurrency(ToolConcurrency::Exclusive)
    }
}

fn validate_argument_shape(value: &Value) -> Result<(), ToolHandlerError> {
    let object = value
        .as_object()
        .ok_or_else(|| ToolHandlerError::new("computer arguments must be an object"))?;
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolHandlerError::new("computer action must be a string"))?;
    let action_fields: &[&str] = match action {
        "observe" => &[],
        "move" => &["x", "y", "node_id", "frame_id", "modifiers"],
        "click" => &[
            "x",
            "y",
            "node_id",
            "frame_id",
            "button",
            "count",
            "modifiers",
        ],
        "drag" => &["frame_id", "path", "button", "duration_ms", "modifiers"],
        "scroll" => &[
            "frame_id",
            "node_id",
            "x",
            "y",
            "delta_x",
            "delta_y",
            "modifiers",
        ],
        "type" => &["text", "node_id", "frame_id"],
        "keypress" => &["keys", "modifiers"],
        "wait" => &["duration_ms"],
        "window" => &["surface_id", "operation", "x", "y", "width", "height"],
        _ => return Ok(()), // The registry's enum validation reports this case.
    };
    const OBSERVATION_FIELDS: &[&str] = &[
        "detail",
        "region",
        "include_screenshot",
        "include_accessibility",
        "observe_after",
    ];
    for key in object.keys().map(String::as_str) {
        if key != "action" && !action_fields.contains(&key) && !OBSERVATION_FIELDS.contains(&key) {
            return Err(ToolHandlerError::new(format!(
                "field {key:?} is not valid for computer action {action:?}"
            )));
        }
    }
    Ok(())
}

pub fn definition() -> ToolDefinition {
    ToolDefinition::new(
        COMPUTER_TOOL_NAME,
        "Observe and operate the local macOS desktop. Use observe before coordinate or node actions and reuse its frame_id. Coordinates are logical desktop points. Prefer node_id for click, scroll, and type when available. Actions are serialized; do not issue overlapping computer calls. detail=semantic returns the accessibility tree without a screenshot; other observations return screenshots only for vision-capable models.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "action": {"type":"string","enum":["observe","move","click","drag","scroll","type","keypress","wait","window"]},
                "surface_id": {"type":"string"},
                "frame_id": {"type":"string"},
                "node_id": {"type":"string"},
                "x": {"type":"number"}, "y": {"type":"number"},
                "button": {"type":"string","enum":["left","right","middle"]},
                "count": {"type":"integer"},
                "modifiers": {"type":"array","items":{"type":"string"}},
                "path": {"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"x":{"type":"number"},"y":{"type":"number"}},"required":["x","y"]}},
                "duration_ms": {"type":"integer"},
                "text": {"type":"string"},
                "keys": {"type":"array","items":{"type":"string"}},
                "delta_x": {"type":"integer"}, "delta_y": {"type":"integer"},
                "detail": {"type":"string","enum":["auto","low","high","semantic"]},
                "region": {"type":"object","additionalProperties":false,"properties":{"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"}},"required":["x","y","width","height"]},
                "include_screenshot": {"type":"boolean"},
                "include_accessibility": {"type":"boolean"},
                "observe_after": {"type":"string","enum":["never","auto","always"]},
                "operation": {"type":"string","enum":["list","focus","move","resize","minimize","maximize","fullscreen","close"]},
                "width": {"type":"number"}, "height": {"type":"number"}
            },
            "required": ["action"]
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    #[derive(Default)]
    struct FakeDriver(Mutex<Vec<ComputerRequest>>);

    #[async_trait]
    impl ComputerDriver for FakeDriver {
        async fn execute(
            &self,
            request: ComputerRequest,
            _: CancellationToken,
        ) -> Result<ComputerOutput, ComputerError> {
            self.0.lock().unwrap().push(request.clone());
            Ok(ComputerOutput::value(
                json!({"action":request.action,"ok":true}),
            ))
        }
    }

    async fn execute(arguments: &str) -> xharness_tools::ToolResult {
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(ComputerTool::new(Arc::new(FakeDriver::default())).spec())
            .await
            .unwrap();
        ToolExecutor::new(registry)
            .execute(
                ToolRequest::new(COMPUTER_TOOL_NAME, arguments)
                    .with_execution_id("computer-test")
                    .unwrap(),
            )
            .await
    }

    #[tokio::test]
    async fn one_tool_covers_the_complete_action_surface() {
        let definition = definition();
        assert_eq!(definition.name, "computer");
        assert_eq!(
            definition.parameters["properties"]["action"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            9
        );
        xharness_tools::validate_tool_schema(&definition.parameters).unwrap();
    }

    #[tokio::test]
    async fn action_specific_validation_fails_before_driver() {
        let result = execute(r#"{"action":"drag","frame_id":"f","path":[{"x":1,"y":2}]}"#).await;
        assert!(!result.is_ok());
        assert!(result.failure.unwrap().message.contains("at least two"));

        let result = execute(r#"{"action":"click","node_id":"n"}"#).await;
        assert!(!result.is_ok());
        assert!(result.failure.unwrap().message.contains("frame_id"));
    }

    #[tokio::test]
    async fn semantic_observe_works_without_vision_sink() {
        let result = execute(r#"{"action":"observe","detail":"semantic"}"#).await;
        assert!(result.is_ok(), "{:?}", result.failure);
        assert!(result.output.unwrap().content.contains("observe"));
    }

    #[tokio::test]
    async fn every_action_has_a_valid_minimal_request() {
        for request in [
            r#"{"action":"observe","detail":"semantic"}"#,
            r#"{"action":"move","frame_id":"f","x":1,"y":2}"#,
            r#"{"action":"click","frame_id":"f","x":1,"y":2,"button":"right","count":2}"#,
            r#"{"action":"drag","frame_id":"f","path":[{"x":1,"y":2},{"x":3,"y":4}]}"#,
            r#"{"action":"scroll","delta_y":120}"#,
            r#"{"action":"scroll","frame_id":"f","node_id":"n","delta_y":120}"#,
            r#"{"action":"type","text":"hello 世界"}"#,
            r#"{"action":"type","frame_id":"f","node_id":"n","text":"semantic input"}"#,
            r#"{"action":"keypress","keys":["CMD","L"]}"#,
            r#"{"action":"wait","duration_ms":1}"#,
            r#"{"action":"window","operation":"list"}"#,
        ] {
            let result = execute(request).await;
            assert!(
                result.is_ok(),
                "request={request}, failure={:?}",
                result.failure
            );
        }
    }

    #[tokio::test]
    async fn fields_from_another_action_fail_before_side_effects() {
        let result = execute(r#"{"action":"type","text":"safe","x":1,"y":2}"#).await;
        assert!(!result.is_ok());
        assert!(result.failure.unwrap().message.contains("not valid"));
    }

    #[tokio::test]
    async fn semantic_type_still_requires_the_observation_frame() {
        let result = execute(r#"{"action":"type","node_id":"n","text":"safe"}"#).await;
        assert!(!result.is_ok());
        assert!(result.failure.unwrap().message.contains("frame_id"));
    }
}
