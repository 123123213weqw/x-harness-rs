//! Model-facing contracts and repair evidence. Never execute a suggested repair.
#![forbid(unsafe_code)]

use serde_json::{json, Map, Value};
use xharness_tools::{validate_arguments, ToolHandlerError};

use crate::native_browser::{self, HEADLESS_SERVER, PLUGIN, SERVER};

pub(super) fn envelope_schema() -> Value {
    // Keep this a literal: the offline routing fixture reads the same contract
    // without executing Rust or maintaining a second schema copy.
    json!({"additionalProperties":false,"oneOf":[{"additionalProperties":false,"properties":{"action":{"const":"list"}},"required":["action"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"const":"list"},"plugin":{}},"required":["action","plugin"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"const":"list"},"plugin":{},"server":{}},"required":["action","plugin","server"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"const":"describe"},"plugin":{},"server":{},"tool":{}},"required":["action","plugin","server","tool"],"type":"object"},{"additionalProperties":false,"properties":{"action":{"const":"call"},"arguments":{},"plugin":{},"server":{},"tool":{}},"required":["action","plugin","server","tool"],"type":"object"}],"properties":{"action":{"enum":["list","describe","call"],"type":"string"},"arguments":{"type":"object"},"plugin":{"minLength":1,"type":"string"},"server":{"minLength":1,"type":"string"},"tool":{"minLength":1,"type":"string"}},"required":["action"],"type":"object"})
}

pub(super) fn failure(code: &str, message: &str, next_call: Value) -> ToolHandlerError {
    ToolHandlerError::new(
        json!({"code":code,"message":message,"effect":"not_started",
        "next_call":next_call,"repair_is_suggestion_only":true})
        .to_string(),
    )
}

fn scoped_list(args: &Value) -> Value {
    if args["plugin"] == PLUGIN && matches!(args["server"].as_str(), Some(SERVER | HEADLESS_SERVER))
    {
        json!({"action":"list","plugin":PLUGIN,"server":args["server"]})
    } else {
        json!({"action":"list"})
    }
}

pub(super) fn validate_envelope(args: &Value) -> Result<(), ToolHandlerError> {
    validate_arguments(&envelope_schema(), args).map_err(|_| failure(
        "invalid_mcp_envelope", "Expected action=list, describe or call and only declared fields; arguments must be an object.", scoped_list(args)))?;
    let action = args["action"].as_str().unwrap_or_default();
    let required: &[&str] = if action == "list" {
        &[]
    } else {
        &["plugin", "server", "tool"]
    };
    for field in required {
        if !args[*field].as_str().is_some_and(|s| !s.trim().is_empty()) {
            return Err(failure("missing_mcp_target", &format!("{action} requires a non-empty {field}; list the server's tools before describing one."), scoped_list(args)));
        }
    }
    if action == "list" && (args.get("tool").is_some() || args.get("arguments").is_some())
        || action == "describe" && args.get("arguments").is_some()
        || args.get("server").is_some() && args.get("plugin").is_none()
        || ["plugin", "server", "tool"].iter().any(|k| {
            args.get(*k)
                .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
        })
    {
        return Err(failure("invalid_mcp_target", "list accepts plugin/server selectors, describe also requires tool, and only call accepts arguments.", scoped_list(args)));
    }
    Ok(())
}

pub(super) fn definitions(headless: bool) -> Vec<Value> {
    if headless {
        native_browser::headless_tools()
    } else {
        native_browser::tools()
    }
}

pub(super) fn native_failure(
    headless: bool,
    tool: &str,
    code: &str,
    message: &str,
) -> ToolHandlerError {
    let tools = definitions(headless);
    let known = tools.iter().find(|d| d["name"] == tool);
    let server = if headless { HEADLESS_SERVER } else { SERVER };
    let next = if known.is_some() {
        json!({"action":"describe","plugin":PLUGIN,"server":server,"tool":tool})
    } else {
        json!({"action":"list","plugin":PLUGIN,"server":server})
    };
    ToolHandlerError::new(json!({"code":code,"message":message,"effect":"not_started",
        "valid_tools":tools.iter().map(|d| &d["name"]).collect::<Vec<_>>(),
        "next_call":next,"inputSchema":known.map(|d| &d["inputSchema"]),
        "open_example":{"action":"call","plugin":PLUGIN,"server":server,"tool":"control","arguments":{"action":"open","url":"https://example.com"}},
        "repair_is_suggestion_only":true}).to_string())
}

