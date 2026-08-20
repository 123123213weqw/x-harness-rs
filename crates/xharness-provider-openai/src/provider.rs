use std::{fmt, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{header, Client, Response};
use tokio_util::sync::CancellationToken;
use xharness_core::{ModelProvider, ProviderError, ProviderRequest, ProviderStream};

use crate::{
    build_openai_request, OpenAiProtocol, OpenAiStreamNormalizer, SseParser,
    DEFAULT_SSE_EVENT_LIMIT_BYTES, DEFAULT_SSE_PENDING_LIMIT_BYTES,
};

pub const DEFAULT_ERROR_BODY_LIMIT_BYTES: usize = 4 * 1024;

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
        }
    }

    fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        match self.protocol {
            OpenAiProtocol::ChatCompletions => format!("{base}/chat/completions"),
            OpenAiProtocol::Responses => format!("{base}/responses"),
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
            .finish()
    }
}

#[derive(Clone)]
pub struct OpenAiProvider {
    config: Arc<OpenAiProviderConfig>,
    client: Client,
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
        })
    }

    pub fn config(&self) -> &OpenAiProviderConfig {
        &self.config
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

    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let body = build_openai_request(self.config.protocol, &self.config.model, &request);
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
        if !status.is_success() {
            let code = status.as_u16();
            let body =
                bounded_error_body(response, self.config.max_error_body_bytes, &cancellation)
                    .await?;
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
                        match parser.feed_bytes(chunk, false) {
                            Ok(events) => {
                                for event in events {
                                    match normalizer.consume(event) {
                                        Ok(provider_events) => {
                                            for provider_event in provider_events {
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
