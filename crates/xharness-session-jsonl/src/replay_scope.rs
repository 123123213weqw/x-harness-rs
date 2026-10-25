//! Bounded, operation-lifetime reuse for validated snapshots during active work.
#![forbid(unsafe_code)]

use super::*;

const MAX_SCOPES: usize = 4;
pub(super) const MAX_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Default)]
pub(super) struct Entry {
    leases: usize,
    snapshot: Option<CachedFile>,
}

#[derive(Debug)]
pub(super) struct Cache {
    pub(super) entries: HashMap<PathBuf, Entry>,
    pub(super) max_bytes: usize,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            max_bytes: MAX_BYTES,
        }
    }
}
impl Cache {
    pub(super) fn has_snapshot(&self, path: &Path, fingerprint: FileFingerprint) -> bool {
        self.entries
            .get(path)
            .and_then(|entry| entry.snapshot.as_ref())
            .is_some_and(|snapshot| snapshot.fingerprint == fingerprint)
    }

    pub(super) fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self
                .entries
                .values()
                .filter(|e| e.snapshot.is_some())
                .count(),
            accounted_bytes: self
                .entries
                .values()
                .filter_map(|e| e.snapshot.as_ref())
                .map(|s| s.loaded.estimated_bytes)
                .sum(),
            max_bytes: self.max_bytes,
        }
    }
    pub(super) fn clear_snapshots(&mut self) {
        for entry in self.entries.values_mut() {
            entry.snapshot = None;
        }
    }
    pub(super) fn remove_snapshot(&mut self, path: &Path) {
        if let Some(entry) = self.entries.get_mut(path) {
            entry.snapshot = None;
        }
    }
    pub(super) fn load(&mut self, path: &Path, fingerprint: FileFingerprint) -> Option<LoadedFile> {
        let entry = self.entries.get_mut(path)?;
        if entry.snapshot.as_ref()?.fingerprint != fingerprint {
            entry.snapshot = None;
            return None;
        }
        entry.snapshot.as_ref().map(|s| s.loaded.clone())
    }
    pub(super) fn take(&mut self, path: &Path, fingerprint: FileFingerprint) -> Option<LoadedFile> {
        self.entries
            .get_mut(path)?
            .snapshot
            .take()
            .filter(|s| s.fingerprint == fingerprint)
            .map(|s| s.loaded)
    }
    pub(super) fn store(
        &mut self,
        path: &Path,
        fingerprint: FileFingerprint,
        loaded: &LoadedFile,
    ) -> bool {
        if !self.entries.contains_key(path)
            || self
                .stats()
                .accounted_bytes
                .saturating_add(loaded.estimated_bytes)
                > self.max_bytes
        {
            return false;
        }
        if let Some(entry) = self.entries.get_mut(path) {
            entry.snapshot = Some(CachedFile {
                fingerprint,
                loaded: loaded.clone(),
                touched: 0,
            });
        }
        true
    }
}

struct Guard {
    path: PathBuf,
    cache: Arc<StdMutex<SnapshotCache>>,
}
impl xharness_session::SessionReadScope for Guard {}
impl Drop for Guard {
    fn drop(&mut self) {
        // Release a potentially large allocation outside the shared cache lock.
        let removed = if let Ok(mut cache) = self.cache.lock() {
            if let Some(entry) = cache.scopes.entries.get_mut(&self.path) {
                entry.leases -= 1;
                if entry.leases == 0 {
                    cache.scopes.entries.remove(&self.path)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        drop(removed);
    }
}

pub(super) fn begin(
    path: PathBuf,
    cache: Arc<StdMutex<SnapshotCache>>,
) -> Result<Box<dyn xharness_session::SessionReadScope>, StoreError> {
    {
        let mut shared = cache
            .lock()
            .map_err(|_| backend_message("session snapshot cache is poisoned"))?;
        if shared.scopes.max_bytes == 0
            || (!shared.scopes.entries.contains_key(&path)
                && shared.scopes.entries.len() >= MAX_SCOPES)
        {
            return Ok(Box::new(()));
        }
        shared
            .scopes
            .entries
            .entry(path.clone())
            .or_default()
            .leases += 1;
    }
    Ok(Box::new(Guard { path, cache }))
}
