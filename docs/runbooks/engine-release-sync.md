# Desktop Release → Engine download/update projection

`Sync desktop releases to engine` connects the existing **public accepted-release**
pipeline to <https://engine.xxdevs.com>. It does not build main, deploy Rust/source,
execute installers, update installed applications, change XS configuration or
restart any shared service. Browser/desktop feature work and plugin distribution
remain separate.

## What activates it

1. A successful trusted `Desktop Promote` workflow completion. This is required
   because publication using `GITHUB_TOKEN` does **not** trigger another
   `release.published` workflow.
2. An independently published formal `desktop-vX.Y.Z` release.
3. Reconciliation at `:07`/`:37` (GitHub scheduling may be delayed).
4. Manual dispatch on **master**; `dry_run` defaults to **true**.

All paths resolve the actual GitHub **latest stable desktop** release, not a tag
provided in an event payload. A stale event cannot regress the website. A draft,
prerelease, incomplete upload, changed candidate, missing/expired native promotion
proof or unsupported signing-policy migration fails closed. Triggered code is
checked out from trusted master, never a release tag/artifact or fork. PR runs have
no publication step or secrets. Publication is serialized without cancellation.

## Acceptance and trust

The projector reuses `desktop-release.py` and `desktop-release-build.py`:

- Check the original asset inventory, API asset identity/size/digest, exact source
  plan, immutable package URLs, pinned updater public key and receipt hashes.
- Require the authenticated successful **current attempt** of Desktop Promote,
  its exact published release snapshot, `promotion-authorized` record and native
  acceptance hashes. Recheck candidate and all native workflow run attempts/jobs;
  a candidate's `candidate-verified-not-native-accepted` evidence is not enough.
- Download the four selected installers and independently verify original updater
  signatures. Keep original installer and `.sig` bytes unchanged.
- Fetch `LICENSE` and `THIRD_PARTY_NOTICES.md` only at the immutable source SHA.
- Exclude `windows-debug-symbols.zip`. Its original checksum/API entry is kept in
  the receipt but its body is **not verified or mirrored**. The selected inventory
  is validated by the unchanged public release contract after each included file
  was first checked against the original inventory.
- Rewrite **only** package URLs into immutable domain release paths. Sign the
  resulting feed with the existing installed-trust Tauri updater key. Do not rotate
  the updater key, alter platform coverage, label an unnotarized Mac as notarized,
  strip a certificate pin, or manufacture new native acceptance.

Current receiver v1 accepts normal notarized distribution (no preview field) and
`ad-hoc-unnotarized-preview`. A future `self-signed-unnotarized-preview` release
requires explicitly upgrading/testing the private receiver's schema and policy
continuity gate first. Synchronization deliberately rejects it today rather than
silently removing `macos_signing_fingerprint`.

The old one-time **0.2.32 bootstrap** has no detached feed signature. Only its exact
frozen manifest SHA256
`98443c93fcd94e8c9b161bdbfaa29abe2cc930c59073c7b402e8834ad83689d5`
is an unsigned anchor exception. It cannot authorize another unsigned version.
All newly projected feeds and installer packages must verify against packet pin
`3ec1f86a3e8aa53e94ad3708b6b40222a08e69ac1c80ee1eaa5c24cbb4ffd83a`.

## Repository configuration

- Variable `XHARNESS_ENGINE_RELEASE_SYNC_ENABLED=true` activates non-PR runs.
  Set false to stop future synchronization; it does not undo published versions.
- Existing `XHARNESS_FRIENDS_PRIVATE_KEY` / `XHARNESS_FRIENDS_PASSWORD` sign the feed
  using pinned prebuilt `@tauri-apps/cli@2.11.4` **signer only**, not `tauri build`.
- New `XHARNESS_ENGINE_RELEASE_SSH_KEY`: a dedicated installer publisher key.
  Never reuse the plugins-only publisher or a general admin key.
