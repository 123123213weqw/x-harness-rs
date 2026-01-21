//! Bounded anonymous Web fetch and pluggable search providers.
//!
//! Fetch follows only same-origin redirects, sends no cookies or ambient
//! credentials, bounds both wire bytes and decoded text, and rejects local or
//! private network destinations. Search is explicit provider injection; there
//! is no silent provider selection or fabricated local search engine.

use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xharness_debug::{DebugEvent, DebugRecorder};

const DEFAULT_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
/// Model-facing page summaries are deliberately much smaller than the wire
/// budget.  A single dynamic page must not be able to consume an entire model
/// context before the next loop step can compact it.
const DEFAULT_MAX_TEXT_CHARS: usize = 8_000;
const DEFAULT_MAX_REDIRECTS: usize = 5;
const DEFAULT_SEARCH_LIMIT: usize = 8;
const MAX_URL_BYTES: usize = 2048;
const MAX_READER_BLOCK_CHARS: usize = 2_000;
const READER_SUMMARY_STRATEGY: &str = "reader-extractive/v1";
const PUBLIC_DNS_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";
const DNS_RECORD_A: u16 = 1;
const DNS_RECORD_AAAA: u16 = 28;

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
    /// Characters in the normalized reader-mode source before extractive
    /// selection. This excludes script/style/template payloads.
    pub source_chars: usize,
    /// Characters returned in `content` after reader-mode selection.
    pub extracted_chars: usize,
    /// Stable algorithm identity for audit and future migrations.
    pub summary_strategy: String,
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
    resolver_client: Client,
    config: WebConfig,
    search: Option<Arc<dyn SearchProvider>>,
    debug: DebugRecorder,
}

impl WebRuntime {
    pub fn new(config: WebConfig) -> Result<Self, WebError> {
        config.validate()?;
        let resolver_client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(config.fetch_timeout)
            .user_agent("xharness-web/0.1")
            .build()?;
        Ok(Self {
            resolver_client,
            config,
            search: None,
            debug: DebugRecorder::disabled(),
        })
    }

