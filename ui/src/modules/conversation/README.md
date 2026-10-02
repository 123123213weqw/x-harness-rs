# Conversation browser source

`index.ts` is the production ModuleLoader entry. `apply.ts` assembles the resident
conversation, keyed chat renderers, session input standard kit, approval takeover,
queue/todo docks, settings preference, and details surface. The source graph is
self-contained under `ui/`; no build step reads the upstream reference checkout.

## Ownership

- `input/`: pure transactional input machine, session facade, scoped-event hub,
  reference/paste decorations, composer blocking, and busy-Enter policy.
- `conversation-nodes/`: assistant/tool/inbox/message/command/retry/turn definitions,
  immediate compaction/checkpoint publication, and incremental chat view builder.
- `chat/`: keyed renderer seats, reasoning/compaction/context disclosure, message
  chrome, stable statistics, reader-owned scrolling and measured DOM windowing.
- `skeleton/`, `queue/`, `settings/`: complete resident conversation/composer UI,
  permission selection, context composition ring, approval receipts and queue edits.
- `edit/`: recoverable edit transactions, source-authorized fork-before-user intake,
  missing-attachment retries, and portable IndexedDB byte persistence for WebKit.
- `types/`, `contract/`: consumed Host/runtime/slot boundaries, not implementations
  borrowed from another migration module. `externals.d.ts` is entry-local only.

React, Cordis, runtime, slots, and render primitives remain platform-owned ABI
services. `runtime-values.ts` and `primitives.ts` narrow only the consumed contracts.
The existing pinned Zod dependency provides the owned unknown-boundary codecs;
platform dependencies retain their original singleton ABI. Owned TypeScript has
no explicit/inferred `any`, ordinary/angle/double assertions, non-null assertions,
or checker suppression. Wire and persistence boundaries start at `unknown` and
use domain codecs. Real Cordis service tracking reads the current caller's `ctx`
at use time; unrelated namespace guards must not invent inject dependencies.

Each owned `*.css` is an exact retained stylesheet string. Its adjacent
`*.styles.ts` owns the explicit idempotent style-tag installation and exports a
class-name map; no component mistakes a CSS string for a class-name object.

## Retained production behavior

The source includes durable image/file references and intake limits; an immutable
history edit/fork flow with durable rollback; the shared plus menu/native picker;
fork/subagent ancestry breadcrumbs and a visible failed-history alert/retry;
permission current-round versus next-round feedback; exact versus estimated
context readings and seven-category rings; silver surface hooks; immediate running
compaction progress and execution-limit checkpoints; persistent network-wait recovery;
and transcript virtualization that never deletes model/history data. Genuine
text selection, focused input and the live tip temporarily protect rows; clicked
buttons alone do not pin history forever. Row-owned disclosure/draft state shares
the real React `createElement` identity and survives eviction/remount. Measured
placeholders retain geometry, width changes keep offscreen seats bounded, and
native clamp/compaction scrolls cannot steal reader ownership.

## Acceptance

The private `test-exports.ts` entry is never imported by the production entry.

```sh
node scripts/test-conversation-source.mjs
UI_TEST_DEPS=/path/to/browser-deps node scripts/test-conversation-source-browser.mjs
UI_TEST_DEPS=/path/to/browser-deps UI_TEST_BROWSER=webkit node scripts/test-conversation-source-browser.mjs
UI_TEST_DEPS=/path/to/browser-deps UI_TEST_IMPL=legacy node scripts/test-conversation-source-browser.mjs
UI_TEST_DEPS=/path/to/browser-deps UI_TEST_BROWSER=webkit UI_TEST_IMPL=legacy node scripts/test-conversation-source-browser.mjs
```

Node acceptance compiles strict source and compares published ABI, every
stylesheet/dictionary/registration, input transactions, host serialization,
edit/storage races, source-authorized forks, cache generations, full-history live
projection identity, compaction/checkpoint publication, and permission/scroll
ownership against the retained production bundle. Browser acceptance renders the
real source-owned resident tree and the retained bundle through the same narrow
platform fixture in Chromium and WebKit, including file chooser focus, edit/IDB,
context/permission UI, reasoning/compaction/checkpoint, approval/queue receipts,
and measured transcript eviction/pinning/reflow.

The immutable comparison is `ui/reference/master-a613970`, never a newly
generated bundle or an upstream checkout. Additional genuine factory tests are:

```sh
node scripts/test-conversation-service-boundaries.mjs
node scripts/test-conversation-connection-boundaries.mjs
node scripts/test-conversation-history-rollback.mjs
```

These cover true Core caller fibers and namespace injection, erased generic RPC
root/scoped routing, fork lineage in list/Host frames, optional archive metadata,
the native delete/unarchive wire helpers, open foreign carriers, and real Session
history rollback/retry after a malformed known compaction. HTTP DTOs are not
weakened to accommodate the fixture carrier's historical `origin: 'fork'`.

The established message-edit, internal-queue, permission-selection, checkpoint,
approval and transcript-windowing gates inspect the actual shipped factory through
`scripts/conversation-artifact-test.mjs`. That test-only seam appends exports inside
AST-identified owned unit closures without changing their imports or production
ABI. It requires source freshness, graph revision, preload and boot consistency;
frozen patch-idempotence checks remain separate golden contracts. The browser
gates retain the real distribution's React, primitives and runtime rather than
substituting a simplified conversation implementation.
