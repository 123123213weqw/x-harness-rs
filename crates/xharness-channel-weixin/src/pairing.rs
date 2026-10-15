use crate::client::{common_headers, production_api_base, Http};
use crate::{bounded_string, BotToken, Credentials, Error, API_BASE};
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub struct PairingClient {
    http: Http,
}
impl PairingClient {
    pub fn new() -> Result<Self, Error> {
        Ok(Self {
            http: Http::production(production_api_base(API_BASE)?)?,
        })
    }
    pub fn loopback_fixture(base: &str) -> Result<Self, Error> {
        Ok(Self {
            http: Http::loopback(base)?,
        })
    }
    /// User explicitly requests a QR; existing tokens are not disclosed to the
    /// provider. No automatic account takeover/reauthorization on worker errors.
    pub async fn start(&self, cancel: &CancellationToken) -> Result<LoginSession, Error> {
        let request = self.http.post(
            "ilink/bot/get_bot_qrcode?bot_type=3",
            None,
            json!({"local_token_list":[]}),
        )?;
        let value = self.http.json(request, false, cancel).await?;
        let qr: QrWire = serde_json::from_value(value).map_err(|_| Error::MalformedResponse)?;
        if !bounded_string(&qr.qrcode, 16 * 1024)
            || !bounded_string(&qr.qrcode_img_content, 16 * 1024)
        {
            return Err(Error::MalformedResponse);
        }
        Ok(LoginSession {
            nonce: qr.qrcode,
            display_content: qr.qrcode_img_content,
            started: Instant::now(),
            api_base: self.http.api_base.clone(),
            redirects: 0,
            consumed: false,
        })
    }
    pub async fn poll(
        &self,
        session: &mut LoginSession,
        verify_code: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<PairingStatus, Error> {
        if session.consumed || session.started.elapsed() >= Duration::from_secs(300) {
            return Err(Error::PairingExpired);
        }
        if verify_code.is_some_and(|v| {
            v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_alphanumeric())
        }) {
            return Err(Error::Configuration);
        }
        let mut url = session
            .api_base
            .join("ilink/bot/get_qrcode_status")
            .map_err(|_| Error::Configuration)?;
        url.query_pairs_mut().append_pair("qrcode", &session.nonce);
        if let Some(code) = verify_code {
            url.query_pairs_mut().append_pair("verify_code", code);
        }
        let request = self.http.client.get(url).headers(common_headers()?);
        let value = self.http.json(request, false, cancel).await?;
        let status: StatusWire =
            serde_json::from_value(value).map_err(|_| Error::MalformedResponse)?;
        match status.status.as_str() {
            "wait" => Ok(PairingStatus::Waiting),
            "scaned" => Ok(PairingStatus::Scanned),
            "need_verifycode" => Ok(PairingStatus::NeedsVerification),
            "expired" => {
                session.consumed = true;
                Ok(PairingStatus::Expired)
            }
            "verify_code_blocked" => {
                session.consumed = true;
                Ok(PairingStatus::VerificationBlocked)
            }
            "binded_redirect" => {
                session.consumed = true;
                Ok(PairingStatus::AlreadyBound)
            }
            "scaned_but_redirect" => {
                if session.redirects >= 4 {
                    return Err(Error::MalformedResponse);
                }
                let host = status.redirect_host.ok_or(Error::MalformedResponse)?;
                if host.is_empty()
                    || host.contains('/')
                    || host.contains('@')
                    || host.contains('?')
                    || host.contains('#')
                {
                    return Err(Error::MalformedResponse);
                }
                session.api_base = self
                    .http
                    .validate_api(&format!("https://{host}/"))
                    .map_err(|_| Error::MalformedResponse)?;
                session.redirects += 1;
                Ok(PairingStatus::Redirected)
            }
            "confirmed" => {
                let api_base = self
                    .http
                    .validate_api(
                        status
                            .baseurl
                            .as_deref()
                            .unwrap_or(session.api_base.as_str()),
                    )
                    .map_err(|_| Error::MalformedResponse)?;
                let token = BotToken::new(status.bot_token.ok_or(Error::MalformedResponse)?)
                    .map_err(|_| Error::MalformedResponse)?;
                let bot_id = status.ilink_bot_id.ok_or(Error::MalformedResponse)?;
                let owner_id = status.ilink_user_id.ok_or(Error::MalformedResponse)?;
                if !bounded_string(&bot_id, 512) || !bounded_string(&owner_id, 512) {
                    return Err(Error::MalformedResponse);
                }
                session.consumed = true;
                Ok(PairingStatus::Confirmed(Credentials {
                    token,
                    api_base,
                    bot_id,
                    owner_id,
                }))
            }
            _ => Err(Error::MalformedResponse),
        }
    }
}
/// Display only in the initiating trusted setup view; never publish its nonce.
pub struct LoginSession {
    nonce: String,
    display_content: String,
    started: Instant,
    api_base: reqwest::Url,
    redirects: u8,
    consumed: bool,
}
impl LoginSession {
    pub fn display_content(&self) -> &str {
        &self.display_content
    }
    pub fn remaining_seconds(&self) -> u64 {
        300u64.saturating_sub(self.started.elapsed().as_secs())
    }
}
impl std::fmt::Debug for LoginSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LoginSession([redacted])")
    }
}
#[derive(Debug)]
pub enum PairingStatus {
    Waiting,
    Scanned,
    NeedsVerification,
    Redirected,
    Expired,
    VerificationBlocked,
    /// Does not authenticate or grant access without a stored original identity.
    AlreadyBound,
    Confirmed(Credentials),
}
#[derive(Deserialize)]
struct QrWire {
    qrcode: String,
    qrcode_img_content: String,
}
#[derive(Deserialize)]
struct StatusWire {
    status: String,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    ilink_user_id: Option<String>,
    baseurl: Option<String>,
    redirect_host: Option<String>,
}
