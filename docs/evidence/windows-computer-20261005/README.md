# Windows Computer Use — native evidence, 2026-10-05

## Exact tested implementation

- Source: `9df5a01dfe355ab1023a000aaee2fe5a1e9c743c`.
- [Windows CI](https://github.com/123123213weqw/x-harness-rs/actions/runs/37295047311): 16 non-interactive tests, native clippy, Host composition check and release probe build passed.
- Probe SHA256: `37d6a32278940bc67de2d73ddeeec3a84a25298997bd583791bf6b44eb25b19f`.
- Independent PE ordinary/delay import audit: AMD64, no dynamic MSVC runtime dependency; artifact source and digest matched before execution.
- Authorized isolated V100 clone: `xharness-install-lab-20261005`, SMBIOS UUID `66b64058-bdcc-43e9-85ee-55a79fe2e875`. Windows 11 preview build 26300; filtered administrator account. UAC, accounts, original VM and production application were not changed. VCRUNTIME140.dll was absent.
- Native exit: **0**, collector receipt `2026-10-05T10:16:06.828638+00:00`.

`native-results.jsonl` contains independently asserted per-case results and the exit receipt, not an LLM's self-assessment. `artifact-audit.json` records the independently verified artifact identity. The fixture uses the same `WindowsComputer` driver, worker protocol and native implementation as the Host; it does not replace the installed application.

## Passed native cases (12)

| Case | Independent assertion |
| --- | --- |
| Observe | Fixture foreground, physical coordinates, bounded UIA tree (9 nodes; 1043 ms) |
| Unicode input | GetWindowText matches Chinese and surrogate-pair emoji; no clipboard |
| Stale frame | Rejected before input; text unchanged |
| Ctrl+A delivery | Actual Edit keydown with Control modifier observed exactly once |
| Selection and replacement | Ctrl+Home, Ctrl+Shift+End; EM_GETSEL covers full UTF-16 text; subsequent node Type replaces text exactly |
| Semantic click | Native Button WM_COMMAND received exactly once |
| Move window | GetWindowRect matches requested x/y |
| Resize window | GetWindowRect matches requested width/height |
| Scroll | Actual WM_MOUSEWHEEL received |
| Cancel drag | GetAsyncKeyState first proves button held; cooperative cancel releases it (22 ms) |
| Screenshot | Actual binary PNG decoded, 1024 × 768, 434286 bytes |
| Wait | At least requested 100 ms elapsed (317 ms total) |

Total native fixture elapsed: **11198 ms**, model calls: **0**. These timings are one controlled run, not a performance benchmark or a general latency guarantee.

## Bugs found by actual interaction

1. UIA focus transiently exposes an Edit child as the foreground HWND. Comparing raw handles incorrectly stopped input as an app switch. Normalize child ancestry with `GA_ROOT`, not owner ancestry; a genuinely different top-level/popup still invalidates the frame.
2. Repeating SetFocus before Type can disturb an existing selection. Query CurrentHasKeyboardFocus and avoid resetting an already focused node. Real selection/replacement now passes.

The original Ctrl+A replacement expectation was also invalid for a classic multiline Edit control. The test now checks actual chord delivery separately and uses supported navigation for selection; it does not implement a fake shortcut or weaken the driver to pass.

## Not yet accepted / release gates

- Installed desktop → Host → actual model tool call → attachment projection end-to-end.
- Windows version matrix, multi-monitor/mixed DPI, UAC/secure desktop, elevated targets, real user takeover and hung third-party UIA providers.
- Standalone pointer move and the full window focus/minimize/maximize/close matrix.
- External hard-kill while holding input: cooperative cancellation is verified, forced termination cannot yet promise input-state recovery.
- macOS regression CI for shared registration/media changes; this fixture does not prove macOS behavior.

Fullscreen remains deliberately unsupported/application-specific. No merge, production replacement, release or update manifest change is certified by this record.

## Reproduction

Compile remotely with the workflow commands; never compile Rust on the local Mac. On the authorized clone only, build `computer-probe` with `--features native-acceptance`, verify the source SHA and executable SHA256, set `XHARNESS_DISPOSABLE_COMPUTER_VM` to the clone UUID, and invoke `computer-probe.exe --native-acceptance`. The UUID feature guard prevents accidental normal invocation but is not a sandbox; use the named disposable interactive desktop. Don't provide user input during the fixture. Ordinary product builds omit this fixture.
