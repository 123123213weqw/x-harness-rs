# Stabilization freeze: fixed foundations, flexible tools

This is a change-control policy, not a claim that the foundation is bug-free.
Do not split more crates, add another scheduler, or pin the tool catalogue.

## Protected boundaries

`config/architecture-freeze.json` enrolls five runtime boundaries and the checker
itself. Only bug fixes and backwards-compatible additions belong in this phase.

| Boundary | Stable responsibility | Existing regression coverage |
| --- | --- | --- |
| Native execution | Shell selection, process/Job lifetime, filesystem and sandbox permissions, pinned Windows runtime | Full native workspace tests, Windows process/ACL tests, bundled PowerShell execution |
| Tool execution | Registry, approvals, ordering, cancellation and execution lifecycle | Full native tool/runtime tests on Linux and Windows |
| Host/UI contract | Existing RPC names and projection/event meanings | Native DTO/wire fixtures and UI consumers, native workspace tests |
| Persistence | Existing event/revision/CAS meanings and session/control storage | JSONL/recovery/restart regressions, full native workspace tests |
| Installation/update | Application identity, install ownership, updater trust and Host shutdown | Windows desktop/unit/loader tests, updater contracts; existing release-only install/upgrade acceptance remains mandatory for publication |

Tool handlers, descriptions, defaults, argument/result schemas and new tools in
`xharness-coding-tools` remain flexible, as do tool UI cards. They still undergo
normal tests, permission checks and crate dependency rules. A schema/description
change can affect model decisions; this policy does not certify model quality or
silently authorize paid evaluations. If a tool change also touches shared
execution, that foundation change needs a record. Host orchestration, provider
streaming and compaction algorithms are not implementation-frozen.

## Gate and records

Run the existing architecture checker with an explicit base:

```sh
python3 -B scripts/regression/check-architecture.py --base "$(git merge-base HEAD origin/master)"
```

Unchanged boundaries and tool-only changes require **no record**. For a focused
foundation correction, generate a compatibility/test plan after finishing edits:

```sh
python3 -B scripts/regression/architecture_freeze.py \
  --base "$(git merge-base HEAD origin/master)" \
  --record windows-cancel-fix --kind bugfix \
  --reason "Correct the reproduced cancellation defect." \
  --compatibility "Keep existing exit codes, wire formats and permission behavior."
```

Commit the generated file in `config/architecture-changes/`. Each exact changed
protected path is bound to before/after SHA-256 values (repository LF line endings)
and the boundary's required regression groups. Regenerate after edits or a rebase
that changes a bound base file. Staged/untracked additions, removals and both sides
of renames are checked. Old unchanged records cannot authorize later work. Records
never contain arbitrary executable test commands.

The comparison uses the **base commit's policy**, so a PR cannot remove a path or
Windows requirement from its own gate by editing the proposed policy. The initial
policy introduction is explicitly reported as bootstrap and still requires a
record. Changing the policy/checker/CI itself is protected and visible in review.
Existing RPC wire names cannot be removed/renamed, and application identifier or
Windows installation mode cannot change, even with a record. Tool names/schemas
are deliberately not included in these hard pins.

This is not a Rust semantic ABI parser or a guarantee of compatibility. A record
is a test plan and review aid, **not** proof of approval or test success. Other
wire fields, persisted event semantics and updater trust still require code review
and the existing executable regressions. Breaking redesigns require a separately
reviewed change to the freeze policy, with migration/old-client coverage, rather
than mislabeling the change as a bug fix. The hard pins have no per-PR bypass.

## CI and Windows

The unconditional `Architecture / stabilization freeze` job uses the PR's exact
base SHA or a push's previous SHA, with full Git history and fail-closed exit
handling. It retains its diff/record report. Python mutation tests also execute
on native Windows. The existing Windows workspace, Tauri, bundled-shell, updater
and loader regressions remain unconditional on PRs; no duplicate Rust build suite
is added. Installation/updater acceptance that is currently release-only remains
release-only; a PR is not native upgrade certification.

Require the new check in repository rulesets if merge blocking is desired. A
workflow cannot configure its own required status, prevent a repository admin
from replacing CI, or manufacture human approval. This change does not modify
repository rulesets, publish a release or install anything on a user's computer.

Without Git metadata (e.g. a source-only rsync build), the checker says explicitly
that only static policy validation ran. CI always supplies a base; a missing or
invalid explicit base fails. Source-only remote Rust results are combined with
the local/CI Git-backed gate, never presented as a differential freeze proof.
