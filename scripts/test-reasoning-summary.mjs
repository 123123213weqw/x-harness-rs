import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const { buildSync } = require('esbuild')
const base = new URL('../ui/src/modules/conversation/chat/', import.meta.url)
function load(file, globals = {}) {
  const code = buildSync({ entryPoints: [new URL(file, base).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] }).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Date, setTimeout, clearTimeout, ...globals })
  return module.exports
}
const { ReasoningSummaryPresentation: Pager, REASONING_PAGE_MS, REASONING_FLIP_MS, firstReasoningLine, latestReasoningLine } = load('reasoning-summary.ts')
const plain = value => JSON.parse(JSON.stringify(value))

test('reasoning preview: history does not count as throughput; first/latest line semantics remain', () => {
  const text = 'Old reasoning'.repeat(10000)
  const pager = new Pager(text, 0)
  assert.equal(pager.advance(200, true).paging, false)
  assert.equal(pager.nextAt, undefined)
  assert.equal(firstReasoningLine('first\nlast\n'), 'first')
  assert.equal(latestReasoningLine('first\nlast\n'), 'last')
})
test('reasoning preview: low speed stays live, high speed waits for a measured sample', () => {
  const slow = new Pager('', 0)
  for (let time = 100; time <= 2000; time += 100) {
    const input = 's'.repeat(time / 100 * 4)
    assert.equal(slow.update(input, time, true).current, input)
    assert.equal(slow.frame.paging, false)
  }
  const fast = new Pager('', 0)
  assert.equal(fast.update('a'.repeat(100), 10, true).paging, false)
  assert.equal(fast.update('b'.repeat(100), 200, true).paging, false, 'nonappend content starts a new sample')
  assert.equal(fast.update('b'.repeat(200), 400, true).paging, true)
})
test('reasoning preview: one 800ms deadline, newest page only, and outgoing line expires at 180ms', () => {
  const pager = new Pager('', 0)
  pager.update('a'.repeat(80), 200, true)
  const first = pager.frame.current
  for (let time = 220; time < 1000; time += 20) {
    pager.update(pager.input + 'b'.repeat(8), time, true)
    assert.equal(pager.frame.current, first)
    assert.equal(pager.nextAt, 1000, 'chunks cannot starve the page timer')
  }
  const frame = pager.update(pager.input + '\nnewest page', 1000, true)
  assert.equal(frame.current, 'newest page')
  assert.equal(frame.previous, first)
  assert.equal(pager.nextAt, 1180)
  pager.advance(1179, true); assert.equal(pager.frame.previous, first)
  pager.advance(1180, true); assert.equal(pager.frame.previous, undefined)
  assert.equal(pager.nextAt, 1800)
  assert.equal(REASONING_PAGE_MS, 800); assert.equal(REASONING_FLIP_MS, 180)
})
test('reasoning preview: slowdown hysteresis prevents threshold flicker and cancels page scheduling', () => {
  const pager = new Pager('', 0)
  pager.update('a'.repeat(40), 200, true)
  assert.equal(pager.frame.paging, true)
  pager.advance(400, true); assert.equal(pager.frame.paging, true, '100 chars/s stays paged once entered')
  pager.advance(600, true); assert.equal(pager.frame.paging, false)
  assert.equal(pager.nextAt, undefined)
})
test('reasoning preview: replacement, disabled motion and a delayed callback do not replay old pages', () => {
  const pager = new Pager('', 0)
  pager.update('a'.repeat(100), 200, true)
  pager.update(pager.input + '\nnewest page', 300, true)
  pager.advance(1000, false)
  assert.equal(pager.frame.current, 'newest page'); assert.equal(pager.frame.previous, undefined)
  pager.update('replacement', 1001, true)
  assert.equal(pager.frame.paging, false); assert.equal(pager.frame.current, 'replacement')
  pager.update('replacement' + 'x'.repeat(10000), 1201, true)
  assert.ok(pager.frame.current.length <= 321, 'the compact page is bounded, not the original input')
  assert.equal(pager.input.length, 10011)
  pager.advance(10000, true)
  assert.equal(pager.frame.current, pager.input); assert.equal(pager.frame.previous, undefined); assert.equal(pager.nextAt, undefined)
})
test('reasoning preview: rate buckets and visual lines stay bounded over long runs', () => {
  const pager = new Pager('', 0)
  for (let time = 1; time <= 5000; time++) {
    pager.update(pager.input + '😀', time, true)
    assert.ok(pager.buckets.length <= 11)
    if (pager.frame.paging) assert.ok(pager.frame.current.length <= 321)
    assert.doesNotMatch(pager.frame.current, /^…?[\uDC00-\uDFFF]/)
  }
  pager.reset('restored\nlast', 6000)
  assert.deepEqual(plain(pager.frame), { current: 'last', paging: false, revision: pager.frame.revision, at: 6000 })
})

