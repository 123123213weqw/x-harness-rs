import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ENGINE_CASE_IDS, STDIO_CASE_IDS, REFERENCE_COMMIT, LEGACY_SOURCE_SHA256, validateReports } from './evidence-validator.mjs';
import { sourcePaths, buildPaths, contentFingerprint, verifyCurrentProvenance } from './provenance.mjs';

function reports() {
  const cases = (ids, schema) => ({ schema, cases: ids.map(id => ({ id, status: 'passed' })), totals: { cases: ids.length, passed: ids.length, failed: 0 } });
  return {
    engine: { ...cases(ENGINE_CASE_IDS, 'xharness.browser-use.acceptance.v1'), referenceCommit: REFERENCE_COMMIT },
    stdio: cases(STDIO_CASE_IDS, 'xharness.browser-use.stdio-acceptance.v1'),
    legacy: { schema: 'xharness.browser-use.legacy-acceptance.v1', source: 'scripts/gui_bench/test_browser.mjs', sourceSha256: LEGACY_SOURCE_SHA256, status: 'passed', checks: 30, exitCode: 0, signal: null },
  };
}
const verdict = data => validateReports(data.engine, data.stdio, data.legacy);
test('accepts only the complete current case sets and exact legacy gate', () => {
  const result = verdict(reports());
  assert.equal(ENGINE_CASE_IDS.length, 24); assert.equal(STDIO_CASE_IDS.length, 6);
  assert.equal(result.passed, true);
});
for (const [name, mutate] of [
  ['green subset with honest subset totals', data => { data.engine.cases.pop(); data.engine.totals.cases--; data.engine.totals.passed--; }],
  ['duplicate case replacing a required case', data => { data.engine.cases.at(-1).id = data.engine.cases[0].id; }],
  ['unreviewed extra green case', data => { data.engine.cases.push({ id: 'unreviewed', status: 'passed' }); data.engine.totals.cases++; data.engine.totals.passed++; }],
  ['declared green totals hiding an actual failure', data => { data.engine.cases[0].status = 'failed'; }],
  ['missing totals', data => { delete data.engine.totals; }],
  ['skipped required case', data => { data.engine.cases[0].status = 'skipped'; }],
  ['wrong engine schema', data => { data.engine.schema = 'unrelated'; }],
  ['wrong reference commit', data => { data.engine.referenceCommit = 'old'; }],
  ['stdio green subset', data => { data.stdio.cases.pop(); data.stdio.totals.cases--; data.stdio.totals.passed--; }],
  ['legacy 29 checks', data => { data.legacy.checks = 29; }],
  ['legacy 31 checks without a reviewed baseline', data => { data.legacy.checks = 31; }],
  ['changed legacy source', data => { data.legacy.sourceSha256 = 'modified'; }],
  ['legacy nonzero exit', data => { data.legacy.exitCode = 1; }],
  ['legacy killed by signal', data => { data.legacy.signal = 'SIGTERM'; }],
]) {
  test(`rejects ${name}`, () => { const data = reports(); mutate(data); assert.equal(verdict(data).passed, false); });
}
test('retains genuine failed-case details rather than promoting a passing subset', () => {
  const data = reports(); data.engine.cases[0].status = 'failed'; data.engine.totals.passed--; data.engine.totals.failed++;
  const result = verdict(data);
  assert.equal(result.passed, false);
  assert.equal(result.gates.engine.validEvidence, true);
  assert.deepEqual(result.gates.engine.failedIds, ['trusted']);
  assert.equal(result.gates.stdio.passed, true);
});
test('rejects externally detected stale provenance even when every case is green', () => {
  const data = reports();
  const result = validateReports(data.engine, data.stdio, data.legacy, { engine: ['Source hashes are stale'] });
  assert.equal(result.passed, false); assert.equal(result.gates.engine.validEvidence, false);
  assert.match(result.gates.engine.errors.join('\n'), /stale/);
});
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'xharness-evidence-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [...sourcePaths, ...buildPaths]) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), `fixture ${path}\n`);
  }
  const hashes = await contentFingerprint(root);
  return { root, recorded: { ...hashes, loadedEngine: { path: 'plugins/browser-use/dist/engine.js', sha256: hashes.buildHashes['plugins/browser-use/dist/engine.js'] } } };
}
test('accepts matching file provenance without loading Playwright or starting Chromium', async t => {
  const { root, recorded } = await fixture(t); await verifyCurrentProvenance(root, recorded);
});
for (const [name, path] of [
  ['stale engine source', 'plugins/browser-use/src/engine.ts'],
  ['stale compiled engine', 'plugins/browser-use/dist/engine.js'],
  ['changed MCP launcher manifest', 'plugins/browser-use/.mcp.json'],
  ['changed plugin manifest', 'plugins/browser-use/.claude-plugin/plugin.json'],
  ['new source outside the fixed path list', 'plugins/browser-use/src/new-bridge.ts'],
  ['new built module outside the fixed path list', 'plugins/browser-use/dist/new-bridge.js'],
]) {
  test(`rejects ${name}`, async t => {
    const { root, recorded } = await fixture(t);
    await writeFile(resolve(root, path), 'changed after acceptance');
    await assert.rejects(() => verifyCurrentProvenance(root, recorded), /changed during test execution/);
  });
}
test('rejects a missing required manifest even if the missing state was captured in evidence', async t => {
  const { root } = await fixture(t);
  await rm(resolve(root, 'plugins/browser-use/.mcp.json'));
  const hashes = await contentFingerprint(root);
  const recorded = { ...hashes, loadedEngine: { path: 'plugins/browser-use/dist/engine.js', sha256: hashes.buildHashes['plugins/browser-use/dist/engine.js'] } };
  await assert.rejects(() => verifyCurrentProvenance(root, recorded), /Missing source hash/);
});
test('rejects missing provenance', async () => { await assert.rejects(() => verifyCurrentProvenance('/unused', undefined), /lacks content-bound provenance/); });
