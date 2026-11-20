//! Public, unguessable read-only asset capabilities; never an API credential.
#![forbid(unsafe_code)]
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures::future::BoxFuture;
use std::sync::Arc;
pub struct PluginAsset {
    pub file: std::fs::File,
    pub mime: String,
    pub bytes: u64,
}
pub trait PluginAssets: Send + Sync + 'static {
    fn open<'a>(
        &'a self,
        capability: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PluginAsset, String>>;
}
pub fn routes(assets: Arc<dyn PluginAssets>) -> Router {
    Router::new()
        .route("/plugin-panel/{capability}/{*path}", get(asset))
        .with_state(assets)
}
async fn asset(
    State(assets): State<Arc<dyn PluginAssets>>,
    Path((capability, path)): Path<(String, String)>,
    request_headers: HeaderMap,
) -> Response {
    if capability.len() != 64 || !capability.bytes().all(|c| c.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // WebKit does not treat CSP 'self' as the resource URL in an opaque
    // sandbox. Bind explicit sources to this Host and this capability prefix,
    // never allow the entire origin (and therefore never the Host API path).
    let Some(host) = request_headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if authority.host().is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let sources = format!(
        "http://{host}/plugin-panel/{capability}/ https://{host}/plugin-panel/{capability}/"
    );
    let policy=format!("default-src 'none'; script-src {sources} 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src {sources} blob: data:; font-src {sources} data: blob:; connect-src {sources}; worker-src {sources} blob:; frame-ancestors 'self'; sandbox allow-scripts allow-downloads");
    let Ok(policy) = policy.parse() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(asset) = assets.open(&capability, &path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let file = tokio::fs::File::from_std(asset.file);
    let stream = futures::stream::try_unfold(file, |mut file| async move {
        use tokio::io::AsyncReadExt;
        let mut bytes = vec![0; 65536];
        let n = file.read(&mut bytes).await?;
        if n == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            bytes.truncate(n);
            Ok(Some((bytes, file)))
        }
    });
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    let Ok(mime) = asset.mime.parse() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(length) = asset.bytes.to_string().parse() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    headers.insert(header::CONTENT_TYPE, mime);
    headers.insert(header::CONTENT_LENGTH, length);
    headers.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        axum::http::HeaderValue::from_static("null"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        axum::http::HeaderValue::from_static("cross-origin"),
    );
    headers.insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "referrer-policy",
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;
    struct Assets(std::path::PathBuf);
    impl PluginAssets for Assets {
        fn open<'a>(
            &'a self,
            cap: &'a str,
            path: &'a str,
        ) -> BoxFuture<'a, Result<PluginAsset, String>> {
            Box::pin(async move {
                if cap != "a".repeat(64) || path != "dist/panel.html" {
                    return Err("expired or forbidden".into());
                }
                Ok(PluginAsset {
                    file: std::fs::File::open(&self.0).map_err(|e| e.to_string())?,
                    mime: "text/html".into(),
                    bytes: 6,
                })
            })
        }
    }
    #[tokio::test]
    async fn capability_assets_are_streamed_opaque_non_api_and_revocable() {
        let file = std::env::temp_dir().join(format!("xh-panel-http-{}", std::process::id()));
        std::fs::write(&file, b"editor").unwrap();
        let app = routes(Arc::new(Assets(file.clone())));
        let url = format!("/plugin-panel/{}/dist/panel.html", "a".repeat(64));
        let result = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::HOST, "localhost:9000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(
            result.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "null"
        );
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "6");
        assert_eq!(result.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!result.headers().contains_key(header::SET_COOKIE));
        let policy = result.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(policy.contains("sandbox allow-scripts allow-downloads"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains(&format!(
            "http://localhost:9000/plugin-panel/{}/",
            "a".repeat(64)
        )));
        assert!(!policy.contains("connect-src *"));
        assert_eq!(to_bytes(result.into_body(), 32).await.unwrap(), "editor");
        for path in [
            format!("/plugin-panel/{}/dist/panel.html", "b".repeat(64)),
            "/plugin-panel/invalid/dist/panel.html".into(),
            format!("/plugin-panel/{}/workspace/document.docx", "a".repeat(64)),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(url)
                    .body(Body::from("write"))
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        std::fs::remove_file(file).unwrap();
    }
}
