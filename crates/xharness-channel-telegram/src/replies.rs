//! Telegram text/button replies, one Bot API effect per durable outbox record.
use crate::{BotUser, Client, Error, InlineButton};
use async_trait::async_trait;
use std::sync::Arc;
use xharness_remote::{
    Account, Channel, Gateway, Outgoing, ProviderReceipt, ReplyBody, ReplyFailure, ReplyPlan,
    ReplyTransport, SendOutcome, SendRequest, Subscription, MAX_REPLY_BATCH,
};

pub struct Replies {
    client: Arc<Client>,
    account: Account,
}
impl Replies {
    pub async fn connect(client: Arc<Client>, expected_bot_id: u64) -> Result<Self, Error> {
        if expected_bot_id == 0 || expected_bot_id > i64::MAX as u64 {
            return Err(Error::Configuration);
        }
        let BotUser { id, .. } = client.identify_for_polling().await?;
        if id as u64 != expected_bot_id {
            return Err(Error::Configuration);
        }
        Ok(Self {
            client,
            account: Account {
                channel: Channel::Telegram,
                id: expected_bot_id.to_string(),
            },
        })
    }
}
#[async_trait]
impl ReplyTransport for Replies {
    fn account(&self) -> &Account {
        &self.account
    }
    async fn send(&self, request: SendRequest) -> SendOutcome {
        if request.account != self.account
            || request.sender.channel != Channel::Telegram
            || request.sender.account != self.account.id
        {
            return SendOutcome::Rejected(ReplyFailure::Forbidden);
        }
        let chat = match request.conversation.parse::<i64>() {
            Ok(id)
                if id > 0
                    && id.to_string() == request.sender.user
                    && id.to_string() == request.conversation =>
            {
                id
            }
            _ => return SendOutcome::Rejected(ReplyFailure::Forbidden),
        };
        let keyboard: Vec<Vec<InlineButton>> = request
            .body
            .buttons
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|b| InlineButton {
                        text: b.label,
                        callback_data: b.ticket,
                    })
                    .collect()
            })
            .collect();
        let result = if let Some(media) = request.attachment {
            if request
                .body
                .attachment
                .as_ref()
                .is_none_or(|r| r.id != media.id)
                || request.replace_message.is_some()
                || !keyboard.is_empty()
            {
                return SendOutcome::Rejected(ReplyFailure::InvalidInput);
            }
            self.client
                .send_attachment(chat, &request.body.text, media)
                .await
        } else if request.body.attachment.is_some() {
            return SendOutcome::Rejected(ReplyFailure::InvalidInput);
        } else if let Some(message) = request.replace_message {
            let message = match message.parse::<i64>() {
                Ok(id) if id > 0 => id,
                _ => return SendOutcome::Rejected(ReplyFailure::InvalidInput),
            };
            self.client
                .edit_message_with_buttons(chat, message, &request.body.text, keyboard)
                .await
        } else {
            self.client
                .send_message(chat, &request.body.text, keyboard)
                .await
        };
        match result {
            Ok(message) => SendOutcome::Delivered(ProviderReceipt {
                message_id: message.message_id.to_string(),
            }),
            Err(Error::RateLimited { retry_after }) => SendOutcome::RetryAfter {
                seconds: retry_after,
            },
            Err(Error::Unauthorized) => SendOutcome::Rejected(ReplyFailure::InvalidCredentials),
            Err(Error::Configuration | Error::InvalidAttachment | Error::AttachmentTooLarge) => {
                SendOutcome::Rejected(ReplyFailure::InvalidInput)
            }
            Err(Error::Rejected { status: 404 }) => SendOutcome::Rejected(ReplyFailure::TargetGone),
            Err(Error::Rejected { status: 400 }) => {
                SendOutcome::Rejected(ReplyFailure::ProviderRejected)
            }
            Err(Error::Rejected { status: 403 }) => SendOutcome::Rejected(ReplyFailure::Forbidden),
            Err(_) => SendOutcome::Uncertain,
        }
    }
}

/// Plain text splitting is lossless and UTF-16-aware. Do not truncate long
/// model output, put all chunks in one transaction with stable part identities.
/// Rendering live projection/approval tickets remains its separate owner.
pub async fn enqueue_text(
    gateway: &Gateway,
    scope: Subscription,
    id: &str,
    text: &str,
) -> Result<Vec<Outgoing>, xharness_remote::Error> {
    if id.is_empty()
        || id.len() > 480
        || text.is_empty()
        || text.contains('\0')
        || text.len() > 128 * 1024
    {
        return Err(xharness_remote::Error::Invalid(
            "Telegram reply text identity/bound",
        ));
    }
    let chunks = split_text(text);
    if chunks.len() > MAX_REPLY_BATCH {
        return Err(xharness_remote::Error::Capacity);
    }
    let plans = chunks
        .into_iter()
        .enumerate()
        .map(|(i, text)| ReplyPlan {
            id: format!("{id}/part-{i}"),
            body: ReplyBody {
                attachment: None,
                text,
                buttons: vec![],
            },
            replace_of: None,
        })
        .collect();
    gateway.enqueue_replies(scope, plans).await
}
pub(crate) fn split_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        if units + ch.len_utf16() > 4096 {
            chunks.push(text[start..index].to_owned());
            start = index;
            units = 0;
        }
        units += ch.len_utf16();
    }
    if start < text.len() {
        chunks.push(text[start..].to_owned());
    }
    chunks
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_unicode_reply_is_lossless_and_each_part_fits_telegram_utf16_budget() {
        let text = format!("{}{}{}", "a".repeat(4095), "😀".repeat(3000), "\n尾部");
        let chunks = split_text(&text);
        assert_eq!(chunks.concat(), text);
        assert!(chunks.len() > 2);
        assert!(chunks
            .iter()
            .all(|s| !s.is_empty() && s.encode_utf16().count() <= 4096));
    }
}
