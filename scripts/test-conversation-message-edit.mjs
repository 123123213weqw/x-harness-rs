import assert from 'node:assert/strict';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {harness} from './conversation-test-harness.mjs';
import {loadSourceInternals} from './fixtures/load-source-internals.mjs';
import {runFrozenSourceDifferential} from './runtime-source-test-harness.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchConversationMessageEdit,patchMessageEditConnection,patchMessageEditRuntime} from './patch-conversation-message-edit.mjs';
const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('ui/overrides/conversation-message-edit.js',root),'utf8');
const sandbox={File,Blob,URL,Promise,console};
vm.runInNewContext(source+'\nglobalThis.Editor=XHarnessMessageEditor;globalThis.forkMessage=xhForkMessage;',sandbox);
const goldenEditor=sandbox.Editor,goldenFork=sandbox.forkMessage;
const actualSource=verifyConversationArtifact();
const actual=harness(exposeConversation(actualSource,['xhForkMessage','zh','deriveAncestry'])).plugin;
let Editor;
const records=new Map();
const storage={load:async id=>records.get(id),save:async(id,r)=>{records.set(id,structuredClone(r));},remove:async id=>{records.delete(id);}};
let next=0;
function fixture(id='s'+next++) {
  const images=new Map();let snapshot={draft:'',imageIds:[],phase:'plain'};const subs=new Set();
  const shell={disposed:false,imageSendInFlight:false,get snapshot(){return snapshot;},state:{subscribe:fn=>{subs.add(fn);return()=>subs.delete(fn);}},
    publish(){snapshot={...snapshot};for(const fn of subs)fn();},setDraft(text){snapshot={...snapshot,draft:text};this.publish();},
    removeImage(id){snapshot={...snapshot,imageIds:snapshot.imageIds.filter(x=>x!==id)};this.publish();},
    addImages(ids){snapshot={...snapshot,imageIds:[...snapshot.imageIds,...ids]};this.publish();},phase(p){snapshot={...snapshot,phase:p};this.publish();}};
  const conversation={createdImageUrls:new Set(),draftImages:ids=>ids.map(id=>images.get(id)).filter(Boolean),
    createDraftImages:files=>files.map(file=>{const a={id:'img'+next++,file,previewUrl:URL.createObjectURL(file)};images.set(a.id,a);return a;}),
    releaseDraftImage(id){const a=images.get(id);if(a)URL.revokeObjectURL(a.previewUrl);images.delete(id);},replaceDraftPreview(image,file){URL.revokeObjectURL(image.previewUrl);image.file=file;image.previewUrl=URL.createObjectURL(file);image.loadState='ready';}};
  const d={id,shell,conversation,storage,t:x=>x,running:()=>false,read:async()=>({ok:true,value:{attachment:{attachmentId:'old',mediaType:'image/png',bytes:3},data:new Uint8Array([1,2,3])}}),focus:()=>{}};
  return {d,shell,conversation,editor:new Editor(d)};
}
const text=t=>[{type:'text',text:t}];const image={type:'image',attachment:{attachmentId:'old',mediaType:'image/png',name:'old.png',bytes:3}};
const tick=()=>new Promise(r=>setTimeout(r,0));
let checks=0;
for(const implementation of [{Editor:goldenEditor,fork:goldenFork},{Editor:actual.XHarnessMessageEditor,fork:actual.xhForkMessage}]) {
 records.clear();Editor=implementation.Editor;sandbox.forkMessage=implementation.fork;
{
 const f=fixture('fork-child');let forkCalls=0,openCalls=0;
 const sessions={binding:()=>({session:{readAttachment:async()=>({ok:true,value:{attachment:{attachmentId:'old',mediaType:'image/png',bytes:3},data:new Uint8Array([4,5,6])}})}}),
  fork:async opts=>{forkCalls++;assert.equal(opts.beforeUserSeq,12);return 'fork-child';},open:id=>{openCalls++;assert.equal(id,'fork-child');}};
 const inputHub={shell:id=>{assert.equal(id,'fork-child');return {...f.shell,xhEditor:f.editor,notify:()=>{}};}};
 await sandbox.forkMessage(inputHub,sessions,'parent',12,[...text('edit me'),image]);
 assert.equal(forkCalls,1);assert.equal(openCalls,1);assert.equal(f.shell.snapshot.draft,'edit me');
 const attachment=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];
 assert.equal(await attachment.file.arrayBuffer().then(b=>new Uint8Array(b)[0]),4);
 assert.equal(attachment.historyRef,undefined);assert.equal(f.editor.state.editing,true);checks+=6;
 await assert.rejects(()=>sandbox.forkMessage(inputHub,sessions,'parent',13,[{type:'audio'}]));
 assert.equal(forkCalls,1);checks++;
}
{
 const f=fixture();f.shell.setDraft('unsent');await f.editor.request(text('history'));
 assert.equal(f.editor.state.phase,'confirm');assert.equal(f.shell.snapshot.draft,'unsent');
 await f.editor.cancel();assert.equal(f.shell.snapshot.draft,'unsent');
 await f.editor.request(text('history'));await f.editor.confirm();assert.equal(f.shell.snapshot.draft,'history');
 f.shell.setDraft('edited');await f.editor.writes;assert.equal(records.get(f.d.id).draft.text,'edited');
 await f.editor.cancel();assert.equal(f.shell.snapshot.draft,'unsent');assert.equal(records.has(f.d.id),false);checks+=6;
}
{
 const f=fixture();const file=new File(['original'],'draft.png',{type:'image/png'});const a=f.conversation.createDraftImages([file])[0];f.shell.addImages([a.id]);
 await f.editor.request([image]);assert.equal(f.editor.state.phase,'confirm');await f.editor.confirm();await tick();
 assert.equal(f.shell.snapshot.draft,'');assert.equal(f.conversation.draftImages(f.shell.snapshot.imageIds)[0].historyRef.attachmentId,'old');f.editor.guardSubmit();
 await f.editor.cancel();assert.equal(await f.conversation.draftImages(f.shell.snapshot.imageIds)[0].file.text(),'original');checks+=4;
}
{
 const f=fixture();f.d.read=async()=>({ok:false,error:{message:'deleted'}});await f.editor.request([image]);await tick();
 assert.throws(()=>f.editor.guardSubmit(),/editMissing/);assert.equal(f.editor.state.editing,true);
 const a=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];f.d.read=async()=>({ok:true,value:{attachment:{attachmentId:'old',mediaType:'image/png',bytes:1},data:new Uint8Array([1])}});await f.editor.hydrate(a);f.editor.guardSubmit();
 f.d.running=()=>true;assert.throws(()=>f.editor.guardSubmit(),/editRunning/);f.d.running=()=>false;
 // Failed admission never calls sent(): draft and transaction remain retryable.
 assert.equal(f.shell.snapshot.imageIds.length,1);await f.editor.sent();assert.equal(records.has(f.d.id),false);checks+=5;
}
{
 const f=fixture();f.shell.setDraft('backup');await f.editor.request(text('old'));await f.editor.confirm();f.shell.setDraft('new text');await f.editor.writes;f.editor.dispose();
 const g=fixture(f.d.id);await g.editor.ready;assert.equal(g.editor.state.phase,'recover');await g.editor.recover();assert.equal(g.shell.snapshot.draft,'new text');await g.editor.cancel();assert.equal(g.shell.snapshot.draft,'backup');checks+=3;
}
{
 const f=fixture();f.d.running=()=>true;await f.editor.request(text('no'));assert.equal(f.shell.snapshot.draft,'');f.d.running=()=>false;
 let release;f.d.storage={...storage,save:()=>new Promise(r=>release=r)};
 const pending=f.editor.request(text('history'));await tick();f.shell.setDraft('typed during save');release();await pending;
 assert.equal(f.shell.snapshot.draft,'typed during save');assert.equal(f.editor.state.editing,false);checks+=3;
}
{
 const f=fixture();f.d.storage={...storage,save:async()=>{throw Error('quota');}};f.shell.setDraft('keep');await f.editor.request(text('old'));await f.editor.confirm();assert.equal(f.shell.snapshot.draft,'keep');
 const a=fixture(),b=fixture();await Promise.all([a.editor.request(text('A')),b.editor.request(text('B'))]);assert.equal(a.shell.snapshot.draft,'A');assert.equal(b.shell.snapshot.draft,'B');
 a.shell.phase('submitting');assert.equal(a.editor.busy(),true);await a.editor.cancel();assert.equal(a.editor.state.editing,true);checks+=5;
}
{
 const f=fixture();await Promise.all([f.editor.request(text('first')),f.editor.request(text('second'))]);assert.equal(f.shell.snapshot.draft,'first');checks++;
 const g=fixture();await g.editor.request([{type:'audio',attachment:{}}]);assert.equal(g.shell.snapshot.draft,'');assert.equal(g.editor.state.editing,false);checks++;
}
{
 const f=fixture();let release;f.d.read=()=>new Promise(r=>release=r);
 await f.editor.request([image]);const a=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];
 f.shell.removeImage(a.id);f.conversation.releaseDraftImage(a.id);release({ok:true,value:{attachment:{attachmentId:'old',mediaType:'image/png',bytes:1},data:new Uint8Array([1])}});await tick();
 assert.equal(f.shell.snapshot.imageIds.length,0);assert.equal(f.conversation.draftImages([a.id]).length,0);checks+=2;
}
{
 const f=fixture();await f.editor.request(text('old'));f.editor.dispose();
 const g=fixture(f.d.id);await g.editor.ready;const a=g.conversation.createDraftImages([new File(['new'],'new.png')])[0];g.shell.addImages([a.id]);
 await g.editor.cancel();assert.equal(g.editor.state.phase,'recover');assert.equal(g.shell.snapshot.imageIds[0],a.id);checks+=2;
}
{
 const f=fixture();await f.editor.request(text('old'));let release;f.d.storage={...storage,remove:()=>new Promise(r=>release=r)};
 const cancelled=f.editor.cancel();await tick();assert.equal(f.editor.state.phase,'saving');
 await f.editor.request(text('do not overwrite'));assert.equal(f.shell.snapshot.draft,'');release();await cancelled;
 assert.equal(f.editor.state.phase,'idle');checks+=3;
}
{
 const f=fixture();f.shell.setDraft('backup');await f.editor.request(text('old'));let release,saves=0;
 f.d.storage={...storage,save:()=>{saves++;return new Promise(r=>release=r)}};
 const first=f.editor.confirm();await f.editor.confirm();assert.equal(saves,1);release();await first;
 const before=f.editor.getSnapshot();f.shell.setDraft('changed');assert.notEqual(f.editor.getSnapshot(),before);checks+=2;
}
{
 const f=fixture();await f.editor.request([{type:'file',attachment:{attachmentId:'f',mediaType:'application/pdf',name:'a.pdf',bytes:3}}]);await tick();
 const a=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];assert.equal(a.historyKind,'file');assert.equal(a.historyRef.attachmentId,'f');
 await f.editor.persist();f.editor.dispose();const g=fixture(f.d.id);await g.editor.ready;await g.editor.recover();await tick();
 assert.equal(g.conversation.draftImages(g.shell.snapshot.imageIds)[0].historyKind,'file');checks+=3;
}
}
const graph=JSON.parse(readFileSync(new URL('ui/dist/client-graph.json',root)));
const conversationBundle=readFileSync(new URL('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',root),'utf8');
const connectionBundle=readFileSync(new URL('ui/dist/plugins/@xharness/dsh-client-connection/client.js',root),'utf8');
const runtimeBundle=readFileSync(new URL('ui/dist/plugins/@xharness/dsh-client-runtime/client.js',root),'utf8');
const ancestors={byId:{parent:{id:'parent',displayTitle:'Parent',origin:'root'},child:{id:'child',displayTitle:'Child',origin:'fork',parentId:'parent'},agent:{id:'agent',displayTitle:'Agent',origin:'subagent',parentId:'child'}}};
assert.deepEqual(JSON.parse(JSON.stringify(actual.deriveAncestry(ancestors,'agent'))).map(row=>row.id),['parent','child','agent']);
assert.equal(actual.zh['message.editFork'],'编辑并 Fork 到新对话');
assert.ok(/blank: !log\.slice\(0,\s*cut\)\.some\(\(?([a-zA-Z]+)\)? => \1\.type === ["']user\/message["']\)/.test(connectionBundle),'native connection fork computes blank from user history');
// The real emitted service→manager→API closure must carry the precise cut.
// This is an actual distribution probe, not a whitespace anchor or a rebuilt test module.
const runtimeGlobals={console,Promise,AbortController,AbortSignal,URL,queueMicrotask,setTimeout,clearTimeout};
const runtimeExternals=name=>name==='@xharness/cordis'?{Service:class{}}:{resolveSlotLabel:x=>x};
let runtimeClasses;
if(runtimeBundle.startsWith('// Generated from ')) {
 const emitted=loadSourceInternals('@xharness/dsh-client-runtime',runtimeExternals,runtimeGlobals);
 runtimeClasses={Session:emitted.internal('src/modules/client-runtime/sessions/session.js').Session,SessionManager:emitted.internal('src/modules/client-runtime/sessions/manager.js').SessionManager,SessionRuntime:emitted.public.SessionRuntime};
} else {
 let registration;vm.runInNewContext(runtimeBundle.replace('return module.exports;','Object.assign(exports,{Session,SessionManager,SessionRuntime});return module.exports;'),{...runtimeGlobals,window:{__ModuleLoader__:{load:row=>registration=row}}});runtimeClasses=registration.factory(runtimeExternals);
}
const wireCalls=[];let child=0;
const manager=new runtimeClasses.SessionManager({sessions:{fork:async payload=>{wireCalls.push(payload);return{result:{ok:true,value:{sessionId:'child-'+ ++child}}}}}},{});
manager.summaries.push({sessionId:'parent',blank:false,cwd:'/workspace',running:false,updatedAt:0});
const runtimeOwner={manager,projectList(){}};
const childId=await runtimeClasses.SessionRuntime.prototype.fork.call(runtimeOwner,{sessionId:'parent',atSeq:3.9,beforeUserSeq:12.9});
assert.deepEqual(JSON.parse(JSON.stringify(wireCalls[0])),{sessionId:'parent',atSeq:3,beforeUserSeq:12});
const summary=manager.summaries.find(row=>row.sessionId===childId);assert.equal(summary.blank,true);assert.equal(summary.origin,'fork');assert.equal(summary.parentSessionId,'parent');assert.equal(summary.cwd,'/workspace');
const ordinaryId=await runtimeClasses.SessionRuntime.prototype.fork.call(runtimeOwner,{sessionId:'parent',atSeq:19.4});assert.equal(manager.summaries.find(row=>row.sessionId===ordinaryId).blank,false);assert.equal('beforeUserSeq' in wireCalls[1],false);

const guardCalls=[],guardApi={sessions:{prompt:async payload=>{guardCalls.push(payload);return{result:{ok:true,value:{accepted:true}}}}},subagents:{prompt:async payload=>{guardCalls.push(payload);return{result:{ok:true,value:{accepted:true}}}}}};
const attachments=[{type:'image',mediaType:'image/png',data:'YQ=='},{type:'image_ref',attachmentId:'image-id'},{type:'file',mediaType:'text/plain',data:'YQ==',name:'notes.txt'},{type:'file_ref',attachmentId:'file-id',name:'notes.txt'}];
for(const part of attachments)for(const mode of ['queue','steer'])for(const withText of [false,true]) {
 const session=new runtimeClasses.Session('child',guardApi,{}, {address:{parentSessionId:'parent',childSessionId:'child',mode:'continuable'},parentAvailable:true});
 const result=await session.prompt(withText?[{type:'text',text:'do not discard'},part]:[part],mode,undefined,{requireIdle:true});assert.equal(result.ok,false);assert.equal(result.error.code,'attachment-error');assert.equal(guardCalls.length,0,'actual shipped subagent path must not discard attachments into text-only prompts');
}
const ordinary=new runtimeClasses.Session('ordinary',guardApi,{});assert.equal((await ordinary.prompt(attachments,'steer',undefined,{requireIdle:true})).ok,true);assert.deepEqual(JSON.parse(JSON.stringify(guardCalls[0].content)),attachments);assert.equal(guardCalls[0].requireIdle,true);
runFrozenSourceDifferential('native before-user fork|native continuable subagent');

for(const [id,patch] of [['dsh-client-ui-conversation',patchConversationMessageEdit],['dsh-client-connection',patchMessageEditConnection],['dsh-client-runtime',patchMessageEditRuntime]]){
 const bytes=readFileSync(new URL(`ui/dist/plugins/@xharness/${id}/client.js`,root));new vm.Script(bytes.toString());
 const golden=readFileSync(new URL(`ui/reference/master-a613970/plugins/@xharness/${id}/client.js`,root));assert.equal(patch(golden).toString(),golden.toString());assert.equal(graph.entries.find(e=>e.id===`@xharness/${id}`).rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
 assert.throws(()=>patch(Buffer.from('upstream changed')),/signature changed/);
}
const html=readFileSync(new URL('ui/dist/index.html',root),'utf8');assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph);
for(const id of ['dsh-client-ui-conversation','dsh-client-connection','dsh-client-runtime']) {
 const entry=graph.entries.find(e=>e.id===`@xharness/${id}`);
 assert.ok(html.includes(entry.url),`index.html must preload the patched ${id} revision`);
}
console.log(`message editor: ${checks} native + golden lifecycle assertions plus 3 golden/schema/hash/boot/source-freshness contracts passed`);