- New `XHARNESS_ENGINE_RELEASE_KNOWN_HOSTS`: Engine SSH host keys verified through
  the existing trusted administration connection, not untrusted `ssh-keyscan`.

The Engine authorized key must have `restrict` and its existing fixed distribution
receiver command, with its private state and binary store outside/at their already
configured paths. No Shell, SCP, PTY, arbitrary destination, agent/port forwarding
or source checkout. The runner directly connects to the fixed Engine SSH endpoint;
if the runner route becomes unavailable, report it rather than opening a new port,
disabling host checks or copying a broad bastion login credential into Actions.

Revoke by deleting only this dedicated authorized-key entry and these two Secrets;
retain the plugin publisher, existing installer keys and updater signing key. No
service restart is necessary to install/revoke an SSH authorized key.

## Testing and publication

Offline (Python 3.12+/Node 22/curl; no Rust compilation):

```sh
python3 -B scripts/test-engine-release-sync.py
node scripts/test-updater-signature.mjs
```

Real public-material dry-run (writes a new local evidence directory, never reads
private signing/SSH keys and never changes the website):

```sh
python3 -B scripts/engine-release-sync.py prepare --work dist/engine-sync
```

A new-release dry-run reports `prepared-unsigned-not-published`, **not deployed**.
The audit records source snapshot, original checksums, native promotion and export
hashes. A same-version reconcile verifies the signed public feed, catalog and
installer HEAD sizes, skips installer downloads/signing/SSH and reports
`already-current-metadata-verified`. This cheap reconcile is not a full payload
re-audit; manual `smoke` with a retained sealed workspace rehashes all bodies.

After contracts/CI pass, dispatch `dry_run=false`. The workflow prepares, signs,
seals a deterministic flat tar and calls only:

```text
publish v1 <expected-live-feed-sha256> <upload-sha256>
```

The **existing private receiver** independently validates inventory, signatures,
trust, quotas, version/platform/policy continuity and CAS before immutable version
publication. No proprietary receiver code is copied into this public repository.

Post-publication acceptance fetches the signed feed, catalog, all installer bodies
and export metadata over unauthenticated HTTPS and compares bytes/hashes. Public
curl calls disable curlrc, enforce HTTPS/no redirects, have time/size bounds and
bounded GET/HEAD retries (including TLS alerts/EOF, which curl's plain `--retry`
does not cover). The local system Python HTTPS client returned a TLS alert; one
hosted CI prepare also hit curl exit 35 after an earlier successful dry-run. The
transport root cause is not established by these observations. curl keeps the
HTTPS read-back bounded and diagnostic, without disabling certificate checks. Installer body read-back uses bounded temporary disk, not a full
in-memory buffer.

## Failure semantics

- Before upload, recheck actual GitHub latest/asset snapshot and the live feed CAS
  hash; a raced promotion is retried with a **fresh prepare**, not an old baseline.
- If SSH errors/times out after send, inspect/read back the expected public state.
  A matching fully verified publication is success even without an SSH reply.
  Never blindly resend a possibly completed write.
- Persist `outcome-unverified-inspect-before-retry` if HTTPS cannot establish the
  outcome. The next run may reconcile a completed publication, but it cannot
  overwrite an existing conflicting version/staging directory.
- The server replaces each catalog/feed file atomically and commits the update
  feed **last**; this is **not** one atomic transaction over all files. A power
  loss could leave an immutable/staged version or temporarily newer catalog with
  an old update pointer. Inspect server state; never automatically delete, roll
  back or overwrite a version to hide partial publication.
- A sync failure does not delete/revoke a valid GitHub Release. Scheduled runs
  provide reconciliation; Actions failure notifications/evidence show a blocked
  website update. Native acceptance and releases have their own gates.

Only `audit/` public-material receipts are uploaded as Actions evidence, not
installers, source exports, SSH/signing keys or credential directories.
