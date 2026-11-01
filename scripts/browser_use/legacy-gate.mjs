#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provenance, verifyUnchanged } from './provenance.mjs';
import { LEGACY_SOURCE_SHA256 } from './evidence-validator.mjs';

if (process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw new Error('Run only on the isolated test server');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runProvenance = await provenance(repository);
const script = resolve(repository, 'scripts/gui_bench/test_browser.mjs');
// Deliberately invoke the existing regression unchanged: no alternate assertions,
// monkey-patched responses, expected failures or compatibility-test substitution.
const source = await readFile(script);
const before = createHash('sha256').update(source).digest('hex');
const child = spawn(process.execPath, [script], { cwd: repository, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data.toString(); process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data.toString(); process.stderr.write(data); });
function stopOwnedGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}
const timeout = setTimeout(() => { stopOwnedGroup('SIGTERM'); }, 180000);
const hard = setTimeout(() => { stopOwnedGroup('SIGKILL'); }, 190000);
const { code, signal } = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout); clearTimeout(hard);
await verifyUnchanged(repository, runProvenance);
const after = createHash('sha256').update(await readFile(script)).digest('hex');
assert.equal(after, before, 'Original regression script changed during execution');
const count = Number(stdout.match(/Browser MCP real Chromium contracts passed: (\d+)/)?.[1] ?? 0);
const passed = code === 0 && signal === null && count === 30 && before === LEGACY_SOURCE_SHA256;
const result = {
  schema: 'xharness.browser-use.legacy-acceptance.v1',
  provenance: runProvenance,
  generatedAt: new Date().toISOString(),
  source: 'scripts/gui_bench/test_browser.mjs',
  sourceSha256: before,
  expectedSourceSha256: LEGACY_SOURCE_SHA256,
  expectedChecks: 30,
  status: passed ? 'passed' : 'failed',
  checks: count,
  exitCode: code,
  signal,
  stdout: stdout.slice(-16000),
  stderr: stderr.slice(-16000),
};
if (process.env.BROWSER_LEGACY_EVIDENCE) {
  const output = resolve(process.env.BROWSER_LEGACY_EVIDENCE);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
}
if (!passed) { console.error('Unchanged legacy Browser Use contract gate failed'); process.exitCode = 1; }
