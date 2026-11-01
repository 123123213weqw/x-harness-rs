#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { provenance, verifyUnchanged } from './provenance.mjs';

if (process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw new Error('Run only on the isolated test server');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runProvenance = await provenance(repository);
const fixture = await startFixture();
const artifacts = await mkdtemp(resolve(tmpdir(), 'xharness-browser-stdio-'));
const child = spawn(process.execPath, [resolve(repository, 'plugins/browser-use/server.mjs')], {
  cwd: repository,
  env: { ...process.env, XHARNESS_BROWSER_ALLOWED_ORIGINS: JSON.stringify([fixture.origin]), XHARNESS_BROWSER_ARTIFACT_ROOT: artifacts },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let sequence = 0, stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
const lines = createInterface({ input: child.stdout });
lines.on('line', raw => {
  let packet;
  try { packet = JSON.parse(raw); } catch { return; }
  const request = pending.get(packet.id);
  if (request) { clearTimeout(request.timer); pending.delete(packet.id); request.resolve(packet.result); }
});
child.on('exit', (code, signal) => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code ?? signal}: ${stderr}`)); }
  pending.clear();
});
function request(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = arguments_ => request('tools/call', { name: 'browser', arguments: arguments_ });
function payload(result) { const text = result.content.find(item => item.type === 'text'); assert.ok(text); return JSON.parse(text.text); }
const cases = [];
let failed = 0;
async function check(id, body) {
  try { await body(); cases.push({ id, status: 'passed' }); console.log(`ok ${cases.length} - ${id}`); }
  catch (error) { failed++; const message = error instanceof Error ? error.stack : String(error); cases.push({ id, status: 'failed', error: message }); console.log(`not ok ${cases.length} - ${id}\n# ${message}`); }
}
console.log('TAP version 13');
try {
  await check('initialize-and-schema', async () => {
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xharness-acceptance', version: '1' } });
    assert.equal(initialized.serverInfo.name, 'xharness-browser-use');
    const tools = await request('tools/list');
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, 'browser');
    assert.match(tools.tools[0].description, /Isolated headless background browser, not the visible XHarness WebView/);
    assert.match(tools.tools[0].description, /Do not transfer cookies\/profiles or silently switch backends/);
    assert.ok(tools.tools[0].description.length <= 2000, 'Host preserves the complete routing/tool description');
    for (const action of ['tabs', 'close', 'screenshot', 'mouse', 'dialog', 'upload', 'download', 'wait']) assert.ok(tools.tools[0].inputSchema.properties.action.enum.includes(action));
  });
  await check('legacy-navigation-observation', async () => {
    const result = await call({ action: 'navigate', url: `${fixture.origin}/?id=stdio` });
    assert.notEqual(result.isError, true);
    const data = payload(result);
    assert.ok(data.observation.frame_id);
    assert.ok(data.observation.nodes.some(node => node.label === 'Native action'));
    assert.equal(data.observation.supports.iframes, true);
  });
  await check('semantic-command-executes-trusted-input', async () => {
    const result = await call({ action: 'click', target: { by: 'role', role: 'button', name: 'Native action' } });
    assert.equal(payload(result).outcome, 'applied');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(await fixture.state('stdio')).events.some(event => event.kind === 'native')) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok((await fixture.state('stdio')).events.some(event => event.kind === 'native' && event.trusted));
  });
  await check('MCP-screenshot-is-real-image-block-not-text-base64', async () => {
    const result = await call({ action: 'screenshot' });
    assert.notEqual(result.isError, true);
    const data = payload(result);
    assert.equal(data.outcome, 'applied');
    const images = result.content.filter(item => item.type === 'image');
    assert.equal(images.length, 1, 'Exactly one MCP image content block is required');
    const image = images[0];
    assert.equal(image.mimeType, 'image/png');
    assert.equal(typeof image.data, 'string', 'MCP image data must be base64 wire data, not a text content block');
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.toString('base64'), image.data, 'Image data must use canonical base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'A genuine PNG signature is required');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR', 'PNG dimensions must come from an IHDR chunk');
    assert.equal(png.readUInt32BE(16), data.result.viewport.width);
    assert.equal(png.readUInt32BE(20), data.result.viewport.height);
    for (const block of result.content.filter(item => item.type === 'text')) assert.ok(!block.text.includes(image.data.slice(0, 100)), 'Image bytes must not enter any text receipt');
  });
  await check('invalid-command-is-rejected-without-browser-effect', async () => {
    const before = (await fixture.state('stdio')).events.length;
    const result = await call({ action: 'click', target: { by: 'role', role: 'button', name: 'Native action' }, arbitrary_eval: 'process.env' });
    assert.equal(result.isError, true);
    assert.equal(payload(result).outcome, 'not-started');
    assert.equal((await fixture.state('stdio')).events.length, before);
    const snapshot = payload(await call({ action: 'observe' })).observation;
    const node = snapshot.nodes.find(node => node.label === 'Native action'); assert.ok(node);
    const target = { ref: node.ref, observationId: snapshot.observationId };
    const malformed = [
      [{ action: 'fill', target, value: 'SENSITIVE_SENTINEL' }, /arguments\.(text|value)/],
      [{ action: 'click', target: { ref: node.ref } }, /target\.observationId/],
      [{ action: 'click', target: { ...target, frameId: 'unused' } }, /target\.frameId/],
      [{ action: 'observe', observationId: snapshot.observationId }, /arguments\.observationId/],
      [{ action: 'click', target: { role: 'button', name: 'Native action' } }, /target\.by/],
    ];
    for (const [arguments_, expected] of malformed) {
      const invalid = await call(arguments_);
      assert.equal(invalid.isError, true);
      const detail = payload(invalid);
      assert.equal(detail.outcome, 'not-started');
      assert.match(detail.error, expected);
      assert.ok(!detail.error.includes('SENSITIVE_SENTINEL'));
      assert.equal((await fixture.state('stdio')).events.length, before);
    }
    // Malformed requests must not reach the engine or invalidate its current refs.
    const recovered = payload(await call({ action: 'click', target }));
    assert.equal(recovered.outcome, 'applied');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await fixture.state('stdio')).events.filter(event => event.kind === 'native').length < 2) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fixture.state('stdio')).events.filter(event => event.kind === 'native' && event.trusted).length, 2);
  });
  await check('explicit-tab-create-and-close-through-MCP', async () => {
    const created = payload(await call({ action: 'new', url: `${fixture.origin}/popup?id=stdio` }));
    assert.equal(created.outcome, 'applied');
    const closed = payload(await call({ action: 'close', targetTabId: created.tabId }));
    assert.equal(closed.outcome, 'applied');
    const tabs = payload(await call({ action: 'tabs' }));
    assert.ok(!tabs.result.some(tab => tab.tabId === created.tabId));
  });
} finally {
  child.stdin.end();
  await new Promise(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 2000);
    const hard = setTimeout(() => { child.kill('SIGKILL'); }, 7000);
    child.once('exit', () => { clearTimeout(timer); clearTimeout(hard); resolve(); });
  });
  lines.close();
  await fixture.close();
  await rm(artifacts, { recursive: true, force: true });
}
await verifyUnchanged(repository, runProvenance);
console.log(`1..${cases.length}`);
const report = { schema: 'xharness.browser-use.stdio-acceptance.v1', provenance: runProvenance, generatedAt: new Date().toISOString(), environment: 'isolated server Chromium and actual stdio MCP; no user profile; no LLM', caveat: 'MCP image blocks verified here; Host/model media projection is a separate Rust acceptance gate', totals: { cases: cases.length, passed: cases.length - failed, failed }, cases };
if (process.env.BROWSER_STDIO_EVIDENCE) { const output = resolve(process.env.BROWSER_STDIO_EVIDENCE); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
process.exitCode = failed ? 1 : 0;
