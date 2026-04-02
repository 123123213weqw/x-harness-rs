// Migrate a version-pinned Mac rehearsal feed to the existing unified channel.
// Reuse accepted release bytes; no build, no runtime patch, no private key reads.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { verifyPackage } from './verify-updater-package.mjs'
import { verifyHops } from './update-channel-bridge.mjs'
const hash = b => createHash('sha256').update(b).digest('hex')
function version(v) {
  assert.match(v, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  assert.equal(v.trim(), v)
  const n = v.split('.').map(Number)
  assert.ok(n.every(x => x <= 65535))
  return n[0] * 65536 ** 2 + n[1] * 65536 + n[2]
}
export function contract(repo, configured, old, target) {
  assert.match(repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
  assert.ok(!repo.endsWith('/.') && !repo.endsWith('/..'))
  assert.equal(repo.trim(), repo)
  assert.equal(repo, configured)
  assert.ok(version(target) > version(old), 'Migration must increase version')
  return { repo, old, target, oldTag: `desktop-test-v${old}`, sourceTag: `desktop-v${target}`,
    tag: `macos-preview-bridge-${old}-to-${target}`,
    file: `XHarness_${target}_aarch64.app.tar.gz`,
    endpoint: `https://github.com/${repo}/releases/latest/download/latest.json` }
}
export function validateSource(c, release, manifest, signature, binary, key) {
  assert.equal(release.draft, false); assert.equal(release.prerelease, false)
  assert.equal(release.tag_name, c.sourceTag)
  assert.equal(manifest.version, c.target)
  const platform = manifest.platforms?.['darwin-aarch64']
  assert.equal(platform?.url, `https://github.com/${c.repo}/releases/download/${c.sourceTag}/${c.file}`)
  assert.equal(platform?.signature, signature.trim())
  assert.ok(key.trim(), 'New public key required')
  assert.ok(binary.includes(Buffer.from(c.endpoint)), 'Target must embed long-lived endpoint')
  assert.ok(binary.includes(Buffer.from(key.trim())), 'Target must embed long-lived public key')
}
export function checkOld(c, release, manifest, downloadedKey, pinnedKey) {
  assert.equal(release.tag_name, c.oldTag)
  assert.equal(release.draft, false); assert.equal(release.prerelease, true)
  assert.equal(manifest.version, c.old, 'Old feed changed; inspect rather than overwrite')
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64'])
  assert.ok(pinnedKey.trim()); assert.equal(downloadedKey.trim(), pinnedKey.trim())
}
export function updateChecksums(text, oldHash, newHash) {
  const lines = text.trimEnd().split(/\r?\n/)
  const matches = lines.filter(line => /^[a-f0-9]{64}  latest\.json$/.test(line))
  assert.equal(matches.length, 1, 'Exactly one manifest checksum required')
  assert.equal(matches[0].slice(0, 64), oldHash, 'Existing checksum must match old feed')
  return lines.map(line => line === matches[0] ? `${newHash}  latest.json` : line).join('\n') + '\n'
}
export function migrationManifest(c, signature, date) {
  assert.ok(signature.trim())
  return { version: c.target, pub_date: date,
    notes: 'macOS 未公证预览版：迁移到长期更新通道。更新包严格验签；首次打开可能需要系统设置允许。请保存工作后确认重启。',
    platforms: { 'darwin-aarch64': { signature: signature.trim(),
      url: `https://github.com/${c.repo}/releases/download/${c.tag}/${c.file}` } } }
}
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
export function run(command, e = process.env) {
  const c = contract(e.GITHUB_REPOSITORY, e.XHARNESS_FRIENDS_RELEASE_REPOSITORY, e.LEGACY_VERSION, e.TARGET_VERSION)
  const root = resolve('dist/macos-preview-bridge'), src = join(root, 'source'), out = join(root, 'release')
  const jsonGh = args => JSON.parse(gh(args))
  const release = tag => jsonGh(['api', `repos/${c.repo}/releases/tags/${tag}`])
  const download = (tag, name, dest) => gh(['release', 'download', tag, '--repo', c.repo, '--pattern', name, '--dir', dest])
  const read = (dir, name) => readFileSync(join(dir, name), 'utf8').trim()
  const oldKey = e.XHARNESS_TEST_UPDATER_PUBKEY ?? '', newKey = e.XHARNESS_FRIENDS_PUBLIC_KEY ?? ''
  assert.ok(oldKey.trim() && newKey.trim()); assert.notEqual(oldKey.trim(), newKey.trim())
  if (command === 'prepare') {
    mkdirSync(resolve('dist'), { recursive: true }); mkdirSync(root); mkdirSync(src); mkdirSync(out); mkdirSync(join(root, 'legacy'))
    for (const name of ['latest.json', 'updater-test.pub', 'SHA256SUMS']) download(c.oldTag, name, join(root, 'legacy'))
    checkOld(c, release(c.oldTag), JSON.parse(read(join(root, 'legacy'), 'latest.json')), read(join(root, 'legacy'), 'updater-test.pub'), oldKey)
    const latest = jsonGh(['api', `repos/${c.repo}/releases/latest`])
    for (const name of ['latest.json', 'updater.pub', c.file, c.file + '.sig']) download(c.sourceTag, name, src)
    assert.equal(read(src, 'updater.pub'), newKey.trim())
    const bytes = readFileSync(join(src, c.file)), signature = read(src, c.file + '.sig')
    verifyPackage(bytes, newKey, signature)
    // Verify before extracting; data filter rejects traversal/escaping links/devices.
    const unpack = join(root, 'unpacked'); mkdirSync(unpack)
    execFileSync('python3', ['-c', 'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter="data")', join(src, c.file), unpack])
    const app = join(unpack, 'XHarness.app')
    execFileSync('codesign', ['--verify', '--deep', '--strict', app])
    const appVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    assert.equal(appVersion, c.target)
    validateSource(c, latest, JSON.parse(read(src, 'latest.json')), signature, readFileSync(join(app, 'Contents/MacOS/xharness-desktop')), newKey)
    copyFileSync(join(src, c.file), join(out, c.file))
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ c, sha256: hash(bytes), oldFeedSha256: hash(readFileSync(join(root, 'legacy/latest.json'))) }))
    writeFileSync(join(out, 'updater-test.pub'), oldKey.trim() + '\n')
    return
  }
  assert.ok(['finish', 'publish'].includes(command))
  const saved = JSON.parse(read(root, 'contract.json')); assert.deepEqual(saved.c, c)
  const bytes = readFileSync(join(out, c.file)); assert.equal(hash(bytes), saved.sha256)
  verifyHops({ bridge: bytes, target: bytes, oldKey, newKey,
    oldSignature: read(out, c.file + '.sig'), bridgeSignature: read(src, c.file + '.sig'), targetSignature: read(src, c.file + '.sig') })
  if (command === 'finish') {
    writeFileSync(join(out, 'latest.json'), JSON.stringify(migrationManifest(c, read(out, c.file + '.sig'), new Date().toISOString()), null, 2) + '\n')
    writeFileSync(join(out, 'legacy-SHA256SUMS'), updateChecksums(read(join(root, 'legacy'), 'SHA256SUMS'), saved.oldFeedSha256, hash(readFileSync(join(out, 'latest.json')))))
    copyFileSync(join(root, 'legacy/latest.json'), join(out, 'legacy-manifest-backup.json'))
    copyFileSync(join(root, 'legacy/SHA256SUMS'), join(out, 'legacy-checksums-backup.txt'))
    writeFileSync(join(out, 'bridge-receipt.json'), JSON.stringify(saved, null, 2) + '\n')
    return
  }
  const manifest = JSON.parse(read(out, 'latest.json'))
  assert.deepEqual(manifest, migrationManifest(c, read(out, c.file + '.sig'), manifest.pub_date))
  assert.ok(Number.isFinite(Date.parse(manifest.pub_date)))
  assert.equal(read(out, 'legacy-SHA256SUMS'), updateChecksums(read(join(root, 'legacy'), 'SHA256SUMS'), saved.oldFeedSha256, hash(readFileSync(join(out, 'latest.json')))).trim())
  // Intentional, scoped legacy pointer change only; unified feed is never written.
  const currentDir = join(root, 'before-publish'); mkdirSync(currentDir)
  download(c.oldTag, 'latest.json', currentDir)
  assert.equal(hash(readFileSync(join(currentDir, 'latest.json'))), saved.oldFeedSha256, 'Legacy feed changed concurrently')
  assert.equal(jsonGh(['api', `repos/${c.repo}/releases/latest`]).tag_name, c.sourceTag, 'Latest changed; replan migration')
  // Fresh prerelease required. A partial failure leaves old feed untouched and
  // requires operator inspection; never silently overwrite a published bridge.
  gh(['release', 'create', c.tag, '--repo', c.repo, '--target', e.GITHUB_SHA, '--draft', '--prerelease', '--latest=false', '--title', `Mac preview migration ${c.old} → ${c.target}`, '--notes', 'Unnotarized preview. Unchanged accepted package, re-signed for legacy clients.'])
  gh(['release', 'upload', c.tag, '--repo', c.repo, join(out, c.file), join(out, c.file + '.sig'), join(out, 'bridge-receipt.json'), join(out, 'updater-test.pub'), join(out, 'legacy-manifest-backup.json'), join(out, 'legacy-checksums-backup.txt')])
  gh(['release', 'edit', c.tag, '--repo', c.repo, '--draft=false', '--prerelease', '--latest=false'])
  // Re-read immediately before the only mutable upload.
  const again = join(root, 'last-check'); mkdirSync(again); download(c.oldTag, 'latest.json', again)
  assert.equal(hash(readFileSync(join(again, 'latest.json'))), saved.oldFeedSha256)
  copyFileSync(join(out, 'legacy-SHA256SUMS'), join(again, 'SHA256SUMS'))
  gh(['release', 'upload', c.oldTag, '--repo', c.repo, join(out, 'latest.json'), join(again, 'SHA256SUMS'), '--clobber'])
  const verify = join(root, 'verify'); mkdirSync(verify); download(c.oldTag, 'latest.json', verify)
  assert.deepEqual(JSON.parse(read(verify, 'latest.json')), JSON.parse(read(out, 'latest.json')))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv[2])
