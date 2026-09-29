import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync('ui/overrides/BrandWordmark.tsx', 'utf8')
const html = readFileSync('ui/dist/index.html', 'utf8')
const entry = html.match(/src="(\/assets\/index-[^"?]+\.js)"/)?.[1]
assert.ok(entry, 'missing bundled UI entry')
const bundle = readFileSync(resolve('ui/dist', `.${entry}`), 'utf8')
assert.match(source, /\bXHarness\s*<\/text>/)
assert.match(bundle, /children:"XHarness"/)
assert.doesNotMatch(bundle, /children:"xLang"/)
assert.match(bundle, /l\?340:232/)
console.log('source and packaged UI both use the XHarness wordmark')
