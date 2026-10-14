# Global and workspace memory

## Ownership and activation

`AGENTS.md` contains project instructions. Memory contains fallible,
reusable facts; it is not a Goal, permission source, user-message transcript, or
an extension of the question-answer sink removed in #291. Old managed AGENTS
blocks are not imported.

Native composition configures `<state_dir>/memory/` with two independent scopes:

- `global/`: preferences and durable facts shared by all workspaces and models
  in the **same local app profile**. It can be edited before any workspace exists.
- `<sha256(canonical cwd)>/`: verified project facts for exactly that canonical
  workspace. Existing workspace storage paths are unchanged.

Each scope stores `MEMORY.md` and a small `settings.json`. No provider/model/session
ID participates in the directory key. Sessions sharing a canonical cwd share
workspace notes; other directories do not. Embedding Hosts opt in with
`HostConfig.memory_dir`. This is not account binding or per-account isolation:
Hosts using the same app state directory share the same global notes.
Files are local app data, not workspace files and not automatically committed.
They are not encrypted or synchronized between machines.

Each scope has its own mode:

- **Manual (default):** the model is instructed to save only after an explicit
  user request to remember a durable fact. Ordinary task/question answers do not
  authorize persistence.
- **Auto (opt in in Settings):** the model may curate verified reusable facts at
  useful milestones. No extra model request, background writer, post-turn
  extractor or unconditional append runs. A model may skip curation. This is
  behavioral guidance, not a deterministic natural-language authorization gate.
- **Off:** the virtual file capability rejects new reads and writes, including
  calls from existing executors. This does not retract an existing model request,
  interrupt an already admitted file operation, or restrict a full-access shell.

A generic “remember this” request defaults to workspace memory. Global writes
require an explicit cross-workspace request, or global auto mode plus a clearly
general reusable fact. Project-specific facts are never automatically promoted
to global. An off/unavailable scope must not be copied into another scope or a
project fallback file. Current user instructions and `AGENTS.md` take precedence
over both scopes; verified workspace-specific facts take precedence over general
defaults within that workspace only.

## Prompt and file capability

The Host injects at most 2,048 UTF-8 bytes / 24 lines from the top of **each**
document (at most 4,096 bytes of note data in total), as explicitly quoted advisory
data. One shared maintenance policy is followed by the global and workspace
indices and their independent modes. Each `MEMORY.md` is limited to 64 KiB.
The full bodies remain available on demand.
Optional corrupt/unavailable memory produces an explicit unavailable policy; it
never blocks the entire turn or silently masquerades as an empty document.
Loading runs outside the global Host state lock, with four owned I/O slots and a
five-second soft deadline. Global and workspace loads run concurrently through
the same slot pool. A timed-out worker retains its slot until it settles.

All actual entry points (ordinary turns, Goal continuations, automation) use the
same prompt assembly. A Loop pins one assembly across tool steps and retries;
newly admitted turns refresh it. This does not introduce a separate cross-process
recovery snapshot protocol. Historical request snapshots retain the policy and
index actually used at that time.

The existing `read`, `edit`, and `write` tools accept the **exact** virtual path
`memory://MEMORY.md` (workspace) or `memory://global/MEMORY.md` (global).
No new model tool is registered and no broad app-data read root is granted.
Native composition requires a valid bound session for both capabilities, resolves
workspace notes from its cwd, and rechecks the selected scope's live mode on every
call. The two scopes retain separate file observation ledgers, including when
calls alternate between them. Other memory URIs, settings access, and
cross-workspace/traversal forms fail closed. Image sniffing cannot intercept
these URIs. Normal workspace paths retain their previous resolution and policy.

The deployment-owned file mount is generic; Coding Tools does not depend on Host
or know the memory storage layout. It reuses FsService regular-file/no-follow
reads, pagination, actor observations, atomic writes, and stale-version checks.
Prompt/UI previews do not grant the model an observation for later edits. Existing
approval/tool lifecycle semantics remain in place. Full read-before-replacement
and preserving unseen notes are model policies (as for existing coding files).

## Settings and persistence

Settings → Memory defaults to **Global memory**, with a second **Workspace memory**
tab. Global editing does not depend on workspace/session creation or the workspace
list RPC. Both tabs have bilingual modes, an editor, reload, save and confirmed
clear; the workspace selector appears only in the workspace tab. Scope/workspace
drafts survive switching and failed CAS; late responses update only their original
scope. Clear writes an empty file in the selected scope; it does not clear other
scopes, chat history or previously captured request snapshots.

The UI-only dynamic endpoint `workspace/memory` accepts exactly one known
`workspaceId` or `sessionId` for workspace memory (the existing payload stays
compatible), or `scope: "global"` with **no** workspace/session selector. Unknown
scopes, mixed selectors and arbitrary cwd/host paths are rejected. Actions are
`view`, `save`, `clear`, and `configure`. Mutations require the observed document
or settings version (null for absent), reject stale conflicting writes, and use
normal control-log RPC receipts. Receipt fingerprints include the scope so an ID
cannot be reused to change the target. Receipts persist method, payload fingerprint and
resulting version only, not the notes or body. The receipt is not a second memory
store. This UI endpoint omits request/response bodies from RPC debug logs;
normal model request/tool history may still record the index or notes actually
used, just as other file reads do. File publication and receipt durability are separate transactions: after a
lost acknowledgment, identical desired content can recover; changed content is
never blindly overwritten. UI cancellation may race an already admitted save;
reload after any unconfirmed result.

Unsafe links/nonregular files are rejected. Oversized/invalid UTF-8 notes show a
repair warning and cannot be silently overwritten by the editor; clear remains
available with version confirmation. Corrupt settings can be replaced through
the mode selector. The user should back up any damaged file before clearing.

## Verification boundaries

Automated coverage exercises real Host/Loop/file services and native tool-factory
composition with a scripted provider, plus Chromium/WebKit UI tests with scripted
RPC. These are not paid DeepSeek evaluations, native macOS GUI acceptance, or a
promise that every model will choose appropriate memories. No new dependency on
another model or model-specific extraction logic is introduced.
