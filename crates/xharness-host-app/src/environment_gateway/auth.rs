use axum::{
    extract::{Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::{net::SocketAddr, sync::Arc};
const COOKIE: &str = "xharness_environment";
#[derive(Clone)]
struct Auth {
    token: Arc<str>,
    origin: String,
    authority: String,
}
pub(super) fn protect(router: Router, token: String, listen: SocketAddr) -> Router {
    let state = Auth {
        token: token.into(),
        origin: format!("http://{listen}"),
        authority: listen.to_string(),
    };
    router
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .route("/environment/bootstrap", get(bootstrap).with_state(state))
}
fn matches(token: &str, candidate: &str) -> bool {
    token.len() == candidate.len()
        && token
            .bytes()
            .zip(candidate.bytes())
            .fold(0u8, |v, (a, b)| v | (a ^ b))
            == 0
}
async fn guard(State(state): State<Auth>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(state.authority.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if headers
        .get(header::ORIGIN)
        .is_some_and(|v| v.to_str().ok() != Some(state.origin.as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
    {
        // A user opens another configured origin in a new tab. Permit only
        // root document navigation, never cross-origin API/WS requests.
        let navigation = request.method() == axum::http::Method::GET
            && request.uri().path() == "/"
            && headers
                .get("sec-fetch-mode")
                .is_some_and(|v| v == "navigate")
            && headers
                .get("sec-fetch-dest")
                .is_some_and(|v| v == "document");
        if !navigation {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let token = headers
        .get("x-xharness-environment-token")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get(header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .and_then(|cookies| {
                    cookies.split(';').find_map(|c| {
                        let (k, v) = c.trim().split_once('=')?;
                        (k == COOKIE).then_some(v)
                    })
                })
        });
    if !token.is_some_and(|v| matches(&state.token, v)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    token: String,
}
async fn bootstrap(
    State(state): State<Auth>,
    Query(query): Query<Bootstrap>,
    headers: HeaderMap,
) -> Response {
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(state.authority.as_str())
        || headers
            .get(header::ORIGIN)
            .is_some_and(|v| v.to_str().ok() != Some(state.origin.as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !matches(&state.token, &query.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(cookie) = HeaderValue::from_str(&format!(
        "{COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
        query.token
    )) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut response = Redirect::to("/").into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
