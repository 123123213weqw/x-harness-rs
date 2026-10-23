import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const sourcePaths = [
  'plugins/browser-use/src/engine.ts',
  'plugins/browser-use/src/types.ts',
  'plugins/browser-use/src/protocol.ts',
  'plugins/browser-use/src/network-policy.ts',
  'plugins/browser-use/server.mjs',
  'plugins/browser-use/.mcp.json',
  'plugins/browser-use/.claude-plugin/plugin.json',
  'plugins/browser-use/package.json',
  'plugins/browser-use/package-lock.json',
  'plugins/browser-use/tsconfig.json',
  'scripts/browser_use/fixture.mjs',
  'scripts/browser_use/acceptance.mjs',
  'scripts/browser_use/stdio.mjs',
  'scripts/browser_use/legacy-gate.mjs',
  'scripts/browser_use/provenance.mjs',
  'scripts/browser_use/update-matrix.mjs',
  'scripts/browser_use/evidence-validator.mjs',
  'scripts/browser_use/evidence-gate.test.mjs',
  'scripts/browser_use/policy-contract.test.mjs',
  'scripts/browser_use/run-server-acceptance.sh',
  'scripts/gui_bench/test_browser.mjs',
  'scripts/gui_bench/fixtures/index.html',
];
export const buildPaths = [
  'plugins/browser-use/dist/engine.js',
  'plugins/browser-use/dist/types.js',
  'plugins/browser-use/dist/protocol.js',
  'plugins/browser-use/dist/network-policy.js',
];
async function hashFile(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function hashFiles(repository, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await hashFile(resolve(repository, path))])));
}
async function discover(repository, directory, extension) {
  const result = [];
  let entries;
  try { entries = await readdir(resolve(repository, directory), { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await discover(repository, path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) result.push(path);
  }
  return result.sort();
}
async function sourceFingerprint(repository) {
  const paths = [...new Set([...sourcePaths, ...await discover(repository, 'plugins/browser-use/src', '.ts')])].sort();
  return hashFiles(repository, paths);
}
async function buildFingerprint(repository) {
  const paths = [...new Set([...buildPaths, ...await discover(repository, 'plugins/browser-use/dist', '.js')])].sort();
  return hashFiles(repository, paths);
}
export async function contentFingerprint(repository) {
  return { sourceHashes: await sourceFingerprint(repository), buildHashes: await buildFingerprint(repository) };
}
export async function provenance(repository, engineModule = resolve(repository, 'plugins/browser-use/dist/engine.js')) {
  const require = createRequire(resolve(repository, 'plugins/browser-use/package.json'));
  const { chromium } = require('playwright');
  const playwright = require('playwright/package.json');
  const executable = chromium.executablePath();
  let browserVersion;
  try { browserVersion = (await promisify(execFile)(executable, ['--version'], { timeout: 10000, maxBuffer: 8192 })).stdout.trim(); }
  catch (error) { browserVersion = { unavailable: error instanceof Error ? error.message.slice(0, 300) : 'Version command failed' }; }
  return {
    sourceHashes: await sourceFingerprint(repository),
    buildHashes: await buildFingerprint(repository),
    loadedEngine: { path: relative(repository, engineModule), sha256: await hashFile(engineModule) },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, playwright: playwright.version, chromium: browserVersion, chromiumExecutable: executable },
  };
}
export async function verifyUnchanged(repository, before) {
  assert.deepEqual(await sourceFingerprint(repository), before.sourceHashes, 'Source or fixtures changed during test execution');
  assert.deepEqual(await buildFingerprint(repository), before.buildHashes, 'Built plugin changed during test execution');
}
export async function verifyCurrentProvenance(repository, recorded) {
  assert.ok(recorded, 'Evidence lacks content-bound provenance');
  await verifyUnchanged(repository, recorded);
  assert.equal(recorded.loadedEngine.path, 'plugins/browser-use/dist/engine.js', 'Evidence used a different engine build');
  assert.equal(recorded.loadedEngine.sha256, (await hashFiles(repository, ['plugins/browser-use/dist/engine.js']))['plugins/browser-use/dist/engine.js']);
  for (const path of sourcePaths) assert.ok(recorded.sourceHashes[path], `Missing source hash for ${path}`);
  for (const path of buildPaths) assert.ok(recorded.buildHashes[path], `Missing build hash for ${path}`);
}
