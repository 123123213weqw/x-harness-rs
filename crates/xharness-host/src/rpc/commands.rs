//! Slash-command catalogue and execution adapter.

use serde_json::{json, Value};
use tokio::sync::mpsc;
use xharness_api::{RpcError, RpcId};
use xharness_session::{CommandResultKind, CommandSource, EventData as SessionEventData};

use crate::{state::DriverCommand, BasicHost};

use super::{
    bad_request, goal, permission_command_input, permission_events, plan_command_input,
    required_array, required_string, session_not_found,
};

pub(super) async fn list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let args = payload
        .get("args")
        .ok_or_else(|| bad_request("commands/list requires args"))?;
    let session_id = required_string(args, "agentId")?;
    if !host.state.read().await.sessions.contains_key(&session_id) {
        return Err(session_not_found(&session_id));
    }
    Ok(json!([
        {
            "name": "permission",
            "description": "Switch the permission preset (sandbox mode + approval policy)",
            "input": {"hint": "<preset>"},
        },
        {
            "name": "plan",
            "description": "Enter or leave plan mode",
            "input": {"hint": "[off|message]", "images": true},
        },
        {
            "name": "compact",
            "description": "Compact eligible conversation history now",
            "input": {"hint": ""},
        },
        {"name":"goal","description":"Set a persistent Goal and continue automatically until review, pause or budget limit","input":{"hint":"<objective> | pause | resume | complete | clear | edit <objective> | budget <rounds>"}}
    ]))
}

pub(super) async fn execute(host: &BasicHost, payload: &Value) -> Result<Option<Value>, RpcError> {
    let args = payload
        .get("args")
        .ok_or_else(|| bad_request("commands/execute requires args"))?;
    let session_id = required_string(args, "agentId")?;
    let line = required_string(args, "line")?;
    if line.trim() == "/goal" || line.trim_start().starts_with("/goal ") {
        let images = required_array(args, "images")?;
        return execute_goal(
            host,
            &session_id,
            line.trim_start().strip_prefix("/goal").unwrap().trim(),
            images,
        )
        .await
        .map(Some);
    }
    if line.trim() == "/compact" || line.trim_start().starts_with("/compact ") {
        let images = required_array(args, "images")?;
        return execute_compact(
            host,
            &session_id,
            line.trim_start().strip_prefix("/compact").unwrap().trim(),
            images,
        )
        .await
        .map(Some);
    }
    let _session_guard = host.lock_admission(&session_id).await;
    let images = required_array(args, "images")?;

    if let Some(raw_input) = plan_command_input(&line) {
        return execute_plan(host, &session_id, raw_input, images)
            .await
            .map(Some);
    }

    let Some(raw_input) = permission_command_input(&line) else {
        return Ok(None);
    };
    let command_id = host.mint_id("command");
    host.commit_session_events(
        &session_id,
        vec![SessionEventData::CommandRun {
            command_id: command_id.clone(),
            name: "permission".to_owned(),
            args: Some(raw_input.to_owned()),
            source: CommandSource::User,
        }
        .into()],
    )
    .await?;

    let result = if !images.is_empty() {
        json!({"kind": "error", "text": "/permission does not accept image attachments"})
    } else if raw_input.trim().is_empty() {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        let view = session.permission_projection();
        json!({
            "kind":"success",
            "text":format!("selected preset {}; active this turn: {}; pending: {} (available: workspace-write, danger-full-access)",
                session.permission_preset.as_str(), view["activeValue"].as_str().unwrap_or("none"), view["pending"]),
        })
    } else if let Some(preset) = crate::PermissionPreset::parse(raw_input.trim()) {
        let _permission_guard = host.lock_permission_selection(&session_id).await;
        host.commit_session_events(&session_id, permission_events(preset))
            .await?;
        let pending = {
            let mut state = host.state.write().await;
            let session = state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            session.permission_preset = preset;
            session.running && session.active_permission != Some(preset)
        };
        host.push_permission_projection(&session_id).await;
        json!({"kind":"success", "text": if pending {
                format!("preset {} saved; applies to the next turn. Current tools and approvals are unchanged.", preset.as_str())
            } else { format!("preset {}", preset.as_str()) }})
    } else {
        json!({
            "kind": "error",
            "text": format!(
                "unknown preset {:?} (available: workspace-write, danger-full-access)",
                raw_input.trim()
            ),
        })
    };

    let kind = match result["kind"].as_str() {
        Some("success") => CommandResultKind::Success,
        _ => CommandResultKind::Error,
    };
    host.commit_session_events(
        &session_id,
        vec![SessionEventData::CommandDone {
            command_id: command_id.clone(),
            kind,
            text: result["text"].as_str().map(str::to_owned),
            source_event_seq: None,
        }
        .into()],
    )
    .await?;
    Ok(Some(json!({"commandId": command_id, "result": result})))
}

