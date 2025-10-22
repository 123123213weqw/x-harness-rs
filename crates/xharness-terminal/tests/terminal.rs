#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{collections::BTreeMap, ffi::OsString, time::Duration};

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
