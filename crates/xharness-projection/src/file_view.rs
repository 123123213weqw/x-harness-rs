//! File mutation render intent, shared by durable and compatibility projections.
//! No filesystem access, content copies, path resolution, or mutation authority.
#![forbid(unsafe_code)]

use serde::Deserialize;
use serde_json::{json, Value};

const MAX_LOCATION_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
struct FileArguments {
    path: String,
}

fn location(name: &str, arguments: &str) -> Option<(String, &'static str)> {
    let label = match name {
        "write" => "Write",
        "edit" => "Edit",
        _ => return None,
    };
    // Deserialize only the path: a large write body is skipped, not copied into
    // another JSON value or a fabricated whole-file diff.
    let FileArguments { path } = serde_json::from_str(arguments).ok()?;
    if path.is_empty() || path.contains('\0') || path.len() > MAX_LOCATION_BYTES {
        return None;
    }
    Some((path, label))
}

pub(super) fn call(name: &str, arguments: &str) -> Option<Value> {
    let (path, label) = location(name, arguments)?;
    Some(json!({"for":"call", "view":{
        "card":"generic", "kind":"edit", "title":format!("{label} {path}"),
        "locations":[{"path":path}]
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_locations_preserve_exact_native_paths_without_copying_contents() {
        for name in ["write", "edit"] {
            for path in [
                "docs/报告.md",
                " leading space.txt ",
                r"C:\work\报告.docx",
                r"\\server\share\a.txt",
            ] {
                let arguments = json!({"path":path,"content":"private body".repeat(100_000),"old":"old","new":"new"}).to_string();
                let view = call(name, &arguments).unwrap();
                assert_eq!(view["view"]["locations"][0]["path"], path);
                assert_eq!(view["view"]["kind"], "edit");
                assert!(view.to_string().len() < 512);
            }
        }
    }

    #[test]
    fn compatibility_projector_uses_the_same_native_file_intent() {
        for name in ["write", "edit"] {
            let arguments = json!({"path":"docs/报告.md","content":"private"}).to_string();
            let event = json!({"type":"tool/call", "seq":1, "data":{
                "name":name, "arguments":arguments, "callId":"native-file"
            }});
            assert_eq!(
                crate::project_web_event_view(&event, &[]),
                call(name, &arguments)
            );
        }
        let read = json!({"type":"tool/call", "data":{
            "name":"read", "arguments":r#"{"path":"docs/报告.md"}"#
        }});
        assert!(crate::project_web_event_view(&read, &[]).is_none());
    }

    #[test]
    fn unsupported_or_invalid_calls_do_not_claim_produced_files() {
        for name in ["read", "bash", "pwsh", "plugin_mcp", "custom_write"] {
            assert!(call(name, r#"{"path":"a.txt"}"#).is_none());
        }
        for arguments in [
            "not json",
            "[]",
            "{}",
            r#"{"path":null}"#,
            r#"{"path":1}"#,
            r#"{"path":""}"#,
            r#"{"path":"a\u0000b"}"#,
            r#"{"path":"a","path":"b"}"#,
        ] {
            assert!(call("write", arguments).is_none(), "{arguments}");
        }
        assert!(call(
            "write",
            &json!({"path":"x".repeat(MAX_LOCATION_BYTES+1)}).to_string()
        )
        .is_none());
    }
}
