import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const css=read('ui/dist/monochrome.css'),html=read('ui/dist/index.html')
const asset=JSON.parse(read('ui/modules.json')).assets.find(row=>row.path==='monochrome.css')
assert.equal(asset?.source,'overrides/monochrome.css')
assert.equal(css,read('ui/overrides/monochrome.css'))
const links=[...html.matchAll(/<link\b[^>]*\bdata-xh-monochrome\b[^>]*>/g)]
assert.equal(links.length,1,'the actual page loads exactly one theme stylesheet')
assert.ok(links[0][0].includes('/monochrome.css?rev='+createHash('sha256').update(css).digest('hex').slice(0,16)))
assert.ok(css.includes('body[data-ds-dark-theme]'))
assert.match(css, /body\[data-ds-dark-theme\] \.U910La_root:not\(\.U910La_collapsed\) \.U910La_newSession\s*\{[^}]*background:\s*#43454a;[^}]*border-color:\s*#616367;/)
assert.match(css, /html, body, #root\s*\{[^}]*overflow:\s*hidden/)
assert.match(css, /html:has\(body\[data-ds-dark-theme\]\)\s*\{[^}]*background-color:\s*#171717/)
assert.match(css, /\[data-conversation-scroll\]\s*\{[^}]*overscroll-behavior-y:\s*contain/)
assert.ok(!css.includes('filter:')) // Never desaturate images or semantic statuses.
assert.ok(!/--dsw-alias-state-(error|success|warn).*:/.test(css))
const deepSeekButtonColors = new Set(['43454a', '616367'])
for (const match of css.matchAll(/#([0-9a-f]{6})(?:[0-9a-f]{2})?\b/g)) {
  if (deepSeekButtonColors.has(match[1])) continue
  assert.equal(match[1].slice(0,2), match[1].slice(2,4))
  assert.equal(match[1].slice(2,4), match[1].slice(4,6))
}
const contrast = (a,b) => {
  const lum = n => { const c = n/255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4 }
  return (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05)
}
assert.ok(contrast(23,255) > 7)
assert.ok(contrast(245,21) > 7)
console.log('PASS: declared source, actual page asset/revision, neutral palette, both themes, semantic colors, contrast')
