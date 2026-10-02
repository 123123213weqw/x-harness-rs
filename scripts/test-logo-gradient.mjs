// Historical CI filename: the mark is transparent and follows the host theme.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {shippedBrand,collect} from './fixtures/platform-brand-values.mjs'
const compact=shippedBrand('FishLogo')({size:32}),BrandWordmark=shippedBrand('BrandWordmark')
assert.equal(compact.type,'svg');assert.equal(compact.props.width,32);assert.equal(compact.props.fill,'currentColor')
assert.equal(collect(compact,'path').length,2)
assert.deepEqual(collect(compact,'path').map(path=>path.props.fillOpacity),['0.42','0.9'])
assert.deepEqual(collect(compact,'path').map(path=>path.props.d),[
 'M57.01 5.59H44.27L6.99 49.86V58.41H19.73L57.01 14.14V5.59Z',
 'M6.99 5.59H19.73L57.01 49.86V58.41H44.27L6.99 14.14V5.59Z',
])
const wordmark=BrandWordmark({includeMark:true})
assert.equal(collect(wordmark,'g')[0].props.fill,'currentColor')
assert.deepEqual(collect(wordmark,'path').map(path=>path.props.d),collect(compact,'path').map(path=>path.props.d))
assert.equal(collect(wordmark,'text')[0].props.children,'XHarness')
assert.equal(collect(BrandWordmark({includeMark:false}),'path').length,0)
assert.equal(collect(wordmark,'image').length,0);assert.equal(collect(wordmark,'rect').length,0)
for(const file of ['FishLogo.tsx','BrandWordmark.tsx']){
 const original=readFileSync('ui/src/modules/platform/primitives/'+file,'utf8')
 assert.match(original,/currentColor/);assert.doesNotMatch(original,/app-icon-512\.png/)
}
console.log('source-fresh Web sidebar/hero share the transparent theme-aware X and original silhouette')
