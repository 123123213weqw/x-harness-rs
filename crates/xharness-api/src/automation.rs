//! Closed saved-automation capabilities. No scheduler, create/edit or public RPC.
use serde::{Deserialize, Serialize};
pub const SCOPED_AUTOMATION_PAGE_SIZE: usize = 25;
pub const SCOPED_AUTOMATION_RUN_LIMIT: usize = 50;
fn id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}
fn instant(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.is_ascii() && !s.chars().any(char::is_control)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationRead {
    List { after: Option<String> },
    View { id: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationControl {
    Pause { id: String },
    Resume { id: String },
    Delete { id: String },
}
impl AutomationControl {
    pub fn id(&self) -> &str {
        match self {
            Self::Pause { id } | Self::Resume { id } | Self::Delete { id } => id,
        }
    }
    pub fn expected_state(&self) -> AutomationControlState {
        match self {
            Self::Pause { .. } => AutomationControlState::Paused,
            Self::Resume { .. } => AutomationControlState::Enabled,
            Self::Delete { .. } => AutomationControlState::Deleted,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedAutomationRead {
    pub workspace: String,
    pub session: String,
    pub read: AutomationRead,
}
impl ScopedAutomationRead {
    pub fn is_bounded(&self) -> bool {
        id(&self.workspace)
            && id(&self.session)
            && match &self.read {
                AutomationRead::List { after } => after.as_ref().is_none_or(|s| id(s)),
                AutomationRead::View { id: s } => id(s),
            }
    }
    pub fn admits(&self, p: &ScopedAutomationPage) -> bool {
        if !self.is_bounded()
            || p.workspace != self.workspace
            || p.session != self.session
            || p.read != self.read
        {
            return false;
        }
        match &self.read {
            AutomationRead::List { after } => {
                p.detail.is_none()
                    && p.entries.len() <= SCOPED_AUTOMATION_PAGE_SIZE
                    && p.entries
                        .iter()
                        .all(|e| e.is_bounded(true) && after.as_ref().is_none_or(|s| e.id > *s))
                    && p.entries.windows(2).all(|w| w[0].id < w[1].id)
                    && p.next.as_ref().is_none_or(|n| {
                        p.entries.len() == SCOPED_AUTOMATION_PAGE_SIZE
                            && p.entries.last().is_some_and(|e| &e.id == n)
                    })
            }
            AutomationRead::View { id: target } => {
                p.next.is_none()
                    && p.entries.len() == 1
                    && p.entries[0].id == *target
                    && p.entries[0].is_bounded(false)
                    && p.detail.as_ref().is_some_and(|d| {
                        d.runs.len() <= SCOPED_AUTOMATION_RUN_LIMIT
                            && d.admitted_run_count <= d.run_count
                            && d.run_count >= d.runs.len() as u64
                            && d.runs
                                .iter()
                                .all(|r| id(&r.id) && instant(&r.occurrence_at))
                            && {
                                let mut ids = std::collections::BTreeSet::new();
                                d.runs.iter().all(|r| ids.insert(&r.id))
                            }
                    })
            }
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedAutomationMutation {
    pub workspace: String,
    pub session: String,
    pub request_key: String,
    pub control: AutomationControl,
}
impl ScopedAutomationMutation {
    pub fn is_bounded(&self) -> bool {
        id(&self.workspace)
            && id(&self.session)
            && id(self.control.id())
            && self.request_key.len() == 64
            && self
                .request_key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    pub fn receipt_id(&self) -> String {
        format!("remote-automation-{}", self.request_key)
    }
    pub fn admits(&self, r: &ScopedAutomationApplied) -> bool {
        self.is_bounded()
            && r.workspace == self.workspace
            && r.session == self.session
            && r.request_key == self.request_key
            && r.control == self.control
            && r.state == self.control.expected_state()
    }
}
macro_rules! states {($n:ident,$($v:ident),+)=>{#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)] #[serde(rename_all="snake_case")] pub enum $n {$($v),+}};}
states!(AutomationControlState, Paused, Enabled, Deleted);
states!(
    AutomationState,
    Scheduled,
    Overdue,
    Paused,
    Finished,
    Deleted,
    Inherited
);
states!(AutomationKind, After, At, Every);
states!(AutomationMode, Reminder, Task);
states!(AutomationTarget, CurrentChat, NewChat);
states!(
    AutomationRunState,
    Cancelled,
    Preparing,
    Completed,
    Failed,
    Interrupted,
    Incomplete,
    Running,
    Queued,
    Unavailable
);
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedAutomationApplied {
    pub workspace: String,
    pub session: String,
    pub request_key: String,
    pub control: AutomationControl,
    pub state: AutomationControlState,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationEntry {
    pub id: String,
    pub prompt: String,
    pub prompt_is_preview: bool,
    pub kind: AutomationKind,
    pub mode: AutomationMode,
    pub target: AutomationTarget,
    pub state: AutomationState,
    pub scheduled_at: String,
    pub after_seconds: Option<u64>,
    pub every_seconds: Option<u64>,
}
impl AutomationEntry {
    fn is_bounded(&self, list: bool) -> bool {
        id(&self.id)
            && !self.prompt.is_empty()
            && self.prompt.len() <= if list { 1024 } else { 200_000 }
            && (!list || self.prompt.chars().count() <= 160)
            && (list || !self.prompt_is_preview)
            && instant(&self.scheduled_at)
            && match self.kind {
                AutomationKind::After => {
                    self.after_seconds.is_some_and(|n| n > 0) && self.every_seconds.is_none()
                }
                AutomationKind::At => self.after_seconds.is_none() && self.every_seconds.is_none(),
                AutomationKind::Every => {
                    self.after_seconds.is_none() && self.every_seconds.is_some_and(|n| n >= 300)
                }
            }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationRunView {
    pub id: String,
    pub occurrence_at: String,
    pub state: AutomationRunState,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationDetail {
    pub runs: Vec<AutomationRunView>,
    pub run_count: u64,
    pub admitted_run_count: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedAutomationPage {
    pub workspace: String,
    pub session: String,
    pub read: AutomationRead,
    pub entries: Vec<AutomationEntry>,
    pub next: Option<String>,
    pub detail: Option<AutomationDetail>,
}
