//! Long polling stops at durable remote admission, not Agent completion or an
//! outgoing reply. No message body can select a Host, principal or session.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::{Client, Error, Event, Message, MAX_ATTACHMENT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_remote::{
    Account, AccountLease, Channel, Command, Content, Gateway, Inbound, PromptMode, ReceiveInput,
    ReceiveReceipt, RejectionCode, Sender,
};

#[derive(Debug, thiserror::Error)]
pub enum IntakeError {
    #[error("Telegram intake transport failed: {0}")]
    Transport(#[from] Error),
    #[error("Telegram intake durable journal or authorization failed")]
    Journal,
}

pub struct Intake {
    client: Arc<Client>,
    gateway: Arc<Gateway>,
    lease: AccountLease,
}
impl Intake {
    /// The account id comes from trusted desktop configuration and must match
    /// getMe. A rotated credential for another bot cannot inherit this cursor.
    /// Composition must load the token from native credentials, not a file here.
    pub async fn connect(
        client: Arc<Client>,
        gateway: Arc<Gateway>,
        expected_bot_id: u64,
    ) -> Result<Self, IntakeError> {
        Self::connect_revision(client, gateway, expected_bot_id, None).await
    }
    pub async fn connect_configured(
        client: Arc<Client>,
        gateway: Arc<Gateway>,
        expected_bot_id: u64,
        revision: u64,
    ) -> Result<Self, IntakeError> {
        Self::connect_revision(client, gateway, expected_bot_id, Some(revision)).await
    }
    async fn connect_revision(
        client: Arc<Client>,
        gateway: Arc<Gateway>,
        expected_bot_id: u64,
        revision: Option<u64>,
    ) -> Result<Self, IntakeError> {
        if expected_bot_id == 0 || expected_bot_id > i64::MAX as u64 {
            return Err(Error::Configuration.into());
        }
        let bot = client.identify_for_polling().await?;
        if bot.id as u64 != expected_bot_id {
            return Err(Error::Configuration.into());
        }
        let account = Account {
            channel: Channel::Telegram,
            id: expected_bot_id.to_string(),
        };
        let lease = match revision {
            Some(revision) => gateway.acquire_configured_account(account, revision).await,
            None => gateway.acquire_account(account).await,
        }
        .map_err(|_| IntakeError::Journal)?;
        parse_cursor(&lease.cursor)?;
        Ok(Self {
            client,
            gateway,
            lease,
        })
    }

    pub fn lease(&self) -> AccountLease {
        self.lease.clone()
    }

    pub fn account(&self) -> &Account {
        &self.lease.account
    }

    /// Telegram confirms updates below the requested offset. Therefore every
    /// offset must come from the FULL-committed journal, never an in-memory batch.
    /// All ids are checked before a batch has any effect; an unknown id cannot be
    /// acknowledged by inferring it from its neighbors.
    pub async fn poll_once(
        &mut self,
        timeout_seconds: u8,
    ) -> Result<Vec<ReceiveReceipt>, IntakeError> {
        self.lease = self
            .gateway
            .account_checkpoint(&self.lease)
            .await
            .map_err(|_| IntakeError::Journal)?;
        let offset = parse_cursor(&self.lease.cursor)?;
        let updates = self.client.get_updates(offset, timeout_seconds).await?;
        let mut previous = None;
        for update in &updates {
            let id = update_id(update)?;
            if previous.is_some_and(|old| id <= old) {
                return Err(Error::MalformedResponse.into());
            }
            previous = Some(id);
        }
        let mut receipts = Vec::with_capacity(updates.len());
        for update in updates {
            let id = update_id(&update)?;
            if offset.is_some_and(|offset| id < offset) {
                continue;
            }
            // Check takeover before resolving identity or downloading attachments.
            self.lease = self
                .gateway
                .account_checkpoint(&self.lease)
                .await
                .map_err(|_| IntakeError::Journal)?;
            let raw = serde_json::to_vec(&update).map_err(|_| Error::MalformedResponse)?;
            let digest = format!("{:x}", Sha256::digest(raw));
            let input = self.normalize(id, &update).await?;
            let receipt = self
                .gateway
                .receive(
                    self.lease.clone(),
                    id.to_string(),
                    digest,
                    (id + 1).to_string(),
                    input,
                )
                .await
                .map_err(|_| IntakeError::Journal)?;
            if let Ok(crate::Decoded {
                event: Event::Callback(callback),
                ..
            }) = crate::decode(&update)
            {
                let text = if matches!(
                    receipt.outcome,
                    xharness_remote::ReceiveOutcome::Accepted { .. }
                ) {
                    "Received"
                } else {
                    "Not accepted"
                };
                // Informational receipt, not native approval success; failure
                // never rolls back the cursor or resends the control operation.
                match tokio::time::timeout(
                    Duration::from_secs(2),
                    self.client.answer_callback(&callback.id, text),
                )
                .await {
                    Ok(Ok(())) => {},
                    Ok(Err(_)) => eprintln!("xharness callback-receipt: transport_failed; durable admission was not retried"),
                    Err(_) => eprintln!("xharness callback-receipt: deadline_exceeded; durable admission was not retried"),
                }
            }
            receipts.push(receipt);
            // If this read or the next HTTP request fails, restart reloads the
            // durable cursor. It never repeats the accepted Agent operation.
            self.lease = self
                .gateway
                .account_checkpoint(&self.lease)
                .await
                .map_err(|_| IntakeError::Journal)?;
        }
        Ok(receipts)
    }

