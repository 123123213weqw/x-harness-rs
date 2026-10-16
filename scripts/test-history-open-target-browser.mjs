/** Actual maintained Runtime + Conversation + virtual rows on both engines.
 * Synthetic RPC pages let the test hold cold opens at deterministic boundaries. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { root, runtimeTestSource, conversationBrowserTestSource } from './runtime-source-test-harness.mjs'
import { installOwnedViewPlatform } from './fixtures/owned-view-platform-browser.mjs'
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await require('playwright')[engine].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
  const errors = []
  page.on('pageerror', e => { if (!e.message.includes('owned feature fixture: stop Host boot')) errors.push(e.message) })
  await installOwnedViewPlatform(page, 'source')
  await page.evaluate(() => { window.registrations = {}; window.__ModuleLoader__ = { load: r => { registrations[r.id] = r } } })
  for (const name of readdirSync(resolve(root, 'ui/dist/plugins/@xharness'))) {
    const source = name === 'dsh-client-runtime' ? runtimeTestSource() : name === 'dsh-client-ui-conversation'
      ? conversationBrowserTestSource() : readFileSync(resolve(root, 'ui/dist/plugins/@xharness', name, 'client.js'), 'utf8')
    await page.addScriptTag({ content: source })
  }
  await page.evaluate(async () => {
    const cache = {}
    const load = id => {
      if (staticModules[id]) return staticModules[id]
      const name = id.endsWith('/client') ? id.slice(0, -7) : id
      return cache[name] ?? (cache[name] = registrations[name].factory(load))
    }
    const runtime = load('@xharness/dsh-client-runtime/client'), ui = load('@xharness/dsh-client-ui-conversation/client')
    const definitions = [], views = []; let fallback
    ui.registerConversationNodes({ conversationEvents: { register: d => definitions.push(d), registerFallback: d => { fallback = d } }, conversationViews: { register: d => views.push(d) } })
    const conversation = { events: { entries: () => definitions, fallbackEntry: () => fallback }, views: { entries: () => views } }
    const row = seq => ({ event: { seq, time: seq, type: 'user/message', surfaceOp: 'append', data: { id: String(seq), source: { kind: 'user' }, content: [{ type: 'text', text: 'Message ' + seq }], text: 'Message ' + seq } } })
    const pageOf = (before = 201) => { const start = Math.max(1, before - 50); return { events: Array.from({ length: before - start }, (_, i) => row(start + i)), hasMore: start > 1 } }
    window.calls = []; window.hold = false; window.releaseTail = undefined
    const api = { sessions: { history: async p => {
      calls.push(p.beforeSeq ?? null)
      if (hold && p.beforeSeq === undefined) await new Promise(r => { window.releaseTail = r })
      await new Promise(r => setTimeout(r, 10))
      return { result: { ok: true, value: pageOf(p.beforeSeq) } }
    } } }
    window.manager = new runtime.SessionManager(api, {}, undefined, undefined, conversation)
    for (const sessionId of ['reader', 'other']) manager.summaries.push({ sessionId, running: false, blank: false })
    manager.select('reader'); window.session = manager.get('reader'); await session.open()
    while (session.hasMore) await session.loadOlder()
    window.memory = new ui.ChatScrollMemory((id, position) => {
      const seq = position?.anchorSeq
      manager.get(id).setHistoryOpenTarget(position === null ? { kind: 'latest' }
        : seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 ? { kind: 'anchor', seq } : undefined)
    })
    const R = staticModules.react, D = staticModules['react-dom']
    const hook = select => select(R.useSyncExternalStore(fn => session.subscribe(fn), () => session.getSnapshot()))
    let root
    window.mount = () => {
      const props = { sessionId: 'reader', useSession: hook, useSessions: select => select({ byId: {} }), useStore: select => select({}), t: k => k,
        chatScroll: memory.forSession('reader'), fileMentions: () => undefined, openFile: async () => {}, loadImage: async () => '', inspectCall: () => {}, forkAt: () => {}, editMessage: () => {},
        loadOlder: () => session.loadOlder(), renderSlot: (_slot, owner) => R.createElement('div', { 'data-heavy-message': owner.node.key, style: { height: 140, borderBottom: '1px solid gray' } }, 'Message ' + owner.node.anchorSeq) }
      root = D.createRoot(document.getElementById('root'))
      D.flushSync(() => root.render(R.createElement('div', { 'data-conversation-scroll': '', style: { height: 650, overflowY: 'auto', overflowAnchor: 'none' } }, R.createElement(ui.ChatView, props))))
    }
    window.unmount = () => { D.flushSync(() => root.unmount()); root = undefined }
    window.evict = async () => {
      unmount(); manager.select('other'); await manager.get('other').open()
      manager.xhHistoryCache.limits.maxInactiveSessions = 0; manager.historyCacheStats()
      if (session.openState !== 'cold') throw Error('production LRU did not evict reader')
      calls.length = 0
    }
    window.reopen = () => {
      hold = true; window.releaseTail = undefined; manager.select('reader'); window.opening = session.open(); mount()
    }
    window.state = () => ({ state: session.openState, base: session.baseSeq, hasMore: session.hasMore, calls: [...calls], bookmark: memory.forSession('reader').read(), loaded: session.events.length })
    mount()
  })
  const port = page.locator('[data-conversation-scroll]')
  const settle = () => port.evaluate(e => new Promise((resolve, reject) => {
    let previous = '', stable = performance.now(); const start = stable
    const sample = () => {
      const next = [e.scrollTop, e.scrollHeight, e.clientHeight].join(':')
      if (next !== previous) { previous = next; stable = performance.now() }
      if (performance.now() - stable > 180) return resolve()
      if (performance.now() - start > 6000) return reject(Error('reader geometry did not settle: ' + next))
      requestAnimationFrame(sample)
    }; requestAnimationFrame(sample)
  }))
  await settle()
  assert.equal((await page.evaluate(() => state())).bookmark, null)
  // Real upward input captures the data-layer seq separately from opaque keys.
  await port.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    const row = e.querySelector('[data-chat-anchor-seq="125"]')
    e.scrollTop += row.getBoundingClientRect().top - e.getBoundingClientRect().top + 35
    e.dispatchEvent(new Event('scroll'))
  })
  await settle()
  const saved = (await page.evaluate(() => state())).bookmark
  assert.ok(saved && Number.isSafeInteger(saved.anchorSeq), JSON.stringify(saved))
  const anchorOffset = () => port.evaluate((e, key) => {
    const row = [...e.querySelectorAll('[data-chat-anchor-key]')].find(row => row.dataset.chatAnchorKey === key)
    return row ? row.getBoundingClientRect().top - e.getBoundingClientRect().top : null
  }, saved.anchorKey)
  const before = await anchorOffset()
  assert.ok(before <= 0 && before > -200, 'bookmark is the top visible message')
  await page.evaluate(() => evict())
  await page.evaluate(() => reopen())
  await page.waitForFunction(() => typeof releaseTail === 'function')
  // Empty cold layout and a passive scroll event must not erase the target.
  await port.evaluate(e => { e.dispatchEvent(new Event('scroll')); e.style.height = '630px' })
  await page.waitForTimeout(100)
  assert.deepEqual((await page.evaluate(() => state())).bookmark, saved)
  assert.equal(await page.locator('[data-heavy-message]').count(), 0, 'no tail-first flash while restoring an older reader')
  await page.evaluate(() => { hold = false; releaseTail() })
  await page.waitForFunction(() => state().state === 'open')
  await settle()
  const restored = await page.evaluate(() => state())
  assert.deepEqual(restored.calls, [null, 151], 'only reach the bookmark page, not the previous all-history boundary')
  assert.equal(restored.hasMore, true)
  assert.ok(Math.abs((await anchorOffset()) - before) < 2, JSON.stringify({ before, after: await anchorOffset(), saved, restored }))
  assert.ok(await page.locator('[data-heavy-message]').count() < 30, 'windowing stays bounded')
  // Explicit paging still prepends without moving the same visible anchor.
  await page.getByRole('button', { name: 'chat.loadOlder', exact: true }).evaluate(e => e.click())
  await page.waitForFunction(() => state().base === 51)
  await settle()
  assert.ok(Math.abs((await anchorOffset()) - before) < 2, 'pagination preserves the restored reader')
  // Expand all again, return to bottom, and reopen: never reload that old range.
  await page.evaluate(async () => { while (session.hasMore) await session.loadOlder(); memory.requestFollow('reader') })
  await settle()
  assert.equal((await page.evaluate(() => state())).bookmark, null)
  await page.evaluate(() => evict()); await page.evaluate(() => reopen())
  await page.waitForFunction(() => typeof releaseTail === 'function')
  await page.evaluate(() => { hold = false; releaseTail() })
  await page.waitForFunction(() => state().state === 'open'); await settle()
  const latest = await page.evaluate(() => state())
  assert.deepEqual(latest.calls, [null]); assert.equal(latest.loaded, 50); assert.equal(latest.hasMore, true)
  assert.ok(await port.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop < 2), 'latest reopen follows the actual floor')
  // Explicit follow during a cold open supersedes an older bookmark.
  await port.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    e.scrollTop -= 350; e.dispatchEvent(new Event('scroll'))
  })
  await settle(); assert.ok((await page.evaluate(() => state())).bookmark)
  await page.evaluate(() => evict()); await page.evaluate(() => reopen())
  await page.waitForFunction(() => typeof releaseTail === 'function')
  await page.evaluate(() => { memory.requestFollow('reader'); hold = false; releaseTail() })
  await page.waitForFunction(() => state().state === 'open'); await settle()
  assert.equal((await page.evaluate(() => state())).bookmark, null)
  assert.ok(await port.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop < 2))
  await page.evaluate(() => unmount())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, anchor: { seq: saved.anchorSeq, offsetBefore: before }, restoredPages: restored.calls.length, latestPages: latest.calls.length, pagination: 'preserved', windowing: 'bounded', coldLayout: 'bookmark retained', explicitFollow: 'supersedes bookmark' }))
} finally { await browser.close() }
