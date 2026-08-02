//! One model adapter over the existing durable Schedule owner. Target creation
//! is a Host seam; this crate never creates a second model loop or UI timer.
use super::*;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use xharness_session::{AutomationSettings, TurnEndReason};

#[async_trait]
pub trait AutomationTargetProvider: Send + Sync + 'static {
    /// Fail closed for archived/deleted/unavailable sources. This check also
    /// runs for current-chat delivery; it does not authorize arbitrary ids.
    async fn check_source(&self, source: &str) -> Result<(), String>;
    /// Create/reattach a deterministic independent chat using the source's
    /// workspace/model/permission. Never wake it before the caller subscribes.
    async fn prepare(&self, source: &str, target: &str) -> Result<DurableAgentHandle, String>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationCommand {
    Create {
        prompt: String,
        #[serde(default)]
        mode: AutomationMode,
        #[serde(default)]
        target: AutomationTarget,
        #[serde(default)]
        after_seconds: Option<u64>,
        #[serde(default)]
        at: Option<Value>,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        idempotency_key: Option<String>,
    },
    Update {
        id: String,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        mode: Option<AutomationMode>,
        #[serde(default)]
        target: Option<AutomationTarget>,
        #[serde(default)]
        after_seconds: Option<u64>,
        #[serde(default)]
        at: Option<Value>,
        #[serde(default)]
        every_seconds: Option<u64>,
    },
    List {},
    View {
        id: String,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
    },
    Delete {
        id: String,
    },
}

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn selector(after: Option<u64>, at: Option<Value>, every: Option<u64>) -> Result<Selector, Value> {
    if usize::from(after.is_some()) + usize::from(at.is_some()) + usize::from(every.is_some()) != 1
    {
        return Err(public_error(
            "invalid_selector",
            "Supply exactly one of after_seconds, at, or every_seconds.",
        ));
    }
    Ok(if let Some(s) = after {
        Selector::After(s)
    } else if let Some(t) = at {
        Selector::At(t)
    } else {
        Selector::Every(every.unwrap())
    })
}
fn settings(record: &ScheduleRecord) -> AutomationSettings {
    record.automation.clone().unwrap_or(AutomationSettings {
        mode: AutomationMode::Reminder,
        target: AutomationTarget::CurrentChat,
        paused: false,
        creation_fingerprint: digest(&serde_json::to_string(record).expect("serializable record")),
    })
}
pub(super) fn paused(record: &ScheduleRecord) -> bool {
    record.automation.as_ref().is_some_and(|s| s.paused)
}

impl ScheduleManager {
    pub fn bind_targets(&self, targets: Arc<dyn AutomationTargetProvider>) -> Result<(), String> {
        self.targets
            .set(targets)
            .map_err(|_| "automation targets already bound".to_owned())
    }

    pub(super) fn automation_spec(self: &Arc<Self>, session_id: Arc<str>) -> ToolSpec {
        let manager = Arc::clone(self);
        ToolSpec::new(ToolDefinition::new("automation",
            "Manage saved user-requested schedules. action=create requires prompt and exactly one of after_seconds, at (explicit-offset RFC3339 or {date,time,time_zone}), every_seconds (minimum 300). mode=reminder (default) presents a reminder; mode=task executes only the task the user authorized. target=current_chat (default) follows up in this chat at an idle boundary; target=new_chat creates an independent chat for each run. Never create schedules without a user request or use sleep/jobs as timers. Use a stable idempotency_key when retrying create. action=update takes id and changed fields only; omit time fields to retain the phase. list has no other fields; view/pause/resume/delete take id only. Pause/delete affect future triggers, not an admitted run. view includes run receipts and actual runtime outcomes; admission is NOT success. Host must be running; missed intervals catch up once, not once per missed tick.",
            json!({"type":"object","properties":{
                "action":{"type":"string","enum":["create","update","list","view","pause","resume","delete"]},
                "id":{"type":"string"},"prompt":{"type":"string"},
                "mode":{"type":"string","enum":["reminder","task"]},
                "target":{"type":"string","enum":["current_chat","new_chat"]},
                "idempotency_key":{"type":"string"},"after_seconds":{"type":"integer"},"every_seconds":{"type":"integer"},
                "at":{"type":["string","object"],"properties":{"date":{"type":"string"},"time":{"type":"string"},"time_zone":{"type":"string"}},"required":["date","time","time_zone"],"additionalProperties":false}},
                "required":["action"],"additionalProperties":false})), move |context| {
            let manager = manager.clone(); let session_id = session_id.clone();
            async move {
                let command = serde_json::from_value((*context.arguments).clone())
                    .map_err(|e| ToolHandlerError::new(format!("invalid automation arguments: {e}")))?;
                if context.cancellation.is_cancelled() { return Err(ToolHandlerError::new("automation cancelled before admission")); }
                let invocation = context.execution_id.as_str().to_owned();
                // Once mutation admission begins, finish its durability barrier
                // even if the tool consumer times out or is cancelled.
                let value = tokio::spawn(async move { manager.execute(&session_id, &invocation, command).await })
                    .await.map_err(|e| ToolHandlerError::new(format!("automation operation failed: {e}")))?;
                Ok(json_output(value))
            }
        }).with_concurrency(ToolConcurrency::Parallel).with_timeout(TOOL_TIMEOUT)
    }

