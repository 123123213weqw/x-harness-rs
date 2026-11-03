// Run on WZU_Server or native macOS CI, using an already-built peer executable.
// No compiler commands here. Process faults are actual exit(86) before replies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { synchronize } from './controller.mjs';
import { Peer, peerArgs } from './transport.mjs';
const binary = process.argv[2]; assert.ok(binary);
const output = process.argv[3];
const root = mkdtempSync(join(tmpdir(), 'xh-wire-process-'));
const cases = []; let complete = false;
function fixture() {
  const path = mkdtempSync(join(root, 'pair-'));
  const config = {};
  for (const side of ['local', 'cloud']) {
    const e = { binary, workspace: join(path, side), control: join(path, `${side}-control`), spool: join(path, `${side}-spool`), registration: randomBytes(32).toString('hex') };
    for (const p of [e.workspace, e.control, e.spool]) mkdirSync(p, { mode: 0o700 });
    config[side] = e;
  }
  const describe = side => JSON.parse(execFileSync(binary, peerArgs(config[side], side, 'provision'), { encoding: 'utf8' }));
  const binding = { version: 1, pair: 'pair', epoch: 1, local: describe('local'), cloud: describe('cloud'), policy: { id: 'personal-workspace-capture', version: 'v2-sync-reserved-unicode16-fold-unicode17-nfd' } };
  for (const side of ['local', 'cloud']) execFileSync(binary, peerArgs(config[side], side, 'bind'), { input: JSON.stringify(binding) });
  return config;
}
function peers(c, fault) {
  return Object.fromEntries(['local', 'cloud'].map(side => [side, new Peer(binary, peerArgs(c[side], side), { env: { ...process.env, ...(fault?.side === side ? { XHARNESS_SYNC_PEER_EXIT_AFTER: fault.operation } : {}) } })]));
}
function move(c, side, hashes) {
  const peer = side === 'local' ? 'cloud' : 'local';
  if (!hashes.length) return;
  for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
  execFileSync('rsync', ['-r', '--checksum', '--files-from=-', '--', c[side].spool + '/', c[peer].spool + '/'], { input: hashes.join('\n') + '\n' });
}
async function sync(c, { fault, cut } = {}) {
  const p = peers(c, fault); let error; let result;
  try { result = await synchronize(p.local, p.cloud, (side, hashes) => move(c, side, hashes), label => { if (label === cut) throw new Error('owned controller interruption'); }); }
  catch (e) { error = e; }
  const stops = await Promise.allSettled([p.local.close(), p.cloud.close()]);
  if (!error && stops.some(s => s.status !== 'fulfilled')) error = new Error('unclean peer exit');
  if (error) throw error;
  return result;
}
try {
  {
    const c = fixture(); mkdirSync(join(c.local.workspace, '中文'));
    const bytes = Buffer.from(Array.from({ length: 524299 }, (_, i) => i % 251));
    writeFileSync(join(c.local.workspace, '中文/data.bin'), bytes); writeFileSync(join(c.local.workspace, '.env'), 'excluded');
    const one = await sync(c); assert.equal(one.generation, 1); assert.deepEqual(readFileSync(join(c.cloud.workspace, '中文/data.bin')), bytes);
    writeFileSync(join(c.cloud.workspace, 'cloud.txt'), 'cloud-return'); const two = await sync(c); assert.equal(two.generation, 2);
    assert.equal(readFileSync(join(c.local.workspace, 'cloud.txt'), 'utf8'), 'cloud-return');
    const inode = statSync(join(c.local.workspace, 'cloud.txt'), { bigint: true }).ino; const noop = await sync(c); assert.ok(noop.unchanged); assert.equal(statSync(join(c.local.workspace, 'cloud.txt'), { bigint: true }).ino, inode);
    cases.push({ name: 'bidirectional_binary_unicode_exclusion_noop', passed: true });
  }
  for (const cut of ['intent', 'both_intents', 'objects', 'staged', 'prepared', 'decision', 'both_decisions', 'cloud_applied', 'both_applied', 'cloud_base', 'both_bases', 'cloud_released']) {
    const c = fixture(); writeFileSync(join(c.local.workspace, 'file'), 'first');
    await assert.rejects(sync(c, { cut }));
    const r = await sync(c); assert.equal(r.generation, 1); assert.equal(r.recovered, true);
    assert.equal(readFileSync(join(c.cloud.workspace, 'file'), 'utf8'), 'first');
    cases.push({ name: `controller_disconnect_${cut}`, passed: true });
  }
  for (const fault of [{ side: 'local', operation: 'plan' }, { side: 'cloud', operation: 'begin' }, { side: 'cloud', operation: 'stage' }, { side: 'cloud', operation: 'prepare' }, { side: 'local', operation: 'decide' }, { side: 'cloud', operation: 'accept_decision' }, { side: 'cloud', operation: 'apply' }, { side: 'cloud', operation: 'finalize' }, { side: 'cloud', operation: 'release' }, { side: 'local', operation: 'release' }]) {
    const c = fixture(); writeFileSync(join(c.local.workspace, 'file'), 'crash-safe');
    await assert.rejects(sync(c, { fault })); const appliedInode = fault.operation === 'apply' ? statSync(join(c.cloud.workspace, 'file'), { bigint: true }).ino : undefined; const r = await sync(c); assert.equal(r.generation, 1); if (appliedInode !== undefined) assert.equal(statSync(join(c.cloud.workspace, 'file'), { bigint: true }).ino, appliedInode);
    assert.equal(readFileSync(join(c.cloud.workspace, 'file'), 'utf8'), 'crash-safe');
    cases.push({ name: `process_exit_before_reply_${fault.side}_${fault.operation}`, passed: true });
  }
  complete = true;
} finally {
  if (output) writeFileSync(output, JSON.stringify({ scope: 'native_independent_processes_and_real_rsync', platform: process.platform, passed: complete, cases, ...(complete ? {} : { retained_fixture: root }) }, null, 2) + '\n');
  if (complete) rmSync(root, { recursive: true });
}
console.log(JSON.stringify({ passed: complete, cases: cases.length }));
