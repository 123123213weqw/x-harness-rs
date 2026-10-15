//! WKWebView's default UA omits Safari's browser/version tokens. Some sites
//! reject it before loading any JavaScript. Complete that identity for guest
//! tabs only, preserving the native platform and WebKit tokens.

fn numeric_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && version.bytes().any(|byte| matches!(byte, b'1'..=b'9'))
}

pub(super) fn complete_webkit_user_agent(native: &str, safari_version: &str) -> Option<String> {
    if native.len() > 2048 || native.chars().any(char::is_control) {
        return None;
    }
    if !native.starts_with("Mozilla/5.0 (Macintosh;") {
        return None;
    }
    let tokens: Vec<_> = native.split_whitespace().collect();
    if tokens.iter().any(|token| {
        ["Chrome/", "Chromium/", "Edg/", "Firefox/", "OPR/"]
            .iter()
            .any(|prefix| token.starts_with(prefix))
    }) {
        return None;
    }
    let webkit = tokens
        .iter()
        .find_map(|token| token.strip_prefix("AppleWebKit/"))?;
    if !numeric_version(webkit) {
        return None;
    }
    let has_version = tokens.iter().any(|token| token.starts_with("Version/"));
    let has_safari = tokens.iter().any(|token| token.starts_with("Safari/"));
    if has_version && has_safari {
        return Some(native.to_owned());
    }
    // Do not repair ambiguous, partially customized identities.
    if has_version || has_safari || !numeric_version(safari_version) {
        return None;
    }
    Some(format!("{native} Version/{safari_version} Safari/{webkit}"))
}

#[cfg(target_os = "macos")]
fn installed_safari_version() -> Option<String> {
    use objc2_foundation::{NSBundle, NSString};

    // Read Apple's installed Safari bundle, not a hard-coded/latest release or
    // Safari Technology Preview. No subprocess, network lookup or new crate.
    for path in [
        "/Applications/Safari.app",
        "/System/Applications/Safari.app",
    ] {
        let Some(bundle) = NSBundle::bundleWithPath(&NSString::from_str(path)) else {
            continue;
        };
        let Some(value) =
            bundle.objectForInfoDictionaryKey(&NSString::from_str("CFBundleShortVersionString"))
        else {
            continue;
        };
        if let Ok(version) = value.downcast::<NSString>() {
            let version = version.to_string();
            if numeric_version(&version) {
                return Some(version);
            }
        }
    }
    None
}

// Only successful native samples become process-wide identity. A callback
// before the main WebView is ready (or another transient failure) must not
// permanently pin the system fallback for every later guest navigation.
async fn cached_identity<F>(identity: &tokio::sync::OnceCell<String>, sample: F) -> Option<&str>
where
    F: std::future::Future<Output = Result<String, String>>,
{
    identity
        .get_or_try_init(|| sample)
        .await
        .ok()
        .map(String::as_str)
}

#[cfg(target_os = "macos")]
pub(super) async fn for_macos(caller: &tauri::Webview) -> Option<&'static str> {
    static IDENTITY: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    cached_identity(&IDENTITY, async {
        let version = installed_safari_version()
            .ok_or_else(|| "installed Safari version unavailable".to_owned())?;
        // Only the trusted main WebView is sampled, never a visited page or
        // an IPC argument. Reuse the existing bounded native callback seam.
        let raw =
            crate::browser_inspect::evaluate(caller, "JSON.stringify(navigator.userAgent)".into())
                .await?;
        let value = crate::browser_inspect::decode_callback(&raw)?;
        let native = value
            .as_str()
            .ok_or_else(|| "native browser identity is not a string".to_owned())?;
        complete_webkit_user_agent(native, &version)
            .ok_or_else(|| "native browser identity cannot be completed".to_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    const NATIVE: &str =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

    #[tokio::test]
    async fn transient_sample_failure_is_not_cached_and_success_is_reused() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let identity = tokio::sync::OnceCell::new();
        let samples = AtomicUsize::new(0);
        assert_eq!(
            cached_identity(&identity, async {
                samples.fetch_add(1, Ordering::SeqCst);
                Err("main callback not ready".into())
            })
            .await,
            None
        );
        assert!(identity.get().is_none());
        let expected = complete_webkit_user_agent(NATIVE, "26.5").unwrap();
        for _ in 0..2 {
            assert_eq!(
                cached_identity(&identity, async {
                    samples.fetch_add(1, Ordering::SeqCst);
                    Ok(expected.clone())
                })
                .await,
                Some(expected.as_str())
            );
        }
        assert_eq!(samples.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancelled_sample_does_not_block_the_next_navigation() {
        let identity = tokio::sync::OnceCell::new();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            cached_identity(&identity, std::future::pending())
        )
        .await
        .is_err());
        assert!(identity.get().is_none());
        assert_eq!(
            cached_identity(&identity, async { Ok("recovered identity".into()) }).await,
            Some("recovered identity")
        );
    }

    #[test]
    fn completes_the_observed_wkwebview_identity_without_changing_its_engine() {
        assert_eq!(
            complete_webkit_user_agent(NATIVE, "26.5"),
            Some(format!("{NATIVE} Version/26.5 Safari/605.1.15"))
        );
    }

    #[test]
    fn uses_installed_version_and_native_webkit_not_fixed_release_numbers() {
        let native = NATIVE.replace("605.1.15", "617.2.4");
        assert_eq!(
            complete_webkit_user_agent(&native, "18.6.1"),
            Some(format!("{native} Version/18.6.1 Safari/617.2.4"))
        );
    }

    #[test]
    fn preserves_an_already_complete_identity() {
        let complete = format!("{NATIVE} Version/26.5 Safari/605.1.15");
        assert_eq!(
            complete_webkit_user_agent(&complete, "18.6"),
            Some(complete)
        );
    }

    #[test]
    fn rejects_missing_or_invalid_version_instead_of_claiming_a_new_engine() {
        for version in [
            "",
            "0",
            "26..5",
            "latest",
            "26.5\r\nInjected: yes",
            "26.5 Safari/999",
        ] {
            assert_eq!(complete_webkit_user_agent(NATIVE, version), None);
        }
    }

    #[test]
    fn leaves_non_macos_and_custom_browser_identities_alone() {
        for native in [
            NATIVE.replace("Macintosh", "Windows"),
            format!("{NATIVE} Chrome/140.0 Safari/537.36"),
            format!("{NATIVE} Firefox/143.0"),
            format!("{NATIVE} Version/26.5"),
            format!("{NATIVE} Safari/605.1.15"),
            NATIVE.replace("605.1.15", "unknown"),
            format!("{NATIVE}\nInjected: yes"),
            "x".repeat(2049),
        ] {
            assert_eq!(complete_webkit_user_agent(&native, "26.5"), None);
        }
    }
}
