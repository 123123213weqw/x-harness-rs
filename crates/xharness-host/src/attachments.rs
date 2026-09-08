//! Host admission/authorization and request-local attachment projection.
use crate::{driver::rpc_error, BasicHost};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::{RpcError, RpcErrorCode};
use xharness_attachment::{
    AttachmentStore, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_INLINE_FILE_BYTES, MAX_PROMPT_IMAGE_BYTES,
};
use xharness_core::{ProviderError, ProviderRequest};
use xharness_session::{AttachmentRef, ContentBlock, Message};

pub(crate) fn attachment_error(error: impl std::fmt::Display) -> RpcError {
    rpc_error(
        RpcErrorCode::AttachmentError,
        error.to_string(),
        json!({"reason":"ATTACHMENT_ERROR"}),
    )
}

pub(crate) fn message_with_blocks(text: String, id: String, content: &[Value]) -> Message {
    if content
        .iter()
        .all(|part| part.get("type").and_then(Value::as_str) == Some("text"))
    {
        return Message::user(text).with_id(id);
    }
    // Only canonical, admitted content reaches this internal boundary.
    Message::user(text).with_id(id).with_content_blocks(
        content
            .iter()
            .map(|part| {
                serde_json::from_value(part.clone()).expect("host admitted canonical content")
            })
            .collect(),
    )
}

pub(crate) fn web_tool_content(text: &str, metadata: Option<&Value>) -> Value {
    let blocks = ContentBlock::from_tool_metadata(metadata);
    if blocks.is_empty() {
        json!([{"type":"text", "text":text}])
    } else {
        json!(blocks)
    }
}

impl BasicHost {
    pub fn attachment_store(&self) -> Arc<AttachmentStore> {
        self.config.attachments.clone()
    }

    pub async fn session_accepts_images(&self, session_id: &str) -> bool {
        let state = self.state.read().await;
        let Some(session) = state.sessions.get(session_id) else {
            return false;
        };
        self.agent_runtime.model_catalog().iter().any(|model| {
            model.provider == session.model.provider
                && model.model == session.model.model
                && model.input_modalities.iter().any(|m| m == "image")
        })
    }

