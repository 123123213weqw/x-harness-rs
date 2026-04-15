//! Bounded calibration of complete wire requests; versioned numeric-only snapshots.
use crate::{ProviderInputTokenCount, TokenCountAccuracy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    observed_at_ms: u64,
    request_id: String,
    features: WireFeatures,
    actual: u64,
}
#[derive(Debug, Default)]
pub struct Calibration {
    scopes: BTreeMap<String, VecDeque<Sample>>,
}
pub const CALIBRATION_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_CALIBRATION_BYTES: usize = 2 * 1024 * 1024;
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    scopes: BTreeMap<String, VecDeque<Sample>>,
}
impl Calibration {
    /// Only hashed identities and numeric features are serializable. Reject
    /// arbitrary caller identifiers instead of accidentally persisting text.
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        let scopes = self
            .scopes
            .iter()
            .filter(|(scope, _)| digest(scope))
            .map(|(scope, rows)| {
                (
                    scope.clone(),
                    rows.iter()
                        .filter(|s| digest(&s.request_id))
                        .cloned()
                        .collect(),
                )
            })
            .collect();
        serde_json::to_vec(&Snapshot { version: 1, scopes })
            .map_err(|_| "invalid calibration snapshot".into())
    }
    pub fn restore(bytes: &[u8]) -> Result<Self, String> {
        Self::restore_at(bytes, now_ms())
    }
    fn restore_at(bytes: &[u8], now: u64) -> Result<Self, String> {
        if bytes.len() > MAX_CALIBRATION_BYTES {
            return Err("calibration snapshot too large".into());
        }
        let mut snapshot: Snapshot =
            serde_json::from_slice(bytes).map_err(|_| "invalid calibration snapshot")?;
        if snapshot.version != 1 || snapshot.scopes.len() > 64 {
            return Err("unsupported calibration snapshot".into());
        }
        for (scope, rows) in &mut snapshot.scopes {
            if !digest(scope) || rows.len() > 32 {
                return Err("invalid calibration scope".into());
            }
            let mut ids = std::collections::BTreeSet::new();
            for s in rows.iter() {
                if !digest(&s.request_id)
                    || !ids.insert(&s.request_id)
                    || s.actual == 0
                    || s.actual > 1_000_000_000_000
                    || s.features.image_tokens != 0
                    || s.features.units() > 1_000_000_000_000
                {
                    return Err("invalid calibration sample".into());
                }
            }
            rows.retain(|s| {
                s.observed_at_ms <= now && now - s.observed_at_ms <= CALIBRATION_TTL_MS
            });
        }
        snapshot.scopes.retain(|_, rows| !rows.is_empty());
        Ok(Self {
            scopes: snapshot.scopes,
        })
    }
    pub fn invalidate(&mut self, scope: &str) {
        self.scopes.remove(scope);
    }

    pub fn estimate(&self, scope: &str, features: &WireFeatures) -> ProviderInputTokenCount {
        let rows: Vec<_> = self
            .scopes
            .get(scope)
            .into_iter()
            .flatten()
            .filter(|s| {
                s.observed_at_ms <= now_ms()
                    && now_ms().saturating_sub(s.observed_at_ms) <= CALIBRATION_TTL_MS
                    && features.similar(&s.features)
            })
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
            observed_at_ms: now_ms(),
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

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    fn warm() -> Calibration {
        let mut c = Calibration::default();
        for n in 0..8 {
            c.observe(
                &"a".repeat(64),
                &format!("{n:064x}"),
                WireFeatures {
                    buckets: [1_448_000, 0, 0],
                    ..Default::default()
                },
                439_242,
            );
        }
        c
    }
    #[test]
    fn restart_preserves_warm_estimate_without_text() {
        let c = warm();
        let bytes = c.snapshot().unwrap();
        let restored = Calibration::restore(&bytes).unwrap();
        let f = WireFeatures {
            buckets: [1_448_000, 0, 0],
            ..Default::default()
        };
        let result = restored.estimate(&"a".repeat(64), &f);
        assert_eq!(result.accuracy, TokenCountAccuracy::Calibrated);
        assert_eq!(
            result.input_tokens,
            c.estimate(&"a".repeat(64), &f).input_tokens
        );
        assert!(result.input_tokens < 966_976);
        assert!(
            Calibration::default()
                .estimate(&"a".repeat(64), &f)
                .input_tokens
                > 966_976
        );
        assert_eq!(
            restored.estimate(&"b".repeat(64), &f).accuracy,
            TokenCountAccuracy::Estimated
        );
        let mut unsafe_ids = Calibration::default();
        unsafe_ids.observe("https://host?api_key=secret", "private prompt", f, 12);
        assert_eq!(
            serde_json::from_slice::<Value>(&unsafe_ids.snapshot().unwrap()).unwrap()["scopes"],
            serde_json::json!({})
        );
    }
    #[test]
    fn expired_future_corrupt_unsupported_and_oversized_snapshots_are_not_trusted() {
        let bytes = warm().snapshot().unwrap();
        assert!(
            Calibration::restore_at(&bytes, now_ms() + CALIBRATION_TTL_MS + 1)
                .unwrap()
                .scopes
                .is_empty()
        );
        assert!(Calibration::restore_at(&bytes, 0)
            .unwrap()
            .scopes
            .is_empty());
        assert!(Calibration::restore(b"{broken").is_err());
        assert!(Calibration::restore(&vec![b' '; MAX_CALIBRATION_BYTES + 1]).is_err());
        let mut v: Value = serde_json::from_slice(&bytes).unwrap();
        v["version"] = 9.into();
        assert!(Calibration::restore(&serde_json::to_vec(&v).unwrap()).is_err());
        v["version"] = 1.into();
        v["scopes"]["a".repeat(64)][0]["actual"] = 0.into();
        assert!(Calibration::restore(&serde_json::to_vec(&v).unwrap()).is_err());
    }
    #[test]
    fn persisted_invalidation_and_underestimate_do_not_resurrect_old_samples() {
        let mut c = warm();
        let scope = "a".repeat(64);
        c.observe(
            &scope,
            &"f".repeat(64),
            WireFeatures {
                buckets: [1_448_000, 0, 0],
                ..Default::default()
            },
            900_000,
        );
        assert_eq!(
            Calibration::restore(&c.snapshot().unwrap()).unwrap().scopes[&scope].len(),
            1
        );
        c.invalidate(&scope);
        assert!(Calibration::restore(&c.snapshot().unwrap())
            .unwrap()
            .scopes
            .is_empty());
    }
}
