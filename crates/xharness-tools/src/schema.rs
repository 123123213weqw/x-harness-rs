use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_SCHEMA_DEPTH: usize = 64;

/// Stable validation diagnostic suitable for model-facing error rendering.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq, Serialize, Deserialize)]
#[error("{path}: {message}")]
pub struct SchemaViolation {
    pub path: String,
    pub message: String,
}

impl SchemaViolation {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Validate the intentionally small, portable JSON Schema subset understood
/// by the executor. Unknown annotation/validation keywords are retained and
/// ignored; malformed known keywords are rejected at registration.
pub fn validate_tool_schema(schema: &Value) -> Result<(), SchemaViolation> {
    let object = schema
        .as_object()
        .ok_or_else(|| SchemaViolation::new("$", "tool schema must be an object"))?;
    let root_types = schema_types(object, "$")?;
    if !root_types.contains(&"object") {
        return Err(SchemaViolation::new(
            "$.type",
            "tool schema root type must include object",
        ));
    }
    validate_schema_node(object, "$", 0)
}

/// Validate one parsed argument value against the supported schema subset.
pub fn validate_arguments(schema: &Value, arguments: &Value) -> Result<(), SchemaViolation> {
    if !arguments.is_object() {
        return Err(SchemaViolation::new(
            "$",
            "tool arguments must be a JSON object",
        ));
    }
    let schema = schema
        .as_object()
        .ok_or_else(|| SchemaViolation::new("$schema", "tool schema must be an object"))?;
    validate_instance(schema, arguments, "$", 0)
}

fn validate_schema_node(
    schema: &Map<String, Value>,
    path: &str,
    depth: usize,
) -> Result<(), SchemaViolation> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(SchemaViolation::new(
            path,
            format!("schema exceeds maximum depth {MAX_SCHEMA_DEPTH}"),
        ));
    }

    let _ = schema_types(schema, path)?;

    if let Some(enum_values) = schema.get("enum") {
        let values = enum_values
            .as_array()
            .ok_or_else(|| SchemaViolation::new(format!("{path}.enum"), "enum must be an array"))?;
        if values.is_empty() {
            return Err(SchemaViolation::new(
                format!("{path}.enum"),
                "enum must not be empty",
            ));
        }
    }

    let properties = match schema.get("properties") {
        Some(Value::Object(properties)) => Some(properties),
        Some(_) => {
            return Err(SchemaViolation::new(
                format!("{path}.properties"),
                "properties must be an object",
            ));
        }
        None => None,
    };
    if let Some(properties) = properties {
        for (name, child) in properties {
            let child_path = property_path(path, name);
            let child = child.as_object().ok_or_else(|| {
                SchemaViolation::new(&child_path, "property schema must be an object")
            })?;
            validate_schema_node(child, &child_path, depth + 1)?;
        }
    }

    if let Some(required) = schema.get("required") {
        let required = required.as_array().ok_or_else(|| {
            SchemaViolation::new(format!("{path}.required"), "required must be an array")
        })?;
        let mut seen = HashSet::new();
        for (index, name) in required.iter().enumerate() {
            let name = name.as_str().ok_or_else(|| {
                SchemaViolation::new(
                    format!("{path}.required[{index}]"),
                    "required entries must be strings",
                )
            })?;
            if !seen.insert(name) {
                return Err(SchemaViolation::new(
                    format!("{path}.required[{index}]"),
                    format!("duplicate required property {name:?}"),
                ));
            }
        }
    }

    if let Some(additional) = schema.get("additionalProperties") {
        match additional {
            Value::Bool(_) => {}
            Value::Object(child) => {
                validate_schema_node(child, &format!("{path}.additionalProperties"), depth + 1)?;
            }
            _ => {
                return Err(SchemaViolation::new(
                    format!("{path}.additionalProperties"),
                    "additionalProperties must be a boolean or schema object",
                ));
            }
        }
    }

    if let Some(items) = schema.get("items") {
        let child = items.as_object().ok_or_else(|| {
            SchemaViolation::new(format!("{path}.items"), "items must be a schema object")
        })?;
        validate_schema_node(child, &format!("{path}.items"), depth + 1)?;
    }
    Ok(())
}

