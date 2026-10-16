use crate::{bounded_string, Error, CDN_BASE, MAX_CURSOR_BYTES, MAX_JSON_BYTES, MAX_TEXT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::HeaderMap, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct BotToken(pub(crate) String);
impl BotToken {
    pub fn new(value: String) -> Result<Self, Error> {
        // Header-safe opaque token; do not impose a community token grammar.
        if value.is_empty()
            || value.len() > 4096
            || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(Error::Configuration);
        }
        Ok(Self(value))
    }
    /// Only for trusted native credential storage, never relay or controller UI.
    pub fn expose_for_native_store(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for BotToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BotToken([redacted])")
    }
}

pub struct Credentials {
    pub(crate) token: BotToken,
    pub(crate) api_base: Url,
    pub(crate) bot_id: String,
    pub(crate) owner_id: String,
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials([redacted])")
    }
}
impl Credentials {
    /// Restore only trusted configuration from a native credential reference.
    /// Validation is not an online identity/eligibility check.
    pub fn new(
        token: BotToken,
        api_base: &str,
        bot_id: String,
        owner_id: String,
    ) -> Result<Self, Error> {
        if !bounded_string(&bot_id, 512) || !bounded_string(&owner_id, 512) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            token,
            api_base: production_api_base(api_base)?,
            bot_id,
            owner_id,
        })
    }
    pub fn token_for_native_store(&self) -> &BotToken {
        &self.token
    }
    pub fn api_base(&self) -> &str {
        self.api_base.as_str()
    }
    pub fn bot_id(&self) -> &str {
        &self.bot_id
    }
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
}

pub(crate) struct Http {
    pub(crate) client: reqwest::Client,
    pub(crate) api_base: Url,
    pub(crate) cdn_base: Url,
    pub(crate) fixture_origin: Option<Url>,
}
impl Http {
    pub(crate) fn production(api_base: Url) -> Result<Self, Error> {
        Self::build(
            api_base,
            Url::parse(CDN_BASE).map_err(|_| Error::Configuration)?,
            None,
        )
    }
    pub(crate) fn loopback(base: &str) -> Result<Self, Error> {
        let url = Url::parse(base).map_err(|_| Error::Configuration)?;
        if url.scheme() != "http"
            || !url
                .host_str()
                .is_some_and(|h| matches!(h, "127.0.0.1" | "[::1]" | "::1"))
            || url.path() != "/"
            || !clean_authority(&url)
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Configuration);
        }
        Self::build(
            url.clone(),
            url.join("c2c/").map_err(|_| Error::Configuration)?,
            Some(url),
        )
    }
    fn build(api_base: Url, cdn_base: Url, fixture_origin: Option<Url>) -> Result<Self, Error> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| Error::Configuration)?;
        Ok(Self {
            client,
            api_base,
            cdn_base,
            fixture_origin,
        })
    }
    pub(crate) fn validate_api(&self, value: &str) -> Result<Url, Error> {
        if let Some(origin) = &self.fixture_origin {
            let url = Url::parse(value).map_err(|_| Error::Configuration)?;
            if url.origin() == origin.origin()
                && url.path() == "/"
                && clean_authority(&url)
                && url.query().is_none()
                && url.fragment().is_none()
            {
                return Ok(url);
            }
            return Err(Error::Configuration);
        }
        production_api_base(value)
    }
    pub(crate) fn validate_cdn(&self, value: &str) -> Result<Url, Error> {
        let url = Url::parse(value).map_err(|_| Error::InvalidMedia)?;
        if !clean_authority(&url) || url.fragment().is_some() {
            return Err(Error::InvalidMedia);
        }
        if let Some(origin) = &self.fixture_origin {
            if url.origin() == origin.origin() {
                return Ok(url);
            }
            return Err(Error::InvalidMedia);
        }
        // Narrow first-party CDN boundary; unknown new CDN domains require an
        // explicit compatibility update, not arbitrary URL fetches or redirects.
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url
                .host_str()
                .is_some_and(|h| h.ends_with(".cdn.weixin.qq.com"))
        {
            return Err(Error::InvalidMedia);
        }
        Ok(url)
    }
    pub(crate) async fn json(
        &self,
        request: reqwest::RequestBuilder,
        mutating: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(if mutating { Error::AmbiguousSend } else { Error::Cancelled }),
            result = async {
                let response = request.send().await.map_err(|e| transport_error(e, mutating))?;
                let status = response.status().as_u16();
                if (300..400).contains(&status) { return Err(if mutating { Error::AmbiguousSend } else { Error::Rejected { code: i64::from(status) } }); }
                let raw = bounded(response, MAX_JSON_BYTES).await.map_err(|e| if mutating { Error::AmbiguousSend } else { e })?;
                let value: Value = serde_json::from_slice(&raw).map_err(|_| if mutating { Error::AmbiguousSend } else { Error::MalformedResponse })?;
                if !value.is_object() { return Err(if mutating { Error::AmbiguousSend } else { Error::MalformedResponse }); }
                check_result(&value, status, mutating)?;
                Ok(value)
            } => result,
        }
    }
    pub(crate) fn post(
        &self,
        path: &str,
        token: Option<&BotToken>,
        payload: Value,
    ) -> Result<reqwest::RequestBuilder, Error> {
        let url = self.api_base.join(path).map_err(|_| Error::Configuration)?;
        let mut headers = common_headers()?;
        headers.insert(
            "AuthorizationType",
            "ilink_bot_token"
                .parse()
                .map_err(|_| Error::Configuration)?,
        );
        let mut random = [0u8; 4];
        getrandom::getrandom(&mut random).map_err(|_| Error::Configuration)?;
        let uin = STANDARD.encode(u32::from_be_bytes(random).to_string());
        headers.insert(
            "X-WECHAT-UIN",
            uin.parse().map_err(|_| Error::Configuration)?,
        );
        let request = self.client.post(url).headers(headers).json(&payload);
        Ok(match token {
            Some(token) => request.bearer_auth(&token.0),
            None => request,
        })
    }
}

