import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs';
import {conversationFixture} from './fixtures/conversation-source-fixture.mjs';
import {patchCompactionProgress} from './patch-compaction-progress.mjs';
import {patchCompactionViewModel} from './patch-compaction-view-model.mjs';
const source=verifyConversationArtifact(),golden=legacyConversation().toString();
const helper=readFileSync(new URL('../ui/overrides/compaction-progress.js',import.meta.url),'utf8');
assert.ok(golden.includes(helper),'maintained helper equals shipped code');
assert.doesNotMatch(helper,/setInterval|useEffect|xhCompactSweep|role:'progressbar'|XhCompactionMetrics/,'minimal status has no timer, percentage, bar or counts');
assert.ok(source.includes('May take a few minutes') && source.includes('可能需要几分钟'),'both status locales ship');
for(const [implementation,bytes] of [['native',source],['golden',golden]]) {
const api=conversationFixture(bytes,['compactionDefinition','commandDefinition','compactProgress']).api;
const wrap=definition=>({...definition,buildViewNode:context=>definition.buildViewNode({key:'compaction:c',id:'c',matches:[],locations:[],target:'chat',...context})});
const def=wrap(api.compactionDefinition),manual=wrap(api.commandDefinition),xhCompactProgress=api.compactProgress;
const event=(type,seq,data)=>({event:{type,seq,time:1000+seq*1000,data}});
const progress={stage:'retrying',calls:3,completedParts:1,splits:1,retries:2,delayMs:5000,inputTokensBefore:180000};
const start=event('compaction/start',10,{compactionId:'c',turn:0});
const update=event('compaction/progress',11,{compactionId:'c',turn:0,progress});
const endFailure=event('compaction/end',12,{compactionId:'c',turn:0,error:'fixture failed'});
let state={};for(const m of [start,update]) state=def.update({state},m);
let node=def.buildViewNode({state});
assert.equal(node.data.status,'running');assert.deepEqual(node.data.progress,progress);
assert.equal(node.anchorSeq,10);assert.equal(node.data.progressTime,12000);
assert.deepEqual(def.buildViewNode({matches:[start,update]}),node,'cold replay equals live');
state=def.update({state},endFailure);node=def.buildViewNode({state});
assert.equal(node.visibility,'visible');assert.equal(node.data.status,'failed');assert.equal(node.data.error,'fixture failed');
assert.equal(node.data.endedAt,13000);
assert.deepEqual(def.buildViewNode({matches:[start,update,endFailure]}),node);
const snapshot=event('compaction/progress',11,update.event.data);
snapshot.view={for:'compaction',view:{schemaVersion:1,id:'c',phase:'running',anchorSeq:10,time:11000,progress,progressTime:12000}};
assert.equal(def.match(snapshot.event,snapshot.view).role,'update');
assert.deepEqual(def.buildViewNode({matches:[snapshot]}).data.progress,progress,'progress-only projected page is self-contained');
assert.equal(def.buildViewNode({matches:[snapshot]}).anchorSeq,10);
for(const malformed of [{}, {...progress,calls:-1}, {...progress,completedParts:4}, {...progress,delayMs:'5'}, {...progress,stage:'fake-99-percent'}]) assert.equal(xhCompactProgress(malformed),undefined);
// Real manual contribution uses the same progress card instead of a new tool/registry.
const run=event('command/run',9,{commandId:'cmd',name:'compact',args:''});
const ms=event('compaction/start',10,{compactionId:'manual',sourceCommandId:'cmd',turn:0});
const mp=event('compaction/progress',11,{compactionId:'manual',sourceCommandId:'cmd',turn:0,progress});
let mstate=manual.start({},run);mstate=manual.update({state:mstate},ms);mstate=manual.update({state:mstate},mp);
const liveManual=manual.buildViewNode({state:mstate});
assert.equal(liveManual.data.compaction.status,'running');assert.equal(liveManual.data.command.name,'compact');
assert.deepEqual(manual.buildViewNode({matches:[run,ms,mp]}),liveManual,'manual cold/live progress match');
assert.deepEqual(patchCompactionProgress(Buffer.from(golden)),Buffer.from(golden));
assert.throws(()=>patchCompactionProgress(Buffer.from('upstream changed')),/anchor changed/);
console.log('compaction progress: stage/count validation, manual/auto live/reload, progress-only page, explicit failure, maintained source and idempotence passed');

const pageManual={...snapshot,view:{for:'compaction',view:{...snapshot.view.view,sourceCommandId:'cmd'}}};
assert.equal(def.match(pageManual.event,pageManual.view),null,'manual view must not duplicate automatic card');
assert.equal(manual.match(pageManual.event,pageManual.view).id,'cmd');
const pageState=manual.start({},pageManual);
assert.deepEqual(manual.buildViewNode({state:pageState}).data.compaction.progress,progress);
assert.equal(manual.buildViewNode({state:pageState}).data.compaction.seq,10);
assert.deepEqual(manual.buildViewNode({matches:[pageManual]}),manual.buildViewNode({state:pageState}),'manual progress-only page is self-contained even without reducer state');
const beforeTerminal=JSON.parse(JSON.stringify(node));
state=def.update({state},snapshot);
assert.deepEqual(JSON.parse(JSON.stringify(def.buildViewNode({state}))),beforeTerminal,'late progress cannot resurrect failed compaction');

}

// Fresh assembly sees the upstream import namespace; direct maintenance sees
// the product namespace. Exercise both without relying on Git HEAD (CI HEAD
// already contains this patch) or installed upstream build dependencies.
const legacy=readFileSync(new URL('../tests/fixtures/compaction-definition-legacy.js',import.meta.url));
const rendererFixture=`
/**
		* Register the automatic-compaction contribution.
*/
const CompactionNodeView = null;
/** Correlated retry-chain keyed Chat renderer. */
if (compaction !== void 0) return (0, react_jsx_runtime.jsx)(CompactionItem, {
children: (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.MarkdownText, { text: node.summary })
"view.chat": "对话",
"view.chat": "Chat",
`;
const normalized=patchCompactionViewModel(legacy).toString()+rendererFixture;
const upstream=normalized.replaceAll('_xharness_', '_deepseek_ai_');
assert.deepEqual(
  patchCompactionProgress(Buffer.from(upstream)).toString().replaceAll('_deepseek_ai_', '_xharness_'),
  patchCompactionProgress(Buffer.from(normalized)).toString(),
  'assembly-before-namespace-rewrite equals checked-bundle maintenance',
);
console.log('compaction progress: manual cold-page fallback and upstream/product namespace assembly passed');
