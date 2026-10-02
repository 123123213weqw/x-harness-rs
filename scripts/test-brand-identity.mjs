import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {shippedBrand,collect} from './fixtures/platform-brand-values.mjs'
const source=readFileSync('ui/src/modules/platform/primitives/BrandWordmark.tsx','utf8')
assert.match(source,/\bXHarness\s*<\/text>/)
const BrandWordmark=shippedBrand('BrandWordmark')
for(const includeMark of [true,false]){
 const node=BrandWordmark({size:24,includeMark})
 assert.equal(collect(node,'text')[0].props.children,'XHarness')
 assert.equal(node.props.width,24*(includeMark?340:232)/64)
 assert.equal(node.props.viewBox,includeMark?'0 0 340 64':'108 0 232 64')
}
console.log('source-fresh packaged platform retains XHarness wordmark, both original viewports and widths')