    pub fn with_debug(mut self, debug: DebugRecorder) -> Self {
        self.debug = debug;
        self
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
        self.debug
            .record_lossy(DebugEvent::new(
                "web",
                "search.request",
                json!({"query": query, "limit": limit}),
            ))
            .await;
        let result = self.search_inner(query, limit, cancellation).await;
        self.debug
            .record_lossy(DebugEvent::new(
                "web",
                "search.completed",
                json!({
                    "response": result.as_ref().ok(),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            ))
            .await;
        result
    }

    async fn search_inner(
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
        self.fetch_with_focus(raw_url, None, cancellation).await
    }

    /// Fetch one page and return a bounded deterministic reader summary.
    /// `focus` only influences extractive block ranking; it is never sent to
    /// the remote server and does not invoke another model.
    pub async fn fetch_with_focus(
        &self,
        raw_url: &str,
        focus: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<FetchResponse, WebError> {
        self.debug
            .record_lossy(DebugEvent::new(
                "web",
                "fetch.request",
                json!({"url": raw_url, "focus": focus}),
            ))
            .await;
        let result = self.fetch_inner(raw_url, focus, cancellation).await;
        self.debug
            .record_lossy(DebugEvent::new(
                "web",
                "fetch.completed",
                json!({
                    "response": result.as_ref().ok(),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            ))
            .await;
        result
    }

    async fn fetch_inner(
        &self,
        raw_url: &str,
        focus: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<FetchResponse, WebError> {
        if raw_url.len() > MAX_URL_BYTES {
            return Err(WebError::UrlTooLong);
        }
        let requested = parse_url(raw_url)?;
        let mut current = requested.clone();

        for redirect_count in 0..=self.config.max_redirects {
            let resolved = self.resolve_target(&current, cancellation).await?;
            self.debug
                .record_lossy(DebugEvent::new(
                    "web",
                    "fetch.resolved",
                    json!({
                        "url": current.to_string(),
                        "source": resolved.source,
                        "addressCount": resolved.addresses.len(),
                    }),
                ))
                .await;
            let client = fetch_client(&self.config, &current, &resolved.addresses)?;
            let request = client
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
                self.debug
                    .record_lossy(DebugEvent::new(
                        "web",
                        "fetch.redirect",
                        json!({"from": current.to_string(), "to": next.to_string()}),
                    ))
                    .await;
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
                self.debug
                    .record_lossy(DebugEvent::new(
                        "web",
                        "fetch.chunk",
                        json!({
                            "url": current.to_string(),
                            "bytes": chunk.len(),
                            "content": String::from_utf8_lossy(&chunk),
                        }),
                    ))
                    .await;
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
                html2md::parse_html(&strip_non_content_html(&decoded))
            } else {
                decoded.into_owned()
            };
            let summary = reader_summary(rendered, focus, self.config.max_text_chars);
            return Ok(FetchResponse {
                requested_url: requested.to_string(),
                final_url: current.to_string(),
                status: status.as_u16(),
                content_type,
                content: summary.content,
                bytes_read,
                source_chars: summary.source_chars,
                extracted_chars: summary.extracted_chars,
                summary_strategy: READER_SUMMARY_STRATEGY.to_owned(),
                truncated: summary.truncated,
            });
        }
        Err(WebError::RedirectLimit)
    }

    async fn resolve_target(
        &self,
        url: &Url,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedTarget, WebError> {
        let host = url.host_str().ok_or(WebError::UnsupportedUrl)?;
        let port = url
            .port_or_known_default()
            .ok_or(WebError::UnsupportedUrl)?;
        let lookup = tokio::net::lookup_host((host, port));
        let addresses: Vec<SocketAddr> = tokio::select! {
            _ = cancellation.cancelled() => return Err(WebError::Cancelled),
            result = lookup => result
                .map_err(|_| WebError::ResolutionFailed(host.to_owned()))?
                .collect(),
        };
        match classify_system_resolution(host, &addresses, self.config.allow_private_networks)? {
            ResolutionDecision::UseSystem(source) => Ok(ResolvedTarget { addresses, source }),
            ResolutionDecision::VerifyWithPublicDns => {
                let addresses = self
                    .resolve_with_public_dns(host, port, cancellation)
                    .await?;
                validate_verified_public_addresses(host, &addresses)?;
                Ok(ResolvedTarget {
                    addresses,
                    source: "encrypted-public-dns",
                })
            }
        }
    }

    async fn resolve_with_public_dns(
        &self,
        host: &str,
        port: u16,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, WebError> {
        let mut addresses = Vec::new();
        for record_type in [DNS_RECORD_A, DNS_RECORD_AAAA] {
            let request = self
                .resolver_client
                .get(PUBLIC_DNS_ENDPOINT)
                .header(header::ACCEPT, "application/dns-json")
                .query(&[("name", host), ("type", &record_type.to_string())]);
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(WebError::Cancelled),
                result = request.send() => result?,
            };
            if !response.status().is_success() {
                return Err(WebError::ResolutionFailed(host.to_owned()));
            }
            let response: DnsJsonResponse = tokio::select! {
                _ = cancellation.cancelled() => return Err(WebError::Cancelled),
                result = response.json() => result?,
            };
            if response.status != 0 {
                return Err(WebError::ResolutionFailed(host.to_owned()));
            }
            addresses.extend(response.answers.into_iter().filter_map(|answer| {
                if !matches!(answer.record_type, DNS_RECORD_A | DNS_RECORD_AAAA) {
                    return None;
                }
                answer
                    .data
                    .parse::<IpAddr>()
                    .ok()
                    .map(|ip| SocketAddr::new(ip, port))
            }));
        }
        if addresses.is_empty() {
            return Err(WebError::ResolutionFailed(host.to_owned()));
        }
        addresses.sort_unstable();
        addresses.dedup();
        Ok(addresses)
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

#[derive(Deserialize)]
struct DnsJsonResponse {
    #[serde(rename = "Status")]
    status: u16,
    #[serde(default, rename = "Answer")]
    answers: Vec<DnsJsonAnswer>,
}

#[derive(Deserialize)]
struct DnsJsonAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
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

#[derive(Debug)]
struct ResolvedTarget {
    addresses: Vec<SocketAddr>,
    source: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolutionDecision {
    UseSystem(&'static str),
    VerifyWithPublicDns,
}

fn classify_system_resolution(
    host: &str,
    addresses: &[SocketAddr],
    allow_private: bool,
) -> Result<ResolutionDecision, WebError> {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return if allow_private {
            Ok(ResolutionDecision::UseSystem("system-private-allowed"))
        } else {
            Err(WebError::PrivateNetworkDenied(host.to_owned()))
        };
    }
    if addresses.is_empty() {
        return Err(WebError::ResolutionFailed(host.to_owned()));
    }
    if allow_private {
        return Ok(ResolutionDecision::UseSystem("system-private-allowed"));
    }

    // IP literals never receive the Fake-IP exception. A direct request to a
    // private/reserved address remains denied even on a machine that uses a
    // transparent proxy.
    if host.parse::<IpAddr>().is_ok() {
        return if addresses.iter().all(|address| is_public_ip(address.ip())) {
            Ok(ResolutionDecision::UseSystem("literal-public"))
        } else {
            Err(WebError::PrivateNetworkDenied(host.to_owned()))
        };
    }

    if addresses.iter().all(|address| is_public_ip(address.ip())) {
        return Ok(ResolutionDecision::UseSystem("system-public"));
    }

    // Clash/Surge-style TUN DNS commonly returns RFC 2544 benchmarking
    // addresses from 198.18.0.0/15 for every public hostname. Do not blindly
    // allow that reserved range: independently resolve the hostname over
    // encrypted public DNS, validate the real addresses, and pin the HTTP
    // client to those addresses before connecting.
    if addresses
        .iter()
        .all(|address| is_public_ip(address.ip()) || is_fake_dns_ip(address.ip()))
        && addresses.iter().any(|address| is_fake_dns_ip(address.ip()))
    {
        return Ok(ResolutionDecision::VerifyWithPublicDns);
    }

    Err(WebError::PrivateNetworkDenied(host.to_owned()))
}

fn validate_verified_public_addresses(
    host: &str,
    addresses: &[SocketAddr],
) -> Result<(), WebError> {
    if addresses.is_empty() {
        return Err(WebError::ResolutionFailed(host.to_owned()));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(WebError::PrivateNetworkDenied(host.to_owned()));
    }
    Ok(())
}

fn fetch_client(
    config: &WebConfig,
    url: &Url,
    addresses: &[SocketAddr],
) -> Result<Client, WebError> {
    let host = url.host_str().ok_or(WebError::UnsupportedUrl)?;
    let mut builder = Client::builder()
        // The resolved addresses are the SSRF boundary. An ambient forward
        // proxy would resolve the hostname itself and bypass this pin.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(config.fetch_timeout)
        .user_agent("xharness-web/0.1");
    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    Ok(builder.build()?)
}

fn is_fake_dns_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .is_some_and(|mapped| is_fake_dns_ip(IpAddr::V4(mapped))),
    }
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

#[derive(Debug)]
struct ReaderSummary {
    content: String,
    source_chars: usize,
    extracted_chars: usize,
    truncated: bool,
}

#[derive(Debug)]
struct ReaderBlock {
    index: usize,
    text: String,
    score: i64,
}

/// Remove executable and high-noise HTML regions before Markdown conversion.
/// This intentionally stays deterministic and dependency-light: it is not an
/// HTML sanitizer for browser rendering, only a reader-mode preprocessor for
/// already untrusted text.
fn strip_non_content_html(source: &str) -> String {
    let mut output = strip_html_comments(source);
    for tag in [
        "script", "style", "noscript", "template", "svg", "canvas", "iframe",
    ] {
        output = strip_html_element(&output, tag);
    }
    output
}

fn strip_html_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;
    while let Some(relative_start) = source[cursor..].find("<!--") {
        let start = cursor + relative_start;
        output.push_str(&source[cursor..start]);
        let Some(relative_end) = source[start + 4..].find("-->") else {
            cursor = source.len();
            break;
        };
        cursor = start + 4 + relative_end + 3;
    }
    output.push_str(&source[cursor..]);
    output
}

fn strip_html_element(source: &str, tag: &str) -> String {
    let lowercase = source.to_ascii_lowercase();
    let opening = format!("<{tag}");
    let closing = format!("</{tag}");
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;

    while let Some(relative_start) = lowercase[cursor..].find(&opening) {
        let start = cursor + relative_start;
        let boundary = lowercase.as_bytes().get(start + opening.len()).copied();
        if !boundary.is_some_and(|byte| byte == b'>' || byte == b'/' || byte.is_ascii_whitespace())
        {
            let keep_until = start + opening.len();
            output.push_str(&source[cursor..keep_until]);
            cursor = keep_until;
            continue;
        }
        output.push_str(&source[cursor..start]);
        let Some(relative_close) = lowercase[start + opening.len()..].find(&closing) else {
            cursor = source.len();
            break;
        };
        let close_start = start + opening.len() + relative_close;
        let Some(relative_end) = lowercase[close_start..].find('>') else {
            cursor = source.len();
            break;
        };
        cursor = close_start + relative_end + 1;
    }
    output.push_str(&source[cursor..]);
    output
}

fn reader_summary(rendered: String, focus: Option<&str>, limit: usize) -> ReaderSummary {
    let normalized = normalize_reader_text(&rendered);
    let source_chars = normalized.chars().count();
    if source_chars <= limit {
        return ReaderSummary {
            extracted_chars: source_chars,
            source_chars,
            content: normalized,
            truncated: false,
        };
    }

    let focus_terms = focus_terms(focus);
    let mut blocks = normalized
        .split("\n\n")
        .enumerate()
        .filter_map(|(index, block)| {
            let block = block.trim();
            if block.is_empty() {
                return None;
            }
            let text = truncate_block(block, MAX_READER_BLOCK_CHARS);
            Some(ReaderBlock {
                index,
                score: reader_block_score(index, &text, &focus_terms),
                text,
            })
        })
        .collect::<Vec<_>>();
    let block_count = blocks.len();
    blocks.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.index.cmp(&right.index))
    });

    // Leave room for a stable accounting marker. Selection is score-first,
    // then restored to document order so the resulting summary remains easy
    // for a model and a human to follow.
    let reserve = 160usize.min(limit / 4);
    let content_budget = limit.saturating_sub(reserve).max(1);
    let mut selected = Vec::new();
    let mut used = 0usize;
    for block in blocks {
        let chars = block.text.chars().count();
        let separator = usize::from(!selected.is_empty()) * 2;
        if used.saturating_add(separator).saturating_add(chars) > content_budget {
            continue;
        }
        used = used.saturating_add(separator).saturating_add(chars);
        selected.push(block);
    }
    if selected.is_empty() {
        let (fallback, _) = truncate_chars(normalized.clone(), content_budget);
        selected.push(ReaderBlock {
            index: 0,
            score: 0,
            text: fallback,
        });
    }
    selected.sort_by_key(|block| block.index);
    let selected_count = selected.len();
    let body = selected
        .into_iter()
        .map(|block| block.text)
        .collect::<Vec<_>>()
        .join("\n\n");
    let marker = format!(
        "\n\n[Reader summary: selected {selected_count}/{block_count} blocks from {source_chars} characters.]"
    );
    let (content, _) = truncate_chars(format!("{body}{marker}"), limit);
    let extracted_chars = content.chars().count();
    ReaderSummary {
        content,
        source_chars,
        extracted_chars,
        truncated: true,
    }
}

fn normalize_reader_text(source: &str) -> String {
    let mut output = Vec::new();
    let mut previous_blank = true;
    let mut seen = HashSet::new();
    for line in source.lines() {
        let line = collapse_inline_whitespace(line.trim());
        if line.is_empty() {
            if !previous_blank {
                output.push(String::new());
                previous_blank = true;
            }
            continue;
        }
        if is_script_like_line(&line) {
            continue;
        }
        if line.chars().count() >= 40 && !seen.insert(line.clone()) {
            continue;
        }
        output.push(line);
        previous_blank = false;
    }
    while output.last().is_some_and(String::is_empty) {
        output.pop();
    }
    output.join("\n")
}

fn collapse_inline_whitespace(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut pending_space = false;
    for character in source.chars() {
        if character == ' ' || character == '\t' || character == '\r' {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
                pending_space = false;
            }
            output.push(character);
        }
    }
    output
}

fn is_script_like_line(line: &str) -> bool {
    let lowercase = line.to_ascii_lowercase();
    lowercase.starts_with("window.")
        || lowercase.starts_with("document.")
        || lowercase.starts_with("function ")
        || lowercase.starts_with("function(")
        || lowercase.starts_with("var ")
        || lowercase.starts_with("let ")
        || lowercase.starts_with("const ")
        || lowercase.contains("googletag.cmd")
        || lowercase.contains("datalayer.push(")
        || lowercase.starts_with("@font-face")
        || lowercase.starts_with("data:image/")
}

fn focus_terms(focus: Option<&str>) -> Vec<String> {
    focus
        .unwrap_or_default()
        .split(|character: char| {
            !character.is_alphanumeric() && character != '_' && character != '-'
        })
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2)
        .map(str::to_lowercase)
        .collect()
}

fn reader_block_score(index: usize, block: &str, focus_terms: &[String]) -> i64 {
    let chars = block.chars().count();
    let lowercase = block.to_lowercase();
    let mut score = i64::try_from(chars.min(1_200)).unwrap_or(1_200);
    if block.starts_with('#') {
        score += 8_000;
    }
    if index < 4 {
        score += i64::try_from(4usize.saturating_sub(index) * 1_000).unwrap_or_default();
    }
    if block.contains("|---") || block.lines().filter(|line| line.contains('|')).count() >= 2 {
        score += 1_500;
    }
    if block.starts_with("- ") || block.starts_with("* ") || block.starts_with("1. ") {
        score += 500;
    }
    for term in focus_terms {
        if lowercase.contains(term) {
            score += 10_000;
        }
    }
    let link_count = block.matches("](").count();
    if chars < 160 && link_count >= 3 {
        score -= 2_000;
    }
    if [
        "cookie",
        "privacy policy",
        "sign in",
        "log in",
        "advertisement",
    ]
    .iter()
    .any(|needle| lowercase.contains(needle))
    {
        score -= 1_000;
    }
    score
}

fn truncate_block(block: &str, limit: usize) -> String {
    if block.chars().count() <= limit {
        return block.to_owned();
    }
    let head: String = block.chars().take(limit.saturating_sub(40)).collect();
    format!("{head}\n[... long block shortened ...]")
}

fn truncate_chars(content: String, limit: usize) -> (String, bool) {
    let Some((index, _)) = content.char_indices().nth(limit) else {
        return (content, false);
    };
    (content[..index].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn address(value: &str) -> SocketAddr {
        value.parse().unwrap()
    }

    #[test]
    fn public_system_resolution_is_used_directly() {
        assert_eq!(
            classify_system_resolution("example.com", &[address("93.184.216.34:443")], false)
                .unwrap(),
            ResolutionDecision::UseSystem("system-public")
        );
    }

    #[test]
    fn fake_ip_hostname_requires_encrypted_public_verification() {
        assert_eq!(
            classify_system_resolution("wttr.in", &[address("198.18.0.65:443")], false).unwrap(),
            ResolutionDecision::VerifyWithPublicDns
        );
    }

    #[test]
    fn direct_fake_ip_and_real_private_targets_remain_denied() {
        for (host, resolved) in [
            ("198.18.0.65", "198.18.0.65:443"),
            ("internal.example", "127.0.0.1:443"),
            ("internal.example", "10.0.0.8:443"),
        ] {
            assert!(matches!(
                classify_system_resolution(host, &[address(resolved)], false),
                Err(WebError::PrivateNetworkDenied(_))
            ));
        }
    }

    #[test]
    fn encrypted_verification_must_return_only_public_addresses() {
        assert!(
            validate_verified_public_addresses("wttr.in", &[address("5.9.243.187:443")]).is_ok()
        );
        assert!(matches!(
            validate_verified_public_addresses("internal.example", &[address("127.0.0.1:443")]),
            Err(WebError::PrivateNetworkDenied(_))
        ));
    }

    #[test]
    fn mapped_fake_and_private_ipv4_addresses_keep_the_ipv4_policy() {
        assert!(is_fake_dns_ip("::ffff:198.18.0.65".parse().unwrap()));
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_public_ip("::ffff:93.184.216.34".parse().unwrap()));
    }

    #[tokio::test]
    async fn fetch_client_connects_only_to_the_pinned_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 1024];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /bound "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                )
                .await
                .unwrap();
        });

        let url = Url::parse(&format!("http://rebind.invalid:{}/bound", address.port())).unwrap();
        let client = fetch_client(&WebConfig::default(), &url, &[address]).unwrap();
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
        server.await.unwrap();
    }
}
