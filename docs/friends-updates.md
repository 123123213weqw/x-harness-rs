# Optional small-group Windows updates

This workflow reuses the existing Tauri updater for a small Windows x64 group.
It signs update packages but does not buy or configure Windows Authenticode
certificates. SmartScreen/unknown-publisher prompts may remain. Do not disable
system protections. This is not the multi-platform production release workflow.

## Explicit maintainer opt-in

The workflow is disabled unless repository variable
`XHARNESS_FRIENDS_RELEASE_REPOSITORY` exactly equals that repository's `owner/name`.
For upstream this value would be `123123213weqw/x-harness-rs`; a fork must use its
own identity. Both the Actions job and the Python release helper enforce this.
Merging this code or opening a PR does not configure or publish a release.

Maintainers must separately provision repository-owned Secrets:

- `XHARNESS_FRIENDS_PRIVATE_KEY`
- `XHARNESS_FRIENDS_PASSWORD`
- `XHARNESS_FRIENDS_PUBLIC_KEY`

Generate and securely back up the key pair with the Tauri signer. Keep the private
key/password out of Git, logs, artifacts and release attachments. Do not copy a
contributor's personal signing key into upstream. Losing the key normally requires
users to manually install a new trusted bootstrap. Model API keys are unrelated
and never belong in the application distribution.

## Channel ownership and publishing

The channel uses the publishing repository's
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json` endpoint.
It must own that repository's latest release pointer: do not simultaneously point
this workflow and a different-key production channel at the same latest URL.
The existing `desktop-v*` production release workflow is unchanged. Maintainers
must choose their channel/signing policy before opting in; this PR does not make
that operational decision for them.

After reviewing the source, push a new `friends-v<major.minor.patch>` tag to the
publishing repository. Ordinary branch pushes do not publish. The Windows job
runs Host/desktop tests, builds the pinned native sidecars, projects the version
and public key into the bundler, builds/signs NSIS, independently verifies the
signatures, and uploads all assets to a Draft before making it public/latest.
Published or draft versions cannot be overwritten. Versions must increase.

The first target must have patch >= 1 and includes a bootstrap with patch minus
one (for example 0.2.0 and 0.2.1). Both come from the same reviewed source and use
the same rolling endpoint/key. Later releases build only the target. A failed
Draft remains private; inspect it and use a new version rather than overwriting.

The manifest maps `windows-x86_64` to an immutable versioned installer URL and its
signature. Asset hashes and the public key are included for independent checks.
No unsigned-update bypass or forced installation is introduced.

## Users and migration

Users install an enabled base package once. The existing desktop updater checks
on startup/periodically, downloads and verifies, then waits for confirmation to
stop the Host and install. Existing state remains in the application's user-data
directory. GitHub and its release asset endpoints must be reachable over HTTPS.

Submitting the implementation upstream does not change installed fork clients'
embedded URL/public key. A move to an independently keyed upstream channel needs
an explicit migration/base installer. Do not silently redirect an old feed to
packages those clients cannot verify.

Windows and macOS can share an aggregate manifest, but this workflow currently
builds Windows only. Adding macOS, deciding platform signing/notarization, and
coordinating all platform uploads before publication remain separate work.

## Verification

Run `python3 -B scripts/test-friends-release.py` without secrets for identity,
version, immutable-manifest and workflow guards; ordinary PR CI includes it.
Existing updater UI/signature regression tests remain unchanged. Local Rust
compilation is prohibited by AGENTS.md; use CI for native tests/builds.

The original fork-specific workflow passed Windows build/signature validation in
[run 33967511179](https://github.com/yyqdbngt/x-harness-rs/actions/runs/33967511179).
Its public installers were independently verified and the base installer preserved
local state. That is prior implementation evidence, not proof of an upstream
release or a completed native in-app restart upgrade. The generalized workflow
requires its own maintainer-authorized release acceptance after opt-in.
