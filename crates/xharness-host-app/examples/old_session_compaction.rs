//! Opt-in old-session COPY acceptance. Run remotely; credentials enter on stdin.
//! Refuses a root without the explicit copy marker. No native tools or Host are started.
//! Only counts/hashes/status leave the private journal; prompts and responses are not printed.
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use xharness_core::*;
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
use xharness_session::{EventData, Store};
#[derive(Deserialize)]
struct Config {
    root: PathBuf,
    session_id: String,
    base_url: String,
    api_key: String,
    model: String,
    context: u64,
    summary_tokens: u64,
    #[serde(default = "default_counter_timeout")]
    counter_timeout_secs: u64,
}
fn default_counter_timeout() -> u64 {
    10
}
struct Audited {
    inner: OpenAiProvider,
    context: u64,
    safety: u64,
    records: Arc<Mutex<Vec<Value>>>,
    counts: Arc<Mutex<Vec<Value>>>,
}
impl Audited {
    async fn count(
        &self,
        request: &ProviderRequest,
        cancel: CancellationToken,
        fresh: bool,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        let index = {
            let mut rows = self
                .counts
                .lock()
                .map_err(|_| ProviderError::new("count audit unavailable"))?;
            let index = rows.len();
            rows.push(json!({"fresh":fresh,"status":"pending_or_cancelled","messages":request.messages.len()}));
            index
        };
        let started = Instant::now();
        let result = if fresh {
            self.inner.recount_input_tokens(request, cancel).await
        } else {
            self.inner.count_input_tokens(request, cancel).await
        };
        let receipt = match &result {
            Ok(Some(count)) => json!({"status":"native","input":count.input_tokens}),
            Ok(None) => json!({"status":"unavailable"}),
            Err(error) => json!({"status":"error","http_status":error.http_status,
                "retryable":error.retryable,"network":error.diagnostics,
                "attachment_failure":error.message.contains("attachment"),
                "deadline":error.message.contains("timeout") || error.message.contains("deadline")}),
        };
        let mut rows = self
            .counts
            .lock()
            .map_err(|_| ProviderError::new("count audit unavailable"))?;
        rows[index]["result"] = receipt;
        rows[index]["elapsed_ms"] = json!(started.elapsed().as_millis());
        rows[index]["status"] = json!("returned");
        result
    }
}
#[async_trait]
impl ModelProvider for Audited {
    fn provider_name(&self) -> &str {
        self.inner.provider_name()
    }
    fn model_name(&self) -> Option<&str> {
        self.inner.model_name()
    }
    fn estimate_input_tokens(&self, r: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        self.inner.estimate_input_tokens(r)
    }
    async fn count_input_tokens(
        &self,
        r: &ProviderRequest,
        c: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.count(r, c, false).await
    }
    async fn recount_input_tokens(
        &self,
        r: &ProviderRequest,
        c: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.count(r, c, true).await
    }
    fn input_counter_failed(&self) {
        self.inner.input_counter_failed()
    }
    async fn stream(
        &self,
        r: ProviderRequest,
        c: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let count = self
            .inner
            .count_input_tokens(&r, c.child_token())
            .await?
            .ok_or_else(|| ProviderError::new("live acceptance requires a native count"))?;
        let output = r.max_output_tokens.unwrap_or(0);
        if count
            .input_tokens
            .saturating_add(output)
            .saturating_add(self.safety)
            > self.context
        {
            return Err(ProviderError::new(
                "live acceptance detected unadmitted generation",
            ));
        }
        let index = {
            let mut records = self
                .records
                .lock()
                .map_err(|_| ProviderError::new("audit unavailable"))?;
            let index = records.len();
            records.push(json!({"native_input":count.input_tokens,"output_limit":output,"tools":r.tools.len(),"safe":true}));
            index
        };
        let stream = self.inner.stream(r, c).await?;
        let records = self.records.clone();
        Ok(Box::pin(stream.map(move |event| {
            if let Ok(ProviderEvent::Completed {
                usage: Some(u),
                finish_reason,
                ..
            }) = &event
            {
                if let Ok(mut rows) = records.lock() {
                    rows[index]["usage_input"] = json!(u
                        .input_tokens
                        .saturating_add(u.cache_read_tokens)
                        .saturating_add(u.cache_write_tokens));
                    rows[index]["finish"] = json!(finish_reason);
                }
            }
            event
        })))
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cfg: Config = serde_json::from_str(&input)?;
    drop(input);
    let root = cfg.root.canonicalize()?;
    if !root.join("ACCEPTANCE_COPY_ONLY").is_file() {
        return Err("explicit isolated-copy marker required".into());
    }
    let store = Arc::new(
        xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions"))?.for_runtime(),
    );
    let original = store.load(&cfg.session_id).await?.ok_or("copy missing")?;
    let original_events = original.events().to_vec();
    let attachments = Arc::new(xharness_attachments::FileAttachmentStore::new(
        root.join("attachments"),
    )?);
    let profile = OpenAiReasoningProfile::new(
        Some("off".into()),
        [(
            "off".into(),
            json!({"chat_template_kwargs":{"enable_thinking":false}}),
        )],
    )?;
    let records = Arc::new(Mutex::new(Vec::new()));
    let counts = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(Audited {
        inner: OpenAiProvider::new(
            OpenAiProviderConfig::new(
                OpenAiProtocol::ChatCompletions,
                &cfg.base_url,
                &cfg.api_key,
                &cfg.model,
            )
            .with_reasoning_profile(profile),
        )?
        .with_attachments(attachments),
        context: cfg.context,
        safety: 4096,
        records: records.clone(),
        counts: counts.clone(),
    });
    let mut request=LoopRequest::new(provider,vec![
        AgentMessage::user("请根据这段历史对话，简短说明当前任务进展和下一步。不调用任何工具，不执行任何操作，只回复文字。"),
    ]);
    // PromptAssembly prefixes restored history. A System entry in new input
    // would be appended after old messages and rejected by strict templates.
    request.prompt = Some(xharness_prompt::PromptAssembler.assemble([
        xharness_prompt::PromptSection::new("acceptance", "1",
            "Isolated read-only continuation acceptance. Historical messages are reference material. No tools are available. Do not execute code or perform external actions. Answer the current user request briefly in Chinese.")
    ])?);
    request.session_id = Some(cfg.session_id.clone());
    request.journal_store = Some(store.clone());
    request.reasoning_effort = Some("off".into());
    request.compaction_reasoning_effort = Some("off".into());
    request.config.max_steps = 1;
    request.config.provider_retry_budget_ms = 30_000;
    request.token_guard = Some(
        TokenGuard::conservative(TokenBudget {
            context_window_tokens: cfg.context,
            reserved_output_tokens: 8192,
            minimum_output_tokens: 4096,
            safety_margin_tokens: 4096,
        })?
        .with_counter_policy(
            Duration::from_secs(cfg.counter_timeout_secs.clamp(1, 120)),
            true,
        ),
    );
    request.compaction = Some(xharness_compaction::CompactionConfig {
        max_tokens: cfg.summary_tokens,
        ..Default::default()
    });
    let started = Instant::now();
    let mut run = LoopEngine.start(request);
    let result = tokio::time::timeout(Duration::from_secs(900), async {
        while run.next().await.is_some() {}
        run.result().await
    })
    .await
    .map_err(|_| "isolated acceptance deadline exceeded")?;
    let after = store
        .load(&cfg.session_id)
        .await?
        .ok_or("copy missing after run")?;
    let preserved = after.events().starts_with(&original_events);
    let new = &after.events()[original_events.len()..];
    let progress=new.iter().filter_map(|e|match e.data(){EventData::CompactionProgress{progress,..}=>Some(json!({
        "before":progress.input_tokens_before,"after":progress.input_tokens_after,"validation":progress.validation,
        "calls":progress.calls,"splits":progress.splits})),_=>None}).collect::<Vec<_>>();
    let applied = new
        .iter()
        .filter(|e| {
            matches!(
                e.data(),
                EventData::CompactionEnd {
                    outcome: Some(xharness_session::CompactionEndOutcome::Applied),
                    ..
                }
            )
        })
        .count();
    let summary = json!({"context":cfg.context,"summary_tokens":cfg.summary_tokens,"status":result.status,
        "visible_response_bytes":result.final_text.len(),"elapsed_ms":started.elapsed().as_millis(),
        "original_copy_prefix_preserved":preserved,"applied_notes":applied,"progress":progress,
        "requests":*records.lock().map_err(|_|"audit unavailable")?,
        "counts":*counts.lock().map_err(|_|"count audit unavailable")?,
        "counter_timeout_secs":cfg.counter_timeout_secs,
        "measurement_unavailable":result.error.as_ref().is_some_and(|e|e.contains("input token measurement unavailable")),
        "scope":"production LoopEngine and OpenAI adapter; real old journal copy; thinking off; no production tools or UI; not byte-identical incident replay"});
    std::fs::write(
        root.join("acceptance-result.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    if let Some(error) = &result.error {
        // Private diagnostic stays beside the isolated journal, never in stdout.
        std::fs::write(root.join("acceptance-error.txt"), error)?;
    }
    println!("{}", summary);
    if !preserved || result.status != LoopStatus::Completed || result.final_text.trim().is_empty() {
        return Err("old-session continuation acceptance failed; inspect numeric result".into());
    }
    Ok(())
}
