//! Provider-neutral recovery policy. No sockets, UI, tasks or tool execution.
use crate::{LoopConfig, ProviderError};
use std::time::Duration;
use tokio::time::Instant;

pub(crate) struct RetryPlan {
    pub attempt: usize,
    /// None means a cancellable, sustained transport wait, not unlimited HTTP retries.
    pub max_retries: Option<usize>,
    pub delay_ms: u64,
}

/// Run-scoped delay exponent, independent of journal-chain attempt numbering.
/// Partial output and pause/resume do not prove that the connection recovered.
#[derive(Default)]
pub(crate) struct NetworkBackoff {
    failures: usize,
}

impl NetworkBackoff {
    pub fn reset(&mut self) {
        self.failures = 0;
    }

    fn next(&mut self) -> usize {
        self.failures = self.failures.saturating_add(1);
        self.failures
    }
}

#[derive(Default)]
pub(crate) struct RetryState {
    bounded_attempts: usize,
    network_attempts: usize,
    pub deadline: Option<Instant>,
}

impl RetryState {
    pub fn with_deadline(deadline: Option<Instant>) -> Self {
        Self {
            deadline,
            ..Self::default()
        }
    }

    pub fn next(
        &mut self,
        config: &LoopConfig,
        error: &ProviderError,
        entropy: u64,
        network_backoff: &mut NetworkBackoff,
    ) -> Result<Option<RetryPlan>, String> {
        if config.network_wait_enabled && error.is_transient_transport() {
            // Never let a previous short-retry deadline kill a long network wait.
            self.deadline = None;
            self.network_attempts = self
                .network_attempts
                .checked_add(1)
                .filter(|n| *n <= u32::MAX as usize)
                .ok_or("network retry counter exhausted")?;
            return Ok(Some(RetryPlan {
                attempt: self.network_attempts,
                max_retries: None,
                delay_ms: retry_delay(
                    config,
                    network_backoff.next(),
                    error.retry_after_ms,
                    entropy,
                    config.network_wait_max_delay_ms,
                ),
            }));
        }
        if !error.retryable || self.bounded_attempts >= config.provider_retries {
            return Ok(None);
        }
        self.bounded_attempts += 1;
        let deadline = *self.deadline.get_or_insert_with(|| {
            Instant::now() + Duration::from_millis(config.provider_retry_budget_ms)
        });
        let delay_ms = retry_delay(
            config,
            self.bounded_attempts,
            error.retry_after_ms,
            entropy,
            config.provider_retry_max_delay_ms,
        );
        if Duration::from_millis(delay_ms) >= deadline.saturating_duration_since(Instant::now()) {
            return Err(format!("provider recovery budget exhausted; required wait {delay_ms} ms exceeds remaining budget; {}", error.diagnostic_message()));
        }
        Ok(Some(RetryPlan {
            attempt: self.bounded_attempts,
            max_retries: Some(config.provider_retries),
            delay_ms,
        }))
    }
}

