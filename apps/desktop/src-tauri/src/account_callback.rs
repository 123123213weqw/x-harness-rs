//! Untrusted OS activation: fixed route, no tokens, exact bounded parameters.
use url::Url;
pub const CALLBACK: &str = "com.xlang.xharness:/auth/callback";
pub fn valid_secret(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn parse(raw: &str) -> Option<(String, String)> {
    if raw.len() > 256 {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    let expected = Url::parse(CALLBACK).ok()?;
    if u.scheme() != expected.scheme()
        || u.host_str().is_some()
        || u.path() != "/auth/callback"
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return None;
    }
    let pairs: Vec<_> = u.query_pairs().collect();
    if pairs.len() != 2 {
        return None;
    }
    let code = pairs.iter().find(|(k, _)| k == "code")?.1.to_string();
    let state = pairs.iter().find(|(k, _)| k == "state")?.1.to_string();
    if !valid_secret(&code) || !valid_secret(&state) {
        return None;
    }
    Some((code, state))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_accepts_only_fixed_bounded_route() {
        let good = format!(
            "{CALLBACK}?code={}&state={}",
            "a".repeat(43),
            "b".repeat(43)
        );
        assert!(parse(&good).is_some());
        for invalid in [
            good.replace("com.xlang.xharness:", "https:"),
            good.replace(":/", "://evil.invalid/"),
            good.replace("/auth/callback", "/other"),
            format!("{good}#fragment"),
            format!("{good}&accessToken=secret"),
            format!("{good}&code={}", "c".repeat(43)),
            good.replace("state=", "code="),
            good.replace(&"a".repeat(43), "short"),
            "x".repeat(1000),
        ] {
            assert!(parse(&invalid).is_none());
        }
    }
}
