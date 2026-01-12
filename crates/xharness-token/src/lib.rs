//! Provider-neutral token metering and hard context-window admission.
//!
//! Exact provider/model tokenizers can implement [`TokenMeter`]. Deployments
//! without one may use [`ConservativeByteMeter`], whose UTF-8/JSON byte count
//! intentionally overestimates ordinary BPE token counts rather than risking
//! an HTTP request that the model server must reject.

use std::{fmt, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Complete provider-neutral material whose protocol serialization consumes
/// context. System messages are separate so diagnostics explain the budget.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenEstimateRequest {
    pub provider: String,
    pub model: Option<String>,
    pub system_messages: Vec<Value>,
    pub conversation_messages: Vec<Value>,
    pub tools: Vec<Value>,
}

/// Disjoint token estimate buckets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub system_tokens: u64,
    pub message_tokens: u64,
    pub tool_tokens: u64,
    pub protocol_tokens: u64,
    pub total_input_tokens: u64,
}

/// Confidence of the token count used for one admission decision.
///
/// Exact request counts are produced by an endpoint that accepts the same
/// structured request as generation and therefore includes chat templates,
/// tool schemas and protocol framing. Exact tokenizer counts operate on a
/// provider-rendered prompt. Estimated counts are local fallbacks only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenCountAccuracy {
    ExactRequest,
    ExactTokenizer,
    Calibrated,
    #[default]
    Estimated,
}

/// Provider-supplied input count for the complete prepared request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInputTokenCount {
    pub counter: String,
    pub input_tokens: u64,
    pub accuracy: TokenCountAccuracy,
}

impl ProviderInputTokenCount {
    pub fn exact_request(counter: impl Into<String>, input_tokens: u64) -> Self {
        Self {
            counter: counter.into(),
            input_tokens,
            accuracy: TokenCountAccuracy::ExactRequest,
        }
    }
}

impl TokenBreakdown {
    fn recompute_total(&mut self) {
        self.total_input_tokens = self
            .system_tokens
            .saturating_add(self.message_tokens)
            .saturating_add(self.tool_tokens)
            .saturating_add(self.protocol_tokens);
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenMeterError {
    #[error("token meter failed: {0}")]
    Failed(String),
}

/// One tokenizer/estimator implementation. Implementations must return
/// disjoint buckets and a total equal to their saturating sum.
pub trait TokenMeter: Send + Sync + 'static {
    fn id(&self) -> &str;

    fn estimate(&self, request: &TokenEstimateRequest) -> Result<TokenBreakdown, TokenMeterError>;
}

/// Safe fallback: serialized UTF-8 bytes plus explicit message/tool framing.
/// For byte-level BPE families, a token consumes at least one encoded byte;
/// therefore this is deliberately pessimistic rather than falsely precise.
#[derive(Clone, Copy, Debug, Default)]
pub struct ConservativeByteMeter;

impl TokenMeter for ConservativeByteMeter {
    fn id(&self) -> &str {
        "conservative-utf8-json-bytes/v1"
    }

    fn estimate(&self, request: &TokenEstimateRequest) -> Result<TokenBreakdown, TokenMeterError> {
        let mut breakdown = TokenBreakdown {
            system_tokens: encoded_len(&request.system_messages)?,
            message_tokens: encoded_len(&request.conversation_messages)?,
            tool_tokens: encoded_len(&request.tools)?,
            // Account for role/message delimiters and the streaming request
            // envelope even if an adapter's JSON happens to be very compact.
            protocol_tokens: encoded_len(&(&request.provider, &request.model))?
                .saturating_add(32)
                .saturating_add((request.system_messages.len() as u64).saturating_mul(8))
                .saturating_add((request.conversation_messages.len() as u64).saturating_mul(8))
                .saturating_add((request.tools.len() as u64).saturating_mul(12)),
            total_input_tokens: 0,
        };
        breakdown.recompute_total();
        Ok(breakdown)
    }
}

fn encoded_len(value: &impl Serialize) -> Result<u64, TokenMeterError> {
    let len = serde_json::to_vec(value)
        .map_err(|error| TokenMeterError::Failed(error.to_string()))?
        .len();
    Ok(u64::try_from(len).unwrap_or(u64::MAX))
}

/// Hard context admission configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBudget {
    pub context_window_tokens: u64,
    /// Preferred per-request generation ceiling. The guard selects this value
    /// while enough context remains and shrinks it only when doing so avoids an
    /// unnecessary compaction/rejection.
    pub reserved_output_tokens: u64,
    /// Smallest generation region that may be admitted. Requests below this
    /// reserve are rejected so the caller can compact before model I/O.
    pub minimum_output_tokens: u64,
    pub safety_margin_tokens: u64,
}

