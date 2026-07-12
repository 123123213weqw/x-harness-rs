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
) -> Result<(), String> {
    ensure_main(&caller)?;
    let (target, inspector) = state.inspection_target(&tab_id)?;
    inspector.revoke();
    if let Some(owner) = owner {
        inspector.delegation.grant(
            owner,
            &target.url().map_err(|_| "browser URL unavailable")?,
            allow_actions,
        )?;
    }
    Ok(())
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
        assert!(!grants.permits("child", &url, false));
        grants.grant("child".into(), &url, true).unwrap();
        grants.revoke();
        assert!(!grants.permits("child", &url, true));
    }
}
