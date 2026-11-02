/** Pure preview decisions and production registration. Browser interaction is verified through CUA. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {reviewedUiAdditions} from './fixtures/reviewed-ui-additions.mjs'
import {assertProductionSources} from './ui-build-variant.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
const {buildSync}=require('esbuild')
const compile=path=>buildSync({entryPoints:[new URL(path,import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
const module={exports:{}};vm.runInNewContext(compile('./fixtures/code-review-preview.ts'),{module,exports:module.exports})
const {records,filterRecords,recordKey}=module.exports
const plain=value=>JSON.parse(JSON.stringify(value))
test('all sample identities are unique; title search is case insensitive',()=>{
 assert.equal(new Set(records.map(recordKey)).size,records.length)
 assert.equal(filterRecords(records,'  TIMESTAMP ','all').length,1)
 assert.equal(filterRecords(records,'unmatched phrase','all').length,0)
})
test('attention is determined by failed checks; missing checks are not fabricated as passing',()=>{
 const attention=filterRecords(records,'','attention');assert.equal(attention.length,1);assert.equal(attention[0].id,208)
 assert.equal(filterRecords(records,'timestamp','attention').length,0)
 assert.equal(records.find(item=>item.id===203).checks.length,0)
})
test('PR links match full repository identity and exact number',()=>{
 assert.equal(filterRecords(records,'https://github.com/anolisa/zcode/pull/4467/','all').length,1)
 for(const value of ['https://github.com/foreign/repo/pull/4467','https://github.com/anolisa/zcode/pull/44670','http://github.com/anolisa/zcode/pull/4467','https://github.com/anolisa/zcode/pull/4467?other=1','https://github.com/anolisa/zcode/pull/NaN'])assert.equal(filterRecords(records,value,'all').length,0)
})
test('filters preserve source records, order and selected identities',()=>{
 const original=plain(records);const subset=filterRecords(records,'memory','all');assert.equal(subset.length,4);assert.deepEqual(plain(records),original);assert.equal(subset[0],records[4])
})
test('retired feature is absent from product registry and cannot return through source assembly',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../ui/modules.json',import.meta.url),'utf8'))
 assert.ok(!manifest.modules.some(item=>item.id==='@xlang/xharness-client-ui-code-review'||item.source.startsWith('src/modules/code-review/')))
 assert.ok(!reviewedUiAdditions().some(item=>item.id==='@xlang/xharness-client-ui-code-review'))
 for(const source of ['src/modules/code-review/index.tsx','src/modules/code-review/ReviewPanel.tsx','src/modules/code-review/cache.ts']){
  assert.throws(()=>assertProductionSources([source]),/Retired Code Review/)
 }
 assert.doesNotThrow(()=>assertProductionSources(['src/modules/assistant/index.tsx','src/modules/assistant/pull-reference.ts','src/modules/browser/file-display/diff.ts']))
 assert.throws(()=>compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'retired',source:'src/modules/code-review/index.tsx'}]),/Retired Code Review/)
 const graph=JSON.parse(readFileSync('ui/dist/client-graph.json','utf8'))
 assert.ok(!graph.entries.some(row=>row.id==='@xlang/xharness-client-ui-code-review'))
 const receipt=JSON.parse(readFileSync('ui/dist/.xharness-ui-output.json','utf8'))
 for(const rows of Object.values(receipt.moduleSources))assert.ok(rows.every(source=>!source.startsWith('src/modules/code-review/')))
})
test('frame retains a single conversation, saved geometry and no retired center slot',()=>{
 const frame=readFileSync('ui/src/modules/layout/AppFrame.tsx','utf8'),layout=readFileSync('ui/src/modules/layout/index.ts','utf8')
 for(const source of [frame,layout])assert.ok(!source.includes('review.center'))
 assert.ok(!frame.includes("centerPage === 'review'"));assert.ok(!frame.includes("centerPage !== 'review'"))
 assert.equal((frame.match(/renderSlot\('conversation', \{\}\)/g)??[]).length,1)
 assert.match(frame,/showConversation:setAssistantVisible/);assert.match(frame,/showConversation:setSwarmVisible/)
 assert.ok(!frame.includes('setSidebar(56)'));assert.ok(!frame.includes('data-xharness-review-nav'))
})
test('native composition no longer wires review storage; tombstone precedes generic GitHub access',()=>{
 const native=readFileSync('crates/xharness-host-app/src/main.rs','utf8'),rpc=readFileSync('crates/xharness-host/src/rpc.rs','utf8'),host=readFileSync('crates/xharness-host/src/lib.rs','utf8')
 assert.ok(!native.includes('with_review_directory'));assert.ok(!host.includes('review_work'))
 assert.ok(rpc.indexOf('github/review-')<rpc.indexOf('if endpoint.starts_with("github/")'))
 assert.ok(rpc.includes('crate::github_review::retired()'))
 assert.ok(native.includes('args.bind.ip().is_loopback()'),'keep credential exposure protection')
})
