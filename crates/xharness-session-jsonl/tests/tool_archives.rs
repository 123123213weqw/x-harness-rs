use xharness_session::{SessionHeader, Store};
use xharness_session_jsonl::JsonlSessionStore;

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "xharness-archives-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn archives_survive_restart_and_are_session_scoped() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(SessionHeader::new("one")).await.unwrap();
    store.create(SessionHeader::new("two")).await.unwrap();
    let text = format!(
        "{}middle evidence{}",
        "汉字\n".repeat(5000),
        "z".repeat(5000)
    );
    let reference = store.archive_tool_result("one", &text).await.unwrap();
    assert_eq!(reference.bytes, text.len());
    assert_eq!(
        store.archive_tool_result("one", &text).await.unwrap(),
        reference
    );
    drop(store);
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    assert_eq!(
        store
            .tool_result_archive("one", &reference.sha256)
            .await
            .unwrap(),
        Some(text)
    );
    assert_eq!(
        store
            .tool_result_archive("two", &reference.sha256)
            .await
            .unwrap(),
        None
    );
    assert!(store
        .tool_result_archive("one", "../../secret")
        .await
        .is_err());
    assert!(store.archive_tool_result("missing", "text").await.is_err());
}

#[tokio::test]
async fn archive_failure_never_returns_a_reference() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(SessionHeader::new("one")).await.unwrap();
    std::fs::write(dir.path().join("tool-results"), b"not a directory").unwrap();
    assert!(store.archive_tool_result("one", "original").await.is_err());
}

#[tokio::test]
async fn corrupt_archive_is_rejected_not_overwritten() {
    use sha2::{Digest, Sha256};
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(SessionHeader::new("one")).await.unwrap();
    let reference = store.archive_tool_result("one", "original").await.unwrap();
    let path = dir.path().join("tool-results").join(format!("{:x}", Sha256::digest(b"one"))).join(format!("{}.json", reference.sha256));
    std::fs::write(&path, "corrupt").unwrap();
    assert!(store.tool_result_archive("one", &reference.sha256).await.is_err());
    assert!(store.archive_tool_result("one", "original").await.is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "corrupt");
}

#[tokio::test]
async fn concurrent_publication_is_complete_and_bounded() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(SessionHeader::new("one")).await.unwrap();
    let (a, b) = tokio::join!(store.archive_tool_result("one", "same"), store.archive_tool_result("one", "same"));
    assert_eq!(a.unwrap(), b.unwrap());
    assert!(store.archive_tool_result("one", &"x".repeat(xharness_session::MAX_TOOL_ARCHIVE_BYTES + 1)).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_archive_directory_cannot_escape_store() {
    let dir = TestDir::new();
    let outside = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(SessionHeader::new("one")).await.unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("tool-results")).unwrap();
    assert!(store.archive_tool_result("one", "secret").await.is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}
