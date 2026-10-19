use super::*;
use serde_json::json;

fn mixed(units: u64) -> WireFeatures {
    WireFeatures {
        buckets: [units * 68 / 100, units * 29 / 100, units / 100],
        framing: units - units * 68 / 100 - units * 29 / 100 - units / 100,
        image_tokens: 145_575,
    }
}

#[test]
fn mixed_growth_recovers_after_text_samples_become_incompatible() {
    let mut c = Calibration::default();
    for i in 0..9 {
        c.observe(
            "s",
            &format!("text-{i}"),
            WireFeatures {
                buckets: [20_000, 65_000, 500],
                framing: 10_000,
                image_tokens: 0,
            },
            28_000,
        );
    }
    // Reconstructed size/distribution, not the private request body. These
    // totals match the recorded 734,086 estimate and 182,078 reported input.
    let query = mixed(588_511);
    assert_eq!(query.units() + query.image_tokens, 734_086);
    assert_eq!(c.estimate("s", &query).input_tokens, 734_086);
    for i in 0..8 {
        let n = 560_000 + i * 4_000;
        c.observe("s", &format!("image-{i}"), mixed(n), 174_000 + i * 1_000);
    }
    let estimate = c.estimate("s", &query);
    assert!(
        estimate.input_tokens < 400_000,
        "mixed growth remained byte-priced: {estimate:?}"
    );
    assert!(estimate.input_tokens >= 182_078);
    assert!(estimate.input_tokens >= query.image_tokens);
    assert_eq!(estimate.accuracy, TokenCountAccuracy::Estimated);
    assert_eq!(c.scopes["s"].len(), 9);
}

#[test]
fn image_only_history_can_warm_up_without_text_only_observations() {
    let mut c = Calibration::default();
    let query = mixed(588_511);
    for i in 0..7 {
        c.observe("s", &format!("image-{i}"), query.clone(), 182_078);
    }
    assert_eq!(c.estimate("s", &query).input_tokens, 734_086);
    c.observe("s", "eighth", query.clone(), 182_078);
    assert!(c.estimate("s", &query).input_tokens < 400_000);
    let text = WireFeatures {
        image_tokens: 0,
        ..query
    };
    assert_eq!(c.estimate("s", &text).input_tokens, text.units());
    assert_eq!(
        c.estimate("s", &text).accuracy,
        TokenCountAccuracy::Estimated
    );
}

fn warm_mixed() -> (Calibration, String, WireFeatures) {
    let mut c = Calibration::default();
    let scope = "a".repeat(64);
    let query = mixed(588_511);
    for i in 0..8 {
        c.observe(&scope, &format!("{i:064x}"), query.clone(), 182_078);
    }
    (c, scope, query)
}

#[test]
fn mixed_envelope_never_subtracts_a_guessed_image_cost() {
    let (c, scope, mut query) = warm_mixed();
    let bound = c.estimate(&scope, &query).input_tokens;
    assert_eq!(bound, 227_854 + query.image_tokens);
    query.image_tokens += 10_000;
    assert_eq!(c.estimate(&scope, &query).input_tokens, bound + 10_000);
    query.image_tokens = u64::MAX;
    assert_eq!(c.estimate(&scope, &query).input_tokens, u64::MAX);
}

#[test]
fn mixed_envelope_keeps_scope_size_distribution_and_warmup_boundaries() {
    let (c, scope, query) = warm_mixed();
    for (s, f) in [
        ("b".repeat(64), query.clone()),
        (scope.clone(), mixed(6_000_000)),
        (
            scope.clone(),
            WireFeatures {
                buckets: [0, 0, 588_511],
                framing: 0,
                ..query
            },
        ),
    ] {
        assert_eq!(c.estimate(&s, &f).input_tokens, f.units() + f.image_tokens);
    }
}

#[test]
fn mixed_duplicate_and_zero_usage_cannot_train_or_invalidate() {
    let (mut c, scope, query) = warm_mixed();
    let before = c.estimate(&scope, &query);
    c.observe(&scope, &format!("{:064x}", 7), query.clone(), u64::MAX);
    c.observe(&scope, "no-usage", query.clone(), 0);
    assert_eq!(c.mixed_scopes[&scope].len(), 8);
    assert_eq!(c.estimate(&scope, &query), before);
}

#[test]
fn mixed_drift_and_explicit_invalidation_survive_restart() {
    let (mut c, scope, query) = warm_mixed();
    let prior = c.estimate(&scope, &query).input_tokens;
    c.observe(&scope, &"f".repeat(64), query.clone(), prior + 1);
    assert_eq!(c.mixed_scopes[&scope].len(), 1);
    let mut restored = Calibration::restore(&c.snapshot().unwrap()).unwrap();
    assert_eq!(restored.estimate(&scope, &query).input_tokens, 734_086);
    restored.invalidate(&scope);
    assert!(Calibration::restore(&restored.snapshot().unwrap())
        .unwrap()
        .mixed_scopes
        .is_empty());
}

#[test]
fn mixed_restart_is_numeric_only_and_legacy_text_cache_is_readable() {
    let (mut c, scope, query) = warm_mixed();
    let before = c.estimate(&scope, &query);
    c.observe("private-endpoint", "private-prompt", query.clone(), 123);
    let bytes = c.snapshot().unwrap();
    let encoded = String::from_utf8(bytes.clone()).unwrap();
    assert!(!encoded.contains("private"));
    let restored = Calibration::restore(&bytes).unwrap();
    assert_eq!(restored.estimate(&scope, &query), before);
    assert!(restored.scopes.is_empty());
    let mut legacy: Value = serde_json::from_slice(&bytes).unwrap();
    legacy["version"] = 1.into();
    assert!(Calibration::restore(&serde_json::to_vec(&legacy).unwrap()).is_err());
    legacy.as_object_mut().unwrap().remove("mixed_scopes");
    assert!(Calibration::restore(&serde_json::to_vec(&legacy).unwrap()).is_ok());
}

