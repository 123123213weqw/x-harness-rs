//! Streaming Chat Completions and Responses API support.

mod protocol;
mod provider;
mod sse;

pub use protocol::{
    build_openai_request, build_openai_token_count_request, OpenAiProtocol, OpenAiStreamNormalizer,
    CHAT_COMPLETIONS, RESPONSES,
};
pub use provider::{
    OpenAiCapabilityProbe, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
    DEFAULT_CAPABILITY_TTL, DEFAULT_ERROR_BODY_LIMIT_BYTES,
};
pub use sse::{
    SseEvent, SseParser, DEFAULT_SSE_EVENT_LIMIT_BYTES, DEFAULT_SSE_PENDING_LIMIT_BYTES,
};
