//! Native deployment composition for the reusable [`xharness_host`] control
//! plane.
//!
//! This crate owns OS-facing tool construction. The Host library itself stays
//! independent from Linux/macOS/Windows process, filesystem, sandbox, jobs and Web
//! implementations.

use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use tokio::sync::{Mutex, RwLock};
use xharness_coding_tools::CodingToolBundle;
use xharness_debug::DebugRecorder;
use xharness_host::{
    update_agent_markdown, AgentMarkdownSink, DurableQuestionHub, DurableQuestionProvider,
    PermissionPreset, SessionToolFactory,
};
use xharness_interaction::{AskUserQuestionTool, QuestionInvocation, QuestionResolution};
use xharness_jobs::JobRegistry;
use xharness_platform::{CapabilityReport, NativePlatform, PlatformConfig};
use xharness_schedule::ScheduleManager;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolSpec};
use xharness_web::WebRuntime;

/// Native Linux/macOS/Windows implementation of the standard coding-tool factory.
/// Platforms are cached per canonical workspace so filesystem observations
/// survive across turns. Background jobs are shared by the factory and fenced
/// by session owner so they remain collectable across model turns.
pub struct NativeToolFactory {
    jobs: Arc<JobRegistry>,
    web: Arc<WebRuntime>,
    platforms: RwLock<BTreeMap<(String, PermissionPreset), Arc<NativePlatform>>>,
    debug: DebugRecorder,
    questions: Option<Arc<DurableQuestionHub>>,
    schedules: Option<Arc<ScheduleManager>>,
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
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: None,
            schedules: None,
        })
    }

    pub fn new_with_questions(
        web: WebRuntime,
        debug: DebugRecorder,
        questions: Arc<DurableQuestionHub>,
    ) -> Arc<Self> {
        Arc::new(Self {
            jobs: Arc::new(JobRegistry::default()),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: Some(questions),
            schedules: None,
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
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
            questions: Some(questions),
            schedules: Some(schedules),
        })
    }

    async fn platform(
        &self,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<Arc<NativePlatform>, String> {
        let key = (cwd.to_owned(), permission);
        if let Some(platform) = self.platforms.read().await.get(&key).cloned() {
            return Ok(platform);
        }
        let config = match permission {
            PermissionPreset::WorkspaceWrite => PlatformConfig::new(cwd),
            PermissionPreset::DangerFullAccess => PlatformConfig::new(cwd).full_access(),
        };
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
        _session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<NativeToolReadiness, String> {
        let platform = self.platform(cwd, permission).await?;
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
    async fn executor(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let platform = self.platform(cwd, permission).await?;
        let readiness = self.readiness(session_id, cwd, permission).await?;
        let mut specs = CodingToolBundle::new(
            platform,
            Arc::clone(&self.jobs),
            Arc::clone(&self.web),
            session_id,
            session_id,
        )
        .specs();
        project_tools(&mut specs, &readiness);
        if let Some(schedules) = &self.schedules {
            specs.extend(schedules.specs(session_id));
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
        if let Some(questions) = &self.questions {
            AskUserQuestionTool::new(Arc::new(DurableQuestionProvider::new(
                Arc::clone(questions),
                session_id,
                cwd,
            )))
            .register(&registry)
            .await
            .map_err(|error| error.to_string())?;
        }
        Ok(ToolExecutor::new(registry).with_debug(self.debug.clone()))
    }

    async fn shutdown(&self) -> Result<(), String> {
        let report = self.jobs.shutdown(std::time::Duration::from_secs(8)).await;
        if report.is_graceful() {
            Ok(())
        } else {
            Err(format!(
                "job shutdown handled {} jobs with {} cancellation failures and {} timeouts",
                report.jobs, report.cancellation_failures, report.timed_out
            ))
        }
    }
}

/// Atomic, symlink-safe writer for the Host-managed AGENTS.md memory section.
#[derive(Default)]
pub struct ManagedAgentMarkdownSink {
    gate: Mutex<()>,
}

impl ManagedAgentMarkdownSink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[async_trait]
impl AgentMarkdownSink for ManagedAgentMarkdownSink {
    async fn persist(
        &self,
        workspace: &Path,
        invocation: &QuestionInvocation,
        resolution: &QuestionResolution,
    ) -> Result<(), String> {
        static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
        let _guard = self.gate.lock().await;
        let workspace = workspace.to_path_buf();
        let invocation = invocation.clone();
        let resolution = resolution.clone();
        tokio::task::spawn_blocking(move || {
            let canonical = std::fs::canonicalize(&workspace).map_err(|error| {
                format!(
                    "could not resolve workspace {}: {error}",
                    workspace.display()
                )
            })?;
            if !canonical.is_dir() {
                return Err(format!(
                    "workspace {} is not a directory",
                    canonical.display()
                ));
            }
            let path = canonical.join("AGENTS.md");
            let existing = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_file() {
                        return Err(format!(
                            "refusing to replace non-regular AGENTS.md at {}",
                            path.display()
                        ));
                    }
                    std::fs::read_to_string(&path)
                        .map_err(|error| format!("could not read {}: {error}", path.display()))?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => {
                    return Err(format!("could not inspect {}: {error}", path.display()));
                }
            };
            let updated = update_agent_markdown(&existing, &invocation, &resolution)?;
            if updated == existing {
                return Ok(());
            }
            let temp = canonical.join(format!(
                ".AGENTS.md.xharness.{}.{}.tmp",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            let result = (|| {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                    .map_err(|error| format!("could not create {}: {error}", temp.display()))?;
                file.write_all(updated.as_bytes())
                    .and_then(|_| file.sync_all())
                    .map_err(|error| format!("could not persist {}: {error}", temp.display()))?;
                std::fs::rename(&temp, &path).map_err(|error| {
                    format!(
                        "could not atomically replace {} with {}: {error}",
                        path.display(),
                        temp.display()
                    )
                })?;
                sync_workspace_directory(&canonical).map_err(|error| {
                    format!("could not sync workspace {}: {error}", canonical.display())
                })?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result
        })
        .await
        .map_err(|error| format!("AGENTS.md writer task failed: {error}"))?
    }
}

#[cfg(unix)]
fn sync_workspace_directory(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_workspace_directory(path: &Path) -> std::io::Result<()> {
    if std::fs::metadata(path)?.is_dir() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "workspace is not a directory",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use xharness_platform::CapabilityState;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    #[cfg(unix)]
    const NATIVE_SHELL_TOOL: &str = "bash";
    #[cfg(windows)]
    const NATIVE_SHELL_TOOL: &str = "pwsh";

    #[cfg(unix)]
    const BACKGROUND_COMMAND: &str = r#"{"command":"sleep 30","run_in_background":true}"#;
    #[cfg(windows)]
    const BACKGROUND_COMMAND: &str =
        r#"{"command":"Start-Sleep -Seconds 30","run_in_background":true}"#;

    struct TempWorkspace(std::path::PathBuf);

    impl TempWorkspace {
        fn new() -> Self {
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
    async fn managed_memory_sink_atomically_preserves_existing_agents_markdown() {
        use xharness_interaction::{
            AnswerDestination, AskUserQuestionRequest, QuestionAnswer, QuestionInteraction,
            QuestionOption, QuestionSpec, ResolveAction,
        };

        let workspace = TempWorkspace::new();
        std::fs::write(workspace.0.join("AGENTS.md"), "# Existing\n\nKeep me.\n").unwrap();
        let invocation = QuestionInvocation::new(
            "memory-1",
            AskUserQuestionRequest {
                questions: vec![QuestionSpec {
                    id: "goal".to_owned(),
                    header: "目标".to_owned(),
                    question: "长期目标是什么？".to_owned(),
                    options: vec![QuestionOption {
                        id: "ship".to_owned(),
                        label: "完成发布".to_owned(),
                        description: None,
                        recommended: true,
                    }],
                    allow_custom: true,
                    destination: AnswerDestination::AgentMarkdown,
                }],
            },
        );
        let mut interaction = QuestionInteraction::new(invocation.clone()).unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Continue,
                vec![QuestionAnswer {
                    question_id: "goal".to_owned(),
                    selected_option_id: Some("ship".to_owned()),
                    custom_text: None,
                }],
            )
            .unwrap();
        let sink = ManagedAgentMarkdownSink::new();
        sink.persist(&workspace.0, &invocation, &resolution)
            .await
            .unwrap();
        sink.persist(&workspace.0, &invocation, &resolution)
            .await
            .unwrap();
        let text = std::fs::read_to_string(workspace.0.join("AGENTS.md")).unwrap();
        assert!(text.starts_with("# Existing\n\nKeep me."));
        assert_eq!(text.matches("长期目标是什么").count(), 1);
        assert!(text.contains("完成发布"));
    }

    #[tokio::test]
    async fn production_factory_projects_ask_user_question_through_the_normal_registry() {
        let workspace = TempWorkspace::new();
        let store: Arc<dyn xharness_session::Store> =
            Arc::new(xharness_session::MemorySessionStore::default());
        let hub = DurableQuestionHub::new(store, Arc::new(NoopTestSink));
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
    async fn production_factory_projects_the_three_schedule_tools() {
        let workspace = TempWorkspace::new();
        let store: Arc<dyn xharness_session::Store> =
            Arc::new(xharness_session::MemorySessionStore::default());
        store
            .create(xharness_session::SessionHeader::new("schedules"))
            .await
            .unwrap();
        let questions = DurableQuestionHub::new(Arc::clone(&store), Arc::new(NoopTestSink));
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
        for name in ["schedule_create", "schedule_list", "schedule_delete"] {
            assert!(names.contains(name), "missing {name}");
        }
    }

    struct NoopTestSink;

    #[async_trait]
    impl AgentMarkdownSink for NoopTestSink {
        async fn persist(
            &self,
            _workspace: &Path,
            _invocation: &QuestionInvocation,
            _resolution: &QuestionResolution,
        ) -> Result<(), String> {
            Ok(())
        }
    }
}
