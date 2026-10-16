#![forbid(unsafe_code)]
use super::*;

struct RetiredTools {
    released: Mutex<Vec<String>>,
}
#[async_trait]
impl SessionToolFactory for RetiredTools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<xharness_tools::ToolExecutor, String> {
        Err("no tools requested".into())
    }
    async fn release_session(&self, id: &str) -> Result<(), String> {
        self.released.lock().unwrap().push(id.to_owned());
        Ok(())
    }
}

#[tokio::test]
async fn permanent_deletion_retires_all_runtime_owners_before_deleting_data() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let leases = Arc::new(MemoryLeaseManager::default());
    let tools = Arc::new(RetiredTools {
        released: Mutex::new(vec![]),
    });
    let schedules = ScheduleManager::new(store.clone());
    let runtime = DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(ScriptProvider {
            answers: Mutex::new(VecDeque::new()),
        })),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        leases.clone(),
        16,
    )
    .with_schedules(schedules.clone());
    for id in ["deleted", "other"] {
        let handle = runtime
            .prepare_automation_worker(AgentSessionRequest {
                session_id: id.into(),
                cwd: "/workspace".into(),
                route: ModelRoute::new("test", "test-model"),
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
            })
            .await
            .unwrap();
        handle.when_ready().await.unwrap();
    }
    let handle = runtime.supervisor.get("deleted").await.unwrap();
    runtime
        .goals
        .prepare("deleted", "delivery", handle.subscribe())
        .await
        .unwrap();
    drop(handle);
    runtime.delete_session_data("deleted").await.unwrap();
    assert!(runtime.supervisor.get("deleted").await.is_none());
    assert!(!runtime.sessions.read().await.contains_key("deleted"));
    assert!(!runtime.goals.handles.read().await.contains_key("deleted"));
    assert!(runtime.goals.prepared.lock().await.is_empty());
    assert!(store.load("deleted").await.unwrap().is_none());
    assert!(store.load("other").await.unwrap().is_some());
    assert_eq!(tools.released.lock().unwrap().as_slice(), &["deleted"]);
    use xharness_agent::LeaseManager;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if leases.acquire("deleted").await.is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    runtime.delete_session_data("deleted").await.unwrap();
    assert!(runtime
        .prepare_automation_worker(AgentSessionRequest {
            session_id: "deleted".into(),
            cwd: "/workspace".into(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None
        })
        .await
        .is_err());
    assert!(store.load("deleted").await.unwrap().is_none());
    assert!(!runtime.sessions.read().await.contains_key("deleted"));
    assert!(runtime.shutdown(Duration::from_secs(2)).await.is_graceful());
}
