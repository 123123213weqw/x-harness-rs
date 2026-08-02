import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../ui/package.json',import.meta.url)),{buildSync}=require('esbuild'),module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:[new URL('../ui/src/modules/code-review/preferences.ts',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,{module,exports:module.exports,Set,Map})
const {ReviewPreferences,repositoryGroups,validRepository}=module.exports,plain=value=>JSON.parse(JSON.stringify(value))
function disk(initial){let raw=initial;return {read:async()=>raw,write:async value=>{raw=value},peek:()=>raw}}
test('repository choices validate full owner/name without unsafe path or oversized fields',()=>{
 for(const name of ['alice/repo.name-1','org_name/demo'])assert.equal(validRepository(name),true)
 for(const name of ['',null,3,'a','a/b/c','a/..','./b','a/repo?x=1','a/hello world',`a/${'x'.repeat(101)}`])assert.equal(validRepository(name),false)
})
test('search matches owner or repository; recent choices are deduplicated and intersect loaded data',()=>{
 const repos=['alice/main','bob/main','alice/extra','alice/main'];assert.deepEqual(plain(repositoryGroups(repos,['bob/main','removed/repo','bob/main'],'')),[{label:'recent',items:['bob/main']},{label:'other',items:['alice/main','alice/extra']}])
 assert.deepEqual(plain(repositoryGroups(repos,['bob/main'],' ALICE ')),[{label:'other',items:['alice/main','alice/extra']}]);assert.deepEqual(plain(repositoryGroups(repos,[],'missing')),[])
})
test('account-verified preferences survive recreation independently from response cache',async()=>{
 const store=disk(),first=new ReviewPreferences(store);await first.activate('alice');first.select('alice','alice/project',true);await first.flush()
 const next=new ReviewPreferences(store);assert.deepEqual(plain(next.current('alice')),{repository:'',mine:false,recent:[]});const restored=await next.activate('alice');assert.equal(restored.repository,'alice/project');assert.equal(restored.mine,true)
 assert.deepEqual(Object.keys(JSON.parse(store.peek())).sort(),['account','mine','recent','repository','version']);assert.ok(!store.peek().includes('token'));assert.ok(!store.peek().includes('body'))
})
test('history is bounded and last selection moves to the front without duplicates',async()=>{
 const p=new ReviewPreferences();await p.activate('alice');for(let n=0;n<20;n++)p.select('alice',`alice/repo-${n}`,n%2===0);p.select('alice','alice/repo-17',false)
 const value=p.current('alice');assert.equal(value.recent.length,6);assert.equal(value.recent[0],'alice/repo-17');assert.equal(new Set(value.recent).size,6);value.recent.push('mutated/not-shared');assert.equal(p.current('alice').recent.length,6)
})
test('changing verified account cannot expose or write another account preferences',async()=>{
 const store=disk(),p=new ReviewPreferences(store);await p.activate('alice');p.select('alice','alice/private-name',true);await p.flush();assert.deepEqual(plain(await p.activate('bob')),{repository:'',mine:false,recent:[]});p.select('alice','alice/other',true);assert.equal(p.current('bob').repository,'')
})
test('corrupt, foreign, coerced or oversized preference snapshots fail closed',async()=>{
 const good={version:1,account:'alice',repository:'alice/project',mine:true,recent:['alice/project']}
 for(const raw of ['broken',JSON.stringify({...good,version:2}),JSON.stringify({...good,account:'bob'}),JSON.stringify({...good,mine:'true'}),JSON.stringify({...good,recent:Array(7).fill('alice/project')}),JSON.stringify({...good,recent:['../private']}),' '.repeat(8193)])assert.deepEqual(plain(await new ReviewPreferences(disk(raw)).activate('alice')),{repository:'',mine:false,recent:[]})
})
test('late disk restoration cannot replace a newer user choice',async()=>{
 let finish;const p=new ReviewPreferences({read:()=>new Promise(resolve=>{finish=resolve}),write:async()=>{}});const reading=p.activate('alice');await Promise.resolve();p.select('alice','alice/new',true);finish(JSON.stringify({version:1,account:'alice',repository:'alice/old',mine:false,recent:[]}));await reading;await p.flush();assert.equal(p.current('alice').repository,'alice/new');assert.equal(p.current('alice').mine,true)
})
test('late old-account restoration cannot undo account switch',async()=>{
 let finish;let first=true;const p=new ReviewPreferences({read:()=>first?(first=false,new Promise(resolve=>{finish=resolve})):Promise.resolve(undefined),write:async()=>{}});const alice=p.activate('alice');await Promise.resolve();const bob=p.activate('bob');finish(JSON.stringify({version:1,account:'alice',repository:'alice/private',mine:true,recent:[]}));await Promise.all([alice,bob]);assert.deepEqual(plain(p.current('bob')),{repository:'',mine:false,recent:[]})
})
test('storage failures are nonfatal and writes retain invocation order',async()=>{
 const p=new ReviewPreferences({read:async()=>{throw Error('blocked')},write:async()=>{throw Error('quota')}});await p.activate('alice');p.select('alice','alice/project',true);await p.flush();assert.equal(p.current('alice').mine,true)
 const writes=[],q=new ReviewPreferences({read:async()=>undefined,write:async raw=>{writes.push(JSON.parse(raw).repository)}});await q.activate('alice');q.select('alice','alice/one',false);q.select('alice','alice/two',true);await q.flush();assert.deepEqual(writes,['alice/one','alice/two'])
})
