//! Shared execution read/control adapter. Never starts a new model turn.
#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
use super::{bad_request, session_not_found};
use crate::BasicHost;
use serde::Deserialize;
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcId};
use xharness_jobs::{
    protocol::{
        JobCatalog, JobPlan, JobRun, PlanState, RunCapabilities, RunRef, RunState, VERSION,
    },
    JobOutputCursor,
};
use xharness_session::{EventData, ScheduleChange};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    command: Command,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    List,
    Output {
        reference: RunRef,
        #[serde(default)]
        cursor: Option<JobOutputCursor>,
    },
    CancelRun {
        reference: RunRef,
    },
    PausePlan {
        #[serde(rename = "planId")]
        plan_id: String,
    },
    ResumePlan {
        #[serde(rename = "planId")]
        plan_id: String,
    },
    CancelFuture {
        #[serde(rename = "planId")]
        plan_id: String,
    },
}

pub(super) async fn manage(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let request: Request =
        serde_json::from_value(payload.clone()).map_err(|_| bad_request("Invalid Job request"))?;
    host.hydrate_session(&request.session_id)
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?;
    let _guard = host.lock_admission(&request.session_id).await;
    {
        let state = host.state.read().await;
        if state.deleted_sessions.contains(&request.session_id)
            || !state.sessions.contains_key(&request.session_id)
        {
            return Err(session_not_found(&request.session_id));
        }
        if state.archived_sessions.contains(&request.session_id)
            && matches!(request.command, Command::ResumePlan { .. })
        {
            return Err(bad_request(
                "Unarchive this chat before resuming future execution",
            ));
        }
    }
    let session = &request.session_id;
    match request.command {
        Command::List => serde_json::to_value(catalog(host, session).await?).map_err(|e|RpcError::internal(e.to_string())),
        Command::Output { reference: RunRef::Process{id}, cursor } => {
            let read=host.agent_runtime.process_output(session, &id, cursor.unwrap_or_else(||JobOutputCursor::start(&id))).await.map_err(bad_request)?;
            Ok(json!({"version":VERSION,"stdout":read.stdout,"stderr":read.stderr,"stdoutTruncated":read.stdout_truncated,"stderrTruncated":read.stderr_truncated,"nextCursor":read.next_cursor,"run":JobRun::process(read.snapshot)}))
        }
        Command::CancelRun { reference: RunRef::Process{id} } => {
            host.agent_runtime.cancel_process_run(session, &id).await.map_err(bad_request)?;
            Ok(json!({"version":VERSION,"accepted":true})) // cancellation request, not terminal success
        }
        Command::CancelRun {..} | Command::Output {..} => Err(bad_request("This driver does not support targeted run cancellation or process output; open its conversation instead")),
        action => {
            let command = match action {
                Command::PausePlan{plan_id}=>xharness_schedule::AutomationCommand::Pause{id:plan_id},
                Command::ResumePlan{plan_id}=>xharness_schedule::AutomationCommand::Resume{id:plan_id},
                Command::CancelFuture{plan_id}=>xharness_schedule::AutomationCommand::Delete{id:plan_id},
                _=>unreachable!(),
            };
            let value=host.agent_runtime.automation_command(session, &format!("job-ui:{}",rpc_id.as_str()), command).await.map_err(|e|RpcError::internal(e.to_string()))?;
            if let Some(message)=value.get("code").and_then(|_|value.get("message")).and_then(Value::as_str) {return Err(bad_request(message));}
            host.sync_authoritative_session(session).await?;
            Ok(json!({"version":VERSION,"accepted":true}))
        }
    }
}

async fn catalog(host: &BasicHost, source: &str) -> Result<JobCatalog, RpcError> {
    let mut result = JobCatalog {
        version: VERSION,
        session_id: source.into(),
        plans: vec![],
        runs: host
            .agent_runtime
            .process_runs(source)
            .await
            .map_err(RpcError::internal)?,
    };
    let Some(session) = host
        .agent_runtime
        .authoritative_session(source)
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?
    else {
        return Ok(result);
    };
    // Bound the catalogue. Do not hydrate every child or scan every workspace.
    let mut ids = std::collections::HashSet::new();
    for event in session.events().iter().rev() {
        let EventData::ScheduleChange {
            change:
                ScheduleChange::Create { schedule, .. } | ScheduleChange::Update { schedule, .. },
        } = event.data()
        else {
            continue;
        };
        if !ids.insert(schedule.id.clone()) {
            continue;
        }
        let view = host
            .agent_runtime
            .automation_command(
                source,
                "job-catalog",
                xharness_schedule::AutomationCommand::View {
                    id: schedule.id.clone(),
                },
            )
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?;
        let (plan, runs) = normalize_automation(source, &view)?;
        result.plans.push(plan);
        result.runs.extend(runs);
        if ids.len() >= 50 {
            break;
        }
    }
    result.runs.sort_by(|a, b| {
        b.started_at_ms
            .or(b.scheduled_at_ms)
            .cmp(&a.started_at_ms.or(a.scheduled_at_ms))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(result)
}

fn normalize_automation(source: &str, value: &Value) -> Result<(JobPlan, Vec<JobRun>), RpcError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        id: String,
        prompt: String,
        scheduled_at: String,
        every_seconds: Option<u64>,
    }
    let record: Record =
        serde_json::from_value(value.clone()).map_err(|_| bad_request("Invalid saved Job plan"))?;
    let state: PlanState = serde_json::from_value(value["state"].clone())
        .map_err(|_| bad_request("Invalid saved Job plan state"))?;
    let mut runs = vec![];
    for raw in value["runs"].as_array().into_iter().flatten() {
        let Some(input) = raw["runId"].as_str() else {
            continue;
        };
        let Some(target) = raw["sessionId"].as_str() else {
            continue;
        };
        let started = raw["occurrenceAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .and_then(|t| u64::try_from(t.timestamp_millis()).ok());
        runs.push(JobRun {
            id: input.into(),
            label: record.prompt.clone(),
            source_session_id: source.into(),
            target_session_id: target.into(),
            plan_id: Some(record.id.clone()),
            state: RunState::from_agent(raw["state"].as_str().unwrap_or("unavailable")),
            reference: RunRef::Automation {
                plan_id: record.id.clone(),
                input_id: input.into(),
            },
            capabilities: RunCapabilities {
                cancel_run: false,
                read_output: false,
                open_session: true,
            },
            started_at_ms: None,
            scheduled_at_ms: started,
            finished_at_ms: None,
            detail: None,
        });
    }
    Ok((
        JobPlan {
            id: record.id,
            label: record.prompt,
            state,
            next_at: record.scheduled_at,
            every_seconds: record.every_seconds,
        },
        runs,
    ))
}