    /// Credential/conflict/malformed/journal failures stop this account. Only
    /// side-effect-free transport failures and explicit rate limits are retried.
    /// Dropping/cancelling intake never cancels accepted Gateway work.
    pub async fn run(mut self, shutdown: CancellationToken) -> Result<(), IntakeError> {
        let mut backoff = 1u64;
        loop {
            let result = tokio::select! {
                biased;
                _ = shutdown.cancelled() => return Ok(()),
                result = self.poll_once(25) => result,
            };
            let delay = match result {
                Ok(receipts) => {
                    backoff = 1;
                    // A broken proxy/fixture may ignore long-poll timeout. Do
                    // not spin an empty account at unbounded request frequency.
                    if receipts.is_empty() {
                        tokio::select! {
                            _ = shutdown.cancelled() => return Ok(()),
                            _ = tokio::time::sleep(Duration::from_millis(200)) => {},
                        }
                    }
                    continue;
                }
                Err(IntakeError::Transport(Error::RateLimited { retry_after })) => {
                    u64::from(retry_after)
                }
                Err(IntakeError::Transport(Error::Transport | Error::Timeout)) => backoff,
                Err(IntakeError::Transport(Error::Rejected { status })) if status >= 500 => backoff,
                Err(error) => return Err(error),
            };
            backoff = (backoff * 2).min(60);
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
            }
        }
    }

    async fn normalize(&self, id: u64, update: &Value) -> Result<ReceiveInput, IntakeError> {
        let message = match crate::decode(update)?.event {
            Event::Rejected(code) => return Ok(reject(code)),
            Event::Callback(callback) => return self.normalize_callback(id, *callback).await,
            Event::Message(message) => message,
        };
        let sender = Sender {
            channel: Channel::Telegram,
            account: self.lease.account.id.clone(),
            user: message
                .from
                .as_ref()
                .ok_or(Error::MalformedResponse)?
                .id
                .to_string(),
        };
        let conversation = message.chat.id.to_string();
        let Some(route) = self
            .gateway
            .resolve_sender(sender.clone(), conversation.clone())
            .await
            .map_err(|_| IntakeError::Journal)?
        else {
            return Ok(reject(RejectionCode::UnboundSender));
        };
        let command = match self.command(&message).await {
            Ok(Some(command)) => command,
            Ok(None) => return Ok(reject(RejectionCode::InvalidCommand)),
            Err(Error::AttachmentTooLarge | Error::InvalidAttachment) => {
                return Ok(reject(RejectionCode::InvalidCommand))
            }
            Err(Error::Rejected { status })
                if (400..500).contains(&status) && !matches!(status, 401 | 409 | 429) =>
            {
                return Ok(reject(RejectionCode::InvalidCommand))
            }
            Err(error) => return Err(error.into()),
        };
        Ok(ReceiveInput::Command {
            principal: route.principal,
            sender,
            conversation,
            inbound: Box::new(Inbound {
                request_id: id.to_string(),
                binding: route.binding.id,
                generation: route.binding.generation,
                command,
            }),
        })
    }

