//! Real engine/store + HTTP + private bridge. Synthetic test cookies only.
//! Runs inside the existing disposable native probe, never the user's profile.
use crate::{browser, browser_bridge, browser_delegation, readiness};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;

struct Fixture {
    origin: String,
    calls: Arc<AtomicUsize>,
    traffic: Arc<Mutex<Vec<String>>>,
    writes: Arc<AtomicUsize>,
    slow: Arc<AtomicUsize>,
    redirected: Arc<AtomicUsize>,
}
// Keep the page self-contained: WebView2 may otherwise fetch an implicit
// favicon concurrently with the later no-dispatch assertions. Do not ignore
// such requests in the counter; record every request for failure attribution.
const PAGE: &str = "<!doctype html><link rel=icon href=\"data:,\"><title>Login request probe</title><main>Signed in</main>";

fn record_request(calls: &AtomicUsize, traffic: &Mutex<Vec<String>>, raw: &str) {
    let mut first = raw.lines().next().unwrap_or("").split_whitespace();
    let method = match first.next() {
        Some("GET") => "GET",
        Some("POST") => "POST",
        Some("HEAD") => "HEAD",
        _ => "other-method",
    };
    // Never log headers, bodies, query values or native cookie contents.
    let route = first
        .next()
        .filter(|path| {
            matches!(
                *path,
                "/" | "/api"
                    | "/favicon.ico"
                    | "/redirect"
                    | "/rotate"
                    | "/logout"
                    | "/write"
                    | "/large"
                    | "/slow"
            )
        })
        .unwrap_or("other-route");
    let mut observed = traffic.lock().unwrap();
    if observed.len() < 64 {
        observed.push(format!("{method} {route}"));
    }
    calls.fetch_add(1, Ordering::SeqCst);
}

fn fixture() -> Fixture {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    let other = format!("http://{}/destination", destination.local_addr().unwrap());
    let redirected = Arc::new(AtomicUsize::new(0));
    let count = redirected.clone();
    std::thread::spawn(move || {
        for stream in destination.incoming() {
            if stream.is_ok() {
                count.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let traffic = Arc::new(Mutex::new(Vec::new()));
    let observed = traffic.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let slow = Arc::new(AtomicUsize::new(0));
    let (count, changed, started) = (calls.clone(), writes.clone(), slow.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let (count, changed, started, other) = (
                count.clone(),
                changed.clone(),
                started.clone(),
                other.clone(),
            );
            let observed = observed.clone();
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut input = Vec::new();
                let mut buffer = [0; 2048];
                while input.len() < 32768 && !input.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => input.extend_from_slice(&buffer[..n]),
                    }
                }
                let raw = String::from_utf8_lossy(&input);
                let path = raw
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("");
                let cookie = raw
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("cookie"))
                            .map(|(_, value)| value.trim())
                    })
                    .unwrap_or("");
                record_request(&count, &observed, &raw);
                let (status,headers,body)=match path {
                "/"=>(200,"Set-Cookie: auth=synthetic-native-login; Path=/; HttpOnly\r\nSet-Cookie: wrong_path=synthetic-path-secret; Path=/other\r\n".to_owned(),PAGE.to_owned()),
                "/redirect"=>(302,format!("Location: {other}\r\n"),String::new()),
                "/rotate"=>(200,"Set-Cookie: auth=synthetic-native-rotated; Path=/; HttpOnly\r\n".into(),"rotated".into()),
                "/logout"=>(200,"Set-Cookie: auth=; Path=/; Max-Age=0; HttpOnly\r\n".into(),"logged out".into()),
                "/write"=>{changed.fetch_add(1,Ordering::SeqCst);(503,String::new(),"failed after write".into())},
                "/large"=>(200,"Content-Type: application/json\r\n".into(),json!({"items":"中".repeat(8000),"title":"Useful"}).to_string()),
                "/slow"=>{started.fetch_add(1,Ordering::SeqCst);std::thread::sleep(Duration::from_millis(700));(200,String::new(),"late private response".into())},
                _=>{let logged_in=cookie.contains("auth=synthetic-native-login")||cookie.contains("auth=synthetic-native-rotated");(if logged_in {200}else{401},"Content-Type: application/json\r\n".into(),json!({"authenticated":logged_in,"rotated":cookie.contains("auth=synthetic-native-rotated"),"wrong_path":cookie.contains("wrong_path="),"echo":cookie}).to_string())}
            };
                let _=write!(stream,"HTTP/1.1 {status} Test\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            });
        }
    });
    Fixture {
        origin,
        calls,
        traffic,
        writes,
        slow,
        redirected,
    }
}

