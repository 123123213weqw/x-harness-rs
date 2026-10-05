import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const { buildSync } = require('esbuild')
const base = new URL('../ui/src/modules/platform/primitives/markdown/', import.meta.url)
function load(file, globals = {}) {
  const code = buildSync({ entryPoints: [new URL(file, base).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', outfile: '/tmp/stream-motion-test.cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] }).outputFiles.find(file => file.path.endsWith('.cjs')).text
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, Date, setTimeout, clearTimeout, console, ...globals })
  return module.exports
}
const { StreamPresentation, streamPieces, STREAM_BATCH_MS, STREAM_BURST_LIMIT } = load('stream-presentation.ts')
const plain = v => JSON.parse(JSON.stringify(v))
test('stream display: mount/history has no motion; only appended source is highlighted', () => {
  const model = new StreamPresentation('Old text ')
  assert.deepEqual(plain(model.frame.ranges), [])
  const frame = model.commit('Old text new', 100, true)
  assert.deepEqual(plain(frame.ranges), [{ start: 9, end: 12, at: 100 }])
  assert.deepEqual(plain(streamPieces(frame.text, 0, frame, 110)), [{ text: 'Old text ', start: 0 }, { text: 'new', start: 9, at: 100 }])
})
test('stream display: old text never gets a fresh timestamp; recent batches stay bounded', () => {
  const model = new StreamPresentation('')
  for (let i = 1; i <= 100; i++) model.commit('x'.repeat(i), i * 20, true)
  assert.ok(model.frame.ranges.length <= 4)
  const first = model.frame.ranges[0]
  assert.equal(first.at, first.end * 20)
  assert.equal(model.frame.text.length, 100)
  assert.equal(streamPieces(model.frame.text, 0, model.frame, 2200).length, 1)
})
test('stream display: replacement, finish, reduction and large bursts are immediate and plain', () => {
  const model = new StreamPresentation('Prefix')
  model.commit('Prefix more', 1, true)
  assert.equal(model.commit('Prefix more', 2, false).ranges.length, 0)
  assert.equal(model.commit('replacement', 3, true).ranges.length, 0)
  const text = 'replacement' + 'x'.repeat(STREAM_BURST_LIMIT + 1)
  assert.equal(model.commit(text, 4, true).text, text)
  assert.equal(model.frame.ranges.length, 0)
})
test('stream display: exact source-offset mapping; normalized Markdown and joined Unicode never get corrupted', () => {
  for (const value of ['😀', 'e\u0301', '👩‍💻', '🇨🇳', '✌️']) {
    const frame = { text: value, ranges: [{ start: 1, end: value.length, at: 1 }] }
    assert.equal(streamPieces(value, 0, frame, 2).map(p => p.text).join(''), value)
    assert.equal(streamPieces(value, 0, frame, 2).length, 1)
  }
  assert.deepEqual(plain(streamPieces('&', 0, { text: '&amp;', ranges: [{ start: 0, end: 5, at: 1 }] }, 2, 5)), [{ text: '&', start: 0 }])
  const frame = { text: '**中文new**', ranges: [{ start: 4, end: 7, at: 1 }] }
  assert.deepEqual(plain(streamPieces('中文new', 2, frame, 2)), [{ text: '中文', start: 2 }, { text: 'new', start: 4, at: 1 }])
})

