import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contract, validateSource, verifyHops, checkReleases, runBridge } from './update-channel-bridge.mjs'

const config = { repository: 'old/app', configuredRepository: 'old/app', upstream: 'new/app', bridge: '0.2.2', target: '0.2.3' }
assert.equal(contract(config).tag, 'friends-v0.2.2')
for (const change of [
  { configuredRepository: '' }, { configuredRepository: 'other/app' },
  { upstream: 'old/app' }, { upstream: 'new/app\n' }, { upstream: '../app' },
  { bridge: '0.2.4' }, { target: '0.2.3\n' },
  { bridge: '01.2.2' }, { target: '65536.0.1' }, { bridge: '0.2.2;bad' },
]) assert.throws(() => contract({ ...config, ...change }))
assert.equal(contract({ ...config, bridge: config.target }).file, contract(config).targetFile)

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const id = randomBytes(8)
  const key = Buffer.from('untrusted comment: test-only key\n' + Buffer.concat([
    Buffer.from('Ed'), id, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]).toString('base64') + '\n').toString('base64')
  return { key, signature(data) {
    const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey)
    const comment = 'test-only bridge'
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey)
    return Buffer.from('untrusted comment: test\n' + Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64') +
      '\ntrusted comment: ' + comment + '\n' + global.toString('base64') + '\n').toString('base64')
  } }
}
const old = pair(), next = pair()
const bridge = Buffer.from('synthetic installer with new endpoint and key'), target = Buffer.from('synthetic later installer')
const hops = { bridge, target, oldKey: old.key, newKey: next.key,
  oldSignature: old.signature(bridge), bridgeSignature: next.signature(bridge), targetSignature: next.signature(target) }
verifyHops(hops)
for (const change of [
  { bridge: Buffer.from('tampered') }, { target: Buffer.from('tampered') },
  { oldKey: next.key }, { newKey: old.key }, { oldSignature: hops.bridgeSignature },
  { targetSignature: hops.oldSignature }, { bridgeSignature: 'invalid' },
]) assert.throws(() => verifyHops({ ...hops, ...change }))
const c = contract(config)
const oldReleases = [{ tagName: 'friends-v0.2.1', isDraft: false }]
const oldLatest = { tag_name: 'friends-v0.2.1' }
const upstreamLatest = { tag_name: c.sourceTag, draft: false, prerelease: false }
checkReleases(c, oldReleases, oldLatest, upstreamLatest)
for (const isDraft of [true, false]) {
  assert.throws(() => checkReleases(c, [...oldReleases, { tagName: c.tag, isDraft }], oldLatest, upstreamLatest))
}
assert.throws(() => checkReleases(c, [...oldReleases, { tagName: 'friends-v0.3.0', isDraft: false }], oldLatest, upstreamLatest))
for (const tag_name of ['desktop-v0.2.1', 'friends-v0.2.2', 'friends-v0.2.3']) {
  assert.throws(() => checkReleases(c, oldReleases, { tag_name }, upstreamLatest))
}
for (const change of [{ tag_name: 'friends-v0.2.4' }, { draft: true }, { prerelease: true }]) {
  assert.throws(() => checkReleases(c, oldReleases, oldLatest, { ...upstreamLatest, ...change }))
}
const manifest = { version: config.target, platforms: { 'windows-x86_64': { url: c.targetUrl, signature: hops.targetSignature } } }
validateSource(c, manifest, next.key, next.key, hops.targetSignature)
for (const change of [{ version: '0.2.2' }, { platforms: { 'windows-x86_64': { url: 'https://evil.invalid/a', signature: hops.targetSignature } } }]) {
  assert.throws(() => validateSource(c, { ...manifest, ...change }, next.key, next.key, hops.targetSignature))
}
assert.throws(() => validateSource(c, manifest, old.key, next.key, hops.targetSignature))
assert.throws(() => validateSource(c, manifest, next.key, next.key, 'wrong signature'))
// End-to-end orchestration with an injected read-only GitHub fixture. No real
// credentials/network/release writes; execute the same prepare/finish code as CI.
const env = { GITHUB_REPOSITORY: config.repository, XHARNESS_FRIENDS_RELEASE_REPOSITORY: config.repository,
  XHARNESS_BRIDGE_UPSTREAM_REPOSITORY: config.upstream, BRIDGE_VERSION: config.bridge, UPSTREAM_VERSION: config.target,
  XHARNESS_BRIDGE_UPSTREAM_PUBLIC_KEY: next.key, XHARNESS_FRIENDS_PUBLIC_KEY: old.key, GITHUB_SHA: 'fixture-commit' }