async fn grant(
    app: &tauri::AppHandle,
    owner: &str,
    origin: &str,
    actions: bool,
) -> Result<(), String> {
    browser_delegation::desktop_browser_delegate(
        app.get_webview("main").unwrap(),
        app.state(),
        "request-probe".into(),
        Some(owner.into()),
        actions,
        Some(origin.into()),
    )
    .await?;
    Ok(())
}
async fn call(
    connection: &browser_bridge::Connection,
    owner: &str,
    op: &str,
    arguments: Value,
) -> Result<Value, String> {
    let value = crate::bridge_call(connection, owner, op, arguments).await?;
    if value.to_string().contains("synthetic-native-login")
        || value.to_string().contains("synthetic-native-rotated")
        || value.to_string().contains("synthetic-path-secret")
    {
        return Err("native cookie leaked through the private tool reply".into());
    }
    Ok(value)
}

pub async fn run(app: &tauri::AppHandle) -> Result<(), String> {
    let fixture = fixture();
    let origin = &fixture.origin;
    let owner = "request-owner";
    let main = app.get_webview("main").ok_or("missing main view")?;
    browser::desktop_browser_bounds(
        main.clone(),
        app.state(),
        serde_json::from_value(json!({"x":0,"y":0,"width":780,"height":560})).unwrap(),
        None,
    )
    .await?;
    browser::desktop_browser_activate(main.clone(), app.state(), Some("request-probe".into()))
        .await?;
    browser::desktop_browser_navigate(
        app.clone(),
        main.clone(),
        app.state(),
        "request-probe".into(),
        format!("{origin}/"),
    )
    .await?;
    readiness::wait(
        Duration::from_secs(6),
        Duration::from_millis(50),
        || async {
            grant(app, owner, origin, false).await?;
            app.state::<browser::BrowserState>()
                .loaded_receipt(owner, "request-probe")?;
            Ok(true)
        },
    )
    .await?;
    let state = app.state::<browser_bridge::BrowserBridge>();
    let connection = state.start(app).await?;
    let first = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/api")}),
    )
    .await?;
    if first["ok"] != true || first["result"]["status"] != 200 {
        return Err("native HttpOnly login was not reused".into());
    }
    let body: Value = serde_json::from_str(
        first["result"]["text"]
            .as_str()
            .ok_or("missing HTTP preview")?,
    )
    .map_err(|_| "invalid HTTP preview")?;
    if body["authenticated"] != true || body["wrong_path"] != false {
        return Err("native cookie scope was not preserved".into());
    }
    let (view, _) = app
        .state::<browser::BrowserState>()
        .inspection_target("request-probe")?;
    if crate::evidence(&view, "document.cookie")
        .await?
        .as_str()
        .unwrap_or("")
        .contains("auth=")
    {
        return Err("fixture HttpOnly cookie was readable to JS".into());
    }
    let before = fixture.calls.load(Ordering::SeqCst);
    for (caller, args) in [
        ("other-owner", json!({"url":format!("{origin}/api")})),
        (owner, json!({"url":"https://other.example/"})),
        (
            owner,
            json!({"url":format!("{origin}/write"),"method":"POST","json_body":{}}),
        ),
        (
            owner,
            json!({"url":format!("{origin}/api"),"headers":{"Cookie":"model override"}}),
        ),
    ] {
        if call(connection, caller, "request", args).await?["ok"] != false {
            return Err("native request accepted a foreign scope or read-only write".into());
        }
    }
    if fixture.calls.load(Ordering::SeqCst) != before {
        return Err(format!(
            "rejected scope contacted network: before={before}, after={}, all_requests={:?}",
            fixture.calls.load(Ordering::SeqCst),
            fixture.traffic.lock().unwrap(),
        ));
    }
    let redirected = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/redirect")}),
    )
    .await?;
    if redirected["result"]["status"] != 302 || fixture.redirected.load(Ordering::SeqCst) != 0 {
        return Err("credential-bearing redirect was followed".into());
    }
    let large = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/large")}),
    )
    .await?;
    let result = &large["result"];
    let reference = result["result_ref"].clone();
    if result["text"].as_str().unwrap_or("").len() > 4096 || !result["next_offset"].is_number() {
        return Err("large result was not bounded and referenced".into());
    }
    let before = fixture.calls.load(Ordering::SeqCst);
    for _ in 0..2 {
        let selected = call(
            connection,
            owner,
            "read_response",
            json!({"result_ref":reference,"json_pointer":"/title"}),
        )
        .await?;
        if selected["result"]["text"] != "\"Useful\"" {
            return Err("response JSON field selection failed".into());
        }
    }
    if fixture.calls.load(Ordering::SeqCst) != before {
        return Err("cached response read replayed HTTP".into());
    }
    grant(app, "other-owner", origin, true).await?;
    grant(app, owner, origin, true).await?;
    if call(
        connection,
        owner,
        "read_response",
        json!({"result_ref":reference}),
    )
    .await?["ok"]
        != false
    {
        return Err("cache resurrected after session switch".into());
    }
    let write = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/write"),"method":"POST","json_body":{}}),
    )
    .await?;
    if write["result"]["status"] != 503 || fixture.writes.load(Ordering::SeqCst) != 1 {
        return Err("write was retried or its HTTP failure hidden".into());
    }
    call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/rotate")}),
    )
    .await?;
    let rotated = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/api")}),
    )
    .await?;
    if !rotated["result"]["text"]
        .as_str()
        .unwrap_or("")
        .contains("\"rotated\":true")
    {
        return Err("rotated native login state was not refreshed".into());
    }
    call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/logout")}),
    )
    .await?;
    let logged_out = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/api")}),
    )
    .await?;
    if logged_out["result"]["status"] != 401 {
        return Err("logged-out cookie was reused from a stale cache".into());
    }
    let pending = call(
        connection,
        owner,
        "request",
        json!({"url":format!("{origin}/slow")}),
    );
    let hide = async {
        readiness::wait(
            Duration::from_secs(3),
            Duration::from_millis(10),
            || async { Ok(fixture.slow.load(Ordering::SeqCst) > 0) },
        )
        .await?;
        browser::desktop_browser_activate(main.clone(), app.state(), None).await
    };
    let (reply, hidden) = tokio::join!(pending, hide);
    hidden?;
    if reply?["ok"] != false {
        return Err("response delivered after native browser hide".into());
    }
    browser::desktop_browser_close(main, app.state(), "request-probe".into()).await?;
    println!(
        "BROWSER_SESSION_REQUEST_EVIDENCE {}",
        json!({"passed":true,"http_only_reused":true,"cookie_values_exported":false,"path_scope":true,"same_origin_only":true,"redirect_not_followed":true,"read_only_write_denied":true,"write_attempts":fixture.writes.load(Ordering::SeqCst),"bounded_preview":true,"repeatable_json_read_without_http":true,"owner_switch_revokes_cache":true,"rotation_and_logout":true,"hide_cancels_delivery":true,"test_only":true,"model_started":false,"all_request_count":fixture.calls.load(Ordering::SeqCst),"all_requests":fixture.traffic.lock().unwrap().clone()})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_request_including_favicon_still_counts_without_secret_logging() {
        let calls = AtomicUsize::new(0);
        let traffic = Mutex::new(Vec::new());
        for request in [
            "GET / HTTP/1.1\r\nCookie: synthetic-private-cookie\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\n\r\n",
            "POST /write HTTP/1.1\r\n\r\nsynthetic-private-body",
            "GET /api?token=synthetic-private-query HTTP/1.1\r\n\r\n",
        ] {
            record_request(&calls, &traffic, request);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!(
            *traffic.lock().unwrap(),
            [
                "GET /",
                "GET /favicon.ico",
                "POST /write",
                "GET other-route"
            ]
        );
        assert!(!format!("{:?}", traffic.lock().unwrap()).contains("synthetic-private"));
        assert!(PAGE.contains("<link rel=icon href=\"data:,\">"));
    }

    #[test]
    fn bounded_diagnostics_never_bound_the_strict_total_counter() {
        let calls = AtomicUsize::new(0);
        let traffic = Mutex::new(Vec::new());
        for _ in 0..100 {
            record_request(&calls, &traffic, "GET /api HTTP/1.1\r\n\r\n");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 100);
        assert_eq!(traffic.lock().unwrap().len(), 64);
    }
}
