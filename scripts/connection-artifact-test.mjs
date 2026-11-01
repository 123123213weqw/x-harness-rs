import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {fixtureUiRoot} from './fixtures/ui-fixture-build.mjs'
import {assertVariant, moduleRowsForVariant, FIXTURE_CONNECTION, PRODUCTION_CONNECTION} from './ui-build-variant.mjs'
import {OUTPUT_MARKER} from './ui-build-contract.mjs'
/** Acceptance-only AST seams over separately verified production and fixture factories. */
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
function verifyConnectionDirectory(directory,variant){
 const bytes=readFileSync(join(directory,`plugins/${id}/client.js`)),graph=JSON.parse(readFileSync(join(directory,'client-graph.json'))),entry=graph.entries.find(row=>row.id===id),html=readFileSync(join(directory,'index.html'),'utf8')
 const marker=JSON.parse(readFileSync(join(directory,OUTPUT_MARKER),'utf8'));assert.equal(marker.variant,variant,'connection artifact belongs to the requested build variant')
 new Script(bytes.toString());assert.ok(entry,'built graph must contain connection');assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));assert.ok(html.includes(entry.url));assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph)
 const manifest=JSON.parse(readFileSync(new URL('modules.json',ui))),row=moduleRowsForVariant(manifest.modules,variant).find(entry=>entry.id===id)
 assert.equal(row?.kind,'source-module')
 assert.deepEqual(bytes,compileSourceModules(fileURLToPath(ui),[row],{variant}).get(id).bytes,'connection must match its strict owned source and selected build variant, not a stale/frozen bundle')
 return bytes.toString()
}
export function verifyConnectionArtifact(){return verifyConnectionDirectory(fileURLToPath(new URL('dist/',ui)),'production')}
export function verifyFixtureConnectionArtifact(){return verifyConnectionDirectory(fixtureUiRoot(),'fixture')}
/** Unit-scoped insertion preserves lexical imports and requires explicit fixture admission. */
export function exposeConnection(source,names,{variant='production'}={}){
 assertVariant(variant)
 for(const name of names){const [unit]=unitOf(name);assert.ok(variant==='fixture'||unit!=='fixture','fixture acceptance members require an explicit fixture build')}
 const entrySource=variant==='fixture'?FIXTURE_CONNECTION:PRODUCTION_CONNECTION
 if(source.startsWith('// Generated'))assert.ok(source.startsWith(`// Generated from ${entrySource};`),'connection factory entry must match its requested variant')
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
 const root=entrySource.replace(/\.ts$/,'.js'),marker=`return __load(${JSON.stringify(root)});`;assert.ok(source.includes(marker),'connection source graph root')
 for(const item of insert.sort((a,b)=>b.pos-a.pos))source=source.slice(0,item.pos)+item.text+source.slice(item.pos)
 return source.replace(marker,`const __acceptance=__load(${JSON.stringify(root)});Object.assign(__acceptance,{${names.map(name=>{const[file,local]=unitOf(name);return`${name}:__load(${JSON.stringify('src/modules/client-connection/'+file+'.js')})[${JSON.stringify(local)}]`}).join(',')}});return __acceptance;`)
}
export function legacyConnection(){return readFileSync(new URL(`reference/master-a613970/plugins/${id}/client.js`,ui))}
