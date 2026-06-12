#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{collections::BTreeMap, ffi::OsString, sync::Arc, time::Duration};

use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_process::SpawnSpec;
use xharness_terminal::{TerminalOpenSpec, TerminalRegistry, TerminalSize};

fn shell_spec() -> SpawnSpec {
    let mut environment = BTreeMap::new();
    environment.insert(
        OsString::from("PATH"),
        OsString::from("/usr/local/bin:/usr/bin:/bin"),
    );
    environment.insert(OsString::from("TERM"), OsString::from("xterm-256color"));
    let mut spec = SpawnSpec::new("/bin/bash", "/tmp").args(["--noprofile", "--norc", "-i"]);
    spec.env = environment;
    spec
}

#[tokio::test]
async fn full_debug_records_terminal_input_raw_output_and_lifecycle() {
    let sink = Arc::new(MemoryDebugSink::default());
    let registry = TerminalRegistry::with_defaults().with_debug(DebugRecorder::new(sink.clone()));
    registry
        .open(TerminalOpenSpec {
            owner: "debug-owner".into(),
            name: "debug".into(),
            process: shell_spec(),
            size: TerminalSize::default(),
        })
        .await
        .unwrap();
    registry
        .send("debug-owner", "debug", b"printf trace-terminal\n")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = registry.read("debug-owner", "debug", None).await.unwrap();
    let _ = registry.close("debug-owner", "debug").await.unwrap();
    let events = sink.events().await;
    for expected in [
        "open.request",
        "open.completed",
        "send.request",
        "output.chunk",
        "read.completed",
        "close.completed",
    ] {
        assert!(events.iter().any(|event| event.event == expected));
    }
    assert!(events
        .iter()
        .all(|event| { event.scope.session_id.as_deref() == Some("debug-owner") }));
}

#[tokio::test]
async fn persistent_pty_is_owner_scoped_and_cursor_based() {
    let registry = TerminalRegistry::default();
    let opened = registry
        .open(TerminalOpenSpec {
            owner: "owner-a".into(),
            name: "main".into(),
            process: shell_spec(),
            size: TerminalSize::default(),
        })
        .await
        .unwrap();
    assert!(opened.running);
    assert!(registry.list("owner-b").await.unwrap().is_empty());

    let before = registry.read("owner-a", "main", None).await.unwrap().cursor;
    registry
        .send("owner-a", "main", b"printf 'terminal-ok\\n'\n")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let read = registry
        .read("owner-a", "main", Some(before))
        .await
        .unwrap();
    assert!(read.content.contains("terminal-ok"), "{:?}", read.content);

    let closed = registry.close("owner-a", "main").await.unwrap();
    assert!(!closed.running);
    assert!(registry.list("owner-a").await.unwrap().is_empty());
}

#[tokio::test]
async fn registry_shutdown_closes_all_ptys_and_rejects_new_sessions() {
    let registry = TerminalRegistry::with_defaults();
    let first = registry
        .open(TerminalOpenSpec {
            owner: "shutdown-a".into(),
            name: "one".into(),
            process: shell_spec(),
            size: TerminalSize::default(),
        })
        .await
        .unwrap();
    let second = registry
        .open(TerminalOpenSpec {
            owner: "shutdown-b".into(),
            name: "two".into(),
            process: shell_spec(),
            size: TerminalSize::default(),
        })
        .await
        .unwrap();

    let report = registry.shutdown().await;
    assert!(report.is_graceful(), "{report:?}");
    assert_eq!(report.sessions, 2);
    assert_eq!(report.closed, 2);
    for pid in [first.pid, second.pid] {
        let pid = Pid::from_raw(i32::try_from(pid).unwrap());
        assert!(matches!(kill(pid, None), Err(Errno::ESRCH)));
    }
    assert!(registry
        .open(TerminalOpenSpec {
            owner: "shutdown-c".into(),
            name: "late".into(),
            process: shell_spec(),
            size: TerminalSize::default(),
        })
        .await
        .is_err());
}

