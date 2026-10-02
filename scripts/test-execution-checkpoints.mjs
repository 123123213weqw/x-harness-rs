import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patchExecutionCheckpoints} from './patch-execution-checkpoints.mjs';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {harness,json} from './conversation-test-harness.mjs';
const golden=legacyConversation();assert.deepEqual(patchExecutionCheckpoints(golden),golden);
assert.throws(()=>patchExecutionCheckpoints(Buffer.from('changed upstream')),/anchor changed/);
const helper=readFileSync(new URL('../ui/overrides/execution-checkpoints.js',import.meta.url),'utf8');
assert.ok(golden.toString().includes(helper.trim()));
const env={react:{memo:x=>x},chatNode:(_c,kind,seq,data)=>({kind,seq,data})};vm.runInNewContext(helper+'\nglobalThis.definition=xhCheckpointDefinition;',env);
const api=harness(exposeConversation(verifyConversationArtifact(),['xhCheckpointDefinition'])).plugin;
for(const d of [env.definition,api.xhCheckpointDefinition]) {
 const event={seq:42,time:1,type:'run/checkpoint',data:{turn:0,notice:{kind:'issued',message:'阶段及重复提醒',phase:1}}};
 assert.equal(d.match(event).id,'42');
 const live=d.start({}, {event}),restored=d.start({}, {event:JSON.parse(JSON.stringify(event))});assert.deepEqual(json(live),json(restored));
 const ctx={key:'run-checkpoint:42',id:'42',state:live,matches:[{event,location:{kind:'session'}}]};
 assert.equal(d.buildViewNode(ctx).data.noticeKind,'issued');assert.equal(d.publication?.(ctx)??'immediate','immediate');
 assert.equal(d.match({...event,data:{turn:0,notice:null}}),null);
 assert.equal(d.match({type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}),null);
 assert.equal(d.start({}, {event:{...event,type:'turn/end',data:{turn:0,reason:{kind:'max-steps'}}}}).kind,'limit');
}
// Exercise actual apply registrations so a definition existing but never installed fails.
const defs=[],slots=[],host={getSnapshot:()=>({value:{busyEnter:'queue'}}),subscribe:()=>()=>{},set:async()=>{}};
const ctx={effect:fn=>fn(),locale:{register:()=>{},bind:()=>key=>key},sessions:{provide:()=>()=>{},list:{getSnapshot:()=>({byId:{}})},scope(){},on:()=>()=>{}},workspaces:{},layout:{},settingsScope:{bind:()=>host},conversationEvents:{register:d=>defs.push(d),registerFallback:()=>{}},conversationViews:{register:()=>{}},slots:{inject:(_n,fn)=>fn(),register:(spec,component)=>slots.push({spec,component}),entries:()=>[],subscribe:()=>()=>{},getVersion:()=>0},get:name=>ctx[name],on:()=>()=>{},plugin:(plugin,config)=>typeof plugin==='function'?new plugin(ctx,config):plugin.apply(ctx)};
api.apply(ctx);assert.ok(defs.includes(api.xhCheckpointDefinition));assert.ok(slots.some(row=>row.spec.name==='conversation.chat.node'&&row.spec.key==='run-checkpoint'));
console.log('execution checkpoint: native + golden live/history projection, immediate publication, limit notice, hidden snapshots, actual registrations + freshness/hash/boot passed');
