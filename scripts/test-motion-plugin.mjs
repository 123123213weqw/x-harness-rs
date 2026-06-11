import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const sourcePath = new URL('../ui/plugins/@xlang/xharness-client-ui-motion/client.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const shipped = await readFile(
  new URL('../ui/dist/plugins/@xlang/xharness-client-ui-motion/client.js', import.meta.url),
  'utf8',
)
assert.equal(shipped, source)
const graph = JSON.parse(await readFile(new URL('../ui/dist/client-graph.json', import.meta.url), 'utf8'))
const motionEntry = graph.entries.find((entry) => entry.id === '@xlang/xharness-client-ui-motion')
assert.ok(motionEntry)
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)
assert.equal(motionEntry.rev, hash(source))
assert.equal(graph.rev, hash(JSON.stringify(graph.entries)))
const index = await readFile(new URL('../ui/dist/index.html', import.meta.url), 'utf8')
assert.ok(index.includes(`window.__DSH_BOOT__ = ${JSON.stringify(graph)}`))

let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const plugin = registration.factory(() => {
  throw new Error('motion plugin requires no modules')
})

assert.equal(registration.id, '@xlang/xharness-client-ui-motion')
assert.equal(JSON.stringify(plugin.inject), '[]')
assert.equal(typeof plugin.apply, 'function')

// Minimal element stubs: the planner only needs tagName/contains/closest and
// parentElement wiring.
function element(tag, parent = null) {
  return {
    tagName: tag.toUpperCase(),
    parent,
    children: [],
    contains(other) {
      if (other === this) return true
      return this.children.some((child) => child.contains(other))
    },
    closest(selector) {
      let node = this
      while (node !== null) {
        if (selector === '[data-transcript-mounted="false"]' && node.evicted) return node
        if (selector === '[data-xh-stream-animate="true"]' && node.animated) return node
        node = node.parent
      }
      return null
    },
  }
}
function adopt(parent, child) {
  child.parent = parent
  parent.children.push(child)
}

const root = element('div')
const row = element('div')
adopt(root, row)

const cases = () => {
  const paragraph = element('p')
  adopt(row, paragraph)
  const heading = element('h2')
  adopt(row, heading)
  const span = element('span')
  adopt(row, span)
  const foreignRow = element('div')
  adopt(root, foreignRow)
  const foreignParagraph = element('p')
  adopt(foreignRow, foreignParagraph)
  const evicted = element('p')
  evicted.evicted = true
  adopt(row, evicted)
  const list = element('ul')
  const item = element('li')
  adopt(list, item)
  adopt(row, list)
  return [paragraph, heading, span, foreignParagraph, evicted, list, item]
}

// Selection: content tags inside the last row only; spans and foreign rows
// never match; nested targets collapse to the ancestor.
let batch = cases()
let plan = plugin.planStreamAnimations(batch, row, 1000, new Map())
const plannedTags = plan.map((target) => target.node.tagName).sort()
assert.equal(JSON.stringify(plannedTags), JSON.stringify(['H2', 'P', 'UL']))
// Stagger: 0, 45, 90 for three targets.
assert.equal(
  JSON.stringify(plan.map((target) => target.delayMs).sort((a, b) => a - b)),
  '[0,45,90]',
)
// The LI wins over its nested UL? No: UL is the ancestor and matches the tag
// set too, so UL animates and LI collapses into it.
assert.ok(plan.some((target) => target.node.tagName === 'UL'))
assert.ok(!plan.some((target) => target.node === batch[6]))

// Churn: re-adding into the same parent within the window is suppressed and
// keeps the window refreshed; after settling, a new block animates again.
const recent = new Map()
const first = element('p')
adopt(row, first)
plan = plugin.planStreamAnimations([first], row, 5000, recent)
assert.equal(plan.length, 1)
const churned = element('p')
adopt(row, churned)
plan = plugin.planStreamAnimations([churned], row, 5100, recent)
assert.equal(plan.length, 0, 'same-parent churn within window is suppressed')
const settled = element('p')
adopt(row, settled)
plan = plugin.planStreamAnimations([settled], row, 5100 + plugin.CHURN_WINDOW_MS + 1, recent)
assert.equal(plan.length, 1, 'a settled parent animates again')

// No last row: nothing is animated.
assert.equal(plugin.planStreamAnimations(cases(), null, 6000, new Map()).length, 0)

// Stagger caps at five steps regardless of batch size.
const big = []
for (let i = 0; i < 9; i += 1) {
  const node = element('p')
  const holder = element('div')
  adopt(holder, node)
  adopt(row, holder)
  big.push(node)
}
const capped = plugin.planStreamAnimations(big, row, 10_000, new Map())
assert.equal(capped.length, 9)
assert.equal(Math.max(...capped.map((target) => target.delayMs)), 5 * 45)

// The stylesheet ships the reduced-motion opt-out.
assert.match(source, /prefers-reduced-motion:reduce/)
assert.match(source, /@keyframes xh-stream-in/)

console.log('motion plugin: assertions passed')
