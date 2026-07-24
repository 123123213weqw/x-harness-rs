// Acceptance-only AST scope over canonical factories. No production exports,
// copied function bodies, or separately reconstructed CSS are introduced.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { verifyArtifact } from './shipped-source-values.mjs'
const require=createRequire(new URL('../../ui/package.json',import.meta.url)),ts=require('typescript')
/** Keep every unit's original lexical require/imports; add only a test return. */
export function artifactUnitScope(artifact,bindings,privateMembers={}){
  const {source,root}=artifact,file=ts.createSourceFile('canonical.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  assert.equal(file.parseDiagnostics.length,0)
  const wanted=new Set(Object.values(bindings).map(binding=>binding.unit)),found=new Set(),edits=[];let returned=0
  function visit(node){
    if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&wanted.has(node.name.text)&&ts.isFunctionExpression(node.initializer)){
      const unit=node.name.text,body=node.initializer.body;found.add(unit)
      const members=privateMembers[unit]??[]
      for(const name of members){
        assert.ok(body.statements.some(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text===name),'private member must be declared in its actual owning unit: '+name)
      }
      if(members.length)edits.push({start:body.end-1,end:body.end-1,text:`\nObject.assign(exports,{${members.join(',')}});\n`})
    }
    if(ts.isReturnStatement(node)&&node.expression&&ts.isCallExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='__load'&&node.expression.arguments.length===1&&ts.isStringLiteral(node.expression.arguments[0])&&node.expression.arguments[0].text===root){
      returned++;edits.push({start:node.getStart(file),end:node.end,text:`return {${Object.entries(bindings).map(([name,{unit,member}])=>`${JSON.stringify(name)}:__load(${JSON.stringify(unit)})${member===undefined?'':`[${JSON.stringify(member)}]`}`).join(',')}};`})
    }
    ts.forEachChild(node,visit)
  }
  visit(file);assert.equal(returned,1,'one canonical factory entry return');assert.deepEqual(found,wanted,'all acceptance units exist in the actual artifact')
  let result=source;for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end)
  return result
}
export function contextViewScope(){
  const unit='src/modules/context/index.js'
  const source=verifyArtifact('@xlang/xharness-client-ui-context')
  assert.match(source,/^\/\/ Generated from src\/modules\/context\/index\.tsx;/,'audit must execute the strict context source artifact')
  return artifactUnitScope({source,root:unit},{apply:{unit,member:'apply'},HarnessView:{unit,member:'HarnessView'}},{[unit]:['HarnessView']})
}
