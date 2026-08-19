use std::{fmt, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{header, Client};
use tokio_util::sync::CancellationToken;
use xharness_core::{ModelProvider, ProviderError, ProviderRequest, ProviderStream};

use crate::{build_openai_request, OpenAiProtocol, OpenAiStreamNormalizer, SseParser};

#[derive(Clone)]
pub struct OpenAiProviderConfig {
    pub protocol: OpenAiProtocol,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
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
            let body = response.text().await.unwrap_or_default();
            let detail = if body.is_empty() {
                format!("OpenAI HTTP {code}")
            } else {
                format!("OpenAI HTTP {code}: {}", bounded_text(&body, 4096))
            };
            return Err(ProviderError::http(code, detail));
        }

        let protocol = self.config.protocol;
        let output = async_stream::stream! {
            let mut bytes = response.bytes_stream();
            let mut parser = SseParser::default();
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

fn bounded_text(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
