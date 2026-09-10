import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {patchSilverSurface} from './patch-silver-surface.mjs'
const source=readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js',import.meta.url),'utf8')
assert.equal(patchSilverSurface(source),source)
const block=source.slice(source.indexOf('function HeroGlow('),source.indexOf('\n\t\t/**',source.indexOf('function HeroGlow(')))
assert.ok(block.includes('"data-xh-silver-glow"'))
assert.ok(!/6187D8|feGaussianBlur|useId|filter:/.test(block))
assert.ok(source.includes('"data-xh-silver-input": workspaceTrigger ? void 0 : ""'))
const css=readFileSync(new URL('../ui/overrides/monochrome.css',import.meta.url),'utf8')
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-glow]'))
assert.ok(css.includes('body[data-ds-dark-theme] [data-xh-silver-input]:focus-within'))
assert.ok(css.includes('@media (forced-colors: active)'))
assert.ok(!css.includes('animation:'))
assert.throws(()=>patchSilverSurface(''),/signature missing/)
console.log('PASS: neutral static glow, no SVG blur, workspace affordance retained, focus/dark/high-contrast, idempotence')
