// Exercise the shipped assembler and Definition together, not a toy reducer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchCompactionViewModel } from './patch-compaction-view-model.mjs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const runtimeSource = read('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js');
const ui = read('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
const fixtures = JSON.parse(read('../tests/fixtures/compaction-ui.json')).filter(f => !f.manual);
let registration;
vm.runInNewContext(runtimeSource, {
  window: { __ModuleLoader__: { load: value => { registration = value; } } },
  console, URL, AbortController, setTimeout, clearTimeout,
});
const runtime = registration.factory(id => id === '@xharness/cordis' ? { Service: class {} } : {});
const context = vm.createContext({ _xharness_dsh_client_runtime_client: runtime });
for (const name of ['contextLocation', 'chatNode']) {
  const start = ui.indexOf(`function ${name}(`), end = ui.indexOf('\n\t\t}', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(ui.slice(start, end + 4), context);
}
const start = ui.indexOf('const COMPACT_PLUGIN = "compact";');
const end = ui.indexOf('//#endregion', ui.indexOf('function registerCompactionConversationNode', start));
vm.runInContext(ui.slice(start, end) + '\nglobalThis.definition=compactionDefinition;', context);
const definition = context.definition;
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function assembler(def = definition) {
  return new runtime.ConversationNodeAssembler(
    { entries: () => [def], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => {
      let nodes = new Map();
      return {
        empty: [],
        replace: value => { nodes = new Map(value.nodes.map(n => [n.key, n])); return [...nodes.values()]; },
        apply: value => { for (const n of value.upserts) nodes.set(n.key, n); return [...nodes.values()]; },
      };
    } }] },
  );
}
function snapshot(a) { return plain(a.snapshot('chat')).sort((a, b) => a.key.localeCompare(b.key)); }
function wire(f, mode) {
  const start = f.events.find(e => e.type === 'compaction/start');
  const summary = f.events.find(e => e.type === 'compaction/summary');
  const checkpoint = f.events.find(e => e.surfaceOp?.op === 'replace');
  return f.events.map(event => {
    const row = { event: plain(event) };
    if (mode === 'legacy') return row;
    if (event.type === 'compaction/start' && mode !== 'end-view-only') row.view = { for: 'compaction', view: {
      schemaVersion: 1, id: event.data.compactionId, phase: 'running', anchorSeq: event.seq, time: event.time,
    } };
    if (event.type === 'compaction/end' && mode !== 'mixed') row.view = { for: 'compaction', view: f.error ? {
      schemaVersion: 1, id: event.data.compactionId, phase: 'failed', anchorSeq: start.seq, time: start.time,
    } : {
      schemaVersion: 1, id: event.data.compactionId, phase: 'succeeded', anchorSeq: checkpoint.seq, time: checkpoint.time,
      summary: summary.data.summary.map(b => b.type === 'text' ? b.text : '').join(''),
      summaryEventSeq: summary.seq, shadowedItemCount: summary.data.shadowedSeqs.length, shadowedTokenCount: summary.data.shadowedTokenCount,
    } };
    if (event.type === 'compaction/end' && mode === 'unsupported') row.view.view.schemaVersion = 99;
    if (event.type === 'compaction/end' && mode === 'malformed') row.view.view.anchorSeq = -1;
    return row;
  });
}
function exercise(input, label, failed) {
  const full = assembler(); full.replaceWindow(input, false); full.flush();
  const expected = snapshot(full);
  assert.equal(expected.length, 1, label);
  assert.equal(expected[0].visibility, failed ? 'hidden' : 'visible', label);
  const live = assembler();
  let runningKey;
  for (const [index, entry] of input.entries()) {
    live.append(entry); live.flush();
    const prefix = assembler(); prefix.replaceWindow(input.slice(0, index + 1), false); prefix.flush();
    assert.deepEqual(snapshot(live), snapshot(prefix), label + ' every intermediate state ' + index); checks++;
    if (entry.event.type === 'compaction/start') {
      const node = snapshot(live)[0];
      assert.equal(node.data.status, 'running', label);
      runningKey = node.key;
    }
    const before = snapshot(live);
    live.append(entry); live.flush();
    assert.deepEqual(snapshot(live), before, label + ' duplicate'); checks++;
  }
  assert.equal(snapshot(live)[0].key, runningKey, label + ' stable key');
  assert.deepEqual(snapshot(live), expected, label + ' live versus reload'); checks++;
  // Opening during generation, then receiving the remaining live tail.
  for (let split = 0; split <= input.length; split++) {
    const resumed = assembler(); resumed.replaceWindow(input.slice(0, split), false); resumed.flush();
    for (const row of input.slice(split)) { resumed.append(row); resumed.flush(); }
    assert.deepEqual(snapshot(resumed), expected, label + ' reconnect at ' + split); checks++;
  }
  const batched = assembler(); for (const entry of input) batched.append(entry); batched.flush();
  assert.deepEqual(snapshot(batched), expected, label + ' batched'); checks++;
  for (let split = 0; split <= input.length; split++) {
    const paged = assembler(); paged.replaceWindow(input.slice(split), split > 0); paged.flush();
    paged.prepend(input.slice(0, split), false); paged.flush();
    assert.deepEqual(snapshot(paged), expected, label + ' page split ' + split); checks++;
    paged.prepend(input.slice(0, split), false); paged.flush();
    assert.deepEqual(snapshot(paged), expected, label + ' repeated page'); checks++;
  }
  const endOnly = input.slice(-1);
  if (endOnly[0].view?.view.schemaVersion === 1 && endOnly[0].view.view.anchorSeq >= 0) {
    const partial = assembler(); partial.replaceWindow(endOnly, true); partial.flush();
    const node = snapshot(partial)[0];
    assert.ok(node, label + ' terminal-only page renders without inventing start');
    assert.deepEqual(node.data, expected[0].data, label + ' terminal-only data'); checks++;
  }
}
for (const [i, f] of fixtures.entries())
  for (const mode of ['legacy', 'projected', 'mixed', 'end-view-only', 'unsupported', 'malformed']) exercise(wire(f, mode), `fixture ${i} ${mode}`, Boolean(f.error));