#[test]
fn mixed_snapshot_validation_rejects_wrong_partition_and_numeric_corruption() {
    let (c, scope, _) = warm_mixed();
    let v: Value = serde_json::from_slice(&c.snapshot().unwrap()).unwrap();
    for (field, bad) in [
        ("actual", json!(0)),
        ("actual", json!(1_000_000_000_001_u64)),
        ("request_id", json!("secret")),
        ("observed_at_ms", json!("bad")),
    ] {
        let mut altered = v.clone();
        altered["mixed_scopes"][&scope][0][field] = bad;
        assert!(Calibration::restore(&serde_json::to_vec(&altered).unwrap()).is_err());
    }
    for (field, bad) in [("image_tokens", 0), ("image_tokens", 1_000_000_000_001_u64)] {
        let mut altered = v.clone();
        altered["mixed_scopes"][&scope][0]["features"][field] = bad.into();
        assert!(Calibration::restore(&serde_json::to_vec(&altered).unwrap()).is_err());
    }
    let mut duplicate = v.clone();
    duplicate["mixed_scopes"][&scope][1] = duplicate["mixed_scopes"][&scope][0].clone();
    assert!(Calibration::restore(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    let mut swapped = v;
    swapped["scopes"] = swapped["mixed_scopes"].take();
    assert!(Calibration::restore(&serde_json::to_vec(&swapped).unwrap()).is_err());
}

#[test]
fn mixed_expired_future_and_oversized_histories_stay_cold() {
    let (mut c, scope, query) = warm_mixed();
    let bytes = c.snapshot().unwrap();
    for now in [0, now_ms() + CALIBRATION_TTL_MS + 1] {
        let restored = Calibration::restore_at(&bytes, now).unwrap();
        assert!(restored.mixed_scopes.is_empty());
        assert_eq!(restored.estimate(&scope, &query).input_tokens, 734_086);
    }
    for i in 8..80 {
        c.observe(&scope, &format!("{i:064x}"), query.clone(), 182_078);
    }
    assert_eq!(c.mixed_scopes[&scope].len(), 32);
    for i in 0..100 {
        c.observe(
            &format!("{i:064x}"),
            &"f".repeat(64),
            query.clone(),
            182_078,
        );
    }
    assert!(c.mixed_scopes.len() <= 64);
    assert!(c.snapshot().unwrap().len() < MAX_CALIBRATION_BYTES);
}

#[test]
fn recovered_mixed_estimate_still_rejects_genuine_context_overflow() {
    use crate::{ConservativeByteMeter, TokenBudget, TokenGuard};
    use std::sync::Arc;
    let (c, scope, query) = warm_mixed();
    let estimate = c.estimate(&scope, &query);
    let guard = TokenGuard::new(
        Arc::new(ConservativeByteMeter),
        TokenBudget::new(524_288, 65_536),
    )
    .unwrap();
    assert!(guard.check_provider_count(&estimate).is_ok());
    let tight = TokenGuard::new(
        Arc::new(ConservativeByteMeter),
        TokenBudget::new(100_000, 65_536),
    )
    .unwrap();
    assert!(tight.check_provider_count(&estimate).is_err());
}

#[test]
fn repeated_body_with_higher_real_usage_still_invalidates_mixed_bound() {
    let (mut c, scope, query) = warm_mixed();
    let prior = c.estimate(&scope, &query).input_tokens;
    c.observe(&scope, &format!("{:064x}", 7), query.clone(), prior + 1);
    assert_eq!(c.mixed_scopes[&scope].len(), 1);
    assert_eq!(c.estimate(&scope, &query).input_tokens, 734_086);
}

#[test]
fn legacy_version_one_text_samples_keep_their_estimate() {
    let mut c = Calibration::default();
    let scope = "a".repeat(64);
    let query = WireFeatures {
        image_tokens: 0,
        ..mixed(588_511)
    };
    for i in 0..8 {
        c.observe(&scope, &format!("{i:064x}"), query.clone(), 150_000);
    }
    let before = c.estimate(&scope, &query);
    let mut legacy: Value = serde_json::from_slice(&c.snapshot().unwrap()).unwrap();
    legacy["version"] = 1.into();
    legacy.as_object_mut().unwrap().remove("mixed_scopes");
    assert_eq!(
        Calibration::restore(&serde_json::to_vec(&legacy).unwrap())
            .unwrap()
            .estimate(&scope, &query),
        before
    );
}

#[test]
fn text_drift_also_discards_the_old_mixed_envelope() {
    let (mut c, scope, query) = warm_mixed();
    let text = WireFeatures {
        image_tokens: 0,
        ..query.clone()
    };
    for i in 100..108 {
        c.observe(&scope, &format!("{i:064x}"), text.clone(), 150_000);
    }
    assert!(c.mixed_scopes.contains_key(&scope));
    let prior = c.estimate(&scope, &text);
    assert_eq!(prior.accuracy, TokenCountAccuracy::Calibrated);
    c.observe(&scope, &"f".repeat(64), text, prior.input_tokens + 1);
    assert!(!c.mixed_scopes.contains_key(&scope));
    assert_eq!(c.estimate(&scope, &query).input_tokens, 734_086);
}
