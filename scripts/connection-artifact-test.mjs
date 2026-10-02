/** Acceptance-only AST seam over the actual production connection factory. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
const ui=new URL('../ui/',import.meta.url),id='@xharness/dsh-client-connection'
const require=createRequire(new URL('../ui/package.json',import.meta.url)),ts=require('typescript')
const schemaUnit='contracts/host/apiproxy/api/sessions.schema'
const schemaNames=new Set([...readFileSync(new URL(`src/modules/client-connection/${schemaUnit}.ts`,ui),'utf8').matchAll(/export const (\w+Schema)\b/g)].map(match=>match[1]))
function unitOf(name){
 if(schemaNames.has(name))return[schemaUnit,name]
 if(name==='contextPressureOf'||name==='usageSampleOf'||name==='projectionValuesOf')return['fixture',name]
 throw Error(`Unknown connection acceptance member ${name}`)
}
export function verifyConnectionArtifact(){
 const bytes=readFileSync(new URL(`dist/plugins/${id}/client.js`,ui)),graph=JSON.parse(readFileSync(new URL('dist/client-graph.json',ui))),entry=graph.entries.find(row=>row.id===id),html=readFileSync(new URL('dist/index.html',ui),'utf8')
 new Script(bytes.toString());assert.ok(entry,'shipped graph must contain connection');assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));assert.ok(html.includes(entry.url));assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph)
 const manifest=JSON.parse(readFileSync(new URL('modules.json',ui))),row=manifest.modules.find(entry=>entry.id===id)
 if(row?.kind==='source-module')assert.deepEqual(bytes,compileSourceModules(ui.pathname,[row]).get(id).bytes,'shipped connection must match its strict owned source, not a stale/frozen bundle')
 return bytes.toString()
}
/** Unit-scoped insertion preserves all lexical imports and private production reducers. */
export function exposeConnection(source,names){
 for(const name of names)unitOf(name)
 if(!source.startsWith('// Generated from src/modules/client-connection/')){
  assert.ok(source.includes('return module.exports;'),'legacy connection factory return')
  return source.replace('return module.exports;',`Object.assign(exports,{${names.join(',')}});return module.exports;`)
 }
 const ast=ts.createSourceFile('connection.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),byFile=new Map(),insert=[]
 for(const name of names){const[file,local]=unitOf(name),path=`src/modules/client-connection/${file}.js`;const locals=byFile.get(path)??new Set();locals.add(local);byFile.set(path,locals)}
 function visit(node){
  if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&byFile.has(node.name.text)&&ts.isFunctionExpression(node.initializer)){
   const locals=byFile.get(node.name.text);if(node.name.text.endsWith('/fixture.js'))insert.push({pos:node.initializer.body.end-1,text:`\nObject.assign(exports,{${[...locals].join(',')}});\n`});byFile.delete(node.name.text)
  }
  ts.forEachChild(node,visit)
 }
 visit(ast);assert.equal(byFile.size,0,'requested connection acceptance units must exist in shipped graph')
 const marker='return __load("src/modules/client-connection/index.js");';assert.ok(source.includes(marker),'connection source graph root')
 for(const item of insert.sort((a,b)=>b.pos-a.pos))source=source.slice(0,item.pos)+item.text+source.slice(item.pos)
 return source.replace(marker,`const __acceptance=__load("src/modules/client-connection/index.js");Object.assign(__acceptance,{${names.map(name=>{const[file,local]=unitOf(name);return`${name}:__load(${JSON.stringify('src/modules/client-connection/'+file+'.js')})[${JSON.stringify(local)}]`}).join(',')}});return __acceptance;`)
}
export function legacyConnection(){return readFileSync(new URL(`reference/master-a613970/plugins/${id}/client.js`,ui))}
