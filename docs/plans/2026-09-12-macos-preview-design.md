# Explicit unnotarized macOS distribution

The user accepts unnotarized macOS distribution for a small group. This changes
distribution requirements, not the installed application version or OS security
settings. Existing Windows/Linux 0.2.18 assets and installations remain untouched.

## Decision

Reuse the unified immutable release pipeline with an explicit third release scope,
`all-macos-preview`. Default `all` still requires Developer ID, notarization and
Gatekeeper acceptance. `windows-linux` is unchanged. The new scope selects the
same four native targets as `all`, but marks the Mac packages as ad-hoc signed,
unnotarized previews. This avoids duplicating the updater and publishing a second
mutable feed; deleting the Apple checks globally would silently weaken defaults.

The selected scope is already bound into the plan, receipts, candidate digest and
native acceptance. Add a corresponding manifest policy and clear release notes.
The shared GitHub release remains a normal desktop release so existing Windows/
Linux clients can use the canonical latest feed; its Mac components are explicitly
previews, not Apple-notarized applications. This is not a separate GitHub prerelease.

## Boundaries

- Existing updater signing keys, HTTPS verification and explicit install confirmation
  remain mandatory. No Apple credentials are needed or passed to preview builds.
- Ad-hoc code signing is verified before packaging acceptance and after installation.
  Never label skipped Gatekeeper/notarization checks as passing.
- Native update/restart/state-preservation and corrupt-download tests remain required
  for both Mac architectures. CI rehearsals also exercise the ad-hoc verifier.
- An existing Mac feed without the explicit preview marker is treated as notarized;
  promotion to preview is rejected. The current feed has no Mac entries, so initial
  preview enrollment requires a voluntary download, not an automatic downgrade.
- Switching back to notarized builds is allowed; future preview downgrades then fail.
- No `spctl --master-disable`, quarantine removal or other host security bypass.
- Initial Gatekeeper approval is a manual user action outside CI. Managed Macs may
  prohibit it. Native launch tests do not prove a browser download opens warning-free.

## Delivery

Implement and submit an upstream PR with Python/Node contract tests and existing
native CI. Publishing new Mac packages is a subsequent release using a new version
and the explicit scope; never modify the immutable 0.2.18 release.
