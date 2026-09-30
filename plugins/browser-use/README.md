# Browser Use adapter

An opt-in isolated Chromium MCP adapter, using XHarness's existing lazy `plugin_mcp` registry, execution, cancellation and per-chat process lifetime. This is **not** an adapter for the embedded Tauri WebView and does not control the user's Chrome profile or desktop.

The server advertises one `browser` tool. Navigate to an operator-approved origin, observe compact untrusted page evidence, then act on a reference and its exact frame. No arbitrary script evaluation or shell is exposed. Element handles prevent a replacement DOM element from silently inheriting an old reference. Every action invalidates the prior frame before effects; failures after invocation explicitly report an uncertain/applied effect so callers re-observe rather than blindly replay.

Operators supply `XHARNESS_BROWSER_DEPS` (a directory containing an installed Playwright dependency and Chromium) and `XHARNESS_BROWSER_ALLOWED_ORIGINS` (a JSON array of exact origins). The model cannot add origins. Fresh browser contexts contain no user cookies or model API credentials. Password values are redacted. Observation results are bounded before crossing the existing MCP result-size boundary.

Current limits: semantic observation only, one page, no cross-frame/shadow-DOM guarantee, no download/upload integration, and no embedded WebView connection. This adapter is an experimental candidate for user review, not a SOTA claim or automatic production installation.


## Observation paging and contracts

`observe` optionally accepts `scope` (`page`, `main`, `dialog`), `text_offset` and `node_offset`. Use the returned `next_text_offset` / `next_node_offset` to retrieve omitted evidence. Each observation replaces the reference frame; act only on refs from the latest page of nodes. This bounds the nested MCP/tool projection below the normal Host archival threshold without irreversibly discarding later controls or text.

The manifest and `.mcp.json` follow the existing plugin package layout. Enabling a plugin and enabling its MCP server remain separate explicit operator decisions. The evaluator bootstraps only its disposable state; no production catalog or user configuration is changed. Dependency availability and allowed origins must be configured by the operator before enabling it.

Run `UI_TEST_DEPS=/path/to/test/deps node scripts/gui_bench/test_browser.mjs` for real Chromium/stdio contracts without paid API calls. The GUI candidate CI runs these contracts and remote Rust regressions. Public task replay uses `scripts/gui_bench/run_native.py --mode browser`; its separate credential controller enforces the original shared CNY ledger and deadline. Preserve the ledger on retry/resume; never create a second budget to bypass the ceiling.
