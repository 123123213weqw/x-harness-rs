// Production installers, real Tauri updater and synthetic user data. CI only.
// A loopback HTTPS proxy supplies the draft old feed without changing live feeds.
// Windows trusts its short-lived test certificate; installer signatures stay real.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackage } from './verify-updater-package.mjs'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI only')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Disposable hosted runner only')
assert.equal(process.platform, 'win32')
const e = process.env, root = resolve('dist/migration-acceptance'), evidence = join(root, 'evidence')
mkdirSync(evidence, { recursive: true })
const oldRepo = e.BASE_REPOSITORY || e.GITHUB_REPOSITORY, upstream = e.UPSTREAM_REPOSITORY
const probeOnly = e.PROBE_ONLY === 'true'
const directLatest = e.DIRECT_LATEST === 'true'
const sameChannel = oldRepo === upstream
for (const repo of [oldRepo, upstream]) assert.match(repo, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
for (const v of [e.BASE_VERSION, e.BRIDGE_VERSION, e.UPSTREAM_VERSION]) assert.match(v, /^\d+\.\d+\.\d+$/)
const baseTags = sameChannel
  ? { '0.2.2': 'friends-v0.2.3', '0.2.3': 'friends-v0.2.3', '0.2.4': 'friends-v0.2.4', '0.2.5': 'friends-v0.2.5' }
  : { '0.2.0': 'friends-v0.2.1', '0.2.1': 'friends-v0.2.1' }
const unifiedAcceptance = e.UNIFIED_ACCEPTANCE === 'true'
if (unifiedAcceptance) {
  assert.equal(directLatest, true)
  assert.equal(sameChannel, true)
  const stage = JSON.parse(readFileSync(join(root, 'unified-stage.json'), 'utf8'))
  assert.equal(stage.base_version, e.BASE_VERSION)
  assert.equal(stage.base_tag, e.BASE_RELEASE_TAG)
  assert.ok([`friends-v${e.BASE_VERSION}`, `desktop-v${e.BASE_VERSION}`].includes(stage.base_tag))
  assert.equal(stage.plan.version, e.UPSTREAM_VERSION)
  assert.equal(stage.plan.repository, upstream)
  assert.equal(stage.plan.endpoint, `https://github.com/${upstream}/releases/latest/download/latest.json`)
  assert.equal(createHash('sha256').update(readFileSync(join(root, 'next', 'latest.json'))).digest('hex'), stage.manifest_sha256)
  assert.equal(createHash('sha256').update(readFileSync(join(root, 'next', `XHarness_${e.UPSTREAM_VERSION}_x64-setup.exe`))).digest('hex'), stage.package_sha256)
} else assert.ok(Object.hasOwn(baseTags, e.BASE_VERSION), 'Unsupported installed base version')
if (directLatest) assert.equal(e.BRIDGE_VERSION, e.UPSTREAM_VERSION)
if (sameChannel) assert.ok(directLatest, 'Same-channel acceptance must use one hop')
const filename = v => `XHarness_${v}_x64-setup.exe`
const location = (kind, v) => join(root, kind, filename(v))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const read = path => readFileSync(path, 'utf8').trim()
const manifest = kind => JSON.parse(read(join(root, kind, 'latest.json')))
function download(repo, tag, kind, names) {
  const dir = join(root, kind); mkdirSync(dir)
  execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir, ...names.flatMap(n => ['--pattern', n])], { stdio: ['ignore', 'pipe', 'pipe'] })
}
if (process.argv[2] === 'download') {
  assert.equal(unifiedAcceptance, false, 'Unified candidates must use the validated stage wrapper')
  const base = filename(e.BASE_VERSION), bridge = filename(e.BRIDGE_VERSION), next = filename(e.UPSTREAM_VERSION)
  download(oldRepo, baseTags[e.BASE_VERSION], 'old', [base, base + '.sig'])
  verifyPackage(readFileSync(location('old', e.BASE_VERSION)), e.OLD_PUBLIC_KEY, read(location('old', e.BASE_VERSION) + '.sig'))
  if (!probeOnly) {
  if (sameChannel) {
    // Candidate is still private: read its successful immutable tag-build artifact.
    assert.match(e.RELEASE_RUN_ID, /^[1-9]\d+$/)
    const releaseRun = JSON.parse(execFileSync('gh', ['api', `repos/${upstream}/actions/runs/${e.RELEASE_RUN_ID}`], { encoding: 'utf8' }))
    assert.equal(releaseRun.conclusion, 'success')
    assert.equal(releaseRun.path, '.github/workflows/friends-release.yml')
    assert.equal(releaseRun.head_branch, `friends-v${e.UPSTREAM_VERSION}`)
    assert.equal(releaseRun.event, 'push')
    mkdirSync(join(root, 'next'))
    execFileSync('gh', ['run', 'download', e.RELEASE_RUN_ID, '--repo', upstream, '--name', 'XHarness-friends-windows', '--dir', join(root, 'next')], { stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(read(join(root, 'next', 'updater.pub')), e.UPSTREAM_PUBLIC_KEY.trim())
    assert.equal(e.OLD_PUBLIC_KEY.trim(), e.UPSTREAM_PUBLIC_KEY.trim())
    assert.equal(manifest('next').platforms['windows-x86_64'].url,
      `https://github.com/${upstream}/releases/download/friends-v${e.UPSTREAM_VERSION}/${next}`)
    mkdirSync(join(root, 'bridge'))
    for (const name of [next, next + '.sig', 'latest.json']) copyFileSync(join(root, 'next', name), join(root, 'bridge', name))
    copyFileSync(location('next', e.UPSTREAM_VERSION) + '.sig', location('bridge', e.BRIDGE_VERSION) + '.upstream.sig')
  } else {
  // Draft releases require write-level access to read. Fetch the SAME immutable
  // workflow artifact with actions:read instead of granting release write access.
  assert.match(e.BRIDGE_RUN_ID, /^[1-9]\d+$/)
  const bridgeRun = JSON.parse(execFileSync('gh', ['api', `repos/${oldRepo}/actions/runs/${e.BRIDGE_RUN_ID}`], { encoding: 'utf8' }))
  assert.equal(bridgeRun.conclusion, 'success')
  assert.equal(bridgeRun.path, '.github/workflows/update-channel-bridge.yml')
  assert.equal(bridgeRun.head_branch, 'master')
  assert.equal(bridgeRun.event, 'workflow_dispatch')
  mkdirSync(join(root, 'bridge'))
  execFileSync('gh', ['run', 'download', e.BRIDGE_RUN_ID, '--repo', oldRepo, '--name', 'Windows-channel-bridge', '--dir', join(root, 'bridge')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const receipt = JSON.parse(read(join(root, 'bridge', 'migration.json')))
  assert.equal(receipt.old, oldRepo); assert.equal(receipt.upstream, upstream)
  assert.equal(receipt.bridge, e.BRIDGE_VERSION); assert.equal(receipt.target, e.UPSTREAM_VERSION)
  assert.equal(receipt.bridgeSha256, hash(location('bridge', e.BRIDGE_VERSION)))
  download(upstream, `friends-v${e.UPSTREAM_VERSION}`, 'next', [next, next + '.sig', 'latest.json'])
  }
  verifyPackage(readFileSync(location('old', e.BASE_VERSION)), e.OLD_PUBLIC_KEY, read(location('old', e.BASE_VERSION) + '.sig'))
  verifyPackage(readFileSync(location('bridge', e.BRIDGE_VERSION)), e.OLD_PUBLIC_KEY, read(location('bridge', e.BRIDGE_VERSION) + '.sig'))
  verifyPackage(readFileSync(location('bridge', e.BRIDGE_VERSION)), e.UPSTREAM_PUBLIC_KEY, read(location('bridge', e.BRIDGE_VERSION) + '.upstream.sig'))
  verifyPackage(readFileSync(location('next', e.UPSTREAM_VERSION)), e.UPSTREAM_PUBLIC_KEY, read(location('next', e.UPSTREAM_VERSION) + '.sig'))
  assert.equal(manifest('bridge').version, e.BRIDGE_VERSION)
  assert.equal(manifest('next').version, e.UPSTREAM_VERSION)
  assert.equal(manifest('bridge').platforms['windows-x86_64'].signature, read(location('bridge', e.BRIDGE_VERSION) + '.sig'))
  assert.equal(manifest('next').platforms['windows-x86_64'].signature, read(location('next', e.UPSTREAM_VERSION) + '.sig'))
  if (directLatest) assert.equal(hash(location('bridge', e.BRIDGE_VERSION)), hash(location('next', e.UPSTREAM_VERSION)))
  writeFileSync(join(evidence, 'packages.json'), JSON.stringify({ base: e.BASE_VERSION, bridge: e.BRIDGE_VERSION, next: e.UPSTREAM_VERSION,
    hashes: ['old', 'bridge', 'next'].map((kind, i) => ({ kind, sha256: hash(location(kind, [e.BASE_VERSION, e.BRIDGE_VERSION, e.UPSTREAM_VERSION][i])) })) }, null, 2))
  console.log('Downloaded and verified exact production packages; no private signing keys used.')
  } else console.log('Original installer verified for startup probe only; NOT migration acceptance.')
} else if (process.argv[2] === 'run') {
  await run().catch(error => {
    writeFileSync(join(evidence, 'FAIL.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2))
    console.error(error.stack)
    process.exitCode = 1
  })
} else throw new Error('Expected download or run')

async function run() {
  const { chromium } = await import(pathToFileURL(e.MIGRATION_TEST_DEPS).href)
  const data = join(e.APPDATA, 'com.xlang.xharness'), installDir = join(e.RUNNER_TEMP, 'XHarnessMigration')
  assert.ok(!existsSync(data), 'Refuse to modify pre-existing application data')
  assert.ok(!existsSync(installDir), 'Refuse pre-existing installation')
  mkdirSync(join(data, 'secrets'), { recursive: true })
  mkdirSync(join(data, 'workspace'), { recursive: true })
  const config = { default: { provider: 'fixture', model: 'fixture-model' }, providers: [{ id: 'fixture', display_name: 'Migration fixture', kind: 'openai-compatible',
    base_url: 'http://127.0.0.1:9/v1', protocol: 'chat', api_key_env: 'MIGRATION_FIXTURE_KEY', models: [{ id: 'fixture-model', display_name: 'Migration fixture model', fallback_context_window_tokens: 32768, max_output_tokens: 8192, minimum_output_tokens: 1024 }] }] }
  writeFileSync(join(data, 'providers.json'), JSON.stringify(config, null, 2))
  writeFileSync(join(data, 'secrets', 'migration_fixture_key'), 'not-a-real-model-credential')
  writeFileSync(join(data, 'workspace', '保留-fixture.txt'), 'Preserve workspace content across both updates.\n')
  const retained = ['providers.json', 'secrets/migration_fixture_key', 'workspace/保留-fixture.txt'].map(name => ({ name, sha256: hash(join(data, name)) }))
  const requests = [], checkpoints = []
  let rejectPackage = false
  const mappings = new Map(probeOnly ? [] : [
    [`/${oldRepo}/releases/latest/download/latest.json`, join(root, 'bridge', 'latest.json')],
    [`/${upstream}/releases/latest/download/latest.json`, join(root, 'next', 'latest.json')],
    [new URL(manifest('bridge').platforms['windows-x86_64'].url).pathname, location('bridge', e.BRIDGE_VERSION)],
    [new URL(manifest('next').platforms['windows-x86_64'].url).pathname, location('next', e.UPSTREAM_VERSION)],
  ])
  if (!probeOnly) for (const kind of ['bridge', 'next']) assert.equal(new URL(manifest(kind).platforms['windows-x86_64'].url).hostname, 'github.com')
  const tls = httpsServer({ pfx: readFileSync(e.MIGRATION_TEST_PFX), passphrase: 'disposable-ci-only' }, (req, res) => {
    const pathname = new URL(req.url, 'https://github.com').pathname
    requests.push({ pathname, time: new Date().toISOString() })
    const file = mappings.get(pathname)
    if (!file) { res.writeHead(404); res.end('not a migration fixture'); return }
    if (rejectPackage && pathname.endsWith('.exe')) { res.writeHead(200, { 'Content-Length': 9 }); res.end('CORRUPTED'); return }
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(res)
  })
  const proxy = httpServer((req, res) => { res.writeHead(403); res.end() })
  const sockets = new Set()
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== 'github.com:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) socket.unshift(head)
    tls.emit('connection', socket)
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const childEnv = { ...e, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1' }
  for (const name of Object.keys(childEnv)) if (/TOKEN|PASSWORD|PRIVATE_KEY|PUBLIC_KEY|DEEPSEEK|OPENAI|^XHARNESS_/i.test(name)) delete childEnv[name]
  let connection
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(fn, label, timeout = 90000) {
    const start = Date.now(); let last
    while (Date.now() - start < timeout) {
      try { const result = await fn(); if (result) return result } catch (error) { last = error.message }
      await wait(1000)
    }
    throw new Error(`${label} timed out: ${last ?? 'no result'}`)
  }
  const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args })
  async function attached(version) {
    return until(async () => {
      if (!connection?.isConnected()) connection = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 4000 })
      for (const context of connection.contexts()) for (const page of context.pages()) {
        writeFileSync(join(evidence, 'last-page.json'), JSON.stringify({ url: page.url(), expectedVersion: version }))
        if (!page.url().startsWith('http://127.0.0.1:')) continue
        const status = await invoke(page, 'desktop_status')
        if (status.version === version && status.hostRunning && status.updaterConfigured) {
          const notice = page.getByRole('button', { name: 'Continue', exact: true })
          if (await notice.isVisible().catch(() => false)) await notice.click()
          return page
        }
      }
      return null
    }, `App ${version} with running Host`)
  }
  async function rpc(page, method, payload) {
    const result = await page.evaluate(async ({ method, payload, rpcId }) => {
      const response = await fetch('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
      return response.json()
    }, { method, payload, rpcId: randomUUID() })
    assert.equal(result.result.ok, true, `RPC ${method} failed`)
    return result.result.value
  }
  const sessionId = 'migration-retained-session'
  async function checkpoint(page, version) {
    for (const file of retained) assert.equal(hash(join(data, file.name)), file.sha256, `${version}: ${file.name} changed`)
    assert.ok(JSON.stringify(await rpc(page, 'session.list', {})).includes(sessionId), `${version}: session lost`)
    assert.ok(JSON.stringify(await rpc(page, 'session.list', {})).includes('迁移保留测试'), `${version}: session title lost`)
    assert.ok(JSON.stringify(await rpc(page, 'session.models', { sessionId })).includes('fixture-model'), `${version}: model missing`)
    const status = await invoke(page, 'desktop_status')
    const executable = join(installDir, 'xharness-desktop.exe')
    const image = readFileSync(executable)
    const migrated = version !== e.BASE_VERSION
    const compiledEndpoint = `https://github.com/${migrated ? upstream : oldRepo}/releases/latest/download/latest.json`
    const compiledKey = (migrated ? e.UPSTREAM_PUBLIC_KEY : e.OLD_PUBLIC_KEY).trim()
    assert.ok(image.includes(Buffer.from(compiledEndpoint)), `${version}: installed update endpoint missing`)
    assert.ok(image.includes(Buffer.from(compiledKey)), `${version}: installed trusted public key missing`)
    if (migrated && !sameChannel) assert.ok(!image.includes(Buffer.from(e.OLD_PUBLIC_KEY.trim())), `${version}: still contains old updater trust key`)
    checkpoints.push({ version, status, retained, compiledEndpoint, compiledKeySha256: createHash('sha256').update(compiledKey).digest('hex'),
      executableSha256: hash(executable), journalSha256: hash(join(data, 'state', 'sessions', sessionId + '.jsonl')) })
    await page.screenshot({ path: join(evidence, `${version}.png`) })
    writeFileSync(join(evidence, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2))
    console.log(`Installed ${version}: Host healthy, session/title/model/config/credential/workspace retained.`)
  }
  try {
    console.log(`Installing original ${e.BASE_VERSION} into disposable runner.`)
    const installer = spawn(location('old', e.BASE_VERSION), ['/S', `/D=${installDir}`], { windowsHide: true, env: childEnv, stdio: 'ignore' })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { execFileSync('taskkill', ['/PID', String(installer.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already stopped */ }
        reject(new Error('Original NSIS installer exceeded 180 seconds'))
      }, 180000)
      installer.on('error', error => { clearTimeout(timer); reject(error) })
      installer.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0, 'Base NSIS install failed')
    console.log('Original installer exited successfully; starting installed desktop.')
    const executable = join(installDir, 'xharness-desktop.exe')
    assert.ok(existsSync(executable))
    spawn(executable, [], { windowsHide: true, env: childEnv, stdio: 'ignore' }).on('error', error => console.error(error.message))
    let page = await attached(e.BASE_VERSION)
    await rpc(page, 'session.create', { sessionId })
    await rpc(page, 'session.rename', { sessionId, title: '迁移保留测试' })
    await checkpoint(page, e.BASE_VERSION)
    if (probeOnly) {
      writeFileSync(join(evidence, 'PROBE-ONLY.json'), JSON.stringify({ nativeTwoHop: false, checkpoints }, null, 2))
      return
    }
    for (const version of (directLatest ? [e.UPSTREAM_VERSION] : [e.BRIDGE_VERSION, e.UPSTREAM_VERSION])) {
      const check = await until(async () => {
        const state = await invoke(page, 'desktop_check_update')
        if (state.phase === 'error') throw new Error(state.message)
        return state.phase === 'available' && state.version === version ? state : null
      }, `Discover ${version}`)
      assert.equal(check.version, version)
      if (version === e.BRIDGE_VERSION) {
        rejectPackage = true
        await invoke(page, 'desktop_download_update').catch(() => {})
        assert.equal((await invoke(page, 'desktop_update_status')).phase, 'error', 'Corrupted package was accepted')
        assert.equal((await invoke(page, 'desktop_status')).version, e.BASE_VERSION)
        rejectPackage = false
      }
      const downloaded = await invoke(page, 'desktop_download_update')
      assert.equal(downloaded.phase, 'downloaded')
      const rejected = await invoke(page, 'desktop_install_update', { confirmStop: false }).then(() => false, () => true)
      assert.ok(rejected, 'Install without confirmation must fail')
      assert.ok((await invoke(page, 'desktop_status')).hostRunning, 'Unconfirmed install stopped Host')
      // Actual native updater installs signed NSIS, stops Host, then restarts the app.
      void invoke(page, 'desktop_install_update', { confirmStop: true }).catch(() => {})
      page = await attached(version)
      await checkpoint(page, version)
    }
    assert.ok(requests.some(r => r.pathname === `/${oldRepo}/releases/latest/download/latest.json`))
    // NSIS restart may discard the test process's proxy environment. The second
    // native check/download/install then uses public upstream directly. Verify
    // installed endpoint AND new trust key above, as well as the real newer
    // native install; do not require interception as a proxy-inheritance test.
    const secondHopIntercepted = requests.some(r => r.pathname === `/${upstream}/releases/latest/download/latest.json`)
    assert.equal(checkpoints.length, directLatest ? 2 : 3)
    for (const checkpoint of checkpoints.slice(1)) assert.equal(checkpoints[0].journalSha256, checkpoint.journalSha256, 'Update rewrote the fixture journal')
    writeFileSync(join(evidence, 'PASS.json'), JSON.stringify({ nativeTwoHop: !directLatest, nativeDirectLatest: directLatest,
      installCount: checkpoints.length - 1, confirmedInstall: true, corruptPackageRejected: true,
      secondHopIntercepted, upstreamEndpointAndKeyVerified: true, checkpoints }, null, 2))
  } finally {
    if (connection?.isConnected()) {
      for (const context of connection.contexts()) for (const page of context.pages()) {
        try {
          await page.screenshot({ path: join(evidence, 'last-window.png'), timeout: 3000 })
          writeFileSync(join(evidence, 'last-window.txt'), (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 8000))
        } catch { /* window already closed */ }
      }
    }
    writeFileSync(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2))
    // Only disposable CI runner processes; never used on a user's workstation.
    for (const name of ['xharness-desktop.exe', 'xharness-host.exe']) {
      try { execFileSync('taskkill', ['/IM', name, '/T', '/F'], { stdio: 'ignore' }) } catch { /* already stopped */ }
    }
    for (const socket of sockets) socket.destroy()
    try { await Promise.race([connection?.close(), wait(3000)]) } catch { /* already closed by restart */ }
    proxy.closeAllConnections(); proxy.close(); tls.closeAllConnections(); tls.close()
  }
}
