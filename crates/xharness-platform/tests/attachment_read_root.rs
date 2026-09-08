use std::sync::atomic::{AtomicU64, Ordering};
use xharness_fs::{ReadLimits, ReadOutcome};
use xharness_platform::{NativePlatform, PlatformConfig};
static NEXT: AtomicU64 = AtomicU64::new(0);

#[tokio::test]
async fn attachment_root_is_readable_without_workspace_write_authority() {
    let base = std::env::temp_dir().join(format!(
        "xh-attachment-read-root-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let workspace = base.join("workspace");
    let store = base.join("store");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("note.txt"), b"attachment contents").unwrap();
    let store = std::fs::canonicalize(store).unwrap();
    let path = store.join("note.txt");
    let platform =
        NativePlatform::new(PlatformConfig::new(&workspace).read_only_root(&store)).unwrap();
    assert!(
        platform.resolve_file(&path).is_err(),
        "normal mutation path must not gain the attachment read capability"
    );
    let (filesystem, target) = platform.resolve_read_file(&path).unwrap();
    let ReadOutcome::File(read) = filesystem
        .read("session", &target, ReadLimits::default())
        .await
        .unwrap()
    else {
        panic!("missing attachment")
    };
    assert_eq!(read.text, "attachment contents");
    assert!(filesystem.read_bytes("session", &target, 2).await.is_err());
    assert_eq!(
        filesystem
            .read_bytes("session", &target, 100)
            .await
            .unwrap(),
        b"attachment contents"
    );
}