    async fn normalize_callback(
        &self,
        id: u64,
        callback: crate::Callback,
    ) -> Result<ReceiveInput, IntakeError> {
        let Some(data) = callback.data else {
            return Ok(reject(RejectionCode::Malformed));
        };
        let Some((choice, raw)) = data.split_once(':') else {
            return Ok(reject(RejectionCode::Unsupported));
        };
        let (raw, option) = match choice {
            "a" | "r" | "c" => (raw, None),
            "q" => {
                let Some((token, index)) = raw.split_once(':') else {
                    return Ok(reject(RejectionCode::InvalidCommand));
                };
                let Ok(index_number) = index.parse::<usize>() else {
                    return Ok(reject(RejectionCode::InvalidCommand));
                };
                if index_number >= 32 || index_number.to_string() != index {
                    return Ok(reject(RejectionCode::InvalidCommand));
                }
                (token, Some(index_number))
            }
            _ => return Ok(reject(RejectionCode::Unsupported)),
        };
        let token = match xharness_remote::TicketToken::try_from(raw.to_owned()) {
            Ok(t) => t,
            Err(_) => return Ok(reject(RejectionCode::InvalidCommand)),
        };
        // Sender/conversation are trusted Telegram metadata, never callback data.
        let sender = Sender {
            channel: Channel::Telegram,
            account: self.lease.account.id.clone(),
            user: callback.from.id.to_string(),
        };
        let conversation = callback.from.id.to_string();
        let Some(route) = self
            .gateway
            .resolve_sender(sender.clone(), conversation.clone())
            .await
            .map_err(|_| IntakeError::Journal)?
        else {
            return Ok(reject(RejectionCode::UnboundSender));
        };
        let scope = xharness_remote::Subscription {
            principal: route.principal.clone(),
            sender: sender.clone(),
            conversation: conversation.clone(),
            binding: route.binding.id.clone(),
            generation: route.binding.generation,
        };
        let pending = match self
            .gateway
            .interaction_ticket_for(scope, token.clone())
            .await
        {
            Ok(pending) => pending,
            Err(xharness_remote::Error::Unauthorized | xharness_remote::Error::Invalid(_)) => {
                return Ok(reject(RejectionCode::Forbidden))
            }
            Err(_) => return Err(IntakeError::Journal),
        };
        let answer = match (choice, pending.interaction.frame.method.as_str()) {
            ("a" | "r", "approval/requested") => {
                xharness_remote::ScopedInteractionAnswer::Approval {
                    allowed: choice == "a",
                }
            }
            ("c", "question/requested") => xharness_remote::ScopedInteractionAnswer::CancelQuestion,
            ("q", "question/requested") => {
                let questions = &pending.interaction.frame.payload["questions"];
                if questions.as_array().is_none_or(|q| q.len() != 1) {
                    return Ok(reject(RejectionCode::InvalidCommand));
                }
                let question = &questions[0];
                let Some(id) = question["id"].as_str() else {
                    return Err(IntakeError::Journal);
                };
                let Some(option) = option else {
                    return Ok(reject(RejectionCode::InvalidCommand));
                };
                let Some(selected) = question["options"][option]["label"].as_str() else {
                    return Ok(reject(RejectionCode::InvalidCommand));
                };
                xharness_remote::ScopedInteractionAnswer::Question {
                    answers: vec![xharness_remote::ScopedQuestionAnswer {
                        id: id.into(),
                        selected: Some(selected.into()),
                        custom: None,
                    }],
                }
            }
            _ => return Ok(reject(RejectionCode::InvalidCommand)),
        };
        Ok(ReceiveInput::Command {
            principal: route.principal,
            sender,
            conversation,
            inbound: Box::new(Inbound {
                request_id: id.to_string(),
                binding: route.binding.id,
                generation: route.binding.generation,
                command: Command::AnswerInteraction {
                    ticket: token,
                    answer,
                },
            }),
        })
    }

