import {fileURLToPath} from 'node:url'
/** Acceptance seam over the actual shipped ModuleLoader factory, not a replacement component. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
const ui=new URL('../ui/',import.meta.url),id='@xharness/dsh-client-ui-conversation';
const require=createRequire(new URL('../ui/package.json',import.meta.url)),ts=require('typescript');
const units={
 AssistantMarkdown:['chat/AssistantMarkdown','AssistantMarkdown'],
 toolArgumentPreview:['chat/tool-argument-view','toolArgumentPreview'],
 boundedToolArgumentText:['chat/tool-argument-view','boundedToolArgumentText'],
 formatToolArgumentBytes:['chat/tool-argument-view','formatToolArgumentBytes'],
 TOOL_ARGUMENT_PREVIEW_LIMIT:['chat/tool-argument-view','TOOL_ARGUMENT_PREVIEW_LIMIT'],
 deriveAncestry:['skeleton/ConversationSession','deriveAncestry'],
 resolveActiveView:['skeleton/ConversationSession','resolveActiveView'],
 InputBar:['skeleton/InputBar','InputBar'],
 contextOccupancy:['chat/StatsLine','contextOccupancy'],ContextMeter:['skeleton/ContextMeter','ContextMeter'],
 compactBlocks:['conversation-nodes/assistant','compactBlocks'],hasVisibleContent:['conversation-nodes/assistant','hasVisibleContent'],hasInterruptionEvidence:['conversation-nodes/assistant','hasInterruptionEvidence'],updateChunk:['conversation-nodes/assistant','updateChunk'],finalNode:['conversation-nodes/assistant','finalNode'],
 contextLocation:['conversation-nodes/common','contextLocation'],chatNode:['conversation-nodes/common','chatNode'],
 turnErrorDefinition:['conversation-nodes/turn-error','turnErrorDefinition'],turnMaxTokensDefinition:['conversation-nodes/turn-max-tokens','turnMaxTokensDefinition'],
 chatViewDefinition:['conversation-nodes/chat-snapshot-builder','chatViewDefinition'],
 assistantDefinition:['conversation-nodes/assistant','assistantDefinition'],compactSource:['conversation-nodes/command','compactSource'],
 compactProgress:['conversation-nodes/compaction-lifecycle','compactProgress'],compactLifecycle:['conversation-nodes/compaction-lifecycle','compactLifecycle'],
 commandDefinition:['conversation-nodes/command','commandDefinition'],compactionDefinition:['conversation-nodes/compaction','compactionDefinition'],compactSummary:['conversation-nodes/command','compactSummary'],CompactionItem:['chat/CompactionItem','CompactionItem'],TurnMaxTokensItem:['chat/MessageItem','TurnMaxTokensItem'],
 HeroGlow:['skeleton/EmptyHero','HeroGlow'],en:['locales','en'],zh:['locales','zh'],ConversationController:['service','ConversationController'],validateAttachments:['attachments','validateAttachments'],
 SessionInputShell:['input/facade','SessionInputShell'],InputHub:['input/hub','InputHub'],
 xhEditStorage:['edit/persistence','xhEditStorage'],xhForkMessage:['edit/actions','xhForkMessage'],
 ApprovalPanel:['skeleton/ApprovalPanel','ApprovalPanel'],selectApproval:['apply','selectApproval'],
 PermissionSelect:['skeleton/PermissionSelect','PermissionSelect'],permissionFeedback:['skeleton/PermissionSelect','permissionFeedback'],
 UserMessageNodeView:['chat/MessageItem','UserMessageNodeView'],ChatView:['chat/ChatView','ChatView'],
 XhTranscriptWindowRow:['chat/TranscriptWindowRow','TranscriptWindowRow'],createTranscriptWindowing:['chat/TranscriptWindowRow','createTranscriptWindowing'],
 ReasoningRow:['chat/ReasoningRow','ReasoningRow'],retryDefinition:['conversation-nodes/retry','retryDefinition'],updateRetryState:['conversation-nodes/retry','updateRetryState'],ModelRetryItem:['chat/MessageItem','ModelRetryItem'],CompactionProgressCard:['chat/CompactionProgressCard','CompactionProgressCard'],
 xhCheckpointDefinition:['conversation-nodes/checkpoint','checkpointDefinition'],XhCheckpointView:['chat/CheckpointView','CheckpointView'],
 xhScrollFollowAtBottom:['chat/ChatView','scrollFollowAtBottom'],QueueDock:['queue/QueueDock','QueueDock'],
};
/** Hash, boot/preload and (when admitted) byte-for-byte strict source freshness are all required. */
export function verifyConversationArtifact(){
 const bytes=readFileSync(new URL(`dist/plugins/${id}/client.js`,ui)),graph=JSON.parse(readFileSync(new URL('dist/client-graph.json',ui))),entry=graph.entries.find(e=>e.id===id),html=readFileSync(new URL('dist/index.html',ui),'utf8');
 new Script(bytes.toString());assert.ok(entry,'shipped graph must contain conversation');assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));assert.ok(html.includes(entry.url));assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]),graph);
 const manifest=JSON.parse(readFileSync(new URL('modules.json',ui)));const row=manifest.modules.find(e=>e.id===id);
 if(row?.kind==='source-module')assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(compileSourceModules(fileURLToPath(ui),[row]).get(id).bytes).digest('hex'),'shipped conversation must match its strict owned source, not a stale/frozen bundle');
 return bytes.toString();
}
/** Expose maintained unit members by AST scope, independent of emitter formatting/signatures. */
export function exposeConversation(source,names){
 if(!source.startsWith('// Generated from src/modules/conversation/')){
  for(const name of names)assert.ok(name in units,`unknown conversation acceptance export ${name}`);
  assert.ok(source.includes('return module.exports;'),'legacy ModuleLoader return');const aliases={compactProgress:'xhCompactProgress',compactLifecycle:'xhCompactLifecycle',CompactionProgressCard:'XhCompactionProgressCard'};
  return source.replace('return module.exports;',`Object.assign(exports,{${names.map(name=>`${name}:${aliases[name]??name}`).join(',')}});return module.exports;`);
 }
 const ast=ts.createSourceFile('conversation.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),byFile=new Map(),insert=[];
 for(const name of names){assert.ok(name in units,`unknown conversation acceptance export ${name}`);const[file,local]=units[name],path=`src/modules/conversation/${file}.js`;const locals=byFile.get(path)??new Set();locals.add(local);byFile.set(path,locals)}
 function visit(node){if(ts.isPropertyAssignment(node)&&ts.isStringLiteral(node.name)&&byFile.has(node.name.text)&&ts.isFunctionExpression(node.initializer)){
  const locals=byFile.get(node.name.text),body=node.initializer.body.getText(ast);
  // TS emits exported constants directly as exports.name; only genuinely
  // private locals need a test assignment in their owning lexical scope.
  const privateLocals=[...locals].filter(name=>!body.includes(`exports.${name}`));
  if(privateLocals.length)insert.push({pos:node.initializer.body.end-1,text:`\nObject.assign(exports,{${privateLocals.join(',')}});\n`});byFile.delete(node.name.text)}ts.forEachChild(node,visit)}visit(ast);assert.equal(byFile.size,0,'requested acceptance units must exist in shipped graph');
 const marker='return __load("src/modules/conversation/index.js");';assert.ok(source.includes(marker),'source graph root');
 for(const item of insert.sort((a,b)=>b.pos-a.pos))source=source.slice(0,item.pos)+item.text+source.slice(item.pos);
 return source.replace(marker,`const __acceptance = __load("src/modules/conversation/index.js");return Object.assign({},__acceptance,{${names.map(name=>`${name}:__load(${JSON.stringify('src/modules/conversation/'+units[name][0]+'.js')})[${JSON.stringify(units[name][1])}]`).join(',')}});`);
}
export function legacyConversation(){return readFileSync(new URL(`reference/master-a613970/plugins/${id}/client.js`,ui))}
