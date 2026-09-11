//! One ordinary model tool; UI, slash commands and tool mutations share Host RPC/CAS.
use crate::{BasicHost, SessionToolFactory};
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Weak};
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_session::{goal::GoalDefinition, Store};
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    Create {
        objective: String,
        max_goal_rounds: Option<u64>,
    },
    Get {},
    Update {
        r#ref: GoalRef,
        objective: Option<String>,
        max_goal_rounds: Option<u64>,
    },
    Pause {
        r#ref: GoalRef,
    },
    Resume {
        r#ref: GoalRef,
    },
    Report {
        report: xharness_agent::GoalReportBody,
    },
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct GoalRef {
    id: String,
    revision: u64,
}

pub(crate) fn spec(
    host: Weak<BasicHost>,
    store: Arc<dyn Store>,
    tools: Arc<dyn SessionToolFactory>,
    session_id: String,
    fence: Option<(GoalDefinition, u64)>,
) -> ToolSpec {
    ToolSpec::new(ToolDefinition::new("goal",
        "Manage a persistent Goal in this conversation. Create ONLY when the user explicitly asks to set a goal or keep working toward one; ordinary tasks do not imply a Goal. action=create requires objective, optional max_goal_rounds (default 256). get reads status and ref. update/pause/resume require the latest ref {id,revision} from get; update changes objective and/or max_goal_rounds and pauses automatic continuation. Change budgets or resume only when the user asks. report requires report {status:progress|blocked|complete,summary,remaining,evidence,blocked_reason}; use near the end of an automatic Goal turn after work settles, then finish the turn. Complete reports need concrete evidence and no remaining work; the USER confirms completion. job/agent evidence IDs are required unfinished dependencies, not unrelated daemons. Never create a new Goal to bypass a paused/finished budget. There is no model action to confirm completion or delete history. Call alone. Tools, /goal and the Goal bar share the same durable state.",
        json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["create","get","update","pause","resume","report"]},
            "objective":{"type":"string","minLength":1},
            "max_goal_rounds":{"type":"integer","minimum":1},
            "ref":{"type":"object","additionalProperties":false,"required":["id","revision"],"properties":{"id":{"type":"string","minLength":1},"revision":{"type":"integer","minimum":1}}},
            "report":{"type":"object","additionalProperties":false,"required":["status","summary"],"properties":{
                "status":{"type":"string","enum":["progress","blocked","complete"]},
                "summary":{"type":"string","minLength":1,"maxLength":8192},
                "remaining":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2048}},
                "evidence":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["kind","reference"],"properties":{"kind":{"type":"string","enum":["artifact","job","agent"]},"reference":{"type":"string","minLength":1,"maxLength":2048}}}},
                "blocked_reason":{"type":"object","additionalProperties":false,"required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}}
            }}
        }})),move |ctx| {
            let host=host.clone(); let store=store.clone(); let tools=tools.clone();
            let session_id=session_id.clone(); let fence=fence.clone();
            async move {
                let operation: Operation=serde_json::from_value((*ctx.arguments).clone())
                    .map_err(|e|ToolHandlerError::new(format!("invalid goal arguments: {e}")))?;
                if ctx.cancellation.is_cancelled() {return Err(ToolHandlerError::new("goal operation cancelled before admission"))}
                if let Operation::Report {report} = operation {
                    let (definition,epoch)=fence.ok_or_else(||ToolHandlerError::new("report is only available during an automatic Goal turn; use get to inspect the Goal"))?;
                    return crate::goals::validate_report(&store,&tools,&session_id,definition,epoch,report).await;
                }
                let host=host.upgrade().ok_or_else(||ToolHandlerError::new("goal host is shutting down"))?;
                let invocation=ctx.execution_id.as_str().to_owned();
                // Finish admitted CAS+receipt even if the consumer is cancelled, like agent tool.
                tokio::spawn(async move { execute(&host,&session_id,&invocation,operation).await })
                    .await.map_err(|e|ToolHandlerError::new(format!("goal admission failed: {e}")))?
            }
        }).requiring_standalone_batch()
}

async fn execute(
    host: &BasicHost,
    session: &str,
    invocation: &str,
    op: Operation,
) -> Result<ToolOutput, ToolHandlerError> {
    if matches!(op, Operation::Get {}) {
        host.sync_authoritative_session(session)
            .await
            .map_err(|e| ToolHandlerError::new(e.message))?;
        let state = host.state.read().await;
        if !state.sessions.contains_key(session) {
            return Err(ToolHandlerError::new("session missing"));
        }
        let value = state
            .goals
            .get(session)
            .map(|g| {
                let mut value = g.projection();
                value["ref"] = json!({"id":g.id,"revision":g.revision});
                value
            })
            .unwrap_or_else(|| json!({"goal":null,"ref":null}));
        return Ok(ToolOutput::text(value.to_string()));
    }
    let mut payload = json!({"sessionId":session});
    let method = match op {
        Operation::Create {
            objective,
            max_goal_rounds,
        } => {
            payload["objective"] = json!(objective);
            if let Some(n) = max_goal_rounds {
                payload["maxGoalRounds"] = json!(n)
            }
            RpcMethod::GoalCreate
        }
        Operation::Update {
            r#ref,
            objective,
            max_goal_rounds,
        } => {
            if objective.is_none() && max_goal_rounds.is_none() {
                return Err(ToolHandlerError::new(
                    "update needs objective or max_goal_rounds",
                ));
            }
            payload["ref"] = json!(r#ref);
            if let Some(text) = objective {
                payload["objective"] = json!(text)
            }
            if let Some(n) = max_goal_rounds {
                payload["maxGoalRounds"] = json!(n)
            }
            RpcMethod::GoalEdit
        }
        Operation::Pause { r#ref } => {
            payload["ref"] = json!(r#ref);
            RpcMethod::GoalPause
        }
        Operation::Resume { r#ref } => {
            payload["ref"] = json!(r#ref);
            RpcMethod::GoalResume
        }
        Operation::Get {} | Operation::Report { .. } => unreachable!(),
    };
    match host.call(RpcId::new(format!("goal-tool:{session}:{invocation}")),method,payload,Default::default()).await {
        RpcResult::Success {value} => Ok(ToolOutput::text(json!({"accepted":true,"result":value,"note":"Goal state updated, not proof of task completion."}).to_string())),
        RpcResult::Failure {error} => Err(ToolHandlerError::new(error.message)),
    }
}
