use super::*;
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

/// Real HTTP transport, synthetic cookies only; no native browser certification.
#[tokio::test]
async fn redirects_never_forward_credentials_and_writes_are_not_retried() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let destination_url = format!("http://{}/stolen", destination.local_addr().unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let fixture = std::thread::spawn(move || {
        for mut stream in listener.incoming().take(2).flatten() {
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut input = vec![];
            let mut bytes = [0; 2048];
            while !input.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut bytes).unwrap();
                if n == 0 {
                    break;
                }
                input.extend_from_slice(&bytes[..n]);
            }
            let raw = String::from_utf8_lossy(&input);
            assert!(raw
                .to_ascii_lowercase()
                .contains("cookie: sid=synthetic-login"));
            if raw.starts_with("GET /redirect ") {
                write!(stream,"HTTP/1.1 302 Found\r\nLocation: {destination_url}\r\nSet-Cookie: sid=rotated-secret; HttpOnly; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                assert!(raw.starts_with("POST /write "));
                count.fetch_add(1, Ordering::SeqCst);
                let body =
                    r#"{"echo":"synthetic-login","access_token":"not-for-model","ok":false}"#;
                write!(stream,"HTTP/1.1 503 Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        }
    });
    let cookies = || {
        vec![tauri::webview::Cookie::parse(
            "sid=synthetic-login; Domain=127.0.0.1; Path=/; HttpOnly".to_owned(),
        )
        .unwrap()]
    };
    let url = url::Url::parse(&format!("{origin}/redirect")).unwrap();
    let request: Request = serde_json::from_value(json!({"url":url})).unwrap();
    let (response, updates) = send(&url, &request, cookies()).await.unwrap();
    assert_eq!(response.status, 302);
    assert_eq!(updates.len(), 1);
    assert!(
        destination.accept().is_err(),
        "cross-origin destination must never be contacted"
    );
    let url = url::Url::parse(&format!("{origin}/write")).unwrap();
    let request: Request =
        serde_json::from_value(json!({"url":url,"method":"POST","json_body":{"write":true}}))
            .unwrap();
    let (response, _) = send(&url, &request, cookies()).await.unwrap();
    assert_eq!(response.status, 503);
    assert!(!response.text.contains("synthetic-login"));
    assert!(!response.text.contains("not-for-model"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fixture.join().unwrap();
}
