// Exercise the shipped execution runtime itself, without a second implementation.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const source=readFileSync(new URL('../apps/desktop/src-tauri/src/browser_evaluate.js',import.meta.url),'utf8')
let next=0
function fixture(){
  const timers=new Set(),nativeLogs=[]
  const context=vm.createContext({TextEncoder,console:Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,(...args)=>nativeLogs.push([k,args])])),
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timers.add(timer);return timer},clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer)},
    document:{title:'fixture',querySelector:()=>({value:'initial'})},fetch:async()=>({status:200,json:async()=>({from:'fetch'})})})
  return {context,nativeLogs,close:()=>{for(const timer of timers)clearTimeout(timer)}}
}
async function execute(f,code,args=null,timeout_ms=250){
  const id=String(++next),options={id,args,timeout_ms}
  const start=JSON.parse(vm.runInContext(`(${source})(${JSON.stringify(options)},async function(args){\n${code}\n})`,f.context))
  assert.equal(start.state,'started')
  const deadline=Date.now()+timeout_ms+1000
  while(Date.now()<deadline){
    const wire=vm.runInContext(`globalThis[Symbol.for('xharness.browser.executions')][${JSON.stringify(id)}].result`,f.context)
    if(wire){assert(Buffer.byteLength(wire)<=7168);return JSON.parse(wire)}
    await new Promise(resolve=>setTimeout(resolve,2))
  }
  throw Error('runtime failed to settle')
}

const f=fixture()
try {
  const original=f.context.console.log
  const r=await execute(f,`document.title=args.title; console.log('proof',args.title); const response=await fetch('/api',{method:'POST'}); return {title:document.title,data:await response.json(),big:42n};`,{title:'真实修改'})
  assert.equal(r.ok,true);assert.equal(r.value.title,'真实修改');assert.equal(r.value.data.from,'fetch');assert.equal(r.value.big.value,'42')
  assert.equal(r.console.length,1);assert.match(r.console[0].text,/proof/);assert.equal(f.nativeLogs.length,1)
  assert.equal(f.context.console.log,original,'console is restored')
  const failed=await execute(f,`globalThis.partial=true; throw new Error('script-error');`)
  assert.equal(failed.ok,false);assert.equal(failed.status,'exception');assert.equal(failed.effect,'unknown');assert.match(failed.error.message,/script-error/)
  assert.equal(f.context.partial,true,'exceptions do not falsely roll back effects')
  const timed=await execute(f,`await new Promise(()=>{});`,null,10)
  assert.equal(timed.status,'timeout');assert.equal(timed.effect,'unknown');assert.equal(f.context.console.log,original)
  const cyclic=await execute(f,`const v={};v.self=v;return {v,none:undefined,n:NaN};`)
  assert.equal(cyclic.value.v.self,'[circular]');assert.equal(cyclic.value.none.type,'undefined');assert.equal(cyclic.value.n,'NaN')
  const unicode=await execute(f,`return {lone:'\\ud800',big:Array(10000).fill('🧪'.repeat(100))};`)
  assert.equal(unicode.ok,true)
  const unicodeWire=JSON.stringify(unicode)
  assert(!/\\ud[89ab][0-9a-f]{2}/i.test(unicodeWire),'Unicode clipping cannot emit lone high-surrogate escapes')
  const big=await execute(f,`for(let i=0;i<100;i++)console.log('🧪'.repeat(10000));return Array(10000).fill('\\u0000'.repeat(1000));`)
  assert.equal(big.ok,true);assert.equal(big.truncated,true);assert(big.console.length<=32)
  const late=await execute(f,`await new Promise(resolve=>setTimeout(resolve,30));globalThis.lateEffect=true;return 'late';`,null,5)
  assert.equal(late.status,'timeout');await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.context.lateEffect,true)
  assert.equal(late.ok,false,'late completion never converts a timeout into success')
  const after=await execute(f,`console.warn('after timeout');return 7;`)
  assert.equal(after.value,7);assert.equal(after.console[0].level,'warn');assert.equal(f.context.console.log,original)
  assert.throws(()=>vm.runInContext(`(${source})({id:'syntax',timeout_ms:5},async function(){ return (\n})`,f.context),/SyntaxError/)
  console.log('browser JavaScript: unrestricted DOM/fetch/await, args, console, exceptions, timeout/late effects, bounded output, cyclic/BigInt/undefined values passed')
} finally {f.close()}
