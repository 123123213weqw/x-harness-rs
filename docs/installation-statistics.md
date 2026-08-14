# Optional installation statistics

Architecture review: `xharness-installation` is an isolated leaf crate (no internal
crate dependencies). The architecture baseline adds only this leaf, not new Host
edges. Filesystem and HTTPS delivery stay in the existing desktop adapter.

The desktop installation outbox is a pure crate with no Host or Agent dependency.
The Tauri shell owns disk storage, consent and delivery. The website owns a separate
metadata table; no account, wallet, or provider privilege is granted by a report.

## Counting contract

- Disabled by default. Enabling explicitly generates a random installation UUID
  and 256-bit credential. No hardware identifier or fingerprint is read.
- An installation is counted after its first accepted startup/report, not when a
  package is downloaded or the registration endpoint is called.
- Activity is server receipt time (rolling 24 hours / 7 days / 30 days). Offline
  reports arrive later; this is approximate activity, not a user's exact schedule.
- An installation is not a person: reinstalls/new opt-ins can create a new ID,
  copied app-data can share one. Desktop account linking is not implemented yet.
- Versions and events are untrusted self-reports, not authenticated attestation.
- Installation-start is pending. Only a later launch of the exact target version,
  with Host successfully started, generates update-confirmed. Old-version launch
  is unconfirmed; lack of a report is unknown, never an automatic failed update.
- Current/outdated compares semantic versions against an operator-configured
  platform/architecture/channel target. No configured target means unknown.

## Reliability and privacy

The owner-only outbox contains at most 64 events and sends batches of 16. It is
atomically persisted before acknowledgments remove events. One worker serializes
registration, reporting, and deletion. Timeouts are 8 seconds; bounded exponential
backoff with jitter reaches at most one attempt per hour. Heartbeats are at most
once per 24 hours. Long offline queues evict oldest events (preferring heartbeats /
startups); totals are approximate, not billing records. No network await is in
startup or the update/install IPC path.

If closing statistics cannot be persisted, in-memory reporting still stops, the UI
explicitly warns that restart may restore the old preference, and offers a retry.
Deletion/acknowledgment persistence failures also back off rather than spinning.

Closing statistics clears queued report payloads and pending update tracking. Only
a deletion credential is retained until deletion is acknowledged. It is impossible
to re-enable while deletion is pending. The server removes the device and all its
events in a transaction and retains only an irreversible denial receipt for 90
days, preventing a late enrollment request from resurrecting removed metadata.
Raw events expire after 90 days; 365-day inactive installations expire. Reports
contain no timestamps supplied by the client, text, pictures, keys, file paths,
account names, hardware IDs or arbitrary failure strings. Secrets are hashed server
side and never returned to the settings/admin UI. IP is used only for in-memory
admission/rate limiting, not recorded in installation tables. Ingress infrastructure
access-log policy must also be reviewed before enabling public ingestion.

## Activation

Build desktop with `XHARNESS_INSTALLATION_ENDPOINT=https://engine.xxdevs.com`
(or an approved HTTPS origin). It is immutable at build time; redirects are not
followed and guest WebViews have no statistics IPC capability. The release workflow
reads repository variable `XHARNESS_INSTALLATION_ENDPOINT`; leave it empty until
server ingestion is deployed and accepted. Ordinary Web pages never register as
installed apps. The feature remains opt-in even in configured release builds.

The server/private dashboard must be deployed separately. Updating the source or
passing Linux CI does not install a new app, enable public administration, or prove
macOS/Windows runtime behavior.

## First-run choice (prototype only — not enabled)

The first-run dialog was deferred by product decision. The Experience plugin does
not register this onboarding step in the production UI. The isolated preview and
its tests are retained for reference; existing statistics remain off by default
and can only be explicitly enabled in Settings. The description below documents
prototype behavior, not an active production prompt.


The existing `settings.onboarding` coordinator mounts the small, bilingual consent
card on a ready blank/new-session screen. It does not interrupt an active conversation
or add a separate root/Host service. Native readiness checks skip ordinary Web, old
native DTOs, unconfigured builds, corrupt storage, existing opt-ins and pending deletion.

Both buttons (including Escape/mask dismissal as a decline) persist the choice in
the native atomic outbox before the card completes. Notice version, decision and
UTC epoch seconds are local-only and never sent to the service. Legacy files missing
this field still load. Known opt-outs are not reprompted when copy changes; expansion
of collection scope must implement explicit re-consent instead of reusing this notice.
Persistence failure remains visible with a retry; duplicate clicks cannot double-submit.

`node scripts/preview-installation-consent.mjs` serves an isolated loopback visual
preview at port 3191. It reuses the actual card and native-top-layer Modal primitive,
but provides no native bridge, backend requests, identity or saved consent. Its language
and theme controls appear only after dismissing the card, and remain preview-only.
Direct variants use `?lang=en` and `?theme=dark`. The card initially shows one
sentence, two choices and one “Learn more” disclosure containing the full current
collection/privacy/retention notice. This copy change does not authorize new fields.
