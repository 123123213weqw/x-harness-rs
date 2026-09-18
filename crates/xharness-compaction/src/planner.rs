use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{CompactionConfig, CompactionError, CompactionSpec, ModelTarget};

/// Why one compaction decision is being made.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    /// Normal between-step pressure check.
    Pressure,
    /// Typed provider context-window overflow recovery.
    ContextOverflow,
    /// Explicit user/host request.
    Manual,
}

/// Provider-neutral surface semantics needed to preserve tool-call/result
/// pairs across a replacement boundary.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurfaceNodeKind {
    Plain,
    AssistantToolCalls { call_ids: Vec<String> },
    ToolResult { call_id: String },
}

/// One priced current-surface node. `seq` is the durable source event
/// coordinate; `tokens` is supplied by the selected model's meter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceNode {
    pub seq: u64,
    pub tokens: u64,
    pub kind: SurfaceNodeKind,
}

impl SurfaceNode {
    pub const fn plain(seq: u64, tokens: u64) -> Self {
        Self {
            seq,
            tokens,
            kind: SurfaceNodeKind::Plain,
        }
    }

    pub fn assistant_tool_calls<I, S>(seq: u64, tokens: u64, call_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            seq,
            tokens,
            kind: SurfaceNodeKind::AssistantToolCalls {
                call_ids: call_ids.into_iter().map(Into::into).collect(),
            },
        }
    }

    pub fn tool_result(seq: u64, tokens: u64, call_id: impl Into<String>) -> Self {
        Self {
            seq,
            tokens,
            kind: SurfaceNodeKind::ToolResult {
                call_id: call_id.into(),
            },
        }
    }
}

/// Complete pressure input. The total includes system, tools and protocol;
/// individual nodes price only the replaceable session surface.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRequest {
    pub trigger: CompactionTrigger,
    pub target: ModelTarget,
    pub context_window_tokens: u64,
    pub current_input_tokens: u64,
    pub surface_generation: u64,
    pub nodes: Vec<SurfaceNode>,
}

/// Inclusive durable coordinates plus positional and price evidence for one
/// head-anchored replacement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRange {
    pub start_seq: u64,
    pub end_seq: u64,
    pub start_index: usize,
    pub end_index: usize,
    pub shadowed_seqs: Vec<u64>,
    pub shadowed_token_count: u64,
    pub retained_token_count: u64,
}

/// Immutable work item passed to the durable compaction transaction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPlan {
    pub trigger: CompactionTrigger,
    pub surface_generation: u64,
    pub spec: CompactionSpec,
    pub range: CompactionRange,
    /// First attempt plus configured retries.
    pub max_summary_attempts: u32,
}

/// Pure planner result; no session or provider state has changed yet.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompactionDecision {
    Disabled,
    NotNeeded {
        current_input_tokens: u64,
        threshold_tokens: u64,
    },
    NoBalancedRange {
        retain_tokens: u64,
    },
    Planned {
        plan: Box<CompactionPlan>,
    },
}

/// Baseline-compatible default pressure planner, expressed without depending
/// on a concrete provider, tokenizer, agent or session store.
#[derive(Clone, Debug)]
pub struct BasicCompactionPlanner {
    config: CompactionConfig,
}

impl BasicCompactionPlanner {
    pub fn new(config: CompactionConfig) -> Result<Self, CompactionError> {
        config.validate()?;
        Ok(Self { config })
    }

    pub fn config(&self) -> &CompactionConfig {
        &self.config
    }

    pub fn plan(&self, request: &CompactionRequest) -> Result<CompactionDecision, CompactionError> {
        self.plan_with_input_budget(request, None, 0)
    }

