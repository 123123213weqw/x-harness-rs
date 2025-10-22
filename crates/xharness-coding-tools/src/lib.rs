//! The standard fourteen-tool coding bundle.
//!
//! Tool names and schemas are stable host-facing contracts. Handlers consume
//! the shared [`xharness_platform::NativePlatform`]; platform-specific system
//! calls never leak into the model-facing layer.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_fs::{ReadLimits, ReadOutcome};
use xharness_platform::NativePlatform;
use xharness_process::{ProcessOutput, SpawnSpec};
use xharness_terminal::{TerminalOpenSpec, TerminalRegistry, TerminalSignal};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, RegistryError,
    ToolConcurrency, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolHandlerError,
    ToolOutput, ToolRegistry, ToolRequest, ToolSpec,
};
use xharness_web::WebRuntime;

pub const STANDARD_TOOL_COUNT: usize = 14;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
const TOOL_TIMEOUT: Duration = Duration::from_secs(610);

#[derive(Clone)]
pub struct CodingToolBundle {
    platform: Arc<NativePlatform>,
    terminal: Arc<TerminalRegistry>,
    web: Arc<WebRuntime>,
    session_id: Arc<str>,
    owner_id: Arc<str>,
}

impl CodingToolBundle {
    pub fn new(
        platform: Arc<NativePlatform>,
        terminal: Arc<TerminalRegistry>,
        web: Arc<WebRuntime>,
        session_id: impl Into<String>,
        owner_id: impl Into<String>,
    ) -> Self {
        Self {
            platform,
            terminal,
            web,
            session_id: Arc::from(session_id.into()),
            owner_id: Arc::from(owner_id.into()),
        }
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        vec![
            self.bash_spec(),
            self.read_spec(),
            self.write_spec(),
            self.edit_spec(),
            self.glob_spec(),
            self.grep_spec(),
            self.terminal_open_spec(),
            self.terminal_send_spec(),
            self.terminal_read_spec(),
            self.terminal_signal_spec(),
            self.terminal_close_spec(),
            self.terminal_list_spec(),
            self.web_search_spec(),
            self.web_fetch_spec(),
        ]
    }

    pub async fn register(&self, registry: &ToolRegistry) -> Result<(), RegistryError> {
        for spec in self.specs() {
            registry.register(spec).await?;
        }
        Ok(())
    }

    pub async fn registry(&self) -> Result<Arc<ToolRegistry>, RegistryError> {
        let registry = Arc::new(ToolRegistry::new());
        self.register(&registry).await?;
        Ok(registry)
    }

