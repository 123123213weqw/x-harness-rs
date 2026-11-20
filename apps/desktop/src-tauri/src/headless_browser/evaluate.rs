//! Same page-world execution contract as the embedded WebView.
#![forbid(unsafe_code)]
use super::Instance;
use crate::browser_inspect::execution;
use serde_json::{json, Value};
use std::time::Duration;

impl Instance {
    pub(super) async fn evaluate(&mut self, arguments: Value) -> Result<Value, String> {
        let request = match execution::Request::parse(arguments) {
            Ok(request) => request,
            Err(error) => return Ok(super::rejected(&error)),
        };
        let id = super::nonce()?;
        self.frame = None;
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms + 1500);
        let result = async {
            let raw = self.process.cdp.evaluate(request.script(&id)).await?;
            let start = execution::decode(&raw.to_string(), &id)?;
            if start["state"] != "started" {
                return Err("invalid JavaScript start callback".to_owned());
            }
            loop {
                let raw = self
                    .process
                    .cdp
                    .evaluate(execution::poll_script(&id))
                    .await?;
                let result = execution::decode(&raw.to_string(), &id)?;
                match result["state"].as_str() {
                    Some("finished") => return Ok(result),
                    Some("pending") => tokio::time::sleep(Duration::from_millis(25)).await,
                    _ => {
                        return Err("JavaScript execution state unavailable after navigation".into())
                    }
                }
            }
        };
        let mut receipt = match tokio::time::timeout_at(deadline, result).await {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => execution::unknown(&error),
            Err(_) => execution::unknown("JavaScript wait timed out; code may still be running"),
        };
        receipt["source"] = json!({"engine":"chromium-headless","untrusted":true,"tab_id":self.id});
        Ok(receipt)
    }
}
