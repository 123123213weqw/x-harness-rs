import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { patchAttachments } from './patch-attachments.mjs'
const root = fileURLToPath(new URL('../',import.meta.url))
const id = '@deepseek-ai/dsh-client-ui-conversation'
const source = readFileSync(resolve(root,`ui/dist/plugins/${id}/client.js`),'utf8')
assert.equal(patchAttachments(id,Buffer.from(source)).toString(),source,'patch must be idempotent')
const start = source.indexOf('function attachmentMediaType(')
const end = source.indexOf('//#region lib/types/client/input/blocks.js',start)
assert.ok(start>0&&end>start)
const revoked=[]
const context = vm.createContext({console,crypto:{randomUUID},URL:{createObjectURL:()=> 'blob:'+randomUUID(),revokeObjectURL:url=>revoked.push(url)},btoa,Uint8Array,Map,Set,Promise,Error,
  _deepseek_ai_cordis:{Service:class {constructor(ctx){this.ctx=ctx}}}})
vm.runInContext(source.slice(start,end)+'\nglobalThis.Controller=ConversationController;globalThis.validate=validateAttachments;',context)
const controller = new context.Controller({effect(){}},{input:{},blocks:{}})
const png = new File([new Uint8Array([1,2,3])],'截图.png',{type:'image/png'})
const pdf = new File(['PDF bytes'],'说明.pdf',{type:'application/pdf'})
const code = new File(['hello'],'main.rs')
const drafts = controller.createDraftImages([png,pdf,code])
assert.deepEqual(Array.from(drafts,d=>d.kind),['image','file','file'])
let captured,accept=false
const session = {async prompt(content){captured=content;return {ok:accept}}}
let result = await controller.sendSession(session,'检查附件',drafts.map(d=>d.id),'queue')
assert.equal(result.kind,'error');assert.equal(controller.draftImages(drafts.map(d=>d.id)).length,3,'failed send retains every draft')
assert.deepEqual(Array.from(captured,p=>p.type),['image','file','file','text'])
assert.equal(captured[1].data,btoa('PDF bytes'));assert.equal(captured[2].mediaType,'application/octet-stream')
accept=true
result = await controller.sendSession(session,'检查附件',drafts.map(d=>d.id),'queue')
assert.equal(result.kind,'success');assert.equal(controller.draftImages(drafts.map(d=>d.id)).length,0)
assert.equal(revoked.length,3)
assert.throws(()=>context.validate([{name:'huge.bin',type:'',size:33*1024*1024}]),/32 MiB/)
assert.throws(()=>context.validate(Array.from({length:21},()=>({name:'a.png',type:'image/png',size:1}))),/20/)
const svg=controller.createDraftImages([new File(['<svg/>'],'unsafe.svg',{type:'image/svg+xml'})])[0]
assert.equal(svg.kind,'file','SVG stays a download, not active inline content')
const cards=readFileSync(resolve(root,'ui/dist/plugins/@deepseek-ai/dsh-client-ui-attachment/client.js'),'utf8')
assert.ok(cards.includes('XHarnessHistoryFile'));assert.ok(cards.includes('multiple:true'))
const models=readFileSync(resolve(root,'ui/dist/plugins/@deepseek-ai/dsh-client-ui-settings-models/client.js'),'utf8')
assert.ok(models.includes("inputModalities:event.target.checked?['text','image']:['text']"))
console.log('attachments: ordered mixed payloads, failure retention, success release, size/count limits, safe generic fallback, model checkbox and idempotent UI patch passed')
// Decode through the actual shipped connection schemas, not only a stub session.
let wireRegistration;
let wireSource=readFileSync(resolve(root,'ui/dist/plugins/@deepseek-ai/dsh-client-connection/client.js'),'utf8');
wireSource=wireSource.replace('exports.AbstractApiClient = AbstractApiClient;', 'exports.testAttachment = sessionAttachmentValueSchema; exports.testPart = promptContentPartSchema; exports.AbstractApiClient = AbstractApiClient;');
vm.runInNewContext(wireSource,{window:{__ModuleLoader__:{load:r=>wireRegistration=r}},console,URL,AbortController,setTimeout,clearTimeout});
const wire=wireRegistration.factory(id=>id==='@deepseek-ai/cordis'?{Service:class{}}:{});
for(const part of captured) assert.equal(wire.testPart.parse(part).type,part.type);
const emptyFile={attachment:{attachmentId:'sha256:fixture',mediaType:'application/octet-stream',bytes:0,name:'empty.txt'},data:''};
assert.equal(wire.testAttachment.parse(emptyFile).attachment.bytes,0);
const imageRef={attachment:{attachmentId:'sha256:fixture',mediaType:'image/png',bytes:12,width:32,height:32},data:'fixture'};
assert.equal(wire.testAttachment.parse(imageRef).attachment.width,32);
console.log('actual connection schemas preserve mixed prompts, zero-byte generic files, and image dimensions');