pub(crate) fn retry_delay(
    config: &LoopConfig,
    retry: usize,
    retry_after: Option<u64>,
    entropy: u64,
    maximum: u64,
) -> u64 {
    let exponent = retry.saturating_sub(1).min(63) as u32;
    let base = config
        .provider_retry_base_delay_ms
        .saturating_mul(1u64 << exponent)
        .min(maximum);
    let spread = base.saturating_mul(u64::from(config.provider_retry_jitter_percent)) / 100;
    let jittered = base
        .saturating_sub(spread)
        .saturating_add(entropy % (spread.saturating_mul(2).saturating_add(1)))
        .min(maximum);
    // Retry-After is a minimum, including when it exceeds the local cap.
    jittered.max(retry_after.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProviderNetworkDiagnostics;
    fn transport() -> ProviderError {
        let mut e = ProviderError::retryable("offline");
        e.diagnostics = Some(Box::new(ProviderNetworkDiagnostics {
            route: "https://fixture.invalid".into(),
            kind: "connect_or_headers".into(),
            elapsed_ms: 0,
            received_chunks: 0,
            received_bytes: 0,
            last_chunk_ago_ms: None,
            protocol_completed: false,
        }));
        e
    }
    #[tokio::test(start_paused = true)]
    async fn sustained_network_wait_has_no_short_deadline_but_has_backoff_cap() {
        let config = LoopConfig {
            provider_retry_jitter_percent: 0,
            ..LoopConfig::default()
        };
        let mut backoff = NetworkBackoff::default();
        let mut state = RetryState::with_deadline(Some(Instant::now()));
        for n in 1..=30 {
            let p = state
                .next(&config, &transport(), 0, &mut backoff)
                .unwrap()
                .unwrap();
            assert_eq!(p.attempt, n);
            assert_eq!(p.max_retries, None);
            assert_eq!(
                p.delay_ms,
                500u64.saturating_mul(1u64 << (n - 1)).min(30_000)
            );
            assert!(state.deadline.is_none());
            tokio::time::advance(Duration::from_secs(60)).await;
        }
    }
    #[tokio::test(start_paused = true)]
    async fn http_and_unstructured_errors_remain_bounded_and_separate_from_network_attempts() {
        for error in [
            ProviderError::http(429, "busy"),
            ProviderError::http(503, "busy"),
            ProviderError::retryable("no transport evidence"),
        ] {
            let mut backoff = NetworkBackoff::default();
            let mut state = RetryState::default();
            let config = LoopConfig::default();
            for _ in 0..4 {
                state.next(&config, &transport(), 0, &mut backoff).unwrap();
            }
            for n in 1..=2 {
                let p = state
                    .next(&config, &error, 0, &mut backoff)
                    .unwrap()
                    .unwrap();
                assert_eq!(p.attempt, n);
                assert_eq!(p.max_retries, Some(2));
            }
            assert!(state
                .next(&config, &error, 0, &mut backoff)
                .unwrap()
                .is_none());
        }
        for status in [400, 401, 403, 404] {
            assert!(RetryState::default()
                .next(
                    &LoopConfig::default(),
                    &ProviderError::http(status, "bad"),
                    0,
                    &mut NetworkBackoff::default()
                )
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn chain_attempts_remain_independent_and_long_lived_backoff_saturates() {
        let config = LoopConfig {
            provider_retry_jitter_percent: 0,
            ..LoopConfig::default()
        };
        let mut backoff = NetworkBackoff {
            failures: usize::MAX,
        };
        for _ in 0..3 {
            let plan = RetryState::default()
                .next(&config, &transport(), 0, &mut backoff)
                .unwrap()
                .unwrap();
            assert_eq!(plan.attempt, 1);
            assert_eq!(plan.delay_ms, config.network_wait_max_delay_ms);
        }
        backoff.reset();
        let plan = RetryState::default()
            .next(&config, &transport(), 0, &mut backoff)
            .unwrap()
            .unwrap();
        assert_eq!(plan.delay_ms, 500);
    }
    #[tokio::test(start_paused = true)]
    async fn transport_opt_out_and_retry_after_keep_legacy_bounds() {
        let config = LoopConfig {
            network_wait_enabled: false,
            ..LoopConfig::default()
        };
        let mut backoff = NetworkBackoff::default();
        let mut state = RetryState::default();
        for _ in 0..2 {
            assert!(state
                .next(&config, &transport(), 0, &mut backoff)
                .unwrap()
                .is_some());
        }
        assert!(state
            .next(&config, &transport(), 0, &mut backoff)
            .unwrap()
            .is_none());
        let mut e = ProviderError::http(429, "busy");
        e.retry_after_ms = Some(120_000);
        assert!(RetryState::default()
            .next(
                &LoopConfig::default(),
                &e,
                0,
                &mut NetworkBackoff::default()
            )
            .is_err());
        let mut e = transport();
        e.retry_after_ms = Some(120_000);
        assert_eq!(
            RetryState::default()
                .next(
                    &LoopConfig::default(),
                    &e,
                    0,
                    &mut NetworkBackoff::default()
                )
                .unwrap()
                .unwrap()
                .delay_ms,
            120_000
        );
    }
}