#[tokio::test]
async fn initial_size_reaches_the_child_pty() {
    let registry = TerminalRegistry::with_defaults();
    let spec = {
        let mut process = shell_spec();
        process.program = "/bin/sh".into();
        process.args = vec!["-c".into(), "stty size".into()];
        TerminalOpenSpec {
            owner: "size-owner".into(),
            name: "sized".into(),
            process,
            size: TerminalSize::new(120, 35),
        }
    };
    registry.open(spec).await.unwrap();
    // `stty size` prints rows before columns.
    let output = read_until(&registry, "size-owner", "sized", "35 120").await;
    assert!(output.contains("35 120"), "unexpected output: {output:?}");
    registry.close("size-owner", "sized").await.unwrap();
}

#[tokio::test]
async fn resize_updates_the_child_pty_window() {
    let registry = TerminalRegistry::with_defaults();
    let spec = {
        let mut process = shell_spec();
        process.args = Vec::new();
        TerminalOpenSpec {
            owner: "resize-owner".into(),
            name: "resizable".into(),
            process,
            size: TerminalSize::new(80, 24),
        }
    };
    registry.open(spec).await.unwrap();
    registry
        .resize("resize-owner", "resizable", TerminalSize::new(100, 40))
        .await
        .unwrap();
    registry
        .send("resize-owner", "resizable", b"stty size\n")
        .await
        .unwrap();
    let output = read_until(&registry, "resize-owner", "resizable", "40 100").await;
    assert!(output.contains("40 100"), "unexpected output: {output:?}");
    assert!(registry
        .resize("resize-owner", "resizable", TerminalSize::new(0, 0))
        .await
        .is_err());
    registry.close("resize-owner", "resizable").await.unwrap();
}

#[tokio::test]
async fn raw_read_preserves_utf8_bytes_split_across_pty_writes() {
    let registry = TerminalRegistry::with_defaults();
    let mut process = shell_spec();
    process.program = "/bin/sh".into();
    process.args = vec![
        "-c".into(),
        "stty -echo; printf '\\346'; IFS= read -r _; printf '\\261\\211'".into(),
    ];
    registry
        .open(TerminalOpenSpec {
            owner: "utf8-owner".into(),
            name: "split".into(),
            process,
            size: TerminalSize::default(),
        })
        .await
        .unwrap();

    let mut first = None;
    for _ in 0..50 {
        let read = registry
            .read_raw("utf8-owner", "split", Some(0))
            .await
            .unwrap();
        if !read.content.is_empty() {
            first = Some(read);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let first = first.expect("first UTF-8 byte must arrive");
    assert_eq!(first.content, [0xe6]);
    assert_eq!(first.cursor, 1);

    registry.send("utf8-owner", "split", b"\n").await.unwrap();

    let mut second = None;
    for _ in 0..100 {
        let read = registry
            .read_raw("utf8-owner", "split", Some(first.cursor))
            .await
            .unwrap();
        if read.content.len() == 2 {
            second = Some(read);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let second = second.expect("remaining UTF-8 bytes must arrive");
    assert_eq!(second.content, [0xb1, 0x89]);
    assert_eq!(second.cursor, 3);
    registry.close("utf8-owner", "split").await.unwrap();
}

/// Poll `read` until `expected` shows up or the deadline passes, then return
/// the accumulated output. PTY echo makes the command itself part of the
/// stream, so matching is done on everything seen so far.
async fn read_until(
    registry: &TerminalRegistry,
    owner: &str,
    name: &str,
    expected: &str,
) -> String {
    let mut cursor = None;
    let mut seen = String::new();
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let read = registry
            .read(owner, name, cursor)
            .await
            .unwrap_or_else(|error| panic!("read failed: {error}"));
        cursor = Some(read.cursor);
        seen.push_str(&read.content);
        if read.content.contains(expected) || seen.contains(expected) {
            return seen;
        }
    }
    seen
}
