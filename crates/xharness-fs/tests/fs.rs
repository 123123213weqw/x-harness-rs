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

use xharness_fs::{
    FsError, FsService, Observation, ReadCursor, ReadDiagnostic, ReadLimits, ReadOutcome, ReadStart,
};

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
    fs::create_dir(workspace.path().join("gate")).unwrap();
    fs::write(workspace.path().join("gate/file.txt"), "inside-v1").unwrap();
    fs::write(outside.path().join("file.txt"), "outside-sentinel").unwrap();
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
        let gate = root.join("gate");
        let parked = root.join("gate.parked");
        while !toggler_stop.load(Ordering::Relaxed) {
            fs::rename(&gate, &parked).unwrap();
            symlink(&outside_path, &gate).unwrap();
            std::thread::yield_now();
            fs::remove_file(&gate).unwrap();
            fs::rename(&parked, &gate).unwrap();
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
    fs::create_dir(workspace.path().join("current")).unwrap();
    fs::write(workspace.path().join("current/file.txt"), "inside-v1").unwrap();
    fs::write(outside.path().join("file.txt"), "outside-v1").unwrap();
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("current/file.txt").unwrap();
    service
        .read("session", &target, ReadLimits::default())
        .await
        .unwrap();

    fs::rename(
        workspace.path().join("current"),
        workspace.path().join("inside"),
    )
    .unwrap();
    symlink(outside.path(), workspace.path().join("current")).unwrap();
    assert!(service
        .write("session", &target, b"attacker-wins".to_vec())
        .await
        .is_err());
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

#[tokio::test]
async fn paged_read_cursor_is_contiguous_line_aware_and_version_bound() {
    let workspace = TestDir::new("paged-read");
    let service = FsService::new(workspace.path()).unwrap();
    fs::write(
        workspace.path().join("pages.txt"),
        "zero\none\ntwo\nthree\n",
    )
    .unwrap();
    let target = service.resolve("pages.txt").unwrap();
    let limits = ReadLimits {
        max_bytes: 64,
        max_lines: 1,
        max_line_bytes: 64,
    };

    let ReadOutcome::File(first) = service
        .read_page("paged", &target, ReadStart::Line(2), limits)
        .await
        .unwrap()
    else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(first.text, "one\n");
    assert_eq!(first.page_start_offset, 5);
    assert_eq!(first.page_start_line, 2);
    assert_eq!(first.captured_bytes, 4);
    assert_eq!(first.total_bytes, 19);
    let cursor = first.next_cursor.expect("first page must continue");
    assert_eq!(ReadCursor::parse(&cursor.encode()).unwrap(), cursor);

    let ReadOutcome::File(second) = service
        .read_page("paged", &target, ReadStart::Cursor(cursor.clone()), limits)
        .await
        .unwrap()
    else {
        panic!("file unexpectedly absent");
    };
    assert_eq!(second.text, "two\n");
    assert_eq!(second.page_start_line, 3);
    assert_eq!(second.page_start_offset, cursor.offset());

    fs::write(workspace.path().join("pages.txt"), "changed\n").unwrap();
    let stale = service
        .read_page("paged", &target, ReadStart::Cursor(cursor), limits)
        .await
        .unwrap_err();
    assert!(matches!(stale, FsError::StaleReadCursor { .. }));
    assert!(matches!(
        ReadCursor::parse("v1:not-a-number:bad"),
        Err(FsError::InvalidReadCursor)
    ));
    let non_ascii_digest = format!("v1:0:4:1:4:{}", "é".repeat(32));
    assert!(matches!(
        ReadCursor::parse(&non_ascii_digest),
        Err(FsError::InvalidReadCursor)
    ));
}
// ---------------------------------------------------------------------------
// FIFO containment (regression for #95).
// ---------------------------------------------------------------------------

/// A FIFO in the workspace must be rejected as a non-regular file, not opened.
///
/// The open happens *before* the regular-file check, so without `O_NONBLOCK` the
/// `open(2)` on a FIFO with no writer blocks per POSIX: `resolve` never returns,
/// taking the runtime worker thread that called it with it. `resolve` is a
/// synchronous `pub fn` reached from the `read`/`write`/`edit` handlers, so
/// nothing above it can cancel the syscall.
#[test]
fn resolve_rejects_a_fifo_without_blocking() {
    let workspace = TestDir::new("fifo-resolve");
    let fifo = workspace.path().join("p");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo must be available");
    assert!(status.success(), "mkfifo failed: {status}");

    let root = workspace.path().to_path_buf();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    // A detached thread: if the open ever blocks again, the assertion below
    // fails and the process exit reclaims the thread.
    std::thread::spawn(move || {
        let service = FsService::new(&root).expect("service");
        let _ = finished_tx.send(format!("{:?}", service.resolve("p")));
    });

    match finished_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(outcome) => assert!(
            outcome.contains("NotRegularFile"),
            "resolve must reject a FIFO as a non-regular file, got: {outcome}"
        ),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("resolve blocked on a FIFO instead of rejecting it")
        }
        Err(error) => panic!("unexpected channel error: {error:?}"),
    }
}

/// A FIFO used as a path *component* must fail closed for the same reason: the
/// parent walk opens with `O_DIRECTORY`, which rejects a FIFO with `ENOTDIR`
/// rather than blocking on it.
#[test]
fn resolve_rejects_a_fifo_parent_component_without_blocking() {
    let workspace = TestDir::new("fifo-parent");
    let fifo = workspace.path().join("p");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo must be available");
    assert!(status.success(), "mkfifo failed: {status}");

    let root = workspace.path().to_path_buf();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let service = FsService::new(&root).expect("service");
        let _ = finished_tx.send(format!("{:?}", service.resolve("p/inner")));
    });

    match finished_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(outcome) => assert!(
            outcome.starts_with("Err("),
            "a FIFO parent component must be rejected, got: {outcome}"
        ),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("resolve blocked on a FIFO parent component")
        }
        Err(error) => panic!("unexpected channel error: {error:?}"),
    }
}

/// The same call shape the `read`/`write`/`edit` handlers use — a synchronous
/// `resolve` awaited inside an async task — must not consume the runtime worker.
#[test]
fn a_fifo_does_not_starve_the_runtime_worker() {
    let workspace = TestDir::new("fifo-starvation");
    let fifo = workspace.path().join("p");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo must be available");
    assert!(status.success(), "mkfifo failed: {status}");
    let root = workspace.path().to_path_buf();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    // `xharness-fs` does not enable tokio's `time` feature, so the liveness
    // heartbeat yields cooperatively instead of sleeping.
    let ticks = Arc::new(AtomicU64::new(0));
    runtime.spawn({
        let ticks = Arc::clone(&ticks);
        async move {
            loop {
                tokio::task::yield_now().await;
                ticks.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    for _ in 0..2_000 {
        if ticks.load(Ordering::Relaxed) >= 10_000 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(
        ticks.load(Ordering::Relaxed) >= 10_000,
        "the heartbeat never ran; the runtime did not start"
    );

    runtime.spawn(async move {
        let service = FsService::new(&root).expect("service");
        let outcome = service.resolve("p");
        assert!(
            format!("{outcome:?}").contains("NotRegularFile"),
            "the handler call shape must get NotRegularFile, got: {outcome:?}"
        );
    });
    std::thread::sleep(std::time::Duration::from_millis(300));
    let before = ticks.load(Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let after = ticks.load(Ordering::Relaxed);

    assert!(
        after > before,
        "the runtime worker stopped ticking ({before} -> {after}); the FIFO call \
         consumed the only worker thread"
    );
}