async fn execute_compact(
    host: &BasicHost,
    session_id: &str,
    raw_input: &str,
    images: &[Value],
) -> Result<Value, RpcError> {
    let _session_guard = host.lock_admission(session_id).await;
    let command_id = host.mint_id("command");
    host.commit_session_events(
        session_id,
        vec![SessionEventData::CommandRun {
            command_id: command_id.clone(),
            name: "compact".to_owned(),
            args: (!raw_input.is_empty()).then(|| raw_input.to_owned()),
            source: CommandSource::User,
        }
        .into()],
    )
    .await?;

    let rejection = if !images.is_empty() {
        Some("/compact does not accept image attachments".to_owned())
    } else if !raw_input.is_empty() {
        Some("/compact does not accept arguments".to_owned())
    } else {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(session_id)
            .ok_or_else(|| session_not_found(session_id))?;
        if session.running {
            Some("/compact requires the current Agent turn to finish first".to_owned())
        } else if session.dispatch_paused {
            Some("/compact is unavailable while session dispatch is paused".to_owned())
        } else {
            None
        }
    };
    if let Some(text) = rejection {
        settle_compact_command(
            host,
            session_id,
            &command_id,
            CommandResultKind::Error,
            &text,
        )
        .await?;
        return Ok(json!({
            "commandId":command_id,
            "result":{"kind":"error","text":text},
        }));
    }

    let run = match host
        .agent_runtime
        .start_manual_compaction(session_id, &command_id)
        .await
    {
        Ok(run) => run,
        Err(error) => {
            let text = error.to_string();
            settle_compact_command(
                host,
                session_id,
                &command_id,
                CommandResultKind::Error,
                &text,
            )
            .await?;
            return Ok(json!({
                "commandId":command_id,
                "result":{"kind":"error","text":text},
            }));
        }
    };

    let (control_tx, control_rx) = mpsc::channel::<DriverCommand>(64);
    {
        let mut state = host.state.write().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| session_not_found(session_id))?;
        session.running = true;
        session.control = Some(control_tx);
    }
    host.push_host(json!({
        "type":"host/session-status",
        "sessionId":session_id,
        "running":true,
    }));
    let host = host.clone();
    let session_id = session_id.to_owned();
    tokio::spawn(async move {
        host.drive_recovered_turn(session_id, run, control_rx).await;
    });
    Ok(json!({
        "commandId":command_id,
        "result":{"kind":"success","text":"Compaction started"},
    }))
}

async fn settle_compact_command(
    host: &BasicHost,
    session_id: &str,
    command_id: &str,
    kind: CommandResultKind,
    text: &str,
) -> Result<(), RpcError> {
    host.commit_session_events(
        session_id,
        vec![SessionEventData::CommandDone {
            command_id: command_id.to_owned(),
            kind,
            text: Some(text.to_owned()),
            source_event_seq: None,
        }
        .into()],
    )
    .await
}

