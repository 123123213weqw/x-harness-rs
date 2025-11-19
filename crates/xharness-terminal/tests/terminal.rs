#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{collections::BTreeMap, ffi::OsString, sync::Arc, time::Duration};

use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_process::SpawnSpec;
use xharness_terminal::{TerminalOpenSpec, TerminalRegistry};

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
