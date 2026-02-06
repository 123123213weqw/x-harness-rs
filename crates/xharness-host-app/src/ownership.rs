//! Process-lifetime ownership of a state directory, independent of install path.
use std::{io, path::Path};
use xharness_agent::{AgentLease, FileLeaseManager, LeaseManager};

/// Acquire before loading configuration or restoring journals. The caller must
/// keep this guard until all Host work has stopped. Kernel locks survive neither
/// process exit nor crashes; persistent lock files are intentionally not removed.
pub async fn acquire(state_dir: &Path) -> Result<Box<dyn AgentLease>, io::Error> {
    let owners = FileLeaseManager::new(state_dir.join("ownership")).map_err(io::Error::other)?;
    let guard = owners.acquire("host").await.map_err(|error| {
        io::Error::other(format!(
            "XHarness 数据目录已被占用或无法锁定，请先退出使用此目录的其他窗口/Host，再重试（不要删除锁文件）：{}: {error}",
            state_dir.display()
        ))
    })?;
    // Releases before the directory-level protocol only hold agent locks. Fail
    // closed if one is already live. They cannot honor our new directory lock,
    // so per-agent leases remain required to protect against later legacy starts.
    let leases_dir = state_dir.join("leases");
    match std::fs::read_dir(&leases_dir) {
        Ok(entries) => {
            let leases = FileLeaseManager::new(&leases_dir).map_err(io::Error::other)?;
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name();
                let Some(agent_id) = name.to_str().and_then(|s| s.strip_suffix(".agent.lock"))
                else {
                    continue;
                };
                let lease = leases.acquire(agent_id).await.map_err(|error| {
                    io::Error::other(format!(
                        "检测到旧版会话占用或不可用的会话锁，请先退出旧版 XHarness/Host：{agent_id}: {error}"
                    ))
                })?;
                drop(lease);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "xharness-ownership-中文-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn aliases_conflict_independent_data_does_not_and_drop_releases() {
        let root = directory();
        let guard = acquire(&root).await.unwrap();
        assert!(acquire(&root.join(".")).await.is_err());
        let separate = acquire(&root.join("separate")).await.unwrap();
        drop(separate);
        drop(guard);
        assert!(root.join("ownership/host.agent.lock").exists());
        drop(acquire(&root).await.unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn live_legacy_agent_blocks_start_without_removing_its_lock() {
        let root = directory();
        let leases = FileLeaseManager::new(root.join("leases")).unwrap();
        let legacy = leases.acquire("session-old").await.unwrap();
        assert!(acquire(&root).await.is_err());
        drop(legacy);
        drop(acquire(&root).await.unwrap());
        assert!(root.join("leases/session-old.agent.lock").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
