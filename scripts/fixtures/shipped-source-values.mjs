/** Read-only acceptance of static values in actual shipped source units. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {compileSourceModules} from '../build-source-modules.mjs'
const ui=new URL('../../ui/',import.meta.url)
const require=createRequire(new URL('package.json',ui)),ts=require('typescript')
export function verifyArtifact(id){
 const bytes=readFileSync(new URL(`dist/plugins/${id}/client.js`,ui))
 const manifest=JSON.parse(readFileSync(new URL('modules.json',ui))),entry=manifest.modules.find(row=>row.id===id)
 assert.ok(entry,`manifest includes ${id}`)
 const graph=JSON.parse(readFileSync(new URL('dist/client-graph.json',ui))),row=graph.entries.find(row=>row.id===id)
 const digest=value=>createHash('sha256').update(value).digest('hex')
 assert.equal(row?.rev,digest(bytes).slice(0,16))
 assert.ok(readFileSync(new URL('dist/index.html',ui),'utf8').includes(row.url))
 if(entry.kind==='source-module')assert.equal(digest(bytes),digest(compileSourceModules(ui.pathname,[entry]).get(id).bytes),`actual ${id} must be source fresh`)
 return bytes.toString()
}
/** No eval, no synthetic CSS: only an exact factory's own literal or const. */
export function shippedUnitValue(source,unitPath,binding='exports.default'){
 const ast=ts.createSourceFile('shipped.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
 assert.equal(ast.parseDiagnostics.length,0)
 const bodies=[]
 const visit=node=>{if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&node.name.text===unitPath&&ts.isFunctionExpression(node.initializer))bodies.push(node.initializer.body);ts.forEachChild(node,visit)}
 visit(ast);assert.equal(bodies.length,1,`exact shipped unit ${unitPath}`)
 const values=new Map()
 for(const statement of bodies[0].statements){
  if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer)values.set(d.name.text,d.initializer)
  if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken)values.set(statement.expression.left.getText(ast),statement.expression.right)
 }
 const seen=new Set()
 const literal=node=>{
  assert.ok(node,`unit ${unitPath} contains ${binding}`)
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text
  if(ts.isNumericLiteral(node))return Number(node.text)
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false
  if(ts.isIdentifier(node)){assert.ok(!seen.has(node.text),'static value cycle');seen.add(node.text);return literal(values.get(node.text))}
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(p=>{assert.ok(ts.isPropertyAssignment(p),'literal class map');return [ts.isStringLiteral(p.name)?p.name.text:p.name.getText(ast),literal(p.initializer)]}))
  throw Error(`Nonliteral shipped value ${unitPath}:${binding}`)
 }
 return literal(values.get(binding))
}
