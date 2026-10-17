//! Native deployment composition for the reusable [`xharness_host`] control
//! plane.
//!
//! This crate owns OS-facing tool construction. The Host library itself stays
//! independent from Linux/macOS/Windows process, filesystem, sandbox, jobs and Web
//! implementations.

mod builtin_ui;
pub mod channel_accounts;
mod computer_media;
mod file_display;
mod git_display;
mod github_http;
pub mod github_service;
pub mod hosted;
pub mod hosted_bootstrap;
pub mod native_browser;
pub mod output_budget_migration;
pub mod ownership;
mod plugin_mcp;
mod plugin_service;
mod read_media;
pub mod remote_admin;
pub mod remote_control;
pub mod tool_allowlist;
pub use plugin_service::{open_product_plugin_manager, NativePluginBackend};
pub mod reasoning_compat;
pub mod reasoning_discovery;

use std::{collections::BTreeMap, path::Path, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use xharness_coding_tools::CodingToolBundle;
mod workspace_memory;
use xharness_debug::DebugRecorder;
use xharness_host::{
    DurableQuestionHub, DurableQuestionProvider, PermissionPreset, SessionToolFactory,
};
use xharness_interaction::AskUserQuestionTool;
use xharness_jobs::JobRegistry;
use xharness_platform::{CapabilityReport, NativePlatform, PlatformConfig};
use xharness_schedule::ScheduleManager;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolSpec};
use xharness_web::{ExaSearchProvider, WebError, WebRuntime};

/// Search remains opt-in: only a non-empty Exa key installs the provider and
/// projects `web_search` to the model. The key is never put in tool metadata.
pub fn configured_web_runtime(
    exa_api_key: Option<String>,
    debug: DebugRecorder,
) -> Result<WebRuntime, WebError> {
    let mut web = WebRuntime::default().with_debug(debug);
    if let Some(key) = exa_api_key.filter(|key| !key.trim().is_empty()) {
        web = web.with_search_provider(Arc::new(ExaSearchProvider::new(key)?));
    }
    Ok(web)
}

/// Native Linux/macOS/Windows implementation of the standard coding-tool factory.
/// Platforms are cached per canonical workspace so filesystem observations
/// survive across turns. Background jobs are shared by the factory and fenced
/// by session owner so they remain collectable across model turns.
pub struct NativeToolFactory {
    jobs: Arc<JobRegistry>,
    display_slots: Arc<tokio::sync::Semaphore>,
    web: Arc<WebRuntime>,
    platforms: RwLock<BTreeMap<(String, String, PermissionPreset), Arc<NativePlatform>>>,
    debug: DebugRecorder,
    questions: Option<Arc<DurableQuestionHub>>,
    schedules: Option<Arc<ScheduleManager>>,
    job_continuations:
        std::sync::OnceLock<Arc<xharness_host::job_continuation::JobContinuationController>>,
    agent_host: std::sync::OnceLock<std::sync::Weak<xharness_host::BasicHost>>,
    plugins: std::sync::OnceLock<Arc<xharness_plugins::PluginManager>>,
    mcp: std::sync::OnceLock<Arc<xharness_mcp::McpRuntime>>,
    native_browser: std::sync::OnceLock<Arc<native_browser::NativeBrowser>>,
    tool_allowlist: std::sync::OnceLock<tool_allowlist::ToolAllowlist>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeToolReadiness {
    pub platform: CapabilityReport,
    pub search_available: bool,
}

impl NativeToolFactory {
    pub fn new(web: WebRuntime) -> Arc<Self> {
        Self::new_with_debug(web, DebugRecorder::disabled())
    }

    pub fn new_with_debug(web: WebRuntime, debug: DebugRecorder) -> Arc<Self> {
        Arc::new(Self {
            jobs: Arc::new(JobRegistry::default()),
            display_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: None,
            schedules: None,
            agent_host: std::sync::OnceLock::new(),
            job_continuations: std::sync::OnceLock::new(),
            plugins: std::sync::OnceLock::new(),
            mcp: std::sync::OnceLock::new(),
            native_browser: std::sync::OnceLock::new(),
            tool_allowlist: std::sync::OnceLock::new(),
        })
    }

    pub fn new_with_questions(
        web: WebRuntime,
        debug: DebugRecorder,
        questions: Arc<DurableQuestionHub>,
    ) -> Arc<Self> {
        Arc::new(Self {
            jobs: Arc::new(JobRegistry::default()),
            display_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: Some(questions),
            schedules: None,
            agent_host: std::sync::OnceLock::new(),
            job_continuations: std::sync::OnceLock::new(),
            plugins: std::sync::OnceLock::new(),
            mcp: std::sync::OnceLock::new(),
            native_browser: std::sync::OnceLock::new(),
            tool_allowlist: std::sync::OnceLock::new(),
        })
    }

