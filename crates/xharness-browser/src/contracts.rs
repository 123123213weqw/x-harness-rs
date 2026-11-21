//! Payload validation shared by the WebView adapters and owned Chromium.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

pub const MAX_CALLBACK_BYTES: usize = 32 * 1024;
pub const MAX_OBSERVATION_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Page,
    Main,
    Dialog,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectRequest {
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub text_offset: usize,
    #[serde(default)]
    pub node_offset: usize,
    #[serde(default)]
    pub option_offset: usize,
}

impl InspectRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.text_offset > 1_000_000
            || self.node_offset > 1_000_000
            || self.option_offset > 1_000_000
        {
            return Err("observation offset exceeds inspection limits".into());
        }
        Ok(())
    }
}

pub fn decode_callback(raw: &str) -> Result<Value, String> {
    if raw.len() > MAX_CALLBACK_BYTES {
        return Err("native observation callback is too large".into());
    }
    // Native adapters supply a JSON-encoded JS string. This is not a
    // guest-origin network callback or an input command.
    let serialized: String =
        serde_json::from_str(raw).map_err(|_| "invalid native observation callback".to_owned())?;
    if serialized.len() > MAX_OBSERVATION_BYTES {
        return Err("native observation is too large".into());
    }
    serde_json::from_str(&serialized).map_err(|_| "invalid guest-page evidence".to_owned())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum PerformRequest {
    Click {
        frame_id: String,
        r#ref: String,
    },
    Fill {
        frame_id: String,
        r#ref: String,
        text: String,
    },
    Select {
        frame_id: String,
        r#ref: String,
        value: String,
    },
    Scroll {
        frame_id: String,
        delta_y: i32,
    },
}

impl PerformRequest {
    pub fn frame(&self) -> &str {
        match self {
            Self::Click { frame_id, .. }
            | Self::Fill { frame_id, .. }
            | Self::Select { frame_id, .. }
            | Self::Scroll { frame_id, .. } => frame_id,
        }
    }

    pub fn reference(&self) -> Option<&str> {
        match self {
            Self::Click { r#ref, .. } | Self::Fill { r#ref, .. } | Self::Select { r#ref, .. } => {
                Some(r#ref)
            }
            Self::Scroll { .. } => None,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.frame().len() != 32 || !self.frame().bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid frame_id".into());
        }
        if self.reference().is_some_and(|reference| {
            !reference.starts_with('n')
                || reference.len() > 8
                || reference[1..].is_empty()
                || !reference[1..].bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return Err("invalid observed ref".into());
        }
        match self {
            Self::Fill { text, .. } if text.len() > 16000 => {
                Err("fill text exceeds byte limit".into())
            }
            Self::Select { value, .. } if value.len() > 500 => {
                Err("select value exceeds byte limit".into())
            }
            Self::Scroll { delta_y, .. } if *delta_y == 0 || delta_y.unsigned_abs() > 5000 => {
                Err("invalid scroll delta".into())
            }
            _ => Ok(()),
        }
    }

    pub fn script(&self) -> Result<String, String> {
        let mut arguments = serde_json::to_value(self).map_err(|_| "invalid DOM action")?;
        // Expire queued script work before the callback deadline. A stalled
        // renderer must not execute a forgotten action arbitrarily later.
        arguments["deadline_epoch_ms"] = Value::from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "clock unavailable")?
                .as_millis() as u64
                + 5000,
        );
        Ok(format!("({})({arguments})", crate::OBSERVE_SCRIPT))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum InputRequest {
    Click {
        frame_id: String,
        x: f64,
        y: f64,
    },
    Move {
        frame_id: String,
        x: f64,
        y: f64,
    },
    Key {
        frame_id: String,
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
    },
}
impl InputRequest {
    pub fn frame(&self) -> &str {
        match self {
            Self::Click { frame_id, .. }
            | Self::Move { frame_id, .. }
            | Self::Key { frame_id, .. } => frame_id,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.frame().len() != 32 || !self.frame().bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid frame_id".into());
        }
        match self {
            Self::Click { x, y, .. } | Self::Move { x, y, .. }
                if !x.is_finite()
                    || !y.is_finite()
                    || *x < 0.0
                    || *y < 0.0
                    || *x > 8192.0
                    || *y > 8192.0 =>
            {
                Err("invalid CSS viewport point".into())
            }
            Self::Key { key, modifiers, .. } => {
                key_spec(key)?;
                if modifiers.len() > 4
                    || modifiers
                        .iter()
                        .any(|m| !["Shift", "Control", "Alt", "Meta"].contains(&m.as_str()))
                    || modifiers
                        .iter()
                        .enumerate()
                        .any(|(i, m)| modifiers[..i].contains(m))
                {
                    return Err("invalid key modifiers".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
// Explicit portable subset, not layout-dependent arbitrary keycode input.
// Text entry stays in DOM fill; native keys cover navigation/shortcuts.
pub struct KeySpec {
    pub text: String,
    pub windows: u32,
    pub mac: u16,
    pub gdk: u32,
}
pub fn key_spec(key: &str) -> Result<KeySpec, String> {
    let (text,windows,mac,gdk) = match key {
        "Enter" => ("\r",13,36,0xff0d), "Tab" => ("\t",9,48,0xff09),
        "Escape" => ("\u{1b}",27,53,0xff1b), "Backspace" => ("\u{8}",8,51,0xff08),
        "Delete" => ("\u{f728}",46,117,0xffff), "Space" => (" ",32,49,32),
        "ArrowLeft" => ("\u{f702}",37,123,0xff51), "ArrowRight" => ("\u{f703}",39,124,0xff53),
        "ArrowUp" => ("\u{f700}",38,126,0xff52), "ArrowDown" => ("\u{f701}",40,125,0xff54),
        "Home" => ("\u{f729}",36,115,0xff50), "End" => ("\u{f72b}",35,119,0xff57),
        "PageUp" => ("\u{f72c}",33,116,0xff55), "PageDown" => ("\u{f72d}",34,121,0xff56),
        _ if key.len()==1 && key.as_bytes()[0].is_ascii_lowercase() => {
            let c=key.as_bytes()[0];
            const MAC:[u16;26]=[0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6];
            return Ok(KeySpec{text:key.into(),windows:u32::from(c.to_ascii_uppercase()),mac:MAC[usize::from(c-b'a')],gdk:u32::from(c)});
        }
        _=>return Err("unsupported browser key; use Enter/Tab/Escape/Backspace/Delete/Space, arrows, Home/End/PageUp/PageDown or a-z".into()),
    };
    Ok(KeySpec {
        text: text.into(),
        windows,
        mac,
        gdk,
    })
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlRequest {
    Status {},
    Open { url: String },
    Close {},
}
pub fn web_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 4096 {
        return Err("URL is too long".into());
    }
    let url = Url::parse(raw).map_err(|_| "invalid URL".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("only http and https pages are supported".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in browser URLs are not supported".into());
    }
    Ok(url)
}
