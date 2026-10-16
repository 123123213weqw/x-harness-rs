use crate::BasicHost;
use xharness_api::{
    ApiBackend, RpcError, ScopedAttachment, ScopedAttachmentKind, MAX_SCOPED_ATTACHMENT_BYTES,
};
use xharness_session::{ContentBlock, EventData};
pub(super) async fn read(
    host: &BasicHost,
    workspace: &str,
    session: &str,
    seq: u64,
    id: &str,
) -> Result<ScopedAttachment, RpcError> {
    let unavailable = || RpcError::internal("scoped attachment unavailable");
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !host.agent_runtime.has_authoritative_sessions()
        || !host.session_in_workspace(workspace, session).await?
    {
        return Err(unavailable());
    }
    let known = host
        .state
        .read()
        .await
        .sessions
        .get(session)
        .ok_or_else(unavailable)?
        .next_event_seq();
    let durable = host
        .agent_runtime
        .authoritative_session(session)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    if durable.header().id != session || durable.next_seq() < known {
        return Err(unavailable());
    }
    let event = durable
        .events()
        .get(usize::try_from(seq).map_err(|_| unavailable())?)
        .filter(|e| e.seq == seq)
        .ok_or_else(unavailable)?;
    let blocks = match event.data() {
        EventData::UserMessage { message, .. } | EventData::AssistantMessage { message, .. } => {
            message.content_blocks.clone()
        }
        EventData::ToolResult { result, .. } => {
            ContentBlock::from_tool_metadata(result.metadata.as_ref())
        }
        _ => return Err(unavailable()),
    };
    let (reference, kind) = blocks
        .into_iter()
        .find_map(|b| match b {
            ContentBlock::Image { attachment } if attachment.id == id => {
                Some((attachment, ScopedAttachmentKind::Image))
            }
            ContentBlock::File { attachment, .. } if attachment.id == id => {
                Some((attachment, ScopedAttachmentKind::File))
            }
            _ => None,
        })
        .ok_or_else(unavailable)?;
    if reference.bytes == 0 || reference.bytes > MAX_SCOPED_ATTACHMENT_BYTES as u64 {
        return Err(unavailable());
    }
    let resolved = host
        .config
        .attachment_store
        .resolve(&reference.session_id, id)
        .await
        .map_err(|_| unavailable())?;
    if resolved.reference != reference
        || resolved.data.len() as u64 != reference.bytes
        || !host.session_in_workspace(workspace, session).await?
    {
        return Err(unavailable());
    }
    Ok(ScopedAttachment {
        id: reference.id,
        kind,
        media_type: reference.media_type,
        width: reference.width,
        height: reference.height,
        data: resolved.data.as_ref().clone(),
    })
}
