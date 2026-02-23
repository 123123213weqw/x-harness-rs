//! Bounded, in-memory calibration of complete wire requests. Never stores prompts.
use crate::{ProviderInputTokenCount, TokenCountAccuracy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WireFeatures {
    /// UTF-8 content bytes: ordinary text, tool/structured material, non-ASCII.
    pub buckets: [u64; 3],
    pub framing: u64,
    pub image_tokens: u64,
}
impl WireFeatures {
    pub fn from_body(body: &Value, image_tokens: u64) -> Self {
        fn walk(v: &Value, structured: bool, f: &mut WireFeatures) {
            match v {
                Value::String(s) if s.starts_with("data:image/") => {}
                Value::String(s) => {
                    for c in s.chars() {
                        let bucket = if !c.is_ascii() {
                            2
                        } else if structured {
                            1
                        } else {
                            0
                        };
                        f.buckets[bucket] = f.buckets[bucket].saturating_add(c.len_utf8() as u64);
                    }
                }
                Value::Array(a) => {
                    for x in a {
                        f.framing += 8;
                        walk(x, structured, f);
                    }
                }
                Value::Object(m) => {
                    for (k, x) in m {
                        if [
                            "max_tokens",
                            "max_output_tokens",
                            "stream",
                            "stream_options",
                            "store",
                        ]
                        .contains(&k.as_str())
                        {
                            continue;
                        }
                        f.framing = f.framing.saturating_add(k.len() as u64 + 4);
                        let tool = structured
                            || matches!(
                                k.as_str(),
                                "tools" | "tool_calls" | "arguments" | "parameters"
                            )
                            || m.get("role").and_then(Value::as_str) == Some("tool")
                            || m.get("type").and_then(Value::as_str)
                                == Some("function_call_output");
                        walk(x, tool, f);
                    }
                }
                _ => f.framing += 8,
            }
        }
        let mut f = Self {
            image_tokens,
            ..Self::default()
        };
        walk(body, false, &mut f);
        f
    }
    pub fn units(&self) -> u64 {
        self.buckets
            .iter()
            .copied()
            .fold(self.framing, u64::saturating_add)
            .max(1)
    }
    fn similar(&self, other: &Self) -> bool {
        let a = self.units() as f64;
        let b = other.units() as f64;
        self.image_tokens == 0
            && other.image_tokens == 0
            && a / b <= 2.0
            && b / a <= 2.0
            && self
                .buckets
                .iter()
                .zip(other.buckets)
                .map(|(x, y)| (*x as f64 / a - y as f64 / b).abs())
                .sum::<f64>()
                < 0.30
    }
}
#[derive(Clone, Debug)]
struct Sample {
    request_id: String,
    features: WireFeatures,
    actual: u64,
}
#[derive(Debug, Default)]
pub struct Calibration {
    scopes: BTreeMap<String, VecDeque<Sample>>,
}
impl Calibration {
    pub fn estimate(&self, scope: &str, features: &WireFeatures) -> ProviderInputTokenCount {
        let rows: Vec<_> = self
            .scopes
            .get(scope)
            .into_iter()
            .flatten()
            .filter(|s| features.similar(&s.features))
            .collect();
        // Unknown distributions and multimodal requests stay conservative. Never
        // fit image pricing to a text-only observation or learn across endpoints.
        let (count, accuracy) = if rows.len() >= 8 {
            let ratio = rows
                .iter()
                .map(|s| s.actual as f64 / s.features.units() as f64)
                .fold(0.0_f64, f64::max);
            (
                ((features.units() as f64 * ratio * 1.25).ceil() as u64).saturating_add(256),
                TokenCountAccuracy::Calibrated,
            )
        } else {
            (
                features.units().saturating_add(features.image_tokens),
                TokenCountAccuracy::Estimated,
            )
        };
        ProviderInputTokenCount {
            counter: format!("wire-calibration/v1:{scope}"),
            input_tokens: count,
            accuracy,
        }
    }
    pub fn observe(&mut self, scope: &str, request_id: &str, features: WireFeatures, actual: u64) {
        if actual == 0 || features.image_tokens != 0 {
            return;
        }
        if self.scopes.len() >= 64 && !self.scopes.contains_key(scope) {
            self.scopes.clear();
        }
        let prior = self.estimate(scope, &features);
        let rows = self.scopes.entry(scope.to_owned()).or_default();
        if rows.iter().any(|s| s.request_id == request_id) {
            return;
        }
        // A violated upper estimate invalidates the learned distribution immediately.
        if prior.accuracy == TokenCountAccuracy::Calibrated && actual > prior.input_tokens {
            rows.clear();
        }
        rows.push_back(Sample {
            request_id: request_id.into(),
            features,
            actual,
        });
        while rows.len() > 32 {
            rows.pop_front();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn f(n: u64) -> WireFeatures {
        WireFeatures {
            buckets: [0, n, 0],
            ..Default::default()
        }
    }
    #[test]
    fn warmup_scope_dedup_drift_and_images() {
        let mut c = Calibration::default();
        for i in 0..8 {
            c.observe("a", &i.to_string(), f(400000), 110000);
        }
        assert_eq!(
            c.estimate("a", &f(400000)).accuracy,
            TokenCountAccuracy::Calibrated
        );
        assert!(c.estimate("a", &f(400000)).input_tokens >= 110000);
        assert_eq!(
            c.estimate("b", &f(400000)).accuracy,
            TokenCountAccuracy::Estimated
        );
        c.observe("a", "7", f(400000), 900000); // duplicate cannot poison calibration
        assert_eq!(
            c.estimate("a", &f(400000)).accuracy,
            TokenCountAccuracy::Calibrated
        );
        c.observe("a", "9", f(400000), 900000);
        assert_eq!(
            c.estimate("a", &f(400000)).accuracy,
            TokenCountAccuracy::Estimated
        );
        assert_eq!(
            c.estimate(
                "a",
                &WireFeatures {
                    image_tokens: 4096,
                    ..f(400000)
                }
            )
            .accuracy,
            TokenCountAccuracy::Estimated
        );
    }
    #[test]
    fn distribution_change_and_large_extrapolation_cold_start() {
        let mut c = Calibration::default();
        for i in 0..8 {
            c.observe("s", &i.to_string(), f(1000), 300);
        }
        assert_eq!(
            c.estimate("s", &f(10000)).accuracy,
            TokenCountAccuracy::Estimated
        );
        assert_eq!(
            c.estimate(
                "s",
                &WireFeatures {
                    buckets: [0, 0, 1000],
                    ..Default::default()
                }
            )
            .accuracy,
            TokenCountAccuracy::Estimated
        );
    }
    #[test]
    fn wire_features_do_not_count_base64_or_output_reserve() {
        let a = serde_json::json!({"messages":[{"role":"user","content":"abc"}],"max_tokens":10});
        let mut b = a.clone();
        b["max_tokens"] = 999999.into();
        assert_eq!(
            WireFeatures::from_body(&a, 0).units(),
            WireFeatures::from_body(&b, 0).units()
        );
    }
}
