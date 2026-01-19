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
    JobCancel, JobLease, JobOutcome, JobRegistry, JobSnapshot, JobStatus, KillResult,
};
use xharness_platform::NativePlatform;
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

#[derive(Clone)]
pub struct CodingToolBundle {
    platform: Arc<NativePlatform>,
    jobs: Arc<JobRegistry>,
    web: Arc<WebRuntime>,
    session_id: Arc<str>,
    owner_id: Arc<str>,
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
        }
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
        ToolSpec::new(
            definition(
                native_shell_name(),
                native_shell_description(),
                json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "description": {"type": "string"},
                        "timeout_ms": {"type": "integer"},
                        "cwd": {"type": "string"},
                        "run_in_background": {
                            "type": "boolean",
                            "description": "Run as a managed background job. Returns immediately and has no command timeout."
                        }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }),
            ),
            move |context| {
                let platform = Arc::clone(&platform);
                let jobs = Arc::clone(&jobs);
                let owner = Arc::clone(&owner);
                async move {
                    let command = required_string(&context, "command")?;
                    let cwd = resolve_cwd(&platform, optional_string(&context, "cwd"))?;
                    let background = optional_bool(&context, "run_in_background").unwrap_or(false);
                    if background && context.arguments.get("timeout_ms").is_some() {
                        return Err(ToolHandlerError::new(
                            "timeout_ms cannot be combined with run_in_background=true; manage the job with job_output/job_kill",
                        ));
                    }
                    let mut spec = SpawnSpec::new(native_shell_program(), cwd)
                        .debug_parent(context.execution_id.as_str())
                        .args(native_shell_args(&command))
                        .envs(managed_environment());
                    if !background {
                        spec = spec.timeout(command_timeout(optional_u64(&context, "timeout_ms"))?);
                    }
                    if background {
                        let reservation = jobs
                            .reserve(
                                owner.to_string(),
                                native_shell_name(),
                                command.clone(),
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
                            "pid": pid
                        })));
                    }
                    let output = run_process(platform, spec, &context.cancellation).await?;
                    let mut value = process_output_value(output);
                    value["kind"] = Value::String("foreground".to_owned());
                    Ok(json_output(value))
                }
            },
        )
        .with_timeout(TOOL_TIMEOUT)
        .requiring_approval(true)
    }

    fn job_output_spec(&self) -> ToolSpec {
        let jobs = Arc::clone(&self.jobs);
        let owner = Arc::clone(&self.owner_id);
        ToolSpec::new(
            definition(
                "job_output",
                "Consume output produced by one managed background job since the previous read and return its current status. Set wait=true only when blocked on this job; a wait timeout returns the still-running status and is not an error. Track every job id and collect relevant jobs before the final answer; do not busy-poll or duplicate their work.",
                json!({
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
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
                    let wait = optional_bool(&context, "wait").unwrap_or(false);
                    if !wait && context.arguments.get("timeout_ms").is_some() {
                        return Err(ToolHandlerError::new(
                            "timeout_ms is only valid when wait=true",
                        ));
                    }
                    if wait {
                        let timeout = job_wait(optional_u64(&context, "timeout_ms"))?;
                        tokio::select! {
                            result = jobs.wait(&owner, &job_id, timeout) => {
                                result.map_err(handler_error)?;
                            }
                            _ = context.cancellation.cancelled() => {
                                return Err(ToolHandlerError::new("job_output wait cancelled; the background job is still running"));
                            }
                        }
                    }
                    let read = jobs.read(&owner, &job_id).map_err(handler_error)?;
                    Ok(json_output(json!({
                        "stdout": read.stdout,
                        "stderr": read.stderr,
                        "stdout_truncated": read.stdout_truncated,
                        "stderr_truncated": read.stderr_truncated,
                        "snapshot": PublicJobSnapshot::from(read.snapshot),
                    })))
                }
            },
        )
        .with_concurrency(ToolConcurrency::Keyed)
        .with_resource_key_resolver(job_id_key)
        .with_timeout(TOOL_TIMEOUT)
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

fn process_output(output: ProcessOutput) -> ToolOutput {
    json_output(process_output_value(output))
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
        "stderr_bytes": output.stderr.bytes_read
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
        TerminationReason::Exited => JobOutcome::completed(detail),
    }
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput {
        content: serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        metadata: Some(value),
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
    let mut paths = Vec::<PathBuf>::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    };
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            push(parent.to_owned());
        }
    }
    if let Some(inherited) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&inherited) {
            push(path);
        }
    }
    #[cfg(unix)]
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        push(home.join(".local/bin"));
        push(home.join(".cargo/bin"));
    }
    #[cfg(unix)]
    for path in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(PathBuf::from(path));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| default_native_path())
}

#[cfg(unix)]
const fn native_shell_name() -> &'static str {
    "bash"
}

#[cfg(windows)]
const fn native_shell_name() -> &'static str {
    "pwsh"
}

#[cfg(unix)]
const fn native_shell_description() -> &'static str {
    "Run one fresh Bash command under the active session permission policy. Pipeline failures propagate because pipefail is enabled. For long-running non-interactive work that begins now set run_in_background=true: the call returns a job id immediately; collect it with job_output and stop it with job_kill. Use schedule_create, not bash or sleep, for future reminders and delayed requests. Do not use shell &, nohup, disown, screen, tmux or a PTY to emulate managed background work. No shell state persists between calls."
}

#[cfg(windows)]
const fn native_shell_description() -> &'static str {
    "Run one fresh PowerShell 7 command under the active session permission policy. Use native Windows paths and $env:NAME environment variables. Native-command and PowerShell errors fail the command. For long-running non-interactive work that begins now set run_in_background=true: the call returns a job id immediately; collect it with job_output and stop it with job_kill. No shell state persists between calls."
}

#[cfg(unix)]
fn native_shell_program() -> OsString {
    OsString::from("/bin/bash")
}

#[cfg(windows)]
fn native_shell_program() -> OsString {
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let installed = program_files.join("PowerShell").join("7").join("pwsh.exe");
    if installed.is_file() {
        installed.into_os_string()
    } else {
        OsString::from("pwsh.exe")
    }
}

#[cfg(unix)]
fn native_shell_args(command: &str) -> Vec<OsString> {
    ["--noprofile", "--norc", "-o", "pipefail", "-lc", command]
        .into_iter()
        .map(OsString::from)
        .collect()
}

#[cfg(windows)]
fn native_shell_args(command: &str) -> Vec<OsString> {
    let script = format!(
        "$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Error.Write(''); {command}"
    );
    [
        OsString::from("-NoLogo"),
        OsString::from("-NoProfile"),
        OsString::from("-NonInteractive"),
        OsString::from("-Command"),
        OsString::from(script),
    ]
    .into_iter()
    .collect()
}

#[cfg(unix)]
fn default_native_path() -> OsString {
    OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

#[cfg(windows)]
fn default_native_path() -> OsString {
    OsString::from(r"C:\Windows\System32;C:\Windows")
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

#[cfg(test)]
mod tests {
    use super::{managed_environment, managed_path};
    use xharness_process::is_secret_env_name;

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
