//! Bounded request/response policy, independent of native platform FFI.
#![forbid(unsafe_code)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::webview::Cookie;
use url::Url;

pub(super) const MAX_BODY: usize = 1024 * 1024;
const PAGE_BYTES: usize = 4096;
const TTL: Duration = Duration::from_secs(120);

#[derive(Default, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(super) enum Method {
    #[default]
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Auth {
    #[default]
    Auto,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    url: String,
    #[serde(default)]
    method: Method,
    #[serde(default, rename = "auth")]
    _auth: Auth,
    #[serde(default, deserialize_with = "present_json")]
    pub(super) json_body: Option<Value>,
}
fn present_json<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

impl Request {
    pub(super) fn action(&self) -> bool {
        !matches!(self.method, Method::Get | Method::Head)
    }
    pub(super) fn method(&self) -> reqwest::Method {
        match self.method {
            Method::Get => reqwest::Method::GET,
            Method::Head => reqwest::Method::HEAD,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        }
    }
    pub(super) fn validate(&self, page: &Url) -> Result<Url, String> {
        let url = Url::parse(&self.url).map_err(|_| "invalid browser request URL")?;
        if self.url.len() > 4096
            || !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.origin() != page.origin()
        {
            return Err("browser request requires the exact delegated HTTP(S) origin without credentials or fragment".into());
        }
        if let Some(body) = &self.json_body {
            if !self.action()
                || serde_json::to_vec(body)
                    .map_err(|_| "invalid JSON body")?
                    .len()
                    > 16 * 1024
            {
                return Err("JSON body requires a write method and at most 16 KiB".into());
            }
        }
        Ok(url)
    }
}

fn scoped(cookie: &Cookie<'_>, url: &Url, now: i64) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(domain) = cookie.domain() else {
        return false;
    };
    let domain_matches = host.eq_ignore_ascii_case(domain);
    let path = cookie.path().unwrap_or("/");
    let request = url.path();
    let path_matches = request == path
        || (request.starts_with(path)
            && (path.ends_with('/') || request.as_bytes().get(path.len()) == Some(&b'/')));
    domain_matches
        && path_matches
        && (!cookie.secure().unwrap_or(false) || url.scheme() == "https")
        && cookie
            .expires_datetime()
            .is_none_or(|expiry| expiry.unix_timestamp() > now)
        && cookie.max_age().is_none_or(|age| age.whole_seconds() > 0)
}

