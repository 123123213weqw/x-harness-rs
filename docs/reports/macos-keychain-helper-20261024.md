# Local Keychain update prompt investigation

- Installed 0.2.57 uses the original persistent local signing certificate; its signing private key already allows codesign. Signing two throwaway native fixtures required no password.
- Six model credential items had a stable certificate-based trusted Host requirement but version-specific partition lists (26/9/7/6/6/5 code hashes). No production credential data was requested for the audit.
- Modern login Keychain witness: signed A created/read a synthetic item; signed B (same certificate and identifier, different code hash) was denied with `errSecAuthFailed` when interaction was disabled. A removed the exact synthetic item.
- An initial `security create-keychain` fixture reported legacy database version 256 and did not enforce the same partition rule. That earlier positive result is NOT used as proof of a modern-Keychain fix. The modern login witness supersedes it.
- Initial stable-helper native fixture had an incorrect hand-counted namespace prefix length and failed before accessing any item. The parser now derives lengths from the literal arrays. Final fixtures must be rerun; no acceptance is inferred from the initial failure.
- No production credential or ACL has been deleted/rewritten/widened. The local helper has not yet been installed or authorized on existing items, and installed app/tasks have not been restarted by these tests.

Source/implementation/acceptance details: [fixed local helper](../macos-local-credential-helper.md). Local private evidence is retained outside the repository; no credential, login password, browser token, or keychain dump is committed.

## Validation so far

- Native helper witness passed 23 synthetic operation/admission cases on the local modern login Keychain, with the helper bytes unchanged across signed C fixture callers, all test items removed, and no production credentials read. This is not yet the actual compiled Rust Host success-path acceptance.
- Isolated native setup/idempotence/tampered-pin rejection passed; the real installation remains unchanged.
- Remote WZU_Server Host all-target suite passed before the additional maintenance-mode entry; final-source model-settings/maintenance tests, all-target Clippy, and the Linux unsupported-maintenance-mode binary check passed separately. The maintenance integration test verifies no startup receipt or state file is written and no supplied secret argument is echoed.
- Offline helper and existing stable-signing contracts passed. Hosted macOS CI and actual signed Host end-to-end acceptance are still required before deployment.