function hookHarness({ hidden = false, reduce = false } = {}) {
  const values = [], refs = [], effects = [], listeners = new Map(), mediaListeners = new Map(), timers = new Map()
  let cursor = 0, now = 0, nextTimer = 0, writes = 0
  const document = { hidden, addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) }
  const media = { matches: reduce, addEventListener: (n, f) => mediaListeners.set(n, f), removeEventListener: n => mediaListeners.delete(n) }
  const react = {
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial } },
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = value; writes++ }] },
    useLayoutEffect(fn, deps) {
      const i = cursor++
      const previous = effects[i]
      if (!previous || deps.some((d, k) => !Object.is(d, previous.deps[k]))) {
        previous?.cleanup?.()
        effects[i] = { deps, pending: fn }
      }
    },
  }
  class Clock extends Date { static now() { return now } }
  const api = load('use-stream-presentation.ts', { require: () => react, document, window: { matchMedia: () => media }, Date: Clock,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id }, clearTimeout: id => timers.delete(id) })
  const render = (text, enabled = true) => {
    cursor = 0
    const result = api.useStreamPresentation(text, enabled)
    for (const effect of effects) if (effect?.pending) { const fn = effect.pending; delete effect.pending; effect.cleanup = fn() }
    return result
  }
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } }
  return { render, advance, timers, document, media, listeners, mediaListeners, get writes() { return writes }, unmount: () => { for (const effect of effects) effect?.cleanup?.() } }
}
test('stream hook: tiny fragments coalesce against one deadline without token-starvation', () => {
  const h = hookHarness()
  h.render('')
  h.render('a'); h.advance(20); h.render('ab'); h.advance(20); h.render('abc')
  assert.equal(h.timers.size, 1)
  h.advance(10)
  assert.equal(h.render('abc').text, 'abc')
  assert.equal(h.timers.size, 0)
  h.unmount()
})
test('stream hook: finish and nonappend replacement cannot paint an old prefix', () => {
  const h = hookHarness()
  h.render('Old'); h.render('Old pending')
  assert.equal(h.render('Old pending final', false).text, 'Old pending final')
  assert.equal(h.timers.size, 0)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.render('Different', true).text, 'Different')
  h.unmount()
})
test('stream hook: hidden/reduced pages have no waiting or animation; unmount cancels pending work', () => {
  const h = hookHarness()
  h.render(''); h.render('pending')
  h.document.hidden = true; h.listeners.get('visibilitychange')()
  assert.equal(h.timers.size, 0)
  assert.equal(h.render('pending').text, 'pending')
  assert.equal(h.render('pending').ranges.length, 0)
  h.document.hidden = false; h.media.matches = true; h.mediaListeners.get('change')()
  h.render('pending more'); assert.equal(h.render('pending more').text, 'pending more')
  assert.equal(h.timers.size, 0)
  h.media.matches = false; h.mediaListeners.get('change')(); h.render('pending more text')
  assert.equal(h.timers.size, 1)
  h.unmount(); const writes = h.writes; h.advance(100)
  assert.equal(h.writes, writes); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.mediaListeners.size, 0)
})
test('stream hook: large output catches up in the same render, never a typewriter backlog', () => {
  const h = hookHarness(); h.render('')
  const text = 'x'.repeat(STREAM_BURST_LIMIT + 1)
  assert.equal(h.render(text).text, text); assert.equal(h.timers.size, 0); h.unmount()
  assert.equal(STREAM_BATCH_MS, 50)
})
test('stream integration: live prose opt-in excludes legacy paragraph motion and code/table/math animation', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert.match(read('ui/src/modules/conversation/chat/AssistantMarkdown.tsx'), /smoothStreaming/)
  assert.match(read('ui/src/modules/platform/primitives/markdown/MarkdownText.tsx'), /smoothStreaming = false/)
  assert.match(read('ui/src/modules/motion/index.ts'), /node\.closest\('\[data-xh-stream-owned\]'\)/)
  const css = read('ui/src/modules/platform/primitives/markdown/MarkdownText.module.css')
  assert.match(css, /--xh-duration-stream-text, 150ms/); assert.match(css, /prefers-reduced-motion: reduce/)
  const render = read('ui/src/modules/platform/primitives/markdown/render.tsx')
  assert.match(render, /renderTable\(node, key, \{ \.\.\.context, streamMotion: undefined \}\)/)
  assert.match(render, /case 'inlineCode':[\s\S]*return <code key=\{key\}>\{value\}<\/code>/)
})

test('stream renderer: real Markdown source positions keep bold/list text exact and normalized entities plain', () => {
  const R = require('react'), { renderToStaticMarkup } = require('react-dom/server')
  const { parseGfm } = load('parse.ts')
  const { renderBlocks, createReferenceTargets } = load('render.tsx', { require })
  const cases = ['Old **bold** new', '- old\n- 新内容', 'hello &amp; **world**', 'emoji 👩‍💻 and 中文', '[safe](https://example.com) more', '<script>alert(1)</script> more', 'before\n\n| A | B |\n| - | - |\n| 1 | 2 |', 'before\n\n```\nconst x = 1;\n```']
  for (const text of cases) {
    const nodes = parseGfm(text).children.map(node => ({ node, key: node.position.start.offset + 10 }))
    const source = ' '.repeat(10) + text
    const context = { streaming: true, codeLabels: undefined, fileMentions: undefined, targets: createReferenceTargets(), footnoteOrder: [], footnoteCounts: new Map() }
    const frame = { text: source, ranges: [{ start: 10, end: source.length, at: Date.now() }] }
    const markup = motion => renderToStaticMarkup(R.createElement('div', {}, ...renderBlocks(nodes, { ...context, streamMotion: motion })))
    const animated = markup(frame)
    const normalized = animated.replace(/<span class="[^"]*" data-xh-stream-piece="true" style="[^"]*">([^<]*)<\/span>/g, '$1')
    assert.equal(normalized, markup(undefined), text)
    assert.doesNotMatch(animated, /<script>/)
    if (text.includes('| A |')) assert.doesNotMatch(animated.match(/<table>[\s\S]*<\/table>/)?.[0] ?? '', /data-xh-stream-piece/)
    if (text.includes('```')) assert.doesNotMatch(animated.match(/<pre[\s\S]*<\/pre>/)?.[0] ?? '', /data-xh-stream-piece/)
  }
})