impl TokenBudget {
    pub fn new(context_window_tokens: u64, reserved_output_tokens: u64) -> Self {
        Self {
            context_window_tokens,
            reserved_output_tokens,
            minimum_output_tokens: reserved_output_tokens,
            safety_margin_tokens: 1_024,
        }
    }

    pub fn validate(&self) -> Result<(), TokenBudgetError> {
        if self.context_window_tokens == 0 {
            return Err(TokenBudgetError::Invalid(
                "context_window_tokens must be greater than zero".to_owned(),
            ));
        }
        if self.reserved_output_tokens == 0 {
            return Err(TokenBudgetError::Invalid(
                "reserved_output_tokens must be greater than zero".to_owned(),
            ));
        }
        if self.minimum_output_tokens == 0 {
            return Err(TokenBudgetError::Invalid(
                "minimum_output_tokens must be greater than zero".to_owned(),
            ));
        }
        if self.minimum_output_tokens > self.reserved_output_tokens {
            return Err(TokenBudgetError::Invalid(format!(
                "minimum output reserve ({}) must not exceed target output ({})",
                self.minimum_output_tokens, self.reserved_output_tokens
            )));
        }
        let reserved = self
            .minimum_output_tokens
            .saturating_add(self.safety_margin_tokens);
        if reserved >= self.context_window_tokens {
            return Err(TokenBudgetError::Invalid(format!(
                "output reserve ({}) plus safety margin ({}) must be smaller than context window ({})",
                self.minimum_output_tokens,
                self.safety_margin_tokens,
                self.context_window_tokens
            )));
        }
        Ok(())
    }

    pub fn available_input_tokens(&self) -> u64 {
        self.context_window_tokens
            .saturating_sub(self.minimum_output_tokens)
            .saturating_sub(self.safety_margin_tokens)
    }

    /// Resolve the largest safe output ceiling for one priced request. The
    /// selected value never exceeds the configured target and never falls
    /// below the minimum reserve accepted by admission.
    pub fn resolve_output_tokens(&self, input_tokens: u64) -> u64 {
        self.reserved_output_tokens.min(
            self.context_window_tokens
                .saturating_sub(input_tokens)
                .saturating_sub(self.safety_margin_tokens),
        )
    }
}

/// Successful budget check recorded beside the prepared request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBudgetReport {
    pub meter: String,
    #[serde(default)]
    pub accuracy: TokenCountAccuracy,
    pub context_window_tokens: u64,
    pub reserved_output_tokens: u64,
    pub minimum_output_tokens: u64,
    pub selected_output_tokens: u64,
    pub safety_margin_tokens: u64,
    pub available_input_tokens: u64,
    pub estimate: TokenBreakdown,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenBudgetError {
    #[error("invalid token budget: {0}")]
    Invalid(String),
    #[error(transparent)]
    Meter(#[from] TokenMeterError),
    #[error(
        "estimated request input ({estimated_input_tokens} tokens) exceeds available input budget ({available_input_tokens}); context={context_window_tokens}, output_reserve={reserved_output_tokens}, safety_margin={safety_margin_tokens}"
    )]
    Exceeded {
        estimated_input_tokens: u64,
        available_input_tokens: u64,
        context_window_tokens: u64,
        reserved_output_tokens: u64,
        minimum_output_tokens: u64,
        safety_margin_tokens: u64,
    },
}

/// Cloneable meter + hard budget supplied to a prepared loop.
#[derive(Clone)]
pub struct TokenGuard {
    meter: Arc<dyn TokenMeter>,
    budget: TokenBudget,
}

impl TokenGuard {
    pub fn new(meter: Arc<dyn TokenMeter>, budget: TokenBudget) -> Result<Self, TokenBudgetError> {
        budget.validate()?;
        Ok(Self { meter, budget })
    }

    pub fn conservative(budget: TokenBudget) -> Result<Self, TokenBudgetError> {
        Self::new(Arc::new(ConservativeByteMeter), budget)
    }

