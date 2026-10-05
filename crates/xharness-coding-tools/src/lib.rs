//! The standard coding, background-job and Web tool bundle.
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

use serde::Serialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_fs::{ReadCursor, ReadLimits, ReadOutcome, ReadStart};
use xharness_jobs::{
    JobCancel, JobLease, JobOutcome, JobOutputCursor, JobRegistry, JobSnapshot, JobStatus,
    KillResult,
};
use xharness_platform::NativePlatform;
use xharness_process::shell::{executable_search_path, Shell, ShellError};
use xharness_process::{
    scrub_secret_env, ProcessHandle, ProcessOutput, ProcessOutputCursor, ProcessOutputObserver,
    SpawnSpec, TerminationReason,
};
use xharness_tools::{
    RegistryError, ToolConcurrency, ToolDefinition, ToolExecutionContext, ToolHandlerError,
    ToolOutput, ToolRegistry, ToolSpec,
};
use xharness_web::WebRuntime;

pub const STANDARD_TOOL_COUNT: usize = 11;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
const TOOL_TIMEOUT: Duration = Duration::from_secs(610);
const DEFAULT_JOB_WAIT: Duration = Duration::from_secs(30);
const MAX_JOB_WAIT: Duration = Duration::from_secs(600);
const DEFAULT_READ_PAGE_BYTES: u64 = 32 * 1024;
const MAX_READ_PAGE_BYTES: u64 = 64 * 1024;
const DEFAULT_READ_PAGE_LINES: u64 = 400;
const MAX_READ_PAGE_LINES: u64 = 1_000;

/// Model-facing job state. Registry ownership, notification bookkeeping,
/// retention limits and producer process ids stay inside the host.
#[derive(Debug, Serialize)]
struct PublicJobSnapshot {
    id: String,
    kind: String,
    label: String,
    status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at_ms: Option<u64>,
}

impl From<JobSnapshot> for PublicJobSnapshot {
    fn from(snapshot: JobSnapshot) -> Self {
        Self {
            id: snapshot.id.to_string(),
            kind: snapshot.kind,
            label: snapshot.label,
            status: snapshot.status,
            detail: snapshot.detail,
            started_at_ms: snapshot.started_at_ms,
            finished_at_ms: snapshot.finished_at_ms,
        }
    }
}

#[async_trait::async_trait]
pub trait MediaReader: Send + Sync {
    async fn read(
        &self,
        path: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<ToolOutput>, ToolHandlerError>;
}
#[derive(Clone)]
pub struct CodingToolBundle {
    platform: Arc<NativePlatform>,
    jobs: Arc<JobRegistry>,
    web: Arc<WebRuntime>,
    session_id: Arc<str>,
    owner_id: Arc<str>,
    media_reader: Option<Arc<dyn MediaReader>>,
    shell: Result<Shell, ShellError>,
}

impl CodingToolBundle {
    pub fn new(
        platform: Arc<NativePlatform>,
        jobs: Arc<JobRegistry>,
        web: Arc<WebRuntime>,
        session_id: impl Into<String>,
        owner_id: impl Into<String>,
    ) -> Self {
        Self {
            platform,
            jobs,
            web,
            session_id: Arc::from(session_id.into()),
            owner_id: Arc::from(owner_id.into()),
            media_reader: None,
            shell: Shell::discover(),
        }
    }

    /// Pin a pre-resolved shell. The description and handler use the same selection.
    pub fn with_shell(mut self, shell: Shell) -> Self {
        self.shell = Ok(shell);
        self
    }

