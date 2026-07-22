// Keep patch positive/negative/idempotence golden on immutable master only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext, createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { verifyArtifact } from './fixtures/shipped-source-values.mjs';
import { exposeModuleUnit } from './fixtures/module-unit-scope.mjs';
import { createHash } from 'node:crypto';
import { patchTranscriptRowState } from './patch-transcript-row-state.mjs';
const graph=JSON.parse(readFileSync(new URL('../ui/reference/master-a613970/client-graph.json',import.meta.url)));
const index=readFileSync(new URL('../ui/reference/master-a613970/index.html',import.meta.url),'utf8');
for(const id of ['@xharness/dsh-client-ui-conversation','@xharness/dsh-client-ui-tool','@xharness/dsh-client-ui-cordis','@xlang/xharness-client-ui-computer']) {
 const source=readFileSync(new URL('../ui/reference/master-a613970/plugins/'+id+'/client.js',import.meta.url));
 new Script(source.toString());
 assert.deepEqual(patchTranscriptRowState(id,source),source,'state patch idempotence '+id);
 assert.equal(source.toString().split('// xh-transcript-row-state/v1').length,2,'single state bridge '+id);
 assert.throws(()=>patchTranscriptRowState(id,Buffer.from('unknown source')),/anchor changed/,'unknown shapes fail closed');
 const entry=graph.entries.find(e=>e.id===id);
 assert.equal(entry.rev,createHash('sha256').update(source).digest('hex').slice(0,16));
 assert.ok(index.includes(entry.url),'boot graph updated');
}
assert.deepEqual(patchTranscriptRowState('@xlang/unrelated',Buffer.from('unchanged')),Buffer.from('unchanged'));
const tool=readFileSync(new URL('../ui/reference/master-a613970/plugins/@xharness/dsh-client-ui-tool/client.js',import.meta.url),'utf8');
assert.equal(tool.split('stateKey: block.callId,').length,8,'every built-in tool view has a stable call key');
assert.match(tool,/xhUseTranscriptState\("tool:" \+ stateKey, false\)/);
assert.match(tool,/if \(appliedMode === processMode\) return/);
const cordisId='@xharness/dsh-client-ui-cordis';
const cordis=readFileSync(new URL('../ui/reference/master-a613970/plugins/'+cordisId+'/client.js',import.meta.url));
for(const key of ['cordis-expanded','cordis-source']) {
 assert.ok(cordis.toString().includes(`xhUseTranscriptState("${key}:" + callId,`),'Cordis call-scoped '+key);
 const legacy=Buffer.from(cordis.toString().replaceAll('"cordis-expanded:" + callId','"cordis-expanded"').replaceAll('"cordis-source:" + callId','"cordis-source"'));
 assert.deepEqual(patchTranscriptRowState(cordisId,legacy),cordis,'legacy assembled Cordis keys upgrade');
 assert.throws(()=>patchTranscriptRowState(cordisId,Buffer.from(cordis.toString().replace(`"${key}:" + callId`,'"unknown-shape"'))),/anchor changed/,'unknown Cordis keys fail closed');
}
const cleanCordis=Buffer.from(cordis.toString()
 .replace(/\n\/\/ xh-transcript-row-state\/v1\nfunction xhUseTranscriptState\(key, initial\) \{[\s\S]*?\n\}\n/,'')
 .replace('xhUseTranscriptState("cordis-expanded:" + callId, false)','(0, react.useState)(false)')
 .replace('xhUseTranscriptState("cordis-source:" + callId, card.clientCode !== null ? "client" : "host")','(0, react.useState)(card.clientCode !== null ? "client" : "host")'));
assert.deepEqual(patchTranscriptRowState(cordisId,cleanCordis),cordis,'clean-source Cordis assembly matches upgraded bundle');
const helper=readFileSync(new URL('../ui/overrides/transcript-windowing.js',import.meta.url),'utf8');
assert.ok(!helper.includes('row.pinned'),'no permanent interaction pins');
assert.match(helper,/mounted: keepMounted/,'no full initial mount');
assert.match(helper,/WeakMap/,'root lifetime is weakly scoped');
console.log('transcript row state: four registrants, call identities, patch/hash consistency and bounded lifetime passed');

const pending = runInNewContext(helper + ';xhTranscriptHasPendingTool');
assert.equal(pending({kind:'assistant',data:{}}),false);
assert.equal(pending({kind:'tool-call',data:{root:{callId:'live',subCalls:[]}}}),true);
assert.equal(pending({kind:'tool-call',data:{root:{kind:'result',callId:'done',subCalls:[]}}}),false);
assert.equal(pending({kind:'tool-call',data:{root:{kind:'result',subCalls:[{callId:'nested',subCalls:[]}]}}}),true);

