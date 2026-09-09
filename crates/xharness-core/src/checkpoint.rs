use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use xharness_session::{ExecutionCheckpointState as State, ExecutionNotice, RepetitionState};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CheckpointConfig {
    pub interval_steps: usize,
    pub notice_steps: usize,
    pub repeat_error_threshold: usize,
    pub repeat_success_threshold: usize,
}
impl Default for CheckpointConfig {
    fn default() -> Self {
        Self {
            interval_steps: 1024,
            notice_steps: 64,
            repeat_error_threshold: 3,
            repeat_success_threshold: 5,
        }
    }
}
impl CheckpointConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.interval_steps < 2
            || self.notice_steps == 0
            || self.notice_steps >= self.interval_steps
            || self.repeat_error_threshold < 2
            || self.repeat_success_threshold < 2
        {
            return Err(
                "invalid execution checkpoint interval, advance notice, or repetition threshold"
                    .into(),
            );
        }
        Ok(())
    }
    pub(crate) fn initial(&self) -> State {
        State {
            phase: 1,
            phase_end_step: self.interval_steps,
            stage_pending: false,
            repetition: RepetitionState::default(),
            pending_notice: None,
            pending_repetitions: Vec::new(),
        }
    }
}
fn canonical(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let sorted: std::collections::BTreeMap<_, _> =
                m.into_iter().map(|(k, v)| (k, canonical(v))).collect();
            serde_json::to_value(sorted).expect("JSON map")
        }
        serde_json::Value::Array(a) => a.into_iter().map(canonical).collect(),
        v => v,
    }
}
/// Consecutive exact observations, not an LRU cache or a semantic loop detector.
/// Hash complete raw result content before model-facing truncation; metadata IDs/timings are omitted.
#[allow(clippy::too_many_arguments)] // One complete tool observation; deliberately no scheduler state.
pub(crate) fn observe(
    state: &mut State,
    cfg: &CheckpointConfig,
    name: &str,
    args: &str,
    ok: bool,
    content: &str,
    error: &str,
    reliable: bool,
) {
    if !reliable {
        state.repetition = RepetitionState::default();
        return;
    }
    let arguments = serde_json::from_str(args)
        .map(canonical)
        .unwrap_or_else(|_| serde_json::Value::String(args.into()));
    let mut h = Sha256::new();
    for bytes in [
        name.as_bytes(),
        serde_json::to_vec(&arguments).unwrap().as_slice(),
        if ok { b"ok" } else { b"error" },
        content.as_bytes(),
        error.as_bytes(),
    ] {
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    }
    let fingerprint = format!("{:x}", h.finalize());
    let r = &mut state.repetition;
    if r.fingerprint == fingerprint {
        r.count = r.count.saturating_add(1);
    } else {
        *r = RepetitionState {
            fingerprint,
            count: 1,
            warned: false,
        };
    }
    if !r.warned
        && r.count
            >= if ok {
                cfg.repeat_success_threshold
            } else {
                cfg.repeat_error_threshold
            }
    {
        r.warned = true;
        if state.pending_repetitions.len() < 16 {
            state.pending_repetitions.push(format!("工具 {name} 的相同参数连续 {} 次返回相同{}（指纹 {}）。请检查原因或调整方法；必要的重复仍可继续。",r.count,if ok {"结果"} else {"错误"},&r.fingerprint[..12]));
        }
    }
}
pub(crate) fn issue(
    state: &mut State,
    cfg: &CheckpointConfig,
    step: usize,
    hard: usize,
) -> Option<ExecutionNotice> {
    if state.pending_notice.is_some() {
        return None;
    }
    let limit = state.phase_end_step.min(hard);
    let stage = !state.stage_pending && step >= limit.saturating_sub(cfg.notice_steps);
    if !stage && state.pending_repetitions.is_empty() {
        return None;
    }
    let mut lines = vec!["[Harness 执行检查点]".to_string()];
    if stage {
        state.stage_pending = true;
        lines.push(format!("截至此检查点已完成 {step} 步，当前阶段位置 {limit} 步。任务未完成且有明确下一步，请继续使用现有工具；系统会进入下一阶段。已完成请给出最终结果，缺少必要信息请提问。不要仅因检查点而结束。"));
        if hard != usize::MAX {
            lines.push(format!(
                "用户设置的累计硬上限为 {hard} 步，自动续行不能突破它。"
            ));
        }
    }
    lines.append(&mut state.pending_repetitions);
    let message = lines.join("\n");
    state.pending_notice = Some(message.clone());
    Some(notice(state, step, hard, "issued", message))
}
pub(crate) fn consume(
    state: &mut State,
    cfg: &CheckpointConfig,
    step: usize,
    hard: usize,
    tools: bool,
) -> Option<ExecutionNotice> {
    state.pending_notice.take()?;
    if !state.stage_pending {
        return None;
    }
    if !tools {
        // A complete answer normally ends the turn, but admitted steering may
        // keep this run alive. Allow its next boundary to reconsider the stage.
        state.stage_pending = false;
        return None;
    }
    if state.phase_end_step >= hard {
        return None;
    }
    state.stage_pending = false;
    state.phase_end_step = state
        .phase_end_step
        .saturating_add(cfg.interval_steps)
        .min(hard);
    state.phase = state.phase.saturating_add(1);
    Some(notice(
        state,
        step,
        hard,
        "continued",
        format!(
            "模型继续使用工具，已进入执行阶段 {}；阶段位置 {} 步。",
            state.phase, state.phase_end_step
        ),
    ))
}
fn notice(s: &State, step: usize, hard: usize, kind: &str, message: String) -> ExecutionNotice {
    ExecutionNotice {
        kind: kind.into(),
        message,
        phase: s.phase,
        steps_completed: step,
        phase_end_step: s.phase_end_step,
        hard_max_steps: (hard != usize::MAX).then_some(hard),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> CheckpointConfig {
        CheckpointConfig {
            interval_steps: 10,
            notice_steps: 2,
            ..Default::default()
        }
    }
    #[test]
    fn phase_notice_is_once_combines_repetition_and_extends_without_new_tool() {
        let c = config();
        let mut s = c.initial();
        for _ in 0..3 {
            observe(
                &mut s,
                &c,
                "read",
                r#"{"b":2,"a":1}"#,
                false,
                "",
                "missing",
                true,
            );
        }
        assert!(issue(&mut s, &c, 8, usize::MAX)
            .unwrap()
            .message
            .contains("连续 3 次"));
        assert!(issue(&mut s, &c, 8, usize::MAX).is_none());
        assert!(s.pending_repetitions.is_empty());
        let restored: State = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(s, restored);
        assert_eq!(consume(&mut s, &c, 9, usize::MAX, true).unwrap().phase, 2);
        assert!(s.pending_notice.is_none());
        assert!(issue(&mut s, &c, 9, usize::MAX).is_none());
    }
    #[test]
    fn canonical_args_thresholds_and_streak_reset() {
        let c = config();
        let mut s = c.initial();
        for i in 0..9 {
            observe(
                &mut s,
                &c,
                "read",
                if i % 2 == 0 {
                    r#"{"b":2,"a":1}"#
                } else {
                    r#"{"a":1,"b":2}"#
                },
                true,
                "ok",
                "",
                true,
            );
        }
        assert_eq!(s.pending_repetitions.len(), 1);
        assert_eq!(s.repetition.count, 9);
        assert!(!serde_json::to_string(&s).unwrap().contains("\"a\""));
        observe(&mut s, &c, "read", "{}", true, "different", "", true);
        assert_eq!(s.repetition.count, 1);
        observe(&mut s, &c, "read", "{}", true, "different", "", false);
        assert_eq!(s.repetition.count, 0);
    }
    #[test]
    fn hard_limit_never_extended_and_not_rewarned_each_step() {
        let c = config();
        let mut s = c.initial();
        issue(&mut s, &c, 7, 9).unwrap();
        assert!(consume(&mut s, &c, 8, 9, true).is_none());
        assert!(issue(&mut s, &c, 8, 9).is_none());
        assert_eq!(s.phase, 1);
    }
    #[test]
    fn final_answer_does_not_extend_and_defaults_are_valid() {
        let c = config();
        let mut s = c.initial();
        issue(&mut s, &c, 8, usize::MAX).unwrap();
        assert!(consume(&mut s, &c, 9, usize::MAX, false).is_none());
        assert_eq!(s.phase, 1);
        assert!(!s.stage_pending);
        assert!(s.pending_notice.is_none());
        assert!(issue(&mut s, &c, 9, usize::MAX).is_some());
        assert!(CheckpointConfig::default().validate().is_ok());
        assert!(CheckpointConfig {
            notice_steps: 1024,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
