// Actual maintained ChatView + row windowing, deterministic stream/gesture races.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { compile } from './conversation-test-harness.mjs'
const deps = process.env.UI_TEST_DEPS ?? '/tmp/ui-tests'
const require = createRequire(resolve(deps, 'package.json'))
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const browser = await require('playwright')[engine].launch({ headless: true })
const source = compile().test
const output = process.env.UI_TEST_OUTPUT
if (output) mkdirSync(output, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 950, height: 700 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.setContent('<html><body style="margin:0"><div id="root"></div></body></html>')
  for (const f of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) await page.addScriptTag({ path: resolve(deps, 'node_modules', f) })
  await page.addStyleTag({ content: ':root{--dsh-chat-content-width:900px;--dsw-alias-label-primary:#222;--dsw-alias-bg-base:#fff}body{font:14px system-ui}button{font:inherit}' })
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load:r=>window.registration=r}' })
  await page.addScriptTag({ content: source })
  await page.evaluate(() => {
    const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key })
    const store = initial => { let value = initial; const listeners = new Set(); return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, set: next => { value = next; listeners.forEach(fn => fn()) } } }
    const runtime = { isAppendSurfaceEvent: () => true, toAssistantBlocks: x => x, createSnapshotStore: store, defineStore: x => x }
    const primitives = new Proxy({ Tooltip: ({ children }) => children }, { get: (o, k) => o[k] ?? (() => jsx('svg', { width: 14, height: 14 })) })
    const plugin = registration.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: React.Fragment } : name === '@xharness/dsh-client-ui-primitives' ? primitives : name === '@xharness/dsh-client-runtime/client' ? runtime : name === '@xharness/cordis' ? { Service: class {} } : {})
    const hook = s => select => select(React.useSyncExternalStore(s.subscribe, s.getSnapshot))
    // These are valid owned Nodes: ChatNodeSeat must dispatch the real keyed
    // renderer, not silently fall back to an unknown/invalid JSON payload.
    const node = i => ({ key: String(i), anchorSeq: i, kind: i === 0 ? 'user' : 'assistant-step', data: i === 0
      ? { kind: 'user', seq: i, time: i, content: [], source: { kind: 'user' }, height: 140 }
      : { status: 'running', turn: 0, step: i, blocks: [], time: i, height: 140 } })
    const nodes = new Map(Array.from({ length: 80 }, (_, i) => [String(i), node(i)]))
    window.snapshot = store({ running: true, queue: [], openState: 'open', openError: null, hasMore: false, loadingOlder: false, chat: { order: [...nodes.keys()], nodes, timeline: { turns: new Map() }, locations: { getTurn: () => [] } } })
    const summaries = store({ byId: {} }), details = store({})
    window.saved = null
    window.grow = (append = false) => {
      const snap = snapshot.getSnapshot(), nodes = new Map(snap.chat.nodes), key = snap.chat.order.at(-1)
      const node = nodes.get(key)
      if (append) {
        const next = String(nodes.size)
        nodes.set(next, { key: next, anchorSeq: nodes.size, kind: 'assistant-step', data: { status: 'running', turn: 0, step: nodes.size, blocks: [], time: nodes.size, height: 140 } })
        ReactDOM.flushSync(() => snapshot.set({ ...snap, chat: { ...snap.chat, nodes, order: [...snap.chat.order, next] } }))
      } else {
        nodes.set(key, { ...node, data: { height: node.data.height + 50 } })
        ReactDOM.flushSync(() => snapshot.set({ ...snap, chat: { ...snap.chat, nodes } }))
      }
    }
    window.shrink = () => {
      const snap = snapshot.getSnapshot()
      ReactDOM.flushSync(() => snapshot.set({ ...snap, chat: { ...snap.chat, order: snap.chat.order.slice(-10) } }))
    }
    const props = { sessionId: 'scroll-fixture', useSession: hook(snapshot), useSessions: hook(summaries), useStore: hook(details),
      t: k => k === 'chat.toBottom' ? 'Back to bottom' : k, openFile: async () => {}, loadOlder: () => {}, loadImage: async () => '', inspectCall: () => {}, forkAt: () => {}, fileMentions: () => undefined, editMessage: () => {}, forkMessage: () => {},
      chatScroll: { read: () => saved, save: value => { saved = value } },
      renderSlot: (_key, owner) => jsx('div', { style: { height: owner.node.data.height, borderBottom: '1px solid #ddd' }, children: ['Message ' + owner.node.key, owner.node.key === '0' && jsx('textarea', { 'aria-label': 'Fixture draft' })] }) }
    const root = ReactDOM.createRoot(document.getElementById('root'))
    ReactDOM.flushSync(() => root.render(jsx('div', { 'data-conversation-scroll': '', tabIndex: 0, style: { height: 650, overflowY: 'auto', overflowAnchor: 'none' }, children: jsx(plugin.ChatView, props) })))
    window.unmount = () => root.unmount()
  })
  const scroll = page.locator('[data-conversation-scroll]'), jump = page.getByRole('button', { name: 'Back to bottom', exact: true })
  const geometry = () => scroll.evaluate(e => ({ top: e.scrollTop, gap: e.scrollHeight - e.clientHeight - e.scrollTop }))
  // Native wheel scrolling is asynchronous (Linux WebKit animates it beyond
  // 150ms). Observe stable geometry instead of taking a mid-gesture snapshot.
  // The deadline and bounded samples also make a genuinely stuck test fail.
  const settledGeometry = () => scroll.evaluate(e => new Promise((resolve, reject) => {
    const start = performance.now(), samples = []
    let previous, stableSince = start, frame, maxTop = e.scrollTop
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame)
      reject(new Error('Scroll geometry did not settle: ' + JSON.stringify(samples)))
    }, 3000)
    const sample = now => {
      const current = { top: e.scrollTop, height: e.scrollHeight, viewport: e.clientHeight }
      maxTop = Math.max(maxTop, current.top)
      samples.push({ ms: Math.round(now - start), ...current })
      if (samples.length > 60) samples.shift()
      if (!previous || current.top !== previous.top || current.height !== previous.height || current.viewport !== previous.viewport) stableSince = now
      previous = current
      if (now - stableSince >= 120) {
        clearTimeout(timeout)
        resolve({ ...current, gap: current.height - current.viewport - current.top, maxTop, samples })
      } else frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
  }))
  await page.waitForFunction(() => { const e = document.querySelector('[data-conversation-scroll]'); return e.scrollTop > 9000 })
  await page.waitForTimeout(100)
  await page.evaluate(() => grow())
  await page.waitForTimeout(100)
  assert.ok((await geometry()).gap <= 1, 'Ordinary streaming stays pinned')
  // Just 4px upward, still inside the old 25px threshold. A same-node delta
  // activates ResizeObserver, not a newly appended row or a turn boundary.
  const tinyTop = await scroll.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -4 }))
    e.scrollTop -= 4
    e.dispatchEvent(new Event('scroll'))
    return e.scrollTop
  })
  await page.evaluate(() => grow())
  await page.waitForTimeout(150)
  if (output) await page.screenshot({ path: join(output, `${engine}-tiny-up.png`) })
  assert.ok(Math.abs((await geometry()).top - tinyTop) < 2, '4px upward reader scroll must not be pulled down by streamed height growth')
  assert.equal(await jump.count(), 1, 'Any upward intent relinquishes bottom-follow')
  // A native anchor correction may move down within the attribution window.
  // It must not be mistaken for a new downward gesture by the reader.
  const adjustedTop = await scroll.evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); return e.scrollTop })
  await page.evaluate(() => grow())
  await page.waitForTimeout(100)
  assert.ok(Math.abs((await geometry()).top - adjustedTop) < 2, 'Post-up geometry correction cannot steal reading ownership')
  // Reading mode remains paused after the old gesture attribution timeout.
  await page.waitForTimeout(1600)
  await page.evaluate(() => grow(true))
  await page.waitForTimeout(100)
  assert.ok(Math.abs((await geometry()).top - adjustedTop) < 2, 'Reading mode must not expire with a timer')
  await jump.click()
  await page.evaluate(() => grow())
  await page.waitForTimeout(100)
  assert.ok((await geometry()).gap <= 1, 'Explicit jump restores streaming follow')
  // Data can commit before the browser delivers the first scroll event.
  const raceTop = await scroll.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -6 }))
    e.scrollTop -= 6
    const top = e.scrollTop
    grow(true)
    return top
  })
  await page.waitForTimeout(150)
  assert.ok(Math.abs((await geometry()).top - raceTop) < 2, 'Upward intent wins before the delayed scroll event/layout effect')
  await jump.click()
  const keyTop = (await geometry()).top
  await scroll.evaluate(e => { e.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })); grow(true) })
  await page.waitForTimeout(100)
  assert.ok(Math.abs((await geometry()).top - keyTop) < 2, 'Upward keyboard intent wins before movement is delivered')
  await jump.click()
  const touchTop = (await geometry()).top
  await scroll.evaluate(e => {
    const fire = (name, y) => { const event = new Event(name, { bubbles: true }); Object.defineProperty(event, 'touches', { value: [{ clientY: y }] }); e.dispatchEvent(event) }
    fire('touchstart', 100); fire('touchmove', 110)
    e.scrollTop -= 4; e.dispatchEvent(new Event('scroll'))
    fire('touchmove', 110) // A stationary touch frame must not erase up intent.
    e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll'))
    grow(true)
    fire('touchend', 110)
  })
  await page.waitForTimeout(100)
  assert.ok(Math.abs((await geometry()).top - touchTop) < 2, 'Finger moving down (reading upward) detaches before streaming')
  // Downward reader motion to the floor may restore follow; a browser-native
  // clamp without reader input must never turn paused reading back on.
  await scroll.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1000 }))
    e.scrollTop = e.scrollHeight
    e.dispatchEvent(new Event('scroll'))
  })
  await page.evaluate(() => grow())
  await page.waitForTimeout(100)
  assert.ok((await geometry()).gap <= 1, 'Reader scrolling down to bottom resumes follow')
  await scroll.evaluate(e => { e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })); e.scrollTop -= 100; e.dispatchEvent(new Event('scroll')) })
  await page.evaluate(() => shrink())
  await page.waitForTimeout(100)
  const compactTop = (await geometry()).top
  await page.evaluate(() => grow())
  await page.waitForTimeout(100)
  assert.ok(Math.abs((await geometry()).top - compactTop) < 2, 'Compaction/clamp does not re-pin a reader')
  await jump.click()
  // Zoom, horizontal motion and editable-field keys do not mean read-up.
  await scroll.evaluate(e => {
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -20, ctrlKey: true }))
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -20 }))
    const field = document.createElement('textarea'); e.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }))
    field.remove(); grow()
  })
  await page.waitForTimeout(100)
  assert.ok((await geometry()).gap <= 1, 'Non-scrolling input leaves follow intact')
  // Native scrollbar drags can last longer than the gesture attribution
  // window. Refresh on movement without capturing or preventing native input.
  await scroll.evaluate(e => {
    e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7 }))
    grow()
  })
  await page.waitForTimeout(1600)
  await scroll.evaluate(e => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7 }))
    e.scrollTop = e.scrollHeight
    e.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
    grow()
  })
  await page.waitForTimeout(100)
  assert.ok((await geometry()).gap <= 1, 'Long native scrollbar drag can return to bottom-follow')
  await scroll.hover()
  await page.mouse.wheel(0, -180)
  // First prove the gesture actually started, then wait for its animation to
  // finish. The earlier synthetic case still appends before the first scroll.
  await page.waitForFunction(() => { const e = document.querySelector('[data-conversation-scroll]'); return e.scrollHeight - e.clientHeight - e.scrollTop >= 100 })
  const wheelBefore = await settledGeometry()
  assert.ok(wheelBefore.gap >= 100, 'Real wheel left the floor')
  await page.evaluate(() => grow(true))
  const wheelAfter = await settledGeometry()
  const diagnostic = JSON.stringify({ engine, wheelBefore, wheelAfter })
  assert.ok(Math.abs(wheelAfter.top - wheelBefore.top) < 2, 'Actual wheel + row append leaves the reader in place: ' + diagnostic)
  assert.ok(wheelAfter.maxTop - wheelBefore.top < 2, 'Append never pulls the reader downward, even transiently: ' + diagnostic)
  assert.ok(wheelAfter.gap >= 100, 'Append does not re-pin the reader: ' + diagnostic)
  assert.equal(await jump.isVisible(), true, 'Actual wheel preserves the explicit return-to-bottom control')
  await page.evaluate(() => unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: real ChatView tiny-up/resize, pre-scroll append race, persistent reader intent, keyboard/touch/native wheel/long scrollbar drag, jump/down re-entry, compaction and non-scroll input passed`)
} finally { await browser.close() }
