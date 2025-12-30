use std::sync::Arc;

use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_web::{SearchProvider, SearchResult, WebConfig, WebError, WebRuntime};

struct FakeSearch;

#[async_trait]
impl SearchProvider for FakeSearch {
    fn id(&self) -> &str {
        "fake"
    }

    async fn search(
        &self,
        query: &str,
        _limit: usize,
        _cancellation: &CancellationToken,
    ) -> Result<Vec<SearchResult>, WebError> {
        Ok(vec![SearchResult {
            title: format!("result for {query}"),
            url: "https://example.com/result".into(),
            snippet: "snippet".into(),
            published_date: None,
        }])
    }
}

#[tokio::test]
async fn explicit_search_provider_is_required_and_normalized() {
    let cancellation = CancellationToken::new();
    assert!(matches!(
        WebRuntime::default()
            .search("query", None, &cancellation)
            .await,
        Err(WebError::SearchUnavailable)
    ));
    let runtime = WebRuntime::default().with_search_provider(Arc::new(FakeSearch));
    let result = runtime
        .search("rust", Some(2), &cancellation)
        .await
        .unwrap();
    assert_eq!(result.provider, "fake");
    assert_eq!(result.results[0].title, "result for rust");
}

#[tokio::test]
async fn fetch_follows_same_origin_and_extracts_bounded_markdown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 2048];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let response = if request.starts_with("GET /redirect ") {
                "HTTP/1.1 302 Found\r\nLocation: /page\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
            } else {
                let body = "<html><body><h1>Hello</h1><p>world</p></body></html>";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            };
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });

    let sink = Arc::new(MemoryDebugSink::default());
    let runtime = WebRuntime::new(WebConfig {
        allow_private_networks: true,
        ..WebConfig::default()
    })
    .unwrap()
    .with_debug(DebugRecorder::new(sink.clone()));
    let result = runtime
        .fetch(
            &format!("http://{address}/redirect"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, 200);
    assert!(result.final_url.ends_with("/page"));
    assert!(result.content.contains("Hello"));
    assert!(result.content.contains("world"));
    assert_eq!(result.summary_strategy, "reader-extractive/v1");
    assert_eq!(result.source_chars, result.extracted_chars);
    assert!(!result.truncated);
    server.await.unwrap();
    let events = sink.events().await;
    for expected in [
        "fetch.request",
        "fetch.redirect",
        "fetch.chunk",
        "fetch.completed",
    ] {
        assert!(events.iter().any(|event| event.event == expected));
    }
}

#[tokio::test]
async fn fetch_removes_script_noise_and_returns_a_focus_ranked_reader_summary() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let script_noise = format!("window.noise = '{}';", "x".repeat(40_000));
    let generic = (0..30)
        .map(|index| {
            format!(
                "<h2>Generic section {index}</h2><p>This is generic navigation and repeated page material number {index} with enough words to form a reader block.</p>"
            )
        })
        .collect::<String>();
    let body = format!(
        "<html><head><script>{script_noise}</script><style>.noise{{color:red}}</style></head><body><h1>Competition index</h1>{generic}<h2>Target contests</h2><p>Focused evidence: Rust Challenge starts tomorrow and has a first prize.</p></body></html>"
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0u8; 2048];
        let _ = stream.read(&mut request).await.unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let runtime = WebRuntime::new(WebConfig {
        max_text_chars: 600,
        allow_private_networks: true,
        ..WebConfig::default()
    })
    .unwrap();
    let result = runtime
        .fetch_with_focus(
            &format!("http://{address}/page"),
            Some("Rust Challenge first prize"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    server.await.unwrap();

    assert_eq!(result.summary_strategy, "reader-extractive/v1");
    assert!(result.truncated);
    assert!(result.extracted_chars <= 600);
    assert!(result.source_chars > result.extracted_chars);
    assert!(result.content.contains("Rust Challenge"));
    assert!(result.content.contains("Reader summary"));
    assert!(!result.content.contains("window.noise"));
    assert!(!result.content.contains("color:red"));
}

#[test]
fn default_model_facing_fetch_budget_is_small() {
    assert_eq!(WebConfig::default().max_text_chars, 8_000);
}
