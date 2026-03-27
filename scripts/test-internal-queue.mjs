// Contract regression against the UI bundle actually shipped to Web/Tauri.
// Runtime inputs use the existing context placement, not a second queue widget.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', import.meta.url), 'utf8');
const dock = code.slice(code.indexOf('function QueueDock('));
const filter = dock.match(/inbox\.filter\(\(row\) => row\.placement === "queued"\)/)?.[0];
assert.ok(filter, 'QueueDock must keep runtime context out of editable drafts');
const items = [
  {id:'receipt',placement:'context',message:{source:{kind:'agent-settlement'}}},
  {id:'draft',placement:'queued',message:{source:{kind:'user'}}},
  {id:'steered',placement:'steering',message:{source:{kind:'user'}}},
  {id:'peer',placement:'context',message:{source:{kind:'agent-message'}}},
];
assert.deepEqual(Array.from(vm.runInNewContext(filter, {inbox:items}), x=>x.id), ['draft']);
assert.match(dock, /editing !== null && \(!queueMutable \|\| !queue\.some\(\(row\) => row\.id === editing\.id\)\)\) setEditing\(null\)/,
  'a stale editor must close after its queue item becomes runtime context');
const method = code.slice(code.indexOf('async steerQueue(session, shell) {'), code.indexOf('\n\t\t\tcontroller(actx)', code.indexOf('async steerQueue(session, shell) {')));
assert.ok(method.startsWith('async steerQueue('));
const controller = vm.runInNewContext('({' + method + '})');
let calls=[];
const session={getSnapshot:()=>({queue:items}),updateQueue:async(id,action)=>{calls.push({id,kind:action.kind});return {ok:true};}};
await controller.steerQueue(session,{notify(){throw Error('unexpected notification');}});
assert.deepEqual(calls,[{id:'draft',kind:'steer'}]);
calls=[];
await controller.steerQueue({...session,getSnapshot:()=>({queue:items.filter(x=>x.placement==='context')})},{});
assert.deepEqual(calls,[]);
// The empty-composer shortcut must not activate for context-only inputs either.
assert.match(code, /input\.queue\.some\(\(row\) => row\.placement === "queued"\)/);
console.log('internal queue UI contract: 6 checks passed');
