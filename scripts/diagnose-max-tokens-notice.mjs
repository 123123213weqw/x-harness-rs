// Diagnostic of the CURRENT behavior; deliberately asserts the known mismatch.
// Not a passing regression contract for the eventual fix; not added to CI.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const [fixturePath,...bundles]=process.argv.slice(2);
const fixtures=JSON.parse(readFileSync(fixturePath,'utf8'));
for(const path of bundles) {
 const source=readFileSync(path,'utf8');
 const start=source.indexOf('function lastStep(context)',source.indexOf('//#region lib/types/client/conversation-nodes/turn-max-tokens.js'));
 const end=source.indexOf('const turnMaxTokensDefinition',start);
 const defEnd=source.indexOf('\n\t\t};',end)+6;
 assert.ok(start>=0 && end>start && defEnd>end);
 const itemStart=source.indexOf('function TurnMaxTokensItem({ t })');
 const itemEnd=source.indexOf('\n\t\t}',itemStart)+5;
 const hints=[...source.matchAll(/"message\.maxTokens\.hint": ("(?:\\.|[^"\\])*")/g)].map(m=>JSON.parse(m[1]));
 assert.ok(hints.length>=2);
 const jsx=(type,props)=>({type,props});
 const env={react_jsx_runtime:{jsx,jsxs:jsx},MessageItem_module_css_default:{},
  _xharness_dsh_client_ui_primitives:{StateDot:'dot'},
  chatNode:(_ctx,kind,seq,data)=>({kind,seq,data})};
 vm.runInNewContext(source.slice(start,defEnd)+'\nglobalThis.def=turnMaxTokensDefinition;\n'+source.slice(itemStart,itemEnd)+'\nglobalThis.render=TurnMaxTokensItem;',env);
 for(const fixture of fixtures) {
  const endEvent=fixture.events.find(e=>e.type==='turn/end' && e.data.reason.kind==='max-tokens');
  assert.ok(endEvent);
  const match={event:endEvent};
  assert.ok(env.def.match(endEvent));
  let state=env.def.start({},match);
  for(const event of fixture.events.filter(e=>e.seq>endEvent.seq)) {
   // New turn doesn't match this contribution or clear its old notice.
   assert.equal(env.def.match(event),null);
   state=env.def.update({state},{event});
  }
  assert.ok(env.def.buildViewNode({state,start:match,matches:[match]}));
  for(const hint of hints) {
   const t=key=>key==='message.maxTokens.hint'?hint:key;
   const idle=env.render({t,running:false});
   const running=env.render({t,running:true});
   assert.deepEqual(running,idle,'current notice ignores session activity');
   assert.ok(JSON.stringify(running).includes(hint.replaceAll('"','\\"')));
  }
  console.log(JSON.stringify({bundle:path,queued:fixture.queued,running:fixture.running,provider_calls:fixture.provider_calls,noticePersists:true,hints}));
 }
}
