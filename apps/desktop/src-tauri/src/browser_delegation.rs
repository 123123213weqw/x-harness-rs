//! Ephemeral consent belongs to the native tab, not page evidence or model args.
//! A grant is for one exact session and origin, never inherited by a subagent.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{State, Webview};
use url::Url;

use crate::browser::{ensure_main, BrowserState};

#[derive(Default)]
pub(super) struct Delegation(Mutex<Option<Grant>>);
struct Grant {
    owner: String,
    origin: String,
    actions: bool,
    expires: Instant,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    origin: String,
    grant: Option<GrantStatus>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantStatus {
    owner: String,
    allow_actions: bool,
    remaining_ms: u64,
}

impl Delegation {
    pub(super) fn grant(&self, owner: String, url: &Url, actions: bool) -> Result<(), String> {
        if owner.is_empty() || owner.len() > 128 || owner.chars().any(char::is_control) {
            return Err("invalid browser session owner".into());
        }
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("only a credential-free web origin may be delegated".into());
        }
        *self
            .0
            .lock()
            .map_err(|_| "browser delegation unavailable")? = Some(Grant {
            owner,
            origin: url.origin().ascii_serialization(),
            actions,
            expires: Instant::now() + Duration::from_secs(600),
        });
        Ok(())
    }

    pub(super) fn revoke(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }

    pub(super) fn permits(&self, owner: &str, url: &Url, action: bool) -> bool {
        self.0.lock().is_ok_and(|slot| {
            slot.as_ref().is_some_and(|grant| {
                grant.owner == owner
                    && grant.origin == url.origin().ascii_serialization()
                    && Instant::now() < grant.expires
                    && (!action || grant.actions)
            })
        })
    }

    pub(super) fn navigate(&self, url: &Url) {
        if let Ok(mut slot) = self.0.lock() {
            if slot
                .as_ref()
                .is_some_and(|grant| grant.origin != url.origin().ascii_serialization())
            {
                *slot = None;
            }
        }
    }

    fn status(&self, owner: &str, url: &Url) -> Result<AccessStatus, String> {
        let slot = self
            .0
            .lock()
            .map_err(|_| "browser delegation unavailable")?;
        let origin = url.origin().ascii_serialization();
        let grant = slot
            .as_ref()
            .filter(|grant| {
                grant.owner == owner && grant.origin == origin && Instant::now() < grant.expires
            })
            .map(|grant| GrantStatus {
                owner: grant.owner.clone(),
                allow_actions: grant.actions,
                remaining_ms: grant
                    .expires
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64,
            });
        Ok(AccessStatus { origin, grant })
    }
}

/// UI status is native-authoritative and never includes another session's lease.
#[tauri::command]
pub async fn desktop_browser_access(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    owner: String,
) -> Result<AccessStatus, String> {
    ensure_main(&caller)?;
    let (target, inspector) = state.inspection_target(&tab_id)?;
    inspector.delegation.status(
        &owner,
        &target.url().map_err(|_| "browser URL unavailable")?,
    )
}

/// Trusted UI must explicitly grant the CURRENT tab to its current session.
/// Nothing is persisted; hide/close/UI reload, another grant or ten minutes revoke
/// it. This command does not itself resume an Agent or execute a page action.
#[tauri::command]
pub async fn desktop_browser_delegate(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    owner: Option<String>,
    allow_actions: bool,
    expected_origin: Option<String>,
) -> Result<AccessStatus, String> {
    ensure_main(&caller)?;
    let (target, inspector) = state.inspection_target(&tab_id)?;
    inspector.revoke();
    let url = target.url().map_err(|_| "browser URL unavailable")?;
    let requested_owner = owner.clone().unwrap_or_default();
    if let Some(owner) = owner {
        // A delayed confirmation must not authorize a redirected/new origin.
        if expected_origin.as_deref() != Some(url.origin().ascii_serialization().as_str()) {
            return Err("browser origin changed; review access again".into());
        }
        inspector.delegation.grant(owner, &url, allow_actions)?;
    }
    let current = target.url().map_err(|_| "browser URL unavailable")?;
    inspector.delegation.navigate(&current);
    inspector.delegation.status(&requested_owner, &current)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_owner_origin_scope_expiry_and_revocation() {
        let grants = Delegation::default();
        let url = Url::parse("https://example.com/path?q=untrusted").unwrap();
        assert!(!grants.permits("parent", &url, false));
        grants.grant("parent".into(), &url, false).unwrap();
        let status = grants.status("parent", &url).unwrap();
        assert_eq!(status.origin, "https://example.com");
        let lease = status.grant.unwrap();
        assert!(!lease.allow_actions);
        assert!(lease.remaining_ms <= 600_000);
        assert!(grants.status("child", &url).unwrap().grant.is_none());
        assert!(grants.permits("parent", &url, false));
        assert!(!grants.permits("child", &url, false));
        assert!(!grants.permits("parent", &url, true));
        for other in [
            "http://example.com",
            "https://example.com:444",
            "https://other.example.com",
        ] {
            assert!(!grants.permits("parent", &Url::parse(other).unwrap(), false));
        }
        grants.navigate(&Url::parse("https://example.com/another").unwrap());
        assert!(grants.permits("parent", &url, false));
        grants.navigate(&Url::parse("https://other.example.com").unwrap());
        grants.navigate(&url); // Returning must not resurrect consent.
        assert!(!grants.permits("parent", &url, false));
        grants.grant("child".into(), &url, true).unwrap();
        assert!(!grants.permits("parent", &url, true));
        grants.0.lock().unwrap().as_mut().unwrap().expires = Instant::now();
        assert!(grants.status("child", &url).unwrap().grant.is_none());
        assert!(!grants.permits("child", &url, false));
        grants.grant("child".into(), &url, true).unwrap();
        grants.revoke();
        assert!(!grants.permits("child", &url, true));
    }
}
