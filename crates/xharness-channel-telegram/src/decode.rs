//! A private-chat sender is platform metadata, never a username/message command.
//! Unknown update kinds are terminal dispositions, not silently skipped offsets.
use serde::Deserialize;
use serde_json::Value;
use xharness_remote::RejectionCode;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: i64,
    pub is_bot: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Photo {
    pub file_id: String,
    pub width: u32,
    pub height: u32,
    pub file_size: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Document {
    pub file_id: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub message_id: i64,
    pub from: Option<User>,
    pub chat: crate::Chat,
    pub text: Option<String>,
    pub caption: Option<String>,
    #[serde(default)]
    pub photo: Vec<Photo>,
    pub document: Option<Document>,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct Callback {
    pub id: String,
    pub from: User,
    pub message: Option<Message>,
    pub data: Option<String>,
}
impl std::fmt::Debug for Callback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Callback")
            .field("id", &self.id)
            .field("from", &self.from)
            .field("message", &self.message.as_ref().map(|_| "[OMITTED]"))
            .field("data", &self.data.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Message(Box<Message>),
    Callback(Box<Callback>),
    Rejected(RejectionCode),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub update_id: u64,
    pub event: Event,
}

pub fn decode(value: &Value) -> Result<Decoded, crate::Error> {
    let update_id = value["update_id"]
        .as_u64()
        .filter(|n| *n < i64::MAX as u64)
        .ok_or(crate::Error::MalformedResponse)?;
    let message = value.get("message");
    let callback = value.get("callback_query");
    let event = match (message, callback) {
        (Some(message), None) => match serde_json::from_value::<Message>(message.clone()) {
            Ok(parsed) if private_message(&parsed) => {
                if [
                    "audio",
                    "voice",
                    "video",
                    "video_note",
                    "sticker",
                    "animation",
                    "paid_media",
                    "poll",
                    "contact",
                    "location",
                    "venue",
                    "dice",
                ]
                .iter()
                .any(|field| message.get(field).is_some())
                {
                    Event::Rejected(RejectionCode::Unsupported)
                } else {
                    Event::Message(Box::new(parsed))
                }
            }
            Ok(_) => Event::Rejected(RejectionCode::Forbidden),
            Err(_) => Event::Rejected(RejectionCode::Malformed),
        },
        (None, Some(callback)) => match serde_json::from_value::<Callback>(callback.clone()) {
            Ok(callback)
                if callback.from.id > 0
                    && !callback.from.is_bot
                    && !callback.id.is_empty()
                    && callback.id.len() <= 512
                    && callback
                        .data
                        .as_ref()
                        .is_some_and(|data| !data.is_empty() && data.len() <= 64)
                    && callback.message.as_ref().is_some_and(|message| {
                        message.chat.kind == "private" && message.chat.id == callback.from.id
                    }) =>
            {
                Event::Callback(Box::new(callback))
            }
            Ok(_) => Event::Rejected(RejectionCode::Forbidden),
            Err(_) => Event::Rejected(RejectionCode::Malformed),
        },
        (None, None) => Event::Rejected(RejectionCode::Unsupported),
        _ => Event::Rejected(RejectionCode::Malformed),
    };
    Ok(Decoded { update_id, event })
}
fn private_message(message: &Message) -> bool {
    message.message_id > 0
        && message.chat.kind == "private"
        && message
            .from
            .as_ref()
            .is_some_and(|user| user.id > 0 && !user.is_bot && message.chat.id == user.id)
        && message.photo.len() <= 16
        && message
            .text
            .as_ref()
            .is_none_or(|text| text.len() <= 128 * 1024)
        && message
            .caption
            .as_ref()
            .is_none_or(|text| text.len() <= 128 * 1024)
}
