//! Compatibility guard for executable arguments copied from context policy v2.
//! These markers describe missing data; they must never be stripped and executed.

use serde_json::Value;

use crate::{ToolFailure, ToolFailureKind};

pub(crate) fn reject_legacy_projection(tool: &str, arguments: &Value) -> Option<ToolFailure> {
    let fields: &[&str] = match tool {
        "write" => &["content"],
        "edit" => &["old", "new"],
        _ => return None,
    };
    let object = arguments.as_object()?;
    let copied_marker = object.contains_key("_xharness_history_projection")
        || fields.iter().any(|field| {
            object
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(is_omitted_argument)
        });
    copied_marker.then(|| ToolFailure::new(
        ToolFailureKind::InvalidArguments,
        "Historical tool arguments are not executable: this call contains an XHarness history projection, not the original file contents. No file was changed by this call. Use read to obtain the current file, then generate a fresh write/edit call with real content/old/new. Do not retry by deleting _xharness_history_projection or by writing the omitted-text placeholder.",
    ))
}

fn is_omitted_argument(text: &str) -> bool {
    // Match the complete v2 marker, not arbitrary source code or documentation
    // mentioning it. No regex/dependency or unbounded recursive JSON scan needed.
    let Some(rest) = text
        .trim()
        .strip_prefix("[xharness history projection: successful ")
        .and_then(|rest| rest.strip_suffix("; re-read the file if content is needed]"))
    else {
        return false;
    };
    let Some((field, rest)) = rest.split_once(" omitted; chars=") else {
        return false;
    };
    if !matches!(field, "write.content" | "edit.old" | "edit.new") {
        return false;
    }
    let Some((chars, rest)) = rest.split_once("; utf8_bytes=") else {
        return false;
    };
    let Some((bytes, digest)) = rest.split_once("; sha256=") else {
        return false;
    };
    !chars.is_empty()
        && chars.bytes().all(|byte| byte.is_ascii_digit())
        && !bytes.is_empty()
        && bytes.bytes().all(|byte| byte.is_ascii_digit())
        && digest.len() == 64
        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker(field: &str) -> String {
        format!("[xharness history projection: successful {field} omitted; chars=1600; utf8_bytes=4800; sha256={}; re-read the file if content is needed]", "a".repeat(64))
    }

    #[test]
    fn recognizes_only_the_complete_legacy_marker() {
        for field in ["write.content", "edit.old", "edit.new"] {
            let value = marker(field);
            assert!(is_omitted_argument(&value));
            assert!(is_omitted_argument(&format!(" \n{value}\n")));
            assert!(!is_omitted_argument(&format!("Example: {value}")));
            assert!(!is_omitted_argument(&format!("{value}\nreal file content")));
            assert!(!is_omitted_argument(
                &value.replace("chars=1600", "chars=invalid")
            ));
            assert!(!is_omitted_argument(
                &value.replace(&"a".repeat(64), "not-a-digest")
            ));
        }
        assert!(!is_omitted_argument(&marker("read.content")));
    }

    #[test]
    fn rejects_metadata_even_when_the_placeholder_was_removed() {
        for tool in ["write", "edit"] {
            let error = reject_legacy_projection(
                tool,
                &json!({
                    "_xharness_history_projection": null,
                    "content": "real content", "old": "before", "new": "after"
                }),
            )
            .unwrap();
            assert_eq!(error.kind, ToolFailureKind::InvalidArguments);
            assert!(error.message.contains("Use read"));
            assert!(!error.retryable);
        }
    }

    #[test]
    fn catches_omitted_fields_without_metadata_but_leaves_normal_inputs_alone() {
        assert!(
            reject_legacy_projection("write", &json!({"content": marker("write.content")}))
                .is_some()
        );
        assert!(reject_legacy_projection(
            "edit",
            &json!({"old": marker("edit.old"), "new": "real"})
        )
        .is_some());
        assert!(reject_legacy_projection(
            "edit",
            &json!({"old": "real", "new": marker("edit.new")})
        )
        .is_some());
        assert!(
            reject_legacy_projection("read", &json!({"content": marker("write.content")}))
                .is_none()
        );
        assert!(reject_legacy_projection(
            "write",
            &json!({"content": "_xharness_history_projection is an old field"})
        )
        .is_none());
        assert!(reject_legacy_projection(
            "write",
            &json!({"content": "", "path": marker("write.content")})
        )
        .is_none());
        assert!(reject_legacy_projection("edit", &json!({"old": "real", "new": ""})).is_none());
        assert!(reject_legacy_projection("write", &Value::Null).is_none());
    }
}
