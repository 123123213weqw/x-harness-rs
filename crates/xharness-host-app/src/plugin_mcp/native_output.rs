//! Native-only model projection. Foreign MCP receipts never pass this boundary.
#![forbid(unsafe_code)]

use serde_json::{json, Value};
use xharness_tools::{ToolHandlerError, ToolOutput};

pub(super) fn finish(
    result: Result<ToolOutput, ToolHandlerError>,
) -> Result<ToolOutput, ToolHandlerError> {
    let mut output = match result {
        Ok(output) => output,
        Err(error) => {
            // Our argument validator already supplies a structured repair receipt.
            // Transport errors remain plain text, never a fabricated success.
            let mut receipt = match serde_json::from_str::<Value>(&error.message) {
                Ok(value) if value.is_object() => value,
                _ => json!({"error":error.message,"effect":"unknown"}),
            };
            receipt["ok"] = json!(false);
            let mut output = ToolOutput::text(receipt.to_string());
            output.command_failure = Some(error.message);
            output
        }
    };
    // Preserve attachment metadata; the marker is private Host/Core metadata,
    // not a field accepted from the browser or exposed in the provider schema.
    let metadata = output
        .metadata
        .get_or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| ToolHandlerError::new("invalid native output metadata; effect: unknown"))?;
    metadata.insert("model_output_format".into(), json!("json_object/v1"));
    Ok(output)
}

pub(super) fn receipt(mut value: Value) -> Result<ToolOutput, ToolHandlerError> {
    if !value.is_object() {
        return Err(ToolHandlerError::new(
            "invalid native browser receipt; effect: unknown",
        ));
    }
    let ok = match value.get("ok") {
        None => true,
        Some(Value::Bool(ok)) => *ok,
        Some(_) => {
            return Err(ToolHandlerError::new(
                "invalid native browser status; effect: unknown",
            ))
        }
    };
    value["ok"] = json!(ok);
    let mut output = ToolOutput::text(value.to_string());
    if !ok {
        // Use the existing output+failure path: retain the complete receipt and
        // a genuine executor failure (approvals/UI/checkpoint behavior unchanged).
        output.command_failure = Some(value.to_string());
    }
    Ok(output)
}
