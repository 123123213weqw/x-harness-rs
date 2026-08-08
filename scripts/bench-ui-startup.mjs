/** Paired full generated UI startup, fixture carrier only; NOT native Tauri or OS-cold startup. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs'
import {resolve, sep, extname} from 'node:path'

const baseline = process.env.UI_STARTUP_BASELINE
assert.ok(baseline, 'UI_STARTUP_BASELINE must name the preserved, same-commit original ui/dist')
const roots = {baseline: resolve(baseline), optimized: resolve('ui/dist')}
const output = resolve(process.env.UI_STARTUP_RESULTS ?? '/tmp/xh-ui-startup-results')
const repetitions = Number(process.env.UI_STARTUP_REPEATS ?? 5)
const session = process.env.UI_STARTUP_SESSION ?? null
assert.ok(session === null || session === 'fx-alpha', 'only the built-in isolated history fixture is admitted')
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 30)
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? 'ui', 'package.json'))
const playwright = require('playwright'), receipts = []
const contentTypes = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png'}
const servers = {}
for (const [name, base] of Object.entries(roots)) {
  assert.ok(existsSync(resolve(base, 'index.html')))
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const local = resolve(base, '.' + decodeURIComponent(path === '/' ? '/index.html' : path))
    if (!local.startsWith(base + sep) || !existsSync(local)) {response.writeHead(404); response.end(); return}
    response.writeHead(200, {'Content-Type': contentTypes[extname(local)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'})
    response.end(readFileSync(local))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers[name] = {server, url: `http://127.0.0.1:${server.address().port}/?fixture=1`}
}
function browserMemory() {
  if (process.platform !== 'linux') return null
  const children = new Set([process.pid])
  // Follow only our threads' child lists; scanning every process on a busy
  // shared server would itself compete with the asset server on each sample.
  for (const pid of children) try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      const ids = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/)
      for (const id of ids) if (/^\d+$/.test(id)) children.add(Number(id))
    }
  } catch {}
  children.delete(process.pid)
  let pssKiB = 0, rssKiB = 0, count = 0
  for (const pid of children) try {
    const data = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    pssKiB += Number(data.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0)
    rssKiB += Number(data.match(/^Rss:\s+(\d+)/m)?.[1] ?? 0); count++
  } catch {}
  return {pssMiB: pssKiB / 1024, rssMiB: rssKiB / 1024, processes: count}
}
try {
  for (const engine of ['chromium', 'webkit']) for (let repetition = 0; repetition < repetitions; repetition++) {
    // Alternate order; each run has a new browser process/context (no HTTP or JS cache reuse).
    for (const variant of repetition % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
      const browser = await playwright[engine].launch({headless: true, ...(engine === 'chromium' ? {args: ['--enable-precise-memory-info']} : {})})
      let sampler
      try {
        const page = await browser.newPage({viewport: {width: 1280, height: 820}, locale: 'en-US'})
        const errors = [], requests = [], samples = [], start = performance.now()
        page.on('pageerror', error => errors.push(error.message))
        page.on('request', request => requests.push(new URL(request.url()).pathname))
        sampler = setInterval(() => {const memory = browserMemory(); if (memory) samples.push({atMs: performance.now() - start, ...memory})}, 50)
        await page.addInitScript(session => {
          let facade
          Object.defineProperty(window, '__ModuleLoader__', {configurable: true, get: () => facade, set: value => {
            const create = value.create
            value.create = function(options) {window.benchPlatform = options.staticModules; return create.call(this, options)}
            facade = value
          }})
          if (session !== null) localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId: session}))
          const result = window.startupBench = {commitMs: null, frameMs: null, longTasks: [], paints: [], frameGaps: [], previousFrame: null, beforeFrameHeap: null}
          if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
            for (const entry of list.getEntries()) result.longTasks.push({startMs: entry.startTime, durationMs: entry.duration})
          }).observe({type: 'longtask', buffered: true})
          if (PerformanceObserver.supportedEntryTypes.includes('paint')) new PerformanceObserver(list => {
            for (const entry of list.getEntries()) result.paints.push({name: entry.name, atMs: entry.startTime})
          }).observe({type: 'paint', buffered: true})
          const observer = new MutationObserver(() => {
            const root = document.getElementById('root')
            if (result.commitMs !== null || !root?.querySelector('textarea,[contenteditable="true"]') || root.querySelector('[data-dsh-boot]')) return
            result.commitMs = performance.now()
            result.beforeFrameHeap = performance.memory?.usedJSHeapSize ?? null
            observer.disconnect()
            requestAnimationFrame(() => requestAnimationFrame(() => {result.frameMs = performance.now()}))
          })
          observer.observe(document, {childList: true, subtree: true})
          function frame(now) {
            if (result.previousFrame !== null) result.frameGaps.push({atMs: now, gapMs: now - result.previousFrame})
            result.previousFrame = now
            if (result.frameMs === null || now < result.frameMs + 1500) requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        }, session)
        await page.goto(servers[variant].url)
        await page.waitForFunction(() => window.startupBench.frameMs !== null, {}, {timeout: 60000})
        await page.waitForTimeout(1800) // measurement interval, never a production readiness gate
        const startupPeakBrowserPssMiB = samples.length ? Math.max(...samples.map(x => x.pssMiB)) : null
        let heapMiB = null
        if (engine === 'chromium') {
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('HeapProfiler.collectGarbage')
          heapMiB = (await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576
          await cdp.detach()
        }
        const observation = await page.evaluate(() => ({...window.startupBench, buttons: document.querySelectorAll('button').length, inputs: document.querySelectorAll('textarea,[contenteditable="true"]').length, codeBlocks: document.querySelectorAll('.shiki').length}))
        assert.deepEqual(errors, [], 'full graph must boot without runtime errors')
        assert.ok(observation.buttons > 5 && observation.inputs > 0)
        assert.equal(await page.getByRole('button', {name: 'Settings', exact: true}).count(), 1)
        if (session === null) assert.equal(await page.getByRole('button', {name: /Select model, current/}).count(), 1)
        assert.ok(!requests.some(path => path.startsWith('/api/')), 'no real Host or paid model calls')
        const firstCode = await page.evaluate(async () => {
          const R = benchPlatform.react, D = benchPlatform['react-dom'], P = benchPlatform['@xharness/dsh-client-ui-primitives']
          const host = document.createElement('div'); document.body.append(host)
          const root = benchPlatform['react-dom/client'].createRoot(host), results = []
          let active = true, lastFrame = performance.now(); const gaps = [];
          function tick(now) {gaps.push(now-lastFrame); lastFrame=now; if(active) requestAnimationFrame(tick)}
          requestAnimationFrame(tick);
          for (const [lang, code] of [['json', '{"answer":42}'], ['typescript', 'const answer: number = 42'], ['typescript', 'const again = 43']]) {
            const start = performance.now(), gapStart = gaps.length
            D.flushSync(() => root.render(R.createElement(P.CodeBlock, {lang, code})))
            const initialMs = performance.now() - start;
            const immediateExact = host.querySelector('pre')?.textContent === code;
            const initialHeight = host.querySelector('pre')?.getBoundingClientRect().height;
            while (!host.querySelector('.shiki') && performance.now() - start < 10000) await new Promise(requestAnimationFrame);
            results.push({lang, initialMs, immediateExact, maxFrameGapMs: gaps.length > gapStart ? Math.max(...gaps.slice(gapStart)) : null, elapsedMs: performance.now() - start, stableHeight: initialHeight === host.querySelector('pre')?.getBoundingClientRect().height, exact: host.querySelector('pre')?.textContent === code, highlighted: Boolean(host.querySelector('.shiki'))})
          }
          active=false; root.unmount(); host.remove(); return results
        })
        clearInterval(sampler)
        assert.ok(firstCode.every(row => row.immediateExact && row.exact && row.highlighted && row.stableHeight), 'first demanded grammar must preserve exact highlighted code')
        const plugins = requests.filter(path => path.startsWith('/plugins/') && path.endsWith('/client.js')).sort()
        const receipt = {engine, variant, repetition, session, ...observation, firstCode, heapMiB, startupPeakBrowserPssMiB, peakBrowserPssMiB: samples.length ? Math.max(...samples.map(x => x.pssMiB)) : null, peakBrowserRssMiB: samples.length ? Math.max(...samples.map(x => x.rssMiB)) : null, plugins, errors, memorySamples: samples}
        receipts.push(receipt)
        console.log(JSON.stringify({engine, variant, repetition, commitMs: receipt.commitMs, frameMs: receipt.frameMs, heapMiB, peakBrowserPssMiB: receipt.peakBrowserPssMiB}))
      } finally {clearInterval(sampler); await browser.close()}
    }
  }
  for (const engine of ['chromium', 'webkit']) {
    const both = receipts.filter(row => row.engine === engine)
    for (const row of both) assert.deepEqual(row.plugins, both[0].plugins, 'optimization cannot omit a client plugin')
    // A restored virtual list can mount different overscan rows as heights
    // settle; its total button/code DOM count is not a content-integrity oracle.
    // The complete graph/navigation/type/pixel suites own functional parity.
    for (const key of session === null ? ['buttons', 'inputs', 'codeBlocks'] : ['inputs']) {
      for (const row of both) assert.equal(row[key], both[0][key], 'same fixture controls: ' + key)
    }
  }
} finally {
  for (const {server} of Object.values(servers)) await new Promise(resolve => server.close(resolve))
  mkdirSync(output, {recursive: true})
  writeFileSync(resolve(output, 'browser-startup.json'), JSON.stringify({scope: 'Generated UI/full plugin graph/fixture carrier/fresh browser; PSS is browser process tree, NOT Tauri or Mac', repetitions, session, receipts}, null, 2) + '\n')
}
