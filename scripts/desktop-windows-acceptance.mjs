// Unified release wrapper. Reuses the real Windows installer/updater acceptance;
// no production IPC or trust bypass is added. Only disposable hosted CI may run it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackage } from './verify-updater-package.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => readFileSync(file, 'utf8').trim()
const json = file => JSON.parse(read(file))
export function requireHostedWindows(env, platform) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'CI only')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Disposable hosted runner only')
  assert.equal(platform, 'win32', 'Windows only')
  assert.equal(env.GITHUB_REF, 'refs/heads/master', 'Trusted master workflow only')
  assert.equal(env.XHARNESS_FRIENDS_RELEASE_REPOSITORY, env.GITHUB_REPOSITORY)
  assert.match(env.GITHUB_REPOSITORY, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
}
export function validateRun(run, plan) {
  assert.equal(run.conclusion, 'success')
  assert.equal(run.status, 'completed')
  assert.equal(run.path, '.github/workflows/desktop-release.yml')
  assert.ok(['push', 'workflow_dispatch'].includes(run.event))
  assert.equal(run.head_branch, run.event === 'push' ? plan.tag : 'master')
  assert.equal(run.head_sha, plan.sha)
  assert.equal(String(run.id), String(plan.release_run_id))
  assert.equal(String(run.run_attempt), String(plan.release_run_attempt))
}
export function installerLocation(repository, tag, version, url) {
  for (const value of [version]) assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  assert.ok(tag === `friends-v${version}` || tag === `desktop-v${version}`, 'Unknown stable base tag')
  const file = `XHarness_${version}_x64-setup.exe`
  assert.equal(url, `https://github.com/${repository}/releases/download/${tag}/${file}`, 'Unexpected installer URL')
  return file
}
export function acceptanceFromPass(plan, manifestHash, packageHash, pass, provenance) {
  assert.equal(pass.nativeDirectLatest, true)
  assert.equal(pass.installCount, 1)
  assert.equal(pass.confirmedInstall, true)
  assert.equal(pass.corruptPackageRejected, true)
  assert.equal(pass.upstreamEndpointAndKeyVerified, true)
  assert.equal(pass.checkpoints?.length, 2)
  const [old, next] = pass.checkpoints
  assert.equal(next.version, plan.version)
  assert.notEqual(old.version, next.version)
  assert.equal(old.journalSha256, next.journalSha256)
  assert.ok(/^[a-f0-9]{64}$/.test(next.journalSha256))
  assert.equal(next.status.hostRunning, true)
  assert.equal(next.status.updaterConfigured, true)
  assert.equal(next.compiledEndpoint, plan.endpoint)
  assert.equal(old.compiledKeySha256, next.compiledKeySha256)
  assert.ok(next.retained?.length >= 3)
  assert.deepEqual(next.retained, old.retained)
  return {
    schema_version: 1, platform: 'windows-x86_64', version: plan.version, sha: plan.sha,
    release_run_id: String(plan.release_run_id), release_run_attempt: String(plan.release_run_attempt),
    manifest_sha256: manifestHash, package_sha256: packageHash,
    status: 'passed', nativeUpdateAccepted: true, scope: 'exact-production-candidate', baseInstrumented: false,
    checks: { signature: true, install: true, launch: true, update: true,
      'state-preservation': true, 'embedded-channel': true, 'corrupt-package-rejected': true,
      'confirmation-required': true },
    provenance, base_version: old.version,
  }
}
function main(command) {
  const e = process.env
  requireHostedWindows(e, process.platform)
  assert.match(e.RELEASE_RUN_ID, /^[1-9]\d*$/)
  const repo = e.GITHUB_REPOSITORY, root = resolve('dist/migration-acceptance')
  const candidate = resolve('dist/unified-windows-candidate'), release = join(candidate, 'release')
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
  const run = JSON.parse(gh('api', `repos/${repo}/actions/runs/${e.RELEASE_RUN_ID}`))
  if (command === 'stage') {
    assert.ok(!existsSync(candidate) && !existsSync(root), 'Refuse pre-existing acceptance directories')
    mkdirSync(candidate, { recursive: true })
    gh('run', 'download', e.RELEASE_RUN_ID, '--repo', repo, '--name', 'desktop-candidate', '--dir', candidate)
    const plan = json(join(candidate, 'plan.json'))
    validateRun(run, plan)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), plan.sha, 'Checkout must match candidate source')
    assert.equal(plan.repository, repo)
    const key = e.UPSTREAM_PUBLIC_KEY?.trim()
    assert.ok(key)
    assert.equal(read(join(release, 'updater.pub')), key, 'Candidate changed updater trust')
    // Revalidate aggregate manifest, every receipt/hash/signature before any install.
    execFileSync('python', ['scripts/desktop-release.py', 'verify-release', '--plan', join(candidate, 'plan.json'),
      '--release-dir', release, '--public-key', join(release, 'updater.pub')], { stdio: 'inherit', timeout: 180000 })
    const latest = JSON.parse(gh('release', 'view', '--repo', repo, '--json', 'tagName,isDraft,isPrerelease'))
    assert.equal(latest.isDraft, false); assert.equal(latest.isPrerelease, false)
    const old = join(root, 'old'), next = join(root, 'next'), bridge = join(root, 'bridge')
    for (const dir of [old, next, bridge]) mkdirSync(dir, { recursive: true })
    gh('release', 'download', latest.tagName, '--repo', repo, '--dir', old, '--pattern', 'latest.json', '--pattern', 'updater.pub')
    const before = json(join(old, 'latest.json')), after = json(join(release, 'latest.json'))
    assert.equal(read(join(old, 'updater.pub')), key, 'Live channel key differs')
    const compare = v => v.split('.').map(Number)
    const a = compare(before.version), b = compare(after.version)
    assert.ok(b[0] > a[0] || b[0] === a[0] && (b[1] > a[1] || b[1] === a[1] && b[2] > a[2]), 'Candidate must be newer')
    const oldName = installerLocation(repo, latest.tagName, before.version, before.platforms['windows-x86_64'].url)
    const nextName = installerLocation(repo, plan.tag, plan.version, after.platforms['windows-x86_64'].url)
    gh('release', 'download', latest.tagName, '--repo', repo, '--dir', old, '--pattern', oldName, '--pattern', oldName + '.sig')
    assert.equal(read(join(old, oldName + '.sig')), before.platforms['windows-x86_64'].signature)
    verifyPackage(readFileSync(join(old, oldName)), key, read(join(old, oldName + '.sig')))
    for (const dir of [next, bridge]) for (const name of [nextName, nextName + '.sig', 'latest.json']) {
      copyFileSync(join(release, name), join(dir, name))
    }
    copyFileSync(join(next, nextName + '.sig'), join(bridge, nextName + '.upstream.sig'))
    const staged = { plan, manifest_sha256: sha(readFileSync(join(release, 'latest.json'))),
      package_sha256: sha(readFileSync(join(next, nextName))), base_tag: latest.tagName, base_version: before.version }
    writeFileSync(join(root, 'unified-stage.json'), JSON.stringify(staged, null, 2))
    const values = { UNIFIED_ACCEPTANCE: 'true', BASE_VERSION: before.version, BASE_RELEASE_TAG: latest.tagName,
      BRIDGE_VERSION: plan.version, UPSTREAM_VERSION: plan.version, UPSTREAM_REPOSITORY: repo,
      OLD_PUBLIC_KEY: key, UPSTREAM_PUBLIC_KEY: key, DIRECT_LATEST: 'true' }
    for (const [name, value] of Object.entries(values)) {
      assert.ok(!/[\r\n]/.test(value), 'Unsafe workflow environment value')
      appendFileSync(e.GITHUB_ENV, `${name}=${value}\n`)
    }
    console.log('Verified unified candidate and current stable Windows base; ready for native one-hop test.')
  } else if (command === 'collect') {
    const staged = json(join(root, 'unified-stage.json')); validateRun(run, staged.plan)
    const pass = json(join(root, 'evidence/PASS.json'))
    const target = join(root, 'next', `XHarness_${staged.plan.version}_x64-setup.exe`)
    assert.equal(sha(readFileSync(target)), staged.package_sha256)
    assert.equal(sha(readFileSync(join(root, 'next/latest.json'))), staged.manifest_sha256)
    const provenance = { workflow: '.github/workflows/desktop-windows-update-acceptance.yml',
      run_id: e.GITHUB_RUN_ID, run_attempt: e.GITHUB_RUN_ATTEMPT,
      source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
    assert.equal(provenance.source_sha, staged.plan.sha)
    const accepted = acceptanceFromPass(staged.plan, staged.manifest_sha256, staged.package_sha256, pass, provenance)
    writeFileSync(join(root, 'evidence/acceptance.json'), JSON.stringify(accepted, null, 2) + '\n')
    console.log('Native Windows candidate acceptance passed; no live feed changed.')
  } else throw new Error('Expected stage or collect')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2])