    /// Pressure is bounded by the actual input region, not only total context.
    /// Reserve 5–20% of that region, responding to the largest recent step growth.
    pub fn plan_with_input_budget(
        &self,
        request: &CompactionRequest,
        available_input_tokens: Option<u64>,
        recent_growth: u64,
    ) -> Result<CompactionDecision, CompactionError> {
        let mut spec = self
            .config
            .resolve(request.target.clone(), request.context_window_tokens)?;
        if let Some(available) = available_input_tokens {
            let floor = (available / 20).max(1);
            let ceiling = (available / 5).max(floor);
            let buffer = recent_growth.saturating_mul(2).clamp(floor, ceiling);
            spec.threshold_tokens = spec.threshold_tokens.min(available.saturating_sub(buffer));
        }
        if request.trigger == CompactionTrigger::Pressure && !self.config.auto {
            return Ok(CompactionDecision::Disabled);
        }
        if request.trigger == CompactionTrigger::Pressure
            && request.current_input_tokens < spec.threshold_tokens
        {
            return Ok(CompactionDecision::NotNeeded {
                current_input_tokens: request.current_input_tokens,
                threshold_tokens: spec.threshold_tokens,
            });
        }

        // Canonical overflow recovery deliberately bypasses normal retention;
        // the range selector still retains one indivisible balanced tail.
        let retain_tokens = if request.trigger == CompactionTrigger::ContextOverflow {
            0
        } else {
            spec.retain_tokens
        };
        let Some(range) = select_compactable_range(&request.nodes, retain_tokens)? else {
            return Ok(CompactionDecision::NoBalancedRange { retain_tokens });
        };
        let max_summary_attempts = spec.compaction_retries.saturating_add(1);
        Ok(CompactionDecision::Planned {
            plan: Box::new(CompactionPlan {
                trigger: request.trigger,
                surface_generation: request.surface_generation,
                spec,
                range,
                max_summary_attempts,
            }),
        })
    }
}

/// Select the largest safe head prefix while keeping at least the requested
/// recent-tail price. A boundary is safe only when every earlier assistant
/// tool call already has its corresponding tool result.
pub fn select_compactable_range(
    nodes: &[SurfaceNode],
    retain_tokens: u64,
) -> Result<Option<CompactionRange>, CompactionError> {
    if nodes.is_empty() {
        return Ok(None);
    }
    let balanced_before = validate_and_price_boundaries(nodes)?;
    let mut accumulated = 0u64;
    let mut keep_from_index = nodes.len();
    for index in (0..nodes.len()).rev() {
        accumulated = accumulated.saturating_add(nodes[index].tokens);
        keep_from_index = index;
        if accumulated >= retain_tokens {
            break;
        }
    }
    if keep_from_index == 0 {
        return Ok(None);
    }
    while keep_from_index > 0 && !balanced_before[keep_from_index] {
        keep_from_index -= 1;
    }
    if keep_from_index == 0 {
        return Ok(None);
    }

    let shadowed = &nodes[..keep_from_index];
    let retained = &nodes[keep_from_index..];
    Ok(Some(CompactionRange {
        start_seq: shadowed[0].seq,
        end_seq: shadowed[shadowed.len() - 1].seq,
        start_index: 0,
        end_index: shadowed.len() - 1,
        shadowed_seqs: shadowed.iter().map(|node| node.seq).collect(),
        shadowed_token_count: sum_tokens(shadowed),
        retained_token_count: sum_tokens(retained),
    }))
}

fn validate_and_price_boundaries(nodes: &[SurfaceNode]) -> Result<Vec<bool>, CompactionError> {
    let mut pending = HashSet::new();
    let mut seen = HashSet::new();
    let mut seen_seqs = HashSet::new();
    let mut balanced_before = Vec::with_capacity(nodes.len() + 1);
    balanced_before.push(true);

    for (index, node) in nodes.iter().enumerate() {
        if !seen_seqs.insert(node.seq) {
            return Err(CompactionError::invalid_surface(format!(
                "surface seq {} at index {index} is duplicated",
                node.seq
            )));
        }
        match &node.kind {
            SurfaceNodeKind::Plain => {}
            SurfaceNodeKind::AssistantToolCalls { call_ids } => {
                if call_ids.is_empty() {
                    return Err(CompactionError::invalid_surface(format!(
                        "assistant tool-call node {} has no call ids",
                        node.seq
                    )));
                }
                for call_id in call_ids {
                    if call_id.trim().is_empty() {
                        return Err(CompactionError::invalid_surface(format!(
                            "assistant tool-call node {} has an empty call id",
                            node.seq
                        )));
                    }
                    if !seen.insert(call_id.clone()) {
                        return Err(CompactionError::invalid_surface(format!(
                            "duplicate tool call id {call_id:?} on current surface"
                        )));
                    }
                    pending.insert(call_id.clone());
                }
            }
            SurfaceNodeKind::ToolResult { call_id } => {
                if call_id.trim().is_empty() {
                    return Err(CompactionError::invalid_surface(format!(
                        "tool-result node {} has an empty call id",
                        node.seq
                    )));
                }
                if !pending.remove(call_id) {
                    return Err(CompactionError::invalid_surface(format!(
                        "tool-result node {} has no earlier unmatched call {call_id:?}",
                        node.seq
                    )));
                }
            }
        }
        balanced_before.push(pending.is_empty());
    }
    Ok(balanced_before)
}

