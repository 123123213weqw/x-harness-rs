//! Bounded calibration of complete wire requests; versioned numeric-only snapshots.
use crate::{ProviderInputTokenCount, TokenCountAccuracy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

mod mixed;

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
    fn similar_text(&self, other: &Self) -> bool {
        let a = self.units() as f64;
        let b = other.units() as f64;
        a / b <= 2.0
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
    mixed_scopes: BTreeMap<String, VecDeque<Sample>>,
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    mixed_scopes: BTreeMap<String, VecDeque<Sample>>,
}

fn snapshot_scopes(
    scopes: &BTreeMap<String, VecDeque<Sample>>,
) -> BTreeMap<String, VecDeque<Sample>> {
    scopes
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
        .collect()
}

impl Calibration {
    /// Only hashed identities and numeric features are serializable. Reject
    /// arbitrary caller identifiers instead of accidentally persisting text.
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&Snapshot {
            version: 2,
            scopes: snapshot_scopes(&self.scopes),
            mixed_scopes: snapshot_scopes(&self.mixed_scopes),
        })
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
        if !matches!(snapshot.version, 1 | 2)
            || (snapshot.version == 1 && !snapshot.mixed_scopes.is_empty())
            || snapshot.scopes.len() > 64
            || snapshot.mixed_scopes.len() > 64
        {
            return Err("unsupported calibration snapshot".into());
        }
        for (scopes, mixed) in [
            (&mut snapshot.scopes, false),
            (&mut snapshot.mixed_scopes, true),
        ] {
            for (scope, rows) in scopes.iter_mut() {
                if !digest(scope) || rows.len() > 32 {
                    return Err("invalid calibration scope".into());
                }
                let mut ids = std::collections::BTreeSet::new();
                for s in rows.iter() {
                    if !digest(&s.request_id)
                        || !ids.insert(&s.request_id)
                        || s.actual == 0
                        || s.actual > 1_000_000_000_000
                        || (s.features.image_tokens != 0) != mixed
                        || s.features.image_tokens > 1_000_000_000_000
                        || s.features.units() > 1_000_000_000_000
                    {
                        return Err("invalid calibration sample".into());
                    }
                }
                rows.retain(|s| {
                    s.observed_at_ms <= now && now - s.observed_at_ms <= CALIBRATION_TTL_MS
                });
            }
            scopes.retain(|_, rows| !rows.is_empty());
        }
        Ok(Self {
            scopes: snapshot.scopes,
            mixed_scopes: snapshot.mixed_scopes,
        })
    }
    pub fn invalidate(&mut self, scope: &str) {
        self.scopes.remove(scope);
        self.mixed_scopes.remove(scope);
    }

    // Only text-only observations identify the text price. A mixed response's
    // total cannot be split by subtracting an estimated image allowance.
    fn estimate_text(&self, scope: &str, features: &WireFeatures) -> (u64, TokenCountAccuracy) {
        let rows: Vec<_> = self
            .scopes
            .get(scope)
            .into_iter()
            .flatten()
            .filter(|s| {
                s.observed_at_ms <= now_ms()
                    && now_ms().saturating_sub(s.observed_at_ms) <= CALIBRATION_TTL_MS
                    && s.features.image_tokens == 0
                    && features.similar_text(&s.features)
            })
            .collect();
        // Preserve text distribution, warmup and scope boundaries even when the
        // current request includes images. Image pricing remains independent.
        if rows.len() >= 8 {
            let ratio = rows
                .iter()
                .map(|s| s.actual as f64 / s.features.units() as f64)
                .fold(0.0_f64, f64::max);
            (
                ((features.units() as f64 * ratio * 1.25).ceil() as u64).saturating_add(256),
                TokenCountAccuracy::Calibrated,
            )
        } else {
            (features.units(), TokenCountAccuracy::Estimated)
        }
    }

    pub fn estimate(&self, scope: &str, features: &WireFeatures) -> ProviderInputTokenCount {
        let (mut text_tokens, text_accuracy) = self.estimate_text(scope, features);
        // Mixed totals are never text measurements. Only a mixed query may
        // reuse their conservative upper envelope when pure-text training is cold.
        if features.image_tokens != 0 && text_accuracy == TokenCountAccuracy::Estimated {
            if let Some(upper) = self.mixed_text_upper(scope, features) {
                text_tokens = text_tokens.min(upper);
            }
        }
        ProviderInputTokenCount {
            counter: format!("wire-calibration/v1:{scope}"),
            input_tokens: text_tokens.saturating_add(features.image_tokens),
            // The image allowance is still estimated, not a measured image cost.
            accuracy: if features.image_tokens == 0 {
                text_accuracy
            } else {
                TokenCountAccuracy::Estimated
            },
        }
    }
    pub fn observe(&mut self, scope: &str, request_id: &str, features: WireFeatures, actual: u64) {
        if actual == 0 {
            return;
        }
        if features.image_tokens != 0 {
            self.observe_mixed(scope, request_id, features, actual);
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
            self.mixed_scopes.remove(scope);
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
    fn first_and_repeated_images_add_allowance_without_repricing_text() {
        use crate::{ConservativeByteMeter, TokenBudget, TokenGuard};
        use std::sync::Arc;

        let mut c = Calibration::default();
        for i in 0..8 {
            c.observe("s", &i.to_string(), f(900_000), 225_000);
        }
        let text = c.estimate("s", &f(900_000));
        assert_eq!(text.accuracy, TokenCountAccuracy::Calibrated);
        let guard = TokenGuard::new(
            Arc::new(ConservativeByteMeter),
            TokenBudget::new(1_048_576, 65_536),
        )
        .unwrap();
        for images in [1, 2, 8, 64] {
            let features = WireFeatures {
                image_tokens: images * 20_520,
                ..f(900_000)
            };
            let mixed = c.estimate("s", &features);
            assert_eq!(
                mixed.input_tokens,
                text.input_tokens + features.image_tokens
            );
            assert_eq!(mixed.accuracy, TokenCountAccuracy::Estimated);
            if images <= 8 {
                let budget = guard.check_provider_count(&mixed).unwrap();
                assert!(budget.estimate.total_input_tokens < 1_048_576 * 4 / 5);
            } else {
                assert!(guard.check_provider_count(&mixed).is_err());
            }
        }
        assert_eq!(c.estimate("s", &f(900_000)), text);
    }

    #[test]
    fn mixed_requests_keep_cold_distribution_scope_and_warmup_guards() {
        let mut c = Calibration::default();
        let mixed = |n, image_tokens| WireFeatures {
            image_tokens,
            ..f(n)
        };
        for i in 0..7 {
            c.observe("s", &i.to_string(), f(400_000), 100_000);
        }
        assert_eq!(c.estimate("s", &mixed(400_000, 4096)).input_tokens, 404_096);
        c.observe("s", "eighth", f(400_000), 100_000);
        assert!(c.estimate("s", &mixed(400_000, 4096)).input_tokens < 200_000);
        for (scope, features) in [
            ("other-endpoint", mixed(400_000, 4096)),
            ("s", mixed(4_000_000, 4096)),
            (
                "s",
                WireFeatures {
                    buckets: [0, 0, 400_000],
                    image_tokens: 4096,
                    ..Default::default()
                },
            ),
        ] {
            assert_eq!(
                c.estimate(scope, &features).input_tokens,
                features.units() + features.image_tokens
            );
        }
        assert_eq!(
            c.estimate("s", &mixed(400_000, u64::MAX)).input_tokens,
            u64::MAX
        );
    }

    #[test]
    fn mixed_usage_does_not_learn_text_or_evict_text_samples() {
        let mut c = Calibration::default();
        for i in 0..8 {
            c.observe("s", &i.to_string(), f(400_000), 100_000);
        }
        let text = c.estimate("s", &f(400_000));
        for i in 0..64 {
            c.observe(
                "s",
                &format!("image-{i}"),
                WireFeatures {
                    image_tokens: 4096,
                    ..f(400_000)
                },
                // An unusually cheap total must never teach a lower text ratio.
                1,
            );
        }
        assert_eq!(c.estimate("s", &f(400_000)), text);
        assert_eq!(c.scopes["s"].len(), 8);
        assert!(!c.scopes["s"].iter().any(|s| s.features.image_tokens != 0));
    }

    #[test]
    fn mixed_underestimate_invalidates_reused_text_without_learning_image_totals() {
        let mut c = Calibration::default();
        for i in 0..8 {
            c.observe("s", &i.to_string(), f(400_000), 100_000);
        }
        let features = WireFeatures {
            image_tokens: 4096,
            ..f(400_000)
        };
        let prior = c.estimate("s", &features);
        c.observe("s", "no-usage", features.clone(), 0);
        c.observe("s", "safe", features.clone(), prior.input_tokens);
        assert_eq!(c.estimate("s", &features), prior);
        c.observe(
            "s",
            "underestimate",
            features.clone(),
            prior.input_tokens + 1,
        );
        assert_eq!(c.estimate("s", &features).input_tokens, 404_096);
        assert_eq!(
            c.estimate("s", &f(400_000)).accuracy,
            TokenCountAccuracy::Estimated
        );
        assert!(!c.scopes.contains_key("s"));
    }

    #[test]
    fn measured_game_history_first_image_does_not_create_false_pressure() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/first-image-calibration.json"
        ))
        .unwrap();
        let mut c = Calibration::default();
        for (index, row) in fixture["samples"].as_array().unwrap().iter().enumerate() {
            c.observe(
                "replay",
                &index.to_string(),
                serde_json::from_value(row["features"].clone()).unwrap(),
                row["actual"].as_u64().unwrap(),
            );
        }
        let mut query: WireFeatures = serde_json::from_value(fixture["query"].clone()).unwrap();
        let text = c.estimate("replay", &query);
        assert_eq!(text.accuracy, TokenCountAccuracy::Calibrated);
        query.image_tokens = fixture["first_image_allowance"].as_u64().unwrap();
        let mixed = c.estimate("replay", &query);
        let old = query.units() + query.image_tokens;
        assert_eq!(mixed.input_tokens, text.input_tokens + query.image_tokens);
        assert!(old > 750_000);
        assert!(mixed.input_tokens < 350_000);
        assert!(mixed.input_tokens >= fixture["reported_input_after_image"].as_u64().unwrap());
        eprintln!(
            "numeric first-image replay: {}",
            serde_json::json!({"old_estimate":old,"new_estimate":mixed.input_tokens,"text_estimate":text.input_tokens,"image_allowance":query.image_tokens})
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

    #[test]
    fn restart_reuses_text_for_images_and_persists_mixed_underestimate_invalidation() {
        let c = warm();
        let scope = "a".repeat(64);
        let mut restored = Calibration::restore(&c.snapshot().unwrap()).unwrap();
        let mixed = WireFeatures {
            buckets: [1_448_000, 0, 0],
            image_tokens: 20_520,
            ..Default::default()
        };
        let estimate = restored.estimate(&scope, &mixed);
        assert_eq!(estimate.accuracy, TokenCountAccuracy::Estimated);
        assert!(estimate.input_tokens < mixed.units());
        restored.observe(
            &scope,
            &"f".repeat(64),
            mixed.clone(),
            estimate.input_tokens + 1,
        );
        let restarted = Calibration::restore(&restored.snapshot().unwrap()).unwrap();
        assert_eq!(
            restarted.estimate(&scope, &mixed).input_tokens,
            mixed.units() + mixed.image_tokens
        );

        // Version 1 snapshots must still reject mixed totals as text samples.
        let mut invalid: Value = serde_json::from_slice(&c.snapshot().unwrap()).unwrap();
        invalid["scopes"][&scope][0]["features"]["image_tokens"] = 1.into();
        assert!(Calibration::restore(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}

#[cfg(test)]
mod mixed_tests;