function scenario({ corruptDownload = false, corruptSigned = false, existingDraft = false, changedLatest = false, direct = false } = {}) {
  const c = contract(direct ? { ...config, bridge: config.target } : config)
  const envForRun = { ...env, BRIDGE_VERSION: c.bridge }
  const expectedBridge = direct ? target : bridge
  const expectedSignature = direct ? old.signature(target) : hops.oldSignature
  const root = join(mkdtempSync(join(tmpdir(), 'xharness-bridge-contract-')), 'bridge')
  let finishedDownload = false
  const runGh = args => {
    if (args[0] === 'release' && args[1] === 'list') return JSON.stringify(existingDraft ? [...oldReleases, { tagName: c.tag, isDraft: true }] : oldReleases)
    if (args[0] === 'api') return JSON.stringify(args[1].includes(config.repository) ? oldLatest :
      (changedLatest && finishedDownload ? { ...upstreamLatest, tag_name: 'friends-v0.3.0' } : upstreamLatest))
    assert.deepEqual(args.slice(0, 3), ['release', 'download', c.sourceTag])
    const directory = args[args.indexOf('--dir') + 1]
    const requested = args.flatMap((value, index) => value === '--pattern' ? [args[index + 1]] : [])
    assert.equal(requested.length, new Set(requested).size, 'Duplicate download asset')
    const assets = { [c.file]: corruptDownload ? Buffer.from('bad') : bridge, [c.file + '.sig']: hops.bridgeSignature,
      [c.targetFile]: target, [c.targetFile + '.sig']: hops.targetSignature,
      'updater.pub': next.key, 'latest.json': JSON.stringify(manifest) }
    if (direct && corruptDownload) assets[c.file] = Buffer.from('bad')
    for (const [name, data] of Object.entries(assets)) writeFileSync(join(directory, name), data)
    finishedDownload = true
    return ''
  }
  const options = { env: envForRun, root, runGh }
  runBridge('prepare', options)
  const output = join(root, 'release')
  assert.deepEqual(readdirSync(output), [c.file])
  writeFileSync(join(output, c.file + '.sig'), expectedSignature)
  if (corruptSigned) writeFileSync(join(output, c.file), 'modified after signing')
  runBridge('finish', options)
  const receipt = JSON.parse(readFileSync(join(output, 'migration.json'), 'utf8'))
  assert.equal(receipt.bridgeSha256, createHash('sha256').update(expectedBridge).digest('hex'))
  assert.equal(receipt.directLatest, direct)
  if (direct) assert.equal(receipt.bridgeSha256, receipt.targetSha256)
  assert.equal(receipt.nativeAcceptance, 'REQUIRED BEFORE PUBLICATION')
  const published = JSON.parse(readFileSync(join(output, 'latest.json'), 'utf8'))
  assert.equal(published.version, c.bridge)
  assert.equal(published.platforms['windows-x86_64'].signature, expectedSignature)
  assert.equal(published.platforms['windows-x86_64'].url, `https://github.com/old/app/releases/download/${c.tag}/${c.file}`)
  assert.equal(readFileSync(join(output, 'updater.pub'), 'utf8').trim(), old.key)
  assert.equal(readFileSync(join(output, 'upstream.pub'), 'utf8').trim(), next.key)
  for (const line of readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [digest, file] = line.split('  ')
    assert.equal(digest, createHash('sha256').update(readFileSync(join(output, file))).digest('hex'))
  }
  assert.throws(() => runBridge('prepare', options), /EEXIST/)
}
for (const direct of [false, true]) {
  scenario({ direct })
  for (const option of ['corruptDownload', 'corruptSigned', 'existingDraft', 'changedLatest']) {
    assert.throws(() => scenario({ [option]: true, direct }), undefined, option)
  }
}
const workflow = readFileSync(new URL('../.github/workflows/update-channel-bridge.yml', import.meta.url), 'utf8')
assert.ok(workflow.includes("github.ref == 'refs/heads/master'"))
assert.ok(workflow.includes('workflow_dispatch:'))
assert.ok(!workflow.includes('pull_request_target'))
assert.ok(!workflow.includes('--draft=false'))
assert.ok(!workflow.includes('--clobber'))
assert.ok(workflow.indexOf(' prepare') < workflow.indexOf('TAURI_SIGNING_PRIVATE_KEY:'))
console.log('Bridge contract, two independent signing keys, tampering and draft-only workflow guards passed')
