import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { patchAtomicHistory, patchHistoryRetry } from './patch-atomic-history.mjs';

const source = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js', import.meta.url), 'utf8');
assert.equal(patchAtomicHistory(Buffer.from(source)).toString(), source);
assert.equal(patchHistoryRetry(Buffer.from(chatSource)).toString(), chatSource);
assert.equal(patchAtomicHistory(Buffer.from(source.replaceAll('\n', '\r\n'))).toString(), source);
assert.throws(() => patchAtomicHistory(Buffer.from('upstream changed')), /anchor changed/);
assert.throws(() => patchHistoryRetry(Buffer.from('upstream changed')), /anchor changed/);
const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url)));
for (const [id, bytes] of [['@xharness/dsh-client-runtime', source], ['@xharness/dsh-client-ui-conversation', chatSource]]) {
  const entry = graph.entries.find(row => row.id === id);
  assert.equal(entry.rev, createHash('sha256').update(bytes).digest('hex').slice(0, 16));
  assert.ok(readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8').includes(entry.url));
}
let registration;
vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.Session = Session; exports.apply = apply;'), {
  window: { __ModuleLoader__: { load: value => { registration = value; } } },
  console, URL, AbortController, setTimeout, clearTimeout, queueMicrotask,
  requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
const runtime = registration.factory(id => id === '@xharness/cordis' ? { Service: class {} } : {});
let failBuild = false;
const definition = {
  kind: 'probe', target: 'probe',
  match: event => event.type === 'probe' ? { id: event.data.id, role: event.data.role } : null,
  start: () => ({}),
  update: (context, match) => { if (match.event.data.fail) throw Error('reducer failure'); return context.state; },
  buildViewNode: context => ({ key: context.key, target: 'probe', seq: context.startSeq }),
};
const events = { entries: () => [definition], fallbackEntry: () => undefined };
const views = { entries: () => [{ target: 'probe', create: () => ({
  empty: [], replace: value => { if (failBuild) throw Error('view failure'); return value.nodes; },
  apply: value => value.upserts,
}) }] };
const row = (seq, id = String(seq), role = 'start', fail = false) => ({ event: { seq, time: seq, type: 'probe', data: { id, role, fail } } });
const bad = [row(20, 'bad', 'update'), row(21, 'bad', 'start')];
const a = new runtime.ConversationNodeAssembler(events, views);
a.replaceWindow([row(10)], true); a.flush();
const oldInputs = a.inputs, oldSnapshot = a.snapshot('probe'), oldLocation = a.locationIndex;
assert.throws(() => a.replaceWindow(bad, false), /before its start/);
assert.equal(a.inputs, oldInputs, 'failed replacement must retain original input map');
assert.deepEqual([...a.inputs.keys()], [10]);
assert.equal(a.snapshot('probe'), oldSnapshot);
assert.equal(a.locationIndex, oldLocation);
assert.equal(a.hasMore, true);
assert.throws(() => a.replaceWindow([row(20, 'bad'), row(21, 'bad', 'update', true)], false), /reducer failure/);
assert.equal(a.inputs, oldInputs);
failBuild = true;
assert.throws(() => a.replaceWindow([row(30)], false), /view failure/);
assert.equal(a.snapshot('probe'), oldSnapshot);
failBuild = false;
assert.throws(() => a.prepend([row(8, '10', 'update')], false), /before its start/);
assert.equal(a.inputs, oldInputs);
a.replaceWindow([row(30)], false); a.flush();
assert.deepEqual([...a.inputs.keys()], [30]);

let replies = [], historyCalls = 0;
const session = new runtime.Session('fixture', { sessions: { history: async () => {
  historyCalls++; const response = replies.shift(); return typeof response === 'function' ? response() : response;
} } }, {}, { conversation: { events, views } });
session.installWindow([row(10)], true); session.openState = 'open'; session.getSnapshot();
const originalEvents = session.events, originalViews = session.views, assembler = session.conversation;
assert.throws(() => session.installWindow(bad, false), /before its start/);
assert.equal(session.events, originalEvents); assert.equal(session.views, originalViews);
assert.equal(session.baseSeq, 10); assert.equal(session.hasMore, true);
assert.equal(session.conversation, assembler);
session.liveBuffer = [row(12), row(11), row(12)];
session.installWindow([row(10)], true);
assert.deepEqual(Array.from(session.events, e => e.seq), [10, 11, 12]);
const afterGood = session.events;
assert.throws(() => session.installWindow([row(10)], true), /backwards/);
assert.equal(session.events, afterGood);
session.liveBuffer = [row(15)];
assert.throws(() => session.installWindow([row(10)], true), /gap/i);
assert.equal(session.events, afterGood); assert.equal(session.liveBuffer.length, 1);
session.liveBuffer = [];
const ok = (rows, hasMore = false) => ({ result: { ok: true, value: { events: rows, hasMore } } });
replies = [ok([row(8, '10', 'update'), row(9)], false)];
await session.loadOlder();
assert.equal(session.events, afterGood, 'failed older page must not commit raw history');
assert.equal(session.baseSeq, 10); assert.equal(session.hasMore, true);
assert.equal(session.openState, 'error'); assert.ok(session.openError);
const pendingApproval = { kind: 'approval', id: 'keep-me' };
session.pending.set('approval:keep-me', pendingApproval); session.pendingRev++;
const pendingRevision = session.pendingRev;
session.subscribedLastSeq = 13;
session.acceptLiveEvent(row(13).event, undefined);
assert.deepEqual(Array.from(session.liveBuffer, entry => entry.event.seq), [13], 'error-state live events remain recoverable');
replies = [ok([row(10), row(11), row(12)])];
await session.loadOlder(); // error-state button is a history-only retry
assert.equal(session.openState, 'open'); assert.equal(session.openError, null);
assert.equal(session.pending.get('approval:keep-me'), pendingApproval, 'history retry must retain pending approval/question state');
assert.equal(session.pendingRev, pendingRevision); assert.equal(session.subscribedLastSeq, 13);
assert.deepEqual(Array.from(session.events, event => event.seq), [10, 11, 12, 13]);
assert.equal(session.liveBuffer.length, 0);

const beforeResync = session.events, beforeSnapshot = session.conversation.snapshot('probe');
replies = [ok(bad)];
await session.resync();
assert.equal(session.events, beforeResync); assert.equal(session.conversation.snapshot('probe'), beforeSnapshot);
assert.equal(session.openState, 'error');
let release;
replies = [() => new Promise(resolve => { release = resolve; })];
const stale = session.resync();
await Promise.resolve();
replies = [ok([row(10), row(11), row(12), row(13)])];
await session.resync();
release(ok(bad)); await stale;
assert.equal(session.openState, 'open');
assert.deepEqual(Array.from(session.events, e => e.seq), [10, 11, 12, 13]);
assert.ok(historyCalls >= 5);
const beforeGap = session.events;
session.liveBuffer = [row(16)]; replies = [ok([row(10), row(11), row(12), row(13)])];
await session.repairGap();
assert.equal(session.openState, 'error'); assert.equal(session.events, beforeGap);
assert.equal(session.liveBuffer.length, 1); assert.equal(session.stitching, false);
replies = [ok([row(10), row(11), row(12), row(13), row(14), row(15), row(16)])];
await session.loadOlder();
assert.equal(session.openState, 'open'); assert.equal(session.liveBuffer.length, 0);

session.hasMore = true;
const beforeRace = session.events;
let releasePage, releaseRepair;
replies = [
  () => new Promise(resolve => { releasePage = resolve; }),
  () => new Promise(resolve => { releaseRepair = resolve; }),
];
const paging = session.loadOlder();
await Promise.resolve();
session.acceptLiveEvent(row(18).event, undefined); // tail is 16: start gap repair for 17
await Promise.resolve();
assert.equal(session.stitching, true);
releasePage(ok([row(8), row(9)]));
await paging;
assert.equal(session.openState, 'open', 'stale pagination must not fail a concurrent gap repair');
assert.equal(session.events, beforeRace, 'pagination response is discarded once gap repair owns publication');
releaseRepair(ok(Array.from({ length: 9 }, (_, offset) => row(10 + offset))));
for (let attempt = 0; attempt < 20 && session.stitching; attempt++)
  await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(session.stitching, false);
assert.deepEqual(Array.from(session.events, event => event.seq), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
console.log('atomic history: transactional mapping, interaction/live-buffer preservation, pagination/gap serialization and retry passed');
