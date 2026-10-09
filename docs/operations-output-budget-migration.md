# Output budget defaults and one-time migration

The native Host applies `migration.output-budget-auto.v1` before restoring
settings, accepting RPCs or resuming pending input. It removes only editable
`llm-pi-ai` provider/model `maxTokens` and model `minimumOutputTokens` overrides.
It does not edit conversations, keys, routes, model lists/order, context-window
settings or safety margins. Deployment `providers.json` and explicit environment
or CLI budgets remain authoritative and are not rewritten.

## Automatic does not mean unlimited

* The maximum target comes from the matching deployment model's declared
  `maxTokens`, then the provider default. Endpoint, protocol and upstream model
  must match before model-level defaults can be inherited.
* Without a declared limit, the existing conservative **4096** target remains.
  No model-name heuristics or context-window-as-output-limit guesses are used.
* An omitted minimum reserve is **min(1024, maximum target)**, independently of
  the maximum. Explicit later minimum edits remain supported.
* Per-request output is bounded by the target and remaining context after input
  and safety margin. Maximum targets larger than the current context remainder
  are allowed; `minimum + safety < context` and `minimum <= maximum` are required.
* Output continuation counts and the per-turn aggregate output ceiling are not
  removed. An actual provider `length` result is still a truncated response.

## Persistence / rollback

Before a changed snapshot is appended, its original user and effective settings
are saved under `<state-dir>/settings-backups/output-budget-v1-r<revision>-*.json`.
Unix directory/file permissions are 0700/0600; on Windows the directory inherits
state-directory ACLs. Backups contain configuration and must not be published.
Every attempt uses a new file; incomplete files from an interrupted backup are
never reused. The settings event and version marker share one atomic CAS batch.
Backup or append failure does not commit a reset; revision conflicts reload and
retry with the latest snapshot (at most four attempts).

New installs also receive the marker. Subsequent launches leave manual changes
alone. Rollback is a normal settings mutation restoring the backup's `user`
section (after reviewing valid token fields); do not delete the version marker
or overwrite the append-only control log. Restored values must pass current
budget validation. Invalid explicit deployment-file budgets are not repaired by
this editable-settings migration.

Frontend cross-field validation prevents saving a visible maximum below a hidden
minimum. Settings activation updates future turns; an already-running turn keeps
its immutable provider/budget. Model-reported hard limits must be accurate; this
migration cannot verify arbitrary third-party output capabilities.
