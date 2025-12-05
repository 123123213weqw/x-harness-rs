use std::{
    collections::HashMap,
    fmt,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{header, Client, Response};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    ModelProvider, ProviderError, ProviderEvent, ProviderInputTokenCount, ProviderRequest,
    ProviderStream,
};
use xharness_debug::{DebugEvent, DebugRecorder, DebugScope};

use crate::{
    build_openai_request, build_openai_token_count_request, OpenAiProtocol, OpenAiStreamNormalizer,
    SseParser, DEFAULT_SSE_EVENT_LIMIT_BYTES, DEFAULT_SSE_PENDING_LIMIT_BYTES,
};

pub const DEFAULT_ERROR_BODY_LIMIT_BYTES: usize = 4 * 1024;
const TOKEN_COUNT_UNKNOWN: u8 = 0;
const TOKEN_COUNT_SUPPORTED: u8 = 1;
const TOKEN_COUNT_UNSUPPORTED: u8 = 2;

const RESERVED_REASONING_PATCH_KEYS: &[&str] = &[
    "model",
    "messages",
    "input",
    "tools",
    "stream",
    "stream_options",
    "store",
    "max_tokens",
    "max_output_tokens",
];

/// Adapter-owned mapping from public reasoning effort ids to OpenAI-compatible
/// request fragments. The Host and browser treat effort ids as opaque; only
/// this adapter knows whether an id becomes `reasoning_effort`,
/// `chat_template_kwargs`, or another endpoint-specific extension.
#[derive(Clone, Debug)]
pub struct OpenAiReasoningProfile {
    default_effort: Option<String>,
    patches: HashMap<String, Map<String, Value>>,
}

impl OpenAiReasoningProfile {
    pub fn new(
        default_effort: Option<String>,
        efforts: impl IntoIterator<Item = (String, Value)>,
    ) -> Result<Self, ProviderError> {
        let mut patches = HashMap::new();
        for (id, patch) in efforts {
            if id.trim().is_empty() {
                return Err(ProviderError::new(
                    "OpenAI reasoning effort id must not be empty",
                ));
            }
            let patch = patch.as_object().cloned().ok_or_else(|| {
                ProviderError::new(format!(
                    "OpenAI reasoning effort {id:?} request patch must be a JSON object"
                ))
            })?;
            if let Some(key) = patch
                .keys()
                .find(|key| RESERVED_REASONING_PATCH_KEYS.contains(&key.as_str()))
            {
                return Err(ProviderError::new(format!(
                    "OpenAI reasoning effort {id:?} request patch cannot override reserved field {key:?}"
                )));
            }
            if patches.insert(id.clone(), patch).is_some() {
                return Err(ProviderError::new(format!(
                    "OpenAI reasoning effort id {id:?} is declared more than once"
                )));
            }
        }
        if patches.is_empty() {
            return Err(ProviderError::new(
                "OpenAI reasoning profile must declare at least one effort",
            ));
        }
        if let Some(default_effort) = default_effort.as_deref() {
            if !patches.contains_key(default_effort) {
                return Err(ProviderError::new(format!(
                    "OpenAI default reasoning effort {default_effort:?} is not declared"
                )));
            }
        }
        Ok(Self {
            default_effort,
            patches,
        })
    }

    pub fn default_effort(&self) -> Option<&str> {
        self.default_effort.as_deref()
    }

    fn apply(&self, requested: Option<&str>, body: &mut Value) -> Result<(), ProviderError> {
        let Some(effort) = requested.or(self.default_effort()) else {
            return Ok(());
        };
        let patch = self.patches.get(effort).ok_or_else(|| {
            ProviderError::new(format!(
                "unsupported reasoning effort {effort:?} for this model"
            ))
        })?;
        let root = body.as_object_mut().ok_or_else(|| {
            ProviderError::new("OpenAI request encoder produced a non-object body")
        })?;
        root.extend(patch.clone());
        Ok(())
    }
}

#[derive(Clone)]
pub struct OpenAiProviderConfig {
    pub protocol: OpenAiProtocol,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub max_sse_pending_bytes: usize,
    pub max_sse_event_bytes: usize,
    pub max_error_body_bytes: usize,
    pub reasoning: Option<OpenAiReasoningProfile>,
}

