import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'

const HOST_BIN = process.env.XHARNESS_HOST_BIN
const WEB_DIST = process.env.XHARNESS_WEB_DIST

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitForHost(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`xharness-host exited before readiness with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'web-e2e-ready',
          method: 'workspace.list',
          payload: {},
        }),
      })
      const body = await response.json()
      if (response.ok && body?.result?.ok && body.result.value.items.length > 0) return body
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`xharness-host did not become ready: ${String(lastError)}`)
}

class InterruptibleTcpProxy {
  constructor(frontPort, backPort) {
    this.frontPort = frontPort
    this.backPort = backPort
    this.server = undefined
    this.sockets = new Set()
  }

  async start() {
    assert.equal(this.server, undefined, 'proxy is already running')
    const server = net.createServer(client => {
      const upstream = net.createConnection({ host: '127.0.0.1', port: this.backPort })
      this.sockets.add(client)
      this.sockets.add(upstream)
      const cleanup = () => {
        this.sockets.delete(client)
        this.sockets.delete(upstream)
      }
      client.once('close', cleanup)
      upstream.once('close', cleanup)
      client.once('error', () => upstream.destroy())
      upstream.once('error', () => client.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    })
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.frontPort, '127.0.0.1', resolve)
    })
  }

  async stop() {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!stopped) {
    child.kill('SIGKILL')
    await exited
  }
}

function rpc(page, method, payload) {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `e2e-${method}`,
        method,
        payload,
      }),
    })
    return response.json()
  }, { method, payload })
}

async function poll(assertion, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await assertion()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`${description}: ${String(lastError)}`)
}

test('真实 Web 完成权限确认，并在第 8 次失败后恢复全部运行时基线', { timeout: 150_000 }, async (t) => {
  assert(HOST_BIN, 'set XHARNESS_HOST_BIN to the compiled xharness-host executable')
  assert(WEB_DIST, 'set XHARNESS_WEB_DIST to the assembled Web dist directory')
  await stat(HOST_BIN)
  await readFile(path.join(WEB_DIST, 'index.html'))

  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xharness-web-e2e-')))
  const backendPort = await freePort()
  const frontendPort = await freePort()
  const child = spawn(HOST_BIN, [
    '--bind', `127.0.0.1:${backendPort}`,
    '--workspace', workspace,
    '--static-dir', WEB_DIST,
    // Permission controls require one selected model, but this scenario never
    // sends a prompt. A syntactically valid dead endpoint proves the UI test
    // does not accidentally depend on model inference.
    '--model', 'e2e-no-inference',
    '--base-url', 'http://127.0.0.1:1/v1',
    '--api-key', 'e2e-not-used',
    '--context-window', '32768',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const proxy = new InterruptibleTcpProxy(frontendPort, backendPort)
  let browser
  t.after(async () => {
    await browser?.close()
    await proxy.stop()
    await stopChild(child)
    await rm(workspace, { recursive: true, force: true })
  })

  const ready = await waitForHost(backendPort, child)
  assert.equal(ready.result.value.items[0].workspaceId, 'workspace-default')
  assert.equal(ready.result.value.items[0].path, workspace)
  await proxy.start()

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  const retries = []
  const successfulApiPaths = []
  page.on('console', message => {
    const match = message.text().match(/connection lost, retry #(\d+)/)
    if (match) retries.push(Number(match[1]))
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (response.ok() && url.pathname.startsWith('/api/')) successfulApiPaths.push(url.pathname)
  })
  page.on('pageerror', error => {
    // Keep the failure report actionable without rejecting on optional plugin diagnostics.
    process.stderr.write(`[web-e2e pageerror] ${error.message}\n`)
  })

  await page.goto(`http://127.0.0.1:${frontendPort}/`, { waitUntil: 'load' })
  await page.getByText(path.basename(workspace), { exact: true }).first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  // A boot Workspace intentionally has no current Session. Create one through
  // the real Host API, persist the same selection cell as the Web runtime and
  // reload so the composer owns a real Session projection before permission
  // and reconnect assertions begin.
  const created = await rpc(page, 'session.create', { workspaceId: 'workspace-default' })
  assert.equal(created.result.ok, true)
  const sessionId = created.result.value.sessionId
  await page.evaluate((id) => {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, sessionId)
  await page.reload({ waitUntil: 'load' })

  const workspaceWrite = page.getByRole('button', { name: 'Access mode, current: Workspace Write' })
  await workspaceWrite.waitFor({ state: 'visible', timeout: 30_000 })
  if (!await workspaceWrite.isEnabled()) {
    process.stderr.write(`[web-e2e boot] ${JSON.stringify({
      retries,
      successfulApiPaths,
      body: await page.locator('body').innerText(),
      storage: await page.evaluate(() => localStorage.getItem('dsh.sessions.current')),
    })}\n`)
  }
  await poll(
    async () => assert.equal(await workspaceWrite.isEnabled(), true, `access mode disabled; host stderr: ${stderr}`),
    30_000,
    'the access mode control did not become interactive',
  )

  await workspaceWrite.click()
  await page.getByRole('menuitem', { name: 'Full access' }).click()
  await page.getByRole('dialog', { name: 'Enable Full access?' }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await page.getByRole('dialog', { name: 'Enable Full access?' }).count(), 0)
  await workspaceWrite.waitFor({ state: 'visible' })

  await workspaceWrite.click()
  await page.getByRole('menuitem', { name: 'Full access' }).click()
  const enable = page.getByRole('button', { name: 'Enable Full access' })
  assert.equal(await enable.isDisabled(), true)
  await page.getByRole('checkbox').check()
  await enable.click()
  const fullAccess = page.getByRole('button', { name: 'Access mode, current: Full access' })
  await fullAccess.waitFor({ state: 'visible', timeout: 10_000 })

  // A browser refresh must rebuild the picker from the durable permissions
  // projection rather than falling back to the default preset.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await fullAccess.waitFor({ state: 'visible', timeout: 30_000 })

  await poll(
    () => assert(successfulApiPaths.includes('/api/session.history')),
    10_000,
    'the selected session did not load its history before interruption',
  )

  successfulApiPaths.length = 0
  await proxy.stop()
  await poll(
    () => assert(retries.some(attempt => attempt >= 8), `observed retries: ${retries.join(', ')}`),
    55_000,
    'the client stopped before retry #8',
  )
  await proxy.start()

  await fullAccess.waitFor({ state: 'visible', timeout: 30_000 })
  await poll(() => {
    for (const required of [
      '/api/host.describe',
      '/api/workspace.list',
      '/api/session.list',
      '/api/session.history',
      '/api/settings.describe',
    ]) {
      assert(successfulApiPaths.includes(required), `missing ${required}; saw ${successfulApiPaths.join(', ')}`)
    }
  }, 20_000, 'the Web runtime did not re-fetch every baseline after reconnect')

  assert.equal(retries.at(-1) >= 8, true)
  assert.equal(await fullAccess.isEnabled(), true)
})
