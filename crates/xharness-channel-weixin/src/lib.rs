//! Independently implemented Weixin iLink HTTP transport. No Host, Agent,
//! scheduler, credentials file, automatic re-login or automatic message retry.
//! Wire/fixture evidence is not actual account eligibility or end-to-end proof.
mod client;
mod decode;
mod media;
mod pairing;

pub use client::{BotToken, Client, Credentials, Updates};
pub use decode::{decode_private_message, DecodedMessage, MessagePart};
pub use media::{MediaKey, MediaKind, MediaReference, UploadedMedia, MAX_ATTACHMENT_BYTES};
pub use pairing::{LoginSession, PairingClient, PairingStatus};

pub const API_BASE: &str = "https://ilinkai.weixin.qq.com/";
pub const CDN_BASE: &str = "https://novac2c.cdn.weixin.qq.com/c2c/";
pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_CURSOR_BYTES: usize = 16 * 1024;

/// Intentionally closed errors: never return reqwest URLs, provider descriptions,
/// message bodies, QR nonces, context tokens or media encryption keys.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid Weixin configuration")]
    Configuration,
    #[error("Weixin transport unavailable")]
    Transport,
    #[error("Weixin request timed out")]
    Timeout,
    #[error("Weixin operation cancelled")]
    Cancelled,
    #[error("Weixin response malformed or exceeds limits")]
    MalformedResponse,
    #[error("Weixin account session expired; explicit re-pairing required")]
    SessionExpired,
    #[error("Weixin credentials rejected")]
    Unauthorized,
    #[error("Weixin operation rate limited")]
    RateLimited,
    #[error("Weixin rejected operation (code {code})")]
    Rejected { code: i64 },
    #[error("Weixin send outcome uncertain; do not automatically resend")]
    AmbiguousSend,
    #[error("Weixin media is invalid or exceeds limits")]
    InvalidMedia,
    #[error("Weixin pairing expired or already consumed")]
    PairingExpired,
}

pub(crate) fn bounded_string(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
