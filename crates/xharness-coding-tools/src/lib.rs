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

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_fs::{ReadCursor, ReadLimits, ReadOutcome, ReadStart};
use xharness_platform::NativePlatform;
use xharness_process::{ProcessOutput, SpawnSpec};
use xharness_terminal::{TerminalOpenSpec, TerminalRegistry, TerminalSignal};
use xharness_tools::{
    RegistryError, ToolConcurrency, ToolDefinition, ToolExecutionContext, ToolHandlerError,
    ToolOutput, ToolRegistry, ToolSpec,
};
use xharness_web::WebRuntime;

pub const STANDARD_TOOL_COUNT: usize = 14;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
const TOOL_TIMEOUT: Duration = Duration::from_secs(610);
const DEFAULT_READ_PAGE_BYTES: u64 = 32 * 1024;
const MAX_READ_PAGE_BYTES: u64 = 64 * 1024;
const DEFAULT_READ_PAGE_LINES: u64 = 400;
const MAX_READ_PAGE_LINES: u64 = 1_000;

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

    fn bash_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        ToolSpec::new(
            definition(
                "bash",
                "Run one Bash command under the active session permission policy. Pipeline failures propagate because pipefail is enabled; output is already bounded, so do not pipe side-effecting commands through head or tail only to limit display.",
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
                        .debug_parent(context.execution_id.as_str())
                        .args([
                            "--noprofile",
                            "--norc",
                            "-o",
                            "pipefail",
                            "-lc",
                            command.as_str(),
                        ])
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
                "Read one bounded UTF-8 file page and record its version for safe edits. Continue with next_cursor; use start_line or offset only for the first page.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "offset": {"type": "integer"},
                        "start_line": {"type": "integer"},
                        "cursor": {"type": "string"},
                        "limit": {"type": "integer"},
                        "line_limit": {"type": "integer"}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let session_id = Arc::clone(&session_id);
                async move {
                    let path = required_string(&context, "path")?;
                    let cursor = optional_string(&context, "cursor");
                    let offset = optional_u64(&context, "offset");
                    let start_line = optional_u64(&context, "start_line");
                    if usize::from(cursor.is_some())
                        + usize::from(offset.is_some())
                        + usize::from(start_line.is_some())
                        > 1
                    {
                        return Err(ToolHandlerError::new(
                            "read accepts only one of cursor, offset, or start_line",
                        ));
                    }
                    if cursor.is_some()
                        && (context.arguments.get("limit").is_some()
                            || context.arguments.get("line_limit").is_some())
                    {
                        return Err(ToolHandlerError::new(
                            "read cursor already fixes page limits; do not combine it with limit or line_limit",
                        ));
                    }
                    let start = if let Some(cursor) = cursor {
                        let cursor = ReadCursor::parse(cursor).map_err(handler_error)?;
                        let limits = cursor.limits();
                        if limits.max_bytes > MAX_READ_PAGE_BYTES as usize
                            || limits.max_lines > MAX_READ_PAGE_LINES as usize
                            || limits.max_line_bytes > 16 * 1024
                        {
                            return Err(ToolHandlerError::new(
                                "read cursor page limits exceed the model-facing safety cap",
                            ));
                        }
                        ReadStart::Cursor(cursor)
                    } else if let Some(start_line) = start_line {
                        if start_line == 0 {
                            return Err(ToolHandlerError::new(
                                "read start_line is one-based and must be greater than zero",
                            ));
                        }
                        ReadStart::Line(start_line)
                    } else {
                        ReadStart::Byte(offset.unwrap_or(0))
                    };
                    let limit = bounded_read_value(
                        optional_u64(&context, "limit").unwrap_or(DEFAULT_READ_PAGE_BYTES),
                        4,
                        MAX_READ_PAGE_BYTES,
                        "limit",
                    )?;
                    let line_limit = bounded_read_value(
                        optional_u64(&context, "line_limit")
                            .unwrap_or(DEFAULT_READ_PAGE_LINES),
                        1,
                        MAX_READ_PAGE_LINES,
                        "line_limit",
                    )?;
                    let target = platform.resolve_file(path).map_err(handler_error)?;
                    let result = platform
                        .filesystem()
                        .read_page(
                            &session_id,
                            &target,
                            start,
                            ReadLimits {
                                max_bytes: limit,
                                max_lines: line_limit,
                                max_line_bytes: 16 * 1024,
                            },
                        )
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
                            "page_start_offset": read.page_start_offset,
                            "page_start_line": read.page_start_line,
                            "captured_bytes": read.captured_bytes,
                            "total_bytes": read.total_bytes,
                            "next_cursor": read.next_cursor.map(|cursor| cursor.encode()),
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
                    let target = platform.resolve_file(path).map_err(handler_error)?;
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
                    let target = platform.resolve_file(path).map_err(handler_error)?;
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
                "List files matching a glob from the session workspace using ripgrep without a shell.",
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
                    let spec = SpawnSpec::new("rg", platform.workspace_root())
                        .debug_parent(context.execution_id.as_str())
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
                "Search text from the session workspace using ripgrep without shell interpretation.",
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
                    let spec = SpawnSpec::new("rg", platform.workspace_root())
                        .debug_parent(context.execution_id.as_str())
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
                        .debug_parent(context.execution_id.as_str())
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
    let root = platform.workspace_root();
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

fn bounded_read_value(
    value: u64,
    minimum: u64,
    maximum: u64,
    name: &str,
) -> Result<usize, ToolHandlerError> {
    if !(minimum..=maximum).contains(&value) {
        return Err(ToolHandlerError::new(format!(
            "read {name} must be between {minimum} and {maximum}"
        )));
    }
    usize::try_from(value)
        .map_err(|_| ToolHandlerError::new(format!("read {name} does not fit this platform")))
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

fn path_key(arguments: &Value) -> Option<String> {
    arguments.get("path")?.as_str().map(ToOwned::to_owned)
}

fn name_key(arguments: &Value) -> Option<String> {
    arguments.get("name")?.as_str().map(ToOwned::to_owned)
}
