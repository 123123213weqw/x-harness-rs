//! One-time migration of editable output overrides. Deployment files remain
//! authoritative, and conversations/credentials are not part of this operation.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};
use xharness_control::{
    ControlError, ControlEvent, ControlStore, MutationReceipt, SettingsSnapshot,
};
use xharness_host::{inherit_model_capabilities, merge_model_layers, MODEL_SETTINGS_NAMESPACE};

const MARKER: &str = "migration.output-budget-auto.v1";

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    AlreadyApplied,
    Applied {
        cleared_fields: usize,
        backup: Option<PathBuf>,
    },
}

fn receipt() -> ControlEvent {
    ControlEvent::MutationCommitted {
        receipt: MutationReceipt {
            rpc_id: MARKER.to_owned(),
            method: "settings.outputBudgetMigration".to_owned(),
            fingerprint: format!("{:x}", Sha256::digest(MARKER.as_bytes())),
            response: json!({"version":1}),
        },
    }
}

/// Only these legacy editable fields are reset; retain unknown metadata, model
/// order, routes, context capacities, safety margins and key references verbatim.
fn clear_overrides(user: &mut Value) -> usize {
    let mut count = 0;
    if let Some(providers) = user.get_mut("providers").and_then(Value::as_object_mut) {
        for provider in providers.values_mut().filter_map(Value::as_object_mut) {
            count += usize::from(provider.remove("maxTokens").is_some());
            if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
                for model in models.iter_mut().filter_map(Value::as_object_mut) {
                    for key in ["maxTokens", "minimumOutputTokens"] {
                        count += usize::from(model.remove(key).is_some());
                    }
                }
            }
        }
    }
    count
}