    pub fn with_media_reader(mut self, reader: Arc<dyn MediaReader>) -> Self {
        self.media_reader = Some(reader);
        self
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        vec![
            self.shell_spec(),
            self.job_output_spec(),
            self.job_list_spec(),
            self.job_kill_spec(),
            self.read_spec(),
            self.write_spec(),
            self.edit_spec(),
            self.glob_spec(),
            self.grep_spec(),
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

    fn shell_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let jobs = Arc::clone(&self.jobs);
        let owner = Arc::clone(&self.owner_id);
        let shell = self.shell.clone();
        ToolSpec::new(
            definition(
                native_shell_name(),
                &native_shell_description(&shell),
                json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Script in the selected shell dialect. Mutually exclusive with program/args."},
                        "program": {"type": "string", "description": "Executable to launch directly without a shell. Mutually exclusive with command."},
                        "args": {"type": "array", "items": {"type": "string"}, "description": "Literal argument vector for program; no shell expansion."},
                        "description": {"type": "string"},
                        "timeout_ms": {"type": "integer"},
                        "cwd": {"type": "string"},
                        "run_in_background": {
                            "type": "boolean",
                            "description": "Run as a managed background job. Returns immediately and has no command timeout."
                        }
                    },
                    "description": "Provide exactly one of command or program. args is only valid with program.",
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let jobs = Arc::clone(&jobs);
                let owner = Arc::clone(&owner);
                let shell = shell.clone();
                async move {
                    let invocation = process_invocation(&context.arguments, &shell)?;
                    let cwd = resolve_cwd(&platform, optional_string(&context, "cwd"))?;
                    let background = optional_bool(&context, "run_in_background").unwrap_or(false);
                    if background && context.arguments.get("timeout_ms").is_some() {
                        return Err(ToolHandlerError::new(
                            "timeout_ms cannot be combined with run_in_background=true; manage the job with job_output/job_kill",
                        ));
                    }
                    let mut spec = SpawnSpec::new(invocation.program, cwd)
                        .debug_parent(context.execution_id.as_str())
                        .args(invocation.args)
                        .envs(managed_environment());
                    if !background {
                        spec = spec.timeout(command_timeout_argument(&context)?);
                    }
                    if background {
                        let reservation = jobs
                            .reserve(
                                owner.to_string(),
                                native_shell_name(),
                                invocation.label,
                                None,
                            )
                            .map_err(handler_error)?;
                        let handle = platform.spawn(spec).await.map_err(handler_error)?;
                        let pid = handle.pid();
                        let cancellation = handle.cancellation();
                        let observer = handle.output_observer();
                        let cancel: JobCancel = Arc::new(move |_| {
                            let _ = cancellation.cancel();
                            Ok(())
                        });
                        let (job_id, lease) = match reservation.commit(Some(pid), cancel) {
                            Ok(started) => started,
                            Err(error) => {
                                let _ = handle.cancel_and_wait().await;
                                return Err(handler_error(error));
                            }
                        };
                        tokio::spawn(run_background_process(handle, observer, lease));
                        return Ok(json_output(json!({
                            "kind": "background",
                            "job_id": job_id,
                            "status": "running",
                            "pid": pid,
                            "execution": invocation.metadata
                        })));
                    }
                    let output = run_process(platform, spec, &context.cancellation).await?;
                    let command_failure = if output.termination == TerminationReason::Exited
                        && output.status.success
                    {
                        None
                    } else {
                        Some(match output.termination {
                            TerminationReason::TimedOut => "shell command timed out".to_owned(),
                            TerminationReason::Cancelled => "shell command was cancelled".to_owned(),
                            TerminationReason::Exited => match output.status.code {
                                Some(code) => format!("shell command exited with code {code}"),
                                None => format!(
                                    "shell command exited by signal {}",
                                    output.status.signal.unwrap_or_default()
                                ),
                            },
                        })
                    };
                    let mut value = process_output_value(output);
                    value["kind"] = Value::String("foreground".to_owned());
                    value["execution"] = invocation.metadata;
                    let mut result = json_output(value);
                    result.command_failure = command_failure;
                    Ok(result)
                }
            },
        )
        .with_timeout(TOOL_TIMEOUT)
        .with_repetition_observation(process_repetition_observation)
        .requiring_approval(true)
    }

