//! Disposable visual observations, never edits to the append-only transcript.
#![forbid(unsafe_code)]

use crate::{ContextError, ContextSurface};
use std::collections::HashSet;
use xharness_session::{ContentBlock, MessageRole};

impl ContextSurface {
    /// Keep the most recent visual tool transaction, including parallel image
    /// reads. Explicit user images are NOT subject to this observation window.
    /// Earlier observations retain their text and session-scoped read reference;
    /// no generated description is substituted for an unseen image. Callers
    /// must first verify closed, known tool outcomes from journal provenance.
    pub fn defer_superseded_tool_images(&mut self) -> Result<(), ContextError> {
        let Some(last_visual) = self.messages.iter().rposition(|m| {
            m.role == MessageRole::Tool
                && m.content_blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Image { .. }))
        }) else {
            return Ok(());
        };
        let start = self.messages[..last_visual]
            .iter()
            .rposition(|m| m.role == MessageRole::Assistant && !m.tool_calls.is_empty())
            .unwrap_or(last_visual);
        let mut seen = HashSet::new();
        for (index, message) in self.messages.iter_mut().enumerate().rev() {
            if message.role != MessageRole::Tool
                || message.interrupted
                || !message.provider_items.is_empty()
            {
                continue;
            }
            for block in message.content_blocks.iter_mut().rev() {
                let ContentBlock::Image { attachment } = block else {
                    continue;
                };
                // Include verified metadata: a malformed conflicting reference
                // must still reach the resolver, not disappear as a duplicate.
                let key = (
                    attachment.session_id.clone(),
                    attachment.id.clone(),
                    attachment.width,
                    attachment.height,
                    attachment.bytes,
                    attachment.media_type.clone(),
                );
                let duplicate = index >= start && !seen.insert(key);
                if index >= start && !duplicate {
                    continue;
                }
                let path = serde_json::to_string(&format!("attachment://{}", attachment.id))
                    .map_err(|e| {
                        ContextError::policy(format!("image reference encoding failed: {e}"))
                    })?;
                *block = ContentBlock::Text { text: format!(
                    "[Image retained in original conversation; {}. Text observations are unchanged. To inspect this image, use read with path {path}.]",
                    if duplicate { "identical image is already in the current visual transaction" } else { "a newer visual tool transaction is available" }
                ) };
                self.deferred_images = self.deferred_images.saturating_add(1);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{AttachmentRef, Message, ToolCall};

    fn image(c: char) -> ContentBlock {
        ContentBlock::Image {
            attachment: AttachmentRef {
                id: c.to_string().repeat(64),
                session_id: "fixture".into(),
                media_type: "image/png".into(),
                bytes: 100,
                width: 1920,
                height: 1080,
            },
        }
    }
    fn batch(id: &str) -> Message {
        let mut message = Message::assistant("");
        message.tool_calls = vec![ToolCall {
            id: id.into(),
            ..Default::default()
        }];
        message
    }
    fn count(messages: &[Message]) -> usize {
        messages
            .iter()
            .flat_map(|m| &m.content_blocks)
            .filter(|b| matches!(b, ContentBlock::Image { .. }))
            .count()
    }

    #[test]
    fn old_tool_images_become_readable_references_not_history_deletions() {
        let original = vec![
            Message::user("compare these explicitly")
                .with_content_blocks(vec![image('a'), image('b')]),
            batch("old"),
            Message::tool("old", "observed old state").with_tool_blocks(vec![image('c')]),
            batch("new"),
            Message::tool("new", "observed new state").with_tool_blocks(vec![image('d')]),
        ];
        let mut surface = ContextSurface::identity(original.clone());
        surface.defer_superseded_tool_images().unwrap();
        assert_eq!(count(&surface.messages), 3);
        assert_eq!(surface.messages[0], original[0]);
        assert_eq!(surface.messages[2].content, "observed old state");
        let ContentBlock::Text { text } = &surface.messages[2].content_blocks[0] else {
            panic!("missing reference")
        };
        assert!(text.contains(&format!("attachment://{}", "c".repeat(64))));
        assert_eq!(count(&original), 4);
        let projected = surface.messages.clone();
        surface.defer_superseded_tool_images().unwrap();
        assert_eq!(surface.messages, projected, "projection is idempotent");
    }

    #[test]
    fn parallel_latest_images_survive_without_a_global_image_count_cap() {
        let mut messages = vec![batch("read-batch")];
        for c in 'a'..='q' {
            messages.push(Message::tool("read-batch", "image").with_content_blocks(vec![image(c)]));
        }
        let mut surface = ContextSurface::identity(messages);
        surface.defer_superseded_tool_images().unwrap();
        assert_eq!(count(&surface.messages), 17);
    }

    #[test]
    fn duplicates_retire_but_opaque_and_interrupted_messages_remain_exact() {
        let mut opaque = Message::tool("opaque", "keep").with_content_blocks(vec![image('b')]);
        opaque
            .provider_items
            .push(serde_json::json!({"opaque":true}));
        let mut interrupted =
            Message::tool("interrupted", "keep").with_content_blocks(vec![image('c')]);
        interrupted.interrupted = true;
        let original = vec![
            opaque,
            interrupted,
            batch("new"),
            Message::tool("new", "two equal images")
                .with_content_blocks(vec![image('a'), image('a')]),
        ];
        let mut surface = ContextSurface::identity(original.clone());
        surface.defer_superseded_tool_images().unwrap();
        assert_eq!(surface.messages[..2], original[..2]);
        assert_eq!(count(&surface.messages), 3);
        assert_eq!(surface.deferred_images, 1);
    }
}
