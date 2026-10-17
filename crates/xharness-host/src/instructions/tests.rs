use super::*;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_api::{ApiBackend, RpcId, RpcMethod};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

pub(super) struct Root(pub(super) PathBuf);
impl Root {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-instructions-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub(super) fn write(&self, text: impl AsRef<[u8]>) {
        std::fs::write(self.0.join("AGENTS.md"), text).unwrap();
    }
    async fn load(&self) -> Result<Option<PromptSection>, String> {
        InstructionLoader::default()
            .load(self.0.to_string_lossy().into())
            .await
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn create(host: &crate::BasicHost, id: &str, root: &Root) {
    assert!(host
        .call(
            RpcId::new(format!("create-{id}")),
            RpcMethod::SessionCreate,
            json!({"sessionId": id,"cwd":root.0}),
            tokio_util::sync::CancellationToken::new()
        )
        .await
        .is_ok());
}

#[tokio::test]
async fn absent_and_empty_files_do_not_create_rules_or_files() {
    let root = Root::new();
    assert!(root.load().await.unwrap().is_none());
    assert!(!root.0.join("AGENTS.md").exists());
    root.write("\u{feff} \n\t");
    assert!(root.load().await.unwrap().is_none());
}

#[tokio::test]
async fn root_is_full_utf8_content_addressed_and_not_a_recursive_scan() {
    let root = Root::new();
    std::fs::create_dir(root.0.join("child")).unwrap();
    std::fs::write(root.0.join("child/AGENTS.md"), "CHILD_ONLY").unwrap();
    root.write("\u{feff}# 项目规则\n测试只能在 V100 上运行。\n");
    let first = root.load().await.unwrap().unwrap();
    assert!(first.content.contains("测试只能在 V100 上运行。"));
    assert!(!first.content.contains("CHILD_ONLY"));
    assert!(!first.content.contains('\u{feff}'));
    assert_eq!(first, root.load().await.unwrap().unwrap());
    assert!(first.version.starts_with("sha256:"));
    assert!(POLICY.contains("inspect AGENTS.md in its ancestor directories"));
    assert!(POLICY.contains("More specific instructions apply only to their directory subtree"));
}

#[tokio::test]
async fn never_reads_a_parent_or_another_workspace() {
    let parent = Root::new();
    parent.write("PARENT_NOT_SELECTED");
    let child = parent.0.join("child");
    std::fs::create_dir(&child).unwrap();
    assert!(InstructionLoader::default()
        .load(child.to_string_lossy().into())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn legacy_answers_are_excluded_without_rewriting_disk() {
    let root = Root::new();
    let text = format!("ROOT_RULE\n{AGENT_MEMORY_BEGIN}\nOLD_ANSWER\n{AGENT_MEMORY_END}\nTAIL_RULE\n{AGENT_MEMORY_BEGIN}\nOTHER_ANSWER\n{AGENT_MEMORY_END}");
    root.write(&text);
    let section = root.load().await.unwrap().unwrap();
    assert!(section.content.contains("ROOT_RULE"));
    assert!(section.content.contains("TAIL_RULE"));
    assert!(!section.content.contains("OLD_ANSWER"));
    assert!(!section.content.contains("OTHER_ANSWER"));
    assert_eq!(
        std::fs::read_to_string(root.0.join("AGENTS.md")).unwrap(),
        text
    );
    root.write(format!(
        "{AGENT_MEMORY_BEGIN}\nOLD_ANSWER\n{AGENT_MEMORY_END}"
    ));
    assert!(root.load().await.unwrap().is_none());
}

#[tokio::test]
async fn malformed_legacy_sections_fail_visibly_instead_of_promoting_answers() {
    let root = Root::new();
    for text in [
        format!("rule\n{AGENT_MEMORY_BEGIN}\nOLD_ANSWER"),
        format!("{AGENT_MEMORY_END}\nrule"),
        format!("{AGENT_MEMORY_BEGIN}{AGENT_MEMORY_BEGIN}OLD_ANSWER{AGENT_MEMORY_END}"),
    ] {
        root.write(&text);
        assert!(root.load().await.unwrap_err().contains("legacy memory"));
        assert_eq!(
            std::fs::read_to_string(root.0.join("AGENTS.md")).unwrap(),
            text
        );
    }
}

#[tokio::test]
async fn byte_limit_and_invalid_utf8_are_errors_not_silent_partial_rules() {
    let root = Root::new();
    root.write(vec![b'x'; MAX_BYTES]);
    assert!(root.load().await.unwrap().is_some());
    root.write(vec![b'x'; MAX_BYTES + 1]);
    assert!(root.load().await.unwrap_err().contains("byte limit"));
    root.write([0xff, 0xfe]);
    assert!(root.load().await.unwrap_err().contains("UTF-8"));
}

#[tokio::test]
async fn directory_is_not_treated_as_a_missing_instruction_file() {
    let root = Root::new();
    std::fs::create_dir(root.0.join("AGENTS.md")).unwrap();
    assert!(root.load().await.unwrap_err().contains("regular file"));
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_cannot_import_rules_from_another_workspace() {
    let root = Root::new();
    let other = Root::new();
    other.write("OTHER_WORKSPACE_SECRET");
    std::os::unix::fs::symlink(other.0.join("AGENTS.md"), root.0.join("AGENTS.md")).unwrap();
    assert!(root.load().await.unwrap_err().contains("symbolic-link"));
}

#[tokio::test]
async fn workspace_switch_and_refresh_do_not_append_rules_to_history() {
    let root = Root::new();
    let other = Root::new();
    root.write("RULE_A");
    other.write("RULE_B");
    let host = crate::BasicHost::without_provider(crate::HostConfig::new(&root.0));
    create(&host, "a", &root).await;
    create(&host, "b", &other).await;
    let first = host.prompt_assembly("a").await.unwrap();
    let b = host.prompt_assembly("b").await.unwrap();
    assert!(first.system().contains("RULE_A"));
    assert!(!first.system().contains("RULE_B"));
    assert!(b.system().contains("RULE_B"));
    assert!(!b.system().contains("RULE_A"));
    root.write("RULE_A_NEW");
    let refreshed = host.prompt_assembly("a").await.unwrap();
    assert_ne!(first.audit().assembly_id, refreshed.audit().assembly_id);
    assert!(!first.system().contains("RULE_A_NEW"));
    assert!(refreshed.system().contains("RULE_A_NEW"));
    assert_eq!(refreshed.system().matches("RULE_A_NEW").count(), 1);
    assert_eq!(refreshed, host.prompt_assembly("a").await.unwrap());
    std::fs::remove_file(root.0.join("AGENTS.md")).unwrap();
    let removed = host.prompt_assembly("a").await.unwrap();
    assert!(!removed.system().contains("RULE_A"));
    assert!(host
        .state
        .read()
        .await
        .sessions
        .values()
        .all(|s| s.messages.is_empty()));
}

#[tokio::test]
async fn browser_routing_is_a_single_stable_audited_policy_not_a_capability_claim() {
    let root = Root::new();
    let host = crate::BasicHost::without_provider(crate::HostConfig::new(&root.0));
    create(&host, "browser-policy", &root).await;
    let first = host.prompt_assembly("browser-policy").await.unwrap();
    assert_eq!(first, host.prompt_assembly("browser-policy").await.unwrap());
    let audit = first
        .audit()
        .sections
        .iter()
        .filter(|s| s.id == "tool/browser")
        .collect::<Vec<_>>();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].version, "2");
    let sections = host
        .state
        .read()
        .await
        .prompt_sections("browser-policy")
        .unwrap();
    let policy = &sections
        .iter()
        .find(|s| s.id == "tool/browser")
        .unwrap()
        .content;
    assert_eq!(first.system().matches(policy).count(), 1);
    assert_eq!(policy, "For website browsing and interaction, prefer the embedded browser through plugin_mcp when available; respect explicit browser choices.");
    for detail in [
        "zero open tabs",
        "web_fetch",
        "computer",
        "successful result",
    ] {
        assert!(
            !policy.contains(detail),
            "detailed guidance belongs to plugin_mcp: {detail}"
        );
    }
    assert!(!policy.contains("@xharness/native-browser"));
    assert!(!policy.contains("Tauri"));
    assert!(host.state.read().await.sessions["browser-policy"]
        .messages
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waiting_for_instruction_io_never_pins_the_global_state_lock() {
    let root = Root::new();
    let host = crate::BasicHost::without_provider(crate::HostConfig::new(&root.0));
    create(&host, "a", &root).await;
    let held = host
        .instructions
        .slots
        .clone()
        .acquire_many_owned(4)
        .await
        .unwrap();
    let waiting_host = host.clone();
    let waiting = tokio::spawn(async move { waiting_host.capture_turn_permission("a").await });
    // Wait until capture has entered its separate permission lane.
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if host
                .admission_gates
                .lock()
                .await
                .values()
                .any(|gate| gate.strong_count() > 0)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!waiting.is_finished());
    tokio::time::timeout(Duration::from_secs(1), host.snapshot())
        .await
        .unwrap();
    let write = tokio::time::timeout(Duration::from_secs(1), host.state.write())
        .await
        .unwrap();
    drop(write);
    drop(held);
    waiting.await.unwrap().unwrap();
}

#[tokio::test]
async fn stalled_loading_has_a_deadline_and_does_not_publish_active_permissions() {
    let root = Root::new();
    root.write("RULE_AFTER_RETRY");
    let host = crate::BasicHost::without_provider(crate::HostConfig::new(&root.0));
    create(&host, "a", &root).await;
    let held = host
        .instructions
        .slots
        .clone()
        .acquire_many_owned(4)
        .await
        .unwrap();
    let error = tokio::time::timeout(
        LOAD_TIMEOUT + Duration::from_secs(1),
        host.capture_turn_permission("a"),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.message.contains("timed out"));
    assert!(host.state.read().await.sessions["a"]
        .active_permission
        .is_none());
    drop(held);
    let (_, prompt) = host.capture_turn_permission("a").await.unwrap();
    assert!(prompt.system().contains("RULE_AFTER_RETRY"));
}

#[tokio::test]
async fn readonly_project_rules_are_loaded_without_mutation() {
    let root = Root::new();
    root.write("READONLY_RULE");
    let path = root.0.join("AGENTS.md");
    let original = std::fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&path, readonly).unwrap();
    let section = root.load().await.unwrap().unwrap();
    assert!(section.content.contains("READONLY_RULE"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "READONLY_RULE");
    assert!(std::fs::metadata(&path).unwrap().permissions().readonly());
    std::fs::set_permissions(path, original).unwrap();
}