// Repeated compactions own independent keys; a failed attempt cannot keep
// the next successful compaction in running/hidden state.
const combined = [];
for (const [index, f] of fixtures.entries()) {
  const offset = combined.length;
  for (const row of wire(f, 'projected')) {
    row.event.seq += offset;
    if (row.event.data.turn !== undefined) row.event.data.turn = index;
    if (row.event.data.compactionId) row.event.data.compactionId += '-' + index;
    if (row.event.data.source?.compactionId) row.event.data.source.compactionId += '-' + index;
    if (row.view) {
      row.view.view.id += '-' + index;
      row.view.view.anchorSeq += offset;
      if (row.view.view.summaryEventSeq !== undefined) row.view.view.summaryEventSeq += offset;
    }
    combined.push(row);
  }
}
const multi = assembler(); multi.replaceWindow(combined, false); multi.flush();
const liveMulti = assembler(); for (const row of combined) { liveMulti.append(row); liveMulti.flush(); }
assert.deepEqual(snapshot(liveMulti), snapshot(multi));
assert.equal(snapshot(multi).length, fixtures.length);
assert.equal(snapshot(multi).filter(n => n.visibility === 'visible').length, 1); checks += 3;
// Prove the real engine rejects the original null-withdrawal regression.
const broken = assembler({ ...definition, buildViewNode: context => {
  const node = definition.buildViewNode(context);
  return node?.visibility === 'hidden' ? null : node;
} });
const failure = wire(fixtures.find(f => f.error), 'legacy');
for (const row of failure.slice(0, -1)) { broken.append(row); broken.flush(); }
broken.append(failure.at(-1));
assert.throws(() => broken.flush(), /withdrew materialized target/); checks++;
// A fresh assembly must produce the same reducer/Definition as the shipped bundle.
const fresh = patchCompactionViewModel(Buffer.from(read('../tests/fixtures/compaction-definition-legacy.js'))).toString();
for (const name of ['updateCompactionState', 'fallbackState$2', 'projectedCompactionView']) {
  const extract = source => {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n\t\t}', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end + 4);
  };
  assert.equal(extract(fresh), extract(ui), name + ' fresh assembly matches shipped'); checks++;
}
const generatedContext = vm.createContext({ compactSource: context.compactSource, chatNode: context.chatNode });
vm.runInContext(fresh + '\nglobalThis.definition=compactionDefinition;', generatedContext);
for (const row of wire(fixtures[1], 'projected'))
  assert.deepEqual(plain(generatedContext.definition.match(row.event, row.view)), plain(definition.match(row.event, row.view)));
assert.deepEqual(patchCompactionViewModel(Buffer.from(fresh)), Buffer.from(fresh), 'fresh patch idempotence');
assert.deepEqual(patchCompactionViewModel(Buffer.from(ui)), Buffer.from(ui), 'patch idempotence');
console.log(`compaction projection: ${checks} checks; shipped assembler live/reload/batched/all page splits/duplicate/mixed/terminal-only passed`);
