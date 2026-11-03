#!/usr/bin/env node
// Real Mac -> verified SSH tunnel -> Linux Rust endpoint. No local Rust build,
// existing user credential reads, production workspace, cloud apply or UI RPC.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const [run, evidence] = process.argv.slice(2);
assert.match(run ?? '', /^codex-build\/x-harness-rs\/runs\/[a-z0-9-]+$/);
assert.ok(evidence, 'evidence JSON path required');
const sshArgs = ['-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function remote(command) {
  // Capture stdout in memory, including the fresh fixture token; never log it.
  return execFileSync('ssh', [...sshArgs, 'WZU_Server', command], { timeout: 20000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
}
const root = remote(`mktemp -d "$HOME/${run}/read-probe.XXXXXXXX"`).trim();
assert.match(root, /^\/[A-Za-z0-9_/.+-]+$/);
const binary = remote('readlink -f "$HOME/codex-build/x-harness-rs/target-personal-handoff/debug/examples/workspace_export_probe"').trim();
const probe = spawn('ssh', [...sshArgs, 'WZU_Server', `printf '%s' $$ > ${quote(root + '.pid')}; exec ${quote(binary)} ${quote(root)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostic = '';
probe.stderr.on('data', b => { diagnostic += b; });
probe.stdout.resume();
const observed = child => new Promise(resolve => {
  child.once('error', error => resolve({ error: error.code }));
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const probeExit = observed(probe);
let tunnel;
let tunnelExit;
const receipt = { scope: 'real_ssh_loopback_read_only', local: process.platform, remote: 'WZU_Server', passed: false, checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedExit(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned process exit timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  let ready;
  for (let attempt = 0; attempt < 15; attempt++) {
    const output = remote(`if test -f ${quote(root + '/ready.json')}; then cat ${quote(root + '/ready.json')}; fi`);
    if (output) { ready = JSON.parse(output); break; }
    await delay(300);
  }
  assert.ok(ready, 'native fixture not ready');
  assert.match(ready.address, /^127\.0\.0\.1:\d+$/);
  assert.match(ready.scope, /^[0-9a-f]{64}$/);
  const token = remote(`cat ${quote(root + '/control-source/.xh-sync-export-auth')}`);
  assert.match(token, /^[0-9a-f]{64}$/);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  tunnel = spawn('ssh', [...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${port}:${ready.address}`, 'WZU_Server'], { stdio: ['ignore', 'ignore', 'pipe'] });
  tunnel.stderr.on('data', b => { diagnostic += b; });
  tunnelExit = observed(tunnel);
  function request(path, { method = 'GET', bearer = false, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port, path, method,
        headers: { Host: ready.address, ...(bearer ? { Authorization: `Bearer ${token}` } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, response => {
        const chunks = [];
        let count = 0;
        response.on('data', bytes => { count += bytes.length; if (count > 32 * 1024 * 1024) response.destroy(new Error('response limit')); else chunks.push(bytes); });
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks), headers: response.headers }));
      });
      req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
      req.once('error', reject);
      req.end(bytes);
    });
  }
  const nonce = randomBytes(32).toString('hex');
  let identity;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { identity = await request(`/identity?nonce=${nonce}`); break; }
    catch (error) { if (attempt === 9 || error.code !== 'ECONNREFUSED') throw error; await delay(300); }
  }
  assert.equal(identity.status, 200);
  const proof = JSON.parse(identity.bytes);
  assert.equal(proof.scope, ready.scope);
  assert.match(proof.proof, /^[0-9a-f]{64}$/);
  const mac = n => createHmac('sha256', token).update('xharness-workspace-read-v1\0').update(n).update(ready.scope).digest();
  assert.ok(timingSafeEqual(mac(nonce), Buffer.from(proof.proof, 'hex')));
  assert.ok(!timingSafeEqual(mac(randomBytes(32).toString('hex')), Buffer.from(proof.proof, 'hex')));
  receipt.checks.push('pinned_scope_fresh_proof_before_bearer', 'replayed_challenge_rejected');
  assert.equal((await request('/snapshot')).status, 401);
  assert.equal((await request('/snapshot', { bearer: true, headers: { Origin: 'http://localhost' } })).status, 403);
  const response = await request('/snapshot', { bearer: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const snapshot = JSON.parse(response.bytes);
  assert.equal(snapshot.scope, ready.scope);
  assert.equal(snapshot.files.length, 1);
  const file = snapshot.files[0];
  assert.equal(file.path, '中文/payload.bin');
  assert.equal(file.bytes, 524299);
  const body = { path: file.path, exact: file.exact, sha256: file.sha256, bytes: file.bytes };
  const blob = await request('/blob', { method: 'POST', bearer: true, body });
  assert.equal(blob.status, 200);
  assert.equal(blob.bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(blob.bytes).digest('hex'), file.sha256);
  assert.ok(blob.bytes.every((b, i) => b === i % 251));
  receipt.bytes = file.bytes;
  receipt.sha256 = file.sha256;
  receipt.checks.push('binary_unicode_full_hash', 'secret_and_control_records_excluded', 'unauthenticated_401', 'browser_origin_403');
  assert.equal((await request('/blob', { method: 'POST', bearer: true, body: { ...body, path: '.env' } })).status, 400);
  assert.equal((await request('/apply', { method: 'POST', bearer: true })).status, 404);
  remote(`printf changed > ${quote(root + '/source/中文/payload.bin')}`);
  assert.equal((await request('/blob', { method: 'POST', bearer: true, body })).status, 409);
  receipt.checks.push('excluded_blob_denied', 'no_apply_route', 'stale_native_version_409');
  receipt.passed = true;
} finally {
  // Never let one cleanup failure prevent observing the other owned process.
  // A broken SSH channel is NOT proof that its native child has stopped: leave
  // the private fixture intact for explicit owner recovery in that case.
  const cleanupErrors = [];
  let nativeStopped = false;
  try {
    remote(`if test -f ${quote(root + '.pid')}; then p=$(cat ${quote(root + '.pid')}); if test "$(readlink /proc/\"$p\"/exe)" = ${quote(binary)}; then kill -INT "$p"; fi; fi`);
  } catch { cleanupErrors.push('native_stop_request_failed'); }
  try {
    const stopped = await boundedExit(probeExit, 10000);
    receipt.probe_exit = stopped;
    nativeStopped = stopped.code === 0;
    if (!nativeStopped) cleanupErrors.push('native_clean_exit_unconfirmed');
  } catch { cleanupErrors.push('native_exit_timeout'); }
  if (tunnel) {
    tunnel.kill('SIGTERM');
    try { receipt.tunnel_exit = await boundedExit(tunnelExit, 10000); }
    catch { cleanupErrors.push('tunnel_exit_timeout'); }
  }
  if (nativeStopped) {
    try { remote(`rm -rf -- ${quote(root)}; rm -- ${quote(root + '.pid')}`); }
    catch { cleanupErrors.push('fixture_cleanup_failed'); }
  } else {
    receipt.owner_recovery_fixture = root;
  }
  receipt.cleanup_errors = cleanupErrors;
  if (cleanupErrors.length) receipt.passed = false;
  writeFileSync(evidence, JSON.stringify(receipt, null, 2) + '\n');
}
assert.ok(receipt.passed, 'cross-machine probe failed or did not stop cleanly');
console.log(JSON.stringify(receipt));
