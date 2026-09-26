//! Prompt admission, attachment materialization, queue mutation, and turn control.

use serde_json::{json, Value};
use tokio::sync::oneshot;
use xharness_api::{RpcError, RpcErrorCode, RpcId};
use xharness_core::{AgentMessage, LoopCommand, LoopControlError};

use crate::{
    driver::{agent_runtime_error, rpc_error, PromptAdmission},
    state::DriverCommand,
    BasicHost,
};

use super::{
    bad_request, optional_string, prompt_fingerprint, queue_item_not_found, required_array,
    required_string, session_not_found, visible_text,
};

pub(crate) async fn prompt(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let mode = required_string(payload, "mode")?;
    if mode != "queue" && mode != "steer" {
        return Err(bad_request("mode must be queue or steer"));
    }
    let content = required_array(payload, "content")?.clone();
    let require_idle = match payload.get("requireIdle") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(bad_request("requireIdle must be a boolean")),
    };
    let client_time_zone = optional_string(payload, "clientTimeZone")?;
    if let Some(zone) = &client_time_zone {
        if zone.trim().is_empty() || zone.contains('\0') {
            return Err(rpc_error(
                RpcErrorCode::InvalidTimeZone,
                "clientTimeZone is invalid",
                json!({"clientTimeZone": zone}),
            ));
        }
    }
    let fingerprint = prompt_fingerprint(&mode, &content, client_time_zone.as_deref());
    let _admission_guard = host.lock_admission(&session_id).await;
    if duplicate_admission(host, &session_id, rpc_id.as_str(), &fingerprint).await? {
        return Ok(json!({"accepted": true}));
    }

    if require_idle {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        if session.running {
            return Err(rpc_error(
                RpcErrorCode::SessionConflict,
                "session started running; edited draft was not submitted",
                json!({"reason":"session-running"}),
            ));
        }
    }

    if content.iter().any(|part| {
        matches!(
            part.get("type").and_then(Value::as_str),
            Some("image" | "image_ref")
        )
    }) {
        let state = host.state.read().await;
        if let Some(session) = state.sessions.get(&session_id) {
            let unsupported = state
                .settings
                .get(crate::MODEL_SETTINGS_NAMESPACE)
                .and_then(|ns| ns.value["providers"][&session.model.provider]["models"].as_array())
                .and_then(|models| {
                    models
                        .iter()
                        .find(|m| m["id"].as_str() == Some(&session.model.model))
                })
                .and_then(|model| model["imageInput"].as_bool())
                == Some(false);
            if unsupported {
                return Err(rpc_error(
                    RpcErrorCode::AttachmentError,
                    "current model does not support images",
                    json!({"reason":"MODEL_DOES_NOT_SUPPORT_IMAGES"}),
                ));
            }
        }
    }

    // Attachment materialization is deliberately after receipt lookup:
    // retrying a successfully admitted request must not mint duplicates.
    let (text, durable) = admit_prompt_content(host, &session_id, &content).await?;
    let mut source = json!({"kind": "user", "rpcId": rpc_id.as_str()});
    if let Some(zone) = client_time_zone {
        source
            .as_object_mut()
            .expect("source is object")
            .insert("clientTimeZone".to_owned(), json!(zone));
    }
    host.enqueue_prompt(PromptAdmission {
        rpc_id,
        session_id,
        mode,
        text,
        content: durable,
        source,
        fingerprint: Some(fingerprint),
    })
    .await?;
    Ok(json!({"accepted": true}))
}

pub(crate) async fn duplicate_admission(
    host: &BasicHost,
    session_id: &str,
    rpc_id: &str,
    fingerprint: &str,
) -> Result<bool, RpcError> {
    let state = host.state.read().await;
    let session = state
        .sessions
        .get(session_id)
        .ok_or_else(|| session_not_found(session_id))?;
    let Some(previous) = session.admissions.get(rpc_id) else {
        return Ok(false);
    };
    if previous.fingerprint.as_deref() == Some(fingerprint) {
        return Ok(true);
    }
    Err(rpc_error(
        RpcErrorCode::SessionConflict,
        "rpc id was already admitted with a different prompt payload",
        json!({"sessionId": session_id, "rpcId": rpc_id}),
    ))
}

