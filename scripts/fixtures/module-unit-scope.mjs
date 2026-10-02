// Acceptance-only export of one actual lexical unit; imports and closure stay intact.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../../ui/package.json',import.meta.url))('typescript')
export function exposeModuleUnit(source,module,unit,name){
 if(!source.startsWith(`// Generated from src/modules/${module}/`)){
  assert.ok(source.includes('return module.exports;'),'frozen ModuleLoader return')
  return source.replace('return module.exports;',`Object.assign(exports,{${name}});return module.exports;`)
 }
 const path=`src/modules/${module}/${unit}.js`,ast=ts.createSourceFile('shipped.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
 let scope
 function visit(node){if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&node.name.text===path&&ts.isFunctionExpression(node.initializer))scope=node.initializer.body;ts.forEachChild(node,visit)}
 visit(ast);assert.ok(scope,`actual shipped scope ${path}`)
 if(!scope.getText(ast).includes(`exports.${name}`))source=source.slice(0,scope.end-1)+`\nObject.assign(exports,{${name}});\n`+source.slice(scope.end-1)
 const marker=`return __load("src/modules/${module}/index.js");`;assert.ok(source.includes(marker),'actual entry return')
 return source.replace(marker,`return Object.assign({},__load("src/modules/${module}/index.js"),{${name}:__load(${JSON.stringify(path)})[${JSON.stringify(name)}]});`)
}
