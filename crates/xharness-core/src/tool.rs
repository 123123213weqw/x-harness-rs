use crate::ToolResult;
use serde_json::json;
use sha2::{Digest, Sha256};

/// Smallest supported model-facing tool-result budget.
///
/// The loop rejects smaller configured limits. [`tool_result_for_model`] also
/// uses this envelope as a fail-safe for direct callers, prioritizing valid
/// JSON over an impossible byte limit.
const LIMIT_TOO_SMALL_ENVELOPE: &str =
    r#"{"ok":false,"content":"","error":"tool result limit too small","truncated":true}"#;
pub const MIN_TOOL_RESULT_LIMIT_BYTES: usize = LIMIT_TOO_SMALL_ENVELOPE.len();

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn encode_tool_result(result: &ToolResult, content: &str, error: &str, truncated: bool) -> String {
    serde_json::to_string(&json!({
        "ok": result.ok,
        "content": content,
        "error": error,
        "truncated": result.truncated || truncated,
    }))
    .expect("serializing a JSON object cannot fail")
}

fn utf8_suffix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn sha256_hex(value: &str) -> String {
    let mut output = String::with_capacity(64);
    for byte in Sha256::digest(value.as_bytes()) {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn head_tail_excerpt(source: &str, keep_bytes: usize) -> (String, usize) {
    let head_budget = keep_bytes.saturating_mul(2) / 3;
    let head = utf8_prefix(source, head_budget);
    let tail = utf8_suffix(&source[head.len()..], keep_bytes.saturating_sub(head.len()));
    let omitted = source
        .len()
        .saturating_sub(head.len())
        .saturating_sub(tail.len());
    (
        format!("{head}\n...[{omitted} UTF-8 bytes omitted by head_tail/v1]...\n{tail}"),
        omitted,
    )
}

fn encode_reduced_tool_result(
    result: &ToolResult,
    excerpt: &str,
    source_is_error: bool,
    original_bytes: usize,
    omitted_bytes: usize,
    sha256: &str,
) -> String {
    serde_json::to_string(&json!({
        "ok": result.ok,
        "content": if source_is_error { "" } else { excerpt },
        "error": if source_is_error { excerpt } else { "" },
        "truncated": true,
        "reduction": {
            "strategy": "head_tail/v1",
            "original_bytes": original_bytes,
            "omitted_bytes": omitted_bytes,
            "sha256": sha256,
        }
    }))
    .expect("serializing a JSON object cannot fail")
}

/// Produces the bounded JSON value written back to the model. The original
/// [`ToolResult`] remains untouched and is emitted in `ToolCompleted`.
pub fn tool_result_for_model(result: &ToolResult, max_bytes: usize) -> (String, bool) {
    if max_bytes < MIN_TOOL_RESULT_LIMIT_BYTES {
        return (LIMIT_TOO_SMALL_ENVELOPE.to_owned(), true);
    }

    // Host-owned opt-in, not JSON-shape detection. Foreign MCP and arbitrary
    // strings retain their envelope; business values are never recursively parsed.
    if result
        .metadata
        .as_ref()
        .and_then(|m| m.get("model_output_format"))
        == Some(&json!("json_object/v1"))
    {
        return json_object_for_model(result, max_bytes);
    }

    let full = encode_tool_result(result, &result.content, &result.error, false);
    if full.len() <= max_bytes {
        return (full, false);
    }

    let minimal = encode_tool_result(result, "", "", true);
    debug_assert!(minimal.len() <= max_bytes);

    let source = if result.content.is_empty() {
        &result.error
    } else {
        &result.content
    };
    let source_is_error = result.content.is_empty();
    let digest = sha256_hex(source);
    let mut low = 0usize;
    let mut high = source.len();
    let mut reduced = None;
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let (excerpt, omitted) = head_tail_excerpt(source, midpoint);
        let candidate = encode_reduced_tool_result(
            result,
            &excerpt,
            source_is_error,
            source.len(),
            omitted,
            &digest,
        );
        if candidate.len() <= max_bytes {
            reduced = Some(candidate);
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    if let Some(reduced) = reduced {
        return (reduced, true);
    }

    let mut low = 0usize;
    let mut high = source.len();
    let mut best = String::new();
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let prefix = utf8_prefix(source, midpoint);
        let candidate = if result.content.is_empty() {
            encode_tool_result(result, "", prefix, true)
        } else {
            encode_tool_result(result, prefix, "", true)
        };
        if candidate.len() <= max_bytes {
            best = candidate;
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    if best.is_empty() {
        best = minimal;
    }
    (best, true)
}

fn json_object_for_model(result: &ToolResult, max_bytes: usize) -> (String, bool) {
    let mut value = match serde_json::from_str::<serde_json::Value>(&result.content) {
        Ok(value) if value.is_object() => value,
        _ => json!({"ok":false,"error":"invalid structured tool result"}),
    };
    // A later pipeline failure cannot be turned into success by a receipt.
    if !result.ok && value["ok"] != false {
        value["ok"] = json!(false);
        value["error"] = json!(result.error);
    } else if !value.get("ok").is_some_and(serde_json::Value::is_boolean) {
        value["ok"] = json!(result.ok);
    }
    value["truncated"] = json!(result.truncated || value["truncated"] == true);
    let full = value.to_string();
    if full.len() <= max_bytes {
        return (full, value["truncated"] == true);
    }

    // Never put an excerpt of serialized JSON inside another JSON string.
    // Retain safety/status fields first; the durable archive holds all data.
    let mut reduced = json!({"ok":value["ok"],"truncated":true});
    for key in ["effect", "status", "code", "error", "message"] {
        if let Some(field) = value.get(key) {
            let field = if let Some(text) = field.as_str() {
                json!(utf8_prefix(text, 512))
            } else if key == "error" && field.is_object() {
                let mut error = serde_json::Map::new();
                for key in ["name", "message"] {
                    if let Some(text) = field.get(key).and_then(serde_json::Value::as_str) {
                        error.insert(key.into(), json!(utf8_prefix(text, 512)));
                    }
                }
                serde_json::Value::Object(error)
            } else {
                continue;
            };
            reduced[key] = field;
            if reduced.to_string().len() > max_bytes {
                if let Some(object) = reduced.as_object_mut() {
                    object.remove(key);
                }
            }
        }
    }
    reduced["reduction"] = json!({"strategy":"root_fields/v1", "original_bytes":full.len(),
        "sha256":sha256_hex(&full)});
    if reduced.to_string().len() > max_bytes {
        if let Some(object) = reduced.as_object_mut() {
            object.remove("reduction");
        }
    }
    (reduced.to_string(), true)
}

/// Preserve a durable reference outside the excerpt, within the same byte budget.
pub(crate) fn tool_result_with_archive(
    result: &ToolResult,
    reference: &xharness_session::ToolArchiveRef,
    max_bytes: usize,
) -> Result<String, String> {
    let archive = json!({"sha256":reference.sha256,"bytes":reference.bytes,
        "read_with":"history", "format":"tool_result/v1"});
    let overhead = archive.to_string().len() + 32;
    let budget = max_bytes
        .checked_sub(overhead)
        .filter(|n| *n >= MIN_TOOL_RESULT_LIMIT_BYTES)
        .ok_or("tool result budget cannot hold its durable archive reference")?;
    let (text, _) = tool_result_for_model(result, budget);
    let mut envelope: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    envelope["archive"] = archive;
    let text = envelope.to_string();
    if text.len() > max_bytes {
        return Err("archived tool result exceeded its byte budget".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn structured(value: serde_json::Value, ok: bool) -> ToolResult {
        ToolResult {
            ok,
            content: value.to_string(),
            error: if ok {
                String::new()
            } else {
                "receipt failed".into()
            },
            truncated: false,
            metadata: Some(json!({"model_output_format":"json_object/v1"})),
        }
    }

    #[test]
    fn explicit_json_projection_is_flat_without_recursive_parsing_or_foreign_unwrap() {
        for ok in [false, true] {
            let receipt = json!({"ok":ok,"effect":"unknown","value":{"string":"{\"content\":[]}","x":[1]},"error":{"message":"fixture"}});
            let result = structured(receipt.clone(), ok);
            let (text, truncated) = tool_result_for_model(&result, 4096);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["value"], receipt["value"]);
            assert_eq!(value["ok"], ok);
            assert_eq!(value["error"], receipt["error"]);
            assert!(!truncated && value.get("content").is_none());
            let mut foreign = result.clone();
            foreign.metadata = None;
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&tool_result_for_model(&foreign, 4096).0)
                    .unwrap()["content"],
                result.content
            );
        }
    }

    #[test]
    fn structured_projection_cannot_hide_pipeline_failure_or_malformed_output() {
        let result = structured(json!({"ok":true,"effect":"applied"}), false);
        let value: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&result, 4096).0).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"], "receipt failed");
        let result = structured(json!([1, 2]), true);
        let value: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&result, 4096).0).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"], "invalid structured tool result");
    }

    #[test]
    fn bounded_flat_projection_preserves_safety_and_archive_without_nested_json_excerpt() {
        let result = structured(
            json!({"ok":false,"effect":"unknown","status":"timeout","error":{"name":"Error","message":"failure"},"value":"汉字".repeat(1000)}),
            false,
        );
        for limit in MIN_TOOL_RESULT_LIMIT_BYTES..2048 {
            let (text, truncated) = tool_result_for_model(&result, limit);
            assert!(truncated && text.len() <= limit);
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["effect"], "unknown");
            assert_eq!(value["ok"], false);
            assert!(value.get("content").is_none() && value.get("value").is_none());
        }
        let reference =
            xharness_session::ToolArchiveRef::for_text(&serde_json::to_string(&result).unwrap())
                .unwrap();
        let text = tool_result_with_archive(&result, &reference, 512).unwrap();
        assert!(text.len() <= 512);
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["archive"]["sha256"], reference.sha256);
        assert_eq!(value["effect"], "unknown");
        assert_eq!(value["error"]["message"], "failure");
        assert_eq!(
            tool_result_with_archive(&result, &reference, 512).unwrap(),
            text
        );
    }
}
