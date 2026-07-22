// Run the shipped connection factory and its actual embedded Zod codecs.
// Replacing transport is intentional; replacing callUnary/readSse would hide
// exactly the production bug this regression must detect.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {verifyConnectionArtifact,legacyConnection} from './connection-artifact-test.mjs';
import {LEGACY_VIEW_SCHEMA, COMPACTION_VIEW_SCHEMA, patchCompactionWire, syncCompactionWire} from './patch-compaction-wire.mjs';

const source=verifyConnectionArtifact(),golden=legacyConnection().toString();
const plain = value => JSON.parse(JSON.stringify(value));
const marker = '// xh-compaction-wire/v1\n';
assert.ok(golden.includes(marker + COMPACTION_VIEW_SCHEMA), 'shipped schema includes compaction extension');
const legacy = golden.replace(marker + COMPACTION_VIEW_SCHEMA, LEGACY_VIEW_SCHEMA);
assert.deepEqual(patchCompactionWire(Buffer.from(legacy)), Buffer.from(golden));
assert.deepEqual(patchCompactionWire(Buffer.from(golden)), Buffer.from(golden), 'idempotent');
assert.throws(() => patchCompactionWire(Buffer.from('changed carrier')), /anchor changed/);
assert.throws(() => patchCompactionWire(Buffer.from(legacy + LEGACY_VIEW_SCHEMA)), /anchor changed/);
assert.throws(() => patchCompactionWire(Buffer.from(marker + golden)), /malformed or duplicate/);

function load(bytes, overrides = {}) {
  let registration;
  const errors = [];
  vm.runInNewContext(bytes, {
    window: {__ModuleLoader__: {load: value => {registration = value;}}},
    URL, URLSearchParams, TextDecoder, AbortSignal, AbortController,
    setTimeout, clearTimeout, queueMicrotask,
    console: {error: (...args) => errors.push(args), log: () => {}},
    ...overrides,
  });
  assert.equal(registration.id, '@xharness/dsh-client-connection');
  const api = registration.factory(id => {throw new Error('unexpected dependency: ' + id);});
  return {api, errors};
}
const old = load(legacy), current = load(source);
async function history(api, value) {
  class Fixture extends api.AbstractApiClient {
    mintRpcId() {return 'wire-test';}
    async postJson(path, request) {
      assert.equal(path, '/api/session.history');
      return {json: async () => ({type: 'server-response', rpcId: request.rpcId, result: {ok: true, value}})};
    }
  }
  const response = await new Fixture().sessions.history({sessionId: 'fixture'});
  assert.equal(response.result.ok, true);
  return plain(response.result.value);
}
const event = (seq, type = 'test/fact', data = {}) => ({seq, time: 1000 + seq, type, data});
const view = (phase = 'running') => ({for: 'compaction', view: {
  schemaVersion: 1, id: 'compact-1', phase, anchorSeq: 67, time: 1067,
  progress: {stage: 'summarizing', calls: 2, completedParts: 1},
  sourceCommandId: 'command-1', futureField: {unicode: '中文🙂'},
  ...(phase === 'succeeded' ? {summary: '完整摘要：α + β 🙂', summaryEventSeq: 69, shadowedItemCount: 4, shadowedTokenCount: 1200} : {}),
}});
// Same offending indexes as the real installed application's failing page.
const input = {events: Array.from({length: 72}, (_, seq) => ({event: event(seq)})), hasMore: true};
input.events[67] = {event: event(67, 'compaction/start', {compactionId: 'compact-1'}), view: view()};
input.events[70] = {event: event(70, 'compaction/end', {compactionId: 'compact-1'}), view: view('succeeded')};
const original = plain(input);
await assert.rejects(history(old.api, input), error => {
  assert.deepEqual(plain(error.issues.map(issue => issue.path)), [['events', 67, 'view', 'for'], ['events', 70, 'view', 'for']]);
  assert.ok(error.issues.every(issue => issue.code === 'invalid_union' && issue.discriminator === 'for'));
  return true;
});
assert.deepEqual(await history(current.api, input), input, 'entire page, durable facts and opaque versioned fields survive');
assert.deepEqual(input, original, 'no mutation of source events');

let checks = 0;
for (const phase of ['running', 'succeeded', 'failed']) {
  for (const schemaVersion of [1, 99]) {
    const metadata = view(phase); metadata.view.schemaVersion = schemaVersion;
    for (const entries of [[], [{event: event(1), view: metadata}], input.events]) {
      const page = {events: entries, hasMore: false};
      assert.deepEqual(await history(current.api, page), page); checks++;
    }
  }
}
for (const metadata of [
  undefined,
  {for: 'call', view: {card: 'Bash', extra: {command: 'echo ok'}}},
  {for: 'result', view: {card: 'Bash result', extra: {exitCode: 0}}},
  // Domain-invalid compaction metadata must reach the domain fallback, not
  // reject an otherwise valid history page. Reducer tests cover that fallback.
  {for: 'compaction', view: {schemaVersion: 1, anchorSeq: -1}},
  {for: 'compaction', view: {}},
]) {
  const entry = {event: event(1), ...(metadata ? {view: metadata} : {})};
  const page = {events: [entry], hasMore: false};
  assert.deepEqual(await history(current.api, page), page); checks++;
}
for (const bad of [
  {for: 'unknown', view: {}}, {for: 'compaction', view: null},
  {for: 'compaction', view: []}, {for: 'compaction', view: 'wrong'},
  {for: 'call', view: {}}, {for: 'result', view: {card: 1}}, {},
]) {
  await assert.rejects(history(current.api, {events: [{event: event(1), view: bad}], hasMore: false})); checks++;
}
await assert.rejects(history(current.api, {events: [{event: {...event(1), seq: -1}, view: view()}], hasMore: false}), 'durable event validation stays strict');

