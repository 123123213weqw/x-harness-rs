// Regression: a running turn must recover a session whose history read failed,
// otherwise the answer the model produces stays invisible behind the error
// banner. Live report: "前面已经 fail，后面发了消息；有可能模型还在回答，但是前端不显示".
//
// The transactional history layer already keeps live frames in the `error` state
// (nothing is lost); what this covers is the missing half — nothing publishes
// that suffix until the user presses the banner's retry. The status frame a new
// prompt produces is the user's own action, so it recovers the window there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { patchLiveAnswerRecovery } from './patch-live-answer-recovery.mjs';

const path = new URL('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js', import.meta.url);
const source = readFileSync(path, 'utf8');
assert.equal(patchLiveAnswerRecovery(Buffer.from(source)).toString(), source);
assert.equal(patchLiveAnswerRecovery(Buffer.from(source.replaceAll('\n', '\r\n'))).toString(), source);
assert.throws(() => patchLiveAnswerRecovery(Buffer.from('upstream changed')), /anchor changed/);
// The recovery is installed on the transactional layer it depends on.
assert.ok(source.indexOf('xh-live-answer-recovery:start') < source.indexOf('xh-atomic-history:start'));
// Assembly applies the patches in that order to the upstream bundle, so the
// install anchor must exist by the time this patch runs.
const upstream = 'const Session = 1;\n// xh-session-history-cache:start\ninstallSessionHistoryCache(Session);\n// xh-session-history-cache:end\n// xh-atomic-history:start\ninstallAtomicHistory(ConversationNodeAssembler, Session);\n// xh-atomic-history:end\n';
const assembled = patchLiveAnswerRecovery(Buffer.from(upstream)).toString();
assert.ok(assembled.indexOf('xh-live-answer-recovery:start') < assembled.indexOf('xh-atomic-history:start'),
  'the recovery must be installed ahead of the transactional layer');
assert.ok(assembled.includes('installLiveAnswerRecovery(Session);'));
assert.throws(() => patchLiveAnswerRecovery(Buffer.from('const Session = 1;')), /anchor changed/);
const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url)));
const entry = graph.entries.find(row => row.id === '@xharness/dsh-client-runtime');
assert.equal(entry.rev, createHash('sha256').update(source).digest('hex').slice(0, 16));
const index = readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8');
assert.ok(index.includes(entry.url));
const published = [...index.matchAll(/dsh-client-runtime\/client\.js\?rev=([0-9a-f]+)/g)].map(match => match[1]);
assert.ok(published.length >= 2 && published.every(rev => rev === entry.rev), `stale runtime rev in index.html: ${published}`);

let registration;
vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.Session = Session; exports.apply = apply;'), {
  window: { __ModuleLoader__: { load: value => { registration = value; } } },
  console, URL, AbortController, setTimeout, clearTimeout, queueMicrotask, Date,
  requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
const runtime = registration.factory(id => id === '@xharness/cordis' ? { Service: class {} } : {});

const definition = {
  kind: 'probe', target: 'probe',
  match: event => event.type === 'probe' ? { id: event.data.id, role: event.data.role } : null,
  start: () => ({}), update: context => context.state,
  buildViewNode: context => ({ key: context.key, target: 'probe', seq: context.startSeq }),
};
const events = { entries: () => [definition], fallbackEntry: () => undefined };
const views = { entries: () => [{ target: 'probe', create: () => ({ empty: [], replace: value => value.nodes, apply: value => value.upserts }) }] };
const row = seq => ({ event: { seq, time: seq, type: 'probe', data: { id: String(seq), role: 'start' } } });
const ok = (rows, hasMore = false) => ({ result: { ok: true, value: { events: rows, hasMore } } });
const fail = { result: { ok: false, error: { code: 'transport-failure', message: 'history failed' } } };

let replies = [], historyCalls = 0;
const session = new runtime.Session('fixture', { sessions: { history: async () => {
  historyCalls++; const response = replies.shift(); return typeof response === 'function' ? response() : response;
} } }, {}, { conversation: { events, views } });
const seqs = () => Array.from(session.events, event => event.seq);
const settle = async () => { for (let attempt = 0; attempt < 50 && session.openState !== 'open'; attempt++) await new Promise(resolve => setTimeout(resolve, 0)); };

// A window that opened, then failed a read: the banner state with a live answer
// already arriving behind it.
session.installWindow([row(10)], true); session.openState = 'open'; session.getSnapshot();
replies = [fail];
await session.loadOlder();
assert.equal(session.openState, 'error');
assert.ok(session.openError);
session.acceptLiveEvent(row(11).event, undefined);
assert.deepEqual(Array.from(session.liveBuffer, item => item.event.seq), [11], 'a failed read must keep the live answer recoverable');

