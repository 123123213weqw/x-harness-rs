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

### Non-disruptive handoff to upstream maintenance

The requested policy is upstream-owned future code/releases, without forcibly
changing existing installations. Keep the fork feed, published artifacts and old
verification key available during the transition. Do not replace the old manifest
with an unrelated-key upstream package, delete old releases, share private signing
keys, or switch installed clients merely because this PR is merged.

Before inviting users to migrate, upstream maintainers must choose one release
channel, configure their own signing material, and publish a compatible base
installer. A newer source tree alone is not a migration artifact. The installer
must include the shared model settings implementation (merged #21 or equivalent),
retain application identifier `com.xlang.xharness`, and preserve the actual user
state/config/workspace locations and persisted formats. Verify compatibility with
the latest installed fork build; do not rely on an older test release or assume
that a lower upstream version is a valid upgrade.

For the initial small-group handoff, use an explicitly chosen one-time installation
of the verified upstream base. After that, its embedded upstream endpoint/public
key handle future updates. A bridge delivered through the old updater is a possible
later implementation: it must be deliberately signed by the old channel owner and
reviewed as a trust change. No bridge publisher or automatic trust migration is
implemented by this PR.

Per-platform acceptance before rollout:

1. Record the currently resolved application data paths and versions. Back up
   persisted state/configuration and workspace data locally; never include these
   backups or model keys in CI artifacts. Retain the previous installer.
2. Finish or explicitly stop active Agent turns and background commands, then
   close the old application before installing. Do not run two Hosts against the
   same state directory. Installing an update entails a short interruption; it
   does not guarantee restoration of external command side effects.
3. Confirm session history, provider profiles, model selection and workspace
   locations after installation. Credential-store identity is derived from the
   canonical state directory: changing that location can make saved model keys
   unavailable even if the profile JSON was copied. Preserve it and verify a model
   call under the same OS account; do not export keys to plaintext to work around
   failures. macOS keychain access prompts/permissions need separate verification.
4. Check the actual upstream feed, package signature, download and restart path
   on Windows and each supported Mac architecture. Keep OS trust/notarization
   prompts distinct from updater signature validation. A Windows build does not
   validate Mac installation or an aggregate manifest.
5. If migration fails, stop the new process and use the retained installer plus
   pre-migration state backup as needed. Do not downgrade a state directory that
   has undergone an incompatible format migration without restoring its backup.

Until this acceptance is complete, leave existing users on the original channel.
Submitting this checklist is not evidence that any installed client has migrated.

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
