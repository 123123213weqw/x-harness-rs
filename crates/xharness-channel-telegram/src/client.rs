//! Errors deliberately discard reqwest URLs and provider descriptions: Bot API
//! URLs contain credentials. Never derive Debug for this client/token.
use crate::Error;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;

pub struct BotToken(String);
impl std::fmt::Debug for BotToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BotToken([redacted])")
    }
}
impl BotToken {
    pub fn new(token: String) -> Result<Self, Error> {
        let (id, key) = token.split_once(':').ok_or(Error::Configuration)?;
        if id.is_empty()
            || !id.bytes().all(|b| b.is_ascii_digit())
            || key.len() < 10
            || token.len() > 256
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::Configuration);
        }
        Ok(Self(token))
    }
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    token: BotToken,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct BotUser {
    pub id: i64,
    pub is_bot: bool,
    pub username: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SentMessage {
    pub message_id: i64,
    pub chat: Chat,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InlineButton {
    pub text: String,
    pub callback_data: String,
}
#[derive(Deserialize)]
struct Envelope<T> {
    ok: bool,
    result: Option<T>,
    error_code: Option<u16>,
    parameters: Option<Parameters>,
}
#[derive(Deserialize)]
struct Parameters {
    retry_after: Option<u32>,
}
#[derive(Deserialize)]
struct File {
    file_path: Option<String>,
    file_size: Option<u64>,
}
#[derive(Deserialize)]
struct Webhook {
    url: String,
}

impl Client {
    pub fn new(token: BotToken) -> Result<Self, Error> {
        Self::endpoint(token, "https://api.telegram.org")
    }
    /// Explicit trusted fixture endpoint; only loopback HTTP is accepted. Not a
    /// controller-supplied URL, custom proxy, relay, or production alternative.
    pub fn loopback_fixture(token: BotToken, base: &str) -> Result<Self, Error> {
        let url = reqwest::Url::parse(base).map_err(|_| Error::Configuration)?;
        if url.scheme() != "http"
            || !url
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]" | "::1"))
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Configuration);
        }
        Self::endpoint(token, base.trim_end_matches('/'))
    }
    fn endpoint(token: BotToken, base: &str) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Configuration)?;
        Ok(Self {
            http,
            base: base.into(),
            token,
        })
    }
    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        payload: Value,
        mutating: bool,
    ) -> Result<T, Error> {
        let url = format!("{}/bot{}/{}", self.base, self.token.0, method);
        let response = self
            .http
            .post(url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                if mutating {
                    Error::AmbiguousSend
                } else if e.is_timeout() {
                    Error::Timeout
                } else {
                    Error::Transport
                }
            })?;
        self.decode_response(response, mutating).await
    }
    async fn decode_response<T: DeserializeOwned>(
        &self,
        response: reqwest::Response,
        mutating: bool,
    ) -> Result<T, Error> {
        let status = response.status();
        let raw = bounded(response, MAX_JSON_BYTES).await.map_err(|_| {
            if mutating {
                Error::AmbiguousSend
            } else {
                Error::MalformedResponse
            }
        })?;
        let envelope: Envelope<T> = serde_json::from_slice(&raw).map_err(|_| {
            if mutating {
                Error::AmbiguousSend
            } else {
                Error::MalformedResponse
            }
        })?;
        if envelope.ok && status.is_success() {
            return envelope.result.ok_or(if mutating {
                Error::AmbiguousSend
            } else {
                Error::MalformedResponse
            });
        }
        if envelope.ok {
            return Err(if mutating {
                Error::AmbiguousSend
            } else {
                Error::MalformedResponse
            });
        }
        match envelope.error_code.unwrap_or(status.as_u16()) {
            401 => Err(Error::Unauthorized),
            409 => Err(Error::Conflict),
            429 => Err(Error::RateLimited {
                retry_after: envelope
                    .parameters
                    .and_then(|p| p.retry_after)
                    .unwrap_or(1)
                    .clamp(1, 3600),
            }),
            code if code >= 500 && mutating => Err(Error::AmbiguousSend),
            code => Err(Error::Rejected { status: code }),
        }
    }
    pub async fn identify_for_polling(&self) -> Result<BotUser, Error> {
        let bot: BotUser = self.call("getMe", json!({}), false).await?;
        if !bot.is_bot || bot.id <= 0 {
            return Err(Error::MalformedResponse);
        }
        let webhook: Webhook = self.call("getWebhookInfo", json!({}), false).await?;
        if !webhook.url.is_empty() {
            return Err(Error::Conflict);
        }
        // Do NOT delete a webhook or drop pending updates to make tests pass.
        Ok(bot)
    }
    pub async fn get_updates(
        &self,
        offset: Option<u64>,
        timeout_seconds: u8,
    ) -> Result<Vec<Value>, Error> {
        if timeout_seconds > 30 || offset.is_some_and(|id| id > i64::MAX as u64) {
            return Err(Error::Configuration);
        }
        let updates: Vec<Value> = self
            .call(
                "getUpdates",
                json!({"offset":offset,"timeout":timeout_seconds,"limit":100,
            "allowed_updates":["message","callback_query"]}),
                false,
            )
            .await?;
        if updates.len() > 100 {
            return Err(Error::MalformedResponse);
        }
        Ok(updates)
    }
    /// Upload bytes only. No provider file_id, URL, native path or endpoint input.
    pub async fn send_attachment(
        &self,
        chat: i64,
        caption: &str,
        media: xharness_remote::ScopedAttachment,
    ) -> Result<SentMessage, Error> {
        use xharness_remote::{ScopedAttachmentKind, MAX_SCOPED_ATTACHMENT_BYTES};
        if chat <= 0
            || caption.contains('\0')
            || caption.encode_utf16().count() > 1024
            || media.data.is_empty()
            || media.data.len() > MAX_SCOPED_ATTACHMENT_BYTES
            || !xharness_remote::valid_media_type(&media.media_type)
        {
            return Err(Error::InvalidAttachment);
        }
        let photo = media.kind == ScopedAttachmentKind::Image
            && matches!(media.media_type.as_str(), "image/png" | "image/jpeg")
            && media.width > 0
            && media.height > 0
            && u64::from(media.width) + u64::from(media.height) <= 10000
            && u64::from(media.width) <= u64::from(media.height) * 20
            && u64::from(media.height) <= u64::from(media.width) * 20;
        let (method, field) = if photo {
            ("sendPhoto", "photo")
        } else {
            ("sendDocument", "document")
        };
        let ext = match media.media_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "application/pdf" => "pdf",
            "text/plain" => "txt",
            _ => "bin",
        };
        let part = reqwest::multipart::Part::bytes(media.data)
            .file_name(format!("attachment.{ext}"))
            .mime_str(&media.media_type)
            .map_err(|_| Error::InvalidAttachment)?;
        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat.to_string())
            .text("caption", caption.to_owned())
            .part(field, part);
        if !photo {
            form = form.text("disable_content_type_detection", "true");
        }
        let response = self
            .http
            .post(format!("{}/bot{}/{}", self.base, self.token.0, method))
            .multipart(form)
            .send()
            .await
            .map_err(|_| Error::AmbiguousSend)?;
        let message: SentMessage = self.decode_response(response, true).await?;
        if message.chat.id != chat || message.chat.kind != "private" || message.message_id <= 0 {
            return Err(Error::AmbiguousSend);
        }
        Ok(message)
    }
    pub async fn send_message(
        &self,
        chat_id: i64,
        text: &str,
        keyboard: Vec<Vec<InlineButton>>,
    ) -> Result<SentMessage, Error> {
        validate_text(text, 4096)?;
        validate_keyboard(&keyboard)?;
        let message:SentMessage=self.call("sendMessage",json!({"chat_id":chat_id,"text":text,
            "link_preview_options":{"is_disabled":true},"reply_markup":{"inline_keyboard":keyboard}}),true).await?;
        if message.chat.id != chat_id || message.message_id <= 0 {
            return Err(Error::AmbiguousSend);
        }
        Ok(message)
    }
    /// Editing a KNOWN message is idempotent at the provider boundary. A lost
    /// initial send is different: it must never be treated as a known message.
    pub async fn edit_message(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
    ) -> Result<SentMessage, Error> {
        self.edit_message_with_buttons(chat_id, message_id, text, vec![])
            .await
    }
    pub async fn edit_message_with_buttons(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
        keyboard: Vec<Vec<InlineButton>>,
    ) -> Result<SentMessage, Error> {
        if message_id <= 0 {
            return Err(Error::Configuration);
        }
        validate_text(text, 4096)?;
        validate_keyboard(&keyboard)?;
        let message: SentMessage = self
            .call(
                "editMessageText",
                json!({"chat_id":chat_id,"message_id":message_id,"text":text,
            "link_preview_options":{"is_disabled":true},"reply_markup":{"inline_keyboard":keyboard}}),
                true,
            )
            .await?;
        if message.chat.id != chat_id || message.message_id != message_id {
            return Err(Error::AmbiguousSend);
        }
        Ok(message)
    }
    pub async fn answer_callback(&self, id: &str, text: &str) -> Result<(), Error> {
        if id.is_empty() || id.len() > 512 {
            return Err(Error::Configuration);
        }
        validate_text(text, 200)?;
        let acknowledged: bool = self
            .call(
                "answerCallbackQuery",
                json!({"callback_query_id":id,"text":text}),
                true,
            )
            .await?;
        if !acknowledged {
            return Err(Error::AmbiguousSend);
        }
        Ok(())
    }
    pub async fn download_file(&self, id: &str) -> Result<Vec<u8>, Error> {
        if id.is_empty() || id.len() > 1024 {
            return Err(Error::InvalidAttachment);
        }
        let file: File = self.call("getFile", json!({"file_id":id}), false).await?;
        if file
            .file_size
            .is_some_and(|n| n > MAX_ATTACHMENT_BYTES as u64)
        {
            return Err(Error::AttachmentTooLarge);
        }
        let path = file.file_path.ok_or(Error::InvalidAttachment)?;
        validate_file_path(&path)?;
        let url = format!("{}/file/bot{}/{}", self.base, self.token.0, path);
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::Rejected {
                status: response.status().as_u16(),
            });
        }
        bounded(response, MAX_ATTACHMENT_BYTES).await
    }
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, Error> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::AttachmentTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(Error::AttachmentTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn validate_text(text: &str, max: usize) -> Result<(), Error> {
    if text.is_empty() || text.contains('\0') || text.encode_utf16().count() > max {
        return Err(Error::Configuration);
    }
    Ok(())
}
fn validate_keyboard(rows: &[Vec<InlineButton>]) -> Result<(), Error> {
    if rows.len() > 16 || rows.iter().map(Vec::len).sum::<usize>() > 64 {
        return Err(Error::Configuration);
    }
    for button in rows.iter().flatten() {
        validate_text(&button.text, 64)?;
        if button.callback_data.is_empty()
            || button.callback_data.len() > 64
            || button.callback_data.contains('\0')
        {
            return Err(Error::Configuration);
        }
    }
    Ok(())
}
fn validate_file_path(path: &str) -> Result<(), Error> {
    if path.is_empty()
        || path.len() > 1024
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'/'))
    {
        return Err(Error::InvalidAttachment);
    }
    Ok(())
}
