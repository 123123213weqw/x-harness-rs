#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const dist = resolve(process.argv[2] || 'ui/dist')
const ip = join(dist, 'index.html')
let html = readFileSync(ip, 'utf8')
const asset = html.match(/src="(\/assets\/index-[^"?]+\.js)(?:\?[^" ]*)?"/)
if (!asset) throw Error('UI entry not found')
let source = readFileSync(join(dist, asset[1]), 'utf8')
// Existing compiled React identifiers are checked, not guessed on upstream change.
for (const name of ['of', 'lf']) {
 const pattern = new RegExp(`function ${name}\\([^]*?(?=function )`)
 const block = source.match(pattern)?.[0]
 if (!block || !block.includes('M58 ')) throw Error('Logo signature changed: '+name)
 if (block.includes('xhLogoGradient')) continue
 let next = block.replace('{return d.jsxs("svg"', '{const xhLogoGradient=R.useId();return d.jsxs("svg"')
 if (next===block) throw Error('Logo JSX anchor changed')
 const defs = 'd.jsx("defs",{children:d.jsxs("linearGradient",{id:xhLogoGradient,x1:"0",y1:"0",x2:"1",y2:"1",children:[d.jsx("stop",{offset:"0%",stopColor:"currentColor"}),d.jsx("stop",{offset:"32%",stopColor:"currentColor",stopOpacity:.48}),d.jsx("stop",{offset:"48%",stopColor:"currentColor",stopOpacity:.9}),d.jsx("stop",{offset:"70%",stopColor:"currentColor",stopOpacity:.58}),d.jsx("stop",{offset:"100%",stopColor:"currentColor"})]})}),'
 next = next.replace('children:[', 'children:['+defs)
 next = next.replace(/(d\.jsx\("path",\{d:"[^"]+",)fill:"currentColor"/g, '$1fill:`url(#${xhLogoGradient})`')
 source = source.replace(block,next)
}
source = source.replace(/\/\/# sourceMappingURL=.*$/gm,'')
const hash = createHash('sha256').update(source).digest('hex').slice(0,12)
const output = `/assets/index-xhmetal-${hash}.js`
writeFileSync(join(dist, output),source)
html = html.replaceAll(asset[1],output)
writeFileSync(ip,html)
console.log('Metallic X:',output)