/// Normalize const/untyped leaves for the executor's deliberately small schema
/// subset. Keep the original constraints for providers; runtime selects an
/// action branch explicitly rather than pretending the executor handles oneOf.
pub(super) fn portable(schema: &Value) -> Value {
    let mut s = schema.clone();
    if let Some(c) = s.get("const").cloned() {
        s["enum"] = json!([c]);
        s["type"] = json!(if c.is_string() { "string" } else { "number" });
    }
    if s.get("type").is_none() {
        s["type"] = json!(["object", "array", "string", "number", "integer", "boolean", "null"]);
    }
    if let Some(props) = s.get_mut("properties").and_then(Value::as_object_mut) {
        for child in props.values_mut() {
            *child = portable(child);
        }
    }
    if let Some(items) = s.get_mut("items") {
        *items = portable(items);
    }
    s
}

fn bounded(schema: &Value, value: &Value) -> bool {
    if let Some(s) = value.as_str() {
        if schema["maxLength"]
            .as_u64()
            .is_some_and(|n| s.chars().count() as u64 > n)
        {
            return false;
        }
        if let Some(pattern) = schema["pattern"].as_str() {
            let valid = match pattern {
                "^[0-9a-fA-F]{32}$" => s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()),
                "^[0-9a-f]{32}$" => s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "^(?:[a-z]|Enter|Tab|Escape|Backspace|Delete|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$" => s.len() == 1 && s.as_bytes()[0].is_ascii_lowercase() || ["Enter","Tab","Escape","Backspace","Delete","Space","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].contains(&s),
                _ => false, // New native patterns require an explicit validator.
            };
            if !valid {
                return false;
            }
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["minimum"].as_f64().is_some_and(|min| n < min)
            || schema["maximum"].as_f64().is_some_and(|max| n > max)
        {
            return false;
        }
    }
    if let Some(a) = value.as_array() {
        if schema["maxItems"]
            .as_u64()
            .is_some_and(|n| a.len() as u64 > n)
        {
            return false;
        }
        if schema["uniqueItems"] == true && a.iter().enumerate().any(|(i, v)| a[..i].contains(v)) {
            return false;
        }
        if let Some(items) = schema.get("items") {
            if !a.iter().all(|v| bounded(items, v)) {
                return false;
            }
        }
    }
    if let Some(o) = value.as_object() {
        for (key, v) in o {
            if let Some(child) = schema["properties"].get(key) {
                if !bounded(child, v) {
                    return false;
                }
            }
        }
    }
    true
}

pub(super) fn validate_native(
    headless: bool,
    tool: &str,
    args: &Value,
) -> Result<(), ToolHandlerError> {
    let definitions = definitions(headless);
    let definition = definitions
        .iter()
        .find(|d| d["name"] == tool)
        .ok_or_else(|| {
            native_failure(
                headless,
                tool,
                "unknown_browser_tool",
                "Use a listed tool name; open/status/close are actions of control, not tool names.",
            )
        })?;
    let full = &definition["inputSchema"];
    let schema = if let Some(branches) = full["oneOf"].as_array() {
        branches.iter().find(|s| {
            s["properties"]["action"]["const"] == args["action"] && args["action"].is_string()
        })
    } else {
        Some(full)
    };
    if schema.is_none_or(|s| validate_arguments(&portable(s), args).is_err() || !bounded(s, args)) {
        return Err(native_failure(headless,tool,"invalid_browser_arguments","Arguments do not match this tool's schema. Start observe with scope=page (or {}). main requires a <main> element; dialog requires a dialog. No browser action was sent."));
    }
    Ok(())
}

pub(super) fn direct_schema(schema: &Value, webview_only: bool) -> Value {
    if let Some(branches) = schema["oneOf"].as_array() {
        let branches = branches
            .iter()
            .map(|b| direct_schema(b, webview_only))
            .collect::<Vec<_>>();
        let mut props = Map::new();
        let mut actions = Vec::new();
        for b in &branches {
            if let Some(p) = b["properties"].as_object() {
                props.extend(p.clone());
            }
            actions.push(b["properties"]["action"]["const"].clone());
        }
        props.insert("action".into(), json!({"type":"string","enum":actions}));
        let required = branches[0]["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|k| {
                branches
                    .iter()
                    .all(|b| b["required"].as_array().is_some_and(|a| a.contains(k)))
            })
            .cloned()
            .collect::<Vec<_>>();
        // Types/bounds are already on the root properties. Branches only need
        // their allowed keys, required keys and action discriminator; repeating
        // full backend/field schemas per action wastes every model request.
        let choices = branches.iter().map(|branch| {
            let allowed = branch["properties"].as_object().into_iter().flatten().map(|(key,_)| {
                let constraint = if key == "action" { json!({"const":branch["properties"]["action"]["const"]}) } else { json!({}) };
                (key.clone(),constraint)
            }).collect::<Map<String,Value>>();
            json!({"type":"object","properties":allowed,"required":branch["required"],"additionalProperties":false})
        }).collect::<Vec<_>>();
        return json!({"type":"object","additionalProperties":false,"properties":props,"required":required,"oneOf":choices});
    }
    let mut s = portable(schema);
    s["properties"]["backend"] = json!({"type":"string","enum":if webview_only {vec![SERVER]} else {vec![HEADLESS_SERVER,SERVER]},"description":"browser: background (preferred). webview: explicit visible page/login. Frames and login are separate; never silently switch."});
    let mut required = s["required"].as_array().cloned().unwrap_or_default();
    required.push(json!("backend"));
    s["required"] = json!(required);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_projection_keeps_branch_required_fields_and_extra_field_denials() {
        for tool in definitions(false) {
            let projected = direct_schema(
                &tool["inputSchema"],
                matches!(tool["name"].as_str(), Some("request" | "read_response")),
            );
            xharness_tools::validate_tool_schema(&projected).unwrap();
            assert_eq!(projected["additionalProperties"], false);
            if let Some(branches) = tool["inputSchema"]["oneOf"].as_array() {
                for (original, choice) in
                    branches.iter().zip(projected["oneOf"].as_array().unwrap())
                {
                    assert_eq!(choice["additionalProperties"], false);
                    assert_eq!(
                        choice["properties"]["action"]["const"],
                        original["properties"]["action"]["const"]
                    );
                    for field in original["required"].as_array().unwrap() {
                        assert!(choice["required"].as_array().unwrap().contains(field));
                    }
                    let mut fields = original["properties"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>();
                    fields.push("backend".into());
                    fields.sort();
                    assert_eq!(
                        choice["properties"]
                            .as_object()
                            .unwrap()
                            .keys()
                            .cloned()
                            .collect::<Vec<_>>(),
                        fields
                    );
                    assert_eq!(
                        choice["properties"]["backend"],
                        json!({}),
                        "do not repeat the full field schemas per action"
                    );
                }
            }
        }
    }

    #[test]
    fn validates_all_native_action_constraints_without_mutating_the_request() {
        use crate::plugin_mcp::contract::{validate_envelope, validate_native};
        for args in [
            json!({"action":"list","server":"browser"}),
            json!({"action":"describe","plugin":PLUGIN,"server":SERVER}),
            json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"control","arguments":null}),
        ] {
            assert!(validate_envelope(&args).is_err());
        }
        let frame = "1".repeat(32);
        let valid = [
            ("control", json!({"action":"status"})),
            (
                "control",
                json!({"action":"open","url":"https://example.com"}),
            ),
            ("observe", json!({})),
            ("screenshot", json!({})),
            (
                "perform",
                json!({"action":"fill","frame_id":frame,"ref":"n0","text":"fixture"}),
            ),
            (
                "input",
                json!({"action":"key","frame_id":frame,"key":"Enter","modifiers":["Meta"]}),
            ),
        ];
        for (tool, args) in valid {
            assert!(validate_native(true, tool, &args).is_ok(), "{tool}: {args}");
        }
        for (tool, args) in [
            ("control", json!({"action":"open","url":"x".repeat(4097)})),
            ("screenshot", json!({"path":"private"})),
            (
                "input",
                json!({"action":"key","frame_id":frame,"key":"not-a-key"}),
            ),
            (
                "input",
                json!({"action":"key","frame_id":frame,"key":"Enter","modifiers":["Meta","Meta"]}),
            ),
            (
                "perform",
                json!({"action":"click","frame_id":"bad","ref":"n0"}),
            ),
            ("request", json!({"url":"https://example.com"})),
        ] {
            let before = args.clone();
            assert!(
                validate_native(true, tool, &args).is_err(),
                "{tool}: {args}"
            );
            assert_eq!(args, before);
        }
    }
}
