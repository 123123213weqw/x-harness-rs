# Opt-in fixed local Keychain helper

This is for a Mac using a persistent local self-signed XHarness certificate. It is not Developer ID signing, notarization, a plaintext credential store, or a promise that all macOS security prompts disappear.

## Why a fixed certificate alone was insufficient

The affected modern login Keychain items had both a trusted-application requirement and a partition list. The Host's certificate-based requirement stayed valid, but the partition list contained per-build `cdhash:` entries. A new Host build could therefore require authorization again for each credential. Apple describes the independent checks in [this DTS answer](https://developer.apple.com/forums/thread/845980); the published [client identification implementation](https://github.com/apple-oss-distributions/Security/blob/main/securityd/src/clientid.cpp) classifies non-Apple/non-Developer-ID signed clients by code hash.

The helper is installed **once**, outside the replaceable `.app`, at:

```
<state>/credential-helper/v1/xharness-keychain-helper
<state>/local-keychain-helper.json
```

Normal app updates leave this executable and its code hash untouched. The Host authenticates the helper's exact bytes and certificate. The helper dynamically authenticates its **direct parent Host process**, accepting only `xharness-host` or `com.xlang.xharness.host` signed with the helper's own leaf certificate. Another program cannot gain access merely by invoking the helper with the right arguments.

## Setup and first authorization

After the helper source and macOS Host integration have passed review/CI:

```sh
python3 -B scripts/macos-keychain-helper.py \
  --state "$HOME/Library/Application Support/com.xlang.xharness/state" \
  --identity LOWERCASE_EXISTING_LOCAL_CERT_SHA1
```

The command builds only the small native C helper, never Rust. It validates the installed Host identity, creates private directories/executable/pins, and does **not** read, export, delete or rewrite existing credentials or their ACLs. It reuses a previously installed identical helper unchanged; changed helper source/pins require explicit versioned migration rather than silent re-signing.

The new signed Host also provides an explicit maintenance mode before any runtime/server/lease/startup receipts are initialized:

```sh
/path/to/new/signed/xharness-host --authorize-local-keychain \
  --state-dir "$HOME/Library/Application Support/com.xlang.xharness/state" \
  --model-ref YOUR_EXISTING_CREDENTIAL_REFERENCE
```

Repeat `--model-ref` / `--channel-ref` for existing references (not secret values). It prints only a presence count, never passwords or tokens, opens no server and can authorize the helper while the old Host task keeps running. This avoids first-time interactive authorization racing short background search/channel availability timeouts. It requires the pinned helper; it cannot silently fall back to a direct reader.

On first credential use, macOS may ask to authorize the helper for each existing item. Choose **Always Allow** after checking its name. Merely choosing Allow grants only that access and does not establish persistent authorization. This is a one-time migration for this helper, not a new per-Host-build identity. Cancelling preserves the original item and returns a credential error; there is no direct-reader fallback that hides a failed helper authorization.

The first migration must be exercised interactively on the user's actual existing items. Synthetic tests do not stand in for this step. Neither the setup script nor the updater saves a login password for subsequent updates.

## Boundaries

- Only `get`, `set`, `delete`; exactly validated XHarness model/channel service namespaces and credential references.
- Secrets remain in the user's existing Keychain namespace. Secret values travel only over private process stdin/stdout, never argv, log messages, files, or generic RPC responses.
- No HTTP listener, Unix socket, daemon, shell execution, arbitrary keychain/item query or generic “read any secret” endpoint.
- The Rust subprocess wrapper clears inherited environment, pins and verifies the helper signature, bounds output, has bounded verification/operation timeouts, kills its own child on cancellation, and never prints secret-bearing stderr.
- Private state-owned pin and helper paths; symlink/hardlink/tampered/public-readable binaries or manifest fail closed. No new dependencies.
- Windows/Linux remain on their existing native credential stores. Mac installations without the opt-in manifest also retain the previous behavior.
- Helper integrity errors, missing signing identity, or changed certificate are explicit failures. No ad-hoc or `/usr/bin/security` fallback, broad ACL grant, `-A`, credential deletion or forced rotation.
- A future **helper** security update, certificate rotation, Keychain reset/lock, revoked authorization, or OS policy change may require authorization again. “Never prompts for any reason” is not claimed.
- This does not defend against the account owner deliberately replacing both their private pin and signed trusted Host or using their signing private key. Those are existing owner-controlled trust roots.

## Acceptance

- Remote Rust Host tests and Clippy; pin/protocol/permissions/tamper/error regressions.
- Local modern-login-Keychain synthetic regression: different Host builds with the same self-signed identity fail direct access to a build-partitioned test item; item is then removed.
- Native helper fixture: two different signed C fixture Host callers read/update/delete synthetic credentials through an unchanged helper, wrong identifier/non-Host parent rejected, foreign service and invalid/oversized/empty writes rejected, failed write preserves old value, all synthetic items removed. No production credential is read by this fixture.
- Existing hosted macOS fixed-signing fixture runs the same helper acceptance under a disposable CI certificate, using its existing protected cleanup. This is not TCC/Gatekeeper or real-credential migration acceptance.

For rollback, stop the affected desktop safely, preserve the helper/pin, and explicitly opt out by moving the manifest out of its active path. Do not delete Keychain items. A legacy Host may require its own old authorization again. Never roll back while a task is using the credential backend.
