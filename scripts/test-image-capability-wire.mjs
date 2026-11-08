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
const {modelCatalogModelSchema,sessionAttachmentRequestSchema,sessionAttachmentValueSchema} = schemas('sessions')
const imageRef={attachmentId:'a',mediaType:'image/png',bytes:123,width:3200,height:2000}
assert.equal(sessionAttachmentRequestSchema.parse({sessionId:'s',attachmentId:'a',thumbnail:true}).thumbnail,true)
assert.equal(sessionAttachmentRequestSchema.safeParse({sessionId:'s',attachmentId:'a',thumbnail:'yes'}).success,false)
assert.equal(sessionAttachmentValueSchema.parse({attachment:imageRef,data:'base64',thumbnail:{width:480,height:300}}).thumbnail.width,480)
assert.equal(sessionAttachmentValueSchema.parse({attachment:imageRef,data:'base64'}).thumbnail,undefined,'legacy original response remains readable')
for(const thumbnail of [{width:481,height:300},{width:0,height:1},{width:1.5,height:1},{width:480,height:Infinity}])assert.equal(sessionAttachmentValueSchema.safeParse({attachment:imageRef,data:'base64',thumbnail}).success,false)
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