async fn admit_prompt_content(
    host: &BasicHost,
    session_id: &str,
    content: &[Value],
) -> Result<(String, Vec<Value>), RpcError> {
    if content.len() > 128 {
        return Err(bad_request("at most 128 content parts"));
    }
    let encoded: usize = content
        .iter()
        .filter_map(|p| p["data"].as_str())
        .map(str::len)
        .sum();
    if encoded > 128 * 1024 * 1024 {
        return Err(bad_request(
            "attachments exceed 96 MiB decoded upload budget",
        ));
    }
    let mut text = String::new();
    let mut durable = Vec::new();
    for part in content {
        if let Some(name) = part.get("name").filter(|v| !v.is_null()) {
            let name = name
                .as_str()
                .ok_or_else(|| bad_request("attachment name must be a string"))?;
            if name.len() > 1024 || name.contains('\0') {
                return Err(bad_request("invalid attachment name"));
            }
        }
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let value = part
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad_request("text content requires string text"))?;
                text.push_str(value);
                durable.push(json!({"type": "text", "text": value}));
            }
            Some("image") => {
                let media_type = part
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad_request("image content requires mediaType"))?;
                if !matches!(
                    media_type,
                    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                ) {
                    return Err(rpc_error(
                        RpcErrorCode::AttachmentError,
                        "unsupported image media type",
                        json!({"reason": "UNSUPPORTED_MEDIA_TYPE"}),
                    ));
                }
                let data = part
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad_request("image content requires base64 data"))?
                    .to_owned();
                if data.is_empty() {
                    return Err(rpc_error(
                        RpcErrorCode::AttachmentError,
                        "image data is empty",
                        json!({"reason": "EMPTY_IMAGE"}),
                    ));
                }
                let upload =
                    xharness_attachments::Upload::from_base64(media_type, &data).map_err(|e| {
                        rpc_error(
                            RpcErrorCode::AttachmentError,
                            e.to_string(),
                            json!({"reason":"INVALID_IMAGE"}),
                        )
                    })?;
                let reference = host
                    .config
                    .attachment_store
                    .put(session_id, upload)
                    .await
                    .map_err(|e| {
                        rpc_error(
                            RpcErrorCode::AttachmentError,
                            e.to_string(),
                            json!({"reason":"ATTACHMENT_STORE"}),
                        )
                    })?;
                let attachment = json!({
                    "attachmentId": reference.id, "mediaType": reference.media_type,
                    "bytes": reference.bytes, "width": (reference.width>0).then_some(reference.width), "height": (reference.height>0).then_some(reference.height),
                    "name": part.get("name").and_then(Value::as_str), "reference": reference,
                });
                durable.push(json!({"type":"image", "attachment":attachment}));
            }
            Some("file") => {
                let media = required_string(part, "mediaType")?;
                let data = part["data"]
                    .as_str()
                    .ok_or_else(|| bad_request("file requires base64 data"))?;
                use base64::Engine;
                if data.len() > xharness_attachments::MAX_FILE_BYTES.div_ceil(3) * 4 {
                    return Err(bad_request("file exceeds 32 MiB"));
                }
                let data = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| bad_request("invalid file base64"))?;
                let r = host
                    .config
                    .attachment_store
                    .put_file(
                        session_id,
                        xharness_attachments::Upload {
                            media_type: media,
                            data,
                        },
                    )
                    .await
                    .map_err(|e| bad_request(e.to_string()))?;
                durable.push(json!({"type":"file","attachment":{"attachmentId":r.id,"mediaType":r.media_type,"bytes":r.bytes,"name":part["name"],"reference":r}}));
            }
            Some(kind @ ("image_ref" | "file_ref")) => {
                let id = required_string(part, "attachmentId")?;
                let resolved = resolve_attachment(host, session_id, &id).await?;
                let reference = &resolved.reference;
                if (kind == "image_ref") != (reference.width > 0) {
                    return Err(bad_request("attachment kind mismatch"));
                }
                durable.push(json!({"type":if kind=="file_ref" {"file"} else {"image"}, "attachment": {
                        "name":part["name"], "attachmentId": reference.id, "mediaType": reference.media_type,
                        "bytes": reference.bytes, "width": (reference.width>0).then_some(reference.width), "height": (reference.height>0).then_some(reference.height),
                        "reference": reference,
                    }}));
            }
            _ => {
                return Err(bad_request(
                    "content part type must be text, image, file, image_ref or file_ref",
                ))
            }
        }
    }
    if durable.is_empty() {
        return Err(bad_request("prompt content must not be empty"));
    }
    Ok((text, durable))
}

