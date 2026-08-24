use serde::{Deserialize, Serialize};

use crate::CompactionError;

pub const DEFAULT_TOOL_RESULT_THRESHOLD_CHARS: usize = 8_192;
pub const DEFAULT_HEAD_CHARS: usize = 4_096;
pub const DEFAULT_TAIL_CHARS: usize = 1_024;
pub const PRUNE_MARKER: &str = "\n\n[... tool result middle pruned ...]\n\n";

/// Unicode-code-point budgets for deterministic, model-free old tool-result
/// pruning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolResultPrunerConfig {
    pub threshold_chars: usize,
    pub head_chars: usize,
    pub tail_chars: usize,
}

impl Default for ToolResultPrunerConfig {
    fn default() -> Self {
        Self {
            threshold_chars: DEFAULT_TOOL_RESULT_THRESHOLD_CHARS,
            head_chars: DEFAULT_HEAD_CHARS,
            tail_chars: DEFAULT_TAIL_CHARS,
        }
    }
}

impl ToolResultPrunerConfig {
    pub fn validate(&self) -> Result<(), CompactionError> {
        if self.threshold_chars == 0 {
            return Err(CompactionError::invalid_config(
                "ToolResultPrunerConfig.thresholdChars must be greater than zero",
            ));
        }
        let emitted_chars = self
            .head_chars
            .saturating_add(PRUNE_MARKER.chars().count())
            .saturating_add(self.tail_chars);
        if emitted_chars > self.threshold_chars {
            return Err(CompactionError::invalid_config(format!(
                "headChars + marker + tailChars ({emitted_chars}) must not exceed thresholdChars ({})",
                self.threshold_chars
            )));
        }
        Ok(())
    }
}

/// Complete accounting for one deterministic text replacement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunedText {
    pub text: String,
    pub chars_before: usize,
    pub chars_after: usize,
    pub chars_removed: usize,
}

#[derive(Clone, Debug)]
pub struct ToolResultPruner {
    config: ToolResultPrunerConfig,
}

impl ToolResultPruner {
    pub fn new(config: ToolResultPrunerConfig) -> Result<Self, CompactionError> {
        config.validate()?;
        Ok(Self { config })
    }

    pub fn config(&self) -> &ToolResultPrunerConfig {
        &self.config
    }

    /// Prune by Unicode scalar values. UTF-8 is never split; grapheme clusters
    /// may still be split, matching the provider-neutral character contract.
    pub fn prune(&self, text: &str) -> Option<PrunedText> {
        let chars_before = text.chars().count();
        if chars_before <= self.config.threshold_chars {
            return None;
        }

        let head: String = text.chars().take(self.config.head_chars).collect();
        let mut tail: Vec<char> = text.chars().rev().take(self.config.tail_chars).collect();
        tail.reverse();
        let tail: String = tail.into_iter().collect();
        let pruned = format!("{head}{PRUNE_MARKER}{tail}");
        let chars_after = pruned.chars().count();
        debug_assert!(chars_after <= self.config.threshold_chars);
        debug_assert!(chars_after < chars_before);
        Some(PrunedText {
            text: pruned,
            chars_before,
            chars_after,
            chars_removed: chars_before - chars_after,
        })
    }
}

impl Default for ToolResultPruner {
    fn default() -> Self {
        Self::new(ToolResultPrunerConfig::default())
            .expect("built-in tool-result pruner defaults must be valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_deepseek_tool_result_pruner() {
        let config = ToolResultPrunerConfig::default();
        assert_eq!(config.threshold_chars, 8_192);
        assert_eq!(config.head_chars, 4_096);
        assert_eq!(config.tail_chars, 1_024);
        config.validate().unwrap();
    }

    #[test]
    fn pruning_is_unicode_safe_deterministic_and_idempotent() {
        let pruner = ToolResultPruner::new(ToolResultPrunerConfig {
            threshold_chars: 16,
            head_chars: 3,
            tail_chars: 2,
        });
        assert!(pruner.is_err(), "marker itself does not fit this budget");

        let marker_chars = PRUNE_MARKER.chars().count();
        let pruner = ToolResultPruner::new(ToolResultPrunerConfig {
            threshold_chars: marker_chars + 5,
            head_chars: 3,
            tail_chars: 2,
        })
        .unwrap();
        let source = format!("甲乙😀{}终点", "中".repeat(marker_chars + 8));
        let first = pruner.prune(&source).unwrap();
        assert!(first.text.starts_with("甲乙😀"));
        assert!(first.text.ends_with("终点"));
        assert_eq!(first.chars_after, marker_chars + 5);
        assert_eq!(pruner.prune(&first.text), None);
        assert_eq!(pruner.prune(&source), Some(first));
    }
}