impl OpenAiProviderConfig {
    pub fn new(
        protocol: OpenAiProtocol,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            protocol,
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            connect_timeout: Duration::from_secs(30),
            request_timeout: Duration::from_secs(600),
            max_sse_pending_bytes: DEFAULT_SSE_PENDING_LIMIT_BYTES,
            max_sse_event_bytes: DEFAULT_SSE_EVENT_LIMIT_BYTES,
            max_error_body_bytes: DEFAULT_ERROR_BODY_LIMIT_BYTES,
            reasoning: None,
        }
    }

    pub fn with_reasoning_profile(mut self, reasoning: OpenAiReasoningProfile) -> Self {
        self.reasoning = Some(reasoning);
        self
    }

    fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        match self.protocol {
            OpenAiProtocol::ChatCompletions => format!("{base}/chat/completions"),
            OpenAiProtocol::Responses => format!("{base}/responses"),
        }
    }

    fn token_count_endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        match self.protocol {
            OpenAiProtocol::ChatCompletions => {
                format!("{base}/chat/completions/input_tokens")
            }
            OpenAiProtocol::Responses => format!("{base}/responses/input_tokens"),
        }
    }

    fn token_counter_id(&self) -> &'static str {
        match self.protocol {
            OpenAiProtocol::ChatCompletions => "openai-compatible/chat-input-tokens/v1",
            OpenAiProtocol::Responses => "openai/responses-input-tokens/v1",
        }
    }
}

impl fmt::Debug for OpenAiProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiProviderConfig")
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("model", &self.model)
            .field("connect_timeout", &self.connect_timeout)
            .field("request_timeout", &self.request_timeout)
            .field("max_sse_pending_bytes", &self.max_sse_pending_bytes)
            .field("max_sse_event_bytes", &self.max_sse_event_bytes)
            .field("max_error_body_bytes", &self.max_error_body_bytes)
            .field(
                "reasoning_efforts",
                &self.reasoning.as_ref().map(|profile| profile.patches.len()),
            )
            .finish()
    }
}

#[derive(Clone)]
pub struct OpenAiProvider {
    config: Arc<OpenAiProviderConfig>,
    client: Client,
    token_count_support: Arc<AtomicU8>,
    debug: DebugRecorder,
}

impl OpenAiProvider {
    pub fn new(config: OpenAiProviderConfig) -> Result<Self, ProviderError> {
        if config.max_sse_pending_bytes == 0 {
            return Err(ProviderError::new(
                "max_sse_pending_bytes must be greater than zero",
            ));
        }
        if config.max_sse_event_bytes == 0 {
            return Err(ProviderError::new(
                "max_sse_event_bytes must be greater than zero",
            ));
        }
        if config.max_error_body_bytes == 0 {
            return Err(ProviderError::new(
                "max_error_body_bytes must be greater than zero",
            ));
        }
        let client = Client::builder()
            .connect_timeout(config.connect_timeout)
            .timeout(config.request_timeout)
            .build()
            .map_err(|error| ProviderError::new(format!("could not build HTTP client: {error}")))?;
        Ok(Self {
            config: Arc::new(config),
            client,
            token_count_support: Arc::new(AtomicU8::new(TOKEN_COUNT_UNKNOWN)),
            debug: DebugRecorder::disabled(),
        })
    }

    pub fn with_debug(mut self, debug: DebugRecorder) -> Self {
        self.debug = debug;
        self
    }

    pub fn config(&self) -> &OpenAiProviderConfig {
        &self.config
    }

    fn request_body(
        &self,
        request: &ProviderRequest,
        token_count: bool,
    ) -> Result<Value, ProviderError> {
        let mut body = if token_count {
            build_openai_token_count_request(self.config.protocol, &self.config.model, request)
        } else {
            build_openai_request(self.config.protocol, &self.config.model, request)
        };
        match &self.config.reasoning {
            Some(profile) => profile.apply(request.reasoning_effort.as_deref(), &mut body)?,
            None if request.reasoning_effort.is_some() => {
                return Err(ProviderError::new(
                    "reasoning effort was selected for a model without a reasoning profile",
                ));
            }
            None => {}
        }
        Ok(body)
    }
}

#[async_trait]
impl ModelProvider for OpenAiProvider {
    fn provider_name(&self) -> &str {
        "openai-compatible"
    }

