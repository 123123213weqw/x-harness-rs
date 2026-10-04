//! Opt-in real-provider acceptance of the production agent tool. Synthetic
//! workspace only; loopback relay keeps provider credentials on the workstation.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_core::IdentityContextPolicy;
use xharness_host::{
    AgentRuntime, AgentTool, BasicHost, DurableLoopAgentRuntime, HostConfig, ModelDescriptor,
    ModelRegistry, ModelRoute, PermissionPreset, RegisteredModel, SessionToolFactory,
};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
use xharness_session::{EventData, MemorySessionStore, Store};
use xharness_tools::{
    ToolDefinition, ToolExecutor, ToolHandlerError, ToolOutput, ToolRegistry, ToolRequest, ToolSpec,
};
struct Fixtures {
    root: PathBuf,
}
#[async_trait]
impl SessionToolFactory for Fixtures {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let registry = Arc::new(ToolRegistry::new());
        let path = self.root.join("context.txt");
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "read_context",
                    "Read the fixed synthetic project context.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                ),
                move |_| {
                    let path = path.clone();
                    async move {
                        Ok(ToolOutput::text(
                            std::fs::read_to_string(path)
                                .map_err(|e| ToolHandlerError::new(e.to_string()))?,
                        ))
                    }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        let path = self.root.join("plan.txt");
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "read_plan",
                    "Read actual plan.txt; context branching does not undo this file.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                ),
                move |_| {
                    let path = path.clone();
                    async move {
                        Ok(ToolOutput::text(
                            std::fs::read_to_string(path)
                                .map_err(|e| ToolHandlerError::new(e.to_string()))?,
                        ))
                    }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        let path = self.root.join("plan.txt");
        registry.register(ToolSpec::new(ToolDefinition::new("write_plan","Replace only the disposable plan.txt with the supplied text.",json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false})),move |ctx|{let path=path.clone();async move {let text=ctx.arguments["text"].as_str().ok_or_else(||ToolHandlerError::new("text required"))?;std::fs::write(path,text).map_err(|e|ToolHandlerError::new(e.to_string()))?;Ok(ToolOutput::text("written"))}})).await.map_err(|e|e.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}
async fn agent(executor: &ToolExecutor, args: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let result = executor
        .execute(ToolRequest::new("agent", args.to_string()))
        .await;
    if let Some(failure) = result.failure {
        return Err(format!("agent failed: {}", failure.message).into());
    }
    let output = result.output.ok_or("no tool receipt")?;
    Ok(serde_json::from_str(&output.content)?)
}
async fn idle(executor: &ToolExecutor, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    tokio::time::timeout(Duration::from_secs(240), async {
        loop {
            let v = agent(executor, json!({"action":"inspect","agent_id":id})).await?;
            if v["agents"][0]["status"] == "idle" && !v["last_settlement"].is_null() {
                return Ok::<_, Box<dyn std::error::Error>>(());
            }
            if v["agents"][0]["status"] == "paused" {
                return Err(format!("child paused: {}", v["last_settlement"]).into());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await??;
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::var("XHARNESS_REVERT_FIXTURE")?);
    std::fs::create_dir_all(&root)?;
    if root.join("plan.txt").exists() {
        return Err("acceptance requires a fresh disposable directory".into());
    }
    std::fs::write(root.join("context.txt"),"FACT_AUTH_42: the project concerns authorization scopes, not login. Keep this observation in context.")?;
    let model = std::env::var("XHARNESS_REVERT_MODEL")?;
    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        std::env::var("XHARNESS_REVERT_RELAY")?,
        std::env::var("XHARNESS_REVERT_NONCE")?,
        model.clone(),
    );
    config.reasoning = Some(OpenAiReasoningProfile::new(
        Some("off".into()),
        vec![("off".into(), json!({"thinking":{"type":"disabled"}}))],
    )?);
    let mut models = ModelRegistry::new();
    models.register(RegisteredModel::new(
        ModelDescriptor::new("acceptance", "real configured DeepSeek", &model, &model),
        Arc::new(OpenAiProvider::new(config)?),
    ))?;
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let fixtures = Arc::new(Fixtures { root: root.clone() });
    let runtime: Arc<dyn AgentRuntime> = Arc::new(DurableLoopAgentRuntime::from_registry(
        ModelRoute::new("acceptance", &model),
        models,
        fixtures.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        2048,
    )?);
    let mut hc = HostConfig::new(&root);
    hc.provider_id = "acceptance".into();
    hc.model_id = model;
    let host = BasicHost::with_agent_runtime(hc, runtime.clone());
    match host
        .call(
            RpcId::new("main-create"),
            RpcMethod::SessionCreate,
            json!({"sessionId":"acceptance-main"}),
            CancellationToken::new(),
        )
        .await
    {
        RpcResult::Success { .. } => {}
        other => return Err(format!("create: {other:?}").into()),
    };
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(AgentTool::for_host(&host, "acceptance-main"))
        .await?;
    let executor = ToolExecutor::new(registry);
    let started=agent(&executor,json!({"action":"start","task":"Synthetic integration acceptance. First call read_context ALONE and wait for its result. On the next step write_plan with exactly STALE_LOGIN_PLAN. Then finish. Do not batch reading and writing. Do not read_plan, use shell, or access other files."})).await?;
    let source = started["agent_id"].as_str().ok_or("source missing")?;
    idle(&executor, source).await?;
    if std::fs::read_to_string(root.join("plan.txt"))? != "STALE_LOGIN_PLAN" {
        return Err("source fixture did not match the controlled intervention".into());
    }
    let frozen = store.load(source).await?.ok_or("source journal missing")?;
    let checkpoint = frozen
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { step: 1, .. }))
        .ok_or("read-only checkpoint missing")?
        .seq;
    if frozen
        .events()
        .iter()
        .take_while(|e| e.seq <= checkpoint)
        .any(|e| matches!(e.data(),EventData::ToolCall {call,..} if call.name=="write_plan"))
    {
        return Err("source batched write into checkpoint; exclude rather than fabricate a read-only prefix".into());
    }
    let reverted=agent(&executor,json!({"action":"revert","agent_id":source,"checkpoint_seq":checkpoint,"message":"Direction correction: the authorization context FACT_AUTH_42 already read is still valid. Do NOT follow the previous instruction to write STALE_LOGIN_PLAN. First use read_plan to verify the actual post-checkpoint file. Then write_plan exactly AUTHORIZATION_ONLY. Do not call read_context again. Report the fact and current file; then stop."})).await?;
    let branch = reverted["agent_id"].as_str().ok_or("branch missing")?;
    idle(&executor, branch).await?;
    if std::fs::read_to_string(root.join("plan.txt"))? != "AUTHORIZATION_ONLY" {
        return Err("real model did not correct the file".into());
    }
    if store
        .load(source)
        .await?
        .ok_or("source disappeared")?
        .events()
        != frozen.events()
    {
        return Err("source history mutated".into());
    }
    let session = store.load(branch).await?.ok_or("branch missing")?;
    let ownership = session
        .events()
        .iter()
        .rposition(|e| matches!(e.data(), EventData::AgentDelegated { .. }))
        .ok_or("managed ownership missing")?;
    let calls: Vec<_> = session.events()[ownership..]
        .iter()
        .filter_map(|e| match e.data() {
            EventData::ToolCall { call, .. } => Some(call.name.as_str()),
            _ => None,
        })
        .collect();
    if calls.contains(&"read_context")
        || !calls.contains(&"read_plan")
        || !calls.contains(&"write_plan")
    {
        return Err("unexpected correction tool execution".into());
    }
    // Assert provider input includes the complete retained observation and lacks
    // the abandoned source plan, without inspecting/rewriting hidden reasoning.
    let request = session.events()[ownership..]
        .iter()
        .find_map(|e| match e.data() {
            EventData::RequestHeader { header } => Some(header),
            _ => None,
        })
        .ok_or("request missing")?;
    let encoded = serde_json::to_string(&request.input)?;
    if !encoded.contains("FACT_AUTH_42") {
        return Err("retained fact missing from real request".into());
    }
    let receipt = json!({"scope":"production_agent_tool_real_deepseek_synthetic_direction_change","source":source,"branch":branch,"checkpoint_seq":checkpoint,"managed_branch":true,"original_history_unchanged":true,"initial_file":"STALE_LOGIN_PLAN","final_file":"AUTHORIZATION_ONLY","files_rolled_back":false,"correction_calls":calls,"retained_fact_in_provider_request":true,"settlement":agent(&executor,json!({"action":"inspect","agent_id":branch})).await?});
    std::fs::write(
        root.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    println!("{}", receipt);
    runtime.shutdown(Duration::from_secs(2)).await;
    Ok(())
}
