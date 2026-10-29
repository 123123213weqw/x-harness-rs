//! A separate upper envelope for mixed requests; never an inferred image price.
use super::*;

impl Calibration {
    /// Warm up on complete multimodal observations, never by subtracting a
    /// guessed image cost. Different dimensions, scopes, distributions and
    /// large extrapolations remain cold and retain conservative admission.
    pub(super) fn mixed_request_upper(&self, scope: &str, features: &WireFeatures) -> Option<u64> {
        let visual = features.images.as_ref()?;
        if !visual.is_valid() {
            return None;
        }
        let now = now_ms();
        let mut count = 0;
        let mut upper = 0.0_f64;
        for sample in self.mixed_scopes.get(scope)? {
            let Some(old) = sample.features.images.as_ref() else {
                continue;
            };
            let ratio = visual.count as f64 / old.count.max(1) as f64;
            let pixel_ratio = visual.pixels as f64 / old.pixels.max(1) as f64;
            if sample.observed_at_ms > now
                || now - sample.observed_at_ms > CALIBRATION_TTL_MS
                || !features.similar_text(&sample.features)
                || visual.max_width != old.max_width
                || visual.max_height != old.max_height
                || !(0.5..=2.0).contains(&ratio)
                || !(0.5..=2.0).contains(&pixel_ratio)
            {
                continue;
            }
            count += 1;
            let growth = (features.units() as f64 / sample.features.units() as f64)
                .max(ratio)
                .max(pixel_ratio)
                .max(1.0);
            upper = upper.max(sample.actual as f64 * growth);
        }
        (count >= 8).then(|| ((upper * 1.25).ceil() as u64).saturating_add(256))
    }

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
            || actual == 0
            || actual > 1_000_000_000_000
            || features.images.as_ref().is_some_and(|i| !i.is_valid())
        {
            return;
        }
        let duplicate = self
            .mixed_scopes
            .get(scope)
            .is_some_and(|rows| rows.iter().any(|sample| sample.request_id == request_id));
        let (_, text_accuracy) = self.estimate_text(scope, &features);
        let trained = text_accuracy == TokenCountAccuracy::Calibrated
            || self.mixed_text_upper(scope, &features).is_some()
            || self.mixed_request_upper(scope, &features).is_some();
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
