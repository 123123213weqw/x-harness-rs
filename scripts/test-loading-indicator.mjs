import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const root = fileURLToPath(new URL('../', import.meta.url))
const result = await require('esbuild').build({
  entryPoints: [root + 'ui/src/modules/conversation/chat/LoadingIndicator.tsx'], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' },
})
const module = { exports: {} }
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
const { LoadingIndicator } = module.exports
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
const render = props => renderToStaticMarkup(React.createElement(LoadingIndicator, props))

test('elapsed duration uses compact h m s without a running prefix', () => {
  const source = readFileSync(root + 'ui/src/modules/conversation/chat/ElapsedTime.tsx', 'utf8')
  const code = require('esbuild').transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs' }).code
  const helper = { exports: {} }
  new Function('module', 'exports', 'require', code)(helper, helper.exports, require)
  const { formatElapsedTime } = helper.exports
  for (const [ms, expected] of [
    [NaN, '0s'], [Infinity, '0s'], [-1, '0s'], [0, '0s'], [999, '0s'], [12_900, '12s'],
    [59_999, '59s'], [60_000, '1m 00s'], [62_000, '1m 02s'],
    [3_599_999, '59m 59s'], [3_600_000, '1h 00m 00s'],
    [3_723_000, '1h 02m 03s'], [360_000_000, '100h 00m 00s'],
  ]) assert.equal(formatElapsedTime(ms), expected)
})

test('inactive indicator renders nothing', () => {
  assert.equal(render({ active: false, label: 'Working' }), '')
})
test('active indicator has a localized accessible label without visible activity copy', () => {
  const html = render({ active: true, label: '正在等待模型回复' })
  assert.match(html, /role="status"/)
  assert.match(html, /aria-label="正在等待模型回复"/)
  assert.equal(html.replace(/<[^>]*>/g, ''), '')
  assert.match(html, /aria-hidden="true"/)
})
test('twelve 2px squares form a crisp 16px ring with no rotating geometry', () => {
  const html = render({ active: true, label: 'Working' })
  assert.match(html, /width="16" height="16" viewBox="0 0 16 16"/)
  assert.match(html, /shape-rendering="crispEdges"/)
  assert.equal((html.match(/<rect /g) ?? []).length, 12)
  assert.equal((html.match(/width="2" height="2"/g) ?? []).length, 12)
  assert.doesNotMatch(html, /<path|<circle|rotor/)
  const points = [...html.matchAll(/x="(\d+)" y="(\d+)"/g)].map(([,x,y]) => [Number(x), Number(y)])
  assert.deepEqual(points, [[5,0],[9,0],[12,2],[14,5],[14,9],[12,12],[9,14],[5,14],[2,12],[0,9],[0,5],[2,2]])
  assert.equal((html.match(/animation-delay:-\d+ms/g) ?? []).length, 12, 'negative stagger starts the chase immediately')
})
test('opacity chase, entrance and reduced motion remain separate and timer-free', () => {
  const css = readFileSync(root + 'ui/src/modules/conversation/chat/LoadingIndicator.css', 'utf8')
  const source = readFileSync(root + 'ui/src/modules/conversation/chat/LoadingIndicator.tsx', 'utf8')
  assert.match(css, /xhLoading_chase 1.2s linear infinite/)
  assert.match(css, /var\(--xh-duration-stream-in, 900ms\)/)
  assert.match(css, /cubic-bezier\(\.16, 1, \.3, 1\)/)
  assert.match(css, /var\(--dsw-alias-label-primary\)/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.xhLoading_root, \.xhLoading_pixel \{ animation: none;/)
  assert.match(css, /data-xh-page-hidden[^}]*animation-play-state: paused/)
  assert.doesNotMatch(css, /transform|rotate|scale/)
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|useEffect|useState/)
})