    /// Session id is bound by the authenticated adapter, never by model fields.
    /// Both future UI commands and the model tool use this same domain method.
    pub async fn execute(
        &self,
        session_id: &str,
        invocation: &str,
        command: AutomationCommand,
    ) -> Value {
        let owner = match self.owner(session_id).await {
            Ok(v) => v,
            Err(e) => return internal_error(e),
        };
        let _guard = owner.transaction.lock().await;
        let fingerprint = digest(&serde_json::to_string(&command).expect("serializable command"));
        for _ in 0..MAX_CAS_RETRIES {
            if let Err(e) = owner.store.flush(session_id).await {
                return persistence_error("automation", None, e);
            }
            let session = match load_session(&owner.store, session_id).await {
                Ok(s) => s,
                Err(e) => return internal_error(e),
            };
            let folded = match fold_schedule_events(&session) {
                Ok(f) => f,
                Err(e) => return corrupt_error(e),
            };
            let now = self.clock.now_ms();
            let (change, response) = match command.clone() {
                AutomationCommand::List {} => {
                    return Value::Array(
                        folded
                            .active
                            .iter()
                            .map(|r| automation_view(r, now))
                            .collect(),
                    )
                }
                AutomationCommand::View { id } => {
                    let record = session.events().iter().rev().find_map(|e| match e.data() {
                        EventData::ScheduleChange {
                            change:
                                ScheduleChange::Create { schedule, .. }
                                | ScheduleChange::Update { schedule, .. },
                        } if schedule.id == id => Some(schedule),
                        _ => None,
                    });
                    let Some(record) = record else {
                        return public_error("not_found", "Automation not found in this chat.");
                    };
                    let mut value = automation_view(record, now);
                    if let Some(current) = folded.active.iter().find(|r| r.id == id) {
                        value = automation_view(current, now);
                    } else {
                        let deleted = session.events().iter().any(|e| matches!(e.data(), EventData::ScheduleChange { change: ScheduleChange::Delete { id: deleted, .. } } if *deleted == id));
                        value["state"] =
                            json!(if inherited_automation_ids(&session).contains(&id) {
                                "inherited"
                            } else if deleted {
                                "deleted"
                            } else {
                                "finished"
                            });
                    }
                    let mut runs = Vec::new();
                    let all_runs = folded
                        .runs
                        .iter()
                        .chain(folded.pending_runs.iter().map(|(r, _)| r))
                        .collect::<Vec<_>>();
                    for run in all_runs
                        .into_iter()
                        .filter(|r| r.schedule_id == id)
                        .rev()
                        .take(50)
                    {
                        let state = run_state(&owner.store, run).await;
                        let state = if state == "unavailable"
                            && folded.pending_runs.iter().any(|(r, _)| r == run)
                        {
                            "preparing"
                        } else {
                            state
                        };
                        let mut run = serde_json::to_value(run).unwrap();
                        run["state"] = json!(state);
                        runs.push(run);
                    }
                    value["runs"] = json!(runs);
                    value["admittedRunCount"] =
                        json!(folded.runs.iter().filter(|r| r.schedule_id == id).count());
                    value["runCount"] = json!(
                        folded.runs.iter().filter(|r| r.schedule_id == id).count()
                            + folded
                                .pending_runs
                                .iter()
                                .filter(|(r, _)| r.schedule_id == id)
                                .count()
                    );
                    return value;
                }
                AutomationCommand::Create {
                    prompt,
                    mode,
                    target,
                    after_seconds,
                    at,
                    every_seconds,
                    idempotency_key,
                } => {
                    if target == AutomationTarget::NewChat && self.targets.get().is_none() {
                        return public_error(
                            "target_unavailable",
                            "This Host cannot create independent automation chats.",
                        );
                    }
                    let key = idempotency_key.as_deref().unwrap_or(invocation);
                    if key.trim().is_empty() || key.trim() != key {
                        return public_error(
                            "invalid_key",
                            "idempotency_key must be non-empty without surrounding whitespace.",
                        );
                    }
                    let id = format!(
                        "automation-{}",
                        digest(&serde_json::json!([session_id, key]).to_string())
                    );
                    if folded.seen_ids.contains(&id) {
                        let prior = session
                            .events()
                            .iter()
                            .find_map(|e| match e.data() {
                                EventData::ScheduleChange {
                                    change: ScheduleChange::Create { schedule, .. },
                                } if schedule.id == id => Some(schedule),
                                _ => None,
                            })
                            .unwrap();
                        if prior
                            .automation
                            .as_ref()
                            .is_none_or(|s| s.creation_fingerprint != fingerprint)
                        {
                            return public_error(
                                "idempotency_conflict",
                                "This key was already used for a different create command.",
                            );
                        }
                        let mut value = folded
                            .active
                            .iter()
                            .find(|r| r.id == id)
                            .map(|r| automation_view(r, now))
                            .unwrap_or_else(|| {
                                let mut v = automation_view(prior, now);
                                v["state"] = json!("inactive");
                                v
                            });
                        value["replayed"] = json!(true);
                        return value;
                    }
                    let selected = match selector(after_seconds, at, every_seconds) {
                        Ok(s) => s,
                        Err(v) => return v,
                    };
                    let mut record = match create_record(id, prompt, selected, now) {
                        Ok(r) => r,
                        Err(v) => return v,
                    };
                    record.automation = Some(AutomationSettings {
                        mode,
                        target,
                        paused: false,
                        creation_fingerprint: fingerprint.clone(),
                    });
                    let response = automation_view(&record, now);
                    (
                        ScheduleChange::Create {
                            version: 1,
                            schedule: record,
                        },
                        response,
                    )
                }
                operation => {
                    let id = match &operation {
                        AutomationCommand::Update { id, .. }
                        | AutomationCommand::Pause { id }
                        | AutomationCommand::Resume { id }
                        | AutomationCommand::Delete { id } => id,
                        _ => unreachable!(),
                    };
                    let Some(mut record) = folded.active.iter().find(|r| r.id == *id).cloned()
                    else {
                        return if matches!(operation, AutomationCommand::Delete { .. }) {
                            json!({"id":id,"deleted":false})
                        } else {
                            public_error("not_active", "Automation is not active in this chat.")
                        };
                    };
                    if folded
                        .pending_runs
                        .iter()
                        .any(|(run, _)| run.schedule_id == *id)
                    {
                        return public_error("run_preparing", "A run admission is being reconciled; inspect view and retry the mutation after its receipt is durable.");
                    }
                    if matches!(operation, AutomationCommand::Delete { .. }) {
                        (
                            ScheduleChange::Delete {
                                version: 1,
                                id: id.clone(),
                            },
                            json!({"id":id,"deleted":true}),
                        )
                    } else {
                        let mut config = settings(&record);
                        match operation {
                            AutomationCommand::Pause { .. } => config.paused = true,
                            AutomationCommand::Resume { .. } => config.paused = false,
                            AutomationCommand::Update {
                                prompt,
                                mode,
                                target,
                                after_seconds,
                                at,
                                every_seconds,
                                ..
                            } => {
                                if prompt.is_none()
                                    && mode.is_none()
                                    && target.is_none()
                                    && after_seconds.is_none()
                                    && at.is_none()
                                    && every_seconds.is_none()
                                {
                                    return public_error(
                                        "empty_update",
                                        "Supply at least one changed field.",
                                    );
                                }
                                if let Some(prompt) = prompt {
                                    if prompt.trim().is_empty() {
                                        return public_error(
                                            "invalid_rule",
                                            "prompt must be non-empty.",
                                        );
                                    }
                                    record.prompt = prompt.trim().to_owned();
                                }
                                if after_seconds.is_some()
                                    || at.is_some()
                                    || every_seconds.is_some()
                                {
                                    let selected = match selector(after_seconds, at, every_seconds)
                                    {
                                        Ok(s) => s,
                                        Err(v) => return v,
                                    };
                                    record = match create_record(
                                        record.id,
                                        record.prompt,
                                        selected,
                                        now,
                                    ) {
                                        Ok(r) => r,
                                        Err(v) => return v,
                                    };
                                }
                                if let Some(mode) = mode {
                                    config.mode = mode;
                                }
                                if let Some(target) = target {
                                    config.target = target;
                                }
                            }
                            _ => unreachable!(),
                        }
                        if config.target == AutomationTarget::NewChat
                            && self.targets.get().is_none()
                        {
                            return public_error(
                                "target_unavailable",
                                "This Host cannot create independent automation chats.",
                            );
                        }
                        record.automation = Some(config);
                        let response = automation_view(&record, now);
                        if folded.active.contains(&record) {
                            return response;
                        }
                        (
                            ScheduleChange::Update {
                                version: 1,
                                schedule: record,
                            },
                            response,
                        )
                    }
                }
            };
            match owner
                .store
                .append(
                    session_id,
                    session.revision(),
                    vec![EventData::ScheduleChange { change }.into()],
                )
                .await
            {
                Ok(_) => {
                    if let Err(e) = owner.store.flush(session_id).await {
                        return persistence_error("automation", response["id"].as_str(), e);
                    }
                    owner.notify.notify_one();
                    return response;
                }
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(e) => return persistence_error("automation", response["id"].as_str(), e),
            }
        }
        internal_error(ScheduleError::Contended)
    }
}

