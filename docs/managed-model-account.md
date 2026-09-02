# Managed model account (candidate)

Settings → Account & model service uses the native device-code bridge. The
identity/billing backend is the PRIVATE `x-harness-web` + `relay-station` change,
not the Harness runtime. Login opens the SYSTEM browser, not an IPC-enabled
embedded guest page. A native random verifier never enters a URL or Web storage.
Only `main` may invoke the five account commands; guest browsing has no grants.
The endpoint is a build-time HTTPS origin (`XHARNESS_ACCOUNT_ORIGIN`, default
`https://engine.xxdevs.com/`). Responses are bounded, never redirected, and the
verification/base URLs must exactly match that origin's fixed paths.

After explicit website approval, the native bridge retains the one-time result
until the existing settings CAS write and OS credential-store write succeed.
The provider is `xharness-managed`; the secret reference is
`XHARNESS_MANAGED_API_TOKEN`. No BYOK profile or current task model is replaced.
A reserved-route collision with a different credential/base URL fails closed.
Settings conflicts do not write a credential. No bearer is rendered or stored
in localStorage. A failed save pauses polling and offers an explicit retry.
Settings may be closed/reopened without losing the native pending login.

Remove local connection erases the local key only. It deliberately does NOT
claim server revocation. Revoke devices on the account website, including a
canceled connection whose revocation acknowledgement was lost. Sign-out,
account suspension and credential expiry prevent subsequent managed requests.
An existing in-flight request is not retroactively unexecuted/refunded.

Validation: remote Linux Tauri lib tests (62), native all-target Clippy, local
owned UI typecheck/assembly, 11 settings-source regression tests, asset checks.
No macOS/Windows browser-login/keyring end-to-end or real paid inference has
been accepted yet. This source change does not release or replace an app, and
does not expose public account routes. Server private bridge and model allowlist
must be configured/tested before deploying a connected release.

## Model source menu

The model pane displays the reserved `xharness-managed` catalog directly under
**XHarness · Account service / 账号服务**. All other providers live behind one
**Custom / 自定义** row; their names appear only inside that submenu. Provider
IDs, not display names or model IDs, determine provenance and selection. No
model capability (for example Vision) is invented for this presentation.

**Manage models / 管理模型** sends a root-context navigation event to the
settings shell; the shell alone owns modal state. Existing reasoning/context
controls and `/model` RPC behavior are retained. Keyboard Back/Escape returns
one level, successful selection restores the composer trigger's focus.

The generic provider editor cannot edit/delete the account-owned profile and
BYOK creation reserves its route even before login. Account connection remains
its owner. These UI guards are not a server-side authorization boundary:
managed request authorization and quota enforcement still belong to the BFF.

Preview: `node scripts/preview-managed-model-menu.mjs` (loopback port 3193).
It uses the actual source components/platform with a clearly labelled fixture
catalog, and performs no authentication, configuration writes or paid requests.
Chromium/WebKit source-menu regressions are enrolled in the UI CI plan.
