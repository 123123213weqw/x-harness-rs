// Deterministic metadata-only scheduling; no inference or live model calls.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../ui/package.json',import.meta.url));
const {transformSync}=require('esbuild');
import {readFileSync} from 'node:fs'
const source=transformSync(readFileSync(new URL('../ui/src/modules/model-selection/capability-refresh.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,setTimeout,clearTimeout,Date});
const {CapabilityRefresh}=module.exports;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){let now=0;const timers=new Set();return {queue:new CapabilityRefresh({now:()=>now,later:fn=>{timers.add(fn);return()=>timers.delete(fn)}}),timers,run:()=>{const runs=[...timers];timers.clear();runs.forEach(fn=>fn())},advance:ms=>{now+=ms}}}
function directory(source='provider_reported',provider='p'){
 const state={status:'ready',current:{provider,model:'m'},groups:[{id:provider,models:[{id:'m',reasoningCapability:{state:'supported',stale:true,source}}]}]};
 const calls=[];return {state,calls,disposed:false,available:()=>true,store:{getSnapshot:()=>state},load:async(force)=>{calls.push(force)}};
}
test('only stale configured discovery sources are checked, never ordinary unknown or explicit disable',async()=>{
 for(const source of ['unknown','configured','documented',undefined]){const h=harness(),d=directory(source);if(source===undefined)delete d.state.groups[0].models[0].reasoningCapability.source;h.queue.schedule(d);h.run();await tick();assert.equal(d.calls.length,0)}
 for(const source of ['provider_reported','last_known_good','discovery_failed']){const h=harness(),d=directory(source);h.queue.schedule(d);h.run();await tick();assert.deepEqual(d.calls,[true])}
 for(const mutate of [d=>d.state.groups[0].models[0].reasoningCapability.stale=false,d=>d.state.groups[0].models[0].reasoningCapability.state='disabled',d=>d.state.status='selecting',d=>d.disposed=true,d=>d.available=()=>false]){const h=harness(),d=directory();mutate(d);h.queue.schedule(d);h.run();await tick();assert.equal(d.calls.length,0)}
});
test('re-renders coalesce, all sessions share one active Host refresh and provider cooldown',async()=>{
 const h=harness(),a=directory(),b=directory();for(let i=0;i<50;i++)h.queue.schedule(a);h.queue.schedule(b);assert.equal(h.timers.size,2);
 let release;a.load=force=>{a.calls.push(force);return new Promise(resolve=>{release=resolve})};h.run();await tick();assert.deepEqual(a.calls,[true]);assert.deepEqual(b.calls,[]);
 release();await tick();h.queue.schedule(b);h.run();await tick();assert.deepEqual(b.calls,[]);
 h.advance(300_000);h.queue.schedule(b);h.run();await tick();assert.deepEqual(b.calls,[true]);
});
test('selection, recovery freshness, child addressing and disposal cancel a queued background check',async()=>{
 for(const mutate of [d=>d.state.status='selecting',d=>d.state.groups[0].models[0].reasoningCapability.stale=false,d=>d.state.current={provider:'other',model:'m'},d=>d.available=()=>false,d=>d.disposed=true]){const h=harness(),d=directory();h.queue.schedule(d);mutate(d);h.run();await tick();assert.deepEqual(d.calls,[])}
 const h=harness(),d=directory();h.queue.schedule(d);h.queue.cancel(d);h.run();await tick();assert.equal(h.timers.size,0);assert.deepEqual(d.calls,[]);
});
test('failed checks back off without loops; another provider can still check',async()=>{
 const h=harness(),d=directory();d.load=async force=>{d.calls.push(force);throw Error('offline')};h.queue.schedule(d);h.run();await tick();
 for(let i=0;i<10;i++){h.queue.schedule(d);h.run();await tick()}assert.deepEqual(d.calls,[true]);
 const other=directory('discovery_failed','other');h.queue.schedule(other);h.run();await tick();assert.deepEqual(other.calls,[true]);
 h.advance(300_000);h.queue.schedule(d);h.run();await tick();assert.deepEqual(d.calls,[true,true]);
});