    pub(crate) async fn admit_attachment_content(
        &self,
        content: &[Value],
    ) -> Result<(String, Vec<Value>), RpcError> {
        if content.is_empty() || content.len() > 129 {
            return Err(attachment_error(
                "prompt requires between 1 and 129 content blocks",
            ));
        }
        let count = content
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("image" | "file")
                )
            })
            .count();
        let encoded_bytes = content
            .iter()
            .filter_map(|part| part.get("data").and_then(Value::as_str))
            .fold(0usize, |sum, data| sum.saturating_add(data.len()));
        if count > 128 || encoded_bytes > 128 * 1024 * 1024 + 512 {
            return Err(attachment_error(
                "prompt exceeds the attachment count or byte limit",
            ));
        }
        let store = self.attachment_store();
        let content = content.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut blocks = Vec::new();
            let mut text = String::new();
            let mut total_bytes = 0usize;
            let mut image_count = 0;
            let mut image_bytes = 0usize;
            for part in content {
                let block = match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let value = part
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(|| attachment_error("text requires a string"))?;
                        text.push_str(value);
                        ContentBlock::Text { text: value.into() }
                    }
                    Some(kind @ ("image" | "file")) => {
                        // Clients submit bytes, never a trusted local path or reference.
                        let media = part
                            .get("mediaType")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream");
                        let data = part
                            .get("data")
                            .and_then(Value::as_str)
                            .ok_or_else(|| attachment_error("attachment requires base64 data"))?;
                        let name = part.get("name").and_then(Value::as_str);
                        let bytes = AttachmentStore::decode_base64(
                            data,
                            if kind == "image" {
                                MAX_IMAGE_BYTES
                            } else {
                                MAX_INLINE_FILE_BYTES
                            },
                        )
                        .map_err(attachment_error)?;
                        total_bytes = total_bytes.saturating_add(bytes.len());
                        if total_bytes > 96 * 1024 * 1024 {
                            return Err(attachment_error("prompt attachments exceed 96 MiB"));
                        }
                        if kind == "image" {
                            image_count += 1;
                            image_bytes = image_bytes.saturating_add(bytes.len());
                            if image_count > MAX_IMAGES || image_bytes > MAX_PROMPT_IMAGE_BYTES {
                                return Err(attachment_error(
                                    "prompt exceeds the image count or byte limit",
                                ));
                            }
                            let attachment = store
                                .save_image(&bytes, media, name)
                                .map_err(attachment_error)?;
                            text.push_str(&format!(
                                "\n[image attachment: {}]",
                                attachment.attachment_id
                            ));
                            ContentBlock::Image {
                                attachment,
                                data_url: None,
                            }
                        } else {
                            let attachment = store
                                .save_file(&bytes, media, name)
                                .map_err(attachment_error)?;
                            text.push_str(&format!(
                                "\n[file attachment: {}]",
                                attachment.name.as_deref().unwrap_or("attachment")
                            ));
                            ContentBlock::File { attachment }
                        }
                    }
                    _ => return Err(attachment_error("content part must be text, image or file")),
                };
                blocks.push(serde_json::to_value(block).expect("content serializes"));
            }
            Ok((text, blocks))
        })
        .await
        .map_err(attachment_error)?
    }

    pub(crate) async fn authorized_attachment(
        &self,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<AttachmentRef, RpcError> {
        // Check all durable events, not just the current model surface or bounded
        // Web cache: compacted and forked historical messages still own their refs.
        if let Some(session) = self
            .agent_runtime
            .authoritative_session(session_id)
            .await
            .map_err(attachment_error)?
        {
            for event in session.events() {
                use xharness_session::EventData;
                let blocks = match event.data() {
                    EventData::UserMessage { message, .. }
                    | EventData::AssistantMessage { message, .. } => message.content_blocks.clone(),
                    EventData::AgentInboxSpliced { inserted, .. } => inserted
                        .iter()
                        .flat_map(|input| input.message.content_blocks.clone())
                        .collect(),
                    EventData::ToolResult { result, .. } => {
                        ContentBlock::from_tool_metadata(result.metadata.as_ref())
                    }
                    _ => Vec::new(),
                };
                if let Some(reference) = blocks
                    .iter()
                    .filter_map(ContentBlock::attachment)
                    .find(|reference| reference.attachment_id == attachment_id)
                {
                    return Ok(reference.clone());
                }
            }
        } else {
            let state = self.state.read().await;
            let session = state
                .sessions
                .get(session_id)
                .ok_or_else(|| attachment_error("session was not found"))?;
            for event in &session.events {
                if let Some(reference) = find_reference(event, attachment_id) {
                    return Ok(reference);
                }
            }
        }
        Err(attachment_error(
            "attachment is missing or is not referenced by this session",
        ))
    }
}

fn find_reference(value: &Value, id: &str) -> Option<AttachmentRef> {
    match value {
        Value::Object(object) => {
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("image" | "file")
            ) {
                if let Some(reference) = object
                    .get("attachment")
                    .and_then(|v| serde_json::from_value::<AttachmentRef>(v.clone()).ok())
                    .filter(|r| r.attachment_id == id)
                {
                    return Some(reference);
                }
            }
            object.values().find_map(|value| find_reference(value, id))
        }
        Value::Array(items) => items.iter().find_map(|value| find_reference(value, id)),
        _ => None,
    }
}

