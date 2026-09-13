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

#[cfg(target_os = "macos")]
pub(super) async fn for_macos(caller: &tauri::Webview) -> Option<&'static str> {
    static IDENTITY: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    IDENTITY
        .get_or_init(|| async {
            let version = installed_safari_version()?;
            // Only the trusted main WebView is sampled, never a visited page or
            // an IPC argument. Reuse the existing bounded native callback seam.
            let raw = crate::browser_inspect::evaluate(
                caller,
                "JSON.stringify(navigator.userAgent)".into(),
            )
            .await
            .ok()?;
            let value = crate::browser_inspect::decode_callback(&raw).ok()?;
            complete_webkit_user_agent(value.as_str()?, &version)
        })
        .await
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;
    const NATIVE: &str =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

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
