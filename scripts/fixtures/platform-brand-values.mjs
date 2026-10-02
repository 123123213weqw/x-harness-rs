/** Pure component seam over the actual shipped platform, not legacy minifier names. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {compilePlatformUi} from '../build-platform-ui.mjs'
import {sourceDeclaration} from './source-declaration.mjs'
const ui=new URL('../../ui/',import.meta.url),require=createRequire(new URL('package.json',ui))
const built=compilePlatformUi(ui.pathname)
const html=readFileSync(new URL('dist/index.html',ui),'utf8')
assert.ok(html.includes('/'+built.entryPath),'HTML uses the actual source platform entry')
const bytes=readFileSync(new URL('dist/'+built.entryPath,ui))
assert.deepEqual(bytes,built.outputs.get(built.entryPath),'shipped platform must be source-fresh')
const source=bytes.toString(),jsx=require('react/jsx-runtime')
export function shippedBrand(name){
 const block=sourceDeclaration(source,name)
 // esbuild gives each static JSX namespace an arbitrary suffix. This is the
 // entire named pure component, with its genuine JSX library binding supplied.
 const names=[...new Set([...block.matchAll(/\b(import_jsx_runtime\d*)\./g)].map(x=>x[1]))]
 assert.ok(names.length>0,'pure brand component retains its JSX dependency')
 return Function(...names,block+';return '+name)(...names.map(()=>jsx))
}
export const shippedPlatform=source
export const collect=(node,type)=>!node||typeof node!=='object'?[]:[...(node.type===type?[node]:[]),...[node.props?.children].flat().flatMap(child=>collect(child,type))]
