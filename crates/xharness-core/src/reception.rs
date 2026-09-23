//! Lightweight per-delta observation. Journal at most once per reception
//! second plus request completion; do not move the retry commit boundary.
use crate::TokenUsage;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::Instant;
use xharness_session::{reception_units, ModelReception, ReceptionSample};

pub(crate) struct ReceptionRecorder {
    clock: Instant,
    start_ms: u64,
    attempt: u32,
    first_ms: Option<u64>,
    last_publish_ms: u64,
    estimated_units: u64,
    reasoning_units: u64,
    samples: Vec<ReceptionSample>,
}

impl ReceptionRecorder {
    pub(crate) fn new(attempt: u32) -> Self {
        Self {
            clock: Instant::now(),
            start_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            attempt,
            first_ms: None,
            last_publish_ms: 0,
            estimated_units: 0,
            reasoning_units: 0,
            samples: Vec::new(),
        }
    }
    fn elapsed_ms(&self) -> u64 {
        self.clock.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
    pub(crate) fn observe(&mut self, kind: &str, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let elapsed = self.elapsed_ms();
        self.first_ms.get_or_insert(elapsed);
        let time_ms = self.start_ms.saturating_add(elapsed) / 1000 * 1000;
        if self.samples.last().is_none_or(|s| s.time_ms != time_ms) {
            self.samples.push(ReceptionSample {
                time_ms,
                ..Default::default()
            });
        }
        let units = reception_units(text);
        self.estimated_units = self.estimated_units.saturating_add(units);
        if kind == "reasoning" {
            self.reasoning_units = self.reasoning_units.saturating_add(units);
        }
        let sample = self.samples.last_mut().expect("sample inserted above");
        let count = match kind {
            "reasoning" => &mut sample.reasoning_units,
            "arguments" => &mut sample.argument_units,
            _ => &mut sample.text_units,
        };
        *count = count.saturating_add(units);
        elapsed.saturating_sub(self.last_publish_ms) >= 1000
    }
    pub(crate) fn checkpoint(
        &mut self,
        finished: bool,
        usage: Option<&TokenUsage>,
    ) -> ModelReception {
        let elapsed_ms = self.elapsed_ms();
        let span = self
            .first_ms
            .map_or(0, |first| elapsed_ms.saturating_sub(first));
        self.last_publish_ms = elapsed_ms;
        ModelReception {
            attempt: self.attempt,
            start_ms: self.start_ms,
            first_delta_ms: self
                .first_ms
                .map(|first| self.start_ms.saturating_add(first)),
            elapsed_ms,
            reception_ms: if span > 0 { span } else { elapsed_ms.max(1) },
            estimated_units: self.estimated_units,
            estimated_reasoning_units: self.reasoning_units,
            finished,
            output_tokens: usage.map(|u| u.output_tokens),
            reasoning_tokens: usage.map(|u| u.reasoning_tokens),
            samples: std::mem::take(&mut self.samples),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn private_tool_prefix_is_measured_before_release() {
        let mut r = ReceptionRecorder::new(0);
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        assert!(r.observe("arguments", "abcd"));
        let first = r.checkpoint(false, None);
        tokio::time::advance(std::time::Duration::from_secs(3)).await;
        r.observe("arguments", "efgh");
        let final_sample = r.checkpoint(
            true,
            Some(&TokenUsage {
                output_tokens: 288,
                ..Default::default()
            }),
        );
        assert_eq!(final_sample.reception_ms, 3000);
        assert_eq!(final_sample.elapsed_ms, 5000);
        assert_eq!(final_sample.first_delta_ms, first.first_delta_ms);
        assert_eq!(final_sample.estimated_units, 8);
        assert_eq!(final_sample.output_tokens, Some(288));
        assert_eq!(final_sample.samples.len(), 1);
    }
    #[tokio::test(start_paused = true)]
    async fn empty_deltas_and_single_burst_do_not_invent_infinity() {
        let mut r = ReceptionRecorder::new(2);
        assert!(!r.observe("reasoning", ""));
        tokio::time::advance(std::time::Duration::from_secs(3)).await;
        r.observe("text", "hi中");
        let sample = r.checkpoint(true, None);
        assert_eq!(sample.reception_ms, 3000);
        assert_eq!(sample.estimated_units, 6);
        assert_eq!(sample.attempt, 2);
    }
}
