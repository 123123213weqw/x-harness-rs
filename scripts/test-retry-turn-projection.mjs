// The Rust projection test checks this same wire-coordinate fixture. Exercise
// the shipped assembler and turn-error reducer, not a replacement state machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {projectionArtifacts} from './projection-artifact-test.mjs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fixture = JSON.parse(read('./fixtures/retry-turn-projection.json'));
for(const implementation of ['source','legacy']) {
const {runtime,conversation}=projectionArtifacts(['turnErrorDefinition'],implementation);
const definition=conversation.turnErrorDefinition;
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
      ...(row.type === 'turn/end' ? { reason: { kind: 'error', error: { code: 'TRANSPORT', message: `turn ${row.turn} failed`,details:{} } } } : {}),
      // The shared Rust fixture is deliberately only the ownership coordinate
      // sequence. Fill the scheduled producer's independent facts identically
      // for both actual factories; do not test an invalid owner DTO by accident.
      ...(row.type.startsWith('llm/') ? { retryId: 'retry-1', retry: 1, step: 1,
        ...(row.type==='llm/retry'?{mode:'normal',maxRetries:2,delayMs:500,provider:'fixture',policyKey:'default',failure:{code:'TRANSPORT',message:'network'}}:{})} : {}),
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
console.log(implementation+' retry turn projection: live/reload/all page splits/duplicate delivery/error ownership passed; old numbering reproduces the failure');

}