fn sum_tokens(nodes: &[SurfaceNode]) -> u64 {
    nodes
        .iter()
        .fold(0u64, |total, node| total.saturating_add(node.tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_waits_for_default_pressure_threshold() {
        let planner = BasicCompactionPlanner::new(CompactionConfig::default()).unwrap();
        let request = CompactionRequest {
            trigger: CompactionTrigger::Pressure,
            target: ModelTarget::new("openai", "qwen"),
            context_window_tokens: 53_248,
            current_input_tokens: 42_597,
            surface_generation: 7,
            nodes: vec![SurfaceNode::plain(1, 10), SurfaceNode::plain(2, 10)],
        };
        assert!(matches!(
            planner.plan(&request).unwrap(),
            CompactionDecision::NotNeeded {
                threshold_tokens: 42_598,
                ..
            }
        ));
    }

    #[test]
    fn range_keeps_recent_tail_and_never_splits_tool_pair() {
        let nodes = vec![
            SurfaceNode::plain(10, 100),
            SurfaceNode::assistant_tool_calls(11, 5, ["call-1"]),
            SurfaceNode::tool_result(12, 5, "call-1"),
            SurfaceNode::plain(13, 100),
        ];
        let range = select_compactable_range(&nodes, 105).unwrap().unwrap();
        // A naive token cut would start the retained tail at the tool result.
        // The balanced cut moves backward and retains assistant+result together.
        assert_eq!(range.shadowed_seqs, vec![10]);
        assert_eq!(range.retained_token_count, 110);
    }

    #[test]
    fn overflow_bypasses_threshold_and_normal_retention() {
        let planner = BasicCompactionPlanner::new(CompactionConfig::default()).unwrap();
        let decision = planner
            .plan(&CompactionRequest {
                trigger: CompactionTrigger::ContextOverflow,
                target: ModelTarget::new("openai", "qwen"),
                context_window_tokens: 53_248,
                current_input_tokens: 1,
                surface_generation: 9,
                nodes: vec![
                    SurfaceNode::plain(1, 10),
                    SurfaceNode::plain(2, 20),
                    SurfaceNode::plain(3, 30),
                ],
            })
            .unwrap();
        let CompactionDecision::Planned { plan } = decision else {
            panic!("expected a plan");
        };
        assert_eq!(plan.range.shadowed_seqs, vec![1, 2]);
        assert_eq!(plan.range.retained_token_count, 30);
        assert_eq!(plan.max_summary_attempts, 2);
    }

    #[test]
    fn no_range_is_returned_when_only_cut_would_split_a_pair() {
        let nodes = vec![
            SurfaceNode::assistant_tool_calls(1, 10, ["call-1"]),
            SurfaceNode::tool_result(2, 10, "call-1"),
        ];
        assert_eq!(select_compactable_range(&nodes, 1).unwrap(), None);
    }

    #[test]
    fn orphan_result_and_duplicate_call_fail_closed() {
        assert!(select_compactable_range(&[SurfaceNode::tool_result(1, 1, "missing")], 0).is_err());
        let duplicate = vec![
            SurfaceNode::assistant_tool_calls(1, 1, ["same"]),
            SurfaceNode::assistant_tool_calls(2, 1, ["same"]),
        ];
        assert!(select_compactable_range(&duplicate, 0).is_err());
    }
    #[test]
    fn pressure_tracks_usable_budget_and_bounded_growth_not_total_capacity() {
        let planner = BasicCompactionPlanner::new(CompactionConfig::default()).unwrap();
        let request = CompactionRequest {
            trigger: CompactionTrigger::Pressure,
            target: ModelTarget::new("test", "model"),
            context_window_tokens: 262_144,
            current_input_tokens: 199_000,
            surface_generation: 1,
            nodes: vec![
                SurfaceNode::plain(1, 180_000),
                SurfaceNode::plain(2, 45_000),
            ],
        };
        assert!(matches!(
            planner
                .plan_with_input_budget(&request, Some(211_968), 0)
                .unwrap(),
            CompactionDecision::NotNeeded {
                threshold_tokens: 201_370,
                ..
            }
        ));
        let CompactionDecision::Planned { plan } = planner
            .plan_with_input_budget(&request, Some(211_968), 8_000)
            .unwrap()
        else {
            panic!("growth buffer must trigger")
        };
        assert_eq!(plan.spec.threshold_tokens, 195_968);
        let CompactionDecision::Planned { plan } = planner
            .plan_with_input_budget(&request, Some(211_968), u64::MAX)
            .unwrap()
        else {
            panic!("must trigger")
        };
        assert_eq!(plan.spec.threshold_tokens, 169_575);
    }
    #[test]
    fn pressure_boundary_matrix_is_monotone_and_leaves_headroom() {
        let planner = BasicCompactionPlanner::new(CompactionConfig {
            retain_ratio: None,
            retain_tokens: Some(0),
            ..CompactionConfig::default()
        })
        .unwrap();
        for capacity in [1024, 4096, 16384, 53248, 262144, 1048576] {
            for available in [1, 20, capacity / 4, capacity / 2, capacity - 1] {
                let mut previous = u64::MAX;
                for growth in [0, 1, 10, available / 10, available, u64::MAX] {
                    let minimum = (available / 20).max(1);
                    let maximum = (available / 5).max(minimum);
                    let buffer = (u128::from(growth) * 2)
                        .clamp(u128::from(minimum), u128::from(maximum))
                        as u64;
                    let expected = ((capacity as f64 * 0.8).floor() as u64)
                        .min(available.saturating_sub(buffer));
                    // The growth list isn't sorted for tiny budgets; test monotonicity separately below.
                    for input in [expected.saturating_sub(1), expected, expected + 1] {
                        let request = CompactionRequest {
                            trigger: CompactionTrigger::Pressure,
                            target: ModelTarget::new("matrix", "route"),
                            context_window_tokens: capacity,
                            current_input_tokens: input,
                            surface_generation: 42,
                            nodes: vec![SurfaceNode::plain(1, 1), SurfaceNode::plain(2, 1)],
                        };
                        let result = planner
                            .plan_with_input_budget(&request, Some(available), growth)
                            .unwrap();
                        if input < expected {
                            assert!(
                                matches!(result, CompactionDecision::NotNeeded { threshold_tokens, .. } if threshold_tokens == expected)
                            );
                        } else {
                            let CompactionDecision::Planned { plan } = result else {
                                panic!("expected plan")
                            };
                            assert_eq!(plan.spec.threshold_tokens, expected);
                            assert_eq!(plan.surface_generation, 42);
                            assert_eq!(plan.range.shadowed_seqs, vec![1]);
                        }
                    }
                    if growth == 0 || growth >= available {
                        assert!(expected <= previous);
                        previous = expected;
                    }
                    assert!(expected < available);
                }
            }
        }
    }

    #[test]
    fn seeded_multi_tool_ranges_never_cut_unresolved_calls() {
        let mut seed = 0x5848_504cu64;
        for case in 0..512 {
            let mut next = || {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                seed
            };
            let mut nodes = vec![SurfaceNode::plain(1, next() % 100)];
            let mut safe_cuts = vec![1usize];
            for batch in 0..(1 + case % 12) {
                let count = 1 + next() % 8;
                let ids = (0..count)
                    .map(|i| format!("{case}-{batch}-{i}"))
                    .collect::<Vec<_>>();
                nodes.push(SurfaceNode::assistant_tool_calls(
                    nodes.len() as u64 + 1,
                    next() % 100,
                    ids.clone(),
                ));
                // Results can arrive in reverse completion order.
                for id in ids.into_iter().rev() {
                    nodes.push(SurfaceNode::tool_result(
                        nodes.len() as u64 + 1,
                        next() % 100,
                        id,
                    ));
                }
                safe_cuts.push(nodes.len());
            }
            nodes.push(SurfaceNode::plain(nodes.len() as u64 + 1, next() % 100));
            let total = nodes.iter().map(|n| n.tokens).sum::<u64>();
            for retain in [0, 1, total / 2, total, u64::MAX] {
                if let Some(range) = select_compactable_range(&nodes, retain).unwrap() {
                    let cut = range.end_index + 1;
                    assert!(safe_cuts.contains(&cut));
                    assert!(cut < nodes.len(), "must retain a tail");
                    assert_eq!(
                        range.shadowed_seqs,
                        nodes[..cut].iter().map(|n| n.seq).collect::<Vec<_>>()
                    );
                    assert_eq!(
                        range.shadowed_token_count + range.retained_token_count,
                        total
                    );
                    assert!(range.retained_token_count >= retain);
                }
            }
            let mut corrupt = nodes.clone();
            corrupt.last_mut().unwrap().seq = nodes[0].seq;
            assert!(select_compactable_range(&corrupt, 0).is_err());
            let mut corrupt = nodes;
            corrupt.insert(0, SurfaceNode::tool_result(u64::MAX, 0, "orphan"));
            assert!(select_compactable_range(&corrupt, 0).is_err());
        }
    }
}