    fn job_output_spec(&self) -> ToolSpec {
        let jobs = Arc::clone(&self.jobs);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "job_output",
                "Read bounded output from one managed background job without consuming it. Pass the returned next_cursor on the next read; omitting it replays the retained window. Set wait=true only when blocked on this job; a wait timeout returns the still-running status and is not an error. Track every job id and collect relevant jobs before the final answer; do not busy-poll or duplicate their work.",
                json!({
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "cursor": {
                            "type": "object",
                            "properties": {
                                "job_id": {"type": "string"},
                                "stdout": {"type": "integer", "minimum": 0},
                                "stderr": {"type": "integer", "minimum": 0}
                            },
                            "required": ["job_id", "stdout", "stderr"],
                            "additionalProperties": false
                        },
                        "wait": {"type": "boolean"},
                        "timeout_ms": {
                            "type": "integer",
                            "description": "Positive wait bound; defaults to 30000 and is capped at 600000. Only used with wait=true."
                        }
                    },
                    "required": ["job_id"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let jobs = Arc::clone(&jobs);
                let owner = Arc::clone(&owner);
                async move {
                    let job_id = required_string(&context, "job_id")?;
                    let cursor = match context.arguments.get("cursor") {
                        Some(value) => serde_json::from_value::<JobOutputCursor>(value.clone())
                            .map_err(handler_error)?,
                        None => JobOutputCursor::start(&job_id),
                    };
                    let wait = optional_bool(&context, "wait").unwrap_or(false);
                    if !wait && context.arguments.get("timeout_ms").is_some() {
                        return Err(ToolHandlerError::new(
                            "timeout_ms is only valid when wait=true",
                        ));
                    }
                    if wait {
                        let timeout = job_wait_argument(&context)?;
                        tokio::select! {
                            result = jobs.wait(&owner, &job_id, timeout) => {
                                result.map_err(handler_error)?;
                            }
                            _ = context.cancellation.cancelled() => {
                                return Err(ToolHandlerError::new("job_output wait cancelled; the background job is still running"));
                            }
                        }
                    }
                    let read = jobs
                        .read_since(&owner, &job_id, &cursor)
                        .map_err(handler_error)?;
                    Ok(json_output(json!({
                        "stdout": read.stdout,
                        "stderr": read.stderr,
                        "stdout_truncated": read.stdout_truncated,
                        "stderr_truncated": read.stderr_truncated,
                        "next_cursor": read.next_cursor,
                        "snapshot": PublicJobSnapshot::from(read.snapshot),
                    })))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(job_id_key)
        .with_timeout(TOOL_TIMEOUT)
        .with_repetition_exemption()
    }

    fn job_list_spec(&self) -> ToolSpec {
        let jobs = Arc::clone(&self.jobs);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "job_list",
                "List managed background jobs owned by this session, including running, stopping and retained terminal jobs. Other sessions are never exposed.",
                empty_schema(),
            ),
            move |_context| {
                let jobs = Arc::clone(&jobs);
                let owner = Arc::clone(&owner);
                async move {
                    let result = jobs
                        .list(&owner)
                        .into_iter()
                        .map(PublicJobSnapshot::from)
                        .collect::<Vec<_>>();
                    Ok(json_output(json!({"jobs": result})))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
        .with_repetition_exemption()
    }

    fn job_kill_spec(&self) -> ToolSpec {
        let jobs = Arc::clone(&self.jobs);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "job_kill",
                "Request idempotent termination of one managed background job. Killing an already-finished job succeeds with already_finished. Use this instead of kill/pkill shell commands so lifecycle and cleanup remain observable.",
                json!({
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "reason": {"type": "string"}
                    },
                    "required": ["job_id"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let jobs = Arc::clone(&jobs);
                let owner = Arc::clone(&owner);
                async move {
                    let job_id = required_string(&context, "job_id")?;
                    let result = jobs
                        .kill(&owner, &job_id, optional_string(&context, "reason"))
                        .map_err(handler_error)?;
                    Ok(json_output(json!({
                        "job_id": job_id,
                        "result": match result {
                            KillResult::Requested => "requested",
                            KillResult::AlreadyFinished => "already_finished",
                        },
                        "job": PublicJobSnapshot::from(
                            jobs.get(&owner, &job_id).map_err(handler_error)?
                        )
                    })))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(job_id_key)
    }

    fn read_spec(&self) -> ToolSpec {
        let platform = Arc::clone(&self.platform);
        let session_id = Arc::clone(&self.session_id);
        let media_reader = self.media_reader.clone();
        ToolSpec::new(
            definition(
                "read",
                "Read a bounded UTF-8 file page and record its version for safe edits. For a line range use path + start_line + line_limit. limit is bytes, NOT lines. Continue with path + next_cursor as cursor, without other pagination parameters. A partial page is not the entire file.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path relative to the workspace, or an absolute path within the active authorized read roots. No parent traversal or symlink escape."},
                        "offset": {"type": "integer", "minimum": 0, "description": "Zero-based UTF-8 byte offset, NOT a line number. Use at most one of offset, start_line, cursor."},
                        "start_line": {"type": "integer", "minimum": 1, "description": "One-based starting line. Example: start_line=100, line_limit=80 reads at most 80 lines beginning at line 100, also subject to byte limits."},
                        "cursor": {"type": "string", "description": "Copy next_cursor unchanged from the previous read. Pass only path and cursor; it fixes the version, position and limits. If stale, re-read without cursor."},
                        "limit": {"type": "integer", "minimum": 4, "maximum": MAX_READ_PAGE_BYTES, "description": "Maximum UTF-8 bytes per page, NOT lines. Default 32768; range 4..65536. Keep omitted for ordinary line reads."},
                        "line_limit": {"type": "integer", "minimum": 1, "maximum": MAX_READ_PAGE_LINES, "description": "Maximum lines per page. Default 400; range 1..1000. Byte and long-line limits can end a page earlier; use next_cursor for continuation."}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let media_reader=media_reader.clone();
                let platform = Arc::clone(&platform);
                let session_id = Arc::clone(&session_id);
                async move {
                    let path = required_string(&context, "path")?;
                    if let Some(reader)=&media_reader {
                        if let Some(output)=reader.read(&path,&context.cancellation).await? {
                            if ["cursor","offset","start_line","limit","line_limit"].iter().any(|k|context.arguments.get(*k).is_some()) {return Err(ToolHandlerError::new("image reads do not support text pagination"));}
                            return Ok(output);
                        }
                    }
                    let cursor = optional_string(&context, "cursor");
                    let offset = read_u64(&context, "offset")?;
                    let start_line = read_u64(&context, "start_line")?;
                    if usize::from(cursor.is_some())
                        + usize::from(offset.is_some())
                        + usize::from(start_line.is_some())
                        > 1
                    {
                        return Err(ToolHandlerError::new(
                            "read accepts only one of cursor, offset, or start_line. For lines use {path, start_line, line_limit}; for continuation use {path, cursor: next_cursor}.",
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
                        read_u64(&context, "limit")?.unwrap_or(DEFAULT_READ_PAGE_BYTES),
                        4,
                        MAX_READ_PAGE_BYTES,
                        "limit",
                    )?;
                    let line_limit = bounded_read_value(
                        read_u64(&context, "line_limit")?
                            .unwrap_or(DEFAULT_READ_PAGE_LINES),
                        1,
                        MAX_READ_PAGE_LINES,
                        "line_limit",
                    )?;
                    let (filesystem, target) = platform.resolve_read_file(path).map_err(handler_error)?;
                    let result = filesystem
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
                    search_process_output(
                        run_process(platform, spec, &context.cancellation).await?,
                    )
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
                    search_process_output(
                        run_process(platform, spec, &context.cancellation).await?,
                    )
                }
            },
        )
        .with_concurrency(ToolConcurrency::Parallel)
        .with_timeout(Duration::from_secs(35))
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
                "Fetch one anonymous public HTTP(S) page as a bounded reader summary. Scripts, styles and boilerplate are removed; use focus when looking for specific facts.",
                json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "focus": {
                            "type": "string",
                            "description": "Optional topic or question used to rank relevant page sections."
                        }
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let web = Arc::clone(&web);
                async move {
                    let url = required_string(&context, "url")?;
                    let focus = optional_string(&context, "focus");
                    let result = web
                        .fetch_with_focus(&url, focus, &context.cancellation)
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

fn search_process_output(output: ProcessOutput) -> Result<ToolOutput, ToolHandlerError> {
    let accepted = output.termination == TerminationReason::Exited
        && output.status.signal.is_none()
        && matches!(output.status.code, Some(0 | 1));
    let no_matches = accepted && output.status.code == Some(1);
    let mut value = process_output_value(output);
    value["no_matches"] = json!(no_matches);
    if accepted {
        Ok(json_output(value))
    } else {
        Err(ToolHandlerError::new(format!(
            "search process failed: {value}"
        )))
    }
}

fn process_output_value(output: ProcessOutput) -> Value {
    json!({
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
        "stderr_bytes": output.stderr.bytes_read,
        "stdout_omitted_bytes": output.stdout.omitted_bytes,
        "stderr_omitted_bytes": output.stderr.omitted_bytes
    })
}

async fn run_background_process(
    handle: ProcessHandle,
    mut observer: ProcessOutputObserver,
    lease: JobLease,
) {
    let mut cursor = ProcessOutputCursor::default();
    let wait = handle.wait();
    tokio::pin!(wait);
    loop {
        let snapshot = observer.snapshot_since(cursor);
        publish_process_snapshot(&lease, &snapshot);
        cursor = snapshot.cursor;
        let revision = snapshot.revision;
        tokio::select! {
            result = &mut wait => {
                let final_snapshot = observer.snapshot_since(cursor);
                publish_process_snapshot(&lease, &final_snapshot);
                let outcome = match result {
                    Ok(output) => background_process_outcome(&output),
                    Err(error) => JobOutcome::failed(format!("process infrastructure failed: {error}")),
                };
                lease.finish(outcome);
                return;
            }
            changed = observer.changed(revision) => {
                if !changed && snapshot.finished {
                    // The result channel is published immediately after the
                    // observer's terminal revision; yield to that branch.
                    tokio::task::yield_now().await;
                }
            }
        }
    }
}

fn publish_process_snapshot(lease: &JobLease, snapshot: &xharness_process::ProcessOutputSnapshot) {
    lease.publish_stdout(snapshot.stdout.text.as_bytes());
    lease.publish_stderr(snapshot.stderr.text.as_bytes());
    if snapshot.stdout.truncated {
        lease.publish_stderr(
            b"\n[some stdout was dropped from the bounded live window before collection]\n",
        );
    }
    if snapshot.stderr.truncated {
        lease.publish_stderr(
            b"\n[some stderr was dropped from the bounded live window before collection]\n",
        );
    }
}

fn background_process_outcome(output: &ProcessOutput) -> JobOutcome {
    let detail = if let Some(code) = output.status.code {
        format!("exit code: {code}")
    } else if let Some(signal) = output.status.signal {
        format!("signal: {signal}")
    } else {
        "process exited without a portable status".to_owned()
    };
    match output.termination {
        TerminationReason::Cancelled => JobOutcome::killed(detail),
        TerminationReason::TimedOut => JobOutcome::failed(format!("timed out; {detail}")),
        TerminationReason::Exited if output.status.signal.is_some() => JobOutcome::killed(detail),
        TerminationReason::Exited if output.status.success => JobOutcome::completed(detail),
        TerminationReason::Exited => JobOutcome::failed(detail),
    }
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput {
        content: serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        metadata: Some(value),
        command_failure: None,
    }
}

fn managed_environment() -> BTreeMap<OsString, OsString> {
    // Match the reference Harness environment boundary: preserve ordinary
    // runtime/tool configuration, but never leak ambient credentials or
    // Harness-private control values into model-launched processes.
    let mut environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
    scrub_secret_env(&mut environment);
    environment.retain(|name, _| {
        !name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("XHARNESS_")
    });
    environment.retain(|name, _| !name.eq_ignore_ascii_case("PATH"));
    environment.insert(OsString::from("PATH"), managed_path());
    #[cfg(unix)]
    environment.insert(OsString::from("LANG"), OsString::from("C.UTF-8"));
    #[cfg(unix)]
    environment.insert(OsString::from("TERM"), OsString::from("xterm-256color"));
    #[cfg(windows)]
    environment.insert(
        OsString::from("POWERSHELL_TELEMETRY_OPTOUT"),
        OsString::from("1"),
    );
    #[cfg(windows)]
    environment.insert(
        OsString::from("POWERSHELL_UPDATECHECK"),
        OsString::from("Off"),
    );
    environment.insert(OsString::from("NO_COLOR"), OsString::from("1"));
    environment.insert(OsString::from("PAGER"), OsString::from("cat"));
    environment.insert(OsString::from("GIT_PAGER"), OsString::from("cat"));
    environment
}

/// Build a deterministic executable search path instead of trusting the
/// sparse `/usr/bin:/bin:/usr/sbin:/sbin` environment supplied by launchd.
/// Release archives place helper binaries such as `rg` beside the Host, so
/// the current executable directory must win over inherited system paths.
fn managed_path() -> OsString {
    executable_search_path()
}

#[cfg(unix)]
const fn native_shell_name() -> &'static str {
    "bash"
}

#[cfg(windows)]
const fn native_shell_name() -> &'static str {
    "pwsh"
}

fn native_shell_description(shell: &Result<Shell, ShellError>) -> String {
    let selection = match shell {
        Ok(shell) => format!(
            "Selected shell: {} at {:?}. {}",
            shell.kind.label(),
            shell.program,
            shell.syntax_hint()
        ),
        Err(error) => format!(
            "Shell unavailable: {error}. Direct program + args execution remains available."
        ),
    };
    format!("Run one managed process under the active session permission policy. Provide exactly one of command (shell script) or program (direct executable with literal args). {selection} For long-running non-interactive work that begins now prefer run_in_background=true: the call returns a job id immediately; collect it with job_output and stop it with job_kill. Use automation for user-requested future reminders (mode=reminder) and delayed tasks (mode=task). Native session tools may suit interactive or existing external sessions; keep their status, logs, and stop method trackable, and do not assume detached processes survive Host shutdown or cancellation. No shell state persists between calls. A failed invocation is never replayed in another interpreter.")
}

struct ProcessInvocation {
    program: OsString,
    args: Vec<OsString>,
    label: String,
    metadata: Value,
}

fn process_invocation(
    arguments: &Value,
    shell: &Result<Shell, ShellError>,
) -> Result<ProcessInvocation, ToolHandlerError> {
    match (arguments.get("command"), arguments.get("program")) {
        (Some(command), None) if arguments.get("args").is_none() => {
            let command = command
                .as_str()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| ToolHandlerError::new("command must be a non-empty string"))?;
            let shell = shell.as_ref().map_err(handler_error)?;
            Ok(ProcessInvocation {
                program: shell.program.clone().into_os_string(),
                args: shell.command_args(command),
                label: command.to_owned(),
                metadata: json!({"mode":"shell", "shell":shell.kind.label(), "program":shell.program}),
            })
        }
        (None, Some(program)) => {
            let program = program
                .as_str()
                .filter(|v| !v.trim().is_empty() && !v.contains('\0'))
                .ok_or_else(|| {
                    ToolHandlerError::new("program must be a non-empty executable name or path")
                })?;
            let args = arguments
                .get("args")
                .map(|value| {
                    value
                        .as_array()
                        .ok_or_else(|| ToolHandlerError::new("args must be an array of strings"))?
                        .iter()
                        .map(|arg| {
                            arg.as_str()
                                .filter(|v| !v.contains('\0'))
                                .map(OsString::from)
                                .ok_or_else(|| {
                                    ToolHandlerError::new(
                                        "args must contain only strings without NUL",
                                    )
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            Ok(ProcessInvocation {
                program: program.into(),
                args,
                label: program.to_owned(),
                metadata: json!({"mode":"direct", "program":program}),
            })
        }
        _ => Err(ToolHandlerError::new(
            "provide exactly one of command or program; args is only valid with program",
        )),
    }
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

fn command_timeout_argument(context: &ToolExecutionContext) -> Result<Duration, ToolHandlerError> {
    let value = context.arguments.get("timeout_ms").map(|value| {
        value.as_u64().ok_or_else(|| ToolHandlerError::new(
            "timeout_ms must be a non-negative integer representable as u64; omit it to use the default"
        ))
    }).transpose()?;
    command_timeout(value)
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

fn job_wait_argument(context: &ToolExecutionContext) -> Result<Duration, ToolHandlerError> {
    let value = context.arguments.get("timeout_ms").map(|value| {
        value.as_u64().ok_or_else(|| ToolHandlerError::new(
            "job_output timeout_ms must be a non-negative integer representable as u64; omit it to use the default"
        ))
    }).transpose()?;
    job_wait(value)
}

fn job_wait(value: Option<u64>) -> Result<Duration, ToolHandlerError> {
    let duration = value.map(Duration::from_millis).unwrap_or(DEFAULT_JOB_WAIT);
    if duration.is_zero() || duration > MAX_JOB_WAIT {
        return Err(ToolHandlerError::new(format!(
            "job wait timeout_ms must be between 1 and {}",
            MAX_JOB_WAIT.as_millis()
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

/// Unlike the generic optional helper, malformed pagination must not silently
/// become an omitted argument (negative integers used to fall back to defaults).
fn read_u64(context: &ToolExecutionContext, name: &str) -> Result<Option<u64>, ToolHandlerError> {
    context.arguments.get(name).map(|value| {
        value.as_u64().ok_or_else(|| ToolHandlerError::new(format!(
            "read {name} must be a non-negative integer representable as u64; omit it to use the default"
        )))
    }).transpose()
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

fn path_key(arguments: &Value) -> Option<String> {
    arguments.get("path")?.as_str().map(ToOwned::to_owned)
}

fn job_id_key(arguments: &Value) -> Option<String> {
    arguments.get("job_id")?.as_str().map(ToOwned::to_owned)
}

// Ignore process identity, but never compare incomplete previews.
fn process_repetition_observation(content: &str) -> Option<(bool, Value)> {
    let mut value: Value = serde_json::from_str(content).ok()?;
    if value["kind"] != "foreground"
        || value["stdout_truncated"] != false
        || value["stderr_truncated"] != false
    {
        return None;
    }
    let success = value["success"].as_bool()?;
    value.as_object_mut()?.remove("pid");
    Some((success, value))
}

#[cfg(test)]
mod tests {
    use super::{managed_environment, managed_path, search_process_output};
    use xharness_process::is_secret_env_name;

    #[test]
    fn shell_description_prefers_managed_jobs_without_banning_native_sessions() {
        let description = super::native_shell_description(&super::Shell::discover());
        assert!(description.contains("prefer run_in_background=true"));
        assert!(description.contains("job_output"));
        assert!(description.contains("job_kill"));
        assert!(description.contains("automation"));
        assert!(!description.contains("schedule_create"));
        assert!(description.contains("Native "));
        assert!(description.contains("status, logs, and stop method"));
        assert!(!description.contains("Never emulate"));
        assert!(!description.contains("Do not use shell"));
    }

    #[test]
    fn repetition_process_observation_ignores_pid_not_failure_or_truncation() {
        let mut v = serde_json::json!({"kind":"foreground","pid":1,"success":false,"exit_code":1,"stdout":"","stderr":"missing","stdout_truncated":false,"stderr_truncated":false});
        let first = super::process_repetition_observation(&v.to_string()).unwrap();
        assert!(!first.0);
        v["pid"] = serde_json::json!(2);
        assert_eq!(
            first,
            super::process_repetition_observation(&v.to_string()).unwrap()
        );
        v["stderr"] = serde_json::json!("different");
        assert_ne!(
            first,
            super::process_repetition_observation(&v.to_string()).unwrap()
        );
        v["stdout_truncated"] = serde_json::json!(true);
        assert!(super::process_repetition_observation(&v.to_string()).is_none());
        assert!(super::process_repetition_observation(r#"{"kind":"background"}"#).is_none());
        assert!(super::process_repetition_observation("bad JSON").is_none());
    }

    #[test]
    fn search_process_exit_matrix_preserves_diagnostics() {
        use xharness_process::{CapturedOutput, ProcessOutput, ProcessStatus, TerminationReason};
        for (code, signal, termination, ok) in [
            (Some(0), None, TerminationReason::Exited, true),
            (Some(1), None, TerminationReason::Exited, true),
            (Some(2), None, TerminationReason::Exited, false),
            (None, Some(6), TerminationReason::Exited, false),
            (Some(0), None, TerminationReason::TimedOut, false),
            (Some(0), None, TerminationReason::Cancelled, false),
            (None, None, TerminationReason::Exited, false),
        ] {
            let capture = CapturedOutput {
                text: "diagnostic fixture".into(),
                truncated: false,
                bytes_read: 18,
                omitted_bytes: 0,
            };
            let result = search_process_output(ProcessOutput {
                pid: 42,
                status: ProcessStatus {
                    success: code == Some(0),
                    code,
                    signal,
                    core_dumped: false,
                },
                termination,
                stdout: capture.clone(),
                stderr: capture,
            });
            assert_eq!(result.is_ok(), ok, "{code:?}/{signal:?}/{termination:?}");
            let text = match result {
                Ok(out) => out.content,
                Err(err) => err.message,
            };
            assert!(text.contains("diagnostic fixture"));
            assert!(text.contains("exit_code") && text.contains("stderr"));
        }
    }

    #[test]
    fn managed_environment_preserves_runtime_state_without_credentials() {
        let environment = managed_environment();
        assert!(environment
            .keys()
            .all(|name| !is_secret_env_name(name.as_os_str())));
        assert!(environment.keys().all(|name| !name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("XHARNESS_")));
        #[cfg(windows)]
        assert!(environment
            .keys()
            .any(|name| name.eq_ignore_ascii_case("SystemRoot")));
    }

    #[test]
    fn managed_path_keeps_system_and_package_search_locations() {
        let paths = std::env::split_paths(&managed_path()).collect::<Vec<_>>();
        #[cfg(unix)]
        {
            assert!(paths
                .iter()
                .any(|path| path == std::path::Path::new("/usr/bin")));
            assert!(paths
                .iter()
                .any(|path| path == std::path::Path::new("/usr/local/bin")));
        }
        #[cfg(windows)]
        assert!(paths.iter().any(|path| {
            path.file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("System32"))
        }));
        let executable = std::env::current_exe().unwrap();
        assert_eq!(
            paths.first().map(|path| path.as_path()),
            executable.parent()
        );
    }
}