function harness({ hidden = false, reduce = false } = {}) {
  const values = [], refs = [], effects = [], timers = new Map(), listeners = new Map(), mediaListeners = new Map()
  let cursor = 0, now = 0, nextId = 0, writes = 0
  const document = { hidden, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const media = { matches: reduce, addEventListener: (name, fn) => mediaListeners.set(name, fn), removeEventListener: name => mediaListeners.delete(name) }
  const react = {
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial } },
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; writes++ }] },
    useLayoutEffect(fn, deps) {
      const i = cursor++, previous = effects[i]
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        previous?.cleanup?.(); effects[i] = { deps, pending: fn }
      }
    },
  }
  class Clock extends Date { static now() { return now } }
  const api = load('use-reasoning-summary.ts', { require: () => react, Date: Clock, document, window: { matchMedia: () => media },
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id }, clearTimeout: id => timers.delete(id) })
  const render = (text, enabled = true) => {
    cursor = 0
    const frame = api.useReasoningSummary(text, enabled)
    for (const effect of effects) if (effect?.pending) { const fn = effect.pending; delete effect.pending; effect.cleanup = fn() }
    return frame
  }
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } }
  return { render, advance, timers, document, media, listeners, mediaListeners, get writes() { return writes }, unmount: () => { for (const effect of effects) effect?.cleanup?.() } }
}
test('reasoning hook: incoming chunks share one timer and newest text is shown at its deadline', () => {
  const h = harness(); h.render(''); h.advance(200)
  const first = 'a'.repeat(80); h.render(first); h.render(first)
  assert.equal(h.timers.size, 1)
  h.advance(300); h.render(first + '\nintermediate')
  h.advance(300); h.render(first + '\nintermediate\nlatest page')
  assert.equal(h.timers.size, 1); assert.equal(h.render(first + '\nintermediate\nlatest page').current, first)
  h.advance(200)
  const frame = h.render(first + '\nintermediate\nlatest page')
  assert.equal(frame.current, 'latest page'); assert.equal(frame.previous, first)
  assert.equal(h.timers.size, 1); h.unmount()
})
test('reasoning hook: finish, expansion and replacement return current text before effects', () => {
  for (const replacement of [false, true]) {
    const h = harness(); h.render(''); h.advance(200); h.render('a'.repeat(80)); h.render('a'.repeat(80))
    const text = replacement ? 'different\nnew' : 'a'.repeat(80) + '\nfinal'
    const frame = h.render(text, replacement)
    assert.equal(frame.current, replacement ? 'new' : 'final')
    assert.equal(frame.paging, false); assert.equal(h.timers.size, 0)
    h.unmount()
  }
})
test('reasoning hook: hidden page cancels its timer, resume does not replay; unmount cleans listeners', () => {
  const h = harness(); h.render(''); h.advance(200); h.render('a'.repeat(80)); assert.equal(h.timers.size, 1)
  h.document.hidden = true; h.listeners.get('visibilitychange')()
  assert.equal(h.timers.size, 0)
  const text = 'a'.repeat(80) + '\nwhile hidden'; assert.equal(h.render(text).current, 'while hidden')
  h.document.hidden = false; h.listeners.get('visibilitychange')()
  assert.equal(h.render(text).paging, false); assert.equal(h.timers.size, 0)
  h.unmount(); const writes = h.writes; h.advance(5000)
  assert.equal(h.writes, writes); assert.equal(h.listeners.size, 0); assert.equal(h.mediaListeners.size, 0)
})
test('reasoning hook: reduced motion keeps pacing but never produces an animated outgoing line', () => {
  const h = harness({ reduce: true }); h.render(''); h.advance(200)
  let text = 'a'.repeat(80); h.render(text)
  h.advance(300); text += '\nnewest line'; h.render(text)
  h.advance(500); const frame = h.render(text)
  assert.equal(frame.paging, true); assert.equal(frame.current, 'newest line'); assert.equal(frame.previous, undefined)
  h.media.matches = false; h.mediaListeners.get('change')()
  h.unmount(); assert.equal(h.timers.size, 0)
})
test('reasoning integration: full body unchanged; fixed-height, two-line motion and original sweep retained', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const row = read('ui/src/modules/conversation/chat/ReasoningRow.tsx')
  assert.match(row, /useReasoningSummary\(text, running && !expanded\)/)
  assert.match(row, /<div className=\{css.thinkBody\}>\{text\}<\/div>/)
  assert.match(row, /firstReasoningLine\(text\)/)
  assert.match(row, /css.pageOut\} aria-hidden/)
  const css = read('ui/src/modules/conversation/chat/ReasoningRow.css')
  assert.match(css, /reasoning-row-sweep/)
  assert.match(css, /--xh-duration-reasoning-flip,180ms/)
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.doesNotMatch(css, /will-change|rotate[XY]|perspective/)
  assert.match(read('ui/overrides/motion-tokens.css'), /--xh-duration-reasoning-flip: 180ms/)
  assert.match(read('ui/demo/stream-motion.tsx'), /<ReasoningRow/)
})

test('reasoning preview: a new line containing one word does not replace a readable complete line', () => {
  const pager = new Pager('', 0)
  pager.update('First complete line\n'.repeat(10), 200, true)
  pager.update(pager.input + 'x', 600, true)
  pager.advance(1000, true)
  assert.equal(pager.frame.current, 'First complete line')
  pager.update(pager.input + ' now becomes readable', 1050, true)
  pager.advance(1800, true)
  assert.equal(pager.frame.current, 'x now becomes readable')
})
