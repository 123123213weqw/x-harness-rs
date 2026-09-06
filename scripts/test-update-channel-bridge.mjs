import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { contract, validateSource, verifyHops, checkReleases } from './update-channel-bridge.mjs'

const config = { repository: 'old/app', configuredRepository: 'old/app', upstream: 'new/app', bridge: '0.2.2', target: '0.2.3' }
assert.equal(contract(config).tag, 'friends-v0.2.2')
for (const change of [
  { configuredRepository: '' }, { configuredRepository: 'other/app' },
  { upstream: 'old/app' }, { upstream: 'new/app\n' }, { upstream: '../app' },
  { bridge: '0.2.3' }, { bridge: '0.2.4' }, { target: '0.2.3\n' },
  { bridge: '01.2.2' }, { target: '65536.0.1' }, { bridge: '0.2.2;bad' },
]) assert.throws(() => contract({ ...config, ...change }))

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
const workflow = readFileSync(new URL('../.github/workflows/update-channel-bridge.yml', import.meta.url), 'utf8')
assert.ok(workflow.includes("github.ref == 'refs/heads/master'"))
assert.ok(workflow.includes('workflow_dispatch:'))
assert.ok(!workflow.includes('pull_request_target'))
assert.ok(!workflow.includes('--draft=false'))
assert.ok(!workflow.includes('--clobber'))
assert.ok(workflow.indexOf(' prepare') < workflow.indexOf('TAURI_SIGNING_PRIVATE_KEY:'))
console.log('Bridge contract, two independent signing keys, tampering and draft-only workflow guards passed')