pub(crate) fn common_headers() -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "iLink-App-Id",
        "bot".parse().map_err(|_| Error::Configuration)?,
    );
    // Independent XHarness protocol-client version, not an OpenClaw impersonation.
    let components: Vec<u32> = env!("CARGO_PKG_VERSION")
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| Error::Configuration)?;
    if components.len() != 3 || components.iter().any(|n| *n > 255) {
        return Err(Error::Configuration);
    }
    let version = (components[0] << 16) | (components[1] << 8) | components[2];
    headers.insert(
        "iLink-App-ClientVersion",
        version
            .to_string()
            .parse()
            .map_err(|_| Error::Configuration)?,
    );
    Ok(headers)
}
fn clean_authority(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none()
}
pub(crate) fn production_api_base(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| Error::Configuration)?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url
            .host_str()
            .is_some_and(|h| h.ends_with(".weixin.qq.com"))
        || url.path() != "/"
        || !clean_authority(&url)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Configuration);
    }
    Ok(url)
}
pub(crate) fn base_info() -> Value {
    json!({"channel_version":env!("CARGO_PKG_VERSION"),"bot_agent":concat!("XHarness/",env!("CARGO_PKG_VERSION"))})
}
pub(crate) fn transport_error(error: reqwest::Error, mutating: bool) -> Error {
    if mutating {
        Error::AmbiguousSend
    } else if error.is_timeout() {
        Error::Timeout
    } else {
        Error::Transport
    }
}
pub(crate) async fn bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(Error::MalformedResponse);
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
        if data.len().saturating_add(chunk.len()) > limit {
            return Err(Error::MalformedResponse);
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
fn check_result(value: &Value, status: u16, mutating: bool) -> Result<(), Error> {
    for key in ["ret", "errcode"] {
        if value.get(key).is_some_and(|v| !v.is_i64()) {
            return Err(if mutating {
                Error::AmbiguousSend
            } else {
                Error::MalformedResponse
            });
        }
    }
    let ret = value.get("ret").and_then(Value::as_i64);
    let err = value.get("errcode").and_then(Value::as_i64);
    if ret == Some(-14) || err == Some(-14) {
        return Err(Error::SessionExpired);
    }
    if matches!(status, 401 | 403) {
        return Err(Error::Unauthorized);
    }
    if status == 429 {
        return Err(Error::RateLimited);
    }
    if !(200..300).contains(&status) {
        return Err(if mutating && status >= 500 {
            Error::AmbiguousSend
        } else {
            Error::Rejected {
                code: i64::from(status),
            }
        });
    }
    if let Some(code) = ret.filter(|v| *v != 0).or_else(|| err.filter(|v| *v != 0)) {
        return Err(Error::Rejected { code });
    }
    // QR responses do not consistently contain ret. A message mutation cannot
    // be called successful based on an unproved empty/unknown response.
    if mutating && ret != Some(0) {
        return Err(Error::AmbiguousSend);
    }
    Ok(())
}

pub struct Client {
    pub(crate) http: Http,
    pub(crate) token: BotToken,
    bot_id: String,
}
impl Client {
    pub fn from_credentials(credentials: Credentials) -> Result<Self, Error> {
        Ok(Self {
            http: Http::production(credentials.api_base)?,
            token: credentials.token,
            bot_id: credentials.bot_id,
        })
    }
    /// Isolated HTTP fixture only; does not imply production pairing/identity.
    pub fn loopback_fixture(token: BotToken, bot_id: String, base: &str) -> Result<Self, Error> {
        if !bounded_string(&bot_id, 512) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            http: Http::loopback(base)?,
            token,
            bot_id,
        })
    }
    pub fn bot_id(&self) -> &str {
        &self.bot_id
    }
    /// Returns an opaque *batch* cursor. The caller must durably admit/reject the
    /// whole batch before using it; this client neither writes nor advances it.
    pub async fn get_updates(
        &self,
        cursor: &str,
        cancel: &CancellationToken,
    ) -> Result<Updates, Error> {
        if cursor.len() > MAX_CURSOR_BYTES || cursor.contains('\0') {
            return Err(Error::Configuration);
        }
        let request = self.http.post(
            "ilink/bot/getupdates",
            Some(&self.token),
            json!({"get_updates_buf":cursor,"base_info":base_info()}),
        )?;
        let value = self.http.json(request, false, cancel).await?;
        let raw: UpdatesWire =
            serde_json::from_value(value).map_err(|_| Error::MalformedResponse)?;
        if raw.ret != Some(0)
            || raw.msgs.len() > 256
            || raw.get_updates_buf.len() > MAX_CURSOR_BYTES
            || raw.get_updates_buf.contains('\0')
        {
            return Err(Error::MalformedResponse);
        }
        if !raw.msgs.is_empty() && raw.get_updates_buf.is_empty() {
            return Err(Error::MalformedResponse);
        }
        Ok(Updates {
            messages: raw.msgs,
            next_cursor: raw.get_updates_buf,
            suggested_timeout_ms: raw
                .longpolling_timeout_ms
                .filter(|n| (1000..=45000).contains(n)),
        })
    }
    pub async fn send_text(
        &self,
        to: &str,
        context_token: &str,
        client_id: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if text.is_empty() || text.len() > MAX_TEXT_BYTES || text.contains('\0') {
            return Err(Error::Configuration);
        }
        self.send_item(
            to,
            context_token,
            client_id,
            json!({"type":1,"text_item":{"text":text}}),
            cancel,
        )
        .await
    }
    pub(crate) async fn send_item(
        &self,
        to: &str,
        context_token: &str,
        client_id: &str,
        item: Value,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if !bounded_string(to, 512)
            || !bounded_string(context_token, 16 * 1024)
            || !bounded_string(client_id, 128)
        {
            return Err(Error::Configuration);
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let request = self.http.post("ilink/bot/sendmessage", Some(&self.token), json!({"msg":{"from_user_id":"","to_user_id":to,"client_id":client_id,"message_type":2,"message_state":2,"context_token":context_token,"item_list":[item]},"base_info":base_info()}))?;
        self.http.json(request, true, cancel).await?;
        Ok(())
    }
}
#[derive(Deserialize)]
struct UpdatesWire {
    ret: Option<i64>,
    msgs: Vec<Value>,
    get_updates_buf: String,
    longpolling_timeout_ms: Option<u32>,
}
/// No Debug: raw provider messages can contain secret context/media tokens.
pub struct Updates {
    pub messages: Vec<Value>,
    pub next_cursor: String,
    pub suggested_timeout_ms: Option<u32>,
}
