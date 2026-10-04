use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobContinuationState {
    Registered,
    Settled,
    Delivered,
    Cancelled,
}

/// Control-plane fact, excluded from the model transcript. Owner is the journal header.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobContinuationRecord {
    pub version: u8,
    pub id: String,
    pub job_id: String,
    pub continuation: String,
    pub state: JobContinuationState,
    pub completion: Option<Value>,
}
impl JobContinuationRecord {
    pub fn validate_transition(&self, prior: Option<&Self>) -> Result<(), &'static str> {
        self.validate()?;
        let Some(prior) = prior else {
            return if self.state == JobContinuationState::Registered && self.completion.is_none() {
                Ok(())
            } else {
                Err("Job continuation must start registered")
            };
        };
        if self.id != prior.id
            || self.job_id != prior.job_id
            || self.continuation != prior.continuation
        {
            return Err("Job continuation identity and note are immutable");
        }
        use JobContinuationState::*;
        if !matches!(
            (prior.state, self.state),
            (Registered, Settled | Cancelled) | (Settled, Delivered | Cancelled)
        ) {
            return Err("invalid Job continuation state transition");
        }
        if prior.completion.is_some() && self.completion != prior.completion {
            return Err("Job terminal snapshot is immutable");
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.id.is_empty()
            || self.id.len() > 512
            || self.job_id.is_empty()
            || self.job_id.len() > 256
            || self.continuation.trim().is_empty()
            || self.continuation.len() > 2048
        {
            return Err("invalid Job continuation version, identity or note");
        }
        if matches!(
            self.state,
            JobContinuationState::Settled | JobContinuationState::Delivered
        ) && !self.completion.as_ref().is_some_and(|c| c.is_object())
        {
            return Err("settled Job continuation requires terminal data");
        }
        if serde_json::to_vec(self)
            .map_err(|_| "invalid Job continuation JSON")?
            .len()
            > 128 * 1024
        {
            return Err("Job continuation exceeds its durable byte limit");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registered() -> JobContinuationRecord {
        JobContinuationRecord {
            version: 1,
            id: "receipt".into(),
            job_id: "job".into(),
            continuation: "verify".into(),
            state: JobContinuationState::Registered,
            completion: None,
        }
    }
    #[test]
    fn continuation_state_machine_rejects_rearm_and_mutation() {
        use JobContinuationState::*;
        let r = registered();
        r.validate_transition(None).unwrap();
        let mut s = r.clone();
        s.state = Settled;
        s.completion = Some(serde_json::json!({"snapshot":{"status":"completed"}}));
        s.validate_transition(Some(&r)).unwrap();
        let mut d = s.clone();
        d.state = Delivered;
        d.validate_transition(Some(&s)).unwrap();
        assert!(r.validate_transition(Some(&d)).is_err());
        assert!(d.validate_transition(None).is_err());
        let mut c = s.clone();
        c.state = Cancelled;
        c.validate_transition(Some(&s)).unwrap();
        assert!(r.validate_transition(Some(&c)).is_err());
        let mut bad = d.clone();
        bad.continuation = "changed".into();
        assert!(bad.validate_transition(Some(&s)).is_err());
        bad = d;
        bad.completion = Some(serde_json::json!({"snapshot":{"status":"failed"}}));
        assert!(bad.validate_transition(Some(&s)).is_err());
    }
    #[test]
    fn continuation_limits_are_utf8_bytes_not_character_counts() {
        let mut r = registered();
        r.continuation = "中".repeat(700);
        assert!(r.validate().is_err());
        r.continuation = "".into();
        assert!(r.validate().is_err());
    }
}
