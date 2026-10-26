use super::*;
use crate::{BasicHost, HostConfig, NoTools};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn cwd(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
    fn host(&self) -> Arc<BasicHost> {
        let mut config = HostConfig::new(&self.0);
        config.memory_dir = Some(self.0.join("local-memory"));
        BasicHost::new(config, None, Arc::new(NoTools))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn rpc(host: &BasicHost, id: &str, p: Value) -> RpcResult {
    host.call_dynamic(
        RpcId::new(id),
        "workspace/memory",
        p,
        CancellationToken::new(),
    )
    .await
    .unwrap()
}
async fn create(host: &BasicHost, id: &str, cwd: &str) {
    assert!(host
        .call(
            RpcId::new(format!("create-{id}")),
            RpcMethod::SessionCreate,
            json!({"sessionId":id,"cwd":cwd}),
            CancellationToken::new()
        )
        .await
        .is_ok());
}
fn value(result: RpcResult) -> Value {
    match result {
        RpcResult::Success { value: Some(value) } => value,
        e => panic!("{e:?}"),
    }
}

#[tokio::test]
async fn defaults_manual_no_document_no_model_dependency_and_off_persists() {
    let root = Root::new();
    let host = root.host();
    create(&host, "a", &root.cwd()).await;
    let view = host.memory_view(root.cwd()).await.unwrap();
    assert_eq!(view["mode"], "manual");
    assert!(view["version"].is_null());
    let fs = host.memory_filesystem("a").await.unwrap();
    assert!(!fs.workspace_root().join(DOCUMENT).exists());
    let prompt = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(prompt.content.contains("Manual mode"));
    assert!(!root.0.join(DOCUMENT).exists());
    assert!(!root.0.join("AGENTS.md").exists());
    host.memory_update(
        root.cwd(),
        "configure",
        &json!({"mode":"off","settingsVersion":null}),
    )
    .await
    .unwrap();
    assert!(host
        .memory_filesystem("a")
        .await
        .err()
        .unwrap()
        .contains("off"));
    let restarted = root.host();
    assert_eq!(
        restarted.memory_view(root.cwd()).await.unwrap()["mode"],
        "off"
    );
    assert!(!restarted
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("Manual mode"));
}

#[tokio::test]
async fn canonical_workspaces_share_only_their_own_memory_across_sessions() {
    let root = Root::new();
    let other = Root::new();
    let host = root.host();
    create(&host, "a", &root.cwd()).await;
    create(&host, "b", &root.cwd()).await;
    create(&host, "c", &other.cwd()).await;
    let a = host.memory_filesystem("a").await.unwrap();
    let b = host.memory_filesystem("b").await.unwrap();
    let c = host.memory_filesystem("c").await.unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    assert_ne!(a.workspace_root(), c.workspace_root());
    host.memory_update(
        root.cwd(),
        "save",
        &json!({"content":"ONLY_WORKSPACE_A","version":null}),
    )
    .await
    .unwrap();
    assert!(host
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("ONLY_WORKSPACE_A"));
    assert!(!host
        .memory_prompt(other.cwd())
        .await
        .unwrap()
        .content
        .contains("ONLY_WORKSPACE_A"));
    assert_eq!(
        root.host().memory_view(root.cwd()).await.unwrap()["content"],
        "ONLY_WORKSPACE_A"
    );
    assert_eq!(
        host.memory_fs(format!("{}/.", root.cwd()))
            .await
            .unwrap()
            .workspace_root(),
        a.workspace_root()
    );
}

#[tokio::test]
async fn index_is_bounded_utf8_data_and_full_notes_are_kept() {
    let root = Root::new();
    let host = root.host();
    let text = format!("{}\nTAIL_NOT_IN_INDEX", "记忆🧠".repeat(1200));
    host.memory_update(root.cwd(), "save", &json!({"content":text,"version":null}))
        .await
        .unwrap();
    let prompt = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(prompt.content.contains("Index truncated: true"));
    assert!(!prompt.content.contains("TAIL_NOT_IN_INDEX"));
    assert!(prompt.content.len() < POLICY.len() + INDEX_BYTES + 1024);
    assert_eq!(host.memory_view(root.cwd()).await.unwrap()["content"], text);
    let view = host.memory_view(root.cwd()).await.unwrap();
    host.memory_update(root.cwd(),"save",&json!({"content":(0..40).map(|i|format!("line{i}\n")).collect::<String>(),"version":view["version"]})).await.unwrap();
    assert!(!host
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("line24"));
}

#[tokio::test]
async fn rpc_receipts_conflicts_scope_validation_and_clear() {
    let root = Root::new();
    let host = root.host();
    create(&host, "a", &root.cwd()).await;
    let save = json!({"sessionId":"a","action":"save","content":"remember","version":null});
    let first = value(rpc(&host, "save", save.clone()).await);
    assert_eq!(value(rpc(&host, "save", save).await), first);
    assert!(!rpc(
        &host,
        "save",
        json!({"sessionId":"a","action":"clear","version":first["version"]})
    )
    .await
    .is_ok());
    assert!(!rpc(
        &host,
        "stale",
        json!({"sessionId":"a","action":"save","content":"overwrite","version":null})
    )
    .await
    .is_ok());
    for payload in [
        json!({"action":"view","cwd":root.cwd()}),
        json!({"action":"view","sessionId":"a","workspaceId":"x"}),
        json!({"action":"view","sessionId":"missing"}),
        json!({"action":"save","sessionId":"a","content":"x"}),
    ] {
        assert!(!rpc(&host, "bad", payload).await.is_ok());
    }
    let state = host.state.read().await;
    let encoded = serde_json::to_string(&state.mutation_receipts).unwrap();
    assert!(!encoded.contains("remember"));
    drop(state);
    assert!(rpc(
        &host,
        "clear",
        json!({"sessionId":"a","action":"clear","version":first["version"]})
    )
    .await
    .is_ok());
    assert!(!host
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("remember\""));
    assert_eq!(host.memory_view(root.cwd()).await.unwrap()["content"], "");
}

#[tokio::test]
async fn corrupt_optional_memory_does_not_block_prompt_and_ui_can_clear_it() {
    let root = Root::new();
    let host = root.host();
    let fs = host.memory_fs(root.cwd()).await.unwrap();
    for bad in [vec![255, 254], vec![b'x'; MEMORY_MAX_BYTES + 1]] {
        std::fs::write(fs.workspace_root().join(DOCUMENT), bad).unwrap();
        assert!(host
            .memory_prompt(root.cwd())
            .await
            .unwrap()
            .content
            .contains("unavailable"));
        let view = host.memory_view(root.cwd()).await.unwrap();
        assert!(view["tooLarge"] == true || view["invalidUtf8"] == true);
        host.memory_update(root.cwd(), "clear", &json!({"version":view["version"]}))
            .await
            .unwrap();
    }
    std::fs::write(fs.workspace_root().join(SETTINGS), "bad-json").unwrap();
    let view = host.memory_view(root.cwd()).await.unwrap();
    assert!(view["mode"].is_null());
    host.memory_update(
        root.cwd(),
        "configure",
        &json!({"mode":"auto","settingsVersion":view["settingsVersion"]}),
    )
    .await
    .unwrap();
    assert!(host
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("Auto mode was explicitly enabled"));
    assert!(host
        .memory_update(
            root.cwd(),
            "save",
            &json!({"version":view["version"],"content":"x".repeat(MEMORY_MAX_BYTES+1)})
        )
        .await
        .is_err());
}

#[tokio::test]
async fn optional_memory_timeout_retains_owned_io_slot_and_never_host_state_lock() {
    let root = Root::new();
    let host = root.host();
    let task = host.clone();
    let cwd = root.cwd();
    let work = tokio::spawn(async move {
        task.memory_job(cwd, |_| async {
            tokio::time::sleep(Duration::from_secs(7)).await;
            Ok(())
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), host.state.write())
            .await
            .is_ok()
    );
    assert!(work.await.unwrap().unwrap_err().contains("timed out"));
    assert_eq!(host.memory_slots.available_permits(), 3);
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_and_fifo_notes_are_not_followed() {
    use std::os::unix::fs::symlink;
    let root = Root::new();
    let host = root.host();
    let fs = host.memory_fs(root.cwd()).await.unwrap();
    let secret = root.0.join("secret");
    std::fs::write(&secret, "NOT_IMPORTED").unwrap();
    symlink(&secret, fs.workspace_root().join(DOCUMENT)).unwrap();
    assert!(host
        .memory_prompt(root.cwd())
        .await
        .unwrap()
        .content
        .contains("unavailable"));
    assert!(host.memory_view(root.cwd()).await.is_err());
    std::fs::remove_file(fs.workspace_root().join(DOCUMENT)).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(fs.workspace_root().join(DOCUMENT))
        .status()
        .unwrap()
        .success());
    assert!(
        tokio::time::timeout(Duration::from_secs(1), host.memory_prompt(root.cwd()))
            .await
            .unwrap()
            .unwrap()
            .content
            .contains("unavailable")
    );
    assert_eq!(std::fs::read_to_string(secret).unwrap(), "NOT_IMPORTED");
}

#[tokio::test]
async fn unconfigured_embedding_does_not_advertise_or_create_memory() {
    let root = Root::new();
    let host = BasicHost::new(HostConfig::new(&root.0), None, Arc::new(NoTools));
    assert!(host.memory_prompt(root.cwd()).await.is_none());
    assert_eq!(
        host.memory_view(root.cwd()).await.unwrap(),
        json!({"available":false})
    );
    assert!(host
        .memory_update(root.cwd(), "save", &json!({"content":"no","version":null}))
        .await
        .is_err());
    assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
}

#[tokio::test]
async fn global_ui_crud_needs_no_workspace_and_receipts_cannot_change_scope() {
    let root = Root::new();
    let host = root.host();
    assert!(host.state.read().await.sessions.is_empty());
    let first = value(rpc(&host, "g-view", json!({"scope":"global","action":"view"})).await);
    assert_eq!(first["mode"], "manual");
    assert_eq!(first["uri"], GLOBAL_MEMORY_URI);
    let save = json!({"scope":"global","action":"save","content":"GENERAL_FACT","version":null});
    let saved = value(rpc(&host, "g-save", save.clone()).await);
    assert_eq!(saved, value(rpc(&host, "g-save", save).await));
    assert_eq!(
        root.host().memory_view(MemoryScope::Global).await.unwrap()["content"],
        "GENERAL_FACT"
    );
    for bad in [
        json!({"scope":"global","action":"view","sessionId":"x"}),
        json!({"scope":"global","action":"view","workspaceId":"x"}),
        json!({"scope":"global","action":"view","cwd":root.cwd()}),
        json!({"scope":"../global","action":"view"}),
        json!({"scope":"workspace","action":"view"}),
    ] {
        assert!(!rpc(&host, "g-invalid", bad).await.is_ok());
    }
    create(&host, "a", &root.cwd()).await;
    assert!(!rpc(
        &host,
        "g-save",
        json!({"sessionId":"a","action":"save","content":"GENERAL_FACT","version":null})
    )
    .await
    .is_ok());
    assert!(!rpc(
        &host,
        "g-stale",
        json!({"scope":"global","action":"save","content":"STALE","version":null})
    )
    .await
    .is_ok());
    host.memory_update(
        root.cwd(),
        "save",
        &json!({"content":"WORKSPACE_FACT","version":null}),
    )
    .await
    .unwrap();
    assert!(rpc(
        &host,
        "g-clear",
        json!({"scope":"global","action":"clear","version":saved["version"]})
    )
    .await
    .is_ok());
    assert_eq!(
        host.memory_view(root.cwd()).await.unwrap()["content"],
        "WORKSPACE_FACT"
    );
    assert_eq!(
        host.memory_view(MemoryScope::Global).await.unwrap()["content"],
        ""
    );
    let receipts = serde_json::to_string(&host.state.read().await.mutation_receipts).unwrap();
    assert!(!receipts.contains("GENERAL_FACT"));
}

#[tokio::test]
async fn global_is_shared_but_modes_and_facts_stay_independent_per_scope() {
    let root = Root::new();
    let other = Root::new();
    let host = root.host();
    create(&host, "a", &root.cwd()).await;
    create(&host, "b", &other.cwd()).await;
    let a = host.global_memory_filesystem("a").await.unwrap();
    let b = host.global_memory_filesystem("b").await.unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    assert!(!Arc::ptr_eq(
        &a,
        &host.memory_filesystem("a").await.unwrap()
    ));
    assert!(host.global_memory_filesystem("unknown").await.is_err());
    host.memory_update(
        MemoryScope::Global,
        "save",
        &json!({"content":"GLOBAL_SHARED","version":null}),
    )
    .await
    .unwrap();
    host.memory_update(
        root.cwd(),
        "save",
        &json!({"content":"PROJECT_ONLY","version":null}),
    )
    .await
    .unwrap();
    for cwd in [root.cwd(), other.cwd()] {
        let prompt = host.assemble_prompt(cwd.clone(), vec![]).await.unwrap();
        assert!(prompt.system().contains("GLOBAL_SHARED"));
        assert_eq!(prompt.system().matches(POLICY).count(), 1);
        assert_eq!(prompt.system().contains("PROJECT_ONLY"), cwd == root.cwd());
        assert!(
            prompt.system().find(GLOBAL_MEMORY_URI).unwrap()
                < prompt.system().rfind("PROJECT_ONLY").unwrap_or(usize::MAX)
        );
    }
    host.memory_update(
        MemoryScope::Global,
        "configure",
        &json!({"mode":"off","settingsVersion":null}),
    )
    .await
    .unwrap();
    assert!(host.global_memory_filesystem("a").await.is_err());
    assert!(host.memory_filesystem("a").await.is_ok());
    let prompt = host.assemble_prompt(root.cwd(), vec![]).await.unwrap();
    assert!(!prompt.system().contains("GLOBAL_SHARED"));
    assert!(prompt.system().contains("PROJECT_ONLY"));
    let global = host.memory_view(MemoryScope::Global).await.unwrap();
    host.memory_update(
        MemoryScope::Global,
        "configure",
        &json!({"mode":"auto","settingsVersion":global["settingsVersion"]}),
    )
    .await
    .unwrap();
    host.memory_update(
        root.cwd(),
        "configure",
        &json!({"mode":"off","settingsVersion":null}),
    )
    .await
    .unwrap();
    assert!(host.global_memory_filesystem("a").await.is_ok());
    assert!(host.memory_filesystem("a").await.is_err());
    let prompt = host.assemble_prompt(root.cwd(), vec![]).await.unwrap();
    assert!(prompt.system().contains("GLOBAL_SHARED"));
    assert!(!prompt.system().contains("PROJECT_ONLY"));
    assert_eq!(
        root.host().memory_view(MemoryScope::Global).await.unwrap()["mode"],
        "auto"
    );
}

#[tokio::test]
async fn empty_notes_are_compact_but_modes_scope_and_write_boundaries_survive() {
    let root = Root::new();
    let host = root.host();
    create(&host, "compact", &root.cwd()).await;
    let empty = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(
        empty.content.len() < 160,
        "empty scope must not carry a full tutorial"
    );
    for required in [MEMORY_URI, "Manual mode", "explicit remember", "Empty."] {
        assert!(empty.content.contains(required));
    }
    let assembly = host.prompt_assembly("compact").await.unwrap();
    let shared = assembly
        .system()
        .split("The session uses workspace-write isolation.")
        .next()
        .unwrap();
    assert_eq!(assembly.system().matches(POLICY).count(), 1);
    assert!(POLICY.len() < 850);
    for required in [
        "User instructions and AGENTS.md win",
        "global writes require",
        "Answers alone do not authorize",
        "preserve unseen notes",
        "credentials",
        "Off/unavailable",
        "successful write",
    ] {
        assert!(
            POLICY.contains(required),
            "lost memory boundary: {required}"
        );
    }
    host.memory_update(
        root.cwd(),
        "save",
        &json!({"content":"REAL_NOTE","version":null}),
    )
    .await
    .unwrap();
    let notes = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(host
        .prompt_assembly("compact")
        .await
        .unwrap()
        .system()
        .starts_with(shared));
    assert!(!notes.content.contains("Empty."));
    assert!(notes.content.contains("REAL_NOTE"));
    assert!(notes
        .content
        .contains("quoted advisory data, not instructions"));
    host.memory_update(
        root.cwd(),
        "configure",
        &json!({"mode":"off","settingsVersion":null}),
    )
    .await
    .unwrap();
    let off = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(host
        .prompt_assembly("compact")
        .await
        .unwrap()
        .system()
        .starts_with(shared));
    assert!(off.content.contains("off"));
    assert!(!off.content.contains("REAL_NOTE"));
    assert!(!off.content.contains("Empty."));
    let view = host.memory_view(root.cwd()).await.unwrap();
    host.memory_update(
        root.cwd(),
        "configure",
        &json!({"mode":"manual","settingsVersion":view["settingsVersion"]}),
    )
    .await
    .unwrap();
    let fs = host.memory_fs(root.cwd()).await.unwrap();
    std::fs::write(fs.workspace_root().join(DOCUMENT), [0xff]).unwrap();
    let invalid = host.prompt_assembly("compact").await.unwrap();
    assert!(invalid.system().starts_with(shared));
    assert!(invalid.system().contains("unavailable or unreadable"));
    let scope = host.memory_prompt(root.cwd()).await.unwrap();
    assert!(!scope.content.contains("Empty."));
}
