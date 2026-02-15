# Workspace directory flow implementation plan

**Goal:** Restore Add workspace in the sidebar and new-conversation picker, including creating a new folder before opening it.

**Architecture:** A product-owned browser plugin fills the existing workspace directory-flow slots and calls the shipped `workspaces.listDirectory/createDirectory` service. The upstream workspace owner continues to register, deduplicate, persist, and select workspaces. The static graph explicitly includes the plugin, instead of relying on the upstream Node host's dynamic directory-picker composition.

**Tech stack:** Existing React/module loader/Modal/Button primitives, shared Rust RPCs, Node contract tests, Playwright Chromium/WebKit, cross-platform Rust CI.

## Accepted design and scope

- Reuse the current shared workspace flow contract; do not upgrade unrelated UI packages or add a native-only picker. Native picking currently returns null in the Rust host; an in-app browser works in Web and all desktop platforms.
- Browse host home, breadcrumbs, folder rows, or an explicitly entered path (including Windows drives and UNC paths). Never construct filesystem paths in JavaScript.
- Create exactly one child folder. Show conflicts and permission/network errors without losing the current directory. Open registers the current directory using the existing workspace owner.
- Cancel aborts reads and invalidates late results. Creation/adoption disables duplicate submission; no claim that an already-sent filesystem mutation can be rolled back.
- Keep the current theme and modal layering; keyboard/IME and narrow-screen operation remain usable.
- No installation replacement, release, existing workspace edits, or user-data migration.

## Task 1: Contract and packaging regression

Create `scripts/test-workspace-directory.mjs`: fail when either slot, source/dist equality, dependency order, or graph/HTML revision is missing. Add `scripts/sync-workspace-directory.mjs` for an idempotent refresh and include the plugin in `scripts/assemble-static-ui.mjs`. Run the test before implementation to prove the missing capability.

## Task 2: Shared directory UI

Create `ui/plugins/@xlang/xharness-client-ui-directory/client.js`. Register Chinese/English copy and both flow occupants. Reuse Modal/Button/icons, add path entry, breadcrumb navigation, hidden-folder toggle, folder creation, loading/error/retry states, and generation/abort guards. Generate the matching `ui/dist` artifacts. Verify with `node --check` and contract tests. Commit the independent feature.

## Task 3: Host path safety and persistence coverage

Update `crates/xharness-host/src/rpc.rs` child-name validation to reject Windows prefixes/aliases and non-single path components without changing POSIX legal names. Extend `crates/xharness-host/tests/basic_host.rs` with directory/create/open/list, Unicode, duplicate, invalid-name, and missing-parent tests. Run `cargo fmt --all --check` locally; Rust compilation/tests run on WZU_Server, or the previously authorized CI fallback when SSH is unavailable. Commit the independent host fix.

## Task 4: Browser and installed-assets regression

Create `scripts/test-workspace-directory-browser.mjs`, using the shipped plugin and upstream workspace flow with isolated RPC fixtures. Test both slots, existing/new paths, failures and retry, duplicate submissions, cancellation/late responses, IME, and small viewports. Capture and inspect a screenshot. Add Chromium/WebKit CI steps and packaged asset assertions for Windows/macOS. Document rebuilding in `ui/README.md`.

## Task 5: Upstream handoff

Run existing UI regressions and new tests, review the complete diff, push atomic commits under `btlqql/workspace-directory-flow`, and submit an upstream PR. Await CI including three-platform Rust and desktop packaging. Report verified results and any remaining limitation; do not merge or install automatically.

## Follow-up: disks and remembered locations

The user approved making non-C drives discoverable without typing paths.

1. Extend `host.listDirectory` without changing its wire shape: omitted path still means home; explicit empty path means a virtual location overview. Windows enumerates assigned drive letters through an audited `GetLogicalDrives` wrapper, without probing every drive or starting a shell. POSIX exposes `/` (and `/Volumes` on macOS). The overview cannot be created in or registered as a workspace.
2. Add persistent-in-dialog location shortcuts and make the overview the first-use landing view. Reuse the shared picker in both entry points. Remember successful navigation in session storage, scoped to the current browser window and host origin, with an in-memory fallback if storage is blocked. An unavailable remembered path falls back to the overview; older hosts without overview support fall back to home. Explicitly entered paths still report their own errors.
3. Test drive switching, overview safety, unavailable drives, stale memory, old-host fallback, storage errors, cancellation races and narrow layouts alongside the existing flow. Keep path construction in Rust, not the UI.
4. Append atomic commits to upstream PR #36, run three-platform CI (the remote compiler is currently unreachable), and refresh only the isolated preview from the verified CI artifact. Preserve preview data and leave the installed App untouched.
