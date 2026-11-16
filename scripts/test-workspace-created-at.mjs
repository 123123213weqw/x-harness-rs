import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {loadSourceInternals} from './fixtures/load-source-internals.mjs';
import {sourceDeclaration} from './fixtures/source-declaration.mjs';
const root=new URL('..',import.meta.url);
const dist=process.env.UI_TEST_DIST ?? 'ui/dist';
const read=path=>readFileSync(new URL(path,root),'utf8');
const WORKSPACE='@xharness/dsh-client-ui-workspace',RUNTIME='@xharness/dsh-client-runtime';

// The product-owned helper must accept the Host's decimal millisecond string and
// still tolerate ISO-8601, because the shipped wire format is milliseconds.
const helper=sourceDeclaration(read('ui/reference/master-a613970/plugins/'+WORKSPACE+'/client.js'),'xhEpochMs');
const xhEpochMs=new Function(`${helper}; return xhEpochMs;`)();
const ms=1789192051593;
assert.equal(xhEpochMs(String(ms)),ms,'decimal millisecond string must parse');
assert.equal(xhEpochMs(ms),ms,'numeric milliseconds must pass through');
assert.equal(xhEpochMs(`  ${ms}  `),ms,'surrounding whitespace is tolerated');
assert.equal(xhEpochMs('2026-09-12T04:42:19.123Z'),Date.parse('2026-09-12T04:42:19.123Z'),'ISO-8601 must still parse');
for(const bad of ['',undefined,null,'not-a-date','1e3',{},'99999999999999999999'])
  assert.ok(Number.isNaN(xhEpochMs(bad)),`${JSON.stringify(bad)} must not parse as a timestamp`);
assert.equal(xhEpochMs('0'),0);
// The ISO branch deliberately inherits `Date.parse` leniency (it accepts loose
// date-like text such as "12.5"); only the decimal-millisecond branch is strict.
assert.equal(xhEpochMs('12.5'),Date.parse('12.5'),'ISO branch delegates to Date.parse');
// A last sanity check on the exact defect: the old expression yields NaN.
assert.ok(Number.isNaN(Date.parse(String(ms))),'regression guard: raw Date.parse of the wire value is NaN');

// Native shipped source must retain the independent frozen parser, grouping,
// hover rendering and runtime recency behavior.
for(const id of [WORKSPACE,RUNTIME]){
  const bytes=readFileSync(new URL(`${dist}/plugins/${id}/client.js`,root));
  const text=bytes.toString();
  new Script(text);
  if(!text.startsWith('// Generated from src/modules/')){
    assert.ok(text.includes('function xhEpochMs(value)'),`${id} must carry the parser`);
    assert.equal(text.includes('Date.parse(workspace.createdAt)'),false);
    continue;
  }
  const values=[String(ms),ms,`  ${ms}  `,'2026-09-12T04:42:19.123Z','0','12.5','',undefined,null,'not-a-date',{},'99999999999999999999'];
  const jsx=(type,props,key)=>({type,props,key});
  const external=name=>{
    if(name==='react')return {useState:value=>[value,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useRef:value=>({current:value}),useEffect:()=>{}};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};
    if(name==='@xharness/cordis')return {Context:class{},Service:class{}};
    if(name==='@xharness/dsh-client-ui-slots')return {SlotOwnershipError:class extends Error{},StaleAuthorizationError:class extends Error{}};
    if(name==='@xharness/dsh-client-ui-primitives')return new Proxy({},{get:(_target,key)=>String(key)});
    if(name==='@xharness/dsh-client-runtime/client')return {defineStore:spec=>({spec}),indexSubagentDescendants:()=>new Map()};
    throw Error(`unexpected timestamp-test external ${name}`);
  };
  const loaded=loadSourceInternals(id,external,{console,Error,Date,URL,AbortController,setTimeout,clearTimeout});
  if(id===WORKSPACE){
    const native=loaded.internal('src/modules/workspace/timestamp.js').xhEpochMs;
    const rows=loaded.internal('src/modules/workspace/rows/Rows.js');
    for(const value of values)assert.equal(native(value),xhEpochMs(value),'native source parser retains golden behavior');
    const t=(key,args)=>key==='date.ymd'?`${args.y}-${args.m}-${args.d}`:key==='hover.created'?args.time:key;
    assert.equal(rows.createdLabel(ms,t),rows.createdLabel(Number(ms),t));
    assert.ok(!rows.createdLabel(ms,t).includes('NaN'));
    assert.equal(rows.createdLabel(Number.NaN,t),undefined);
    const invalid=rows.WorkspaceHoverContent({label:'Title',cwd:'/workspace',createdAt:Number.NaN,t});
    assert.equal(invalid.props.children[2],null,'native invalid timestamp omits the whole hover time row');
    const tree=loaded.internal('src/modules/workspace/tree.js');
    const list={ids:[],byId:{},current:undefined,phase:'ready'};
    const workspaces=[{workspaceId:'native',path:'/native',title:'Native',sessionIds:[],createdAt:String(ms),updatedAt:String(ms)}];
    assert.equal(tree.deriveGroups(list,workspaces,[],{expandedGroups:[]})[0].createdAt,ms,'native grouping accepts Host milliseconds');
  }else{
    const native=loaded.internal('src/modules/client-runtime/workspaces/epoch.js').workspaceEpochMs;
    for(const value of values)assert.equal(native(value),xhEpochMs(value),'runtime parser retains golden behavior');
    const {WorkspaceRuntime}=loaded.internal('src/modules/client-runtime/workspaces/service.js');
    const runtime=Object.create(WorkspaceRuntime.prototype);let result;
    const items=[{workspaceId:'old',path:'/old',title:'Old',sessionIds:[],createdAt:'1000',updatedAt:'1000'},{workspaceId:'new',path:'/new',title:'New',sessionIds:[],createdAt:'2000',updatedAt:'2000'}];
    runtime.manager={getSnapshot:()=>({items,archivedSessionIds:[],state:'idle',phase:'ready',error:null})};
    runtime.sessions={list:{getSnapshot:()=>({phase:'ready',byId:{},current:undefined})}};
    runtime.list={set:value=>{result=value}};
    runtime.project();assert.equal(result.recentWorkspaceId,'new','native source runtime recency uses decimal-ms fallback');
    items[0].createdAt='2026-09-12T04:42:19.123Z';runtime.project();assert.equal(result.recentWorkspaceId,'old','native source runtime still supports ISO fallback');
  }
}
const graph=JSON.parse(read(`${dist}/client-graph.json`));
for(const id of [WORKSPACE,RUNTIME]){
  const bytes=readFileSync(new URL(`${dist}/plugins/${id}/client.js`,root));
  const entry=graph.entries.find(candidate=>candidate.id===id);
  assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16),`${id} revision must match shipped bytes`);
  assert.ok(read(`${dist}/index.html`).includes(entry.url),`${id} boot graph must carry the refreshed revision`);
}
console.log('Workspace timestamps: frozen/native millisecond+ISO parsing, grouping, hover, recency and shipped graph/hash passed');
