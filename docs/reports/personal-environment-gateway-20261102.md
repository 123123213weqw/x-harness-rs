# Personal environment connection MVP: 2026-11-02 acceptance

## Scope (not a handoff completion report)

Opt-in macOS/Linux independent-environment connections, not synchronized
workspaces or native session migration. No installed application replacement,
production Host restart, model/keychain permission change, dependency upgrade,
public listener or execution-permit change was performed.

The native Mac edge used the already installed signed Host executable with a
new disposable state/workspace. The Linux edge used a remotely built native
Host with another disposable state/workspace. A loopback-only Linux Gateway
connected to both through verified SSH forwarding for this acceptance. The
Mac edge intentionally had no model credential in its new state; **Mac model
execution is not claimed by this report**.
An existing authorized DeepSeek environment was reused on its owning server;
no model credential was brought to the Mac or browser.

Additional native Mac acceptance downloaded only the arm64 Gateway artifact
from CI run `41399615144`, source head `fc5909b2e891b7c7717c1993414aee77a0801cc8`.
The archive SHA-256 matched GitHub's artifact digest. This executable booted a
temporary loopback-only Mac Gateway against the isolated Mac Host: the real
production UI loaded its `local-workspace`, and authenticated catalogue and
fresh-identity readiness requests returned HTTP 200. Local showed no Cloud
strip. The temporary Gateway was then shut down without stopping either Host.
This adds native Mac carrier boot acceptance, not Mac model or Cloud handoff
acceptance. No Rust compilation occurred on the Mac.

## Real browser/model/tool evidence

- The real production Web bundle booted against both actual native Hosts; HTTP
  and both native downlinks passed their connection handshake.
- Selecting Cloud opened the registered separate origin, not a fake transport
  or a mutable global API URL. Selecting Local opened Local separately. The
  unsent Cloud draft stayed byte-for-byte in the original conversation.
- Local had no lower Cloud strip. Cloud displayed the real generation-scoped
  connected/unavailable state, plus an explicit independent-workspace/no-sync/
  no-session-transfer notice. Neither UI nor API claimed a takeover.
- Real DeepSeek created `handoff-smoke.txt`, read it using the native tools and
  reported the actual Linux working directory. Only the test's one-time tool
  approvals were answered; no permission preset was widened.
- Independently read server-side bytes: 29 bytes, contents after trailing
  newline removal `CLOUD_HANDOFF_SMOKE_20261102`, SHA-256
  `3abf63181ac131c21a30458865ec3e7702f88c64aeebfa81976200db45dbd1bd`.
  The Mac test workspace did not acquire this file: this proves routing and
  isolation, **not synchronization**.
- Stopping only the test Gateway changed the existing Cloud status to
  unavailable while both native Hosts remained Ready. After Gateway restart,
  the same page reconnected and retained its draft. The native session journal
  hashes were exactly unchanged across this transport restart (before any
  deliberate next prompt), so no model/tool/prompt was replayed by reconnection.
- A deliberate second prompt in the reloaded/reconnected original Cloud
  session recalled the prior tool result and returned the exact marker above.
  This tests continuation within one environment, not cross-environment transfer.

A missing ID on two list-slot registrations was caught by the real browser,
fixed using stable slot IDs, and added to the registration regression assertions.
Expected browser closes were also distinguished from carrier failures so a
normal tab close does not produce false failure records.

## Automated evidence

- Production UI source tests: 11 passed, including all 120 original fail-closed
  composer/history combinations; catalogue origin/shape/secret-field confusion
  and failed-popup/forged-selection cases are rejected.
- Strict owned TypeScript, production UI assembly (61 modules / 190 assets),
  provenance/hash verification and formatting passed.
- Architecture checker/freeze passed; 34 architecture mutation tests and 10 CI
  tiering tests passed. A reviewed change record enrolls the new composition
  seam without weakening existing business/unsafe-code guards.
- WZU_Server affected Host App + Server `--all-targets`: 413 passed, 9 explicitly
  ignored live/platform fixtures; ignored fixtures are not counted as live success.
- Final edited transport/identity scope rechecked separately: 4 Gateway HTTP/WS/
  shutdown/configuration tests and 11 Server transport tests passed; original
  typed-cause preservation/redacted formatting has its own passing unit test.
- Strict remote Clippy passed. The actual remote compiler-negative mutation
  receipt includes the Gateway business seam and restored-source positive
  compilation. No Rust compilation/check/test occurred on the Mac.

This report does not claim GitHub CI completion, Windows Gateway support,
Mac model acceptance, workspace sync, native bundle portability, active-task
migration, distributed execution ownership, merge or release. See the runbook's
remaining handoff work before enabling any such capability.

## First CI feedback and correction

The first browser/parity CI run correctly rejected direct `/api/environments`
discovery inside the presentation plugin: isolated fixture carriers must never
contact a real Host. Discovery was moved into an optional Connection capability,
installed only by the production wire root. Fixture roots do not install it;
presentation without that capability performs zero network discovery. Existing
fixture-isolation and pixel-parity assertions were not relaxed. A dedicated
source regression covers the absent-capability path.

The first macOS job failed before Rust execution in its unchanged locked npm
install (`Exit handler never called`). No dependency/runtime/action upgrade or
lockfile refresh was used as a workaround. A fresh CI attempt passed that install,
the full macOS workspace tests and strict Clippy, and retained the Mac artifact
used above. Both committed and rebuilt strict pixel parity and all eight browser
shards passed on that attempt.

A remaining UI contract rejected the runtime-environment plugin's new Connection
dependency because its independent reviewed ABI registry still listed the old
two dependencies. The registry now pins exactly the new three-dependency ABI;
the immutable master reference and strict equality assertions are unchanged.
Additional runtime-plugin mutations reject missing/extra/reordered dependencies,
source/kind changes, removal and eager boot. The aggregate layout gate correctly
remained failed until its prerequisite contract was corrected; no gate was
skipped or changed to accept failed prerequisites. Final-head CI is still required.