    async fn command(&self, message: &Message) -> Result<Option<Command>, Error> {
        // Never silently discard an unsupported attachment beside text.
        if message.document.is_some() && !message.photo.is_empty() {
            return Ok(None);
        }
        let text = message
            .text
            .as_deref()
            .or(message.caption.as_deref())
            .unwrap_or("");
        let (mode, prompt) = if text.starts_with('/') {
            let end = text.find(char::is_whitespace).unwrap_or(text.len());
            let name = &text[..end];
            let rest = text[end..].trim_start();
            match name {
                "/cancel" if rest.is_empty() && no_media(message) => {
                    return Ok(Some(Command::Cancel))
                }
                "/automations" if no_media(message) => {
                    #[derive(serde::Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Cursor {
                        after: String,
                    }
                    let after = if rest.trim().is_empty() {
                        None
                    } else {
                        let cursor = match serde_json::from_str::<Cursor>(rest.trim()) {
                            Ok(v) => v,
                            Err(_) => return Ok(None),
                        };
                        if cursor.after.is_empty()
                            || cursor.after.len() > 512
                            || cursor.after.chars().any(char::is_control)
                        {
                            return Ok(None);
                        }
                        Some(cursor.after)
                    };
                    return Ok(Some(Command::AutomationRead {
                        read: xharness_remote::AutomationRead::List { after },
                    }));
                }
                "/automation" if no_media(message) => {
                    if let Ok(read @ xharness_remote::AutomationRead::View { .. }) =
                        serde_json::from_str::<xharness_remote::AutomationRead>(rest.trim())
                    {
                        let xharness_remote::AutomationRead::View { id } = &read else {
                            unreachable!()
                        };
                        if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
                            return Ok(None);
                        }
                        return Ok(Some(Command::AutomationRead { read }));
                    }
                    let control = match serde_json::from_str::<xharness_remote::AutomationControl>(
                        rest.trim(),
                    ) {
                        Ok(v) => v,
                        Err(_) => return Ok(None),
                    };
                    if control.id().is_empty()
                        || control.id().len() > 512
                        || control.id().chars().any(char::is_control)
                    {
                        return Ok(None);
                    }
                    return Ok(Some(Command::AutomationControl { control }));
                }
                "/new" if no_media(message) => {
                    #[derive(serde::Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Target {
                        workspace: String,
                    }
                    let target = match serde_json::from_str::<Target>(rest.trim()) {
                        Ok(target) => target,
                        Err(_) => return Ok(None),
                    };
                    if target.workspace.is_empty()
                        || target.workspace.len() > 512
                        || target.workspace.chars().any(char::is_control)
                    {
                        return Ok(None);
                    }
                    return Ok(Some(Command::CreateSession {
                        workspace: target.workspace,
                    }));
                }
                "/select" if no_media(message) => {
                    let target = match serde_json::from_str::<xharness_remote::SessionSelection>(
                        rest.trim(),
                    ) {
                        Ok(target) => target,
                        Err(_) => return Ok(None),
                    };
                    if [&target.workspace, &target.session].into_iter().any(|id| {
                        id.is_empty() || id.len() > 512 || id.chars().any(char::is_control)
                    }) {
                        return Ok(None);
                    }
                    return Ok(Some(Command::Select { target }));
                }
                "/sessions" if no_media(message) => {
                    let after = if rest.trim().is_empty() {
                        None
                    } else {
                        let cursor = match serde_json::from_str::<xharness_remote::CatalogueCursor>(
                            rest.trim(),
                        ) {
                            Ok(cursor) => cursor,
                            Err(_) => return Ok(None),
                        };
                        if [&cursor.workspace, &cursor.session].into_iter().any(|id| {
                            id.is_empty() || id.len() > 512 || id.chars().any(char::is_control)
                        }) {
                            return Ok(None);
                        }
                        Some(cursor)
                    };
                    return Ok(Some(Command::Catalogue { after }));
                }
                "/history" if no_media(message) => {
                    let mut fields = rest.split_whitespace();
                    let max_messages = match fields.next() {
                        None => 50,
                        Some(raw) => match raw.parse::<u16>() {
                            Ok(n) if n > 0 && n <= 500 => n,
                            _ => return Ok(None),
                        },
                    };
                    let before_seq = match fields.next() {
                        None => None,
                        Some(raw) => match raw.parse::<u64>() {
                            Ok(n) if n > 0 && n.to_string() == raw => Some(n),
                            _ => return Ok(None),
                        },
                    };
                    if fields.next().is_some() {
                        return Ok(None);
                    }
                    return Ok(Some(Command::History {
                        before_seq,
                        max_messages,
                    }));
                }
                "/answer" if no_media(message) => {
                    let Some((raw, json)) = rest.split_once(char::is_whitespace) else {
                        return Ok(None);
                    };
                    let ticket = match xharness_remote::TicketToken::try_from(raw.to_owned()) {
                        Ok(t) => t,
                        Err(_) => return Ok(None),
                    };
                    let answers = match serde_json::from_str::<
                        Vec<xharness_remote::ScopedQuestionAnswer>,
                    >(json.trim())
                    {
                        Ok(a) => a,
                        Err(_) => return Ok(None),
                    };
                    let answer = xharness_remote::ScopedInteractionAnswer::Question { answers };
                    if !answer.is_bounded() {
                        return Ok(None);
                    }
                    return Ok(Some(Command::AnswerInteraction { ticket, answer }));
                }
                "/queue" => (PromptMode::Queue, rest),
                "/steer" => (PromptMode::Steer, rest),
                _ => return Ok(None),
            }
        } else {
            (PromptMode::Queue, text)
        };
        let mut content = Vec::new();
        if !prompt.trim().is_empty() {
            content.push(Content::Text {
                text: prompt.to_owned(),
            });
        }
        if let Some(photo) = message
            .photo
            .iter()
            .max_by_key(|p| u64::from(p.width) * u64::from(p.height))
        {
            if photo
                .file_size
                .is_some_and(|n| n > MAX_ATTACHMENT_BYTES as u64)
            {
                return Err(Error::AttachmentTooLarge);
            }
            let bytes = self.client.download_file(&photo.file_id).await?;
            // Telegram photo is JPEG; Host validates actual bytes and capabilities.
            content.push(Content::Image {
                media_type: "image/jpeg".into(),
                data: STANDARD.encode(bytes),
                name: None,
            });
        }
        if let Some(document) = &message.document {
            if document
                .file_size
                .is_some_and(|n| n > MAX_ATTACHMENT_BYTES as u64)
            {
                return Err(Error::AttachmentTooLarge);
            }
            let name = document.file_name.clone();
            if name.as_ref().is_some_and(|name| {
                name.is_empty()
                    || name.len() > 512
                    || name.chars().any(char::is_control)
                    || name.contains('/')
                    || name.contains('\\')
            }) {
                return Err(Error::InvalidAttachment);
            }
            let media_type = document
                .mime_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".into());
            if media_type.is_empty()
                || media_type.len() > 512
                || media_type.chars().any(char::is_control)
            {
                return Err(Error::InvalidAttachment);
            }
            let bytes = self.client.download_file(&document.file_id).await?;
            if matches!(
                media_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) {
                content.push(Content::Image {
                    media_type,
                    data: STANDARD.encode(bytes),
                    name,
                });
            } else {
                content.push(Content::File {
                    media_type,
                    data: STANDARD.encode(bytes),
                    name,
                });
            }
        }
        if content.is_empty() {
            return Ok(None);
        }
        Ok(Some(Command::Prompt {
            mode,
            content,
            client_time_zone: None,
        }))
    }
}
fn no_media(message: &Message) -> bool {
    message.document.is_none() && message.photo.is_empty()
}
fn reject(code: RejectionCode) -> ReceiveInput {
    ReceiveInput::Reject { code }
}
fn update_id(update: &Value) -> Result<u64, Error> {
    update["update_id"]
        .as_u64()
        .filter(|id| *id < i64::MAX as u64)
        .ok_or(Error::MalformedResponse)
}
fn parse_cursor(cursor: &str) -> Result<Option<u64>, Error> {
    if cursor.is_empty() {
        return Ok(None);
    }
    let id = cursor.parse::<u64>().map_err(|_| Error::Configuration)?;
    if id > i64::MAX as u64 || id.to_string() != cursor {
        return Err(Error::Configuration);
    }
    Ok(Some(id))
}
