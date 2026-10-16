//! Description-only change: preserve the schema and actual execution policy.
use super::*;

struct Never;
#[async_trait]
impl DelegationRuntime for Never {
    async fn execute(
        &self,
        _: &str,
        _: &str,
        _: AgentOperation,
        _: CancellationToken,
    ) -> Result<Value, String> {
        panic!("description inspection must not execute a child")
    }
}

#[test]
fn short_description_preserves_schema_and_execution_policy() {
    let spec = AgentTool::spec(Arc::new(Never), "parent");
    let definition = &spec.definition;
    let schema: Value = serde_json::from_str(include_str!("agent-tool-schema.json")).unwrap();
    assert_eq!(definition.name, "agent");
    assert_eq!(definition.parameters, schema);
    assert_eq!(spec.concurrency, ToolConcurrency::Parallel);
    assert_eq!(spec.timeout, Duration::from_secs(45));
    assert!(definition.description.len() <= 1600);
    for guidance in [
        "If a child is requested, start it instead of doing its task yourself",
        "start(task",
        "send(agent_id,message)",
        "inspect(optional agent_id)",
        "stop(agent_id)",
        "revert(agent_id,checkpoint_seq,message)",
        "no pending work or unresolved operations",
        "never undoes files or external effects",
        "use its returned agent_id",
        "No automatic revert or invented reasoning",
        "human's explicit request",
        "Do not choose overrides from task complexity or cost",
        "Host confirmation",
        "models[].start_selectors",
        "not availability guarantees",
        "admission, not success",
        "completion/failure arrives automatically",
        "last_settlement.outcome.provider_failure",
        "resumption requires the user",
        "Do not parallelize dependent edits",
    ] {
        assert!(
            definition.description.contains(guidance),
            "missing {guidance}"
        );
    }
    assert!(!definition.description.contains("ask_question"));
}
