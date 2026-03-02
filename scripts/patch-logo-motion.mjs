#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const dist=resolve(process.argv[2] || 'ui/dist')
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12)
const ip=join(dist,'index.html');let html=readFileSync(ip,'utf8')
const asset=html.match(/src="(\/assets\/index-[^"?]+\.js)(?:\?[^" ]*)?"/)
if(!asset)throw Error('UI entry missing')
let source=readFileSync(join(dist,asset[1]),'utf8')
// Existing packaged shell only. Full rebuild uses the TSX source instead.
if (!process.argv.includes('--assets-only')) for(const name of ['of','lf']) {
 const block=source.match(new RegExp(`function ${name}\\([^]*?(?=function )`))?.[0]
 if(!block?.includes('xhLogoGradient'))throw Error('Apply logo gradient first')
 if(block.includes('xh-logo-sweep'))continue
 const paths=[...block.matchAll(/d\.jsx\("path",\{d:"([^"]+)"/g)].map(m=>m[1])
 if(paths.length!==2)throw Error('X geometry changed')
 const jsx=(type,props)=>`d.jsx(${JSON.stringify(type)},{${props}})`
 const clip=`d.jsxs("clipPath",{id:xhLogoGradient+"-clip",children:[${paths.map(p=>jsx('path',`d:${JSON.stringify(p)}`)).join(',')}]})`
 const shine=`d.jsxs("linearGradient",{id:xhLogoGradient+"-shine",children:[${[0,50,100].map(n=>jsx('stop',`offset:"${n}%",stopColor:"white",stopOpacity:${n===50?.8:0}`)).join(',')}]})`
 const defs=`d.jsxs("defs",{children:[${clip},${shine}]})`
 const overlay=`d.jsx("g",{clipPath:"url(#"+xhLogoGradient+"-clip)",pointerEvents:"none",children:d.jsx("rect",{className:"xh-logo-sweep",x:-24,y:0,width:24,height:64,fill:"url(#"+xhLogoGradient+"-shine)"})})`
 const tail=']})}'
 if(!block.endsWith(tail))throw Error('SVG tail changed')
 const next=block.slice(0,-tail.length)+`,${defs},${name==='lf'?'l&&':''}${overlay}`+tail
 source=source.replace(block,next)
}
source=source.trimEnd()+'\n'
const out=`/assets/index-xhmotion-${hash(source)}.js`
writeFileSync(join(dist,out),source);html=html.replaceAll(asset[1],out)
for(const ext of ['css','js']) {
 const data=readFileSync(new URL(`../ui/overrides/logo-motion.${ext}`,import.meta.url))
 writeFileSync(join(dist,`logo-motion.${ext}`),data)
 html=html.replace(new RegExp(`\\s*<(?:link|script)\\b[^>]*data-xh-logo-motion-${ext}[^>]*>(?:<\\/script>)?\\s*`,'g'),'')
 const url=`/logo-motion.${ext}?rev=${hash(data)}`
 const tag=ext==='css'?`<link rel="stylesheet" data-xh-logo-motion-css href="${url}">`:`<script defer data-xh-logo-motion-js src="${url}"></script>`
 html=html.replace('</head>',tag+'\n</head>')
}
writeFileSync(ip,html)
console.log(out)
