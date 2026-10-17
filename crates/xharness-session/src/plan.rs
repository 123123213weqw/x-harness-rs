//! Session-local working plan. Never arms a Goal or schedules execution.
#![forbid(unsafe_code)]
use crate::{EventData, Session};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanItemStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionPlan {
    pub revision: u64,
    pub items: Vec<PlanItem>,
}

impl SessionPlan {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.revision == 0 || self.revision > 9_007_199_254_740_991 {
            return Err("invalid plan revision");
        }
        if self.items.len() > 128 {
            return Err("plan exceeds 128 items");
        }
        let mut ids = std::collections::HashSet::new();
        for item in &self.items {
            if item.id.trim().is_empty() || item.id.len() > 128 || !ids.insert(&item.id) {
                return Err("plan item IDs must be non-empty, unique and at most 128 bytes");
            }
            if item.title.trim().is_empty() || item.title.len() > 2048 {
                return Err("invalid plan title");
            }
        }
        Ok(())
    }
}

pub fn session_plan(session: &Session) -> Option<SessionPlan> {
    session.events().iter().rev().find_map(|e| match e.data() {
        EventData::SessionPlanUpdated { plan } => Some(plan.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Revision, SessionHeader};
    fn plan(revision: u64) -> SessionPlan {
        SessionPlan {
            revision,
            items: vec![PlanItem {
                id: "a".into(),
                title: "Verify".into(),
                status: PlanItemStatus::Pending,
            }],
        }
    }
    #[test]
    fn plan_journal_is_not_transcript_and_rejects_stale_or_malformed_snapshots() {
        let mut session = Session::new(SessionHeader::new("plan")).unwrap();
        assert_eq!(session_plan(&session), None);
        session
            .append(
                Revision::ZERO,
                EventData::SessionPlanUpdated { plan: plan(1) },
            )
            .unwrap();
        assert!(crate::derive_messages(session.events()).is_empty());
        let before = session.revision();
        assert!(session
            .append(before, EventData::SessionPlanUpdated { plan: plan(1) })
            .is_err());
        assert_eq!(session.revision(), before);
        let mut invalid = plan(2);
        invalid.items.push(invalid.items[0].clone());
        assert!(session
            .append(before, EventData::SessionPlanUpdated { plan: invalid })
            .is_err());
        session
            .append(
                before,
                EventData::SessionPlanUpdated {
                    plan: SessionPlan {
                        revision: 2,
                        items: vec![],
                    },
                },
            )
            .unwrap();
        assert!(session_plan(&session).unwrap().items.is_empty());
        assert!(crate::derive_messages(session.events()).is_empty());
    }
    #[test]
    fn plan_bounds_do_not_forbid_parallel_items() {
        let mut value = plan(1);
        value.items[0].status = PlanItemStatus::InProgress;
        value.items.push(PlanItem {
            id: "b".into(),
            title: "Parallel".into(),
            status: PlanItemStatus::InProgress,
        });
        assert!(value.validate().is_ok());
        value.items[1].title = " ".into();
        assert!(value.validate().is_err());
        value = plan(0);
        assert!(value.validate().is_err());
        value = plan(9_007_199_254_740_992);
        assert!(value.validate().is_err());
        value = plan(1);
        value.items[0].id = "x".repeat(129);
        assert!(value.validate().is_err());
        value = plan(1);
        value.items[0].title = "x".repeat(2049);
        assert!(value.validate().is_err());
    }
}