    fn model_name(&self) -> Option<&str> {
        Some(&self.config.model)
    }

    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        if self.token_count_support.load(Ordering::Acquire) == TOKEN_COUNT_UNSUPPORTED {
            return Ok(None);
        }
        let body = self.request_body(request, true)?;
        self.trace(
            &request.debug_scope,
            "token_count.request",
            json!({"endpoint": self.config.token_count_endpoint(), "body": &body}),
        )
        .await;
        let pending = self
            .client
            .post(self.config.token_count_endpoint())
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(ProviderError::new("OpenAI input token count cancelled"));
            }
            response = pending => response.map_err(|error| {
                ProviderError::retryable(format!("OpenAI input token count network error: {error}"))
            })?,
        };
        let status = response.status();
        self.trace(
            &request.debug_scope,
            "token_count.response_status",
            json!({"status": status.as_u16()}),
        )
        .await;
        if matches!(status.as_u16(), 404 | 405 | 501) {
            self.token_count_support
                .store(TOKEN_COUNT_UNSUPPORTED, Ordering::Release);
            return Ok(None);
        }
        if !status.is_success() {
            let code = status.as_u16();
            let body =
                bounded_error_body(response, self.config.max_error_body_bytes, &cancellation)
                    .await?;
            let detail = if body.is_empty() {
                format!("OpenAI input token count HTTP {code}")
            } else {
                format!("OpenAI input token count HTTP {code}: {body}")
            };
            return Err(ProviderError::http(code, detail));
        }
        let body =
            bounded_error_body(response, self.config.max_error_body_bytes, &cancellation).await?;
        self.trace(
            &request.debug_scope,
            "token_count.response_body",
            json!({"body": &body}),
        )
        .await;
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
            ProviderError::new(format!(
                "invalid OpenAI input token count response: {error}"
            ))
        })?;
        let input_tokens = value
            .get("input_tokens")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                ProviderError::new(
                    "invalid OpenAI input token count response: missing input_tokens",
                )
            })?;
        self.token_count_support
            .store(TOKEN_COUNT_SUPPORTED, Ordering::Release);
        Ok(Some(ProviderInputTokenCount::exact_request(
            self.config.token_counter_id(),
            input_tokens,
        )))
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let body = self.request_body(&request, false)?;
        self.trace(
            &request.debug_scope,
            "request",
            json!({
                "endpoint": self.config.endpoint(),
                "protocol": format!("{:?}", self.config.protocol),
                "body": &body,
            }),
        )
        .await;
        let pending = self
            .client
            .post(self.config.endpoint())
            .header(header::ACCEPT, "text/event-stream")
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(ProviderError::new("OpenAI request cancelled"));
            }
            response = pending => response.map_err(|error| {
                ProviderError::retryable(format!("OpenAI network error: {error}"))
            })?,
        };

        let status = response.status();
        self.trace(
            &request.debug_scope,
            "response_status",
            json!({"status": status.as_u16()}),
        )
        .await;
        if !status.is_success() {
            let code = status.as_u16();
            let body =
                bounded_error_body(response, self.config.max_error_body_bytes, &cancellation)
                    .await?;
            self.trace(
                &request.debug_scope,
                "response_error",
                json!({"status": code, "body": &body}),
            )
            .await;
            let detail = if body.is_empty() {
                format!("OpenAI HTTP {code}")
            } else {
                format!("OpenAI HTTP {code}: {body}")
            };
            return Err(ProviderError::http(code, detail));
        }

        let protocol = self.config.protocol;
        let max_sse_pending_bytes = self.config.max_sse_pending_bytes;
        let max_sse_event_bytes = self.config.max_sse_event_bytes;
        let debug = self.debug.clone();
        let debug_scope = request.debug_scope.clone();
        let output = async_stream::stream! {
            let mut bytes = response.bytes_stream();
            let mut parser = SseParser::with_limits(max_sse_pending_bytes, max_sse_event_bytes);
            let mut normalizer = OpenAiStreamNormalizer::new(protocol);
            loop {
                let next = tokio::select! {
                    _ = cancellation.cancelled() => return,
                    next = bytes.next() => next,
                };
                match next {
                    Some(Ok(chunk)) => {
                        debug.record_lossy(DebugEvent::new(
                            "provider.openai",
                            "sse.chunk",
                            json!({
                                "bytes": chunk.len(),
                                "content": String::from_utf8_lossy(&chunk),
                            }),
                        ).with_scope(debug_scope.clone())).await;
                        match parser.feed_bytes(chunk, false) {
                            Ok(events) => {
                                for event in events {
                                    match normalizer.consume(event) {
                                        Ok(provider_events) => {
                                            for provider_event in provider_events {
                                                debug.record_lossy(DebugEvent::new(
                                                    "provider.openai",
                                                    "stream.event",
                                                    provider_event_payload(&provider_event),
                                                ).with_scope(debug_scope.clone())).await;
                                                yield Ok(provider_event);
                                            }
                                        }
                                        Err(error) => {
                                            yield Err(error);
                                            return;
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                        }
                    }
                    Some(Err(error)) => {
                        yield Err(ProviderError::retryable(format!(
                            "OpenAI stream transport error: {error}"
                        )));
                        return;
                    }
                    None => break,
                }
            }

            match parser.feed([], true) {
                Ok(events) => {
                    for event in events {
                        match normalizer.consume(event) {
                            Ok(provider_events) => {
                                            for provider_event in provider_events {
                                                debug.record_lossy(DebugEvent::new(
                                                    "provider.openai",
                                                    "stream.event",
                                                    provider_event_payload(&provider_event),
                                                ).with_scope(debug_scope.clone())).await;
                                                yield Ok(provider_event);
                                }
                            }
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                        }
                    }
                }
                Err(error) => {
                    yield Err(error);
                    return;
                }
            }
            if let Err(error) = normalizer.finish() {
                yield Err(error);
            }
        };
        Ok(Box::pin(output))
    }
}

impl OpenAiProvider {
    async fn trace(&self, scope: &DebugScope, event: &str, payload: Value) {
        self.debug
            .record_lossy(
                DebugEvent::new("provider.openai", event, payload).with_scope(scope.clone()),
            )
            .await;
    }
}

fn provider_event_payload(event: &ProviderEvent) -> Value {
    match event {
        ProviderEvent::TextDelta(delta) => json!({"type": "text_delta", "delta": delta}),
        ProviderEvent::ReasoningDelta(delta) => {
            json!({"type": "reasoning_delta", "delta": delta})
        }
        ProviderEvent::ToolCallDelta {
            index,
            id,
            name,
            arguments_delta,
        } => json!({
            "type": "tool_call_delta",
            "index": index,
            "id": id,
            "name": name,
            "argumentsDelta": arguments_delta,
        }),
        ProviderEvent::Completed {
            finish_reason,
            usage,
            provider_items,
        } => json!({
            "type": "completed",
            "finishReason": finish_reason,
            "usage": usage,
            "providerItems": provider_items,
        }),
    }
}

async fn bounded_error_body(
    response: Response,
    max_bytes: usize,
    cancellation: &CancellationToken,
) -> Result<String, ProviderError> {
    let read_limit = max_bytes.saturating_add(1);
    let mut body = Vec::with_capacity(max_bytes.min(4096));
    let mut chunks = response.bytes_stream();
    let mut truncated = false;
    let mut read_failed = false;

    while body.len() < read_limit {
        let next = tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(ProviderError::new("OpenAI error response read cancelled"));
            }
            next = chunks.next() => next,
        };
        match next {
            Some(Ok(chunk)) => {
                let remaining = read_limit - body.len();
                let take = remaining.min(chunk.len());
                body.extend_from_slice(&chunk[..take]);
                if take < chunk.len() {
                    truncated = true;
                    break;
                }
            }
            Some(Err(_)) => {
                read_failed = true;
                break;
            }
            None => break,
        }
    }
    if body.len() > max_bytes {
        body.truncate(max_bytes);
        truncated = true;
    }

    let mut text = String::from_utf8_lossy(&body).into_owned();
    if truncated {
        text.push_str(" [truncated]");
    } else if read_failed {
        text.push_str(" [body read failed]");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_core::AgentMessage;

    fn request(effort: Option<&str>) -> ProviderRequest {
        ProviderRequest {
            messages: vec![AgentMessage::user("hello")],
            tools: Vec::new(),
            step: 1,
            reasoning_effort: effort.map(str::to_owned),
            max_output_tokens: None,
            debug_scope: Default::default(),
        }
    }

    #[test]
    fn exact_model_reasoning_profile_maps_public_ids_to_wire_fragments() {
        let profile = OpenAiReasoningProfile::new(
            Some("high".to_owned()),
            [
                (
                    "off".to_owned(),
                    json!({"chat_template_kwargs": {"enable_thinking": false}}),
                ),
                ("high".to_owned(), json!({"reasoning_effort": "ultra"})),
            ],
        )
        .unwrap();
        let provider = OpenAiProvider::new(
            OpenAiProviderConfig::new(
                OpenAiProtocol::ChatCompletions,
                "http://localhost/v1",
                "",
                "model",
            )
            .with_reasoning_profile(profile),
        )
        .unwrap();

        let default_body = provider.request_body(&request(None), false).unwrap();
        assert_eq!(default_body["reasoning_effort"], "ultra");

        let off_body = provider.request_body(&request(Some("off")), false).unwrap();
        assert_eq!(off_body["chat_template_kwargs"]["enable_thinking"], false);
        assert!(off_body.get("reasoning_effort").is_none());

        let error = provider
            .request_body(&request(Some("unknown")), false)
            .unwrap_err();
        assert!(error.message.contains("unsupported reasoning effort"));
    }

    #[test]
    fn reasoning_profile_rejects_reserved_request_overrides() {
        let error =
            OpenAiReasoningProfile::new(None, [("bad".to_owned(), json!({"messages": []}))])
                .unwrap_err();
        assert!(error.message.contains("reserved field \"messages\""));
    }
}
