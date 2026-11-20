# WordCraft scoped launch and static discovery

Follow-up to #442. Removes the accidental session-wide full-access prerequisite;
no package, dependency, model/Skill prompt or default enablement change.

## Permission ownership

- Install remains inert. MCP must still be explicitly enabled in Plugin Hub.
- Opening a document is an authenticated desktop action. The existing UI
  confirmation pattern now confirms starting this local plugin for that document
  before `panelOpen` sends `launchConfirmed: true`. Cancel sends no API request.
  This does not set or persist a session permission preset, or approve model calls.
- This is **not** an OS sandbox for arbitrary third-party Node code. The dialog
  says so. Existing document/adapter and Host save-path checks restrict supported
  document operations to the session workspace; cwd/environment alone is not an
  OS filesystem restriction.
- workspace-write and workspace-write-ai-review retain the existing per-tool
  approval protocol (AI review/fallback included). Full access retains its
  existing policy. A manual UI launch grant cannot bypass a required model
  approval, app-only tool separation, or visible/ready checks.
- A panel capability binds the existing session workspace and package digest.
  Archive/delete, workspace change, disconnect and disable still fail closed.
  Changing between the three current presets does not discard the user's live
  editor: each permits explicit workspace document UI actions. Model operations
  remain subject to the executing turn's permission/approval policy. There is no
  new persistent grant, session permission escalation or parallel approval queue.
- Manual save still requires a confirmed destination, existing canonical parent
  inside the workspace, regular non-symlink target and DOCX extension. Browser
  supplied bytes are never written by the Host.

## Discovery without activation

UI packages may provide a bounded `dist/tools.json` array. Installation computes
an optional SHA-256 only after verifying the complete archive against its catalog.
Discovery validates that pin on each read; it never learns trust from mutable
files at discovery time. The existing WordCraft 0.1.0 archive already contains
this catalog, so no binary/package rewrite or registry change is necessary.

Only matching UI-server static `list`/`describe` and its process-free server index
are approval-free. Foreign server discovery that can start a process and all
model `call` operations retain existing approval policy. An already-durable
approval requirement is never removed. App-only tools and `open_editor` are not
advertised: opening still belongs to the explicit document UI.

Legacy installed metadata without the new optional pin is not silently trusted
or migrated. Reinstall the same verified plugin and explicitly re-enable MCP to
obtain the pin. Discovery fails closed until then; old immutable package release
notes referring to full access describe the original Host integration, not this
new Host's policy. Legacy non-panel DTO key sets remain unchanged.

## Validation

Evidence and results are recorded after execution; this document alone is not
proof of runtime acceptance. No installed application or production Host is
changed, restarted or stopped by the test work.

Executed on the final implementation:

- WZU_Server: 167 Host-app, 15 plugin-data, 510 Host, 13 MCP and 16 HTTP-server
  tests passed; the native wire producer plus unchanged JS consumer passed
  (13 Host replies, one shared DTO, 11 endpoints, two error replies). Original
  opt-in ignored cases were not enabled or reclassified as successful.
- Strict all-target Clippy passed for all three affected crates. All 63 existing
  business-error compiler mutations and both managed unsafe mutations rejected
  the injected violations, restored exact original bytes, and passed the positive
  compiler check. The guard source stage matched all 5,306 bound repository files.
- Local owned UI typecheck, production assembly/verification, 50 plugin/retention
  regressions, both Chromium/WebKit opaque bridge tests, and 34 architecture
  mutation tests passed. Existing foreign-browser approval assertions stayed
  unchanged: the first broad metadata exemption was narrowed to UI plugins.
- A fresh loopback-only V100 fixture installed the unchanged archive
  `ed0879f7548b1ce7e7a4920f2b89a0d55fbac0e70ffa365a52d9d983a749e22d`,
  with Skill/MCP initially disabled and the expected static tool pin present.
  After explicit test-only MCP enablement, Chromium opened in workspace-write
  and WebKit opened in workspace-write-ai-review, never full access. Both actual
  WASM editors accepted Unicode edits, rejected hidden operations after the
  visibility acknowledgement, preserved the editor across ordinary preset
  changes, and saved DOCX through the production save bridge. Four saved ZIP/XML
  files retained Unicode/table content and excluded the rejected hidden marker.
- Browsers mounted the production React panel, not the entire installed App.
  Actual HTML/CSP/JS, RPC, Node server, document reads/writes and capabilities used
  the isolated remote Host. Only the already hash-verified public WASM was streamed
  locally to avoid measuring a slow SSH file transfer. This is functional
  acceptance, not a fresh memory benchmark or an end-to-end AI reviewer test:
  the fixture's explicit MCP endpoint has no model/approval provider. The real
  gateway approval/denial/cancellation/monotonicity tests cover that separate seam.

The owned fixture exited after verification; the production Host retained its
original November 4 start time. Evidence lives in the task's
`outputs/wordcraft-permissions-20261110/` directory. No package/lockfile/version,
GitHub protection, system prompt, installed application or production Host was
modified by the acceptance runs.
