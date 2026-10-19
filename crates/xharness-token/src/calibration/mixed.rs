//! A separate upper envelope for mixed requests; never an inferred image price.
use super::*;

impl Calibration {
    pub(super) fn mixed_text_upper(&self, scope: &str, features: &WireFeatures) -> Option<u64> {
        let now = now_ms();
        let rows = self.mixed_scopes.get(scope)?;
        let mut count = 0;
        let mut ratio = 0.0_f64;
        for sample in rows {
            if sample.observed_at_ms <= now
                && now - sample.observed_at_ms <= CALIBRATION_TTL_MS
                && features.similar_text(&sample.features)
            {
                count += 1;
                // The complete reported input includes its image cost. Keeping
                // it all gives an upper text envelope, not a text measurement.
                // Add the current request's independent image allowance later.
                ratio = ratio.max(sample.actual as f64 / sample.features.units() as f64);
            }
        }
        (count >= 8)
            .then(|| ((features.units() as f64 * ratio * 1.25).ceil() as u64).saturating_add(256))
    }

    pub(super) fn observe_mixed(
        &mut self,
        scope: &str,
        request_id: &str,
        features: WireFeatures,
        actual: u64,
    ) {
        // Invalid numeric observations cannot poison a previously learned bound.
        if features.units() > 1_000_000_000_000
            || features.image_tokens > 1_000_000_000_000
            || actual > 1_000_000_000_000
        {
            return;
        }
        let duplicate = self
            .mixed_scopes
            .get(scope)
            .is_some_and(|rows| rows.iter().any(|sample| sample.request_id == request_id));
        let (_, text_accuracy) = self.estimate_text(scope, &features);
        let trained = text_accuracy == TokenCountAccuracy::Calibrated
            || self.mixed_text_upper(scope, &features).is_some();
        if trained && actual > self.estimate(scope, &features).input_tokens {
            // Even a repeated body can expose changed gateway usage. Invalidate
            // before deduplication; repeats may not hide a violated upper bound.
            self.invalidate(scope);
        } else if duplicate {
            return;
        }
        // The mixed cache has its own bound so repeated screenshots cannot
        // evict independently verified text-only observations.
        if self.mixed_scopes.len() >= 64 && !self.mixed_scopes.contains_key(scope) {
            self.mixed_scopes.clear();
        }
        let rows = self.mixed_scopes.entry(scope.into()).or_default();
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
