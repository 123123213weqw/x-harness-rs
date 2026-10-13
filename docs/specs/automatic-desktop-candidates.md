# Automatic desktop candidates (prepare, never publish)

`master` push → latest exact-SHA `CI` succeeds → `Desktop Candidate Prepare` →
reserve an immutable `desktop-vX.Y.Z` tag → existing `Desktop Release` **on that
tag**, with integrated acceptance → four protected signing/native workers →
complete private draft and receipts → stop at `awaiting_confirmation`.

Targets: Windows x64, Linux x64 AppImage, macOS arm64 and macOS x64. PR/fork runs,
failed/cancelled/skipped gates and obsolete CI attempts cannot prepare candidates.
A master CI cancelled by a newer commit has no green result, hence no candidate.

The controller never invokes `Desktop Promote`, publishes a release, changes the
public `latest.json` or website, or restarts installed apps. Draft assets are not
an update channel; users keep receiving the last **published** stable release.

## Source, version and recovery

- Controls come from trusted master. Authenticate CI through REST and verify the
  trigger SHA is a master ancestor. No PR artifacts, no substitution of current
  HEAD for the trigger SHA, even when master advances while work is queued.
- Version = next patch after the highest canonical desktop/friends release or
  reserved desktop tag, including drafts/failed builds. Gaps are expected. Failed
  version numbers, drafts and tags are never reused/deleted/overwritten.
- Tag allocation and dispatch upload write-ahead checkpoints **before** POST.
  Lost replies reconcile the same intent by GET. Only a confirmed tag conflict
  can pick another version, within a bounded budget. An uncertain POST with no
  visible result stops for same-run recovery, never blind redispatch.
- Immutable tag dispatch makes checkout, workflow SHA, signed bytes, plan and
  receipts identify the same source. Only the build workflow allows this mode;
  tags must resolve to commits in master ancestry. All four native workers must
  pass; a successful aggregator alone is not acceptance.
- Per-tag candidate locks are separate from the serialized stable publication
  lock. A controller rerun restores its run-bound journal before doing anything.

## Policy and retention

Reuse `XHARNESS_FRIENDS_RELEASE_REPOSITORY` and existing protected signing
environments. `XHARNESS_DESKTOP_TAG_RELEASE_SCOPE` selects `all-macos-preview`
(existing default, ad-hoc/unnotarized), `all-macos-selfsigned` (fixed protected
publisher), or `all` (Apple Developer ID/notarization required). Automatic mode
rejects `windows-linux`; missing credentials never silently drop platforms.

The controller has no updater/Apple private keys. Only existing protected signing
workers receive them. Automatic build artifacts/journals: **14 days**; manual
release artifacts: 90 days; small ready pointers: 30 days. Expired evidence is an
error, not authorization to rebuild or trust caches. Draft cleanup is not automatic.

## Publish an accepted candidate, without rebuilding

The successful controller summary gives the reserved version and **Desktop
Release build run id** (not the controller/CI id). Substitute those exact values:

```sh
python3 -B scripts/release.py VERSION --repo 123123213weqw/x-harness-rs \
  --candidate-run-id BUILD_RUN_ID --confirm-publish VERSION
```

This entry authenticates the successful build and immutable plan, adopts that
run, and dispatches **only Desktop Promote**. The same run supplies integrated
Unix/Windows evidence. No compilation, version changes, re-signing or second
Desktop Release. Resume the same version task after transport errors.
Without `--confirm-publish`, stop for confirmation. `--retry`, `--pipeline` and
`--hosted` cannot be mixed with this promotion-only entry.

The promoter freshly verifies latest CI, signatures, unchanged draft/bytes,
native receipts and live channel. Older source cannot roll code backwards just
because its reserved version is higher. If another publication changed the
Windows stable base since the one-hop test, select a freshly accepted candidate
against that base; there is **no hidden rebuild or acceptance bypass**.

Legacy new-build release remains available. For ready candidates, use the reuse
entry, not a second build with an already-reserved version.

## Validation

```sh
python3 -B scripts/test-desktop-candidates.py
python3 -B scripts/test-release-orchestrator.py
python3 -B scripts/test-release-service.py
python3 -B scripts/test-desktop-release-build.py
python3 -B scripts/test-unified-desktop-release.py
node scripts/test-desktop-windows-acceptance.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/desktop-candidates.yml \
  .github/workflows/desktop-release.yml .github/workflows/ci.yml
```

Offline cases cover authentication, source movement, version races, lost replies,
restore, preparation-only enforcement, tag provenance, four-platform gates,
signing policy, stale base rejection and promotion-only reuse. They do not replace
the first real four-platform signed candidate run after this feature reaches master.
