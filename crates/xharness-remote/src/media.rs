//! Event-owned outgoing references. The native journal/store owns the bytes.
use crate::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
pub use xharness_api::{ScopedAttachment, ScopedAttachmentKind, MAX_SCOPED_ATTACHMENT_BYTES};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyAttachment {
    pub event_seq: u64,
    pub id: String,
}
impl Gateway {
    pub(crate) async fn resolve_outgoing_attachment(
        &self,
        binding: &Binding,
        reference: &ReplyAttachment,
    ) -> Result<ScopedAttachment, Error> {
        let media = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.session_event_attachment(
                &binding.workspace,
                &binding.session,
                reference.event_seq,
                &reference.id,
            ),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if media.id != reference.id
            || media.data.is_empty()
            || media.data.len() > MAX_SCOPED_ATTACHMENT_BYTES
            || native_media_id(&media) != media.id
            || !valid_media_type(&media.media_type)
        {
            return Err(Error::Invalid("native attachment identity/bound"));
        }
        if (media.width == 0) != (media.height == 0)
            || (media.kind == ScopedAttachmentKind::Image && media.width == 0)
            || (media.width > 0
                && (u64::from(media.width) * u64::from(media.height) > 16 * 1024 * 1024
                    || !matches!(
                        media.media_type.as_str(),
                        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                    )))
        {
            return Err(Error::Invalid("native image metadata"));
        }
        if !self.reply_host_scope(binding).await? {
            return Err(Error::Unauthorized);
        }
        Ok(media)
    }
}
pub fn valid_media_type(media: &str) -> bool {
    let Some((a, b)) = media.split_once('/') else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && media.len() <= 128
        && a.bytes()
            .chain(b.bytes())
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_+-.".contains(&c))
}

fn native_media_id(media: &ScopedAttachment) -> String {
    let mut h = Sha256::new();
    // Native storage identity is selected by reference dimensions, not the
    // display block: an image reference may legitimately be shown as a file.
    if media.width == 0 {
        h.update(b"xharness-file-v1\0");
        h.update(media.media_type.as_bytes());
        h.update([0]);
    }
    h.update(&media.data);
    hex::encode(h.finalize())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_file_identity_pins_kind_mime_and_payload_unlike_image_content_hash() {
        let mut media = ScopedAttachment {
            id: String::new(),
            kind: ScopedAttachmentKind::Image,
            media_type: "image/png".into(),
            width: 1,
            height: 1,
            data: b"fixture".to_vec(),
        };
        let image = native_media_id(&media);
        assert_eq!(image, hex::encode(Sha256::digest(b"fixture")));
        media.kind = ScopedAttachmentKind::File;
        assert_eq!(
            native_media_id(&media),
            image,
            "displaying an image as a document retains its native storage identity"
        );
        media.width = 0;
        media.height = 0;
        let file = native_media_id(&media);
        assert_ne!(file, image);
        media.media_type = "image/jpeg".into();
        assert_ne!(native_media_id(&media), file);
    }
}