const frames = [
  {type: 'session/event', sessionId: 'fixture', event: event(67, 'compaction/start'), view: view()},
  {type: 'session/event', sessionId: 'fixture', event: event(70, 'compaction/end'), view: view('succeeded')},
  {type: 'session/event', sessionId: 'fixture', event: event(71, 'turn/end')},
];
const envelopes = frames.map((payload, index) => ({type: 'server-request', rpcId: 'live-' + index, method: 'session.event', payload}));
async function sse(loaded, chunkSize) {
  const bytes = new TextEncoder().encode(envelopes.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join(''));
  class Fixture extends loaded.api.AbstractApiClient {
    async doFetch(url) {
      assert.equal(url.pathname, '/api/events.mux');
      let position = 0;
      return new Response(new ReadableStream({pull(controller) {
        if (position === bytes.length) {controller.close(); return;}
        controller.enqueue(bytes.slice(position, position + chunkSize)); position = Math.min(position + chunkSize, bytes.length);
      }}));
    }
  }
  const received = [];
  for await (const row of new Fixture().openMux({}, new AbortController().signal)) received.push(plain(row));
  return received;
}
const expectedLive = envelopes.map(({rpcId, payload}) => ({rpcId, payload}));
assert.deepEqual(await sse(old, 1), expectedLive.slice(2), 'old live decoder dropped compaction events');
assert.equal(old.errors.length, 2);
for (const size of [1, 7, 4096]) {
  assert.deepEqual(await sse(current, size), expectedLive, 'real SSE schema and arbitrary Unicode chunks'); checks++;
}
assert.equal(current.errors.length, 0);

// The actual browser uses WebSocket, not AbstractApiClient's SSE carrier.
// Get WebApiClient through the real plugin apply() and simulate only the socket.
async function websocket(bytes) {
  class Socket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; readyState = 1;
    constructor(url) {
      super(); assert.equal(url.pathname, '/api/events.mux');
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        for (const row of envelopes) this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(row)}));
        this.readyState = 3; this.dispatchEvent(new Event('close'));
      });
    }
    close() {this.readyState = 3; this.dispatchEvent(new Event('close'));}
  }
  const loaded = load(bytes, {WebSocket: Socket});
  let connection;
  loaded.api.apply({provide: (name, value) => {assert.equal(name, 'connection'); connection = value;}});
  const received = [];
  for await (const row of connection.api.openMux({}, new AbortController().signal)) received.push(plain(row));
  return {received, errors: loaded.errors};
}
assert.deepEqual((await websocket(legacy)).received, expectedLive.slice(2));
const liveBrowser = await websocket(source);
assert.deepEqual(liveBrowser.received, expectedLive);
assert.equal(liveBrowser.errors.length, 0);

// Build synchronization must update the loader revision and the boot graph,
// otherwise old bytes may stay cached even though a file changed on disk.
const temp = mkdtempSync(join(tmpdir(), 'xh-compaction-wire-'));
try {
  const path = join(temp, 'plugins/@xharness/dsh-client-connection'); mkdirSync(path, {recursive: true});
  writeFileSync(join(path, 'client.js'), legacy);
  const graph = {rev: 'old', entries: [{id: '@xharness/dsh-client-connection', rev: 'old', url: '/plugins/@xharness/dsh-client-connection/client.js?rev=old'}]};
  writeFileSync(join(temp, 'client-graph.json'), JSON.stringify(graph));
  writeFileSync(join(temp, 'index.html'), `<link href="${graph.entries[0].url}"><script>window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`);
  const revision = syncCompactionWire(temp), once = readFileSync(join(temp, 'index.html'), 'utf8');
  assert.equal(syncCompactionWire(temp), revision, 'sync idempotent');
  assert.equal(readFileSync(join(temp, 'index.html'), 'utf8'), once);
  assert.doesNotMatch(once, /rev=old/);
  assert.ok(once.includes(JSON.parse(readFileSync(join(temp, 'client-graph.json'), 'utf8')).entries[0].url));
} finally {rmSync(temp, {recursive: true, force: true});}
console.log(`compaction wire: baseline reproduced at indexes 67/70; actual unary, SSE, WebSocket decode, ${checks} compatibility cases, loader revisions passed`);
