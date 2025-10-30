//! Bounded anonymous Web fetch and pluggable search providers.
//!
//! Fetch follows only same-origin redirects, sends no cookies or ambient
//! credentials, bounds both wire bytes and decoded text, and rejects local or
//! private network destinations. Search is explicit provider injection; there
//! is no silent provider selection or fabricated local search engine.

use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

const DEFAULT_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS: usize = 100_000;
const DEFAULT_MAX_REDIRECTS: usize = 5;
const DEFAULT_SEARCH_LIMIT: usize = 8;
const MAX_URL_BYTES: usize = 2048;

#[derive(Clone, Debug)]
pub struct WebConfig {
    pub fetch_timeout: Duration,
    pub max_response_bytes: usize,
    pub max_text_chars: usize,
    pub max_redirects: usize,
    pub allow_private_networks: bool,
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            fetch_timeout: DEFAULT_FETCH_TIMEOUT,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            max_text_chars: DEFAULT_MAX_TEXT_CHARS,
            max_redirects: DEFAULT_MAX_REDIRECTS,
            allow_private_networks: false,
        }
    }
}

impl WebConfig {
    pub fn validate(&self) -> Result<(), WebError> {
        if self.fetch_timeout.is_zero() || self.max_response_bytes == 0 || self.max_text_chars == 0
        {
            return Err(WebError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResponse {
    pub provider: String,
    pub query: String,
    pub results: Vec<SearchResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FetchResponse {
    pub requested_url: String,
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub content: String,
    pub bytes_read: u64,
    pub truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum WebError {
    #[error("web configuration limits must be non-zero")]
    InvalidConfig,
    #[error("web URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("only anonymous HTTP(S) URLs are supported")]
    UnsupportedUrl,
    #[error("web URL exceeds {MAX_URL_BYTES} bytes")]
    UrlTooLong,
    #[error("private or local network target is denied: {0}")]
    PrivateNetworkDenied(String),
    #[error("web target did not resolve: {0}")]
    ResolutionFailed(String),
    #[error("cross-origin redirect is denied: {from} -> {to}")]
    CrossOriginRedirect { from: String, to: String },
    #[error("web redirect limit exceeded")]
    RedirectLimit,
    #[error("web redirect is missing a valid Location header")]
    InvalidRedirect,
    #[error("unsupported response content type {0:?}")]
    UnsupportedContentType(String),
    #[error("web response exceeded {limit} bytes")]
    ResponseTooLarge { limit: usize },
    #[error("web request timed out")]
    TimedOut,
    #[error("web request was cancelled")]
    Cancelled,
    #[error("no web search provider is configured")]
    SearchUnavailable,
    #[error("web provider failed: {0}")]
    Provider(String),
    #[error("web transport failed: {0}")]
    Transport(#[from] reqwest::Error),
}

#[async_trait]
pub trait SearchProvider: Send + Sync + 'static {
    fn id(&self) -> &str;

    async fn search(
        &self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SearchResult>, WebError>;
}

#[derive(Clone)]
pub struct WebRuntime {
    client: Client,
    config: WebConfig,
    search: Option<Arc<dyn SearchProvider>>,
}

impl WebRuntime {
    pub fn new(config: WebConfig) -> Result<Self, WebError> {
        config.validate()?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(config.fetch_timeout)
            .user_agent("xharness-web/0.1")
            .build()?;
        Ok(Self {
            client,
            config,
            search: None,
        })
    }

    pub fn with_search_provider(mut self, provider: Arc<dyn SearchProvider>) -> Self {
        self.search = Some(provider);
        self
    }

    pub const fn has_search_provider(&self) -> bool {
        self.search.is_some()
    }

    pub async fn search(
        &self,
        query: &str,
        limit: Option<usize>,
        cancellation: &CancellationToken,
    ) -> Result<SearchResponse, WebError> {
        let provider = self.search.as_ref().ok_or(WebError::SearchUnavailable)?;
        let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 20);
        if query.trim().is_empty() {
            return Err(WebError::Provider("search query must not be empty".into()));
        }
        let results = provider.search(query, limit, cancellation).await?;
        Ok(SearchResponse {
            provider: provider.id().to_owned(),
            query: query.to_owned(),
            results,
        })
    }

    pub async fn fetch(
        &self,
        raw_url: &str,
        cancellation: &CancellationToken,
    ) -> Result<FetchResponse, WebError> {
        if raw_url.len() > MAX_URL_BYTES {
            return Err(WebError::UrlTooLong);
        }
        let requested = parse_url(raw_url)?;
        let mut current = requested.clone();

        for redirect_count in 0..=self.config.max_redirects {
            validate_public_target(&current, self.config.allow_private_networks).await?;
            let request = self
                .client
                .get(current.clone())
                .header(header::ACCEPT, "text/html,text/plain;q=0.9");
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(WebError::Cancelled),
                response = request.send() => response?,
            };
            if response.status().is_redirection() {
                if redirect_count == self.config.max_redirects {
                    return Err(WebError::RedirectLimit);
                }
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(WebError::InvalidRedirect)?;
                let next = current
                    .join(location)
                    .map_err(|_| WebError::InvalidRedirect)?;
                if !same_origin(&current, &next) {
                    return Err(WebError::CrossOriginRedirect {
                        from: current.to_string(),
                        to: next.to_string(),
                    });
                }
                current = next;
                continue;
            }

            let status = response.status();
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if !matches!(
                content_type.as_str(),
                "text/html" | "text/plain" | "text/markdown"
            ) {
                return Err(WebError::UnsupportedContentType(content_type));
            }
            if response
                .content_length()
                .is_some_and(|length| length > self.config.max_response_bytes as u64)
            {
                return Err(WebError::ResponseTooLarge {
                    limit: self.config.max_response_bytes,
                });
            }
            let mut bytes = Vec::new();
            let mut bytes_read = 0u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = tokio::select! {
                _ = cancellation.cancelled() => return Err(WebError::Cancelled),
                chunk = stream.next() => chunk,
            } {
                let chunk = chunk?;
                bytes_read = bytes_read.saturating_add(chunk.len() as u64);
                if bytes.len().saturating_add(chunk.len()) > self.config.max_response_bytes {
                    return Err(WebError::ResponseTooLarge {
                        limit: self.config.max_response_bytes,
                    });
                }
                bytes.extend_from_slice(&chunk);
            }
            let decoded = String::from_utf8_lossy(&bytes);
            let rendered = if content_type == "text/html" {
                html2md::parse_html(&decoded)
            } else {
                decoded.into_owned()
            };
            let (content, truncated) = truncate_chars(rendered, self.config.max_text_chars);
            return Ok(FetchResponse {
                requested_url: requested.to_string(),
                final_url: current.to_string(),
                status: status.as_u16(),
                content_type,
                content,
                bytes_read,
                truncated,
            });
        }
        Err(WebError::RedirectLimit)
    }
}

impl Default for WebRuntime {
    fn default() -> Self {
        Self::new(WebConfig::default()).expect("default Web configuration is valid")
    }
}

impl std::fmt::Debug for WebRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebRuntime")
            .field("config", &self.config)
            .field(
                "search_provider",
                &self.search.as_ref().map(|provider| provider.id()),
            )
            .finish_non_exhaustive()
    }
}

/// Exa Search API provider. The API key is never included in `Debug` output.
#[derive(Clone)]
pub struct ExaSearchProvider {
    client: Client,
    endpoint: Url,
    api_key: Arc<str>,
}

impl ExaSearchProvider {
    pub fn new(api_key: impl Into<String>) -> Result<Self, WebError> {
        let endpoint = Url::parse("https://api.exa.ai/search")
            .map_err(|error| WebError::InvalidUrl(error.to_string()))?;
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()?,
            endpoint,
            api_key: Arc::from(api_key.into()),
        })
    }
}

impl std::fmt::Debug for ExaSearchProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExaSearchProvider")
            .field("endpoint", &self.endpoint)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

#[derive(Serialize)]
struct ExaRequest<'a> {
    query: &'a str,
    #[serde(rename = "numResults")]
    num_results: usize,
    contents: ExaContents,
}

