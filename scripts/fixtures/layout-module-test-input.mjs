/** Full policy-checked Layout closure with private helper access for regression
 * only. Production module exports/inputs are not changed. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {compileSourceModules} from '../build-source-modules.mjs'
const id='@xharness/dsh-client-ui-layout'
let compiled
export function layoutUnitModuleTestInput(file,names){
 const implementation=process.env.UI_TEST_IMPL??'source'
 let bytes=implementation==='legacy'?readFileSync(new URL(`../../ui/reference/master-a613970/plugins/${id}/client.js`,import.meta.url),'utf8'):(compiled??=compileSourceModules(new URL('../../ui/',import.meta.url).pathname,[{id,source:'src/modules/layout/index.ts'}]).get(id).bytes.toString())
 if(implementation==='legacy')return bytes.replace('return module.exports;',`Object.assign(exports,{${names.join(',')}});return module.exports;`)
 assert.equal(implementation,'source','unit seam operates freshly strict-compiled source or immutable frozen reference')
 const pattern=/return __load\(("[^"\n]+")\);\n\}\n\}\);\s*$/
 assert.ok(pattern.test(bytes),'owned compiler unit return')
 return bytes.replace(pattern,`return {...__load($1),...__load(${JSON.stringify('src/modules/layout/'+file)})};\n}\n});`)
}
