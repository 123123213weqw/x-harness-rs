import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchMonochromeTheme } from './patch-monochrome-theme.mjs'
const dir = mkdtempSync(join(tmpdir(), 'xh-theme-'))
try {
  writeFileSync(join(dir, 'index.html'), '<html><head><script src="/keep.js"></script></head><body></body></html>')
  patchMonochromeTheme(dir)
  const first = readFileSync(join(dir, 'index.html'), 'utf8')
  patchMonochromeTheme(dir)
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), first)
  assert.equal((first.match(/data-xh-monochrome/g) || []).length, 1)
  assert.ok(first.includes('<script src="/keep.js"></script>'))
  const css = readFileSync(join(dir, 'monochrome.css'), 'utf8')
  assert.equal(css, readFileSync(new URL('../ui/dist/monochrome.css', import.meta.url), 'utf8'))
  assert.ok(css.includes('body[data-ds-dark-theme]'))
  assert.ok(!css.includes('filter:')) // Never desaturate images or semantic statuses.
  assert.ok(!/--dsw-alias-state-(error|success|warn).*:/.test(css))
  for (const match of css.matchAll(/#([0-9a-f]{6})(?:[0-9a-f]{2})?\b/g)) {
    assert.equal(match[1].slice(0,2), match[1].slice(2,4))
    assert.equal(match[1].slice(2,4), match[1].slice(4,6))
  }
  const contrast = (a,b) => {
    const lum = n => { const c = n/255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4 }
    return (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05)
  }
  assert.ok(contrast(23,255) > 7)
  assert.ok(contrast(245,21) > 7)
  console.log('PASS: idempotent injection, bundle parity, neutral palette, both themes, semantic colors, contrast')
} finally { rmSync(dir, {recursive:true, force:true}) }