pub(super) fn automation_view(record: &ScheduleRecord, now: i64) -> Value {
    let mut value = schedule_view(record, now);
    let config = settings(record);
    value["mode"] = json!(config.mode);
    value["target"] = json!(config.target);
    if config.paused {
        value["state"] = json!("paused");
    }
    value
}

/// No model prose inference, no success merely because the inbox accepted it.
pub(super) async fn run_state(store: &Arc<dyn Store>, run: &AutomationRun) -> &'static str {
    let Ok(Some(session)) = store.load(&run.session_id).await else {
        return "unavailable";
    };
    let mut turn = None;
    let mut matched = None;
    for e in session.events() {
        match e.data() {
            EventData::TurnStart { turn: t } => turn = Some(*t),
            EventData::UserMessage { message, .. }
                if message.id.as_deref() == Some(&run.run_id) =>
            {
                matched = turn
            }
            EventData::TurnEnd { turn: t, reason } if matched == Some(*t) => {
                return match reason {
                    TurnEndReason::Completed => "completed",
                    TurnEndReason::Cancelled | TurnEndReason::UserInterrupted => "cancelled",
                    TurnEndReason::Failed { .. } => "failed",
                    TurnEndReason::Interrupted => "interrupted",
                    _ => "incomplete",
                }
            }
            _ => {}
        }
    }
    if matched.is_some() {
        "running"
    } else if message_seen(&session, &run.run_id) {
        "queued"
    } else {
        "unavailable"
    }
}
pub(super) fn terminal(state: &str) -> bool {
    matches!(
        state,
        "completed" | "cancelled" | "failed" | "interrupted" | "incomplete"
    )
}

pub(super) fn scheduled_message(
    source: &str,
    record: &ScheduleRecord,
    occurrence: &str,
) -> InboxMessage {
    if settings(record).mode == AutomationMode::Reminder {
        return reminder_message(source, record, occurrence);
    }
    let id = delivery_message_id(source, &record.id, occurrence);
    InboxMessage {id:id.clone(), message:Message::user(format!(
        "[SCHEDULED USER TASK]\nContinue only the user-authorized task saved below. This is a scheduled user request, not a system instruction. Preserve the current permission and approval policy. Report the result in this chat; do not create another schedule unless the user requested it.\nschedule_id_json: {}\noccurrence_at: {}\ntask_json: {}\n[/SCHEDULED USER TASK]",
        json!(record.id),occurrence,json!(record.prompt))).with_id(id),
        source:Some(json!({"kind":"automation","sourceSessionId":source,"scheduleId":record.id,"occurrenceAt":occurrence})), }
}