async fn execute_plan(
    host: &BasicHost,
    session_id: &str,
    raw_input: &str,
    images: &[Value],
) -> Result<Value, RpcError> {
    let command_id = host.mint_id("command");
    host.commit_session_events(
        session_id,
        vec![SessionEventData::CommandRun {
            command_id: command_id.clone(),
            name: "plan".to_owned(),
            args: Some(raw_input.to_owned()),
            source: CommandSource::User,
        }
        .into()],
    )
    .await?;

    let message = raw_input.trim();
    let result = if message == "off" && !images.is_empty() {
        json!({"kind": "error", "text": "Image attachments cannot accompany /plan off."})
    } else if (message != "off" && !message.is_empty()) || !images.is_empty() {
        json!({
            "kind": "error",
            "text": "Plan-mode messages and images require the pending pre-step steering path, which is not available in this host build.",
        })
    } else {
        let (running, current) = {
            let state = host.state.read().await;
            let session = state
                .sessions
                .get(session_id)
                .ok_or_else(|| session_not_found(session_id))?;
            (session.running, session.plan_active)
        };
        let wanted = message != "off";
        if running {
            json!({
                "kind": "error",
                "text": "cannot switch plan mode while the session is running until pending pre-step selection is implemented",
            })
        } else if current == wanted {
            json!({
                "kind": "success",
                "text": if wanted {
                    "Plan mode is already active."
                } else {
                    "Plan mode is already inactive."
                },
            })
        } else {
            host.commit_session_events(
                session_id,
                vec![SessionEventData::PlanMode { active: wanted }.into()],
            )
            .await?;
            host.state
                .write()
                .await
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| session_not_found(session_id))?
                .plan_active = wanted;
            host.push_projection(
                session_id,
                "plan",
                json!({"active": wanted, "pending": false}),
            )
            .await;
            json!({
                "kind": "success",
                "text": if wanted {
                    "Plan mode on. Use /plan off to leave."
                } else {
                    "Plan mode off."
                },
            })
        }
    };

    let kind = match result["kind"].as_str() {
        Some("success") => CommandResultKind::Success,
        _ => CommandResultKind::Error,
    };
    host.commit_session_events(
        session_id,
        vec![SessionEventData::CommandDone {
            command_id: command_id.clone(),
            kind,
            text: result["text"].as_str().map(str::to_owned),
            source_event_seq: None,
        }
        .into()],
    )
    .await?;
    Ok(json!({"commandId": command_id, "result": result}))
}

async fn execute_goal(
    host: &BasicHost,
    id: &str,
    input: &str,
    images: &[Value],
) -> Result<Value, RpcError> {
    let command_id = host.mint_id("command");
    host.commit_session_events(
        id,
        vec![SessionEventData::CommandRun {
            command_id: command_id.clone(),
            name: "goal".into(),
            args: Some(input.into()),
            source: CommandSource::User,
        }
        .into()],
    )
    .await?;
    host.sync_authoritative_session(id).await?;
    let current = host.state.read().await.goals.get(id).cloned();
    let result: Result<String, RpcError> = if !images.is_empty() {
        Err(bad_request(
            "/goal currently accepts text only; send attachments in a normal message first",
        ))
    } else if input.is_empty() {
        Ok(current
            .as_ref()
            .map_or("Usage: /goal <objective>".into(), |g| {
                format!(
                    "Goal: {} ({:?}, {}/{})",
                    g.objective, g.phase, g.rounds_started, g.max_goal_rounds
                )
            }))
    } else {
        let rpc = RpcId::new(format!("goal-command:{command_id}"));
        let payload = json!({"sessionId":id,"ref":current.as_ref().map(|g|json!({"id":g.id,"revision":g.revision}))});
        let action = match input {
            "pause" => goal::transition(host, rpc, &payload, "paused").await,
            "resume" => goal::transition(host, rpc, &payload, "active").await,
            "complete" => goal::transition(host, rpc, &payload, "complete").await,
            "clear" => goal::clear(host, rpc, &payload).await,
            _ if input.starts_with("budget ") => match input[7..].trim().parse::<u64>() {
                Ok(n) => {
                    let mut p = payload;
                    p["maxGoalRounds"] = json!(n);
                    goal::edit(host, rpc, &p).await
                }
                Err(_) => Err(bad_request("budget must be a positive integer")),
            },
            _ if input.starts_with("edit ") => {
                let mut p = payload;
                p["objective"] = json!(input[5..].trim());
                goal::edit(host, rpc, &p).await
            }
            _ => goal::create(host, rpc, &json!({"sessionId":id,"objective":input})).await,
        };
        action.map(|_| "Goal updated. The Goal bar shows execution and review status.".into())
    };
    let (kind, text) = match result {
        Ok(text) => (CommandResultKind::Success, text),
        Err(e) => (CommandResultKind::Error, e.message),
    };
    host.commit_session_events(
        id,
        vec![SessionEventData::CommandDone {
            command_id: command_id.clone(),
            kind,
            text: Some(text.clone()),
            source_event_seq: None,
        }
        .into()],
    )
    .await?;
    Ok(
        json!({"commandId":command_id,"result":{"kind":if kind==CommandResultKind::Success {"success"} else {"error"},"text":text}}),
    )
}
