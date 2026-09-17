//! Host-owned cache shared by all provider instances in one state directory.
//! The Host's state-directory ownership lock excludes other writers. No prompt,
//! endpoint, model name, credential or tool schema is stored in this file.
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use xharness_token::{Calibration, ProviderInputTokenCount, WireFeatures, MAX_CALIBRATION_BYTES};

#[derive(Default)]
pub struct CalibrationStore {
    inner: Mutex<Calibration>,
    path: Option<PathBuf>,
}
impl CalibrationStore {
    /// Cache corruption is non-fatal and never changes the configured hard budget.
    /// Call only inside an exclusively owned Host state directory.
    pub fn open(path: PathBuf) -> Self {
        let restored = load(&path);
        if let Err(ref e) = restored {
            if e.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "token calibration cache unavailable; using conservative estimates ({:?})",
                    e.kind()
                );
            }
        }
        Self {
            inner: Mutex::new(restored.unwrap_or_default()),
            path: Some(path),
        }
    }
    pub fn estimate(
        &self,
        scope: &str,
        features: &WireFeatures,
    ) -> Option<ProviderInputTokenCount> {
        Some(self.inner.lock().ok()?.estimate(scope, features))
    }
    pub async fn observe(
        self: &Arc<Self>,
        scope: String,
        id: String,
        features: WireFeatures,
        actual: u64,
    ) {
        self.update(move |c| c.observe(&scope, &id, features, actual))
            .await;
    }
    pub async fn invalidate(self: &Arc<Self>, scope: String) {
        self.update(move |c| c.invalidate(&scope)).await;
    }
    async fn update(self: &Arc<Self>, f: impl FnOnce(&mut Calibration) + Send + 'static) {
        let this = self.clone();
        // Once per complete response, never per delta. Await persistence before
        // handing completion to the loop; blocking IO stays off the async runtime.
        let result = tokio::task::spawn_blocking(move || -> io::Result<()> {
            let mut c = this
                .inner
                .lock()
                .map_err(|_| io::Error::other("cache lock poisoned"))?;
            f(&mut c);
            if let Some(path) = &this.path {
                let bytes = c.snapshot().map_err(io::Error::other)?;
                save(path, &bytes)?;
            }
            Ok(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            eprintln!("token calibration cache write failed; continuing with in-memory estimates");
        }
    }
}
fn regular(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::other("cache is not a regular file"));
    }
    Ok(())
}
fn load(path: &Path) -> io::Result<Calibration> {
    regular(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_CALIBRATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Calibration::restore(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid calibration cache"))
}
fn save(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_CALIBRATION_BYTES {
        return Err(io::Error::other("cache too large"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing cache parent"))?;
    // Do not create arbitrary parent directories or follow a symlinked cache root.
    if !fs::symlink_metadata(parent)?.file_type().is_dir() {
        return Err(io::Error::other("invalid cache directory"));
    }
    match fs::symlink_metadata(path) {
        Ok(_) => regular(path)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = parent.join(format!(
        ".token-calibration-{}-{serial}.tmp",
        std::process::id()
    ));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_token::TokenCountAccuracy;
    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            static ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let id = ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("xh-calibration-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn cache(&self) -> PathBuf {
            self.0.join("cache.json")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn features() -> WireFeatures {
        WireFeatures {
            buckets: [400_000, 0, 0],
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn concurrent_completion_restart_and_scope_invalidation() {
        let dir = Dir::new();
        let store = Arc::new(CalibrationStore::open(dir.cache()));
        let mut tasks = Vec::new();
        for i in 0..24 {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .observe(
                        format!("{:064x}", i % 2),
                        format!("{i:064x}"),
                        features(),
                        100_000,
                    )
                    .await;
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let restored = Arc::new(CalibrationStore::open(dir.cache()));
        for i in 0..2 {
            assert_eq!(
                restored
                    .estimate(&format!("{i:064x}"), &features())
                    .unwrap()
                    .accuracy,
                TokenCountAccuracy::Calibrated
            );
        }
        restored.invalidate(format!("{:064x}", 0)).await;
        let restarted = CalibrationStore::open(dir.cache());
        assert_eq!(
            restarted
                .estimate(&format!("{:064x}", 0), &features())
                .unwrap()
                .accuracy,
            TokenCountAccuracy::Estimated
        );
        assert_eq!(
            restarted
                .estimate(&format!("{:064x}", 1), &features())
                .unwrap()
                .accuracy,
            TokenCountAccuracy::Calibrated
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.cache()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn bad_cache_and_write_failure_do_not_fail_model_completion() {
        let dir = Dir::new();
        fs::write(dir.cache(), b"broken").unwrap();
        let store = Arc::new(CalibrationStore::open(dir.cache()));
        assert_eq!(
            store
                .estimate(&"a".repeat(64), &features())
                .unwrap()
                .accuracy,
            TokenCountAccuracy::Estimated
        );
        fs::remove_file(dir.cache()).unwrap();
        fs::create_dir(dir.cache()).unwrap();
        for i in 0..8 {
            store
                .observe("a".repeat(64), format!("{i:064x}"), features(), 100_000)
                .await;
        }
        assert_eq!(
            store
                .estimate(&"a".repeat(64), &features())
                .unwrap()
                .accuracy,
            TokenCountAccuracy::Calibrated
        );
        assert!(dir.cache().is_dir());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_cache_is_not_read_or_overwritten() {
        let dir = Dir::new();
        let target = dir.0.join("outside");
        fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, dir.cache()).unwrap();
        let store = Arc::new(CalibrationStore::open(dir.cache()));
        store
            .observe("a".repeat(64), "b".repeat(64), features(), 100_000)
            .await;
        assert_eq!(fs::read(target).unwrap(), b"untouched");
    }
}
