# Shared model settings

The native Host installs a `ModelSettingsBackend` implemented by the reusable
host-app library. Tauri and the Web carrier call the same existing RPCs. There
is no PowerShell settings proxy and no desktop-only provider database.

## User workflow

Open Settings → Models → Add custom provider. Enter a unique provider route,
HTTP(S) base URL, supported protocol and model ID(s). The custom-provider form
creates a credential reference; leaving its key empty keeps that route inactive.
Profiles with no `apiKeyEnv` can use local unauthenticated model servers.
Use HTTPS for remote credentialed services.
Chat completions and Responses are supported; other protocols are not advertised.

The Models fetch action contacts the form's endpoint with a 15-second deadline,
does not follow redirects, and returns at most 512 candidates from a bounded
2 MiB OpenAI-style listing. A saved key is not sent to a different draft URL;
enter the key explicitly when testing a changed endpoint. Manual model entry
remains available when an endpoint has no listing API.

Profiles are committed through the existing revisioned Host control store;
credentials are written separately. The client's partial-success retry flow
handles a profile saved before its key. A missing key leaves the provider
configured but inactive. A credential write prepares the replacement registry
before writing the key and activates it only after successful storage.

Successful changes apply to subsequent turns without restarting the App. Active
turns retain their already-bound provider. Removing a model makes future calls
to its old selection unavailable rather than silently routing them elsewhere.
New sessions choose the configured default when available, otherwise the first
available model, and persist that selection.

## State and security

`--providers-file` remains an imported base layer; user changes are persisted in
the selected `--state-dir` control log. Imported profiles cannot be removed via
the custom-provider delete action; removing user overrides restores their base.
Preserved metadata includes exact-model reasoning, upstream model aliases,
capability probes and token budgets. Explicit context limits are recommended.
When no limit is given for a new model, 32768 is an explicitly non-authoritative
fallback; default output reserve is 4096 and safety margin 1024 tokens. These are
budget assumptions, not claims about an endpoint's actual accepted limits.

Only key references (`apiKeyEnv`) enter settings and control receipts. The
production credential store is Windows Credential Manager, macOS Keychain or
Linux Secret Service via keyring 3.6.3. Credential entries are scoped by canonical
state-directory identity. Keep the same state directory across upgrades; copying
the control log to another machine/directory does not copy the keys. There is no
plaintext fallback. Headless Linux deployments can use environment variables or
provide an unlocked Secret Service. Environment/process credentials take priority
and are read-only in the UI.

Keyring feature selection and platform behavior:
https://docs.rs/keyring/3.6.3/keyring/

The RPC trace records parsed/redacted JSON rather than raw request strings and
omits credential-write payloads. Credentials never enter control receipts or
session logs. Invalid configuration, stale revisions and unavailable credential
storage return errors without applying an uncommitted registry.

## Verification

- `node scripts/test-model-settings-ui.mjs`: runs the actual bundled schema
  implementation against the Rust schema; no replica validator.
- `cargo test -p xharness-host-app --test model_settings`: persistence, invalid
  edits, key storage failure and authenticated HTTP model execution; Windows also
  tests actual credential-store persistence/recreation and cleanup.
- `cargo test -p xharness-host-app --test process_model_settings`: real executable,
  HTTP RPCs, native state directory, process restart and exactly-once replay.
- Full workspace tests and platform installer builds run on GitHub CI. Local
  Rust compilation is prohibited by this repository's AGENTS.md.

Production-provider and packaged-UI acceptance must be reported separately from
these deterministic tests. Passing a mock-provider test is not evidence that a
particular user's API account is valid or that a long coding run was completed.
