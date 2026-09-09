import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchConversationMessageEdit,patchMessageEditConnection,patchMessageEditRuntime} from './patch-conversation-message-edit.mjs';
const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('ui/overrides/conversation-message-edit.js',root),'utf8');
const sandbox={File,Blob,URL,Promise,console};
vm.runInNewContext(source+'\nglobalThis.Editor=XHarnessMessageEditor;',sandbox);
const Editor=sandbox.Editor;
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
    releaseDraftImage(id){const a=images.get(id);if(a)URL.revokeObjectURL(a.previewUrl);images.delete(id);}};
  const d={id,shell,conversation,storage,t:x=>x,running:()=>false,read:async()=>({ok:true,value:{attachment:{mediaType:'image/png'},data:new Uint8Array([1,2,3])}}),focus:()=>{}};
  return {d,shell,conversation,editor:new Editor(d)};
}
const text=t=>[{type:'text',text:t}];const image={type:'image',attachment:{attachmentId:'old',mediaType:'image/png',name:'old.png'}};
const tick=()=>new Promise(r=>setTimeout(r,0));
let checks=0;
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
 const a=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];f.d.read=async()=>({ok:true,value:{attachment:{mediaType:'image/png'},data:new Uint8Array([1])}});await f.editor.hydrate(a);f.editor.guardSubmit();
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
 const g=fixture();await g.editor.request([{type:'file',attachment:{}}]);assert.equal(g.shell.snapshot.draft,'');assert.equal(g.editor.state.editing,false);checks++;
}
{
 const f=fixture();let release;f.d.read=()=>new Promise(r=>release=r);
 await f.editor.request([image]);const a=f.conversation.draftImages(f.shell.snapshot.imageIds)[0];
 f.shell.removeImage(a.id);f.conversation.releaseDraftImage(a.id);release({ok:true,value:{attachment:{mediaType:'image/png'},data:new Uint8Array([1])}});await tick();
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
const graph=JSON.parse(readFileSync(new URL('ui/dist/client-graph.json',root)));
for(const [id,patch] of [['dsh-client-ui-conversation',patchConversationMessageEdit],['dsh-client-connection',patchMessageEditConnection],['dsh-client-runtime',patchMessageEditRuntime]]){
 const bytes=readFileSync(new URL(`ui/dist/plugins/@deepseek-ai/${id}/client.js`,root));new vm.Script(bytes.toString());
 assert.equal(patch(bytes).toString(),bytes.toString());assert.equal(graph.entries.find(e=>e.id===`@deepseek-ai/${id}`).rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
 assert.throws(()=>patch(Buffer.from('upstream changed')),/signature changed/);
}
const html=readFileSync(new URL('ui/dist/index.html',root),'utf8');assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph);
console.log(`message editor: ${checks} lifecycle assertions plus 3 patch/schema/hash contracts passed`);
