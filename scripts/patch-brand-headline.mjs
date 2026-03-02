#!/usr/bin/env node
import {patchSilverSurface} from './patch-silver-surface.mjs'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
const dist=resolve(process.argv[2]||'ui/dist')
const id='@deepseek-ai/dsh-client-ui-conversation'
const p=join(dist,'plugins',id,'client.js')
let s=readFileSync(p,'utf8')
for (const [locale, title] of [['zh','新时代的语言'],['en','The Language of a New Era']]) {
 const pattern = new RegExp(`(const ${locale} = \{[\\s\\S]*?"hero\\.headline":\\s*)"[^"\\n]*"`)
 if (!pattern.test(s)) throw Error('Hero locale missing: '+locale)
 s=s.replace(pattern, (_,prefix)=>prefix+JSON.stringify(title))
}
const badge = /,\s*\(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: HeroShell_module_css_default\.previewBadge,\s*children: t\("hero\.preview"\)\s*\}\)/g
s=s.replace(badge,'')
if(s.includes('children: t("hero.preview")'))throw Error('Preview badge render signature changed')
s=patchSilverSurface(s)
writeFileSync(p,s)
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,16)
const gp=join(dist,'client-graph.json'),g=JSON.parse(readFileSync(gp))
const e=g.entries.find(e=>e.id===id)
if(!e)throw Error('Conversation graph entry missing')
e.rev=hash(s);e.url=`/plugins/${id}/client.js?rev=${e.rev}`;g.rev=hash(JSON.stringify(g.entries))
writeFileSync(gp,JSON.stringify(g,null,2)+'\n')
const ip=join(dist,'index.html');let html=readFileSync(ip,'utf8')
if(!/window\.__DSH_BOOT__ = .*?<\/script>/.test(html))throw Error('Boot manifest missing')
html=html.replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(g)}</script>`)
writeFileSync(ip,html)
