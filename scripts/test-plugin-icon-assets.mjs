import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const ui=new URL('../ui/',import.meta.url)
const manifest=JSON.parse(readFileSync(new URL('modules.json',ui),'utf8'))
const names=['browser','debug','documents','git-branch','github','review','refactor','test','api','database','docker']
for(const name of names){
  const path=`plugin-icons/${name}.svg`
  const row=manifest.assets.find(asset=>asset.path===path)
  assert.ok(row,`${name}: shipped from repository manifest`)
  assert.equal(row.source,`src/assets/${path}`)
  const bytes=readFileSync(new URL(row.source,ui)),svg=bytes.toString('utf8')
  assert.match(svg, /viewBox="0 0 64 64"/)
  assert.match(svg, /rx="14" fill="#[0-9a-f]{6}"/)
  assert.doesNotMatch(svg, /linearGradient|radialGradient|filter|opacity|url\(/, "minimal artwork has no effects")
  assert.deepEqual([...new Set(svg.match(/#[0-9a-f]{6}/g))].sort(),["#000000","#ffffff"],"pure black and white only")
  assert.doesNotMatch(svg, /<(?:script|foreignObject|image|animate|style)\b|\bon\w+\s*=|\bhref\s*=|<!DOCTYPE/i,'passive self-contained vector artwork')
  assert.ok(bytes.length<6000)
  assert.deepEqual(readFileSync(new URL(`dist/${path}`,ui)),bytes,`${name}: actual shipped bytes match source`)
  const inventory=JSON.parse(readFileSync(new URL('dist/asset-manifest.json',ui),'utf8'))
  assert.equal(inventory.files[path].sha256,createHash('sha256').update(bytes).digest('hex'))
}
assert.match(readFileSync(new URL('src/assets/plugin-icons/GITHUB-MARK-LICENSE.txt',ui),'utf8'),/MIT License/)
console.log('plugin artwork: 11 source/shipped SVGs, sizes, passive content, hashes and retained GitHub license passed')
