use crate::media::valid_filename;
use crate::{bounded_string, Client, Error, MediaKey, MediaKind, MediaReference, MAX_TEXT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xharness_remote::{Content, RejectionCode};

/// Authenticated provider metadata, never identifiers supplied by message text.
/// No Debug because this contains a reply context token and private message body.
pub struct DecodedMessage {
    pub message_id: String,
    pub user_id: String,
    pub conversation: String,
    pub context_token: String,
    pub parts: Vec<MessagePart>,
}
pub enum MessagePart {
    Text(String),
    Media {
        kind: MediaKind,
        reference: MediaReference,
        key_override: Option<MediaKey>,
        name: Option<String>,
    },
}
/// First validate private sender metadata; trusted composition then resolves
/// Gateway::resolve_sender before downloading any media or creating an Inbound.
pub fn decode_private_message(
    value: &Value,
    expected_bot_id: &str,
) -> Result<DecodedMessage, RejectionCode> {
    if value.get("message_type").and_then(Value::as_u64) != Some(1)
        || value
            .get("group_id")
            .is_some_and(|v| v.as_str() != Some(""))
    {
        return Err(RejectionCode::Unsupported);
    }
    let string = |key: &str, max: usize| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| bounded_string(v, max))
            .map(str::to_owned)
            .ok_or(RejectionCode::Malformed)
    };
    let user_id = string("from_user_id", 512)?;
    if string("to_user_id", 512)? != expected_bot_id {
        return Err(RejectionCode::Malformed);
    }
    let message_id = value
        .get("message_id")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or(RejectionCode::Malformed)?
        .to_string();
    let context_token = string("context_token", 16 * 1024)?;
    let list = value
        .get("item_list")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or(RejectionCode::Malformed)?;
    let mut parts = Vec::with_capacity(list.len());
    for item in list {
        let kind = item
            .get("type")
            .and_then(Value::as_u64)
            .ok_or(RejectionCode::Malformed)?;
        if kind == 1 {
            let text = item
                .pointer("/text_item/text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty() && t.len() <= MAX_TEXT_BYTES && !t.contains('\0'))
                .ok_or(RejectionCode::Malformed)?;
            parts.push(MessagePart::Text(text.to_owned()));
            continue;
        }
        if kind == 3 {
            // Only platform-provided transcription is accepted; no new paid ASR.
            let text = item
                .pointer("/voice_item/text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty() && t.len() <= MAX_TEXT_BYTES && !t.contains('\0'))
                .ok_or(RejectionCode::Unsupported)?;
            parts.push(MessagePart::Text(text.to_owned()));
            continue;
        }
        let (kind, field) = match kind {
            2 => (MediaKind::Image, "image_item"),
            4 => (MediaKind::File, "file_item"),
            5 => (MediaKind::Video, "video_item"),
            _ => return Err(RejectionCode::Unsupported),
        };
        let media = item
            .get(field)
            .and_then(|v| v.get("media"))
            .ok_or(RejectionCode::Malformed)?;
        let reference =
            MediaReference::from_json(media.clone()).map_err(|_| RejectionCode::Malformed)?;
        let key_override = if kind == MediaKind::Image {
            item.pointer("/image_item/aeskey")
                .map(|v| {
                    v.as_str()
                        .ok_or(RejectionCode::Malformed)
                        .and_then(|s| MediaKey::from_hex(s).map_err(|_| RejectionCode::Malformed))
                })
                .transpose()?
        } else {
            None
        };
        let name = if kind == MediaKind::File {
            Some(
                item.pointer("/file_item/file_name")
                    .and_then(Value::as_str)
                    .filter(|v| valid_filename(v))
                    .ok_or(RejectionCode::Malformed)?
                    .to_owned(),
            )
        } else {
            None
        };
        parts.push(MessagePart::Media {
            kind,
            reference,
            key_override,
            name,
        });
    }
    // One principal/account/peer routes private chat. A provider session_id is
    // not a native Host session and must never select one.
    Ok(DecodedMessage {
        message_id,
        conversation: user_id.clone(),
        user_id,
        context_token,
        parts,
    })
}
impl Client {
    /// Only after sender resolution, then revalidate permission at admission.
    /// The existing Host attachment ingestion validates MIME/content again.
    pub async fn materialize_parts(
        &self,
        parts: &[MessagePart],
        cancel: &CancellationToken,
    ) -> Result<Vec<Content>, Error> {
        let mut content = Vec::with_capacity(parts.len());
        for part in parts {
            match part {
                MessagePart::Text(text) => content.push(Content::Text { text: text.clone() }),
                MessagePart::Media {
                    kind,
                    reference,
                    key_override,
                    name,
                } => {
                    let bytes = self
                        .download_media(reference, key_override.as_ref(), cancel)
                        .await?;
                    let data = STANDARD.encode(&bytes);
                    let value = match kind {
                        MediaKind::Image => Content::Image {
                            media_type: image_type(&bytes).ok_or(Error::InvalidMedia)?.into(),
                            data,
                            name: None,
                        },
                        MediaKind::File | MediaKind::Video => Content::File {
                            media_type: if *kind == MediaKind::Video {
                                "video/mp4"
                            } else {
                                "application/octet-stream"
                            }
                            .into(),
                            data,
                            name: name.clone(),
                        },
                    };
                    content.push(value);
                }
            }
            if serde_json::to_vec(&content)
                .map_err(|_| Error::InvalidMedia)?
                .len()
                > xharness_remote::MAX_INBOUND_BYTES
            {
                return Err(Error::InvalidMedia);
            }
        }
        if content.is_empty() {
            return Err(Error::InvalidMedia);
        }
        Ok(content)
    }
}
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
