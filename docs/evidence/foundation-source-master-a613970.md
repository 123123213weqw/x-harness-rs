# Foundation source acceptance — master a613970

Baseline: `a613970c78a36a024de56100078323df25b96004`.
The test label `legacy` means the immutable executable reference under
`ui/reference/master-a613970`, not a production dependency on a legacy bundle.

## Scope and compiler

Native TS execution for client-modules, client-runtime, client-hmr,
client-locale and cordis-client-runner uses the release `compileSourceModules`
compiler, genuine original SDKs, strict declaration checking, and the owned
hard policy. No business `any`, ordinary type assertion, doublecast, non-null
assertion substitute or type suppression is used. Genuine original Immer
10.2.0 and Cordis/Cosmokit/Loader vendor runtime/SDKs remain provenance-pinned.
Platform acceptance is recorded separately in
`platform-source-master-a613970.json` / `.md`.

## Reproduce

```sh
cd ui && npm ci --ignore-scripts --no-audit --no-fund && cd ..
node --test scripts/test-foundation-source-modules.mjs
node scripts/test-atomic-history.mjs
node scripts/test-live-answer-recovery.mjs
node scripts/test-startup-catalog-refresh.mjs
for impl in legacy source; do
  for browser in chromium webkit; do
    UI_TEST_DEPS=/path/to/playwright-deps UI_TEST_IMPL=$impl UI_TEST_BROWSER=$browser \
      node scripts/test-session-history-cache.mjs
  done
done
```

All 123 foundation assertions pass with process exit 0 and no after-test
asynchronous errors. Startup catalog refresh retains its patch golden and
passes all three actual frozen/source schema/manager tests. Atomic history
retains all original transactions, pending/live suffix, pagination/gap and
retry assertions plus five frozen/source cases; live-answer recovery retains
all original cases plus two frozen/source cases. No issue messages are ignored:
JSON corpus values and the genuine locked Zod English SDK are initialized in
each schema's execution realm.

History-cache browser acceptance passes source/frozen × Chromium/WebKit,
32 paths per run, including actual invalid-compaction `Session.resync`, old
Chat snapshot identity and displayed message retention, the error banner,
clicking its real retry control (history RPC only), scope/projection retention,
range restore, background events, pending/queue/running protections, stale
async epochs and manager-drop cleanup. Chromium also forces GC and verifies
both evicted event WeakRefs are reclaimed. In the recorded run, inactive
sessions drop from 31 to 6; source heap drops 26,101,872 → 17,073,864 bytes,
frozen heap 21,355,812 → 12,342,144. These are synthetic payload/heap checks,
not an RSS claim.

## Actual native gaps caught and fixed

- Preserve audited `historyReuse: 'local'` reducer/build identities while
  rebinding fresh Match/Location objects; hidden/dependency-changed state
  replays. A failed staged view leaves the committed transaction untouched.
- Settle dead-generation waits before the new mux generation is admitted;
  readiness must not clear fresh pending waits or subscription watermark.
- Accept the real locale label thunk without cloning/eagerly evaluating it;
  declaration-level Slot inject is an object, not entry-level callback inject.
- The runner consumes the independently preloaded ModuleLoader's actual
  invalidation method with its receiver intact, rather than `instanceof` a
  second class inlined into its own closure. A real Core plugin with its real
  inject roster mounts and unloads successfully.

## Honest boundaries and public ABI

Typed owned Chat publication preserves the exact object identity. The sole
explicit additional runtime public key is `publishChatSnapshot`; every prior
key and injection value is checked exactly against frozen. Untyped old JS
Chat publishers are not silently dropped: stable common/legacy values retain
identity, while unknown callable readers use checked receiver-preserving
adapters and validate every returned node/list. Typed persistence uses real
per-domain decoders and literal action bake tuples; untyped JS state remains
unknown and keeps its original persistence keys and read/write behavior.

`foundation-source-master-a613970.json` records current source/artifact hashes,
immutable frozen digests, compiler inputs and complete output-log hashes.
Whole-graph UI, same-Host integration and canonical CI remain root-owned gates;
this receipt does not declare the full migration complete. No local Rust
compilation, commit, push, release or running application restart was performed.