pub(super) fn cookie_header(
    cookies: Vec<Cookie<'static>>,
    url: &Url,
) -> Result<(String, Vec<String>), String> {
    if cookies.len() > 256 {
        return Err("native login state exceeds cookie count budget".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock unavailable")?
        .as_secs() as i64;
    // Redact reflections of *all* native store values too, not just sent ones.
    let secrets = cookies
        .iter()
        .map(|cookie| cookie.value().to_owned())
        .collect();
    let mut selected: Vec<_> = cookies
        .into_iter()
        .filter(|cookie| scoped(cookie, url, now))
        .collect();
    selected.sort_by_key(|cookie| std::cmp::Reverse(cookie.path().unwrap_or("/").len()));
    let mut header = String::new();
    for cookie in selected {
        if !valid_cookie(&cookie) {
            return Err("native login state cannot be used for HTTP".into());
        }
        if !header.is_empty() {
            header.push_str("; ");
        }
        header.push_str(cookie.name());
        header.push('=');
        header.push_str(cookie.value());
        if header.len() > 16 * 1024 {
            return Err("native login state exceeds HTTP header budget".into());
        }
    }
    Ok((header, secrets))
}

fn valid_cookie(cookie: &Cookie<'_>) -> bool {
    !cookie.name().is_empty()
        && cookie
            .name()
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
        && cookie.value().bytes().all(|c| {
            c == 0x21
                || (0x23..=0x2b).contains(&c)
                || (0x2d..=0x3a).contains(&c)
                || (0x3c..=0x5b).contains(&c)
                || (0x5d..=0x7e).contains(&c)
        })
}

pub(super) fn cookie_update(mut cookie: Cookie<'static>, url: &Url) -> Option<Cookie<'static>> {
    if !valid_cookie(&cookie) {
        return None;
    }
    let host = url.host_str()?;
    // No widening the browser store to a parent/public-suffix domain via this
    // HTTP adapter. Sites requiring that must use normal browser interactions.
    if cookie
        .domain()
        .is_some_and(|domain| !domain.eq_ignore_ascii_case(host))
        || (cookie.secure().unwrap_or(false) && url.scheme() != "https")
    {
        return None;
    }
    if cookie.name().starts_with("__Host-") && cookie.domain().is_some() {
        return None;
    }
    cookie.set_domain(host.to_owned());
    if cookie.path().is_none_or(|path| !path.starts_with('/')) {
        let path = url
            .path()
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .filter(|parent| !parent.is_empty())
            .unwrap_or("/");
        cookie.set_path(path.to_owned());
    }
    if cookie.name().starts_with("__Secure-") && !cookie.secure().unwrap_or(false) {
        return None;
    }
    if cookie.name().starts_with("__Host-")
        && (!cookie.secure().unwrap_or(false) || cookie.path() != Some("/"))
    {
        return None;
    }
    Some(cookie)
}

pub(super) fn media_type(header: Option<&reqwest::header::HeaderValue>) -> &'static str {
    match header
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
    {
        "application/json" => "application/json",
        "text/html" => "text/html",
        _ => "text/plain",
    }
}

pub(super) fn sanitize(body: &str, secrets: Vec<String>) -> Result<String, String> {
    let mut patterns = Vec::new();
    for secret in secrets.into_iter().filter(|secret| !secret.is_empty()) {
        patterns.push(url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>());
        let escaped = serde_json::to_string(&secret).map_err(|_| "invalid native login state")?;
        patterns.push(escaped[1..escaped.len() - 1].to_owned());
        patterns.push(secret);
    }
    patterns.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    patterns.dedup();
    fn redact(text: &str, patterns: &[String]) -> Result<String, String> {
        // One pass: replacement markers must never be reprocessed as secrets.
        let mut out = String::new();
        let mut offset = 0;
        while offset < text.len() {
            if let Some(pattern) = patterns
                .iter()
                .find(|pattern| text[offset..].starts_with(pattern.as_str()))
            {
                out.push_str("[redacted]");
                offset += pattern.len();
            } else {
                let ch = text[offset..]
                    .chars()
                    .next()
                    .ok_or("invalid response text")?;
                out.push(ch);
                offset += ch.len_utf8();
            }
            if out.len() > MAX_BODY {
                return Err("sanitized browser response exceeds storage budget".into());
            }
        }
        Ok(out)
    }
    fn redact_json(value: &mut Value, patterns: &[String]) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                let mut clean = serde_json::Map::new();
                for (key, mut value) in std::mem::take(map) {
                    let normalized = key.to_ascii_lowercase().replace('-', "_");
                    if matches!(
                        normalized.as_str(),
                        "cookie"
                            | "cookies"
                            | "set_cookie"
                            | "authorization"
                            | "password"
                            | "secret"
                            | "api_key"
                    ) || normalized.ends_with("_token")
                    {
                        value = json!("[redacted]");
                    } else {
                        redact_json(&mut value, patterns)?;
                    }
                    clean.insert(redact(&key, patterns)?, value);
                }
                *map = clean;
            }
            Value::Array(values) => {
                for value in values {
                    redact_json(value, patterns)?;
                }
            }
            Value::String(text) => *text = redact(text, patterns)?,
            _ => {
                let text = value.to_string();
                let clean = redact(&text, patterns)?;
                if clean != text {
                    *value = Value::String(clean);
                }
            }
        }
        Ok(())
    }
    let text = match serde_json::from_str::<Value>(body) {
        Ok(mut value) => {
            redact_json(&mut value, &patterns)?;
            value.to_string()
        }
        Err(_) => redact(body, &patterns)?,
    };
    if text.len() > MAX_BODY {
        return Err("sanitized browser response exceeds storage budget".into());
    }
    Ok(text)
}

