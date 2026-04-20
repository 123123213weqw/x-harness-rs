// The Rust projection test checks this same wire-coordinate fixture. Exercise
// the shipped assembler and turn-error reducer, not a replacement state machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const runtimeSource = read('../ui/dist/plugins/@xharness/dsh-client-runtime/client.js');
const ui = read('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js');
const fixture = JSON.parse(read('./fixtures/retry-turn-projection.json'));
let registration;
vm.runInNewContext(runtimeSource, {
  window: { __ModuleLoader__: { load: value => { registration = value; } } },
  console, URL, AbortController, setTimeout, clearTimeout,
});
const runtime = registration.factory(id => {
  if (id === '@xharness/cordis') return { Service: class {} };
  return {};
});
const context = vm.createContext({ _xharness_dsh_client_runtime_client: runtime });
for (const name of ['contextLocation', 'chatNode', 'lastStep$1', 'retryTurn', 'failureFrom', 'fallbackState']) {
  const start = ui.indexOf(`function ${name}(`);
  const end = ui.indexOf('\n\t\t}', start);
  assert.ok(start >= 0 && end > start, `missing shipped helper ${name}`);
  vm.runInContext(ui.slice(start, end + 4), context);
}
const start = ui.indexOf('const turnErrorDefinition = {');
const end = ui.indexOf('\n\t\t};', start);
assert.ok(start >= 0 && end > start, 'missing shipped turn-error definition');
const definition = vm.runInContext(ui.slice(start, end + 5) + '\nturnErrorDefinition', context);
const plain = value => JSON.parse(JSON.stringify(value));
function assembler() {
  return new runtime.ConversationNodeAssembler(
    { entries: () => [definition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => {
      let nodes = new Map();
      return {
        empty: [],
        replace: value => { nodes = new Map(value.nodes.map(node => [node.key, node])); return [...nodes.values()]; },
        apply: value => { for (const node of value.upserts) nodes.set(node.key, node); return [...nodes.values()]; },
      };
    } }] },
  );
}
function entries(offset = 0) {
  return fixture.map((row, seq) => ({ event: {
    seq, time: seq + 1, type: row.type,
    data: {
      turn: row.turn + offset,
      ...(row.type === 'turn/end' ? { reason: { kind: 'error', error: { code: 'TRANSPORT', message: `turn ${row.turn} failed` } } } : {}),
      ...(row.type.startsWith('llm/') ? { retryId: 'retry-1', retry: 1, step: 1 } : {}),
    },
  } }));
}
for (const offset of [0, 4]) {
  const input = entries(offset);
  const full = assembler();
  full.replaceWindow(input, false);
  full.flush();
  const expected = plain(full.snapshot('chat'));
  // Retry suppression belongs only to the retried turn, not the next failed turn.
  assert.deepEqual(expected.filter(node => node.visibility !== 'hidden').map(node => node.data.turn), [offset + 1]);
  const live = assembler();
  for (const entry of input) {
    live.append(entry);
    live.flush();
    live.append(entry); // duplicate delivery must remain idempotent
  }
  assert.deepEqual(plain(live.snapshot('chat')), expected);
  for (let split = 0; split <= input.length; split++) {
    const paged = assembler();
    paged.replaceWindow(input.slice(split), split > 0);
    paged.flush();
    paged.prepend(input.slice(0, split), false);
    paged.flush();
    const visible = nodes => plain(nodes).filter(node => node.visibility !== 'hidden');
    assert.deepEqual(visible(paged.snapshot('chat')), visible(expected), `pagination split ${split}`);
  }
  const broken = input.map(entry => ({ event: {
    ...entry.event,
    data: { ...entry.event.data, turn: entry.event.data.turn + (entry.event.type.startsWith('llm/') ? 1 : 0) },
  } }));
  assert.throws(() => assembler().replaceWindow(broken, false),
    new RegExp(`conversation Context 10:turn-error${offset + 1} received an update before its start Match`));
}
console.log('retry turn projection: live/reload/all page splits/duplicate delivery/error ownership passed; old numbering reproduces the failure');
