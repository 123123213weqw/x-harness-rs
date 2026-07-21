import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs';
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patchMaxTokensNotice} from './patch-max-tokens-notice.mjs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const fixturePath=new URL('docs/evidence/max-tokens-notice-20260914/host-events.json',root);
const bundles=[fileURLToPath(new URL('ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',root))];
const copy=JSON.parse(readFileSync(new URL('ui/overrides/max-tokens-notice.json',root),'utf8'));
const fixtures=JSON.parse(readFileSync(fixturePath,'utf8'));
for(const path of bundles) {
 const source=readFileSync(path,'utf8');
 const native=source.startsWith('// Generated from src/modules/conversation/');
 if(native)verifyConversationArtifact();
 const golden=legacyConversation().toString();
 const start=source.indexOf('function lastStep(context)',source.indexOf('//#region lib/types/client/conversation-nodes/turn-max-tokens.js'));
 const end=source.indexOf('const turnMaxTokensDefinition',start);
 const defEnd=source.indexOf('\n\t\t};',end)+6;
 if(!native)assert.ok(start>=0 && end>start && defEnd>end);
 const itemStart=source.indexOf('function TurnMaxTokensItem({ t })');
 const itemEnd=source.indexOf('\n\t\t}',itemStart)+5;
 const hints=[...(native?golden:source).matchAll(/"message\.maxTokens\.hint": ("(?:\\.|[^"\\])*")/g)].map(m=>JSON.parse(m[1]));
 assert.deepEqual(new Set(hints),new Set(Object.values(copy)));
 for(const hint of hints) assert.doesNotMatch(hint,/continue|发送|继续|resume/i);
 assert.deepEqual(patchMaxTokensNotice(Buffer.from(golden)),Buffer.from(golden),'patch must be idempotent');
 const stale=golden.replace(JSON.stringify(copy.en),JSON.stringify('Send "continue" to resume.')).replace(JSON.stringify(copy.zh),JSON.stringify('发送“继续”继续工作。'));
 assert.deepEqual(patchMaxTokensNotice(Buffer.from(stale)),Buffer.from(golden),'rebuild replaces old copy');
 assert.throws(()=>patchMaxTokensNotice(Buffer.from(golden.replace('const en = {','const renamed = {'))),/anchor changed/);
 const jsx=(type,props)=>({type,props});
 const env={react_jsx_runtime:{jsx,jsxs:jsx},MessageItem_module_css_default:{},
  _xharness_dsh_client_ui_primitives:{StateDot:'dot'},
  chatNode:(_ctx,kind,seq,data)=>({kind,seq,data})};
 if(native){const {api}=conversationFixture(source,['turnMaxTokensDefinition','TurnMaxTokensItem','en','zh']);env.def=api.turnMaxTokensDefinition;env.render=api.TurnMaxTokensItem;assert.deepEqual([api.en['message.maxTokens.hint'],api.zh['message.maxTokens.hint']].sort(),hints.sort());}
 else vm.runInNewContext(source.slice(start,defEnd)+'\nglobalThis.def=turnMaxTokensDefinition;\n'+source.slice(itemStart,itemEnd)+'\nglobalThis.render=TurnMaxTokensItem;',env);
 for(const fixture of fixtures) {
  const endEvent=fixture.events.find(e=>e.type==='turn/end' && e.data.reason.kind==='max-tokens');
  assert.ok(endEvent);
  const match={event:endEvent};
  assert.ok(env.def.match(endEvent));
  let state=env.def.start({},match);
  for(const event of fixture.events.filter(e=>e.seq>endEvent.seq)) {
   // Preserve the historical truncation fact even when a successor starts.
   assert.equal(env.def.match(event),null);
   state=env.def.update({state},{event});
  }
  assert.ok(env.def.buildViewNode({state,start:match,matches:[match]}));
  for(const hint of hints) {
   const t=key=>key==='message.maxTokens.hint'?hint:key;
   const idle=env.render({t,running:false});
   const running=env.render({t,running:true});
   for(const state of [{running:true},{running:false},{running:false,dispatchPaused:true},{running:true,queued:true},{running:false,restored:true}]) {
    assert.deepEqual(env.render({t,...state}),idle,'historical fact stays correct in every activity state');
   }
   assert.deepEqual(running,idle);
   assert.ok(JSON.stringify(running).includes(hint.replaceAll('"','\\"')));
  }
  console.log(`neutral max-token notice: queued=${fixture.queued}, running=${fixture.running}, bilingual render passed`);
 }
}

const graph=JSON.parse(readFileSync(new URL('ui/dist/client-graph.json',root),'utf8'));
const entry=graph.entries.find(e=>e.id==='@xharness/dsh-client-ui-conversation');
const hash=createHash('sha256').update(readFileSync(bundles[0])).digest('hex').slice(0,16);
assert.equal(entry.rev,hash);
assert.equal(entry.url,`/plugins/${entry.id}/client.js?rev=${hash}`);
const html=readFileSync(new URL('ui/dist/index.html',root),'utf8');
const boot=JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]);
assert.deepEqual(boot,graph,'desktop/web must ship the updated manifest');
const {assertRebuildInput}=await import('./fixtures/repository-ui-input.mjs');
assertRebuildInput('@xharness/dsh-client-ui-conversation');
console.log('max-token notice: history, running, paused, bilingual, rebuild and manifest checks passed');

execFileSync(process.execPath,['--check',fileURLToPath(new URL('scripts/assemble-static-ui.mjs',root))]);