    pub fn new_with_questions_and_schedules(
        web: WebRuntime,
        debug: DebugRecorder,
        questions: Arc<DurableQuestionHub>,
        schedules: Arc<ScheduleManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            jobs: Arc::new(JobRegistry::default()),
            display_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: Some(questions),
            schedules: Some(schedules),
            agent_host: std::sync::OnceLock::new(),
            job_continuations: std::sync::OnceLock::new(),
            plugins: std::sync::OnceLock::new(),
            mcp: std::sync::OnceLock::new(),
            native_browser: std::sync::OnceLock::new(),
            tool_allowlist: std::sync::OnceLock::new(),
        })
    }

    pub fn bind_agent_host(&self, host: &Arc<xharness_host::BasicHost>) -> Result<(), String> {
        self.agent_host
            .set(Arc::downgrade(host))
            .map_err(|_| "agent host already bound".into())
    }

    /// Bind the deployment-owned durable outbox before creating any executor.
    /// Start/recover it only after Host configuration and session readiness.
    pub fn enable_job_continuations(
        &self,
        store: Arc<dyn xharness_session::Store>,
        host: &Arc<xharness_host::BasicHost>,
    ) -> Result<Arc<xharness_host::job_continuation::JobContinuationController>, String> {
        let controller = xharness_host::job_continuation::JobContinuationController::new(
            self.jobs.clone(),
            store,
            host,
        );
        self.job_continuations
            .set(controller.clone())
            .map_err(|_| "Job continuations already bound".to_owned())?;
        Ok(controller)
    }

    /// Configure once during deployment startup, before creating executors.
    pub fn restrict_tools(&self, allowlist: tool_allowlist::ToolAllowlist) -> Result<(), String> {
        self.tool_allowlist
            .set(allowlist)
            .map_err(|_| "tool allowlist already configured".into())
    }

    pub fn bind_plugins(
        &self,
        manager: Arc<xharness_plugins::PluginManager>,
    ) -> Result<(), String> {
        self.plugins
            .set(manager)
            .map_err(|_| "plugins already bound".into())
    }

    pub fn bind_mcp(&self, runtime: Arc<xharness_mcp::McpRuntime>) -> Result<(), String> {
        self.mcp
            .set(runtime)
            .map_err(|_| "MCP runtime already bound".into())
    }

    pub fn bind_native_browser(
        &self,
        browser: native_browser::NativeBrowser,
    ) -> Result<(), String> {
        self.native_browser
            .set(Arc::new(browser))
            .map_err(|_| "native browser already bound".into())
    }

    async fn platform(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<Arc<NativePlatform>, String> {
        let key = (session_id.to_owned(), cwd.to_owned(), permission);
        if let Some(platform) = self.platforms.read().await.get(&key).cloned() {
            return Ok(platform);
        }
        let mut config = match permission {
            PermissionPreset::WorkspaceWrite | PermissionPreset::WorkspaceWriteAiReview => {
                PlatformConfig::new(cwd)
            }
            PermissionPreset::DangerFullAccess => PlatformConfig::new(cwd).full_access(),
        };
        if let Some(host) = self.agent_host.get().and_then(std::sync::Weak::upgrade) {
            if let Some(root) = host
                .attachment_store()
                .read_only_root(session_id)
                .map_err(|e| e.to_string())?
            {
                config = config.read_only_root(root);
            }
        }
        let platform = Arc::new(
            NativePlatform::with_debug(config, self.debug.clone())
                .map_err(|error| error.to_string())?,
        );
        let mut platforms = self.platforms.write().await;
        Ok(platforms
            .entry(key)
            .or_insert_with(|| Arc::clone(&platform))
            .clone())
    }

    pub async fn readiness(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<NativeToolReadiness, String> {
        let platform = self.platform(session_id, cwd, permission).await?;
        Ok(NativeToolReadiness {
            platform: platform.capability_report().await,
            search_available: self.web.has_search_provider(),
        })
    }
}

fn project_tools(specs: &mut Vec<ToolSpec>, readiness: &NativeToolReadiness) {
    let process_available = readiness.platform.restricted_process.is_available();
    specs.retain(|spec| match spec.definition.name.as_str() {
        "bash" | "pwsh" | "glob" | "grep" => process_available,
        "web_search" => readiness.search_available,
        _ => true,
    });
}

#[async_trait]
impl SessionToolFactory for NativeToolFactory {
    fn allows_host_tool(&self, name: &str) -> bool {
        self.tool_allowlist
            .get()
            .is_none_or(|list| list.contains(name))
    }

    async fn validate_executor(&self, executor: &ToolExecutor) -> Result<(), String> {
        if let Some(allowlist) = self.tool_allowlist.get() {
            allowlist.validate(&executor.registry().definitions().await)?;
        }
        Ok(())
    }

    async fn validate_goal_references(
        &self,
        id: &str,
        refs: &[xharness_session::goal::GoalEvidence],
    ) -> Result<(), String> {
        use xharness_session::goal::GoalEvidence;
        for reference in refs {
            match reference {
                GoalEvidence::Job { reference } => {
                    self.jobs.get(id, reference).map_err(|e| e.to_string())?;
                }
                GoalEvidence::Agent { reference } => {
                    let host = self
                        .agent_host
                        .get()
                        .and_then(std::sync::Weak::upgrade)
                        .ok_or("agent dependency service unavailable")?;
                    host.validate_goal_agent_reference(id, reference).await?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn goal_dependencies(
        &self,
        id: &str,
        refs: &[xharness_session::goal::GoalEvidence],
    ) -> Result<bool, String> {
        use xharness_session::goal::GoalEvidence;
        let mut pending = false;
        for reference in refs {
            match reference {
                GoalEvidence::Job { reference } => {
                    let job = self.jobs.get(id, reference).map_err(|e| {
                        format!(
                            "required job unavailable (may have been interrupted by restart): {e}"
                        )
                    })?;
                    match job.status {
                        xharness_jobs::JobStatus::Running | xharness_jobs::JobStatus::Stopping => {
                            pending = true
                        }
                        xharness_jobs::JobStatus::Completed => {}
                        _ => {
                            return Err(format!(
                                "required job {reference} failed or was killed; inspect its output"
                            ))
                        }
                    }
                }
                GoalEvidence::Agent { reference } => {
                    let host = self
                        .agent_host
                        .get()
                        .and_then(std::sync::Weak::upgrade)
                        .ok_or("agent dependency service unavailable")?;
                    pending |= host.goal_agent_dependency(id, reference).await?;
                }
                _ => {}
            }
        }
        Ok(pending)
    }

    async fn process_runs(
        &self,
        session_id: &str,
    ) -> Result<Vec<xharness_jobs::protocol::JobRun>, String> {
        Ok(self
            .jobs
            .list(session_id)
            .into_iter()
            .map(xharness_jobs::protocol::JobRun::process)
            .collect())
    }
    async fn process_output(
        &self,
        session_id: &str,
        id: &str,
        cursor: xharness_jobs::JobOutputCursor,
    ) -> Result<xharness_jobs::JobRead, String> {
        self.jobs
            .read_since(session_id, id, &cursor)
            .map_err(|e| e.to_string())
    }
    async fn cancel_process_run(&self, session_id: &str, id: &str) -> Result<(), String> {
        self.jobs
            .kill(session_id, id, Some("cancel_run from UI"))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    async fn read_display_diff(
        &self,
        _session_id: &str,
        cwd: &str,
        path: &Path,
        scope: xharness_api::display::GitDiffScope,
        cancellation: CancellationToken,
    ) -> Result<xharness_api::display::DisplayFile, String> {
        let permit = tokio::select! {
            _ = cancellation.cancelled() => return Err("Git preview cancelled".into()),
            result = self.display_slots.clone().acquire_owned() => result.map_err(|e|e.to_string())?,
        };
        // Even a full-access session's display adapter is read-only, offline,
        // and fails closed if the native sandbox is unavailable.
        let (config, layout) = git_display::platform_config(Path::new(cwd))?;
        let platform =
            NativePlatform::with_debug(config, self.debug.clone()).map_err(|e| e.to_string())?;
        git_display::read(&platform, &layout, path, scope, cancellation, permit).await
    }

    async fn read_display_file(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
        path: &Path,
    ) -> Result<xharness_api::display::DisplayFile, String> {
        let platform = self.platform(session_id, cwd, permission).await?;
        let permit = self
            .display_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        file_display::read(&platform, path, permit).await
    }

    async fn executor(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let platform = self.platform(session_id, cwd, permission).await?;
        let readiness = self.readiness(session_id, cwd, permission).await?;
        let mut bundle = CodingToolBundle::new(
            platform.clone(),
            Arc::clone(&self.jobs),
            Arc::clone(&self.web),
            session_id,
            session_id,
        );
        if let Some(port) = self.job_continuations.get() {
            bundle = bundle.with_job_continuation(port.clone());
        }
        if let Some(host) = self.agent_host.get().and_then(std::sync::Weak::upgrade) {
            bundle = bundle.with_file_mount(Arc::new(workspace_memory::Mount {
                host: Arc::downgrade(&host),
                session: session_id.into(),
                filesystems: tokio::sync::Mutex::new([None, None]),
            }));
            bundle = bundle.with_media_reader(Arc::new(read_media::Reader {
                host: Arc::downgrade(&host),
                platform: platform.clone(),
                session: session_id.into(),
            }));
        }
        let mut specs = bundle.specs();
        let mut guards = Vec::new();
        let mut builtin_ui = None;
        if let Some(read) = specs.iter_mut().find(|s| s.definition.name == "read") {
            read.definition.description.push_str(" When memory is enabled, memory://MEMORY.md reads only this workspace; memory://global/MEMORY.md reads profile-global notes. Use normal file pagination; scope modes and write approvals still apply.");
            read.definition.description.push_str(" PNG/JPEG/WebP/GIF files return image content when the selected model explicitly supports vision; no separate read_image tool is needed. Recent uploaded images are provided directly; an earlier deferred image can be inspected with read(path=\"attachment://<image id>\") as shown in its history marker. Image reads do not accept text pagination options.");
        }
        project_tools(&mut specs, &readiness);
        if let Some(host) = self.agent_host.get().and_then(std::sync::Weak::upgrade) {
            specs.push(xharness_host::AgentTool::for_session(&host, session_id).await);
            builtin_ui = Some(Arc::new(builtin_ui::BuiltinUi::new(&host, session_id)));
        }
        // Native desktop control deliberately remains outside the workspace
        // sandbox. It is registered as one provider-neutral tool only after
        // the user selected the existing full-access preset. macOS permission
        // probes still fail closed inside the adapter.
        #[cfg(any(target_os = "macos", windows))]
        if permission == PermissionPreset::DangerFullAccess {
            #[cfg(target_os = "macos")]
            let driver: Arc<dyn xharness_computer::ComputerDriver> =
                Arc::new(xharness_computer_macos::MacComputer::new());
            #[cfg(windows)]
            let driver: Arc<dyn xharness_computer::ComputerDriver> = Arc::new(
                xharness_computer_windows::WindowsComputer::new()
                    .map_err(|error| error.to_string())?,
            );
            let mut tool = xharness_computer::ComputerTool::new(driver);
            if let Some(host) = self.agent_host.get().and_then(std::sync::Weak::upgrade) {
                tool = tool.with_media_sink(Arc::new(computer_media::Sink {
                    host: Arc::downgrade(&host),
                    session: session_id.into(),
                }));
            }
            let spec = tool.spec();
            #[cfg(windows)]
            let spec = {
                let mut spec = spec;
                spec.definition.description.push_str(" Windows: coordinates and screenshot bounds are physical virtual-desktop pixels. Each dispatched action consumes its frame; observe again unless the result returns a new frame_id. UIA snapshots cover the foreground window. Scroll deltas use wheel units (120 per detent), positive y scrolls down and positive x scrolls right. Fullscreen is application-specific; use its observed controls. No automatic elevation or secure-desktop control.");
                spec
            };
            specs.push(spec);
        }
        if let Some(schedules) = &self.schedules {
            specs.extend(schedules.specs(session_id));
        }
        if let Some(plugins) = self.plugins.get() {
            let available = plugins.enabled_skills().await;
            if !available.is_empty() {
                let manager = Arc::clone(plugins);
                specs.push(ToolSpec::new(
                    xharness_tools::ToolDefinition::new(
                        "plugin_skill",
                        "Discover or load user-enabled Skills. action=list returns names; action=read loads SKILL.md by plugin and skill; action=resource reads a referenced text asset by plugin and relative path. No plugin code is executed by this tool.",
                        serde_json::json!({"type":"object","properties":{"action":{"type":"string","enum":["list","read","resource"]},"plugin":{"type":"string"},"skill":{"type":"string"},"path":{"type":"string"}},"required":["action"]}),
                    ),
                    move |context| {
                        let manager = Arc::clone(&manager);
                        async move {
                            let action = context.arguments.get("action").and_then(serde_json::Value::as_str)
                                .ok_or_else(|| xharness_tools::ToolHandlerError::new("action is required"))?;
                            if action == "list" {
                                let rows = manager.enabled_skills().await.into_iter().map(|(plugin, skill)|
                                    serde_json::json!({"plugin":plugin,"skill":skill.name,"description":skill.description}))
                                    .collect::<Vec<_>>();
                                return Ok(xharness_tools::ToolOutput::text(serde_json::json!({"skills":rows}).to_string()));
                            }
                            let plugin = context.arguments.get("plugin").and_then(serde_json::Value::as_str)
                                .ok_or_else(|| xharness_tools::ToolHandlerError::new("plugin is required"))?;
                            if action == "resource" {
                                let path = context.arguments.get("path").and_then(serde_json::Value::as_str)
                                    .ok_or_else(|| xharness_tools::ToolHandlerError::new("path is required"))?;
                                let content = manager.read_resource(plugin, path).await
                                    .map_err(|e| xharness_tools::ToolHandlerError::new(e.to_string()))?;
                                return Ok(xharness_tools::ToolOutput::text(content));
                            }
                            if action != "read" {
                                return Err(xharness_tools::ToolHandlerError::new("action must be list, read or resource"));
                            }
                            let skill = context.arguments.get("skill").and_then(serde_json::Value::as_str)
                                .ok_or_else(|| xharness_tools::ToolHandlerError::new("skill is required"))?;
                            let content = manager.read_skill(plugin, skill).await
                                .map_err(|e| xharness_tools::ToolHandlerError::new(e.to_string()))?;
                            Ok(xharness_tools::ToolOutput::text(content))
                        }
                    },
                ));
            }
        }
        let enabled_mcp = match self.plugins.get() {
            Some(plugins) => !plugins.enabled_mcp_plugins().await.is_empty(),
            None => false,
        };
        // Host UI exists on Web as well as desktop, even with no plugin store,
        // external MCP runtime or native-browser bridge configured.
        if builtin_ui.is_some()
            || self.mcp.get().is_some() && (enabled_mcp || self.native_browser.get().is_some())
        {
            let binding = plugin_mcp::bind(
                self.plugins.get().cloned(),
                self.mcp.get().cloned(),
                self.native_browser.get().cloned(),
                builtin_ui,
                session_id.into(),
                permission == PermissionPreset::DangerFullAccess,
                self.agent_host.get().map(|host| {
                    Arc::new(computer_media::Sink {
                        host: host.clone(),
                        session: session_id.into(),
                    }) as Arc<dyn xharness_computer::ComputerMediaSink>
                }),
            );
            specs.push(binding.spec);
            guards.push(binding.guard);
        }
        if let Some(questions) = &self.questions {
            if questions
                .allows_user_questions(session_id)
                .await
                .map_err(|error| error.message)?
            {
                specs.push(
                    AskUserQuestionTool::new(Arc::new(DurableQuestionProvider::new(
                        Arc::clone(questions),
                        session_id,
                    )))
                    .spec(),
                );
            }
        }
        if let Some(allowlist) = self.tool_allowlist.get() {
            allowlist.apply(&mut specs);
        }
        if permission == PermissionPreset::DangerFullAccess {
            for spec in &mut specs {
                spec.requires_approval = false;
            }
        }
        let registry = Arc::new(ToolRegistry::new());
        for spec in specs {
            registry
                .register(spec)
                .await
                .map_err(|error| error.to_string())?;
        }
        // Questions collect information; they do not change tool permissions.
        // Existing platform policy and approval requirements remain authoritative.
        let executor = ToolExecutor::new(registry).with_debug(self.debug.clone());
        if let Some(host) = self.agent_host.get().and_then(std::sync::Weak::upgrade) {
            guards.push(xharness_host::AgentTool::model_selection_guard(
                &host, session_id,
            ));
        }
        Ok(executor.with_guards(guards))
    }

    async fn shutdown(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(controller) = self.job_continuations.get() {
            if let Err(error) = controller.shutdown().await {
                errors.push(error);
            }
        }
        if let Some(mcp) = self.mcp.get() {
            mcp.shutdown().await;
        }
        let report = self.jobs.shutdown(std::time::Duration::from_secs(8)).await;
        if let Some(controller) = self.job_continuations.get() {
            if let Err(error) = controller.shutdown().await {
                errors.push(error);
            }
        }
        if !report.is_graceful() {
            errors.push(format!(
                "job shutdown handled {} jobs with {} cancellation failures and {} timeouts",
                report.jobs, report.cancellation_failures, report.timed_out
            ));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use xharness_interaction::QuestionInvocation;
    #[tokio::test]
    async fn deployment_allowlist_removes_execution_not_just_definitions() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        assert!(factory.allows_host_tool("history"));
        factory
            .restrict_tools(tool_allowlist::ToolAllowlist::parse("read").unwrap())
            .unwrap();
        assert!(factory
            .restrict_tools(tool_allowlist::ToolAllowlist::parse("").unwrap())
            .is_err());
        let executor = factory
            .executor(
                "gui",
                &workspace.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        assert!(!factory.allows_host_tool("history"));
        assert!(!factory.allows_host_tool("goal"));
        let definitions = executor.registry().definitions().await;
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "read");
        let result = executor
            .execute(xharness_tools::ToolRequest::new(
                NATIVE_SHELL_TOOL,
                r#"{"command":"exit 0"}"#,
            ))
            .await;
        assert!(!result.is_ok());
        let empty = NativeToolFactory::new(WebRuntime::default());
        empty
            .restrict_tools(tool_allowlist::ToolAllowlist::parse("").unwrap())
            .unwrap();
        assert!(
            empty
                .executor(
                    "gui",
                    &workspace.0.to_string_lossy(),
                    PermissionPreset::DangerFullAccess
                )
                .await
                .unwrap()
                .registry()
                .is_empty()
                .await
        );
    }

    #[tokio::test]
    async fn deployment_allowlist_does_not_grant_missing_capabilities() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        factory
            .restrict_tools(tool_allowlist::ToolAllowlist::parse("computer").unwrap())
            .unwrap();
        let executor = factory
            .executor(
                "gui",
                &workspace.0.to_string_lossy(),
                PermissionPreset::WorkspaceWrite,
            )
            .await
            .unwrap();
        assert!(factory.validate_executor(&executor).await.is_err());
    }

    use std::sync::atomic::{AtomicU64, Ordering};
    use xharness_platform::CapabilityState;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    #[tokio::test]
    async fn execution_api_uses_the_same_owned_registry_as_native_tools() {
        let factory = NativeToolFactory::new(
            configured_web_runtime(None, DebugRecorder::disabled()).unwrap(),
        );
        let (id, lease) = factory
            .jobs
            .reserve("owned", "bash", "fixture process", None)
            .unwrap()
            .commit(None, Arc::new(|_| Ok(())))
            .unwrap();
        lease.publish_stdout("owned result");
        let runs = factory.process_runs("owned").await.unwrap();
        assert_eq!(runs[0].id, id.as_str());
        assert!(factory.process_runs("other").await.unwrap().is_empty());
        assert!(factory
            .process_output(
                "other",
                id.as_str(),
                xharness_jobs::JobOutputCursor::start(id.as_str())
            )
            .await
            .is_err());
        assert_eq!(
            factory
                .process_output(
                    "owned",
                    id.as_str(),
                    xharness_jobs::JobOutputCursor::start(id.as_str())
                )
                .await
                .unwrap()
                .stdout,
            "owned result"
        );
        factory
            .cancel_process_run("owned", id.as_str())
            .await
            .unwrap();
        assert_eq!(
            factory.process_runs("owned").await.unwrap()[0].state,
            xharness_jobs::protocol::RunState::Stopping
        );
        lease.finish(xharness_jobs::JobOutcome::killed("producer acknowledged"));
        assert_eq!(
            factory.process_runs("owned").await.unwrap()[0].state,
            xharness_jobs::protocol::RunState::Cancelled
        );
    }

    #[cfg(unix)]
    const NATIVE_SHELL_TOOL: &str = "bash";
    #[cfg(windows)]
    const NATIVE_SHELL_TOOL: &str = "pwsh";

    #[cfg(unix)]
    const BACKGROUND_COMMAND: &str = r#"{"command":"sleep 30","run_in_background":true}"#;
    #[cfg(windows)]
    const BACKGROUND_COMMAND: &str =
        r#"{"command":"Start-Sleep -Seconds 30","run_in_background":true}"#;

    pub(crate) struct TempWorkspace(pub(crate) std::path::PathBuf);

    #[tokio::test]
    async fn exa_search_is_projected_only_with_an_explicit_key() {
        let workspace = TempWorkspace::new();
        let cwd = workspace.0.to_string_lossy();
        for (key, expected) in [
            (None, false),
            (Some(" ".to_owned()), false),
            (Some("test-key".to_owned()), true),
        ] {
            let web = configured_web_runtime(key, DebugRecorder::disabled()).unwrap();
            assert_eq!(web.has_search_provider(), expected);
            let factory = NativeToolFactory::new(web);
            let executor = factory
                .executor("search-test", &cwd, PermissionPreset::DangerFullAccess)
                .await
                .unwrap();
            let names = executor.registry().definitions().await;
            assert_eq!(names.iter().any(|tool| tool.name == "web_search"), expected);
        }
    }

    #[tokio::test]
    async fn enabled_plugin_skill_is_projected_and_callable_as_one_lazy_tool() {
        use sha2::Digest;
        let workspace = TempWorkspace::new();
        let manager =
            Arc::new(xharness_plugins::PluginManager::open(workspace.0.join("plugins")).unwrap());
        let mut archive = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut archive);
            let options = zip::write::SimpleFileOptions::default();
            writer
                .start_file("demo/.zcode-plugin/plugin.json", options)
                .unwrap();
            writer.write_all(br#"{"name":"demo"}"#).unwrap();
            writer
                .start_file("demo/skills/ship/SKILL.md", options)
                .unwrap();
            writer
                .write_all(b"---\ndescription: Ship code\n---\nRun the checks.")
                .unwrap();
            writer.start_file("demo/.mcp.json", options).unwrap();
            writer
                .write_all(br#"{"mcpServers":{"local":{"command":"fixture"}}}"#)
                .unwrap();
            writer.finish().unwrap();
        }
        let archive = archive.into_inner();
        let digest = format!("{:x}", sha2::Sha256::digest(&archive));
        manager.import_catalog(&serde_json::json!({"plugins":[{"name":"demo","version":"1.0",
            "source":{"source":"url","type":"zip","url":"https://example.com/demo.zip","sha256":digest}}]}).to_string()).await.unwrap();
        manager
            .install_verified_archive("demo", &archive)
            .await
            .unwrap();
        let factory = NativeToolFactory::new(WebRuntime::default());
        factory.bind_plugins(Arc::clone(&manager)).unwrap();
        factory.bind_mcp(xharness_mcp::McpRuntime::new()).unwrap();
        let cwd = workspace.0.to_string_lossy();
        let before = factory
            .executor("plugin-test", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        assert!(!before
            .registry()
            .definitions()
            .await
            .iter()
            .any(|definition| definition.name == "plugin_skill"));
        manager.set_enabled("demo", true).await.unwrap();
        let after = factory
            .executor("plugin-test", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        let skill_tools = after
            .registry()
            .definitions()
            .await
            .into_iter()
            .filter(|definition| definition.name == "plugin_skill")
            .collect::<Vec<_>>();
        assert_eq!(skill_tools.len(), 1);
        let listed = after
            .execute(xharness_tools::ToolRequest::new(
                "plugin_skill",
                r#"{"action":"list"}"#,
            ))
            .await;
        assert!(listed.is_ok());
        assert!(listed.output.unwrap().content.contains("ship"));
        let read = after
            .execute(xharness_tools::ToolRequest::new(
                "plugin_skill",
                r#"{"action":"read","plugin":"demo","skill":"ship"}"#,
            ))
            .await;
        assert!(read.is_ok());
        assert!(read.output.unwrap().content.contains("Run the checks"));
        manager.set_mcp_enabled("demo", true).await.unwrap();
        let with_mcp = factory
            .executor("plugin-test", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        assert!(with_mcp
            .registry()
            .definitions()
            .await
            .iter()
            .any(|tool| tool.name == "plugin_mcp"));
        let mcp_list = with_mcp
            .execute(xharness_tools::ToolRequest::new(
                "plugin_mcp",
                r#"{"action":"list"}"#,
            ))
            .await;
        assert!(mcp_list.is_ok());
        assert!(mcp_list.output.unwrap().content.contains("demo"));
        manager.set_mcp_enabled("demo", false).await.unwrap();
        let mcp_denied = with_mcp
            .execute(xharness_tools::ToolRequest::new(
                "plugin_mcp",
                r#"{"action":"list","plugin":"demo"}"#,
            ))
            .await;
        assert!(
            !mcp_denied.is_ok(),
            "MCP disable fences stale tool snapshots"
        );
        manager.set_enabled("demo", false).await.unwrap();
        let denied = after
            .execute(xharness_tools::ToolRequest::new(
                "plugin_skill",
                r#"{"action":"read","plugin":"demo","skill":"ship"}"#,
            ))
            .await;
        assert!(
            !denied.is_ok(),
            "disabling a plugin fences even a previously projected tool"
        );
    }

    impl TempWorkspace {
        pub(crate) fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xharness-host-app-permission-{}-{}",
                std::process::id(),
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn ai_review_preserves_workspace_sandbox_and_tool_approval_flags() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        let cwd = workspace.0.to_string_lossy();
        let manual = factory
            .executor("manual", &cwd, PermissionPreset::WorkspaceWrite)
            .await
            .unwrap();
        let review = factory
            .executor("review", &cwd, PermissionPreset::WorkspaceWriteAiReview)
            .await
            .unwrap();
        let manual_definitions = manual.registry().definitions().await;
        let review_definitions = review.registry().definitions().await;
        assert_eq!(
            manual_definitions, review_definitions,
            "no new model-visible tool or widened permissions"
        );
        assert_eq!(
            PermissionPreset::WorkspaceWriteAiReview.sandbox_mode(),
            PermissionPreset::WorkspaceWrite.sandbox_mode()
        );
        assert!(PermissionPreset::WorkspaceWriteAiReview.sandbox_enabled());
        for definition in &manual_definitions {
            assert_eq!(
                manual
                    .registry()
                    .get(&definition.name)
                    .await
                    .unwrap()
                    .requires_approval,
                review
                    .registry()
                    .get(&definition.name)
                    .await
                    .unwrap()
                    .requires_approval
            );
        }
        assert!(review_definitions
            .iter()
            .all(|definition| definition.name != "computer"));
    }

    #[tokio::test]
    async fn full_access_removes_per_tool_prompts_after_the_product_risk_gate() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        let cwd = workspace.0.to_string_lossy();
        let guarded = factory
            .executor("guarded", &cwd, PermissionPreset::WorkspaceWrite)
            .await
            .unwrap();
        let guarded_names = guarded.registry().definitions().await;
        assert!(!guarded_names.is_empty());
        assert!(
            guarded
                .registry()
                .get("write")
                .await
                .unwrap()
                .requires_approval
        );

        let full_access = factory
            .executor("full", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        let full_definitions = full_access.registry().definitions().await;
        for definition in &full_definitions {
            assert!(
                !full_access
                    .registry()
                    .get(&definition.name)
                    .await
                    .unwrap()
                    .requires_approval
            );
        }
        assert!(full_definitions
            .iter()
            .all(|definition| definition.name != "web_search"));
        assert!(full_definitions
            .iter()
            .any(|definition| definition.name == NATIVE_SHELL_TOOL));
        assert!(guarded_names
            .iter()
            .all(|definition| definition.name != "computer"));
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert!(full_definitions
            .iter()
            .any(|definition| definition.name == "computer"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert!(full_definitions
            .iter()
            .all(|definition| definition.name != "computer"));
    }

    #[tokio::test]
    async fn unavailable_capabilities_are_removed_before_model_projection() {
        let workspace = TempWorkspace::new();
        let platform =
            Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap());
        let mut specs = CodingToolBundle::new(
            platform,
            Arc::new(JobRegistry::default()),
            Arc::new(WebRuntime::default()),
            "session",
            "session",
        )
        .specs();
        project_tools(
            &mut specs,
            &NativeToolReadiness {
                platform: CapabilityReport {
                    filesystem_read: CapabilityState::Available,
                    filesystem_mutation: CapabilityState::Available,
                    restricted_process: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    terminal_open: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    process_network: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    sandbox_backend: "bubblewrap".to_owned(),
                },
                search_available: false,
            },
        );
        let mut names = specs
            .iter()
            .map(|spec| spec.definition.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "edit",
                "job_kill",
                "job_list",
                "job_output",
                "read",
                "web_fetch",
                "write"
            ]
        );
    }

    #[tokio::test]
    async fn native_factory_shutdown_cancels_shared_background_jobs() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        let executor = factory
            .executor(
                "job-shutdown",
                &workspace.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let opened = executor
            .execute(xharness_tools::ToolRequest::new(
                NATIVE_SHELL_TOOL,
                BACKGROUND_COMMAND,
            ))
            .await;
        assert!(opened.is_ok(), "{opened:?}");
        assert_eq!(factory.jobs.list("job-shutdown").len(), 1);

        SessionToolFactory::shutdown(factory.as_ref())
            .await
            .unwrap();
        assert!(factory.jobs.list("job-shutdown")[0].status.is_terminal());
        let late = executor
            .execute(xharness_tools::ToolRequest::new(
                NATIVE_SHELL_TOOL,
                BACKGROUND_COMMAND,
            ))
            .await;
        assert!(!late.is_ok());
    }

    #[tokio::test]
    async fn production_factory_projects_ask_user_question_through_the_normal_registry() {
        let workspace = TempWorkspace::new();
        let store: Arc<dyn xharness_session::Store> =
            Arc::new(xharness_session::MemorySessionStore::default());
        store
            .create(xharness_session::SessionHeader::new("questions"))
            .await
            .unwrap();
        let hub = DurableQuestionHub::new(store);
        let factory = NativeToolFactory::new_with_questions(
            WebRuntime::default(),
            DebugRecorder::disabled(),
            hub,
        );
        let executor = factory
            .executor(
                "questions",
                &workspace.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let spec = executor
            .registry()
            .get(xharness_interaction::ASK_USER_QUESTION_TOOL)
            .await
            .expect("question tool is registered");
        assert!(matches!(
            spec.settlement,
            xharness_tools::ToolSettlement::External
        ));
        assert!(matches!(
            spec.batch_policy,
            xharness_tools::ToolBatchPolicy::Standalone
        ));
    }

    #[tokio::test]
    async fn pending_question_does_not_restrict_tools_or_bypass_approval() {
        use serde_json::json;
        use xharness_session::{EventData, Message, Revision, SessionHeader, ToolCall};
        use xharness_tools::{ToolDefinition, ToolFailureKind, ToolOutput, ToolRequest, ToolSpec};
        let workspace = TempWorkspace::new();
        let store: Arc<dyn xharness_session::Store> =
            Arc::new(xharness_session::MemorySessionStore::default());
        let id = "pending-question-permissions";
        store.create(SessionHeader::new(id)).await.unwrap();
        let args = json!({"questions":[{"id":"target","header":"Deploy","question":"Deploy where?","options":[],"allowCustom":true,"destination":"context"}]});
        let invocation = QuestionInvocation::new(
            "question-call",
            xharness_interaction::AskUserQuestionRequest::parse(&args.to_string()).unwrap(),
        );
        let call = ToolCall {
            id: "question-call".into(),
            provider_call_id: None,
            index: 0,
            name: xharness_interaction::ASK_USER_QUESTION_TOOL.into(),
            arguments_json: args.to_string(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                id,
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("build first, ask deployment target"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: assistant,
                        usage: None,
                    }
                    .into(),
                    EventData::ToolCall {
                        turn: 1,
                        step: 1,
                        call,
                    }
                    .into(),
                    EventData::QuestionRequested {
                        invocation: invocation.clone(),
                    }
                    .into(),
                    EventData::QuestionDeferred {
                        interaction_id: invocation.interaction_id,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        store.flush(id).await.unwrap();
        let hub = DurableQuestionHub::new(store.clone());
        let factory = NativeToolFactory::new_with_questions(
            WebRuntime::default(),
            DebugRecorder::disabled(),
            hub,
        );
        for permission in [
            PermissionPreset::WorkspaceWrite,
            PermissionPreset::DangerFullAccess,
        ] {
            let executor = factory
                .executor(id, &workspace.0.to_string_lossy(), permission)
                .await
                .unwrap();
            // Use harmless probes for tool categories. This checks production
            // middleware without depending on OS shell/network availability.
            for name in [
                NATIVE_SHELL_TOOL,
                "write",
                "web_fetch",
                "job_create",
                "agent",
            ] {
                let name = format!("probe_{name}");
                executor
                    .registry()
                    .register(ToolSpec::new(
                        ToolDefinition::new(
                            &name,
                            "independent work probe",
                            json!({"type":"object"}),
                        ),
                        |_| async {
                            Ok(ToolOutput {
                                content: "independent work done".into(),
                                metadata: None,
                                command_failure: None,
                            })
                        },
                    ))
                    .await
                    .unwrap();
                let result = executor.execute(ToolRequest::new(&name, "{}")).await;
                assert!(
                    result.is_ok(),
                    "{permission:?} {name}: {:?}",
                    result.failure
                );
                let protected = executor
                    .execute(ToolRequest::new(&name, "{}").requiring_approval(true))
                    .await;
                assert_eq!(
                    protected.failure.unwrap().kind,
                    ToolFailureKind::ApprovalUnavailable,
                    "a deferred question must not grant permission"
                );
            }
        }
        assert!(xharness_session::has_unanswered_deferred_question(
            store.load(id).await.unwrap().unwrap().events()
        ));
    }

    #[tokio::test]
    async fn production_factory_projects_one_automation_tool() {
        let workspace = TempWorkspace::new();
        let store: Arc<dyn xharness_session::Store> =
            Arc::new(xharness_session::MemorySessionStore::default());
        store
            .create(xharness_session::SessionHeader::new("schedules"))
            .await
            .unwrap();
        let questions = DurableQuestionHub::new(Arc::clone(&store));
        let schedules = ScheduleManager::new(store);
        let factory = NativeToolFactory::new_with_questions_and_schedules(
            WebRuntime::default(),
            DebugRecorder::disabled(),
            questions,
            schedules,
        );
        let executor = factory
            .executor(
                "schedules",
                &workspace.0.to_string_lossy(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap();
        let names = executor
            .registry()
            .definitions()
            .await
            .into_iter()
            .map(|definition| definition.name)
            .collect::<std::collections::BTreeSet<_>>();
        assert!(names.contains("automation"));
        for name in ["schedule_create", "schedule_list", "schedule_delete"] {
            assert!(
                !names.contains(name),
                "legacy adapter still exposed: {name}"
            );
        }
    }

    #[tokio::test]
    async fn goal_jobs_are_explicit_owner_scoped_and_unknown_never_counts_as_success() {
        use xharness_session::goal::GoalEvidence;
        let f =
            NativeToolFactory::new(WebRuntime::new(xharness_web::WebConfig::default()).unwrap());
        let (id, lease) = f
            .jobs
            .reserve("s", "eval", "required", None)
            .unwrap()
            .commit(None, Arc::new(|_| Ok(())))
            .unwrap();
        let refs = vec![GoalEvidence::Job {
            reference: id.as_str().into(),
        }];
        assert!(
            !f.goal_dependencies("s", &[]).await.unwrap(),
            "unrelated background processes must not block"
        );
        f.validate_goal_references("s", &refs).await.unwrap();
        assert!(f.validate_goal_references("other", &refs).await.is_err());
        assert!(f.goal_dependencies("s", &refs).await.unwrap());
        assert!(f.goal_dependencies("other", &refs).await.is_err());
        lease.finish(xharness_jobs::JobOutcome::completed("verified"));
        f.validate_goal_references("s", &refs).await.unwrap();
        assert!(!f.goal_dependencies("s", &refs).await.unwrap());
        for reference in ["missing", &format!("{} (running)", id.as_str())] {
            assert!(f
                .validate_goal_references(
                    "s",
                    &[GoalEvidence::Job {
                        reference: reference.into()
                    }]
                )
                .await
                .is_err());
        }
        assert!(f
            .goal_dependencies(
                "s",
                &[GoalEvidence::Job {
                    reference: "missing".into()
                }]
            )
            .await
            .is_err());
        let (id, lease) = f
            .jobs
            .reserve("s", "eval", "failed", None)
            .unwrap()
            .commit(None, Arc::new(|_| Ok(())))
            .unwrap();
        drop(lease);
        f.validate_goal_references(
            "s",
            &[GoalEvidence::Job {
                reference: id.as_str().into(),
            }],
        )
        .await
        .unwrap();
        assert!(f
            .goal_dependencies(
                "s",
                &[GoalEvidence::Job {
                    reference: id.as_str().into()
                }]
            )
            .await
            .is_err());
    }
}
pub mod config;
mod context_discovery;
pub mod model_settings;
