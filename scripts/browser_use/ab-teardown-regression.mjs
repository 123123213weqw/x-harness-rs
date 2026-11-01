#!/usr/bin/env node
// Native MCP cleanup regression, not a model evaluation. Never relabel old trials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startAbFixture } from './ab-fixture.mjs';

if (process.platform !== 'linux' || process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw Error('Only run on isolated V100, after paid model trials stop');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); if (!value.startsWith('--') || at < 0) throw Error('Use --output=NEW_DIRECTORY [--repeats=10]'); return [value.slice(2, at), value.slice(at + 1)]; }));
assert.ok(args.output, 'Explicit new evidence directory required');
const repeats = Number(args.repeats ?? 10);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 20);
const output = resolve(args.output); await mkdir(output, { recursive: false, mode: 0o700 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = value => JSON.parse(JSON.stringify(value));
async function settle(predicate, maxMs = 500) { const start = performance.now(); while (!predicate() && performance.now() - start < maxMs) await pause(10); return { elapsedMs: Math.round(performance.now() - start), achieved: predicate() }; }

async function tinyFixture() {
  const rows = new Map(), timers = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture'), parts = url.pathname.split('/').filter(Boolean), state = rows.get(parts[1]);
    if (parts[0] !== 'tiny' || !state) { response.writeHead(404); response.end(); return; }
    if (parts[2] === 'clicked') {
      state.events.push({ kind: 'native-click-audit', at: Date.now(), trusted: url.searchParams.get('trusted') === 'true', x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) });
      response.writeHead(200); response.end('recorded'); return;
    }
    if (parts[2] === 'commit') { state.events.push({ kind: 'commit', at: Date.now() }); state.committed = true; response.writeHead(200); response.end('committed'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Delayed commit teardown regression</title><style>button{position:absolute;left:100px;top:100px;width:180px;height:60px;font:16px sans-serif}</style><button>Save local test state</button><script>
      document.querySelector('button').addEventListener('click',event=>{
        // Synchronous audit ONLY proves the trusted click happened before cleanup.
        // The task effect is deliberately separate, asynchronously committed 100ms later.
        const audit=new XMLHttpRequest();audit.open('GET',location.pathname+'/clicked?trusted='+event.isTrusted+'&x='+event.clientX+'&y='+event.clientY,false);audit.send();
        setTimeout(()=>fetch(location.pathname+'/commit',{method:'POST'}),100);
      });</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, create() { const id = randomUUID(); rows.set(id, { committed: false, events: [] }); return { id, url: `${this.origin}/tiny/${id}` }; }, state: id => snapshot(rows.get(id)), async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
async function candidate(origin, artifactRoot) {
  const child = spawn(process.execPath, [resolve(repository, 'plugins/browser-use/server.mjs')], { cwd: repository, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', XHARNESS_BROWSER_ALLOWED_ORIGINS: JSON.stringify([origin]), XHARNESS_BROWSER_ARTIFACT_ROOT: artifactRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { let packet; try { packet = JSON.parse(line); } catch { return; } const slot = pending.get(packet.id); if (!slot) return; pending.delete(packet.id); clearTimeout(slot.timer); packet.error ? slot.reject(Error(JSON.stringify(packet.error))) : slot.resolve(packet.result); });
  child.on('exit', (code, signal) => { for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(Error(`MCP exited ${code ?? signal}: ${stderr}`)); } pending.clear(); });
  function rpc(method, params = {}) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP ${method} timeout`)); }, 30000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
  const api = { async call(command) { const wire = await rpc('tools/call', { name: 'browser', arguments: command }); const content = wire.content?.find(item => item.type === 'text'); assert.ok(content, JSON.stringify(wire)); const receipt = JSON.parse(content.text); assert.notEqual(wire.isError, true, JSON.stringify(receipt)); assert.ok(receipt.outcome === 'applied' || receipt.performed?.effect === 'applied', JSON.stringify(receipt)); return { receipt, images: wire.content.filter(item => item.type === 'image').map(item => ({ sha256: hash(Buffer.from(item.data, 'base64')), bytes: Buffer.from(item.data, 'base64').length })) }; }, async close() { child.stdin.end(); await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); const soft = setTimeout(() => child.kill('SIGTERM'), 1500), hard = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(soft); clearTimeout(hard); resolve(); }); }); lines.close(); } };
  try { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'terminal-effect-regression', version: '1' } }); return api; } catch (error) { await api.close(); throw error; }
}
const tiny = await tinyFixture(), modal = await startAbFixture(), rows = [];
let failures = 0;
try {
  for (let repeat = 0; repeat < repeats; repeat++) for (const scenario of ['synthetic-100ms', 'original-modal']) for (const mode of repeat % 2 ? ['passive-settle', 'immediate-close'] : ['immediate-close', 'passive-settle']) {
    const start = performance.now(), artifactRoot = await mkdtemp(join(output, 'browser-'));
    let backend; const evidence = { scenario, mode, repeat, status: 'failed', setup: 'Known-target test setup, no model, no answer inserted into any prompt', trace: [] };
    try {
      const run = scenario === 'synthetic-100ms' ? tiny.create() : modal.createRun({ taskId: 'modal-rules', seed: '20261325', arm: `teardown-${mode}-${repeat}` });
      const state = scenario === 'synthetic-100ms' ? () => tiny.state(run.id) : () => modal.evidence(run.runId).state;
      const done = scenario === 'synthetic-100ms' ? () => state().committed : () => modal.score(run.runId).success;
      backend = await candidate(scenario === 'synthetic-100ms' ? tiny.origin : modal.origin, artifactRoot);
      async function call(command) { const result = await backend.call(command); evidence.trace.push({ command, receipt: result.receipt, images: result.images }); return result.receipt; }
      await call({ action: 'navigate', url: run.url });
      if (scenario === 'original-modal') {
        const expected = modal.evidence(run.runId).expected; assert.equal(expected.correct, 'modal-rules-5770-2');
        await call({ action: 'click', target: { by: 'role', role: 'button', name: '关闭', exact: true } });
        const ready = await settle(() => state().modal === null, 1000); assert.equal(ready.achieved, true);
        const observed = await call({ action: 'observe' });
        const nodes = observed.observation?.nodes ?? observed.result?.nodes;
        assert.ok(nodes?.some(node => node.label === '样机运输 5770-3'), 'Original target must be rendered before the final click');
        evidence.expected = expected; evidence.scenarioHash = run.scenarioHash;
      }
      const raster = await call({ action: 'screenshot' }); assert.equal(raster.result.actionable, true); assert.deepEqual(raster.result.viewport, { width: 1280, height: 800 });
      // Exact final mouse coordinates from the preserved main1 PNG for original-modal.
      const point = scenario === 'synthetic-100ms' ? { x: 190, y: 130 } : { x: 180, y: 281 };
      evidence.beforeMouse = state();
      const dispatchStart = performance.now(); await call({ action: 'mouse', screenshotId: raster.result.screenshotId, ...point, operation: 'click' }); evidence.mouseReceiptMs = Math.round(performance.now() - dispatchStart);
      evidence.immediateOracle = { passed: done(), state: state() };
      if (scenario === 'synthetic-100ms') {
        const native = state().events.find(event => event.kind === 'native-click-audit');
        assert.ok(native, 'Native audit must have reached server before MCP mouse returned'); assert.equal(native.trusted, true); assert.equal(native.x, point.x); assert.equal(native.y, point.y);
      }
      if (mode === 'passive-settle') { evidence.settle = await settle(done, 500); assert.equal(evidence.settle.achieved, true, 'Effect must reach actual server state before cleanup'); }
      evidence.preCleanupOracle = { passed: done(), state: state() };
      await backend.close(); backend = null;
      evidence.afterCleanupOracle = { passed: done(), state: state() };
      if (scenario === 'original-modal' && evidence.preCleanupOracle.passed) {
        const select = modal.evidence(run.runId).events.find(event => event.kind === 'action' && event.action.type === 'select'); assert.equal(select?.action.trusted, true); assert.equal(select.action.id, evidence.expected.correct);
      }
      evidence.fixtureEvents = scenario === 'synthetic-100ms' ? tiny.state(run.id).events : modal.evidence(run.runId).events;
      evidence.status = 'passed';
    } catch (error) { failures++; evidence.error = error.stack ?? String(error); }
    finally { await backend?.close(); evidence.elapsedMs = Math.round(performance.now() - start); await rm(artifactRoot, { recursive: true, force: true }); rows.push(evidence); await writeFile(join(output, `${scenario}-${mode}-${repeat}.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ scenario, mode, repeat, status: evidence.status, immediateFound: evidence.immediateOracle?.passed, preCleanupFound: evidence.preCleanupOracle?.passed, afterCleanupFound: evidence.afterCleanupOracle?.passed, error: evidence.error })); }
  }
  const counts = [];
  for (const scenario of ['synthetic-100ms', 'original-modal']) for (const mode of ['immediate-close', 'passive-settle']) { const group = rows.filter(row => row.scenario === scenario && row.mode === mode); counts.push({ scenario, mode, trials: group.length, errors: group.filter(row => row.status !== 'passed').length, immediateFound: group.filter(row => row.immediateOracle?.passed).length, beforeCleanupFound: group.filter(row => row.preCleanupOracle?.passed).length, afterCleanupFound: group.filter(row => row.afterCleanupOracle?.passed).length, afterCleanupMissing: group.filter(row => row.afterCleanupOracle && !row.afterCleanupOracle.passed).length }); }
  const report = { passed: failures === 0, failures, repeats, counts, source: Object.fromEntries(await Promise.all(['scripts/browser_use/ab-teardown-regression.mjs', 'scripts/browser_use/ab-fixture.mjs', 'plugins/browser-use/server.mjs', 'plugins/browser-use/dist/engine.js', 'plugins/browser-use/dist/protocol.js', 'plugins/browser-use/dist/cdp-policy-bridge.js'].map(async path => [path, hash(await readFile(resolve(repository, path)))]))), boundary: 'No LLM calls. Synthetic100ms deliberately separates synchronous native-input audit from delayed task effect; original-modal uses unchanged real task and exact final coordinates. Immediate effects are reported as found/missing, never forced to fail. Passive settle performs no browser action or task changes and must achieve server oracle BEFORE cleanup. No old main1 result is relabeled.' };
  await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report, null, 2)); process.exitCode = failures ? 1 : 0;
} finally { await tiny.close(); await modal.close(); }
