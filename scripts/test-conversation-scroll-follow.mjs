import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchConversationScrollFollow } from './patch-conversation-scroll-follow.mjs';

const root = new URL('../', import.meta.url);
const helper = readFileSync(new URL('ui/overrides/conversation-scroll-follow.js', root), 'utf8');
const context = {};
vm.runInNewContext(helper + '\nglobalThis.decide = xhScrollFollowAtBottom;', context);
const decide = context.decide;

// Native anchoring after compaction can move the viewport without reader input.
assert.equal(decide(true, 30, 80, 100, false), true);
assert.equal(decide(true, 50, 100, 50, false), true);
// An actual wheel/touch/keyboard/scrollbar gesture still releases follow mode.
assert.equal(decide(true, 30, 80, 100, true), false);
assert.equal(decide(true, 78, 80, 100, true), true);
// Once the reader has chosen an older position, reflow must not resume follow.
assert.equal(decide(false, 30, 80, 30, false), false);

const path = new URL('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js', root);
const patched = patchConversationScrollFollow(readFileSync(path));
assert.deepEqual(patchConversationScrollFollow(patched), patched, 'patch is idempotent');
const source = patched.toString();
assert.match(source, /readerInputRecent && Math\.abs/);
assert.match(source, /addEventListener\("wheel", readerInput/);
assert.match(source, /removeEventListener\("wheel", readerInput/);
assert.match(source, /xhScrollFollowAtBottom\(atBottomRef\.current/);
console.log('conversation scroll follow: compaction reflow, reader gesture and patch idempotence passed');
