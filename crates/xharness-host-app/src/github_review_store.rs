//! Immutable initial/final receipts, two bounded files per run (linear storage).
//! State-directory ownership is provided by native composition; no credentials.
use super::*;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf};
fn directory(root: &std::path::Path, target: &Value) -> Result<PathBuf, RpcError> {
    let account = target["account"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(bad)?;
    let repo = repository(target["repository"].as_str())?.to_lowercase();
    let number = target["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(bad)?;
    let hash = Sha256::digest(serde_json::to_vec(&(account, repo, number)).map_err(|_| invalid())?);
    Ok(root.join(format!("{hash:x}")))
}
impl NativeGitHub {
    pub fn with_review_directory(mut self, path: PathBuf) -> Self {
        self.review_directory = Some(path);
        self
    }
    pub(super) async fn persist_review(&self, target: &Value, run: &Value) -> Result<(), RpcError> {
        let root = self
            .review_directory
            .clone()
            .ok_or_else(|| failure("storage", "Review persistence is not configured"))?;
        let path = directory(&root, target)?;
        let id = run["id"]
            .as_str()
            .filter(|v| v.len() <= 120 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .ok_or_else(bad)?;
        if run["target"] != *target {
            return Err(bad());
        }
        let status = run["status"].as_str().ok_or_else(bad)?;
        if !matches!(status, "running" | "completed" | "failed" | "cancelled") {
            return Err(bad());
        }
        let suffix = if status == "running" {
            "initial"
        } else {
            "final"
        };
        let file = path.join(format!("{id}-{suffix}.json"));
        let bytes = serde_json::to_vec(run).map_err(|_| invalid())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(failure("storage", "Review record exceeds storage bound"));
        }
        tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
            use std::io::Write;
            std::fs::create_dir_all(&path)?;
            let temp = path.join(format!(
                ".{}-{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let result = (|| {
                let mut f = options.open(&temp)?;
                f.write_all(&bytes)?;
                f.sync_all()?;
                drop(f);
                std::fs::rename(&temp, &file)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result
        })
        .await
        .map_err(|_| failure("storage", "Review storage worker failed"))?
        .map_err(|_| failure("storage", "Could not persist review record"))
    }
    pub(super) async fn load_reviews(&self, target: &Value) -> Result<Vec<Value>, RpcError> {
        let Some(root) = self.review_directory.clone() else {
            return Ok(Vec::new());
        };
        let path = directory(&root, target)?;
        let target = target.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<Value>, RpcError> {
            let entries = match std::fs::read_dir(path) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(_) => return Err(failure("storage", "Could not read review history")),
            };
            // Bound response and loaded records; older receipts remain on disk.
            let mut paths = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|_| invalid())?;
                if entry.file_type().map_err(|_| invalid())?.is_file()
                    && entry.path().extension().is_some_and(|v| v == "json")
                    && entry
                        .file_name()
                        .to_str()
                        .is_some_and(|v| v.ends_with("-initial.json") || v.ends_with("-final.json"))
                {
                    paths.push(entry.path());
                }
            }
            paths.sort();
            paths.reverse();
            paths.truncate(60);
            let mut runs = BTreeMap::<String, Value>::new();
            let mut total_bytes = 0u64;
            for path in paths {
                let meta = std::fs::symlink_metadata(&path).map_err(|_| invalid())?;
                if meta.len() > 8 * 1024 * 1024 || meta.file_type().is_symlink() {
                    return Err(invalid());
                }
                if total_bytes.saturating_add(meta.len()) > 16 * 1024 * 1024 {
                    break;
                }
                total_bytes += meta.len();
                let v: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| invalid())?)
                    .map_err(|_| failure("storage", "Review history record is damaged"))?;
                if v["target"]["account"] != target["account"]
                    || v["target"]["repository"].as_str().map(str::to_lowercase)
                        != target["repository"].as_str().map(str::to_lowercase)
                    || v["target"]["number"] != target["number"]
                {
                    return Err(invalid());
                }
                let id = v["id"].as_str().ok_or_else(invalid)?.to_owned();
                if runs.get(&id).is_none_or(|old| old["status"] == "running") {
                    runs.insert(id, v);
                }
            }
            Ok(runs.into_iter().rev().take(30).map(|(_, v)| v).collect())
        })
        .await
        .map_err(|_| failure("storage", "Review history worker failed"))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn review_receipts_restore_final_and_fence_scope() {
        let path = std::env::temp_dir().join(format!(
            "xharness-review-store-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let backend = NativeGitHub::default().with_review_directory(path.clone());
        let target =
            json!({"account":"alice","repository":"alice/project","number":7,"sha":"a".repeat(40)});
        let run = json!({"id":"review-1","target":target,"status":"running","text":""});
        backend.save_review(&target, &run).await.unwrap();
        let mut final_run = run.clone();
        final_run["status"] = json!("completed");
        final_run["text"] = json!("complete");
        backend.save_review(&target, &final_run).await.unwrap();
        assert_eq!(
            backend.review_history(&target).await.unwrap(),
            vec![final_run]
        );
        let mut other = target.clone();
        other["account"] = json!("bob");
        assert!(backend.review_history(&other).await.unwrap().is_empty());
        let mut invalid_run = run;
        invalid_run["id"] = json!("../escape");
        assert!(backend.save_review(&target, &invalid_run).await.is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
}