pub(super) async fn attachment(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let attachment_id = required_string(payload, "attachmentId")?;
    let attachment = resolve_attachment(host, &session_id, &attachment_id).await?;
    let r = &attachment.reference;
    Ok(
        json!({"attachment": {"attachmentId":r.id,"mediaType":r.media_type,"bytes":r.bytes,"width":(r.width>0).then_some(r.width),"height":(r.height>0).then_some(r.height)}, "data":attachment.base64()}),
    )
}

async fn resolve_attachment(
    host: &BasicHost,
    session_id: &str,
    attachment_id: &str,
) -> Result<xharness_attachments::ResolvedAttachment, RpcError> {
    let state = host.state.read().await;
    if !state.sessions.contains_key(session_id) {
        return Err(session_not_found(session_id));
    }
    drop(state);
    // A fork may legitimately replay a reference owned by its ancestor.
    // Authorize via this session's actual history, never a caller-supplied owner.
    let mut owner = session_id.to_owned();
    let reference_owner = |message: &xharness_session::Message| {
        message.content_blocks.iter().find_map(|block| match block {
            xharness_session::ContentBlock::Image { attachment }
            | xharness_session::ContentBlock::File { attachment, .. }
                if attachment.id == attachment_id =>
            {
                Some(attachment.session_id.to_owned())
            }
            _ => None,
        })
    };
    if let Some(session) = host
        .agent_runtime
        .authoritative_session(session_id)
        .await
        .map_err(agent_runtime_error)?
    {
        if let Some(found) = session
            .events()
            .iter()
            .find_map(|entry| match entry.data() {
                xharness_session::EventData::UserMessage { message, .. } => {
                    reference_owner(message)
                }
                xharness_session::EventData::ToolResult { result, .. } => {
                    xharness_session::ContentBlock::from_tool_metadata(result.metadata.as_ref())
                        .iter()
                        .find_map(|block| match block {
                            xharness_session::ContentBlock::Image { attachment }
                            | xharness_session::ContentBlock::File { attachment, .. }
                                if attachment.id == attachment_id =>
                            {
                                Some(attachment.session_id.clone())
                            }
                            _ => None,
                        })
                }
                _ => None,
            })
        {
            owner = found;
        }
    } else if let Some(found) = host
        .state
        .read()
        .await
        .sessions
        .get(session_id)
        .and_then(|session| session.messages.iter().find_map(reference_owner))
    {
        owner = found;
    }
    let attachment = host
        .config
        .attachment_store
        .resolve(&owner, attachment_id)
        .await
        .map_err(|e| {
            rpc_error(
                RpcErrorCode::AttachmentError,
                e.to_string(),
                json!({"reason":"NOT_FOUND"}),
            )
        })?;
    Ok(attachment)
}