#[derive(Serialize)]
struct ExaContents {
    text: ExaText,
}

#[derive(Serialize)]
struct ExaText {
    #[serde(rename = "maxCharacters")]
    max_characters: usize,
}

#[derive(Deserialize)]
struct ExaResponse {
    #[serde(default)]
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    #[serde(default)]
    title: String,
    url: String,
    #[serde(default)]
    text: String,
    #[serde(default, rename = "publishedDate")]
    published_date: Option<String>,
}

#[async_trait]
impl SearchProvider for ExaSearchProvider {
    fn id(&self) -> &str {
        "exa"
    }

    async fn search(
        &self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SearchResult>, WebError> {
        let request = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.api_key.as_ref())
            .json(&ExaRequest {
                query,
                num_results: limit,
                contents: ExaContents {
                    text: ExaText {
                        max_characters: 1_000,
                    },
                },
            });
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(WebError::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status();
        if !status.is_success() {
            return Err(WebError::Provider(format!("Exa returned HTTP {status}")));
        }
        let response: ExaResponse = response.json().await?;
        Ok(response
            .results
            .into_iter()
            .map(|result| SearchResult {
                title: result.title,
                url: result.url,
                snippet: result.text,
                published_date: result.published_date,
            })
            .collect())
    }
}

fn parse_url(raw: &str) -> Result<Url, WebError> {
    let url = Url::parse(raw).map_err(|error| WebError::InvalidUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(WebError::UnsupportedUrl);
    }
    Ok(url)
}

async fn validate_public_target(url: &Url, allow_private: bool) -> Result<(), WebError> {
    if allow_private {
        return Ok(());
    }
    let host = url.host_str().ok_or(WebError::UnsupportedUrl)?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(WebError::PrivateNetworkDenied(host.to_owned()));
    }
    let port = url
        .port_or_known_default()
        .ok_or(WebError::UnsupportedUrl)?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| WebError::ResolutionFailed(host.to_owned()))?
        .collect();
    if addresses.is_empty() {
        return Err(WebError::ResolutionFailed(host.to_owned()));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(WebError::PrivateNetworkDenied(host.to_owned()));
    }
    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || (ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0)
                || (ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19)))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn truncate_chars(content: String, limit: usize) -> (String, bool) {
    let Some((index, _)) = content.char_indices().nth(limit) else {
        return (content, false);
    };
    (content[..index].to_owned(), true)
}
