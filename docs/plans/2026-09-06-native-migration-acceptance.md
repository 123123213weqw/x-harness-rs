# Native Windows Migration Acceptance Implementation Plan

**Goal:** Validate real old installers and both native updater hops before changing the public old feed.

**Architecture:** Run only on disposable GitHub-hosted Windows runners. Download the original old installers, old-key bridge draft and new-key upstream target, verify signatures, then use a loopback HTTPS fixture proxy for the exact embedded GitHub URLs. A short-lived certificate is trusted only in that runner's current-user store and removed afterward; no TLS or installer-signature bypass is used. Playwright attaches to WebView2 through a loopback-only test debugging port and invokes the installed application's normal Tauri commands.

**Tech Stack:** Existing production NSIS installers, Tauri updater, PowerShell certificate APIs, Node HTTPS/CONNECT, Playwright CDP. No local Rust compilation.

## Steps

1. Provision independent upstream signer with encrypted local backup and exact repository opt-in. Never move old private key. Publish upstream bootstrap/target from reviewed source using existing signed release workflow.
2. Add `scripts/windows-migration-acceptance.{mjs,ps1}` and `.github/workflows/windows-migration-acceptance.yml`. Refuse local and self-hosted execution. Matrix covers old `0.2.0` and `0.2.1` in separate fresh runners.
3. Seed synthetic model config, credential, workspace file; create and rename an actual persisted session through the authenticated in-app API. No real model request.
4. Before install, reject corrupt package and reject install without confirmation. Perform actual `desktop_install_update` twice, attach after each restart, check versions, Host health, model catalog, file hashes, session/title and journal retention. Capture screenshots and request paths proving endpoint transition.
5. Run syntax/guard tests locally, CI for real installations. Publish old draft ONLY after both matrix cases produce PASS evidence. Preserve live feed on failure. Do not mistake signature-only checks for native acceptance.

No installation on the developer's machine, no production root-store change, no old-feed mutation before acceptance, and no signing private keys in this workflow.
