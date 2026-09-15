# Shipped UI preference persistence (#65)

The shared Rust Host registers `ui-theme.preference`, `locale.preference`,
`ui-conversation.busyEnter`, and `agent-presets.default` before restoring the
control journal. All three settings write methods validate these sections, then
use the existing control gate, revision fence and durable commit/notification path.
Missing fields retain the UI fallback; `unset` restores that behavior. Unknown
namespaces still fail closed. No model configuration or credentials are changed.

New sessions without an explicit preset use the saved default when that preset
exists. A missing preset falls back to `coding` without deleting the saved ID.
Preset definitions have their existing lifecycle; this change does not add
persistence of copied/edited preset definitions or change running sessions.

The settings-scope UI displays a localized, dismissible save-failure notice for
RPC refusals and transport errors, even if recovery reads also fail. It does not
show raw errors or values. Latest-write fencing and disposal prevent stale
notices; a successful save clears only its own namespace's failure. Default
preset management already reports errors inline and retains that path.

## Compatibility

- Desktop and loopback Web share Host-backed persistence across platforms.
- Remote browsers retain the existing process-local mode; settings write access
  is not broadened by this fix.
- No migration changes old settings or creates synthetic user choices. Preferences
  previously rejected by the Host cannot be recovered; users must select them once.
- After the new Host durably writes these namespaces, older Hosts that do not
  register them reject that control log. Do not downgrade against the same state
  directory; retain a pre-upgrade data backup for rollback. Do not delete a live
  control journal to bypass this validation.

## Verification

- Native process test: all four namespaces, update/replace/mutate, three Host
  launches, unset persistence, revision conflicts, invalid writes, unknown namespaces.
- Host tests: preference enums and default-preset selection/fallback/explicit override.
- Node regression: transport/RPC failure, failed reread, generation race, disposal,
  remote memory mode, checked patch anchors, CRLF, bundle hashes and boot graph.
- Browser fixture: modal layer, Chinese/English text, bounded DOM, no focus steal,
  dismissal, matching-success clear and narrow viewport; Chromium/WebKit in CI.

WZU_Server was unreachable during implementation. No local Rust compilation was
performed; Rust validation is delegated to repository CI. No installed App or
production data was replaced or used by these tests.