fn validate_instance(
    schema: &Map<String, Value>,
    instance: &Value,
    path: &str,
    depth: usize,
) -> Result<(), SchemaViolation> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(SchemaViolation::new(
            path,
            format!("arguments exceed maximum validation depth {MAX_SCHEMA_DEPTH}"),
        ));
    }

    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|candidate| candidate == instance) {
            return Err(SchemaViolation::new(
                path,
                "value is not one of the allowed enum entries",
            ));
        }
    }

    let allowed = schema_types(schema, path)?;
    if !allowed.iter().any(|kind| instance_has_type(instance, kind)) {
        return Err(SchemaViolation::new(
            path,
            format!(
                "expected {}, got {}",
                allowed.join(" or "),
                instance_type(instance)
            ),
        ));
    }

    if let Some(object) = instance.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    return Err(SchemaViolation::new(
                        property_path(path, name),
                        "required property is missing",
                    ));
                }
            }
        }

        for (name, value) in object {
            if let Some(child) = properties.and_then(|known| known.get(name)) {
                if let Some(child) = child.as_object() {
                    validate_instance(child, value, &property_path(path, name), depth + 1)?;
                }
                continue;
            }
            match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    return Err(SchemaViolation::new(
                        property_path(path, name),
                        "additional property is not allowed",
                    ));
                }
                Some(Value::Object(child)) => {
                    validate_instance(child, value, &property_path(path, name), depth + 1)?;
                }
                _ => {}
            }
        }
    }

    if let (Some(array), Some(item_schema)) = (
        instance.as_array(),
        schema.get("items").and_then(Value::as_object),
    ) {
        for (index, value) in array.iter().enumerate() {
            validate_instance(item_schema, value, &format!("{path}[{index}]"), depth + 1)?;
        }
    }
    Ok(())
}

fn schema_types<'a>(
    schema: &'a Map<String, Value>,
    path: &str,
) -> Result<Vec<&'a str>, SchemaViolation> {
    let value = schema
        .get("type")
        .ok_or_else(|| SchemaViolation::new(format!("{path}.type"), "type is required"))?;
    let values: Vec<&str> = match value {
        Value::String(kind) => vec![kind],
        Value::Array(kinds) if !kinds.is_empty() => kinds
            .iter()
            .enumerate()
            .map(|(index, kind)| {
                kind.as_str().ok_or_else(|| {
                    SchemaViolation::new(
                        format!("{path}.type[{index}]"),
                        "type entries must be strings",
                    )
                })
            })
            .collect::<Result<_, _>>()?,
        Value::Array(_) => {
            return Err(SchemaViolation::new(
                format!("{path}.type"),
                "type array must not be empty",
            ));
        }
        _ => {
            return Err(SchemaViolation::new(
                format!("{path}.type"),
                "type must be a string or non-empty string array",
            ));
        }
    };

    let mut seen = HashSet::new();
    for (index, kind) in values.iter().enumerate() {
        if !matches!(
            *kind,
            "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
        ) {
            return Err(SchemaViolation::new(
                format!("{path}.type[{index}]"),
                format!("unsupported JSON Schema type {kind:?}"),
            ));
        }
        if !seen.insert(*kind) {
            return Err(SchemaViolation::new(
                format!("{path}.type[{index}]"),
                format!("duplicate JSON Schema type {kind:?}"),
            ));
        }
    }
    Ok(values)
}

fn instance_has_type(value: &Value, expected: &str) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn instance_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.as_i64().is_some() || number.as_u64().is_some() => {
            "integer"
        }
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn property_path(base: &str, property: &str) -> String {
    if property
        .chars()
        .all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        format!("{base}.{property}")
    } else {
        format!("{base}[{property:?}]")
    }
}
