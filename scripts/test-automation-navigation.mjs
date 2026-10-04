import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
const {buildSync}=require('esbuild')
const compiled=buildSync({entryPoints:[new URL('../ui/src/modules/schedule/automation-data.ts',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
function api(fetch=async()=>{throw Error('Unexpected request')}){const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports,fetch,AbortController,Error,Date,JSON,Number,Array,Set});return module.exports}
const plain=value=>JSON.parse(JSON.stringify(value))
const record=(id,extra={})=>({id,prompt:`Run ${id}`,scheduledAt:'2026-10-04T12:00:00Z',kind:'at',...extra})
const session=(sessionId,schedules,extra={})=>({sessionId,projections:{values:{title:`Chat ${sessionId}`,schedules}},...extra})
test('automation: hydrated empty and unknown catalog are distinct',()=>{const a=api();assert.deepEqual(plain(a.automationCatalog({items:[]})),{entries:[],incompleteSessions:0});assert.equal(a.automationCatalog({items:[session('a',[])]}).incompleteSessions,0);assert.equal(a.automationCatalog({items:[{sessionId:'a'}]}).incompleteSessions,1);for(const value of [null,{},[],{items:'bad'}])assert.throws(()=>a.automationCatalog(value),/Invalid session list/)})
test('automation: exact schedule projection, sorting and per-chat identity',()=>{const a=api();const value=a.automationCatalog({items:[session('a',[record('x'),record('x')]),session('b',[record('x',{scheduledAt:'2026-10-03T12:00:00Z',kind:'every',everySeconds:60})])]});assert.equal(value.entries.length,2);assert.deepEqual(plain(value.entries.map(row=>row.sessionId)),['b','a']);assert.equal(value.entries[0].record.everySeconds,60);assert.equal(value.entries[0].sessionTitle,'Chat b');assert.equal(value.incompleteSessions,0)})
test('automation: malformed rows cannot become fabricated records or falsely empty data',()=>{const a=api();const bad=[null,record('x',{scheduledAt:'not-a-date'}),record('x',{kind:'cron'}),record('x',{prompt:123}),record(123)];const value=a.automationCatalog({items:[session('a',bad),null,{sessionId:123}]});assert.equal(value.entries.length,0);assert.equal(value.incompleteSessions,3)})
test('automation: malformed repeat intervals remain visible but explicitly incomplete',()=>{const a=api();for(const interval of [undefined,'60',0,-1,Infinity,NaN]){const value=a.automationCatalog({items:[session('a',[record('x',{kind:'every',everySeconds:interval})])]});assert.equal(value.entries.length,1);assert.equal(value.entries[0].record.everySeconds,undefined);assert.equal(value.incompleteSessions,1)}})
test('automation: additional provider fields ignored, missing title falls back without reading bodies',()=>{const a=api();const value=a.automationCatalog({items:[session('a',[record('x',{secret:'omit'})],{messageBody:'DO NOT READ',projections:{values:{title:'',schedules:[record('x',{secret:'omit'})]}}})]});assert.equal(value.entries[0].sessionTitle,'a');assert.equal(value.entries[0].record.secret,undefined);assert.equal(value.entries[0].messageBody,undefined)})
test('automation: projection codec has no transport or request id authority',()=>{
  const code=readFileSync(new URL('../ui/src/modules/schedule/automation-data.ts',import.meta.url),'utf8')
  assert.ok(!code.includes('fetch('));assert.ok(!code.includes('/api/'));assert.ok(!code.includes('rpcId'))
  const view=readFileSync(new URL('../ui/src/modules/schedule/AutomationNavigation.tsx',import.meta.url),'utf8')
  assert.match(view,/useSyncExternalStore\(service.subscribe, service.getSnapshot\)/)
  assert.match(view,/service.refresh\(controller.signal\)/)
})
test('automation: approved clock geometry is exact and legacy Tasks footer registration removed',()=>{const svg=readFileSync(new URL('../ui/src/assets/navigation/automation.svg',import.meta.url),'utf8'),component=readFileSync(new URL('../ui/src/modules/workspace/WorkspaceBrowser.tsx',import.meta.url),'utf8');const paths=source=>[...source.matchAll(/<path d="([^"]+)"/g)].map(row=>row[1]).filter(path=>path.startsWith("M20 12")||path.startsWith("M14.4")||path.startsWith("M12 7.5"));assert.deepEqual(paths(component),paths(svg));assert.match(component,/strokeWidth="1\.5"/);const tasks=readFileSync(new URL('../ui/src/modules/tasks/index.tsx',import.meta.url),'utf8');assert.ok(!tasks.includes("'sidebar.footer.action'"));assert.ok(tasks.includes("'work.center.tasks'"))})