pub(super) struct Response {
    pub status: u16,
    pub format: &'static str,
    pub text: String,
}
struct Entry {
    id: String,
    owner: String,
    epoch: u64,
    expires: Instant,
    response: Response,
}
/// One bounded, sanitized response per native tab; never disk/session history.
#[derive(Default)]
pub(crate) struct Responses(Mutex<Option<Entry>>);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Read {
    result_ref: String,
    #[serde(default)]
    offset: usize,
    json_pointer: Option<String>,
}
impl Responses {
    pub(crate) fn clear(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
    pub(super) fn insert(
        &self,
        owner: &str,
        epoch: u64,
        response: Response,
    ) -> Result<Value, String> {
        let entry = Entry {
            id: crate::browser_inspect::frame_id()?,
            owner: owner.into(),
            epoch,
            expires: Instant::now() + TTL,
            response,
        };
        let page = entry.page(0, None)?;
        *self
            .0
            .lock()
            .map_err(|_| "browser response store unavailable")? = Some(entry);
        Ok(page)
    }
    pub(super) fn read(&self, owner: &str, epoch: u64, read: Read) -> Result<Value, String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "browser response store unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|entry| entry.expires <= Instant::now())
        {
            *slot = None
        }
        let entry = slot
            .as_ref()
            .filter(|entry| {
                entry.id == read.result_ref && entry.owner == owner && entry.epoch == epoch
            })
            .ok_or(
                "browser response expired or scope changed; make a new observation before deciding",
            )?;
        entry.page(read.offset, read.json_pointer.as_deref())
    }
}
impl Entry {
    fn page(&self, offset: usize, pointer: Option<&str>) -> Result<Value, String> {
        let selected = if let Some(pointer) = pointer {
            if pointer.len() > 512 || (!pointer.is_empty() && !pointer.starts_with('/')) {
                return Err("invalid JSON pointer".into());
            }
            let json: Value = serde_json::from_str(&self.response.text)
                .map_err(|_| "browser response is not JSON")?;
            Some(
                json.pointer(pointer)
                    .ok_or("JSON pointer not found")?
                    .to_string(),
            )
        } else {
            None
        };
        let text = selected.as_deref().unwrap_or(&self.response.text);
        if offset > text.len() || !text.is_char_boundary(offset) {
            return Err("response offset is not a valid UTF-8 boundary".into());
        }
        let mut end = offset.saturating_add(PAGE_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(
            json!({"ok":(200..300).contains(&self.response.status),"status":self.response.status,"content_type":self.response.format,"authentication":"browser","untrusted":true,"result_ref":self.id,"text":&text[offset..end],"total_bytes":text.len(),"next_offset":(end < text.len()).then_some(end)}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cookie(raw: &str) -> Cookie<'static> {
        Cookie::parse(raw.to_owned()).unwrap()
    }
    #[test]
    fn exact_origin_and_no_model_credentials() {
        let page = Url::parse("https://example.com/chat").unwrap();
        for url in [
            "http://example.com/",
            "https://example.com:444/",
            "https://sub.example.com/",
            "https://example.com.evil/",
            "https://user:pass@example.com/",
            "https://example.com/#secret",
            "file:///tmp/cookies",
        ] {
            let request: Request = serde_json::from_value(json!({"url":url})).unwrap();
            assert!(request.validate(&page).is_err(), "{url}");
        }
        for extra in [
            json!({"headers":{"Cookie":"secret"}}),
            json!({"owner":"other"}),
            json!({"tab_id":"other"}),
            json!({"auth":"none"}),
            json!({"method":"TRACE"}),
        ] {
            let mut value = json!({"url":"https://example.com/api"});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        let get: Request =
            serde_json::from_value(json!({"url":"https://example.com/api"})).unwrap();
        assert!(get.validate(&page).is_ok());
        assert!(!get.action());
        let post: Request = serde_json::from_value(
            json!({"url":"https://example.com/api","method":"POST","json_body":{"q":"x"}}),
        )
        .unwrap();
        assert!(post.validate(&page).is_ok());
        assert!(post.action());
        let null_post: Request = serde_json::from_value(
            json!({"url":"https://example.com/api","method":"POST","json_body":null}),
        )
        .unwrap();
        assert_eq!(null_post.json_body, Some(Value::Null));
        assert!(null_post.validate(&page).is_ok());
        let null_get: Request =
            serde_json::from_value(json!({"url":"https://example.com/api","json_body":null}))
                .unwrap();
        assert!(null_get.validate(&page).is_err());
        let body_get: Request =
            serde_json::from_value(json!({"url":"https://example.com/api","json_body":{}}))
                .unwrap();
        assert!(body_get.validate(&page).is_err());
        let huge: Request = serde_json::from_value(
            json!({"url":"https://example.com/api","method":"POST","json_body":"x".repeat(16385)}),
        )
        .unwrap();
        assert!(huge.validate(&page).is_err());
    }
    #[test]
    fn native_cookie_rfc_scope_and_path_order_including_http_only() {
        let cookies = vec![cookie("root=one; Domain=example.com; Path=/; HttpOnly"), cookie("deep=two; Domain=.example.com; Path=/api"), cookie("wrong_path=private; Domain=example.com; Path=/apis"),cookie("foreign=private; Domain=other.com; Path=/"),cookie("expired=private; Domain=example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),cookie("deleted=private; Domain=example.com; Path=/; Max-Age=0"),cookie("secure=three; Domain=example.com; Path=/; Secure")];
        let (header, _) = cookie_header(
            cookies.clone(),
            &Url::parse("https://example.com/api/items").unwrap(),
        )
        .unwrap();
        assert_eq!(header, "deep=two; root=one; secure=three");
        let (header, _) = cookie_header(
            cookies.clone(),
            &Url::parse("http://example.com/api/items").unwrap(),
        )
        .unwrap();
        assert_eq!(header, "deep=two; root=one");
        let (header, _) = cookie_header(
            cookies.clone(),
            &Url::parse("https://example.com/apiary").unwrap(),
        )
        .unwrap();
        assert_eq!(header, "root=one; secure=three");
        let host_only = cookie("sid=host; Domain=example.com; Path=/");
        assert!(!scoped(
            &host_only,
            &Url::parse("https://sub.example.com/").unwrap(),
            1
        ));
    }
    #[test]
    fn cookie_updates_cannot_widen_scope_or_downgrade_secure() {
        let https = Url::parse("https://example.com/api/login").unwrap();
        for raw in [
            "sid=secret; Domain=com",
            "sid=secret; Domain=..example.com",
            "sid=secret; Domain=other.com",
            "__Secure-sid=secret",
            "__Host-sid=secret; Secure; Path=/api",
        ] {
            assert!(cookie_update(cookie(raw), &https).is_none());
        }
        let updated = cookie_update(cookie("sid=rotated; HttpOnly; Secure"), &https).unwrap();
        assert_eq!(updated.domain(), Some("example.com"));
        assert_eq!(updated.path(), Some("/api"));
        assert_eq!(updated.http_only(), Some(true));
        assert!(cookie_update(
            cookie("sid=secret; Secure"),
            &Url::parse("http://example.com/").unwrap()
        )
        .is_none());
    }
    #[test]
    fn reflected_credentials_are_removed_before_cache_and_pagination() {
        let secret = "synthetic-private-session";
        let body=json!({"echo":format!("auth={secret}"),"nested":{"access_token":"other-secret"},"items":[{"set-cookie":"new-secret"}],"title":"Visible"}).to_string();
        let clean = sanitize(&body, vec![secret.into()]).unwrap();
        assert!(!clean.contains(secret));
        assert!(!clean.contains("other-secret"));
        assert!(!clean.contains("new-secret"));
        assert_eq!(
            serde_json::from_str::<Value>(&clean).unwrap()["title"],
            "Visible"
        );
        let numeric = sanitize(
            r#"{"value":123,"echo":"a redacted"}"#,
            vec!["123".into(), "a".into(), "red".into()],
        )
        .unwrap();
        assert!(serde_json::from_str::<Value>(&numeric).is_ok());
        assert!(!numeric.contains("123"));
        let clean = sanitize("escaped=a%2Fb raw=a/b", vec!["a/b".into()]).unwrap();
        assert!(!clean.contains("a/b"));
        assert!(!clean.contains("a%2Fb"));
    }
    #[test]
    fn response_is_bounded_repeatable_paged_selected_expired_and_owner_scoped() {
        let store = Responses::default();
        let text = json!({"huge":"中".repeat(5000),"title":"Useful"}).to_string();
        let first = store
            .insert(
                "a",
                7,
                Response {
                    status: 200,
                    format: "application/json",
                    text: text.clone(),
                },
            )
            .unwrap();
        assert!(first["text"].as_str().unwrap().len() <= 4096);
        let id = first["result_ref"].as_str().unwrap();
        let read =
            |owner, epoch, args| store.read(owner, epoch, serde_json::from_value(args).unwrap());
        let selected = read("a", 7, json!({"result_ref":id,"json_pointer":"/title"})).unwrap();
        assert_eq!(selected["text"], "\"Useful\"");
        assert_eq!(read("a", 7, json!({"result_ref":id})).unwrap(), first);
        assert!(read("b", 7, json!({"result_ref":id})).is_err());
        assert!(read("a", 8, json!({"result_ref":id})).is_err());
        let mut restored = first["text"].as_str().unwrap().to_owned();
        let mut page = first.clone();
        while let Some(offset) = page["next_offset"].as_u64() {
            page = read("a", 7, json!({"result_ref":id,"offset":offset})).unwrap();
            restored.push_str(page["text"].as_str().unwrap());
        }
        assert_eq!(restored, text);
        assert!(read("a", 7, json!({"result_ref":id,"offset":MAX_BODY+1})).is_err());
        store.0.lock().unwrap().as_mut().unwrap().expires = Instant::now();
        assert!(read("a", 7, json!({"result_ref":id})).is_err());
        assert!(store.0.lock().unwrap().is_none());
        let old = store
            .insert(
                "a",
                7,
                Response {
                    status: 200,
                    format: "text/plain",
                    text: "old".into(),
                },
            )
            .unwrap();
        store
            .insert(
                "a",
                7,
                Response {
                    status: 200,
                    format: "text/plain",
                    text: "new".into(),
                },
            )
            .unwrap();
        assert!(read("a", 7, json!({"result_ref":old["result_ref"]})).is_err());
        store.clear();
        assert!(store.0.lock().unwrap().is_none());
    }
}