    /// Build the compatibility registrations consumed by the current
    /// `xharness-core` loop. Core owns the user approval handshake; the inner
    /// policy executor receives only that already-approved invocation.
    pub async fn core_specs(&self) -> Result<Vec<xharness_core::ToolSpec>, RegistryError> {
        let registry = self.registry().await?;
        let executor = Arc::new(
            ToolExecutor::new(Arc::clone(&registry))
                .with_approval_provider(Arc::new(CoreDelegatedApproval)),
        );
        let mut output = Vec::with_capacity(STANDARD_TOOL_COUNT);
        for definition in registry.definitions().await {
            let spec = registry
                .get(&definition.name)
                .await
                .expect("definition came from the same registry");
            let name = definition.name.clone();
            let executor = Arc::clone(&executor);
            let mut core = xharness_core::ToolSpec::new(
                definition.name,
                definition.description,
                definition.parameters,
                move |arguments, cancellation| {
                    let executor = Arc::clone(&executor);
                    let name = name.clone();
                    async move {
                        let arguments_json =
                            serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_owned());
                        let result = executor
                            .execute(
                                ToolRequest::new(name, arguments_json)
                                    .with_cancellation(cancellation),
                            )
                            .await;
                        bridge_result(result)
                    }
                },
            )
            .timeout(spec.timeout);
            core.concurrency = match spec.concurrency {
                ToolConcurrency::Parallel => xharness_core::ToolConcurrency::Parallel,
                ToolConcurrency::Keyed => xharness_core::ToolConcurrency::Keyed,
                ToolConcurrency::Exclusive => xharness_core::ToolConcurrency::Exclusive,
            };
            core.resource_key_resolver = spec.resource_key_resolver.clone();
            core.requires_approval = spec.requires_approval;
            output.push(core);
        }
        Ok(output)
    }

    fn bash_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        ToolSpec::new(
            definition(
                "bash",
                "Run one Bash command in the selected workspace sandbox.",
                json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "description": {"type": "string"},
                        "timeout_ms": {"type": "integer"},
                        "cwd": {"type": "string"}
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                async move {
                    let command = required_string(&context, "command")?;
                    let cwd = resolve_cwd(&platform, optional_string(&context, "cwd"))?;
                    let timeout = command_timeout(optional_u64(&context, "timeout_ms"))?;
                    let spec = SpawnSpec::new("/bin/bash", cwd)
                        .args(["--noprofile", "--norc", "-lc", command.as_str()])
                        .timeout(timeout)
                        .envs(managed_environment());
                    let output = run_process(platform, spec, &context.cancellation).await?;
                    Ok(process_output(output))
                }
            },
        )
        .with_timeout(TOOL_TIMEOUT)
        .requiring_approval(true)
    }

    fn read_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let session_id = Arc::clone(&self.session_id);
        ToolSpec::new(
            definition(
                "read",
                "Read a workspace file and record its version for safe later edits.",
                path_schema(false),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let session_id = Arc::clone(&session_id);
                async move {
                    let path = required_string(&context, "path")?;
                    let target = platform.filesystem().resolve(path).map_err(handler_error)?;
                    let result = platform
                        .filesystem()
                        .read(&session_id, &target, ReadLimits::default())
                        .await
                        .map_err(handler_error)?;
                    match result {
                        ReadOutcome::Absent => Ok(json_output(json!({
                            "path": target.display(), "absent": true
                        }))),
                        ReadOutcome::File(read) => Ok(json_output(json!({
                            "path": target.display(),
                            "content": read.text,
                            "bytes_read": read.bytes_read,
                            "truncated": read.truncated,
                            "sha256": read.version.sha256_hex(),
                            "diagnostics": format!("{:?}", read.diagnostics)
                        }))),
                    }
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
    }

    fn write_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let session_id = Arc::clone(&self.session_id);
        ToolSpec::new(
            definition(
                "write",
                "Create a file or replace a previously observed version atomically.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let session_id = Arc::clone(&session_id);
                async move {
                    let path = required_string(&context, "path")?;
                    let content = required_string(&context, "content")?;
                    let target = platform.filesystem().resolve(path).map_err(handler_error)?;
                    let result = platform
                        .filesystem()
                        .write(&session_id, &target, content.into_bytes())
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(json!({
                        "path": target.display(),
                        "created": result.created,
                        "bytes_written": result.bytes_written,
                        "sha256": result.version.sha256_hex()
                    })))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(path_key)
        .requiring_approval(true)
    }

    fn edit_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let session_id = Arc::clone(&self.session_id);
        ToolSpec::new(
            definition(
                "edit",
                "Replace exactly one literal in a previously read UTF-8 file.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old": {"type": "string"},
                        "new": {"type": "string"}
                    },
                    "required": ["path", "old", "new"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let session_id = Arc::clone(&session_id);
                async move {
                    let path = required_string(&context, "path")?;
                    let old = required_string(&context, "old")?;
                    let new = required_string(&context, "new")?;
                    let target = platform.filesystem().resolve(path).map_err(handler_error)?;
                    let result = platform
                        .filesystem()
                        .edit_literal(&session_id, &target, old, new)
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(json!({
                        "path": target.display(),
                        "bytes_written": result.bytes_written,
                        "sha256": result.version.sha256_hex()
                    })))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(path_key)
        .requiring_approval(true)
    }

    fn glob_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        ToolSpec::new(
            definition(
                "glob",
                "List workspace files matching a glob using ripgrep without a shell.",
                json!({
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "path": {"type": "string"}
                    },
                    "required": ["pattern"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                async move {
                    let pattern = required_string(&context, "pattern")?;
                    let mut args = vec![OsString::from("--files"), OsString::from("--color=never")];
                    args.extend([OsString::from("-g"), OsString::from(pattern)]);
                    if let Some(path) = optional_string(&context, "path") {
                        args.push(OsString::from("--"));
                        args.push(OsString::from(path));
                    }
                    let spec = SpawnSpec::new("rg", platform.filesystem().workspace_root())
                        .args(args)
                        .timeout(Duration::from_secs(30))
                        .envs(managed_environment());
                    Ok(process_output(
                        run_process(platform, spec, &context.cancellation).await?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
        .with_timeout(Duration::from_secs(35))
    }

    fn grep_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        ToolSpec::new(
            definition(
                "grep",
                "Search workspace text using ripgrep without shell interpretation.",
                json!({
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "path": {"type": "string"},
                        "case_sensitive": {"type": "boolean"}
                    },
                    "required": ["pattern"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                async move {
                    let pattern = required_string(&context, "pattern")?;
                    let mut args = vec![
                        OsString::from("--line-number"),
                        OsString::from("--no-heading"),
                        OsString::from("--color=never"),
                    ];
                    if optional_bool(&context, "case_sensitive") == Some(false) {
                        args.push(OsString::from("--ignore-case"));
                    }
                    args.push(OsString::from("--"));
                    args.push(OsString::from(pattern));
                    args.push(OsString::from(
                        optional_string(&context, "path").unwrap_or("."),
                    ));
                    let spec = SpawnSpec::new("rg", platform.filesystem().workspace_root())
                        .args(args)
                        .timeout(Duration::from_secs(30))
                        .envs(managed_environment());
                    Ok(process_output(
                        run_process(platform, spec, &context.cancellation).await?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
        .with_timeout(Duration::from_secs(35))
    }

    fn terminal_open_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_open",
                "Open a named persistent interactive Bash PTY.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "cwd": {"type": "string"}
                    },
                    "required": ["name"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let name = required_string(&context, "name")?;
                    let cwd = resolve_cwd(&platform, optional_string(&context, "cwd"))?;
                    let process = SpawnSpec::new("/bin/bash", cwd)
                        .args(["--noprofile", "--norc", "-i"])
                        .envs(managed_environment());
                    let process = platform
                        .prepare_spawn(process)
                        .await
                        .map_err(handler_error)?;
                    let result = terminal
                        .open(TerminalOpenSpec {
                            owner: owner.to_string(),
                            name,
                            process,
                        })
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .requiring_approval(true)
    }

    fn terminal_send_spec(&self) -> ToolSpec {
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_send",
                "Send text to a persistent terminal and return newly observed output.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "input": {"type": "string"},
                        "append_newline": {"type": "boolean"},
                        "settle_ms": {"type": "integer"}
                    },
                    "required": ["name", "input"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let name = required_string(&context, "name")?;
                    let before = terminal
                        .read(&owner, &name, None)
                        .await
                        .map_err(handler_error)?
                        .cursor;
                    let mut input = required_string(&context, "input")?.into_bytes();
                    if optional_bool(&context, "append_newline").unwrap_or(true) {
                        input.push(b'\n');
                    }
                    terminal
                        .send(&owner, &name, &input)
                        .await
                        .map_err(handler_error)?;
                    let settle = optional_u64(&context, "settle_ms")
                        .unwrap_or(100)
                        .min(5_000);
                    tokio::time::sleep(Duration::from_millis(settle)).await;
                    let result = terminal
                        .read(&owner, &name, Some(before))
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(name_key)
        .requiring_approval(true)
    }

    fn terminal_read_spec(&self) -> ToolSpec {
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_read",
                "Read terminal scrollback from an optional monotonic byte cursor.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "cursor": {"type": "integer"}
                    },
                    "required": ["name"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let result = terminal
                        .read(
                            &owner,
                            &required_string(&context, "name")?,
                            optional_u64(&context, "cursor"),
                        )
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(name_key)
    }

    fn terminal_signal_spec(&self) -> ToolSpec {
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_signal",
                "Send an allowed signal to the terminal foreground process group.",
                json!({
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "signal": {"type": "string", "enum": ["interrupt", "terminate", "kill", "suspend", "hangup"]}
                    },
                    "required": ["name", "signal"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let name = required_string(&context, "name")?;
                    let signal = match required_string(&context, "signal")?.as_str() {
                        "interrupt" => TerminalSignal::Interrupt,
                        "terminate" => TerminalSignal::Terminate,
                        "kill" => TerminalSignal::Kill,
                        "suspend" => TerminalSignal::Suspend,
                        "hangup" => TerminalSignal::Hangup,
                        _ => return Err(ToolHandlerError::new("unsupported terminal signal")),
                    };
                    terminal.signal(&owner, &name, signal).await.map_err(handler_error)?;
                    Ok(json_output(json!({"name": name, "signal": signal})))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(name_key)
        .requiring_approval(true)
    }

    fn terminal_close_spec(&self) -> ToolSpec {
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_close",
                "Terminate and remove a named persistent terminal.",
                name_schema(),
            ),
            move |context| {
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let result = terminal
                        .close(&owner, &required_string(&context, "name")?)
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(name_key)
        .requiring_approval(true)
    }

    fn terminal_list_spec(&self) -> ToolSpec {
        let terminal = Arc::clone(&self.terminal);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "terminal_list",
                "List persistent terminals owned by this agent.",
                empty_schema(),
            ),
            move |_context| {
                let terminal = Arc::clone(&terminal);
                let owner = Arc::clone(&owner);
                async move {
                    let result = terminal.list(&owner).await.map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
    }

    fn web_search_spec(&self) -> ToolSpec {
        let web = Arc::clone(&self.web);
        ToolSpec::new(
            definition(
                "web_search",
                "Search the Web using the explicitly configured search provider.",
                json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer"}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let web = Arc::clone(&web);
                async move {
                    let result = web
                        .search(
                            &required_string(&context, "query")?,
                            optional_u64(&context, "limit")
                                .and_then(|value| usize::try_from(value).ok()),
                            &context.cancellation,
                        )
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
    }

    fn web_fetch_spec(&self) -> ToolSpec {
        let web = Arc::clone(&self.web);
        ToolSpec::new(
            definition(
                "web_fetch",
                "Fetch one anonymous public HTTP(S) page with bounded content extraction.",
                json!({
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let web = Arc::clone(&web);
                async move {
                    let result = web
                        .fetch(&required_string(&context, "url")?, &context.cancellation)
                        .await
                        .map_err(handler_error)?;
                    Ok(json_output(
                        serde_json::to_value(result).map_err(handler_error)?,
                    ))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
        .with_timeout(Duration::from_secs(35))
    }
}

struct CoreDelegatedApproval;

#[async_trait]
impl ApprovalProvider for CoreDelegatedApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Ok(ApprovalDecision::Approved)
    }
}

fn bridge_result(result: xharness_tools::ToolResult) -> xharness_core::ToolResult {
    match (result.output, result.failure) {
        (Some(output), None) => xharness_core::ToolResult {
            ok: true,
            content: output.content,
            error: String::new(),
            truncated: false,
            metadata: output.metadata,
        },
        (_, Some(failure)) => xharness_core::ToolResult::failure(failure.message),
        (None, None) => xharness_core::ToolResult::failure("tool executor returned no outcome"),
    }
}

trait SpawnSpecExt {
    fn envs(self, environment: BTreeMap<OsString, OsString>) -> Self;
}

impl SpawnSpecExt for SpawnSpec {
    fn envs(mut self, environment: BTreeMap<OsString, OsString>) -> Self {
        self.env = environment;
        self
    }
}

async fn run_process(
    platform: Arc<NativePlatform>,
    spec: SpawnSpec,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, ToolHandlerError> {
    let handle = platform.spawn(spec).await.map_err(handler_error)?;
    let control = handle.cancellation();
    let wait = handle.wait();
    tokio::pin!(wait);
    tokio::select! {
        result = &mut wait => result.map_err(handler_error),
        _ = cancellation.cancelled() => {
            control.cancel();
            wait.await.map_err(handler_error)
        }
    }
}

fn process_output(output: ProcessOutput) -> ToolOutput {
    json_output(json!({
        "pid": output.pid,
        "success": output.status.success,
        "exit_code": output.status.code,
        "signal": output.status.signal,
        "termination": format!("{:?}", output.termination).to_ascii_lowercase(),
        "stdout": output.stdout.text,
        "stderr": output.stderr.text,
        "stdout_truncated": output.stdout.truncated,
        "stderr_truncated": output.stderr.truncated,
        "stdout_bytes": output.stdout.bytes_read,
        "stderr_bytes": output.stderr.bytes_read
    }))
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput {
        content: serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        metadata: Some(value),
    }
}

fn managed_environment() -> BTreeMap<OsString, OsString> {
    let mut environment = BTreeMap::new();
    environment.insert(
        OsString::from("PATH"),
        std::env::var_os("PATH")
            .unwrap_or_else(|| OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")),
    );
    environment.insert(OsString::from("LANG"), OsString::from("C.UTF-8"));
    environment.insert(OsString::from("TERM"), OsString::from("xterm-256color"));
    environment.insert(OsString::from("NO_COLOR"), OsString::from("1"));
    environment.insert(OsString::from("PAGER"), OsString::from("cat"));
    environment.insert(OsString::from("GIT_PAGER"), OsString::from("cat"));
    environment
}

fn resolve_cwd(
    platform: &NativePlatform,
    requested: Option<&str>,
) -> Result<PathBuf, ToolHandlerError> {
    let root = platform.filesystem().workspace_root();
    let path = match requested {
        None | Some("") => root.to_owned(),
        Some(path) if Path::new(path).is_absolute() => PathBuf::from(path),
        Some(path) => root.join(path),
    };
    fs::canonicalize(&path).map_err(handler_error)
}

fn command_timeout(value: Option<u64>) -> Result<Duration, ToolHandlerError> {
    let duration = value
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT);
    if duration.is_zero() || duration > MAX_COMMAND_TIMEOUT {
        return Err(ToolHandlerError::new(format!(
            "timeout_ms must be between 1 and {}",
            MAX_COMMAND_TIMEOUT.as_millis()
        )));
    }
    Ok(duration)
}

fn required_string(context: &ToolExecutionContext, name: &str) -> Result<String, ToolHandlerError> {
    context
        .arguments
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolHandlerError::new(format!("missing string argument {name:?}")))
}

fn optional_string<'a>(context: &'a ToolExecutionContext, name: &str) -> Option<&'a str> {
    context.arguments.get(name).and_then(Value::as_str)
}

fn optional_u64(context: &ToolExecutionContext, name: &str) -> Option<u64> {
    context.arguments.get(name).and_then(Value::as_u64)
}

fn optional_bool(context: &ToolExecutionContext, name: &str) -> Option<bool> {
    context.arguments.get(name).and_then(Value::as_bool)
}

fn handler_error(error: impl std::fmt::Display) -> ToolHandlerError {
    ToolHandlerError::new(error.to_string())
}

fn definition(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition::new(name, description, parameters)
}

fn empty_schema() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": false})
}

fn name_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
        "additionalProperties": false
    })
}

fn path_schema(content: bool) -> Value {
    if content {
        json!({
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
            "additionalProperties": false
        })
    } else {
        json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": false
        })
    }
}

fn path_key(arguments: &Value) -> Option<String> {
    arguments.get("path")?.as_str().map(ToOwned::to_owned)
}

fn name_key(arguments: &Value) -> Option<String> {
    arguments.get("name")?.as_str().map(ToOwned::to_owned)
}
