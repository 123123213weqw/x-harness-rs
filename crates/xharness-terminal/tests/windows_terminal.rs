#![cfg(windows)]

use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_process::SpawnSpec;
use xharness_terminal::{TerminalOpenSpec, TerminalRegistry, TerminalSignal};

fn pwsh_path() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join("PowerShell").join("7").join("pwsh.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("pwsh.exe"))
}

fn pwsh_spec() -> SpawnSpec {
    let environment = std::env::vars_os().collect::<BTreeMap<OsString, OsString>>();
    // ConPTY provides a console, so launch PowerShell's interactive mode.
    // `-Command -` waits for redirected stdin to close and therefore buffers
    // commands instead of behaving like a persistent terminal.
    let mut spec = SpawnSpec::new(pwsh_path(), std::env::temp_dir()).args([
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
    ]);
    spec.env = environment;
    spec
}

async fn wait_for_output(
    registry: &TerminalRegistry,
    owner: &str,
    name: &str,
    needle: &str,
) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let read = registry.read(owner, name, None).await.unwrap();
        if read.content.contains(needle) {
            return read.content;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "ConPTY output did not contain {needle:?}: {:?}",
            read.content
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn conpty_runs_persistent_powershell_with_utf8_and_debug_events() {
    let sink = Arc::new(MemoryDebugSink::default());
    let registry = TerminalRegistry::with_defaults().with_debug(DebugRecorder::new(sink.clone()));
    let opened = registry
        .open(TerminalOpenSpec {
            owner: "windows-owner".into(),
            name: "powershell".into(),
            process: pwsh_spec(),
        })
        .await
        .unwrap();
    assert!(opened.running);

    registry
        .send(
            "windows-owner",
            "powershell",
            "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output 'conpty-你好'\r\n"
                .as_bytes(),
        )
        .await
        .unwrap();
    let content = wait_for_output(&registry, "windows-owner", "powershell", "conpty-你好").await;
    assert!(content.contains("conpty-你好"), "{content:?}");

    registry
        .signal("windows-owner", "powershell", TerminalSignal::Interrupt)
        .await
        .unwrap();
    let closed = registry.close("windows-owner", "powershell").await.unwrap();
    assert!(!closed.running);
    let events = sink.events().await;
    for expected in [
        "open.completed",
        "send.completed",
        "output.chunk",
        "close.completed",
    ] {
        assert!(events.iter().any(|event| event.event == expected));
    }
}

#[tokio::test]
async fn conpty_registry_shutdown_reaps_all_powershell_sessions() {
    let registry = TerminalRegistry::with_defaults();
    for (owner, name) in [("owner-a", "one"), ("owner-b", "two")] {
        registry
            .open(TerminalOpenSpec {
                owner: owner.into(),
                name: name.into(),
                process: pwsh_spec(),
            })
            .await
            .unwrap();
    }
    let report = registry.shutdown().await;
    assert!(report.is_graceful(), "{report:?}");
    assert_eq!(report.sessions, 2);
    assert_eq!(report.closed, 2);
}