impl BasicHost {
    /// Resolve within this session's attachment namespace, or use an ancestor
    /// owner only when the reference is present in the fork's actual history.
    /// Never trust a caller-supplied owner ID for on-demand model image reads.
    pub async fn resolve_session_attachment(
        &self,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<xharness_attachments::ResolvedAttachment, String> {
        resolve_attachment(self, session_id, attachment_id)
            .await
            .map_err(|error| error.message)
    }
}

pub(super) async fn update_queue(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let _session_guard = host.lock_admission(&session_id).await;
    let item_id = required_string(payload, "itemId")?;
    let action = payload
        .get("action")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("action must be an object"))?;
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request("action.kind is required"))?;
    let authoritative = host.agent_runtime.has_authoritative_sessions();
    let item = {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        let item = if authoritative {
            session
                .projected_queue
                .iter()
                .find(|item| item.id == item_id)
                .cloned()
        } else {
            session
                .queue
                .iter()
                .find(|item| item.id == item_id)
                .cloned()
        };
        item.ok_or_else(|| {
            rpc_error(
                RpcErrorCode::QueueItemNotFound,
                "queued item is no longer pending",
                json!({"itemId": item_id}),
            )
        })?
    };
    // Check before mutating the durable inbox. Old clients can still submit
    // actions for a formerly queued internal receipt after a Host upgrade.
    if !item.user_mutable() {
        return Err(rpc_error(
            RpcErrorCode::BadRequest,
            "runtime context is not an editable user queue item",
            json!({"itemId": item_id, "reason": "QUEUE_ITEM_READ_ONLY"}),
        ));
    }
    let mut steer_item = None;
    let mut replacement = None;
    match kind {
        "remove" | "steer" => {
            host.agent_runtime
                .remove_pending_input(&session_id, &item_id)
                .await
                .map_err(|error| queue_item_not_found(&item_id, error))?;
            if kind == "steer" {
                steer_item = Some(item);
            }
        }
        "edit" => {
            let content = action
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| bad_request("edit action requires content"))?
                .clone();
            if content
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) != Some("text"))
            {
                return Err(rpc_error(
                    RpcErrorCode::AttachmentError,
                    "queue edits accept text content only",
                    json!({"reason": "QUEUE_EDIT_NON_TEXT"}),
                ));
            }
            let text = visible_text(&content);
            host.agent_runtime
                .replace_pending_input(
                    &session_id,
                    AgentMessage::new(xharness_core::Role::User, text.clone())
                        .with_id(item_id.clone()),
                    Some(json!({
                        "content": content.clone(),
                        "source": item.source.clone(),
                        "rpcFingerprint": item.fingerprint,
                        "rpcSessionId": session_id,
                    })),
                )
                .await
                .map_err(|error| queue_item_not_found(&item_id, error))?;
            replacement = Some((content, text));
        }
        _ => return Err(bad_request("unsupported queue action")),
    }

    // The Host driver FIFO is only an attachment index. Keep it aligned
    // for work not yet handed to RunningTurn, but never use it as the Web
    // queue authority when a durable Session exists.
    {
        let mut state = host.state.write().await;
        let session = state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        if let Some(index) = session.queue.iter().position(|item| item.id == item_id) {
            if let Some((content, text)) = replacement {
                if let Some(item) = session.queue.get_mut(index) {
                    item.content = content;
                    item.text = text;
                }
            } else {
                session.queue.remove(index);
            }
        }
    }
    if authoritative {
        host.sync_authoritative_session(&session_id).await?;
    } else {
        host.emit_queue(&session_id).await;
    }
    if let Some(item) = steer_item {
        host.enqueue_prompt(PromptAdmission {
            rpc_id: RpcId::new(item.id),
            session_id,
            mode: "steer".to_owned(),
            text: item.text,
            content: item.content,
            source: item.source,
            fingerprint: item.fingerprint,
        })
        .await?;
    }
    Ok(json!({"accepted": true}))
}

pub(super) async fn cancel(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    send_control(host, &session_id, LoopCommand::InterruptByUser).await?;
    Ok(json!({"accepted": true}))
}

pub(crate) async fn send_control(
    host: &BasicHost,
    session_id: &str,
    command: LoopCommand,
) -> Result<(), RpcError> {
    let cancel_is_idempotent =
        matches!(&command, LoopCommand::Cancel | LoopCommand::InterruptByUser);
    // Order stop with queue admission and the paused-to-running handoff.
    // Release before waiting for the driver's acknowledgement.
    let admission_guard = if cancel_is_idempotent {
        Some(host.lock_admission(session_id).await)
    } else {
        None
    };
    if cancel_is_idempotent {
        host.set_dispatch_paused(session_id, true).await?;
    }
    let control = host
        .state
        .read()
        .await
        .sessions
        .get(session_id)
        .ok_or_else(|| session_not_found(session_id))?
        .control
        .clone();
    let Some(control) = control else {
        return Ok(());
    };
    let (acknowledgement, accepted) = oneshot::channel();
    if control
        .send(DriverCommand {
            command,
            input_metadata: None,
            acknowledgement,
        })
        .await
        .is_err()
    {
        return if cancel_is_idempotent {
            Ok(())
        } else {
            Err(RpcError::internal("session driver is no longer available"))
        };
    }
    drop(admission_guard);
    match accepted.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(LoopControlError::Closed)) | Err(_) if cancel_is_idempotent => Ok(()),
        Ok(Err(error)) => Err(RpcError::internal(error.to_string())),
        Err(_) => Err(RpcError::internal(
            "session driver closed without acknowledgement",
        )),
    }
}
