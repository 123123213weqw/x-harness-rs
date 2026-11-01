#!/usr/bin/env node
// Native execution regressions: better guidance must not weaken reference guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserUseEngine } from '../../plugins/browser-use/dist/engine.js';
import { startFixture } from './fixture.mjs';
if (process.platform !== 'linux' || process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw Error('Run in the isolated V100 checkout');
const unwrap = receipt => { assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt)); return receipt.result; };
function denied(receipt, pattern) {
  assert.equal(receipt.outcome, 'not-started', JSON.stringify(receipt));
  assert.match(receipt.error?.message ?? '', pattern);
}
async function environment(body, large = false) {
  const fixture = await startFixture();
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'xh-reference-guidance-'));
  let engine;
  try {
    engine = await BrowserUseEngine.create({ artifactRoot, allowedOrigins: [fixture.origin], maxOutputChars: 5000, timeoutMs: 800 });
    unwrap(await engine.execute({ action: 'navigate', url: `${fixture.origin}/?id=guidance${large ? '&mode=large' : ''}` }));
    await body(engine, fixture);
  } finally { await engine?.close(); await fixture.close(); await rm(artifactRoot, { recursive: true, force: true }); }
}
async function events(fixture, kind) {
  let found = [];
  for (let i = 0; i < 100; i++) {
    found = (await fixture.state('guidance')).events.filter(row => row.kind === kind);
    if (found.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return found;
}
test('a consumed ref explains recovery, rejects replay and preserves one native effect', async () => environment(async (engine, fixture) => {
  const snapshot = unwrap(await engine.execute({ action: 'observe' }));
  const node = snapshot.nodes.find(node => node.name === 'Native action'); assert.ok(node);
  const command = { action: 'click', target: { ref: node.ref, observationId: snapshot.observationId } };
  unwrap(await engine.execute(command));
  const replay = await engine.execute(command);
  denied(replay, /new observation, effect or navigation invalidated it.*Call observe again.*observationId.*Do not blindly replay/);
  assert.equal((await events(fixture, 'native')).length, 1);
}));
test('clipped ref guidance points to pagination, and only freshly returned identities work', async () => environment(async (engine) => {
  const first = unwrap(await engine.execute({ action: 'observe' }));
  assert.ok(first.nodes.length); assert.notEqual(first.nextNodeOffset, null);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 5000);
  const omittedRef = `node-${first.nextNodeOffset}`;
  assert.ok(!first.nodes.some(node => node.ref === omittedRef));
  const missing = await engine.execute({ action: 'hover', target: { ref: omittedRef, observationId: first.observationId } });
  denied(missing, /current nodes\[\]\.ref.*nextNodeOffset.*Never combine an older ref/);
  const second = unwrap(await engine.execute({ action: 'observe', nodeOffset: first.nextNodeOffset }));
  assert.ok(second.nodes.some(node => node.ref === omittedRef));
  denied(await engine.execute({ action: 'hover', target: { ref: first.nodes[0].ref, observationId: first.observationId } }), /Stale observation/);
  // Neither stale nor unknown attempts are allowed to consume the current observation.
  const node = second.nodes.find(node => !node.disabled && node.bounds); assert.ok(node);
  unwrap(await engine.execute({ action: 'hover', target: { ref: node.ref, observationId: second.observationId } }));
}, true));
test('ambiguous target guidance never picks a matching button on behalf of the model', async () => environment(async (engine, fixture) => {
  const receipt = await engine.execute({ action: 'click', target: { by: 'role', role: 'button', name: 'Duplicate action' } });
  denied(receipt, /matched 2.*current node ref.*do not guess an index/);
  const state = await fixture.state('guidance');
  assert.ok(!state.events.some(row => row.kind === 'duplicate-a' || row.kind === 'duplicate-b'));
}));
