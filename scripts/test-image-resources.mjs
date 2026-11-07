import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
let registration,seq=0;const created=[],revoked=[]
vm.runInNewContext(compileSourceModules('ui',[{id:'raster-policy',source:'src/modules/platform/primitives/image-resources.ts'}]).get('raster-policy').bytes.toString(),{window:{__ModuleLoader__:{load:r=>registration=r}},URL:{createObjectURL:blob=>{created.push(blob);return 'blob:diag-'+(++seq)},revokeObjectURL:url=>revoked.push(url)},DOMException,Promise,Date})
const {DecodedImageBudget,ImageUrlPool,ThumbnailQueue}=registration.factory(()=>{throw Error('unexpected import')})
test('retained raster reuse holds decoded charge, owner close revokes exactly once',()=>{
 const budget=new DecodedImageBudget(64),pool=new ImageUrlPool(budget,100,3),owner=Symbol(),blob={size:10}
 const a=pool.acquire(owner,blob,2,2);assert.ok(a);a.release();a.release();assert.equal(budget.bytes,16)
 const b=pool.acquire(owner,blob,2,2);assert.equal(a.url,b.url);assert.equal(budget.bytes,16)
 pool.dispose(owner);b.release();pool.dispose(owner);assert.equal(budget.bytes,0);assert.equal(revoked.filter(url=>url===a.url).length,1)
})
test('shared consumer pressure evicts inactive raster before denying an original',()=>{
 const budget=new DecodedImageBudget(64),pool=new ImageUrlPool(budget),owner=Symbol(),a=pool.acquire(owner,{size:1},2,2);a.release()
 const original=budget.reserve(4,4);assert.ok(original);assert.equal(pool.size,0);assert.equal(budget.bytes,64);original.release();assert.equal(budget.bytes,0)
})
test('visible resources cannot be evicted, cache bounds and invalid dimensions fail closed',()=>{
 const budget=new DecodedImageBudget(64),pool=new ImageUrlPool(budget,10,1),owner=Symbol(),a=pool.acquire(owner,{size:10},2,2)
 assert.equal(pool.acquire(Symbol(),{size:1},1,1),undefined);assert.equal(pool.acquire(Symbol(),{size:11},1,1),undefined)
 assert.equal(budget.reserve(0,1),undefined);assert.equal(budget.reserve(1.5,1),undefined);assert.equal(budget.reserve(Number.MAX_SAFE_INTEGER,2),undefined)
 pool.evictInactive();assert.equal(pool.size,1);a.release();const b=pool.acquire(Symbol(),{size:1},1,1);assert.ok(b);assert.equal(pool.size,1);assert.equal(budget.bytes,4);b.release();pool.evictInactive();assert.equal(budget.bytes,0)
})
test('pending cancellation removes queued read, active read keeps slot until actual completion',async()=>{
 const queue=new ThumbnailQueue(),first=new AbortController(),second=new AbortController(),calls=[];let finish
 const a=queue.run(()=>new Promise(resolve=>{calls.push(1);finish=resolve}),first.signal)
 const b=queue.run(()=>{calls.push(2)},second.signal);const rejected=assert.rejects(b,/Aborted/);second.abort();await Promise.resolve();first.abort()
 const c=queue.run(()=>{calls.push(3);return 3},new AbortController().signal);await Promise.resolve();assert.deepEqual(calls,[1]);finish(1);await a;await rejected;assert.equal(await c,3);assert.deepEqual(calls,[1,3])
})

test('an explicit original or visible workspace read does not wait behind a gallery backlog',async()=>{
 const queue=new ThumbnailQueue(),calls=[];let finish
 const a=queue.run(()=>new Promise(resolve=>{calls.push('active');finish=resolve}),new AbortController().signal)
 const b=queue.run(()=>{calls.push('thumbnail');return Promise.resolve()},new AbortController().signal)
 const c=queue.run(()=>{calls.push('original');return Promise.resolve()},new AbortController().signal,true)
 await Promise.resolve();finish();await Promise.all([a,b,c]);assert.deepEqual(calls,['active','original','thumbnail'])
})
