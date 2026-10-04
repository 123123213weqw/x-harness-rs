/** Pure preview decisions and production registration. Browser interaction is verified through CUA. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
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
test('feature is repository-built and contributes slots; it adds no remote or mutation execution',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../ui/modules.json',import.meta.url),'utf8'))
 const entry=manifest.modules.find(item=>item.id==='@xlang/xharness-client-ui-code-review');assert.equal(entry.source,'src/modules/code-review/index.tsx')
 const source=readFileSync(new URL('../ui/'+entry.source,import.meta.url),'utf8')
 assert.match(source,/slots.inject\('review.center'/);assert.match(source,/slots.inject\('sidebar.footer.action'/)
 for(const prohibited of ['createPluginClient','window.open','iframe','download=','Merge</button>'])assert.ok(!source.includes(prohibited),prohibited)
 assert.ok(!/\bfetch\s*\(/.test(source),'feature must use the Host RPC client, not raw fetch')
 assert.ok(!/\bany\b|\bas\b|dangerouslySetInnerHTML/.test(source))
 assert.match(source,/new GitHubClient/);assert.ok(!source.includes('records,recordKey'));assert.ok(!manifest.assets.some(item=>item.path==='navigation/review-author.png'))
})
test('frame retains conversation identity and borrows rather than overwrites saved panel width',()=>{
 const frame=readFileSync(new URL('../ui/src/modules/layout/AppFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/centerPage === 'review' \|\|/);assert.match(frame,/workspaceOpen=centerPage !== 'review'/)
 assert.match(frame,/hidden=\{centerPage !== 'chat'\}/);assert.match(frame,/renderSlot\('review.center', \{close: closeCenterPage\}\)/)
 assert.ok(!frame.includes('setSidebar(56)'))
 assert.match(frame,/centerPage === 'review'.*closest\('\[data-xharness-review-nav\],\[data-xharness-plugin-nav\],\[data-xharness-work-nav\]'\)/)
 const layout=readFileSync(new URL('../ui/src/modules/layout/index.ts',import.meta.url),'utf8');assert.match(layout,/'review.center': \{ kind: 'single', scope: 'root' \}/)
})
