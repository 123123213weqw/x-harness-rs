# Shared model settings (accepted design)

The user approved a complete, reusable Host implementation, not a Windows-only
form or another response-schema patch. Retain the bundled DeepSeek client and
the provider-neutral runtime. Add a settings service boundary between Host RPCs
and native model composition. Web and Tauri must use exactly the same service.

The public adapter exposes the client's `llm-pi-ai` namespace and serialized
Schemastery schema, while internal deployment types remain independent of that
client. Provider profiles contain endpoint, supported protocol, model metadata,
and credential references. Never persist key values in the settings journal.

Configuration mutations are revision-checked, validated, durably committed, and
projected into the runtime catalog. The first delivery may require a documented,
user-confirmed restart to apply configuration; it must never stop an active turn
automatically. Prefer atomic registry replacement if the existing runtime admits
it without changing in-flight turns. Persisted settings are authoritative on
restart and override imported deployment defaults without rewriting user files.

Credentials use a separate injected store. Production uses the platform's native
credential service; tests use an isolated in-memory implementation. Missing or
unavailable credential storage fails explicitly, never silently falls back to
plaintext. Secrets must not enter control receipts, debugging events, errors,
model catalogs, or version control.

Alternatives rejected: Tauri-only commands (not reusable by Web/CLI), editing the
minified UI to fit placeholder RPCs (breaks upstream compatibility), and rewriting
the agent loop (unrelated). Import existing providers.json through the current
deployment parser. Limit advertised protocols to implemented OpenAI adapters.

Acceptance: a clean installation can add/edit/remove a provider and models,
persist its key, survive restart, select its route, and complete a model/tool turn.
Test invalid fields, duplicate IDs, concurrent edits, failed storage, missing
credentials, and removal of a selected route. Run cross-platform CI and Windows
packaging; do not compile Rust locally (AGENTS.md). Keep existing user processes
and data until a verified replacement is available.
