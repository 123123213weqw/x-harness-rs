Isolated experiment reference, NOT production code or full ZCode agent.
Original revision: 3c5b227649371507ddc4eb46ac5133afe6db1cab.
original/ contains exact git object bytes, git blob IDs and SHA-256 are in source-manifest.json.
build-reference.mjs performs TypeScript transpilation only on 8 original backend files; it does NOT replace backend behavior or typecheck the whole monorepo.
Original backend dependency playwright-core 1.59.1 is independently pinned here.
ab-reference.mjs is OUR DISCLOSED SHIM, not upstream code. It passes native BrowserCommand arguments to the original BrowserControlPort, adds only experiment session identities, original public viewport bootstrap, fixture-origin INPUT URL scope, and a public interaction capability subset.
No evaluate/HTTP/FS/route/hidden-DOM methods are exposed to the model. Backend source is unchanged.
The fixture-origin input check is an experiment scope check, not a claim that upstream has XHarness's runtime redirect firewall.
Any cross-version browser executable use must be recorded as a dependency confound. Real original backend smoke/benchmark evidence is required; extraction/transpilation alone is not acceptance.
Apache-2.0 upstream LICENSE is retained under original/LICENSE.