// Native source acceptance uses the actual CJS factory's lexical unit graph,
// not a copied override hook. React and its server lifecycle are real locked
// 18.3.1; only pure seats and the real DOM-only Computer row are rendered here.
const require = createRequire(new URL('../ui/package.json', import.meta.url));
const ts = require('typescript'), React = require('react'), Server = require('react-dom/server');
assert.equal(React.version, '18.3.1');
const nativeIds = {
 conversation:'@xharness/dsh-client-ui-conversation', tool:'@xharness/dsh-client-ui-tool',
 cordis:'@xharness/dsh-client-ui-cordis', computer:'@xlang/xharness-client-ui-computer',
};
const native = Object.fromEntries(Object.entries(nativeIds).map(([name,id]) => [name, verifyArtifact(id)]));
function unitBody(source, path) {
 const ast=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),bodies=[];
 function visit(node){if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&node.name.text===path&&ts.isFunctionExpression(node.initializer))bodies.push(node.initializer.body);ts.forEachChild(node,visit)}
 visit(ast);assert.equal(bodies.length,1,'one exact lexical unit '+path);return {ast,body:bodies[0]};
}
function countNodes(body, predicate) {let count=0;function visit(node){if(predicate(node))count++;ts.forEachChild(node,visit)}visit(body);return count}
const context = createContext({console,React,Map,Set,WeakMap,WeakSet,Date,Symbol,Promise,Uint8Array,ArrayBuffer,TextDecoder,TextEncoder,queueMicrotask,setTimeout,clearTimeout,window:{__ModuleLoader__:{load:registration=>{context.registration=registration}}}});
function actualUnit(module, unit, name) {
 const code=native[module],path=`src/modules/${module}/${unit}.js`;
 unitBody(code,path);
 // If private, the standard AST seam adds only a test assignment to the real
 // owning closure. Point the test factory at that unit rather than loading
 // unrelated business/UI imports; all consumed imports still use __load.
 let exposed=exposeModuleUnit(code,module,unit,name);
 const returned=`return Object.assign({},__load("src/modules/${module}/index.js"),{${name}:__load(${JSON.stringify(path)})[${JSON.stringify(name)}]});`;
 assert.ok(exposed.includes(returned),'actual unit seam return');
 exposed=exposed.replace(returned,`return __load(${JSON.stringify(path)});`);
 runInContext(exposed,context);
 const api=context.registration.factory(id=>{if(id==='react')return React;if(id==='react/jsx-runtime')return require('react/jsx-runtime');throw Error('Unexpected native row dependency '+id)});
 assert.equal(typeof api[name],'function','actual member '+name);return api;
}
const stateApi=actualUnit('conversation','chat/transcript-state','transcriptStateFor');
const bridge=stateApi.transcriptState;
assert.equal(bridge,stateApi.transcriptStateFor({...React}),'namespace wrappers share createElement, not namespace object identity');
assert.equal(context.__xhTranscriptState.get(React.createElement),bridge);
const toolSeat=actualUnit('tool','transcript-state','useTranscriptState').useTranscriptState;
const cordisSeat=actualUnit('cordis','transcript-state','useTranscriptState').useTranscriptState;
function renderSeat(hook, store, key, initial) {
 let seat;
 function Probe(){seat=hook(key,initial);return React.createElement('span',null,String(seat[0]))}
 Server.renderToStaticMarkup(React.createElement(bridge.Context.Provider,{value:store},React.createElement(Probe)));
 return seat;
}
for(const [name,hook]of [['tool',toolSeat],['cordis-expanded',cordisSeat],['reasoning',stateApi.useTranscriptState]]) {
 const values=new Map(),otherRow=new Map();
 const first=renderSeat(hook,values,name+':alpha',false);assert.equal(first[0],false);
 first[1](value=>!value);assert.equal(values.get(name+':alpha'),true,'real setter persists to row-owned map');
 assert.equal(renderSeat(hook,values,name+':alpha',false)[0],true,'fresh mounted hook restores persisted call alpha');
 assert.equal(renderSeat(hook,values,name+':beta',false)[0],false,'call beta remains independent');
 assert.equal(renderSeat(hook,otherRow,name+':alpha',false)[0],false,'row/session map isolates same call key');
 first[1](value=>!value);first[1](value=>!value);assert.equal(values.get(name+':alpha'),true,'functional setters accumulate through current ref');
}
const modes=new Map(),sourceSeat=renderSeat(cordisSeat,modes,'cordis-source:alpha','client');sourceSeat[1]('host');
assert.equal(renderSeat(cordisSeat,modes,'cordis-source:alpha','client')[0],'host');
assert.equal(renderSeat(cordisSeat,modes,'cordis-source:beta','client')[0],'client');
const applied=renderSeat(toolSeat,modes,'tool-mode:alpha',null);applied[1]('detailed');
assert.equal(renderSeat(toolSeat,modes,'tool-mode:alpha',null)[0],'detailed','process-mode application survives remount');
for(const hook of [toolSeat,cordisSeat]) {
 const registry=context.__xhTranscriptState;context.__xhTranscriptState=undefined;
 assert.equal(renderSeat(hook,new Map(),'standalone',false)[0],false,'standalone original local-state fallback');
 context.__xhTranscriptState=registry;
}
const nativeTool=unitBody(native.tool,'src/modules/tool/tool/components/ToolRow.js');
assert.match(nativeTool.body.getText(nativeTool.ast),/if \(appliedMode === processMode\)\s*return/,'real Tool consumer does not reapply same process mode');
let keyedViews=0;
for(const path of ['web-row','GenericToolCard','read-row','todo-row','file-mutation-row','search-row','ask-question-row']){
 const {body}=unitBody(native.tool,`src/modules/tool/tool/toolviews/${path}.js`);
 keyedViews+=countNodes(body,node=>ts.isPropertyAssignment(node)&&node.name.getText()==='stateKey'&&node.initializer.getText()==='block.callId');
}
assert.equal(keyedViews,7,'all seven actual Tool registrants forward the stable call identity');
const nativeCordis=unitBody(native.cordis,'src/modules/cordis/CordisDefineRow.js');
for(const key of ['cordis-expanded','cordis-source'])assert.equal(countNodes(nativeCordis.body,node=>ts.isCallExpression(node)&&node.expression.getText().includes('useTranscriptState')&&ts.isBinaryExpression(node.arguments[0])&&ts.isStringLiteral(node.arguments[0].left)&&node.arguments[0].left.text===key+':'&&node.arguments[0].operatorToken.kind===ts.SyntaxKind.PlusToken&&node.arguments[0].right.getText()==='callId'),1,'actual Cordis consumer call-scoped '+key);
const windowUnit=unitBody(native.conversation,'src/modules/conversation/chat/TranscriptWindowRow.js');
assert.ok(!windowUnit.body.getText(windowUnit.ast).includes('row.pinned'),'native has no permanent interaction pins');
assert.equal(countNodes(windowUnit.body,node=>ts.isPropertyAssignment(node)&&node.name.getText()==='mounted'&&node.initializer.getText()==='keepMounted'),1,'native first commit mounts only explicit keep seats');
assert.equal(countNodes(windowUnit.body,node=>ts.isVariableDeclaration(node)&&node.name.getText()==='roots'&&node.initializer&&ts.isNewExpression(node.initializer)&&node.initializer.expression.getText()==='WeakMap'),1,'native root lifetime is weakly scoped');
const computerApi=actualUnit('computer','index','ComputerRow'), computerValues=new Map([['computer:alpha',true],['computer:beta',false]]);
function renderComputer(callId,values=computerValues){return Server.renderToStaticMarkup(React.createElement(bridge.Context.Provider,{value:values},React.createElement(computerApi.ComputerRow,{callId,block:{kind:'tool-result',call:{argsRaw:'{"action":"observe"}'},content:[]},t:key=>key})))}
assert.match(renderComputer('alpha'),/aria-expanded="true"/,'actual Computer row restores its call-owned expanded state');
assert.match(renderComputer('beta'),/aria-expanded="false"/,'Computer sibling call does not inherit alpha');
assert.match(renderComputer('alpha'),/aria-expanded="true"/,'fresh Computer mount restores again');
assert.match(renderComputer('alpha',new Map()),/aria-expanded="false"/,'Computer row/session lifetime isolates state');
const nativePending=actualUnit('conversation','chat/pending-tool','transcriptHasPendingTool').transcriptHasPendingTool;
const running={callId:'live',callView:null,time:1,name:'computer',argsRaw:'{}',turn:0,step:0,subCalls:[]};
const result={kind:'tool-result',seq:1,time:2,callId:'done',callView:null,call:null,callTime:null,content:[],isError:false,resultView:null,subCalls:[]};
assert.equal(nativePending({kind:'assistant',data:{}}),false);
assert.equal(nativePending({kind:'tool-call',data:{root:running}}),true);
assert.equal(nativePending({kind:'tool-call',data:{root:result}}),false);
assert.equal(nativePending({kind:'tool-call',data:{root:{...result,subCalls:[running]}}}),true);
assert.equal(nativePending({kind:'tool-call',data:{root:{callId:'malformed',subCalls:[]}}}),false,'unknown malformed carrier is not promoted to a known pending Tool');
console.log('native transcript row state: exact fresh factories, actual React seats/functional setters/remounts, independent calls/sessions, seven Tool identities/mode guard, Cordis source tab, Computer retained expansion, weak bounded window and consumed pending DTO guards passed');
