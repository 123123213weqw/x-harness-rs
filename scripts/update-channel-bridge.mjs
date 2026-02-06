// Re-sign an unchanged upstream installer in the OLD repository only.
// No private material is read by this helper. Publishing remains a manual gate.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackage } from './verify-updater-package.mjs'

function repository(value) {
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  assert.ok(!value.endsWith('/.') && !value.endsWith('/..'))
  assert.equal(value.trim(), value)
  return value
}
function version(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  assert.equal(value.trim(), value)
  const parts = value.split('.').map(Number)
  assert.ok(parts.every(n => n <= 65535))
  return parts[0] * 65536 ** 2 + parts[1] * 65536 + parts[2]
}
export function contract({ repository: old, configuredRepository, upstream, bridge, target }) {
  repository(old); repository(upstream)
  assert.equal(configuredRepository, old, 'Old repository must explicitly opt in')
  assert.notEqual(old.toLowerCase(), upstream.toLowerCase(), 'Channels must differ')
  assert.ok(version(target) > version(bridge), 'Upstream must offer a newer second hop')
  const tag = `friends-v${bridge}`, sourceTag = `friends-v${target}`
  const file = `XHarness_${bridge}_x64-setup.exe`, targetFile = `XHarness_${target}_x64-setup.exe`
  return { old, upstream, bridge, target, tag, sourceTag, file, targetFile,
    endpoint: `https://github.com/${upstream}/releases/latest/download/latest.json`,
    targetUrl: `https://github.com/${upstream}/releases/download/${sourceTag}/${targetFile}` }
}
export function validateSource(c, manifest, downloadedKey, pinnedKey, targetSignature) {
  assert.ok(pinnedKey.trim(), 'Pin the upstream public key separately before migration')
  assert.equal(downloadedKey.trim(), pinnedKey.trim(), 'Downloaded key must match separately pinned key')
  assert.equal(manifest.version, c.target)
  assert.equal(manifest.platforms?.['windows-x86_64']?.url, c.targetUrl)
  assert.equal(manifest.platforms['windows-x86_64'].signature, targetSignature.trim())
}
export function verifyHops({ bridge, target, oldKey, newKey, oldSignature, bridgeSignature, targetSignature }) {
  assert.notEqual(oldKey.trim(), newKey.trim(), 'Migration requires independent channel keys')
  verifyPackage(bridge, newKey, bridgeSignature)
  verifyPackage(bridge, oldKey, oldSignature)
  verifyPackage(target, newKey, targetSignature)
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function checkReleases(c, oldReleases, oldLatest, upstreamLatest) {
  assert.ok(!oldReleases.some(r => r.tagName === c.tag), 'Never overwrite an existing draft or release')
  assert.ok(oldLatest.tag_name?.startsWith('friends-v'), 'Old latest pointer must belong to the friends channel')
  assert.ok(version(oldLatest.tag_name.slice(9)) < version(c.bridge), 'Bridge must upgrade existing clients')
  for (const r of oldReleases.filter(r => !r.isDraft && r.tagName.startsWith('friends-v'))) {
    assert.ok(version(r.tagName.slice(9)) < version(c.bridge), 'Bridge must exceed every published old-channel version')
  }
  assert.equal(upstreamLatest.tag_name, c.sourceTag, 'Upstream latest must already serve the selected target')
  assert.equal(upstreamLatest.draft, false)
  assert.equal(upstreamLatest.prerelease, false)
}
function preflight(c, runGh) {
  const json = args => JSON.parse(runGh(args))
  checkReleases(c,
    json(['release', 'list', '--repo', c.old, '--limit', '1000', '--json', 'tagName,isDraft']),
    json(['api', `repos/${c.old}/releases/latest`]),
    json(['api', `repos/${c.upstream}/releases/latest`]))
}
export function runBridge(command, { env: e = process.env, root = resolve('dist/channel-bridge'), runGh = gh } = {}) {
  const c = contract({ repository: e.GITHUB_REPOSITORY, configuredRepository: e.XHARNESS_FRIENDS_RELEASE_REPOSITORY,
    upstream: e.XHARNESS_BRIDGE_UPSTREAM_REPOSITORY, bridge: e.BRIDGE_VERSION, target: e.UPSTREAM_VERSION })
  const source = join(root, 'source'), output = join(root, 'release')
  const read = name => readFileSync(join(source, name), 'utf8').trim()
  const pinnedKey = e.XHARNESS_BRIDGE_UPSTREAM_PUBLIC_KEY ?? ''
  const oldKey = e.XHARNESS_FRIENDS_PUBLIC_KEY ?? ''
  assert.ok(pinnedKey.trim() && oldKey.trim(), 'Both public keys are required')
  assert.notEqual(pinnedKey.trim(), oldKey.trim())
  if (command === 'prepare') {
    preflight(c, runGh)
    // Fail on a reused directory; never mix artifacts from different attempts.
    mkdirSync(root, { recursive: true }); mkdirSync(source); mkdirSync(output)
    const assets = [c.file, c.file + '.sig', c.targetFile, c.targetFile + '.sig', 'updater.pub', 'latest.json']
    runGh(['release', 'download', c.sourceTag, '--repo', c.upstream, '--dir', source,
      ...assets.flatMap(name => ['--pattern', name])])
    validateSource(c, JSON.parse(read('latest.json')), read('updater.pub'), pinnedKey, read(c.targetFile + '.sig'))
    verifyPackage(readFileSync(join(source, c.file)), pinnedKey, read(c.file + '.sig'))
    verifyPackage(readFileSync(join(source, c.targetFile)), pinnedKey, read(c.targetFile + '.sig'))
    copyFileSync(join(source, c.file), join(output, c.file))
    writeFileSync(join(root, 'plan.json'), JSON.stringify(c, null, 2) + '\n')
    console.log('Verified both upstream installers; bridge staged for old-key signing (no publication).')
  } else if (command === 'finish') {
    preflight(c, runGh)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')), c)
    const bridge = readFileSync(join(output, c.file)), target = readFileSync(join(source, c.targetFile))
    assert.equal(hash(bridge), hash(readFileSync(join(source, c.file))), 'Re-signing must not alter installer bytes')
    const oldSignature = readFileSync(join(output, c.file + '.sig'), 'utf8').trim()
    validateSource(c, JSON.parse(read('latest.json')), read('updater.pub'), pinnedKey, read(c.targetFile + '.sig'))
    verifyHops({ bridge, target, oldKey, newKey: pinnedKey, oldSignature,
      bridgeSignature: read(c.file + '.sig'), targetSignature: read(c.targetFile + '.sig') })
    const manifest = { version: c.bridge, notes: '迁移到上游维护的更新通道。请保存任务，确认停止 Host 后安装；会话与模型配置应保留。',
      pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': {
        signature: oldSignature, url: `https://github.com/${c.old}/releases/download/${c.tag}/${c.file}` } } }
    writeFileSync(join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
    writeFileSync(join(output, 'updater.pub'), oldKey.trim() + '\n')
    writeFileSync(join(output, 'upstream.pub'), pinnedKey.trim() + '\n')
    writeFileSync(join(output, c.file + '.upstream.sig'), read(c.file + '.sig') + '\n')
    writeFileSync(join(output, 'migration.json'), JSON.stringify({ ...c, bridgeSha256: hash(bridge), targetSha256: hash(target),
      workflowCommit: e.GITHUB_SHA, nativeAcceptance: 'REQUIRED BEFORE PUBLICATION',
      warning: 'Cryptographic checks do not prove installed endpoint or native data preservation.' }, null, 2) + '\n')
    writeFileSync(join(output, 'README.md'), `# Windows update-channel migration ${c.bridge}\n\n` +
      `Identical installer from ${c.upstream} / ${c.sourceTag}, re-signed by ${c.old}.\n` +
      `Expected installed update endpoint: ${c.endpoint}\n\n` +
      'DRAFT ONLY: require isolated native old -> bridge -> upstream acceptance, including user confirmation, configuration/session retention and cancellation, before publishing. Keep the old latest feed pinned to this bridge afterward. Never upload private keys.\n')
    writeFileSync(join(output, 'SHA256SUMS'), readdirSync(output).filter(n => n !== 'SHA256SUMS').sort()
      .map(n => `${hash(readFileSync(join(output, n)))}  ${n}\n`).join(''))
    console.log('Both hops verified; complete draft assets ready. Native installation acceptance is still required.')
  } else throw new Error('Expected prepare or finish')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBridge(process.argv[2])
