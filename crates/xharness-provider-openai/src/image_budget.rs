//! Provider-specific image allowances, independent of learned text calibration.
use reqwest::Url;
use serde_json::Value;
use xharness_token::TokenMeterError;

/// DeepSeek documents at most 1,024 tokens per image after server resizing.
/// Use the upper bound, not an inferred split of mixed prompt usage. Verified
/// 2026-10-18: https://api-docs.deepseek.com/guides/vision/#token-usage
const DEEPSEEK_FLASH_IMAGE_BOUND: u64 = 1024;

fn has_documented_bound(base_url: &str, model: &str) -> bool {
    if !matches!(
        model,
        "deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-flash-vision-exp"
    ) {
        return false;
    }
    let Ok(url) = Url::parse(base_url) else {
        return false;
    };
    // A model name on a proxy, local server or unknown route is not evidence
    // that its image preprocessing follows the official service's contract.
    url.scheme() == "https"
        && url.host_str() == Some("api.deepseek.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path().trim_end_matches('/'), "" | "/v1" | "/beta")
}

pub(crate) fn estimate(
    base_url: &str,
    model: &str,
    messages: &[Value],
) -> Result<u64, TokenMeterError> {
    // Retain metadata validation and the existing saturating fallback for
    // unsupported deployments. Changing one provider must not discount others.
    let fallback = xharness_token::image_estimate(messages)?;
    if !has_documented_bound(base_url, model) {
        return Ok(fallback);
    }
    Ok(messages
        .iter()
        .filter_map(|m| m.get("content_blocks").and_then(Value::as_array))
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("image"))
        .fold(0u64, |sum, _| {
            sum.saturating_add(DEEPSEEK_FLASH_IMAGE_BOUND)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn images(width: u64, height: u64, count: usize) -> Vec<Value> {
        vec![
            json!({"content_blocks": vec![json!({"type":"image", "attachment":{
            "width":width,"height":height
        }}); count]}),
        ]
    }

    #[test]
    fn documented_models_and_official_routes_use_the_per_image_bound() {
        for model in [
            "deepseek-flash",
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
        ] {
            for base in [
                "https://api.deepseek.com",
                "https://api.deepseek.com/",
                "https://api.deepseek.com/v1/",
                "https://api.deepseek.com/beta",
                "https://API.DEEPSEEK.COM:443",
            ] {
                for (w, h) in [(1, 1), (512, 512), (3600, 2400), (8192, 16)] {
                    for count in [0, 1, 2, 17, 600] {
                        assert_eq!(
                            estimate(base, model, &images(w, h, count)).unwrap(),
                            1024 * count as u64,
                            "{base} {model} {w}x{h} {count}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn unknown_models_and_deployments_keep_the_original_fallback() {
        let messages = images(3600, 2400, 2);
        for base in [
            "http://api.deepseek.com",
            "https://api.deepseek.com:8443",
            "https://api.deepseek.com.evil.example",
            "https://api.deepseek.com@proxy.example",
            "https://user:password@api.deepseek.com",
            "https://api.deepseek.com/custom",
            "https://api.deepseek.com/v1?route=other",
            "https://api.deepseek.com/#other",
            "https://api.openai.com/v1",
            "http://localhost:8080/v1",
            "not a URL",
        ] {
            assert_eq!(
                estimate(base, "deepseek-flash", &messages).unwrap(),
                270_000
            );
        }
        for model in [
            "deepseek-v4-pro",
            "deepseek-chat",
            "deepseek-flash-custom",
            "deepseek-flash-2099",
            "proxy/deepseek-flash",
            "DEEPSEEK-FLASH",
            "",
        ] {
            assert_eq!(
                estimate("https://api.deepseek.com", model, &messages).unwrap(),
                270_000
            );
        }
        assert_eq!(
            estimate(
                "https://other.example",
                "other",
                &images(u64::MAX, u64::MAX, 2)
            )
            .unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn invalid_metadata_still_fails_and_non_images_do_not_add_allowance() {
        for dimensions in [
            json!({}),
            json!({"width":0,"height":2400}),
            json!({"width":3600,"height":null}),
            json!({"width":-1,"height":10}),
            json!({"width":1.5,"height":10}),
        ] {
            let messages =
                vec![json!({"content_blocks":[{"type":"image","attachment":dimensions}]})];
            assert!(estimate("https://api.deepseek.com", "deepseek-flash", &messages).is_err());
        }
        let messages = vec![json!({"content_blocks":[
            {"type":"text","text":"caption"},
            {"type":"file","attachment":{"width":3600,"height":2400}}
        ]})];
        assert_eq!(
            estimate("https://api.deepseek.com", "deepseek-flash", &messages).unwrap(),
            0
        );
    }
}
