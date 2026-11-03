// No shell locally. Remote executable/roots are explicit native owner config,
// never response-selected paths. Preserve OpenSSH host verification and keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
const MAX_FRAME = 2 * 1024 * 1024;
export const sshOptions = ['-T', '-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
export const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
export function validateConfig(c) {
  assert.deepEqual(Object.keys(c).sort(), ['cloud', 'local', 'sshHost']);
  assert.match(c.sshHost, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
  for (const e of [c.local, c.cloud]) {
    assert.deepEqual(Object.keys(e).sort(), ['binary', 'control', 'registration', 'spool', 'workspace']);
    for (const k of ['binary', 'workspace', 'control', 'spool']) {
      // Bounded v1 transport names: no rsync remote-shell argument ambiguity.
      assert.match(e[k], /^\/[a-zA-Z0-9_./+-]+$/); assert.ok(!e[k].split('/').some(p => p === '.' || p === '..' || !p && e[k].indexOf('//') >= 0));
    }
    assert.match(e.registration, /^[0-9a-f]{64}$/);
  }
  return c;
}
export function readConfig(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    assert.ok(s.isFile() && s.nlink === 1 && !(s.mode & 0o077) && s.uid === process.getuid() && s.size < 16384, 'owner-only native config required');
    const bytes = Buffer.alloc(16385);
    // Bounded synchronous owner configuration, never a model/browser payload.
    const n = readSync(fd, bytes, 0, bytes.length, 0); assert.ok(n === s.size && n < 16384);
    return validateConfig(JSON.parse(bytes.subarray(0,n).toString('utf8')));
  } finally { closeSync(fd); }
}
export const peerArgs = (e, role, mode = 'serve') => [mode, e.workspace, e.control, e.spool, e.registration, role];
export class Peer {
  constructor(command, args, options = {}, maxFrame = MAX_FRAME) {
    assert.ok(Number.isSafeInteger(maxFrame) && maxFrame >= MAX_FRAME && maxFrame <= 24 * 1024 * 1024 + 65536);
    this.maxFrame = maxFrame;
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.buffer = Buffer.alloc(0); this.pending = null; this.ended = false;
    this.exit = new Promise(resolve => {
      this.child.once('error', () => { this.ended = true; this.fail(new Error('native peer start failed')); resolve({ error: true }); });
      this.child.once('exit', (code, signal) => { this.ended = true; this.fail(new Error('native peer exited; retain journal for recovery')); resolve({ code, signal }); });
    });
    this.child.stderr.resume(); // Native errors/SSH diagnostics may include paths; never generic-log them.
    this.child.stdin.on('error', () => this.fail(new Error('native peer input closed')));
    this.child.stdout.on('data', b => {
      this.buffer = Buffer.concat([this.buffer, b]);
      if (this.buffer.length > this.maxFrame) { this.fail(new Error('native peer frame limit')); this.child.kill('SIGTERM'); return; }
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      const frame = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!this.pending || this.buffer.length) { this.fail(new Error('unsolicited native response')); this.child.kill('SIGTERM'); return; }
      const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
      try { const r = JSON.parse(frame); assert.equal(typeof r.ok, 'boolean'); if (!r.ok) { const e = new Error('native sync rejected; retained state requires inspection'); e.code = ['conflict','deletion_disabled','limit','unregistered','busy','source_or_target_changed','inventory_rejected','native_state_rejected','invalid_request'].includes(r.error) ? r.error : 'invalid_response'; throw e; } pending.resolve(r.value); }
      catch (e) { pending.reject(e); }
    });
  }
  fail(e) { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(e); this.pending = null; } }
  call(request) {
    assert.ok(!this.pending && !this.ended, 'one outstanding native request per participant');
    const bytes = Buffer.from(JSON.stringify(request) + '\n'); assert.ok(bytes.length <= this.maxFrame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('native request timeout; retain journal')); this.child.kill('SIGTERM'); }, 30000);
      this.pending = { resolve, reject, timer }; this.child.stdin.write(bytes);
    });
  }
  async close() {
    if (!this.ended) this.child.stdin.end();
    let timer;
    try {
      const r = await Promise.race([this.exit, new Promise((_, reject) => { timer = setTimeout(() => { this.child.kill('SIGTERM'); reject(new Error('peer clean exit unconfirmed; retain state')); }, 10000); })]);
      if (r.code !== 0) throw new Error('peer did not exit cleanly; retain state');
      return r;
    } finally { clearTimeout(timer); }
  }
}
export function openPeers(c, options = {}) {
  validateConfig(c);
  const local = new Peer(c.local.binary, peerArgs(c.local, 'local'), options.local);
  const remoteCommand = 'exec ' + [c.cloud.binary, ...peerArgs(c.cloud, 'cloud')].map(quote).join(' ');
  const cloud = new Peer('ssh', [...sshOptions, c.sshHost, remoteCommand], options.cloud);
  return { local, cloud };
}
export async function transfer(c, direction, objects) {
  validateConfig(c); assert.ok(['local', 'cloud'].includes(direction));
  assert.ok(Array.isArray(objects) && objects.length <= 256 && new Set(objects).size === objects.length);
  for (const h of objects) assert.match(h, /^[0-9a-f]{64}$/);
  if (!objects.length) return;
  const local = c.local.spool.replace(/\/$/, '') + '/';
  const remote = `${c.sshHost}:${c.cloud.spool.replace(/\/$/, '')}/`;
  const [source, target] = direction === 'local' ? [local, remote] : [remote, local];
  await new Promise((resolve, reject) => {
    const child = spawn('rsync', ['-r', '--checksum', '--files-from=-', '-e', ['ssh', ...sshOptions].join(' '), '--', source, target], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    let inputFailed = false;
    child.stderr.resume(); child.stdin.on('error', () => { inputFailed = true; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('object transport start failed')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && !inputFailed ? resolve() : reject(new Error('object transport failed; do not apply or advance base')); });
    child.stdin.end(objects.join('\n') + '\n');
  });
}
