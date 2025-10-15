//! Streaming Chat Completions and Responses API support.

mod protocol;
mod provider;
mod sse;

pub use protocol::{
    build_openai_request, OpenAiProtocol, OpenAiStreamNormalizer, CHAT_COMPLETIONS, RESPONSES,
};
pub use provider::{OpenAiProvider, OpenAiProviderConfig};
pub use sse::{SseEvent, SseParser};
