# Model-independent DeepSeek search acceptance

## Delivered behavior

- The native Host uses the official DeepSeek Search API directly, not an
  auxiliary chat-model request. Exa is no longer built in.
- The existing Plugins configuration card stages an enable switch and key.
  The enable setting is durable; the key stays in the OS credential store or
  explicitly named environment reference. No key is persisted in settings.
- `web_search(query, limit)` and its result structure stay unchanged. Search
  availability does not depend on the selected tool-capable chat model.
- Settings and credentials are read per operation. Disabling search removes it
  from the next turn's tool projection and prevents already-exposed new calls.
  In-flight calls retain their original configuration/credential snapshot.
- `web_fetch` keeps its existing transport, SSRF policy, and reader behavior.

## Regression coverage

The HTTP adapter fixtures exercise authorization and the exact request body,
128-character Unicode queries, result bounds and normalization, legitimate empty
results, malformed replies, oversized replies, permanent failures, redirects,
finite transient retries, and cancellation during stalled I/O or retry waiting.

Native composition tests exercise two unrelated model routes, the real tool
factory's enabled/disabled projection, missing/rotated/deleted credentials, and
the Host weak-reference lifetime. The durable settings/credential RPC test
restarts the Host, replays a revision-fenced receipt, checks credential-change
events, and verifies that an independent search-key write does not reload other
models' keys. It also selects models across two providers and back through the
real Session RPC, keeping search available. Model-linked writes still activate
the model registry. Native
credential validation, process read-only overrides, and store failures stay
explicit. Fixture control files are checked for literal-key leakage.

The TypeScript tests cover staging, saving, and resetting the switch, removal of
the obsolete endpoint/maxUses fields, and a rejected key replacement when an old
key is already configured. That refusal must remain an unsaved draft, not appear
as a successful save. Production assets are rebuilt from the owned TS sources.

## Verification boundaries

Rust compilation/tests run on WZU_Server, never on the development Mac. Local
checks are formatting, architecture policy, TypeScript, and static UI assembly.
HTTP fixtures are not a live DeepSeek service or real-model evaluation. No live
API call, account-charge assertion, macOS/Windows native installation, app
replacement/restart, release publication, or shared-key distribution is claimed.

## Executed checks

- V100: `cargo test --locked -p xharness-web -p xharness-host -p xharness-host-app`
  passed 730 tests with 14 existing ignored tests; no ignore annotations changed.
  After expanding the model-switch case, all 21 `model_settings` integration
  tests were rerun and passed.
- V100: `cargo clippy --locked -p xharness-web -p xharness-host -p xharness-host-app --all-targets -- -D warnings` passed.
- V100 Linux desktop: the 10 `sidecar::tests` passed; desktop `--all-targets`
  Clippy with warnings denied passed. Debug sidecars were staged only inside
  the isolated test checkout, not installed or distributed.
- UI: strict TypeScript, reproducible production build/check, 77 view-source
  tests, model-settings and remote-settings contracts, desktop bootstrap/startup,
  settings-save feedback, and desktop asset checks passed. The plugin wire test
  consumed actual Rust output: 13 native replies and one shared DTO fixture,
  covering 11 endpoints and two error replies.
- Formatting, architecture dependency/freeze checks, and 30 architecture-policy
  mutation tests passed. API/tool/result schemas and anonymous fetch are unchanged.

Source API contract: [DeepSeek Search API](https://api-docs.deepseek.com/api/search/).
The implementation details and bounds are in [the web specification](../specs/web.md).