pub(crate) async fn project_request(
    mut request: ProviderRequest,
    store: Option<Arc<AttachmentStore>>,
    images: bool,
    cancellation: CancellationToken,
) -> Result<ProviderRequest, ProviderError> {
    if !request
        .messages
        .iter()
        .any(|message| !message.content_blocks.is_empty())
    {
        return Ok(request);
    }
    let cancelled = cancellation.clone();
    let task = tokio::task::spawn_blocking(move || {
        let mut retained = 0usize;
        // LoopEngine sets the trusted session scope even when debug recording is disabled.
        let session_id = request.debug_scope.session_id.clone();
        // Keep the latest images under the request transport budget. A request-
        // local omission never removes refs from the durable session.
        for message in request.messages.iter_mut().rev() {
            for block in message.content_blocks.iter_mut().rev() {
                if cancelled.is_cancelled() {
                    return Err(ProviderError::new("attachment preparation cancelled"));
                }
                let replacement = match block {
                    ContentBlock::Text { .. } => None,
                    ContentBlock::File { attachment } => {
                        let store = store.as_ref().ok_or_else(|| {
                            ProviderError::new("file attachment store unavailable")
                        })?;
                        let path = match session_id.as_deref() {
                            Some(session) => store.session_file_path(session, attachment),
                            // Explicit low-level callers without a session have no native tool grant.
                            None => store.file_path(attachment),
                        }
                        .map_err(|e| ProviderError::new(e.to_string()))?
                        .ok_or_else(|| {
                            ProviderError::new(
                                "generic file tools require a disk-backed attachment store",
                            )
                        })?;
                        Some(ContentBlock::Text {
                            text: format!(
                                "[file attachment: {}; {} bytes; {}; read-only path: {}]",
                                serde_json::to_string(
                                    attachment.name.as_deref().unwrap_or("attachment")
                                )
                                .unwrap(),
                                attachment.bytes,
                                attachment.attachment_id,
                                serde_json::to_string(&path.to_string_lossy()).unwrap()
                            ),
                        })
                    }
                    ContentBlock::Image {
                        attachment,
                        data_url,
                    } if images && retained < 20 => {
                        let data = store
                            .as_ref()
                            .ok_or_else(|| {
                                ProviderError::new("image attachment store unavailable")
                            })?
                            .image_data_url(attachment)
                            .map_err(|e| ProviderError::new(e.to_string()))?;
                        retained += 1;
                        *data_url = Some(data);
                        None
                    }
                    ContentBlock::Image { attachment, .. } => Some(ContentBlock::Text {
                        text: format!(
                            "[image omitted because {}; attachment {}]",
                            if images {
                                "the request image budget was reached"
                            } else {
                                "this model accepts text only"
                            },
                            attachment.attachment_id
                        ),
                    }),
                };
                if let Some(replacement) = replacement {
                    *block = replacement;
                }
            }
            message.content = message
                .content_blocks
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text } = b {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        Ok(request)
    });
    tokio::select! {
        _ = cancellation.cancelled() => Err(ProviderError::new("attachment preparation cancelled")),
        result = task => result.map_err(|e| ProviderError::new(format!("attachment preparation failed: {e}")))?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn text_only_projection_does_not_read_images_or_mutate_history() {
        let image = ContentBlock::Image {
            attachment: AttachmentRef {
                attachment_id: format!("sha256:{}", "a".repeat(64)),
                media_type: "image/png".into(),
                bytes: 12,
                name: None,
                width: Some(1),
                height: Some(1),
            },
            data_url: None,
        };
        let original = Message::user("image").with_content_blocks(vec![image.clone()]);
        let request = ProviderRequest {
            messages: vec![original.clone()],
            tools: vec![],
            step: 1,
            reasoning_effort: None,
            max_output_tokens: None,
            debug_scope: Default::default(),
        };
        let projected = project_request(request.clone(), None, false, CancellationToken::new())
            .await
            .unwrap();
        assert!(projected.messages[0]
            .content
            .contains("this model accepts text only"));
        assert_eq!(original.content_blocks, vec![image]);
        assert!(
            project_request(request, None, true, CancellationToken::new())
                .await
                .is_err()
        );
    }
}
