//! Trusted event-owned bytes, not a file path or controller download URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopedAttachmentKind {
    Image,
    File,
}
pub const MAX_SCOPED_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, PartialEq, Eq)]
pub struct ScopedAttachment {
    pub id: String,
    pub kind: ScopedAttachmentKind,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}
impl std::fmt::Debug for ScopedAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopedAttachment")
            .field("kind", &self.kind)
            .field("media_type", &self.media_type)
            .field("bytes", &self.data.len())
            .field("data", &"[REDACTED]")
            .finish()
    }
}
