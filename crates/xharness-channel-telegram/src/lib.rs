//! Official Telegram Bot API transport. No Host, Agent or model/tool dispatch.
mod client;
mod commands;
pub use commands::format_command_reply;
mod decode;
mod intake;
mod interactions;
mod media;
mod output;
pub use output::format_output;
mod replies;
pub use client::*;
pub use decode::*;
pub use intake::*;
pub use interactions::*;
pub use replies::*;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid Telegram configuration")]
    Configuration,
    #[error("Telegram transport unavailable")]
    Transport,
    #[error("Telegram request timed out")]
    Timeout,
    #[error("Telegram response is malformed or exceeds limits")]
    MalformedResponse,
    #[error("Telegram credentials are invalid or expired")]
    Unauthorized,
    #[error("Telegram account has a conflicting poller or webhook")]
    Conflict,
    #[error("Telegram rate limited; retry after {retry_after} seconds")]
    RateLimited { retry_after: u32 },
    #[error("Telegram rejected operation (code {status})")]
    Rejected { status: u16 },
    #[error("Telegram send outcome is uncertain; do not automatically resend")]
    AmbiguousSend,
    #[error("Telegram attachment exceeds upload budget")]
    AttachmentTooLarge,
    #[error("Telegram attachment path is invalid")]
    InvalidAttachment,
}
