# Optional WordCraft editor (experimental)

WordCraft is a separately downloaded plugin, **not** an enabled built-in tool or
part of the desktop installation. Normal document automation still uses Python.
This adapter reuses a pinned, unmodified WordCraft 0.5.0 WASM engine and the
ZCode 0.2.3 MCP adapter; it changes only the transport/bootstrap and workspace
launcher. Preserve the bundled upstream code, font and asset license notices.
The registry uses a generic document icon, not upstream brand artwork.

## Opt in

1. Install WordCraft from the public plugin catalog after the companion registry
   PR is published. The ZIP is approximately 38.2 MiB; installation leaves both
   Skill and MCP disabled. Node.js is an external prerequisite; we do not install it.
2. Explicitly allow the plugin's MCP capability. This alone does not launch Node
   or load WASM. Enabling its Skill is separate and optional.
3. Choose the intended session/workspace and explicitly select full access.
   Editable panels do not silently elevate a restricted session's permissions.
4. Open an existing workspace `.docx` in the file pane, then choose **Edit with
   WordCraft**. Only then does the session-owned stdio process start and the
   sandboxed editor load. There is no plugin-owned HTTP listener.
5. Keep the editor visible and ready for AI edits. Inspect the document and
   current selection before editing, save, and verify the saved file.

The file toolbar button is absent when the package is not installed and disabled
until MCP is allowed. Refreshing the catalog is not permission to install or
activate anything. The new catalog entry's URL does not claim the production
artifact has already been deployed before the companion PR is accepted.

## Ownership and failure behavior

- At most two live editor panels. A panel belongs to one existing session, its
  canonical workspace and the exact installed package. No path or permission
  comes from an iframe-supplied working directory.
- Session switches and hidden sidebars retain live editors, unlike read-only
  presentation caches. New model operations are rejected while a panel is hidden,
  not ready, disconnected or missing a recent foreground activity lease.
- Hiding **during** an operation can pause browser painting/automation. A timeout
  is outcome-unknown, not proof of an unapplied edit: reveal the panel and inspect
  before retrying. Model calls stay ordered; only app-only replies/resources run
  concurrently. A timeout does not kill a pinned editor or discard unsaved data.
- Closing asks for explicit saved/discarded confirmation. An in-flight model
  operation rejects close without tearing down the iframe. Disabling, updating
  or uninstalling an active editor plugin also requires closing its panels first.
- Browser reload/crash cannot recover unsaved WASM memory. Reopening a stale
  editor requires explicit discard confirmation and reloads the **saved** file;
  it never pretends to restore the unsaved document. Capabilities are not persisted.
- The initial manual save bridge only accepts DOCX workspace destinations and
  asks before overwriting. It re-saves the live engine via its normal MCP path,
  rather than trusting arbitrary iframe bytes. Other manual export formats report
  unsupported instead of writing DOCX bytes under a misleading extension.

## Isolation and resource budget

`.xharness-ui.json` is included in the installed ZIP and pinned in plugin state.
It lists every exposed asset, MIME type, byte length and SHA-256. Only those
public assets are streamed through an unguessable read-only capability; workspace
files never enter this static route. The same file handle is hash-verified before
streaming. A modified package, changed workspace, revoked permission or closed
connection makes the capability unavailable.

The iframe has `allow-scripts allow-downloads`, **not** `allow-same-origin`.
CSP denies general network/frame access. It cannot read Host DOM, cookies or call
Host APIs directly. Parent messages must come from the exact opaque-origin frame;
only app-visible MCP tools and the plugin's resource namespace are forwarded.
Model discovery cannot see/call `_editor_*` tools or launch an unopened UI plugin.

The 88,453,355-byte WASM loads on explicit opening only; this is a comparatively
heavy optional editor, not a promise of negligible memory. No permanent WASM
Base64 cache is kept in Host/UI transport. Two-panel retention is deliberate to
protect unsaved work, not an LRU memory saving claim. Complex DOCX pagination,
fonts and round-trip fidelity are not certified equivalent to Microsoft Word.

## Build and tests

Use `scripts/plugins/package-wordcraft.py --source-zip <audited-input> --out <zip>`.
The script rejects any input except the whole-archive SHA-256 pinned in source;
updating that pin requires reviewing the new upstream artifact. Two repacks of
the same accepted input must match byte-for-byte. No Rust compilation is needed
for repacking. Full WASM source reproducibility is **not** claimed.

Normal CI runs Rust scope/asset/MCP tests and the real opaque iframe bridge test
on Chromium/WebKit. Full editor acceptance additionally uses
`crates/xharness-host-app/examples/wordcraft_fixture.rs`: a separate loopback-only
fixture executable, no model or credentials. This explicit harness is not a
product API. Its real MCP calls/edit/save must be checked against saved DOCX
contents. Rust builds and actual compiler-guard mutations run remotely only.
