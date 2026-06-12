import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const source = read('ui/overrides/motion-tokens.css')
const shipped = read('ui/dist/motion-tokens.css')
const html = read('ui/dist/index.html')
const revision = createHash('sha256').update(source).digest('hex').slice(0, 16)

assert.equal(shipped, source, 'the shell must ship the product token source unchanged')
assert.equal((html.match(/data-xh-motion-tokens/g) ?? []).length, 1, 'inject tokens once')
assert.ok(html.includes(`/motion-tokens.css?rev=${revision}`), 'cache-bust on token changes')
assert.ok(html.indexOf('data-xh-motion-tokens') < html.indexOf('window.__DSH_BOOT__'))
assert.match(read('scripts/assemble-static-ui.mjs'), /ui\/overrides\/motion-tokens\.css/)

for (const name of [
  'fast', 'control', 'overlay-in', 'overlay-out', 'panel-in',
  'panel-out', 'stream-in', 'status-pulse', 'logo-cycle',
]) assert.match(source, new RegExp(`--xh-duration-${name}:`))
for (const name of ['panel', 'stream', 'in', 'out', 'in-out', 'standard']) {
  assert.match(source, new RegExp(`--xh-ease-${name}:`))
}

const terminal = read('ui/plugins/@xlang/xharness-client-ui-terminal/client.js')
const tasks = read('ui/plugins/@xlang/xharness-client-ui-tasks/client.js')
const motion = read('ui/plugins/@xlang/xharness-client-ui-motion/client.js')
const schedule = read('ui/plugins/@xlang/xharness-client-ui-schedule/client.js')
const computer = read('ui/plugins/@xlang/xharness-client-ui-computer/client.js')
const context = read('ui/plugins/@xlang/xharness-client-ui-context/client.js')
const logo = read('ui/overrides/logo-motion.css')
for (const css of [terminal, tasks]) {
  assert.match(css, /var\(--xh-duration-panel-in,260ms\)/)
  assert.match(css, /var\(--xh-duration-panel-out,180ms\)/)
  assert.match(css, /var\(--xh-ease-panel,cubic-bezier\(\.23,1,\.32,1\)\)/)
  assert.match(css, /onAnimationEnd/)
  assert.match(css, /finishClose\(\)/)
  assert.doesNotMatch(css, /setTimeout\([^\n]*190\)/)
}
assert.match(tasks, /var\(--xh-duration-overlay-in,200ms\)/)
assert.match(tasks, /var\(--xh-duration-overlay-out,150ms\)/)
assert.match(motion, /var\(--xh-duration-stream-in,900ms\)/)
assert.match(motion, /var\(--xh-ease-stream,cubic-bezier\(\.16,1,\.3,1\)\)/)
assert.match(schedule, /transition:transform var\(--xh-duration-fast,120ms\)/)
assert.match(computer, /animation:xh-computer-pulse var\(--xh-duration-status-pulse,1\.5s\)/)
assert.match(computer, /transition:opacity var\(--xh-duration-fast,120ms\)/)
assert.match(context, /var\(--xh-duration-control,150ms\)/)
assert.match(logo, /var\(--xh-duration-logo-cycle, 5s\)/)

console.log('motion tokens: source/dist, boot order, consumers and lifecycle verified')
