import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const tokens=read('ui/src/modules/theme/typography.css')
const markdown=read('ui/src/modules/platform/primitives/markdown/MarkdownText.module.css')
test('typography follows the base tokens and owning stylesheet lifetime',()=>{
 const owner=read('ui/src/modules/theme/styles.ts')
 assert.ok(owner.indexOf("['typography.css', typography]")>owner.indexOf("['gradient-shadow-text.css', gradientShadowText]"))
 assert.ok(owner.includes('ctx.effect('));assert.ok(owner.includes('tag.remove()'))
 assert.doesNotMatch(tokens,/@font-face|@import|https?:|!important/)
 assert.match(tokens,/var\(--dsw-font-family\)/);assert.match(tokens,/var\(--ds-font-family-code\)/)
})
test('font shorthands agree with individual inspection tokens',()=>{
 for(const name of ['h2','h3','h4','base-strong','base-strong-italic','table-head','code-block']){
  const value=tokens.match(new RegExp(`--dsw-font-markdown-${name}: ([^;]+);`))[1]
  const geometry=value.match(/(\d+)px\/(\d+)px/)
  for(const [field,expected] of [['font-size',geometry[1]+'px'],['line-height',geometry[2]+'px']]){
   const detail=tokens.match(new RegExp(`--dsw-font-markdown-${name}-${field}: ([^;]+);`))
   if(detail)assert.equal(detail[1],expected)
  }
  const weight=tokens.match(new RegExp(`--dsw-font-markdown-${name}-font-weight: ([^;]+);`))
  if(weight)assert.ok(value.includes(weight[1]+' '))
 }
})
test('only authored emphasis strengthens; heading emphasis inherits its level',()=>{
 assert.match(markdown,/\.markdown strong\s*\{\s*font-weight: var\(--dsw-font-markdown-base-strong-font-weight, 700\);/)
 assert.match(markdown,/:where\(h1, h2, h3, h4, h5, h6\) strong\s*\{\s*font-weight: inherit;/)
 assert.match(markdown,/:where\(h5, h6\)[^}]*font-weight: 600;/)
 assert.doesNotMatch(tokens,/--dsw-font-markdown-base:/)
 assert.match(markdown,/\.markdown > \*:first-child/)
 assert.match(markdown,/\.markdown > \*:last-child/)
})
test('preview uses actual rendering and frozen before CSS, no provider traffic',()=>{
 const demo=read('ui/demo/typography.tsx'),script=read('scripts/preview-typography.mjs')
 assert.match(demo,/platform\/primitives\/markdown\/MarkdownText/)
 assert.match(demo,/conversation\/chat\/ReasoningRow/)
 assert.doesNotMatch(demo,/fetch\(|WebSocket|XMLHttpRequest/)
 assert.match(script,/a3d5c6d93be089eb055888e0f5fc3ee1c217023b/)
 assert.match(script,/'127\.0\.0\.1'/)
})
