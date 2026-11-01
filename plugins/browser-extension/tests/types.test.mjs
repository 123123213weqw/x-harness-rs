import test from 'node:test'
import assert from 'node:assert/strict'
import{readFile,readdir}from'node:fs/promises'
import ts from'typescript'
import{command,schema}from'../dist/protocol.js'
test('owned TypeScript has no any, type assertions or compiler suppression',async()=>{
 async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=directory+'/'+entry.name;if(entry.isDirectory()){await visit(path);continue}if(!path.endsWith('.ts'))continue
  const source=await readFile(path,'utf8');assert.doesNotMatch(source,/@ts-(?:ignore|nocheck)/)
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true)
  function walk(node){assert.ok(node.kind!==ts.SyntaxKind.AnyKeyword&&!ts.isAsExpression(node)&&!ts.isTypeAssertionExpression(node),path+': unsafe type escape');ts.forEachChild(node,walk)}walk(file)
 }}await visit('src')
})
test('discriminated tool schemas and strict runtime decoder agree on every action',()=>{
 const cases=[{action:'status'},{action:'tabs'},{action:'stop'},{action:'observe',tabId:1},{action:'observe',tabId:1,cursor:'next-page'},{action:'screenshot',tabId:1},{action:'click',tabId:1,observationId:'o',ref:'n1'},{action:'fill',tabId:1,observationId:'o',ref:'n1',text:'😀'.repeat(8192)},{action:'press',tabId:1,key:'Enter'},{action:'navigate',tabId:1,url:'https://example.com'}]
 for(const value of cases){
  const branch=schema.oneOf.find(row=>row.properties.action.const===value.action||row.properties.action.enum?.includes(value.action));assert.ok(branch,value.action)
  assert.equal(branch.additionalProperties,false);assert.deepEqual(command(value),value)
  assert.ok(Object.keys(value).every(key=>key in branch.properties))
  for(const required of branch.required){const missing={...value};delete missing[required];assert.throws(()=>command(missing))}
  assert.throws(()=>command({...value,unknownField:true}))
 }
})