    pub fn check(
        &self,
        request: &TokenEstimateRequest,
    ) -> Result<TokenBudgetReport, TokenBudgetError> {
        let mut estimate = self.meter.estimate(request)?;
        estimate.recompute_total();
        let available_input_tokens = self.budget.available_input_tokens();
        if estimate.total_input_tokens > available_input_tokens {
            return Err(TokenBudgetError::Exceeded {
                estimated_input_tokens: estimate.total_input_tokens,
                available_input_tokens,
                context_window_tokens: self.budget.context_window_tokens,
                reserved_output_tokens: self.budget.minimum_output_tokens,
                minimum_output_tokens: self.budget.minimum_output_tokens,
                safety_margin_tokens: self.budget.safety_margin_tokens,
            });
        }
        Ok(TokenBudgetReport {
            meter: self.meter.id().to_owned(),
            accuracy: TokenCountAccuracy::Estimated,
            context_window_tokens: self.budget.context_window_tokens,
            reserved_output_tokens: self.budget.reserved_output_tokens,
            minimum_output_tokens: self.budget.minimum_output_tokens,
            selected_output_tokens: self
                .budget
                .resolve_output_tokens(estimate.total_input_tokens),
            safety_margin_tokens: self.budget.safety_margin_tokens,
            available_input_tokens,
            estimate,
        })
    }

    /// Enforce the same hard budget using a count supplied by the selected
    /// provider. The total is exact even though a provider count endpoint does
    /// not expose the system/message/tool bucket breakdown; it is placed in
    /// `message_tokens` so the disjoint-total invariant remains true.
    pub fn check_provider_count(
        &self,
        count: &ProviderInputTokenCount,
    ) -> Result<TokenBudgetReport, TokenBudgetError> {
        let estimate = TokenBreakdown {
            message_tokens: count.input_tokens,
            total_input_tokens: count.input_tokens,
            ..TokenBreakdown::default()
        };
        let available_input_tokens = self.budget.available_input_tokens();
        if count.input_tokens > available_input_tokens {
            return Err(TokenBudgetError::Exceeded {
                estimated_input_tokens: count.input_tokens,
                available_input_tokens,
                context_window_tokens: self.budget.context_window_tokens,
                reserved_output_tokens: self.budget.minimum_output_tokens,
                minimum_output_tokens: self.budget.minimum_output_tokens,
                safety_margin_tokens: self.budget.safety_margin_tokens,
            });
        }
        Ok(TokenBudgetReport {
            meter: count.counter.clone(),
            accuracy: count.accuracy,
            context_window_tokens: self.budget.context_window_tokens,
            reserved_output_tokens: self.budget.reserved_output_tokens,
            minimum_output_tokens: self.budget.minimum_output_tokens,
            selected_output_tokens: self.budget.resolve_output_tokens(count.input_tokens),
            safety_margin_tokens: self.budget.safety_margin_tokens,
            available_input_tokens,
            estimate,
        })
    }

    pub fn budget(&self) -> &TokenBudget {
        &self.budget
    }

    /// Bind the same meter and output policy to a smaller session-selected
    /// context window. The provider/deployment maximum is validated by the
    /// caller; this method only enforces the budget's internal safety rules.
    pub fn with_context_window(
        &self,
        context_window_tokens: u64,
    ) -> Result<Self, TokenBudgetError> {
        let mut budget = self.budget.clone();
        budget.context_window_tokens = context_window_tokens;
        Self::new(Arc::clone(&self.meter), budget)
    }
}

