//! Direct, model-independent DeepSeek Search API adapter.
#![forbid(unsafe_code)]

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use reqwest::{redirect::Policy, Client, StatusCode};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::{SearchProvider, SearchResult, WebError};

const ENDPOINT: &str = "https://api.deepseek.com/v1/tools/search";
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BYTES: usize = 512 * 1024;
const MAX_RESULT_CHARS: usize = 1_000;

/// Clones share their connection pool; credentials are snapshotted per operation.
/// An empty credential is an unavailable template, never an anonymous search.
#[derive(Clone)]
pub struct DeepSeekSearchProvider {
    client: Client,
    endpoint: reqwest::Url,
    api_key: Arc<str>,
}

impl std::fmt::Debug for DeepSeekSearchProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeepSeekSearchProvider")
            .field("api_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl DeepSeekSearchProvider {
    pub fn new(api_key: impl Into<String>) -> Result<Self, WebError> {
        Ok(Self {
            client: Client::builder()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(TIMEOUT)
                .build()?,
            endpoint: reqwest::Url::parse(ENDPOINT).expect("static DeepSeek Search URL"),
            api_key: Arc::from(api_key.into()),
        })
    }

    /// Reuse the pool and fixed endpoint without mutating an in-flight request.
    pub fn with_api_key(&self, api_key: String) -> Self {
        Self {
            api_key: Arc::from(api_key),
            ..self.clone()
        }
    }

    async fn attempt(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, Failure> {
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.api_key.as_ref())
            .json(&serde_json::json!({"query":query, "count":limit, "need_content":false}))
            .send()
            .await
            .map_err(Failure::transport)?;
        let status = response.status();
        if status != StatusCode::OK {
            let retryable = matches!(status.as_u16(), 408 | 429 | 500..=599);
            let delay = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(|v| Duration::from_secs(v.min(TIMEOUT.as_secs())));
            // Error bodies can contain reflected credentials or server details.
            return Err(Failure {
                error: WebError::Provider(format!(
                    "DeepSeek Search returned HTTP {}",
                    status.as_u16()
                )),
                retryable,
                delay,
            });
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BYTES as u64)
        {
            return Err(Failure::closed(WebError::ResponseTooLarge {
                limit: MAX_BYTES,
            }));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(Failure::transport)? {
            if chunk.len() > MAX_BYTES.saturating_sub(body.len()) {
                return Err(Failure::closed(WebError::ResponseTooLarge {
                    limit: MAX_BYTES,
                }));
            }
            body.extend_from_slice(&chunk);
        }
        let response: Response = serde_json::from_slice(&body).map_err(|_| invalid_response())?;
        response
            .results
            .into_iter()
            .take(limit)
            .map(|row| {
                if row.url.len() > crate::MAX_URL_BYTES
                    || row.date.as_ref().is_some_and(|date| date.len() > 64)
                {
                    return Err(invalid_response());
                }
                crate::parse_url(&row.url).map_err(|_| invalid_response())?;
                let text = if row.summary.trim().is_empty() {
                    row.snippet
                } else {
                    row.summary
                };
                Ok(SearchResult {
                    title: row.title.chars().take(500).collect(),
                    url: row.url,
                    snippet: text.chars().take(MAX_RESULT_CHARS).collect(),
                    published_date: row.date.filter(|date| !date.trim().is_empty()),
                })
            })
            .collect()
    }

    async fn bounded_search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, WebError> {
        for attempt in 0..3 {
            match self.attempt(query, limit).await {
                Ok(results) => return Ok(results),
                Err(failure) if failure.retryable && attempt < 2 => {
                    tokio::time::sleep(
                        failure
                            .delay
                            .unwrap_or(Duration::from_millis(250 << attempt)),
                    )
                    .await;
                }
                Err(failure) => return Err(failure.error),
            }
        }
        unreachable!("bounded retry loop always returns")
    }
}

#[async_trait]
impl SearchProvider for DeepSeekSearchProvider {
    fn id(&self) -> &str {
        "deepseek-search-api"
    }

    async fn available(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    async fn search(
        &self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SearchResult>, WebError> {
        if cancellation.is_cancelled() {
            return Err(WebError::Cancelled);
        }
        if self.api_key.trim().is_empty() {
            return Err(WebError::SearchUnavailable);
        }
        if query.trim().is_empty() || query.chars().count() > 128 {
            return Err(WebError::Provider(
                "DeepSeek Search requires a nonblank query of at most 128 Unicode characters"
                    .into(),
            ));
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(WebError::Cancelled),
            result = tokio::time::timeout(TIMEOUT, self.bounded_search(query, limit.clamp(1, 20))) => {
                result.map_err(|_| WebError::TimedOut)?
            }
        }
    }
}

struct Failure {
    error: WebError,
    retryable: bool,
    delay: Option<Duration>,
}

impl Failure {
    fn closed(error: WebError) -> Self {
        Self {
            error,
            retryable: false,
            delay: None,
        }
    }
    fn transport(error: reqwest::Error) -> Self {
        let retryable = !error.is_builder() && !error.is_redirect();
        Self {
            error: WebError::Transport(error),
            retryable,
            delay: None,
        }
    }
}

fn invalid_response() -> Failure {
    Failure::closed(WebError::Provider(
        "DeepSeek Search returned an invalid response".into(),
    ))
}

#[derive(Deserialize)]
struct Response {
    results: Vec<ResultRow>,
}

#[derive(Deserialize)]
struct ResultRow {
    title: String,
    url: String,
    snippet: String,
    #[serde(default)]
    summary: String,
    date: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::Mutex;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: String,
        headers: String,
        stall: bool,
    }

    fn reply(status: u16, body: impl Into<String>) -> Reply {
        Reply {
            status,
            body: body.into(),
            headers: String::new(),
            stall: false,
        }
    }

    fn row() -> Value {
        json!({"title":"Source", "url":"https://example.com/source", "snippet":"Short excerpt", "summary":"Model summary", "date":null})
    }

    async fn fixture(
        replies: Vec<Reply>,
    ) -> (DeepSeekSearchProvider, Arc<Mutex<Vec<String>>>, Server) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut provider = DeepSeekSearchProvider::new("search-only-test-key").unwrap();
        provider.client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .unwrap();
        provider.endpoint =
            reqwest::Url::parse(&format!("http://{}/search", listener.local_addr().unwrap()))
                .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = Server(tokio::spawn(async move {
            for reply in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 2048];
                loop {
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..index]);
                        let size = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= index + 4 + size {
                            break;
                        }
                    }
                }
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                let headers = format!(
                    "HTTP/1.1 {} fixture\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
                    reply.status,
                    if reply.stall { 100 } else { reply.body.len() },
                    reply.headers
                );
                if stream.write_all(headers.as_bytes()).await.is_err() {
                    continue;
                }
                if reply.stall {
                    std::future::pending::<()>().await;
                }
                let _ = stream.write_all(reply.body.as_bytes()).await;
            }
        }));
        (provider, requests, server)
    }

    #[tokio::test]
    async fn direct_json_is_model_independent_and_normalized_without_history() {
        let mut dated = row();
        dated["date"] = json!("2026-10-19T00:00:00Z");
        let (p, requests, _server) =
            fixture(vec![reply(200, json!({"results":[dated]}).to_string())]).await;
        let result = p
            .search("rust site:example.com", 8, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(p.id(), "deepseek-search-api");
        assert_eq!(result[0].snippet, "Model summary");
        assert_eq!(
            result[0].published_date.as_deref(),
            Some("2026-10-19T00:00:00Z")
        );
        let request = requests.lock().unwrap()[0].clone();
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer search-only-test-key"));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"query":"rust site:example.com","count":8,"need_content":false})
        );
        assert!(!format!("{p:?}").contains("search-only-test-key"));
    }

    #[tokio::test]
    async fn unicode_limits_are_characters_and_queries_are_never_silently_truncated() {
        let (p, requests, _server) = fixture(vec![reply(200, "{\"results\":[]}")]).await;
        assert!(p
            .search(&"🦀".repeat(128), 8, &CancellationToken::new())
            .await
            .unwrap()
            .is_empty());
        for query in ["🦀".repeat(129), String::new(), " \n\t".into()] {
            assert!(p
                .search(&query, 8, &CancellationToken::new())
                .await
                .is_err());
        }
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn missing_credentials_and_precancelled_search_never_dispatch() {
        let p = DeepSeekSearchProvider::new("").unwrap();
        assert!(!p.available().await);
        assert!(matches!(
            p.search("rust", 8, &CancellationToken::new()).await,
            Err(WebError::SearchUnavailable)
        ));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            p.with_api_key("fixture".into())
                .search("rust", 8, &cancellation)
                .await,
            Err(WebError::Cancelled)
        ));
    }

    #[tokio::test]
    async fn empty_results_summary_fallback_order_and_result_caps_are_preserved() {
        let mut short = row();
        short["summary"] = json!("");
        let mut long = row();
        long["summary"] = json!("🦀".repeat(2_000));
        let (p, requests, _server) = fixture(vec![reply(
            200,
            json!({"results":[short,long.clone(),long]}).to_string(),
        )])
        .await;
        let result = p
            .search("rust", 2, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].snippet, "Short excerpt");
        assert_eq!(result[0].published_date, None);
        assert_eq!(result[1].snippet.chars().count(), MAX_RESULT_CHARS);
        assert!(requests.lock().unwrap()[0].contains("\"count\":2"));
    }

    #[tokio::test]
    async fn malformed_or_oversized_results_are_closed_not_forged_as_empty_success() {
        let mut bad_url = row();
        bad_url["url"] = json!("file:///private/data");
        let mut long_url = row();
        long_url["url"] = json!(format!("https://example.com/{}", "x".repeat(3_000)));
        let mut long_date = row();
        long_date["date"] = json!("x".repeat(100));
        for body in [
            "not json".into(),
            "{}".into(),
            "{\"results\":null}".into(),
            json!({"results":[{"url":"https://example.com/"}]}).to_string(),
            json!({"results":[bad_url]}).to_string(),
            json!({"results":[long_url]}).to_string(),
            json!({"results":[long_date]}).to_string(),
            "x".repeat(MAX_BYTES + 1),
        ] {
            let (p, requests, _server) = fixture(vec![reply(200, body)]).await;
            assert!(p
                .search("rust", 8, &CancellationToken::new())
                .await
                .is_err());
            assert_eq!(requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn permanent_errors_and_redirects_do_not_retry_or_echo_response_secrets() {
        for status in [400, 401, 402, 403, 404, 413, 301, 302, 307, 308] {
            let mut response = reply(status, "private-error-secret");
            response.headers = "Location: https://example.com/collect\r\n".into();
            let (p, requests, _server) = fixture(vec![response]).await;
            let error = p
                .search("rust", 8, &CancellationToken::new())
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(&status.to_string()), "{error}");
            assert!(!error.contains("private-error-secret"));
            assert!(!error.contains("search-only-test-key"));
            assert_eq!(requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn transient_statuses_retry_with_a_finite_budget() {
        for status in [408, 429, 500, 502, 503, 504] {
            let mut failed = reply(status, "error");
            failed.headers = "Retry-After: 0\r\n".into();
            let (p, requests, _server) =
                fixture(vec![failed.clone(), reply(200, "{\"results\":[]}")]).await;
            assert!(p
                .search("rust", 8, &CancellationToken::new())
                .await
                .unwrap()
                .is_empty());
            assert_eq!(requests.lock().unwrap().len(), 2);
            let (p, requests, _server) = fixture(vec![failed; 3]).await;
            assert!(p
                .search("rust", 8, &CancellationToken::new())
                .await
                .is_err());
            assert_eq!(requests.lock().unwrap().len(), 3);
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_response_body_and_retry_backoff() {
        for response in [
            Reply {
                stall: true,
                ..reply(200, "")
            },
            Reply {
                headers: "Retry-After: 5\r\n".into(),
                ..reply(429, "error")
            },
        ] {
            let (p, requests, _server) = fixture(vec![response]).await;
            let cancel = CancellationToken::new();
            let task_cancel = cancel.clone();
            let task = tokio::spawn(async move { p.search("rust", 8, &task_cancel).await });
            tokio::time::timeout(Duration::from_secs(10), async {
                while requests.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            cancel.cancel();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(10), task)
                    .await
                    .unwrap()
                    .unwrap(),
                Err(WebError::Cancelled)
            ));
            assert_eq!(requests.lock().unwrap().len(), 1);
        }
    }
}
