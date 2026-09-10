import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const html=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8')
const entry=html.match(/src="(\/assets\/index-[^"]+\.js)"/)[1]
const source=readFileSync(new URL('../ui/dist'+entry,import.meta.url),'utf8')
let seq=0
const R={useId:()=>':logo-'+(++seq)+':'}
const d={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'}
for(const name of ['of','lf']){
 const block=source.match(new RegExp(`function ${name}\\([^]*?(?=function )`))[0]
 const render=Function('R','d',block+`;return ${name}`)(R,d)
 const collect=(node,type)=>!node||typeof node!=='object'?[]:[...(node.type===type?[node]:[]),...[node.props?.children].flat().flatMap(c=>collect(c,type))]
 const a=render({}), b=render({})
 const id=collect(a,'linearGradient')[0].props.id
 assert.equal(collect(a,'rect')[0].props.className,'xh-logo-sweep')
 assert.equal(collect(a,'rect')[0].props.fill,`url(#${id}-shine)`)
 assert.equal(collect(a,'clipPath')[0].props.id,`${id}-clip`)
 assert.notEqual(id,collect(b,'linearGradient')[0].props.id)
 assert.equal(collect(a,'stop').length,8)
 assert.equal(collect(a,'path').filter(p=>p.props.fill).length,2)
 for(const path of collect(a,'path').filter(p=>p.props.fill))assert.equal(path.props.fill,`url(#${id})`)
 if(name==='lf') {assert.equal(collect(render({includeMark:false}),'path').filter(p=>p.props.fill).length,0);assert.equal(collect(a,'text')[0].props.fill,'currentColor')}
}
console.log('PASS: two X variants, unique IDs, metallic gradient and sweep, both path fills, wordmark unchanged')
