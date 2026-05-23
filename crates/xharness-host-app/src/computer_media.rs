use std::sync::Weak;

use async_trait::async_trait;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xharness_computer::{ComputerMediaSink, Screenshot};
use xharness_host::BasicHost;
use xharness_tools::{ToolHandlerError, ToolOutput};

pub(crate) struct Sink {
    pub host: Weak<BasicHost>,
    pub session: String,
}

fn error(value: impl std::fmt::Display) -> ToolHandlerError {
    ToolHandlerError::new(value.to_string())
}

#[async_trait]
impl ComputerMediaSink for Sink {
    async fn supports_images(&self) -> bool {
        match self.host.upgrade() {
            Some(host) => host.session_accepts_images(&self.session).await,
            None => false,
        }
    }

    async fn project_png(
        &self,
        summary: String,
        screenshot: Screenshot,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolHandlerError> {
        if cancellation.is_cancelled() {
            return Err(error("computer observation cancelled"));
        }
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| error("attachment service unavailable"))?;
        if !host.session_accepts_images(&self.session).await {
            return Err(error(
                "current model does not declare image input; use semantic observation",
            ));
        }
        let attachment = host
            .attachment_store()
            .put(
                &self.session,
                xharness_attachments::Upload {
                    media_type: "image/png".into(),
                    data: screenshot.png,
                },
            )
            .await
            .map_err(error)?;
        if cancellation.is_cancelled() {
            return Err(error("computer observation cancelled"));
        }
        let image_label = format!(
            "{} ({} × {} pixels)",
            screenshot.label, attachment.width, attachment.height
        );
        Ok(ToolOutput {
            content: summary.clone(),
            metadata: Some(json!({
                "xharnessContentBlocks": [
                    xharness_session::ContentBlock::Text { text: summary },
                    xharness_session::ContentBlock::Text { text: image_label },
                    xharness_session::ContentBlock::Image { attachment }
                ]
            })),
        })
    }
}
