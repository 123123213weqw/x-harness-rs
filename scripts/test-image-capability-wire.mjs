// Exercise production decoders: image metadata must survive the wire boundary.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const {buildSync} = require('esbuild')
function schemas(file) {
  const code = buildSync({entryPoints:[`ui/src/modules/client-connection/contracts/host/apiproxy/api/${file}.schema.ts`],
    bundle:true,platform:'node',format:'cjs',write:false,packages:'external'}).outputFiles[0].text
  const module = {exports:{}}
  vm.runInNewContext(code,{module,exports:module.exports,require})
  return module.exports
}
const {modelCatalogModelSchema} = schemas('sessions')
const {discoveredModelViewSchema} = schemas('llm')
for (const schema of [modelCatalogModelSchema,discoveredModelViewSchema]) {
  for (const imageInput of [true,false]) {
    const row = schema.parse({id:'m',name:'Model',imageInput,imageInputCapability:{state:imageInput?'supported':'unsupported',source:'documented'}})
    assert.equal(row.imageInput,imageInput)
    assert.equal(row.imageInputCapability.source,'documented')
  }
  assert.equal(schema.parse({id:'m',name:'Legacy'}).imageInput,undefined)
  assert.equal(schema.safeParse({id:'m',name:'Model',imageInput:'yes'}).success,false)
}
console.log('Image capability wire: supported/unsupported/unknown/provenance and legacy payloads passed')
