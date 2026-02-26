# Unix acceptance cleanup implementation plan

> Execute task-by-task with verification checkpoints; no local Rust compilation.

**Goal:** Finish owned native acceptance cleanup without treating Darwin zombie-only process groups as live permission failures.

**Architecture:** Inspect the exact owned group, reap the direct child, send TERM then bounded KILL only while live members remain, and verify quiescence. Preserve fail-closed handling of live permission failures and write process-state evidence on success and failure. Do not kill processes by executable name or change installed applications.

**Tech stack:** Python standard library, Unix ps/process groups, GitHub-hosted native CI.

## Evidence and alternatives

PR #45 CI 34360878505 failed twice in round 2 at killpg with EPERM, after all upgrade assertions succeeded. Existing evidence does not identify which signal failed or whether live processes remained. Apple XNU bsd/kern/kern_sig.c killpg1 excludes SZOMB group members and can return EPERM when none can be signalled. This is a plausible mechanism, not yet a runner-level diagnosis.

Ignoring EPERM would hide real leaks. Only reaping the original parent would miss the restarted child. Use explicit live-group verification instead. Zombie processes have exited and cannot be killed; reap our direct child and leave reparented zombies to their parent/init. Preserve process_group=0 on Darwin and Linux's private session.

## Task 1: Regression tests

- Modify `scripts/test-unix-update-acceptance.py`: mock absent/zombie-only groups, TERM completion, TERM-resistant descendants, real EPERM, EPERM after exit, malformed ps output, foreign UID, own-group rejection, bounded KILL failure and cleanup evidence.
- Run `python -B scripts/test-unix-update-acceptance.py CleanupTests` locally; establish failure before implementing.
- Add Unix-only real child/restart descendant tests; run via existing Linux/macOS CI, not Windows emulation.

## Task 2: Implementation

- Modify `scripts/unix-update-acceptance.py`: exact group snapshots from `ps -axo pid=,pgid=,uid=,stat=`, strict parsing, bounded TERM/KILL waits, live-member verification after any ESRCH/EPERM race. Record snapshots, signals and errors in `cleanup.json` within the isolated evidence root.
- Pass evidence root from both native entry points. Existing finally blocks continue invalidating acceptance.json on failure.
- Run local mock regressions, Python syntax validation and Windows/release contract tests. Commit the focused fix using the current GitHub identity.

## Task 3: Native CI and release handoff

- Push to existing PR #45; require full CI including all three Unix rehearsal repetitions and no live-process cleanup failure. Review cleanup.json evidence if CI fails; do not suppress failures or reduce rounds.
- Merge only after green checks, then require exact master SHA CI before a new immutable 0.2.11 tag.
- Continue Windows/Linux-only signed build, native candidate acceptance and promotion; no macOS publication, live installation changes, signing-key migration or 0.2.10 retagging.
