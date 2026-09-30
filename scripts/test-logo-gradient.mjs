// Historical test name retained for CI; the in-page mark is transparent and
// follows the host theme instead of carrying the app icon's opaque tile.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8')
const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
assert.ok(entry)
const source = readFileSync(new URL(`../ui/dist${entry}`, import.meta.url), 'utf8')
const d = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
const collect = (node, type) => !node || typeof node !== 'object' ? []
  : [...(node.type === type ? [node] : []), ...[node.props?.children].flat().flatMap(child => collect(child, type))]
const component = name => {
  const block = source.match(new RegExp(`function ${name}\\([^]*?(?=function )`))?.[0]
  assert.ok(block, `${name} is present in the packaged UI`)
  return Function('d', `${block};return ${name}`)(d)
}
const compact = component('of')({ size: 32 })
assert.equal(compact.type, 'svg')
assert.equal(compact.props.width, 32)
assert.equal(compact.props.fill, 'currentColor')
assert.equal(collect(compact, 'path').length, 2)
assert.deepEqual(collect(compact, 'path').map(path => path.props.fillOpacity), ['0.42', '0.9'],
  'the crossing ribbons retain separate tones instead of becoming a solid black X')
assert.deepEqual(collect(compact, 'path').map(path => path.props.d), [
  'M57.01 5.59H44.27L6.99 49.86V58.41H19.73L57.01 14.14V5.59Z',
  'M6.99 5.59H19.73L57.01 49.86V58.41H44.27L6.99 14.14V5.59Z',
], 'transparent silhouette is centered from the original app-icon geometry')
const wordmark = component('lf')({ includeMark: true })
assert.equal(collect(wordmark, 'g')[0].props.fill, 'currentColor')
assert.deepEqual(collect(wordmark, 'path').map(path => path.props.d), collect(compact, 'path').map(path => path.props.d))
assert.equal(collect(wordmark, 'text')[0].props.children, 'XHarness')
assert.equal(collect(component('lf')({ includeMark: false }), 'path').length, 0)
assert.equal(collect(wordmark, 'image').length, 0, 'opaque app icon is not used inside the page')
assert.equal(collect(wordmark, 'rect').length, 0, 'mark has no background tile')
for (const file of ['FishLogo.tsx', 'BrandWordmark.tsx']) {
  const original = readFileSync(new URL(`../ui/overrides/${file}`, import.meta.url), 'utf8')
  assert.match(original, /currentColor/)
  assert.doesNotMatch(original, /app-icon-512\.png/)
}
console.log('Web sidebar and hero use the same transparent, theme-aware X')
