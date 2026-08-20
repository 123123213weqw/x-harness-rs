#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use xharness_fs::{FsError, FsService, Observation, ReadDiagnostic, ReadLimits, ReadOutcome};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xharness-fs-{label}-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn resolve_rejects_parent_traversal_and_symlink_escape() {
    let workspace = TestDir::new("workspace");
    let outside = TestDir::new("outside");
    fs::write(outside.path().join("secret.txt"), "outside").unwrap();
    symlink(outside.path(), workspace.path().join("escape")).unwrap();
    symlink(
        outside.path().join("secret.txt"),
        workspace.path().join("file-link"),
    )
    .unwrap();
    let service = FsService::new(workspace.path()).unwrap();

    assert!(matches!(
        service.resolve("../outside.txt"),
        Err(FsError::InvalidPath { .. })
    ));
    assert!(matches!(
        service.resolve("escape/secret.txt"),
        Err(FsError::WorkspaceEscape { .. })
    ));
    assert!(matches!(
        service.resolve("file-link"),
        Err(FsError::WorkspaceEscape { .. } | FsError::SymlinkTarget { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_parent_symlink_swaps_never_write_outside() {
    let workspace = TestDir::new("workspace-race");
    let outside = TestDir::new("outside-race");
    fs::create_dir(workspace.path().join("inside")).unwrap();
    fs::write(workspace.path().join("inside/file.txt"), "inside-v1").unwrap();
    fs::write(outside.path().join("file.txt"), "outside-sentinel").unwrap();
    symlink("inside", workspace.path().join("gate")).unwrap();
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("gate/file.txt").unwrap();
    service
        .read("race", &target, ReadLimits::default())
        .await
        .unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let toggler_stop = Arc::clone(&stop);
    let root = workspace.path().to_owned();
    let outside_path = outside.path().to_owned();
    let toggler = std::thread::spawn(move || {
        let mut outside_turn = true;
        while !toggler_stop.load(Ordering::Relaxed) {
            let temporary = root.join("gate.next");
            let _ = fs::remove_file(&temporary);
            let destination = if outside_turn {
                outside_path.as_path()
            } else {
                Path::new("inside")
            };
            symlink(destination, &temporary).unwrap();
            fs::rename(&temporary, root.join("gate")).unwrap();
            outside_turn = !outside_turn;
            std::thread::yield_now();
        }
    });

    for sequence in 0..100 {
        let _ = service
            .write(
                "race",
                &target,
                format!("inside-update-{sequence}").into_bytes(),
            )
            .await;
    }
    stop.store(true, Ordering::Relaxed);
    toggler.join().unwrap();
    assert_eq!(
        fs::read_to_string(outside.path().join("file.txt")).unwrap(),
        "outside-sentinel"
    );
}

#[tokio::test]
async fn write_rechecks_parent_after_symlink_swap() {
    let workspace = TestDir::new("workspace-swap");
    let outside = TestDir::new("outside-swap");
    fs::create_dir(workspace.path().join("inside")).unwrap();
    fs::write(workspace.path().join("inside/file.txt"), "inside-v1").unwrap();
    fs::write(outside.path().join("file.txt"), "outside-v1").unwrap();
    symlink("inside", workspace.path().join("current")).unwrap();
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("current/file.txt").unwrap();
    service
        .read("session", &target, ReadLimits::default())
        .await
        .unwrap();

    fs::remove_file(workspace.path().join("current")).unwrap();
    symlink(outside.path(), workspace.path().join("current")).unwrap();
    assert!(matches!(
        service
            .write("session", &target, b"attacker-wins".to_vec())
            .await,
        Err(FsError::WorkspaceEscape { .. })
    ));
    assert_eq!(
        fs::read_to_string(outside.path().join("file.txt")).unwrap(),
        "outside-v1"
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("inside/file.txt")).unwrap(),
        "inside-v1"
    );
}

#[tokio::test]
async fn blind_overwrite_and_stale_observation_fail_closed() {
    let workspace = TestDir::new("cas");
    fs::write(workspace.path().join("file.txt"), "v1").unwrap();
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("file.txt").unwrap();

    assert!(matches!(
        service.write("blind", &target, b"blind".to_vec()).await,
        Err(FsError::BlindOverwrite { .. })
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("file.txt")).unwrap(),
        "v1"
    );

    let read = service
        .read("stale", &target, ReadLimits::default())
        .await
        .unwrap();
    let version = match read {
        ReadOutcome::File(read) => read.version,
        ReadOutcome::Absent => panic!("file unexpectedly absent"),
    };
    assert_eq!(
        service.observations().get("stale", target.key()).unwrap(),
        Some(Observation::Version(version))
    );
    fs::write(workspace.path().join("file.txt"), "v2-external").unwrap();
    assert!(matches!(
        service.write("stale", &target, b"v3".to_vec()).await,
        Err(FsError::StaleObservation { .. })
    ));
    assert_eq!(
        fs::read_to_string(workspace.path().join("file.txt")).unwrap(),
        "v2-external"
    );
}

#[tokio::test]
async fn create_replace_and_literal_edit_publish_atomically() {
    let workspace = TestDir::new("atomic");
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("new.txt").unwrap();
    let created = service
        .write("session", &target, b"alpha beta\n".to_vec())
        .await
        .unwrap();
    assert!(created.created);
    assert_eq!(
        fs::read_to_string(workspace.path().join("new.txt")).unwrap(),
        "alpha beta\n"
    );

    let replaced = service
        .write("session", &target, b"alpha beta gamma\n".to_vec())
        .await
        .unwrap();
    assert!(!replaced.created);
    assert_ne!(created.version, replaced.version);
    let edited = service
        .edit_literal("session", &target, "beta", "BETA")
        .await
        .unwrap();
    assert!(!edited.created);
    assert_eq!(
        fs::read_to_string(workspace.path().join("new.txt")).unwrap(),
        "alpha BETA gamma\n"
    );
    assert!(fs::read_dir(workspace.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".xharness-tmp-")));

    assert!(matches!(
        service
            .edit_literal("session", &target, "missing", "replacement")
            .await,
        Err(FsError::LiteralMatchCount { count: 0, .. })
    ));
    fs::write(workspace.path().join("new.txt"), "same same").unwrap();
    service
        .read("duplicate", &target, ReadLimits::default())
        .await
        .unwrap();
    assert!(matches!(
        service
            .edit_literal("duplicate", &target, "same", "x")
            .await,
        Err(FsError::LiteralMatchCount { count: 2, .. })
    ));

    service
        .read("edit-stale", &target, ReadLimits::default())
        .await
        .unwrap();
    fs::write(workspace.path().join("new.txt"), "changed elsewhere").unwrap();
    assert!(matches!(
        service
            .edit_literal("edit-stale", &target, "same", "x")
            .await,
        Err(FsError::StaleObservation { .. })
    ));
}

#[tokio::test]
async fn absent_read_is_recorded_and_external_create_makes_it_stale() {
    let workspace = TestDir::new("absent");
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("future.txt").unwrap();
    assert_eq!(
        service
            .read("session", &target, ReadLimits::default())
            .await
            .unwrap(),
        ReadOutcome::Absent
    );
    assert_eq!(
        service.observations().get("session", target.key()).unwrap(),
        Some(Observation::Absent)
    );
    fs::write(workspace.path().join("future.txt"), "external").unwrap();
    assert!(matches!(
        service.write("session", &target, b"ours".to_vec()).await,
        Err(FsError::StaleObservation { .. })
    ));
}

#[tokio::test]
async fn read_limits_and_utf8_diagnostics_are_safe() {
    let workspace = TestDir::new("limits");
    let service = FsService::new(workspace.path()).unwrap();

    fs::write(workspace.path().join("unicode.txt"), "ééé").unwrap();
    let unicode = service.resolve("unicode.txt").unwrap();
    let read = service
        .read(
            "unicode",
            &unicode,
            ReadLimits {
                max_bytes: 5,
                max_lines: 10,
                max_line_bytes: 10,
            },
        )
        .await
        .unwrap();
    let ReadOutcome::File(read) = read else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(read.text, "éé");
    assert!(read.truncated);
    assert!(read
        .diagnostics
        .contains(&ReadDiagnostic::ByteLimit { limit: 5 }));
    assert!(read
        .diagnostics
        .contains(&ReadDiagnostic::Utf8BoundaryTrimmed { bytes: 1 }));

    fs::write(workspace.path().join("long.txt"), "abcdef\nsecond\n").unwrap();
    let long = service.resolve("long.txt").unwrap();
    let ReadOutcome::File(long_read) = service
        .read(
            "long",
            &long,
            ReadLimits {
                max_bytes: 100,
                max_lines: 10,
                max_line_bytes: 3,
            },
        )
        .await
        .unwrap()
    else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(long_read.text, "abc");
    assert!(long_read
        .diagnostics
        .contains(&ReadDiagnostic::LongLine { line: 1, limit: 3 }));

    fs::write(workspace.path().join("lines.txt"), "one\ntwo\nthree\n").unwrap();
    let lines = service.resolve("lines.txt").unwrap();
    let ReadOutcome::File(line_read) = service
        .read(
            "lines",
            &lines,
            ReadLimits {
                max_bytes: 100,
                max_lines: 2,
                max_line_bytes: 100,
            },
        )
        .await
        .unwrap()
    else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(line_read.text, "one\ntwo\n");
    assert!(line_read
        .diagnostics
        .contains(&ReadDiagnostic::LineLimit { limit: 2 }));

    fs::write(workspace.path().join("invalid.bin"), [b'a', 0xff, b'b']).unwrap();
    let invalid = service.resolve("invalid.bin").unwrap();
    let ReadOutcome::File(invalid_read) = service
        .read("invalid", &invalid, ReadLimits::default())
        .await
        .unwrap()
    else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(invalid_read.text, "a\u{fffd}b");
    assert!(invalid_read
        .diagnostics
        .contains(&ReadDiagnostic::InvalidUtf8 { offset: 1 }));
}
