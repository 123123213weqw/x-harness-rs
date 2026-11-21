//! Page-world script protocol, shared by native browser backends.
use crate::decode_callback;
use serde::Deserialize;
use serde_json::{json, Value};

const RUNTIME: &str = include_str!("browser_evaluate.js");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    code: String,
    #[serde(default)]
    args: Value,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}
fn default_timeout() -> u64 {
    5000
}

impl Request {
    pub fn parse(value: Value) -> Result<Self, String> {
        let request: Self =
            serde_json::from_value(value).map_err(|_| "invalid JavaScript arguments")?;
        if request.code.trim().is_empty()
            || request.code.len() > 12000
            || !(1..=10000).contains(&request.timeout_ms)
        {
            return Err(
                "JavaScript requires 1..12000 UTF-8 bytes of code and timeout_ms=1..10000".into(),
            );
        }
        Ok(request)
    }
    pub fn script(&self, id: &str) -> String {
        let options = json!({"id":id,"timeout_ms":self.timeout_ms,"args":self.args});
        format!(
            "({RUNTIME})({options},async function(args){{\n{}\n}})",
            self.code
        )
    }
}

pub fn poll_script(id: &str) -> String {
    let id = json!(id);
    format!("(()=>{{const s=globalThis[Symbol.for('xharness.browser.executions')];const e=s?.[{id}];if(!e)return JSON.stringify({{id:{id},state:'missing'}});if(!e.done)return JSON.stringify({{id:{id},state:'pending'}});delete s[{id}];return e.result;}})()")
}

pub fn decode(raw: &str, id: &str) -> Result<Value, String> {
    let result = decode_callback(raw)?;
    if result["id"].as_str() != Some(id) {
        return Err("JavaScript callback belongs to another execution".into());
    }
    Ok(result)
}

pub fn unknown(message: &str) -> Value {
    json!({"ok":false,"effect":"unknown","status":"interrupted","message":message,"retry":"Do not replay automatically; inspect actual page state. Pending script effects are not rolled back."})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scripts_are_not_filtered_but_targets_and_limits_are_fixed() {
        for code in [
            "return document.cookie",
            "return await fetch('/api',{method:'POST'})",
            "window.changed=true; console.log('ok'); return 42",
        ] {
            let request = Request::parse(json!({"code":code})).unwrap();
            assert!(request.script("nonce").contains(code));
        }
        for args in [
            json!({"code":""}),
            json!({"code":"return 1","owner":"other"}),
            json!({"code":"return 1","tab_id":"main"}),
            json!({"code":"return 1","timeout_ms":10001}),
            json!({"code":"x".repeat(12001)}),
        ] {
            assert!(Request::parse(args).is_err());
        }
    }
    #[test]
    fn callbacks_are_correlated_and_uncertain_effects_are_explicit() {
        let raw =
            serde_json::to_string(&json!({"id":"a","state":"finished","ok":true}).to_string())
                .unwrap();
        assert!(decode(&raw, "a").is_ok());
        assert!(decode(&raw, "b").is_err());
        assert_eq!(unknown("lost")["effect"], "unknown");
        assert_eq!(unknown("lost")["ok"], false);
    }
}
