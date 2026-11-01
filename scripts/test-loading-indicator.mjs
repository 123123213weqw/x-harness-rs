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
test('the 16px static glyph is nested in the rotating HTML element', () => {
  const html = render({ active: true, label: 'Working' })
  assert.match(html, /<div class="xhLoading_rotor"[^>]*><svg/)
  assert.match(html, /width="16" height="16"/)
  assert.equal((html.match(/<path /g) ?? []).length, 8)
})
test('rotation, entrance and reduced motion remain separate and timer-free', () => {
  const css = readFileSync(root + 'ui/src/modules/conversation/chat/LoadingIndicator.css', 'utf8')
  const source = readFileSync(root + 'ui/src/modules/conversation/chat/LoadingIndicator.tsx', 'utf8')
  assert.match(css, /xhLoading_spin 1s linear infinite/)
  assert.match(css, /var\(--xh-duration-stream-in, 900ms\)/)
  assert.match(css, /cubic-bezier\(\.16, 1, \.3, 1\)/)
  assert.match(css, /var\(--dsw-alias-label-tertiary\)/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.xhLoading_root, \.xhLoading_rotor \{ animation: none;/)
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|useEffect|useState/)
})