fn backup(root: &Path, revision: u64, snapshot: &SettingsSnapshot) -> std::io::Result<PathBuf> {
    // A unique file per attempt means a crash during backup creation cannot
    // make the next launch reuse an incomplete backup. No existing file is
    // ever overwritten; create_new also rejects final-component symlinks.
    let directory = root.join("settings-backups");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::other(
            "settings backup directory must be a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    let path = directory.join(format!("output-budget-v1-r{revision}-{nonce}.json"));
    let bytes = serde_json::to_vec(snapshot)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    std::fs::File::open(&directory)?.sync_all()?;
    Ok(path)
}

/// Called before settings restoration and accepting RPCs. Backup must succeed
/// before an atomic settings+marker CAS append. A fresh install is marked too,
/// so future manual edits are never reset on subsequent launches.
pub async fn migrate_output_budgets(
    store: &dyn ControlStore,
    state_root: &Path,
    base: &Value,
) -> Result<MigrationOutcome, Box<dyn std::error::Error + Send + Sync>> {
    for _ in 0..4 {
        let log = store.load().await?;
        let projection = log.projection()?;
        if projection.receipts.contains_key(MARKER) {
            return Ok(MigrationOutcome::AlreadyApplied);
        }
        let mut events = Vec::new();
        let mut cleared_fields = 0;
        let mut backup_path = None;
        if let Some(snapshot) = projection.settings.get(MODEL_SETTINGS_NAMESPACE) {
            let mut next = snapshot.clone();
            cleared_fields = clear_overrides(&mut next.user);
            if cleared_fields > 0 {
                let root = state_root.to_owned();
                let previous = snapshot.clone();
                let revision = log.revision().get();
                backup_path = Some(
                    tokio::task::spawn_blocking(move || backup(&root, revision, &previous))
                        .await??,
                );
                next.value = merge_model_layers(base, &next.user);
                inherit_model_capabilities(&mut next.value, &snapshot.value);
                inherit_model_capabilities(&mut next.value, base);
                next.revision = next
                    .revision
                    .checked_add(1)
                    .ok_or("model settings revision overflow")?;
                events.push(ControlEvent::SettingsSet { settings: next });
            }
        }
        events.push(receipt());
        match store.append(log.revision(), events).await {
            Ok(_) => {
                return Ok(MigrationOutcome::Applied {
                    cleared_fields,
                    backup: backup_path,
                })
            }
            Err(ControlError::RevisionConflict { .. }) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err("output budget migration conflicted repeatedly; no uncommitted reset applied".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use xharness_control::{ControlRevision, JsonlControlStore, MemoryControlStore};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xharness-output-migration-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn old() -> SettingsSnapshot {
        SettingsSnapshot {
            namespace: MODEL_SETTINGS_NAMESPACE.to_owned(),
            revision: 1,
            user: json!({"providers":{"p":{"baseURL":"https://example.com/v1","api":"openai-completions","apiKeyEnv":"KEY_REF","maxTokens":2048,"models":[{"id":"m","maxTokens":4096,"minimumOutputTokens":8192,"contextWindow":131072,"tokenSafetyMargin":1024,"future":{"keep":true}}]}}}),
            value: json!({"providers":{"p":{"baseURL":"https://example.com/v1","api":"openai-completions","models":[{"id":"m","reasoning":{"efforts":[{"id":"high"}]},"imageInput":true}]}}}),
        }
    }
    fn base() -> Value {
        json!({"providers":{"p":{"baseURL":"https://example.com/v1","api":"openai-completions","models":[{"id":"m","maxTokens":65536,"contextWindow":131072}]}}})
    }
    async fn seed(store: &dyn ControlStore, snapshot: SettingsSnapshot, id: &str) {
        let mut marker = receipt();
        if let ControlEvent::MutationCommitted { receipt } = &mut marker {
            receipt.rpc_id = id.to_owned();
        }
        store
            .append(
                store.load().await.unwrap().revision(),
                vec![ControlEvent::SettingsSet { settings: snapshot }, marker],
            )
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn migration_preserves_metadata_backs_up_and_rebases_once() {
        let root = Temp::new();
        let store = MemoryControlStore::default();
        seed(&store, old(), "seed").await;
        let outcome = migrate_output_budgets(&store, &root.0, &base())
            .await
            .unwrap();
        let MigrationOutcome::Applied {
            cleared_fields,
            backup: Some(path),
        } = outcome
        else {
            panic!("not migrated")
        };
        assert_eq!(cleared_fields, 3);
        assert_eq!(
            serde_json::from_slice::<SettingsSnapshot>(&std::fs::read(&path).unwrap()).unwrap(),
            old()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let snapshot = store
            .load()
            .await
            .unwrap()
            .projection()
            .unwrap()
            .settings
            .remove(MODEL_SETTINGS_NAMESPACE)
            .unwrap();
        let mut expected = old();
        clear_overrides(&mut expected.user);
        assert_eq!(snapshot.user, expected.user);
        assert_eq!(
            snapshot.value["providers"]["p"]["models"][0]["reasoning"],
            old().value["providers"]["p"]["models"][0]["reasoning"]
        );
        assert_eq!(
            snapshot.value["providers"]["p"]["models"][0]["imageInput"],
            true
        );
        assert_eq!(snapshot.revision, 2);
        assert_eq!(
            snapshot.value["providers"]["p"]["models"][0]["maxTokens"],
            65536
        );
        assert!(snapshot.value["providers"]["p"]["models"][0]
            .get("minimumOutputTokens")
            .is_none());
        assert_eq!(
            migrate_output_budgets(&store, &root.0, &base())
                .await
                .unwrap(),
            MigrationOutcome::AlreadyApplied
        );
        assert_eq!(store.load().await.unwrap().revision(), ControlRevision(2));
    }
    #[tokio::test]
    async fn disk_restart_and_later_manual_edits_are_not_reset() {
        let root = Temp::new();
        let store = JsonlControlStore::new(root.0.join("control")).unwrap();
        seed(&store, old(), "seed").await;
        migrate_output_budgets(&store, &root.0, &base())
            .await
            .unwrap();
        let mut manual = old();
        manual.revision = 3;
        seed(&store, manual.clone(), "manual-edit").await;
        drop(store);
        let store = JsonlControlStore::new(root.0.join("control")).unwrap();
        assert_eq!(
            migrate_output_budgets(&store, &root.0, &base())
                .await
                .unwrap(),
            MigrationOutcome::AlreadyApplied
        );
        assert_eq!(
            store.load().await.unwrap().projection().unwrap().settings[MODEL_SETTINGS_NAMESPACE],
            manual
        );
    }
    #[tokio::test]
    async fn new_install_is_marked_without_backup_or_future_reset() {
        let root = Temp::new();
        let store = MemoryControlStore::default();
        assert_eq!(
            migrate_output_budgets(&store, &root.0, &base())
                .await
                .unwrap(),
            MigrationOutcome::Applied {
                cleared_fields: 0,
                backup: None
            }
        );
        assert!(!root.0.join("settings-backups").exists());
        seed(&store, old(), "manual").await;
        assert_eq!(
            migrate_output_budgets(&store, &root.0, &base())
                .await
                .unwrap(),
            MigrationOutcome::AlreadyApplied
        );
    }
    #[tokio::test]
    async fn backup_failure_does_not_append_settings_or_marker() {
        let root = Temp::new();
        std::fs::write(root.0.join("settings-backups"), b"not a directory").unwrap();
        let store = MemoryControlStore::default();
        seed(&store, old(), "seed").await;
        let before = store.load().await.unwrap();
        assert!(migrate_output_budgets(&store, &root.0, &base())
            .await
            .is_err());
        assert_eq!(store.load().await.unwrap(), before);
    }
    #[tokio::test]
    async fn interrupted_backup_does_not_block_next_attempt() {
        let root = Temp::new();
        std::fs::create_dir(root.0.join("settings-backups")).unwrap();
        std::fs::write(
            root.0.join("settings-backups/output-budget-v1-r1.json"),
            b"partial",
        )
        .unwrap();
        let store = MemoryControlStore::default();
        seed(&store, old(), "seed").await;
        assert!(migrate_output_budgets(&store, &root.0, &base())
            .await
            .is_ok());
        assert_eq!(
            std::fs::read(root.0.join("settings-backups/output-budget-v1-r1.json")).unwrap(),
            b"partial"
        );
        assert_eq!(store.load().await.unwrap().revision(), ControlRevision(2));
    }
    struct InterceptStore {
        inner: MemoryControlStore,
        once: std::sync::atomic::AtomicBool,
        conflict: bool,
    }
    #[async_trait::async_trait]
    impl ControlStore for InterceptStore {
        async fn load(&self) -> Result<xharness_control::ControlLog, ControlError> {
            self.inner.load().await
        }
        async fn flush(&self) -> Result<ControlRevision, ControlError> {
            self.inner.flush().await
        }
        async fn append(
            &self,
            expected: ControlRevision,
            events: Vec<ControlEvent>,
        ) -> Result<xharness_control::ControlAppendReceipt, ControlError> {
            let migration = matches!(events.last(),Some(ControlEvent::MutationCommitted{receipt}) if receipt.rpc_id == MARKER);
            if migration && self.once.swap(false, Ordering::SeqCst) {
                if self.conflict {
                    // Simulate a concurrent manual settings change between load
                    // and CAS. The retry must back up and migrate the new state.
                    let mut current = old();
                    current.revision = 2;
                    current.user["providers"]["p"]["models"][0]["name"] = json!("concurrent edit");
                    let mut committed = receipt();
                    if let ControlEvent::MutationCommitted { receipt } = &mut committed {
                        receipt.rpc_id = "concurrent".to_owned();
                    }
                    self.inner
                        .append(
                            expected,
                            vec![ControlEvent::SettingsSet { settings: current }, committed],
                        )
                        .await?;
                    return Err(ControlError::RevisionConflict {
                        expected,
                        actual: self.inner.load().await?.revision(),
                    });
                }
                return Err(ControlError::Backend {
                    message: "simulated append failure".to_owned(),
                });
            }
            self.inner.append(expected, events).await
        }
    }
    #[tokio::test]
    async fn failed_append_is_retryable_without_a_false_marker() {
        let root = Temp::new();
        let store = InterceptStore {
            inner: MemoryControlStore::default(),
            once: true.into(),
            conflict: false,
        };
        seed(&store, old(), "seed").await;
        assert!(migrate_output_budgets(&store, &root.0, &base())
            .await
            .is_err());
        let projection = store.load().await.unwrap().projection().unwrap();
        assert_eq!(projection.settings[MODEL_SETTINGS_NAMESPACE], old());
        assert!(!projection.receipts.contains_key(MARKER));
        assert!(migrate_output_budgets(&store, &root.0, &base())
            .await
            .is_ok());
        assert_eq!(
            std::fs::read_dir(root.0.join("settings-backups"))
                .unwrap()
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn cas_conflict_retries_against_current_snapshot() {
        let root = Temp::new();
        let store = InterceptStore {
            inner: MemoryControlStore::default(),
            once: true.into(),
            conflict: true,
        };
        seed(&store, old(), "seed").await;
        let MigrationOutcome::Applied {
            backup: Some(path), ..
        } = migrate_output_budgets(&store, &root.0, &base())
            .await
            .unwrap()
        else {
            panic!("not applied")
        };
        let saved: SettingsSnapshot =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(
            saved.user["providers"]["p"]["models"][0]["name"],
            "concurrent edit"
        );
        let projection = store.load().await.unwrap().projection().unwrap();
        assert_eq!(projection.settings[MODEL_SETTINGS_NAMESPACE].revision, 3);
        assert_eq!(
            projection.settings[MODEL_SETTINGS_NAMESPACE].user["providers"]["p"]["models"][0]
                ["name"],
            "concurrent edit"
        );
    }
}