impl fmt::Debug for TokenGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenGuard")
            .field("meter", &self.meter.id())
            .field("budget", &self.budget)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conservative_meter_is_deterministic_and_reports_disjoint_buckets() {
        let request = TokenEstimateRequest {
            provider: "p".to_owned(),
            model: Some("m".to_owned()),
            system_messages: vec![json!({"role":"system","content":"规则"})],
            conversation_messages: vec![json!({"role":"user","content":"hello"})],
            tools: vec![json!({"name":"read","parameters":{"type":"object"}})],
        };
        let first = ConservativeByteMeter.estimate(&request).unwrap();
        let second = ConservativeByteMeter.estimate(&request).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.total_input_tokens,
            first
                .system_tokens
                .saturating_add(first.message_tokens)
                .saturating_add(first.tool_tokens)
                .saturating_add(first.protocol_tokens)
        );
    }

    #[test]
    fn budget_rejects_before_the_reserved_output_region() {
        let guard = TokenGuard::conservative(TokenBudget {
            context_window_tokens: 256,
            reserved_output_tokens: 64,
            minimum_output_tokens: 64,
            safety_margin_tokens: 32,
        })
        .unwrap();
        let error = guard
            .check(&TokenEstimateRequest {
                conversation_messages: vec![json!({"content":"x".repeat(300)})],
                ..TokenEstimateRequest::default()
            })
            .unwrap_err();
        assert!(matches!(error, TokenBudgetError::Exceeded { .. }));
    }

    #[test]
    fn invalid_budget_is_rejected_when_the_guard_is_constructed() {
        let error = TokenGuard::conservative(TokenBudget {
            context_window_tokens: 4_096,
            reserved_output_tokens: 4_096,
            minimum_output_tokens: 4_096,
            safety_margin_tokens: 0,
        })
        .unwrap_err();
        assert!(matches!(error, TokenBudgetError::Invalid(_)));
    }

    #[test]
    fn session_context_window_reuses_the_meter_and_preserves_output_policy() {
        let guard = TokenGuard::conservative(TokenBudget {
            context_window_tokens: 65_536,
            reserved_output_tokens: 8_192,
            minimum_output_tokens: 4_096,
            safety_margin_tokens: 1_024,
        })
        .unwrap();

        let selected = guard.with_context_window(32_768).unwrap();
        assert_eq!(guard.budget().context_window_tokens, 65_536);
        assert_eq!(selected.budget().context_window_tokens, 32_768);
        assert_eq!(selected.budget().reserved_output_tokens, 8_192);
        assert_eq!(selected.budget().minimum_output_tokens, 4_096);
        assert_eq!(selected.budget().safety_margin_tokens, 1_024);

        let error = guard.with_context_window(5_120).unwrap_err();
        assert!(matches!(error, TokenBudgetError::Invalid(_)));
    }

    #[test]
    fn provider_exact_count_overrides_the_local_estimator() {
        let guard = TokenGuard::new(
            Arc::new(ConservativeByteMeter),
            TokenBudget {
                context_window_tokens: 262_144,
                reserved_output_tokens: 8_192,
                minimum_output_tokens: 8_192,
                safety_margin_tokens: 2_048,
            },
        )
        .unwrap();
        let report = guard
            .check_provider_count(&ProviderInputTokenCount::exact_request(
                "openai/chat-input-tokens/v1",
                70_857,
            ))
            .unwrap();
        assert_eq!(report.meter, "openai/chat-input-tokens/v1");
        assert_eq!(report.accuracy, TokenCountAccuracy::ExactRequest);
        assert_eq!(report.estimate.message_tokens, 70_857);
        assert_eq!(report.estimate.total_input_tokens, 70_857);
        assert_eq!(report.available_input_tokens, 251_904);
    }

    #[test]
    fn adaptive_output_uses_target_when_room_exists_and_shrinks_to_the_safe_remainder() {
        let guard = TokenGuard::new(
            Arc::new(ConservativeByteMeter),
            TokenBudget {
                context_window_tokens: 262_144,
                reserved_output_tokens: 49_152,
                minimum_output_tokens: 16_384,
                safety_margin_tokens: 4_096,
            },
        )
        .unwrap();

        let roomy = guard
            .check_provider_count(&ProviderInputTokenCount::exact_request("exact", 100_000))
            .unwrap();
        assert_eq!(roomy.selected_output_tokens, 49_152);
        assert_eq!(roomy.available_input_tokens, 241_664);

        let pressured = guard
            .check_provider_count(&ProviderInputTokenCount::exact_request("exact", 220_000))
            .unwrap();
        assert_eq!(pressured.selected_output_tokens, 38_048);
        assert!(pressured.selected_output_tokens >= pressured.minimum_output_tokens);
    }

    #[test]
    fn adaptive_output_rejects_before_falling_below_the_minimum_reserve() {
        let guard = TokenGuard::new(
            Arc::new(ConservativeByteMeter),
            TokenBudget {
                context_window_tokens: 262_144,
                reserved_output_tokens: 49_152,
                minimum_output_tokens: 16_384,
                safety_margin_tokens: 4_096,
            },
        )
        .unwrap();
        let error = guard
            .check_provider_count(&ProviderInputTokenCount::exact_request("exact", 242_000))
            .unwrap_err();
        assert!(matches!(error, TokenBudgetError::Exceeded { .. }));
    }
}
