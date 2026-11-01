//! Portable cache charges, not allocator-specific object sizes or RSS.
#![forbid(unsafe_code)]

use serde_json::Value;

/// Charge owned string/array capacity, map-node allowance and spare outer
/// event/weight slots. Maps deliberately use a conservative allowance instead
/// of depending on private standard-library BTreeMap layout. The byte budget
/// is still an estimate: allocator fragmentation and other owners are separate.
pub fn estimated_event_resident_bytes(value: &Value) -> usize {
    let value_slot = std::mem::size_of::<Value>();
    let word = std::mem::size_of::<usize>();
    let mut bytes = value_slot.saturating_mul(2).saturating_add(4 * word);
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::String(text) => {
                bytes = bytes
                    .saturating_add(text.capacity())
                    .saturating_add(2 * word);
            }
            Value::Array(values) => {
                if values.capacity() != 0 {
                    bytes = bytes
                        .saturating_add(values.capacity().saturating_mul(value_slot))
                        .saturating_add(2 * word);
                }
                pending.extend(values);
            }
            Value::Object(values) => {
                if !values.is_empty() {
                    bytes = bytes.saturating_add(64 * word).saturating_add(
                        values.len().saturating_mul(
                            std::mem::size_of::<(String, Value)>().saturating_mul(4),
                        ),
                    );
                }
                for (key, value) in values {
                    bytes = bytes
                        .saturating_add(key.capacity())
                        .saturating_add(2 * word);
                    pending.push(value);
                }
            }
            _ => {}
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn charge_tracks_owned_capacity_and_container_overhead_not_only_json_length() {
        let small = json!({"a":1,"b":{"c":"d"}});
        assert!(
            estimated_event_resident_bytes(&small) > serde_json::to_vec(&small).unwrap().len() * 4
        );
        let mut text = String::with_capacity(1024 * 1024);
        text.push('x');
        assert!(estimated_event_resident_bytes(&Value::String(text)) >= 1024 * 1024);
        let array = Value::Array(Vec::with_capacity(100));
        assert!(estimated_event_resident_bytes(&array) >= 100 * std::mem::size_of::<Value>());
    }
}
