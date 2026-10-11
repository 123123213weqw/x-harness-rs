//! Saved Schedule operations, exact registered scope and original native proof.
use crate::BasicHost;
use serde_json::{json, Value};
use xharness_api::{
    ApiBackend, AutomationControl, AutomationDetail, AutomationEntry, AutomationRead,
    AutomationRunView, RpcError, ScopedAutomationApplied, ScopedAutomationMutation,
    ScopedAutomationPage, ScopedAutomationRead, SCOPED_AUTOMATION_PAGE_SIZE,
};
use xharness_schedule::{
    AutomationCommand, SavedAutomationApplied, SavedAutomationControl, SavedAutomationError,
    SavedAutomationInvocation,
};
fn unavailable() -> RpcError {
    RpcError::internal("scoped automation unavailable")
}
fn native(r: &ScopedAutomationMutation) -> Result<SavedAutomationInvocation, RpcError> {
    if !r.is_bounded() {
        return Err(unavailable());
    }
    Ok(SavedAutomationInvocation {
        invocation: r.receipt_id(),
        fingerprint: xharness_control::mutation_fingerprint(
            xharness_schedule::CONTROL_RECEIPT_METHOD,
            &serde_json::to_value(r).map_err(|_| unavailable())?,
        ),
        control: match &r.control {
            AutomationControl::Pause { id } => SavedAutomationControl::Pause { id: id.clone() },
            AutomationControl::Resume { id } => SavedAutomationControl::Resume { id: id.clone() },
            AutomationControl::Delete { id } => SavedAutomationControl::Delete { id: id.clone() },
        },
    })
}
fn applied(
    r: &ScopedAutomationMutation,
    v: SavedAutomationApplied,
) -> Result<ScopedAutomationApplied, RpcError> {
    let result = ScopedAutomationApplied {
        workspace: r.workspace.clone(),
        session: r.session.clone(),
        request_key: r.request_key.clone(),
        control: r.control.clone(),
        state: serde_json::from_value(serde_json::to_value(v.state).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?,
    };
    if v.id != r.control.id() || !r.admits(&result) {
        return Err(unavailable());
    }
    Ok(result)
}
async fn scope(host: &BasicHost, w: &str, s: &str, resume: bool) -> Result<(), RpcError> {
    if !host.agent_runtime.has_authoritative_sessions() {
        return Err(unavailable());
    }
    // Reject archived resume before native recovery; pause/delete do not cancel
    // already admitted runs and preserve the existing card semantics.
    if resume && host.state.read().await.archived_sessions.contains(s) {
        return Err(unavailable());
    }
    if !host.session_in_workspace(w, s).await? {
        return Err(unavailable());
    }
    Ok(())
}
fn domain_error(e: SavedAutomationError) -> RpcError {
    match e {
        SavedAutomationError::NotActive => RpcError::internal("saved automation not active"),
        SavedAutomationError::Conflict => {
            RpcError::internal("saved automation original identity conflict")
        }
        _ => unavailable(),
    }
}
pub(super) async fn control(
    host: &BasicHost,
    r: ScopedAutomationMutation,
) -> Result<ScopedAutomationApplied, RpcError> {
    let request = native(&r)?;
    let resume = matches!(r.control, AutomationControl::Resume { .. });
    scope(host, &r.workspace, &r.session, resume).await?;
    let guard = host.lock_admission(&r.session).await;
    scope(host, &r.workspace, &r.session, resume).await?;
    let host = host
        .self_ref
        .get()
        .and_then(std::sync::Weak::upgrade)
        .ok_or_else(unavailable)?;
    // This owned native writer retains admission and publication even if the API
    // waiter disappears. Schedule independently owns its 32-slot write/drain gate.
    tokio::spawn(async move {
        let _guard = guard;
        let v = host
            .agent_runtime
            .saved_automation_control(&r.session, request)
            .await
            .map_err(domain_error)?;
        host.sync_authoritative_session(&r.session).await?;
        applied(&r, v)
    })
    .await
    .map_err(|_| unavailable())?
}
pub(super) async fn receipt(
    host: &BasicHost,
    r: ScopedAutomationMutation,
) -> Result<Option<ScopedAutomationApplied>, RpcError> {
    let request = native(&r)?;
    scope(host, &r.workspace, &r.session, false).await?;
    let _guard = host.lock_admission(&r.session).await;
    scope(host, &r.workspace, &r.session, false).await?;
    host.agent_runtime
        .saved_automation_receipt(&r.session, &request)
        .await
        .map_err(domain_error)?
        .map(|v| applied(&r, v))
        .transpose()
}
fn entry(v: &Value, list: bool) -> Result<AutomationEntry, RpcError> {
    let prompt = v
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?;
    let preview = list
        && v.get("promptIsPreview")
            .and_then(Value::as_bool)
            .ok_or_else(unavailable)?;
    let prompt = if list {
        prompt.chars().take(160).collect::<String>()
    } else {
        if prompt.len() > 200_000 {
            return Err(unavailable());
        }
        prompt.to_owned()
    };
    serde_json::from_value(json!({"id":v["id"],"prompt":prompt,"prompt_is_preview":preview,"kind":v["kind"],"mode":v["mode"],"target":v["target"],"state":v["state"],"scheduled_at":v["scheduledAt"],"after_seconds":v.get("afterSeconds"),"every_seconds":v.get("everySeconds")})).map_err(|_|unavailable())
}
pub(super) async fn read(
    host: &BasicHost,
    r: ScopedAutomationRead,
) -> Result<ScopedAutomationPage, RpcError> {
    if !r.is_bounded() {
        return Err(unavailable());
    }
    scope(host, &r.workspace, &r.session, false).await?;
    let _guard = host.lock_admission(&r.session).await;
    scope(host, &r.workspace, &r.session, false).await?;
    let command = match &r.read {
        AutomationRead::List { .. } => AutomationCommand::List {},
        AutomationRead::View { id } => AutomationCommand::View { id: id.clone() },
    };
    let value = host
        .agent_runtime
        .saved_automation_read(
            &r.session,
            command,
            match &r.read {
                AutomationRead::List { after } => after.clone(),
                AutomationRead::View { .. } => None,
            },
        )
        .await
        .map_err(domain_error)?;
    let (entries, next, detail) = match &r.read {
        AutomationRead::List { after } => {
            let values = value["entries"].as_array().ok_or_else(unavailable)?;
            if values.len() > SCOPED_AUTOMATION_PAGE_SIZE {
                return Err(unavailable());
            }
            let selected = values
                .iter()
                .map(|v| entry(v, true))
                .collect::<Result<Vec<_>, _>>()?;
            let next = serde_json::from_value::<Option<String>>(value["next"].clone())
                .map_err(|_| unavailable())?;
            let _ = after;
            (selected, next, None)
        }
        AutomationRead::View { .. } => {
            let runs=value["runs"].as_array().ok_or_else(unavailable)?.iter().map(|v|serde_json::from_value::<AutomationRunView>(json!({"id":v["runId"],"occurrence_at":v["occurrenceAt"],"state":v["state"]})).map_err(|_|unavailable())).collect::<Result<Vec<_>,_>>()?;
            (
                vec![entry(&value, false)?],
                None,
                Some(AutomationDetail {
                    runs,
                    run_count: value["runCount"].as_u64().ok_or_else(unavailable)?,
                    admitted_run_count: value["admittedRunCount"]
                        .as_u64()
                        .ok_or_else(unavailable)?,
                }),
            )
        }
    };
    let page = ScopedAutomationPage {
        workspace: r.workspace.clone(),
        session: r.session.clone(),
        read: r.read.clone(),
        entries,
        next,
        detail,
    };
    if !r.admits(&page) {
        return Err(unavailable());
    }
    // Reads only project saved native state. Ordinary Host recovery of already
    // admitted work remains native-owned; this seam does not admit a model turn.
    host.sync_authoritative_session(&r.session).await?;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentRuntime, DurableLoopAgentRuntime, HostConfig, NoTools};
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        sync::Arc,
    };
    use tokio_util::sync::CancellationToken;
    use xharness_agent::MemoryLeaseManager;
    use xharness_api::{AutomationControlState, AutomationState, RpcId, RpcMethod, RpcResult};
    use xharness_core::{
        IdentityContextPolicy, ModelProvider, ProviderError, ProviderRequest, ProviderStream,
    };
    use xharness_schedule::ScheduleManager;
    use xharness_session::{MemorySessionStore, Store};
    struct Provider(AtomicUsize);
    #[async_trait::async_trait]
    impl ModelProvider for Provider {
        async fn stream(
            &self,
            _: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            panic!("native automation controls must not invoke a model");
        }
    }
    async fn setup() -> (
        Arc<BasicHost>,
        Arc<DurableLoopAgentRuntime>,
        Arc<MemorySessionStore>,
        Arc<ScheduleManager>,
        Arc<Provider>,
    ) {
        let store = Arc::new(MemorySessionStore::default());
        let schedules = ScheduleManager::new(store.clone());
        let provider = Arc::new(Provider(AtomicUsize::new(0)));
        let runtime = Arc::new(
            DurableLoopAgentRuntime::new(
                "fixture",
                "fixture",
                Some(provider.clone()),
                Arc::new(NoTools),
                Arc::new(IdentityContextPolicy),
                store.clone(),
                Arc::new(MemoryLeaseManager::default()),
                64,
            )
            .with_schedules(schedules.clone()),
        );
        let mut config = HostConfig::new(std::env::temp_dir());
        config.provider_id = "fixture".into();
        config.model_id = "fixture".into();
        config.auto_titles = false;
        let host = BasicHost::with_agent_runtime(config, runtime.clone());
        for id in ["s", "other"] {
            assert!(matches!(
                host.call(
                    RpcId::new(id),
                    RpcMethod::SessionCreate,
                    json!({"workspaceId":"workspace-default","sessionId":id}),
                    CancellationToken::new()
                )
                .await,
                RpcResult::Success { .. }
            ));
        }
        (host, runtime, store, schedules, provider)
    }
    async fn create(m: &ScheduleManager, s: &str, key: &str, prompt: &str) -> String {
        m.execute(
            s,
            key,
            serde_json::from_value(json!({"action":"create","prompt":prompt,"after_seconds":3600}))
                .unwrap(),
        )
        .await["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn query(read: AutomationRead) -> ScopedAutomationRead {
        ScopedAutomationRead {
            workspace: "workspace-default".into(),
            session: "s".into(),
            read,
        }
    }
    fn mutation(c: AutomationControl, key: char) -> ScopedAutomationMutation {
        ScopedAutomationMutation {
            workspace: "workspace-default".into(),
            session: "s".into(),
            request_key: key.to_string().repeat(64),
            control: c,
        }
    }
    #[tokio::test]
    async fn native_scoped_automation_pages_view_and_original_controls_share_existing_schedule_without_model(
    ) {
        let (h, runtime, store, m, provider) = setup().await;
        let long = "🧪 saved user task ".repeat(40);
        let id = create(&m, "s", "one", &long).await;
        let _foreign = create(&m, "other", "private", "PRIVATE_OTHER_TASK").await;
        for n in 0..26 {
            create(&m, "s", &format!("rule-{n}"), &format!("saved {n}")).await;
        }
        h.sync_authoritative_session("s").await.unwrap();
        let mut after = None;
        let mut ids = Vec::new();
        loop {
            let q = query(AutomationRead::List { after });
            let page = h.scoped_automation_read(q.clone()).await.unwrap();
            assert!(q.admits(&page));
            assert!(!serde_json::to_string(&page)
                .unwrap()
                .contains("PRIVATE_OTHER"));
            for e in &page.entries {
                if e.id == id {
                    assert!(e.prompt_is_preview);
                    assert_eq!(e.prompt.chars().count(), 160);
                }
            }
            ids.extend(page.entries.iter().map(|e| e.id.clone()));
            match page.next {
                Some(n) => after = Some(n),
                None => break,
            }
        }
        assert_eq!(ids.len(), 27);
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
        let q = query(AutomationRead::View { id: id.clone() });
        let view = h.scoped_automation_read(q).await.unwrap();
        assert_eq!(view.entries[0].prompt, long.trim());
        assert!(!view.entries[0].prompt_is_preview);
        assert_eq!(view.detail.unwrap().run_count, 0);
        let pause = mutation(AutomationControl::Pause { id: id.clone() }, 'a');
        assert!(h
            .scoped_automation_receipt(pause.clone())
            .await
            .unwrap()
            .is_none());
        let applied = h.scoped_automation_control(pause.clone()).await.unwrap();
        assert_eq!(applied.state, AutomationControlState::Paused);
        assert!(pause.admits(&applied));
        assert!(
            h.state.read().await.sessions["s"]
                .schedules
                .iter()
                .find(|s| s.id == id)
                .unwrap()
                .automation
                .as_ref()
                .unwrap()
                .paused
        );
        h.scoped_automation_control(mutation(AutomationControl::Resume { id: id.clone() }, 'b'))
            .await
            .unwrap();
        let before = store.load("s").await.unwrap().unwrap();
        assert_eq!(
            h.scoped_automation_control(pause.clone()).await.unwrap(),
            applied
        );
        assert_eq!(
            store.load("s").await.unwrap().unwrap().events(),
            before.events()
        );
        h.scoped_automation_control(mutation(AutomationControl::Delete { id: id.clone() }, 'c'))
            .await
            .unwrap();
        assert_eq!(
            h.scoped_automation_read(query(AutomationRead::View { id: id.clone() }))
                .await
                .unwrap()
                .entries[0]
                .state,
            AutomationState::Deleted
        );
        assert_eq!(
            h.scoped_automation_receipt(pause).await.unwrap(),
            Some(applied)
        );
        assert_eq!(provider.0.load(Ordering::SeqCst), 0);
        runtime.shutdown(std::time::Duration::from_secs(5)).await;
    }
    #[tokio::test]
    async fn native_automation_rejects_foreign_workspace_and_other_session_rule_without_mutation() {
        let (h, runtime, store, m, p) = setup().await;
        let id = create(&m, "other", "foreign", "PRIVATE_FOREIGN").await;
        let before = store.load("s").await.unwrap().unwrap();
        let mut req = mutation(AutomationControl::Pause { id: id.clone() }, 'a');
        req.workspace = "unregistered".into();
        assert!(h.scoped_automation_control(req).await.is_err());
        assert!(h
            .scoped_automation_control(mutation(AutomationControl::Delete { id }, 'b'))
            .await
            .is_err());
        assert_eq!(
            store.load("s").await.unwrap().unwrap().events(),
            before.events()
        );
        assert_eq!(p.0.load(Ordering::SeqCst), 0);
        runtime.shutdown(std::time::Duration::from_secs(5)).await;
    }
    #[tokio::test]
    async fn archived_automation_can_pause_delete_but_cannot_resume() {
        let (h, runtime, _, m, p) = setup().await;
        let id = create(&m, "s", "one", "saved task").await;
        h.state.write().await.archived_sessions.insert("s".into());
        h.scoped_automation_control(mutation(AutomationControl::Pause { id: id.clone() }, 'a'))
            .await
            .unwrap();
        assert!(h
            .scoped_automation_control(mutation(AutomationControl::Resume { id: id.clone() }, 'b'))
            .await
            .is_err());
        h.scoped_automation_control(mutation(AutomationControl::Delete { id }, 'c'))
            .await
            .unwrap();
        assert_eq!(p.0.load(Ordering::SeqCst), 0);
        runtime.shutdown(std::time::Duration::from_secs(5)).await;
    }
    #[tokio::test]
    async fn native_jsonl_host_restart_recovers_original_control_without_reapplying_it() {
        let dir = std::env::temp_dir().join(format!(
            "xh-scoped-automation-{}-{}",
            std::process::id(),
            crate::state::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let provider = Arc::new(Provider(AtomicUsize::new(0)));
        async fn compose(
            dir: &std::path::Path,
            store: Arc<dyn Store>,
            provider: Arc<Provider>,
        ) -> (
            Arc<BasicHost>,
            Arc<DurableLoopAgentRuntime>,
            Arc<ScheduleManager>,
        ) {
            let schedules = ScheduleManager::new(store.clone());
            let runtime = Arc::new(
                DurableLoopAgentRuntime::new(
                    "fixture",
                    "fixture",
                    Some(provider),
                    Arc::new(NoTools),
                    Arc::new(IdentityContextPolicy),
                    store,
                    Arc::new(MemoryLeaseManager::default()),
                    64,
                )
                .with_schedules(schedules.clone()),
            );
            let mut config = HostConfig::new(dir);
            config.provider_id = "fixture".into();
            config.model_id = "fixture".into();
            config.auto_titles = false;
            (
                BasicHost::with_agent_runtime(config, runtime.clone()),
                runtime,
                schedules,
            )
        }
        let (pause, applied, event_count) = {
            let store: Arc<dyn Store> = Arc::new(
                xharness_session_jsonl::JsonlSessionStore::new(dir.join("sessions"))
                    .unwrap()
                    .for_runtime(),
            );
            let (h, r, m) = compose(&dir, store.clone(), provider.clone()).await;
            assert!(matches!(
                h.call(
                    RpcId::new("create"),
                    RpcMethod::SessionCreate,
                    json!({"workspaceId":"workspace-default","sessionId":"s"}),
                    CancellationToken::new()
                )
                .await,
                RpcResult::Success { .. }
            ));
            let id = create(&m, "s", "first", "saved task after disk restart").await;
            let pause = mutation(AutomationControl::Pause { id }, 'a');
            let applied = h.scoped_automation_control(pause.clone()).await.unwrap();
            let count = store.load("s").await.unwrap().unwrap().events().len();
            r.shutdown(std::time::Duration::from_secs(2)).await;
            (pause, applied, count)
        };
        let store: Arc<dyn Store> = Arc::new(
            xharness_session_jsonl::JsonlSessionStore::new(dir.join("sessions"))
                .unwrap()
                .for_runtime(),
        );
        let (h, r, _) = compose(&dir, store.clone(), provider.clone()).await;
        h.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(
            h.scoped_automation_receipt(pause.clone()).await.unwrap(),
            Some(applied.clone())
        );
        assert_eq!(
            h.scoped_automation_control(pause.clone()).await.unwrap(),
            applied
        );
        assert_eq!(
            store.load("s").await.unwrap().unwrap().events().len(),
            event_count
        );
        let id = pause.control.id().to_owned();
        h.scoped_automation_control(mutation(AutomationControl::Resume { id: id.clone() }, 'b'))
            .await
            .unwrap();
        let before = store.load("s").await.unwrap().unwrap();
        assert_eq!(h.scoped_automation_control(pause).await.unwrap(), applied);
        assert_eq!(
            store.load("s").await.unwrap().unwrap().events(),
            before.events()
        );
        assert!(
            !h.state.read().await.sessions["s"].schedules[0]
                .automation
                .as_ref()
                .unwrap()
                .paused
        );
        assert_eq!(provider.0.load(Ordering::SeqCst), 0);
        r.shutdown(std::time::Duration::from_secs(2)).await;
        drop(h);
        drop(r);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