// The user acts: a new prompt makes the host report the session running again.
// Recovery must publish the buffered answer instead of leaving it in the buffer.
const callsBeforeRecovery = historyCalls;
replies = [ok([row(10), row(11), row(12)])];
session.handleRunning(true);
assert.ok(historyCalls > callsBeforeRecovery, 'a running turn must retry the failed history read');
await settle();
assert.equal(session.openState, 'open');
assert.equal(session.openError, null);
assert.deepEqual(seqs(), [10, 11, 12], 'the buffered live answer must be published');

// Queueing behind an already-running turn does not emit another running=true
// edge from the Host. A successful local prompt admission must therefore be an
// independent recovery trigger rather than relying exclusively on status.
let promptHistoryCalls = 0, promptCalls = 0;
const promptSession = new runtime.Session('prompt-fixture', {
  sessions: {
    prompt: async () => { promptCalls++; return { result: { ok: true, value: { accepted: true } } }; },
    history: async () => { promptHistoryCalls++; return ok([row(20), row(21)]); },
  },
}, {}, { conversation: { events, views } });
promptSession.installWindow([row(20)], true); promptSession.openState = 'error'; promptSession.getSnapshot();
promptSession.acceptLiveEvent(row(21).event, undefined);
await promptSession.prompt([{ type: 'text', text: 'queued while already running' }], 'queue');
for (let attempt = 0; attempt < 50 && promptSession.openState !== 'open'; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(promptCalls, 1);
assert.equal(promptHistoryCalls, 1, 'an accepted prompt must recover without a new running status frame');
assert.equal(promptSession.openState, 'open');
assert.deepEqual(Array.from(promptSession.events, event => event.seq), [20, 21]);

// Rejected admission cannot produce an answer and must not turn into an
// unrelated history request.
let rejectedHistoryCalls = 0;
const rejected = new runtime.Session('rejected', {
  sessions: {
    prompt: async () => ({ result: { ok: false, error: { code: 'rejected', message: 'no' } } }),
    history: async () => { rejectedHistoryCalls++; return ok([row(30)]); },
  },
}, {}, { conversation: { events, views } });
rejected.installWindow([row(30)], true); rejected.openState = 'error'; rejected.getSnapshot();
const rejectedResult = await rejected.prompt([{ type: 'text', text: 'rejected' }], 'queue');
assert.equal(rejectedResult.ok, false);
assert.equal(rejectedHistoryCalls, 0, 'a rejected prompt must not trigger recovery');

// Rate limit: streaming status frames must not become one history fetch each.
//
// One interval must pass before the next retry is allowed, so a burst of status
// frames inside it is free.
const now = Date.now;
let clock = now(); Date.now = () => clock;
try {
  session.hasMore = true;
  replies = [fail];
  await session.loadOlder();
  assert.equal(session.openState, 'error');
  const settled = historyCalls;
  session.xhLiveRecoveryAt = clock;
  for (let index = 0; index < 50; index++) session.handleRunning(true);
  assert.equal(historyCalls, settled, 'a burst of running frames must not retry more than the interval allows');
  clock += 5000;
  // The retry must not move the committed window backwards; keep it consistent.
  replies = [ok([row(10), row(11), row(12)])];
  session.handleRunning(true);
  assert.equal(historyCalls, settled + 1, 'the next interval must retry again');
  await settle();
  assert.equal(session.openState, 'open');
} finally { Date.now = now; }

// A background session keeps its buffered answer and does not fetch on its own.
const background = new runtime.Session('bg', { sessions: { history: async () => {
  historyCalls++; return replies.shift();
} } }, {}, { conversation: { events, views } });

background.xhHistoryOwner = { manager: { selected: 'fixture' }, changed: () => {}, schedule: () => {} };background.installWindow([row(10)], true); background.openState = 'open'; background.hasMore = true; background.getSnapshot();
replies = [fail];
await background.loadOlder();
assert.equal(background.openState, 'error');
background.acceptLiveEvent(row(11).event, undefined);
const calls = historyCalls;
background.handleRunning(true);
background.handleRunning(true);
assert.equal(historyCalls, calls, 'a session the user is not looking at must not retry history');
assert.deepEqual(Array.from(background.liveBuffer, item => item.event.seq), [11], 'a background session keeps its buffered answer');

// Nothing to recover while the window is healthy: status frames stay free.
const before = historyCalls;
for (let index = 0; index < 20; index++) session.handleRunning(true);
session.handleRunning(false);
assert.equal(historyCalls, before, 'a healthy window must not refetch on status frames');

console.log('live answer recovery: prompt/status triggers, buffered answer publication, rate limit and background isolation passed');
