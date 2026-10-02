import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const marker = '// xh-compaction-progress/v1';
export function patchCompactionProgressModel(bytes) {
  let s = bytes.toString();
  if (s.includes(marker)) return Buffer.from(s);
  const once = (before, after) => {
    if (s.split(before).length !== 2) throw Error('compaction progress anchor changed: ' + before.slice(0,100));
    s = s.replace(before, after);
  };
  const override = readFileSync(new URL('../ui/overrides/compaction-progress.js',import.meta.url),'utf8');
  if (s.includes('const COMPACT_PLUGIN = "compact";')) once('const COMPACT_PLUGIN = "compact";', override+'\n\t\tconst COMPACT_PLUGIN = "compact";');
  else s=override+'\n'+s;
  once('function updateCompactionState(state, match) {', 'function updateCompactionState(state, match) {\n    if(match.event.type === \"compaction/progress\" && (state.end || [\"failed\",\"succeeded\"].includes(state.presentation?.phase))) return state;');
  once('else if (match.event.type === "compaction/end") next = {', 'else if (match.event.type === "compaction/progress") next = state.end ? state : { ...state, progress:match };\n\t\t\telse if (match.event.type === "compaction/end") next = {');
  s = s.replaceAll('event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end"', 'event.type === "compaction/start" || event.type === "compaction/progress" || event.type === "compaction/summary" || event.type === "compaction/end"');
  once('if (presentation !== void 0) return {', 'if (typeof presentation?.sourceCommandId === \"string\") return null;\n\t\t\t\t\tif (presentation !== void 0) return {');
  once('role: presentation.phase === "running" ? "start" : "update"', 'role: event.type === "compaction/progress" ? "update" : presentation.phase === "running" ? "start" : "update"');
  // Reduce old and new carriers identically; progress cannot resurrect an ended node.
  const a=s.indexOf('const compactionDefinition ='), tail=s.indexOf('/**\n\t\t* Register the automatic-compaction',a), b=tail<0?s.length:tail;
  let def=s.slice(a,b);
  const x=def.indexOf('\t\t\tbuildViewNode:');
  if(x<0) throw Error('missing compaction build');
  def=def.slice(0,x)+`\t\t\tbuildViewNode: (context) => {
    const state = context.state ?? fallbackState$2(context);
    if (state.checkpoint && !state.presentation) {
      const data = {...compactSummary(state.summary,state.checkpoint), progress:xhCompactProgress(state.progress?.event.data.progress)};
      return chatNode(context,"compaction",data.seq,data);
    }
    const data = xhCompactLifecycle(state);
    return data ? chatNode(context,"compaction",data.seq,data) : null;
  }
};\n\t\t`;
  s=s.slice(0,a)+def+s.slice(b);
  if(s.includes('const compaction = state.checkpoint')) once('const compaction = state.checkpoint === void 0 ? null : compactSummary(state.summary, state.checkpoint);', 'const compaction = state.checkpoint === void 0 ? xhCompactLifecycle(state) : {...compactSummary(state.summary,state.checkpoint), progress:xhCompactProgress(state.progress?.event.data.progress)};');
  if(s.includes('function fallbackState$3(context)')) once('function fallbackState$3(context) {', `function fallbackState$3(context) {
    const lifecycle = context.matches.find(m => typeof projectedCompactionView(m.view)?.sourceCommandId === "string" || (m.event.type === "compaction/start" && m.event.data.sourceCommandId));
    if(lifecycle) {
      const view=projectedCompactionView(lifecycle.view);
      const run=context.matches.find(m=>m.event.type === "command/run");
      const done=context.matches.find(m=>m.event.type === "command/done");
      const command=done ? commandFromDone(done) : run ? commandFromRun(run) : {
        kind:"command", seq:view?.anchorSeq ?? lifecycle.event.seq, time:view?.time ?? lifecycle.event.time,
        commandId:view?.sourceCommandId ?? lifecycle.event.data.sourceCommandId, name:"compact", args:null, outcome:null,
      };
      return context.matches.reduce(updateCompactionState,{command});
    }
`);
  if(s.includes('const commandDefinition =')) {
    once('match: (event) => {\n\t\t\t\tif (event.type === "command/run")', `match: (event, view) => {
      const projected=projectedCompactionView(view);
      if(typeof projected?.sourceCommandId === "string") return {id:projected.sourceCommandId,role:"update"};
      if (event.type === "command/run")`);
    once('start: (_context, match) => ({ command: commandFromRun(match) }),', `start: (_context, match) => {
      const view=projectedCompactionView(match.view);
      if(match.event.type === "command/run") return {command:commandFromRun(match)};
      if(match.event.type === "command/done") return {command:commandFromDone(match)};
      const command={kind:"command",seq:view?.anchorSeq ?? match.event.seq,time:view?.time ?? match.event.time,
        commandId:view?.sourceCommandId ?? match.event.data.sourceCommandId,name:"compact",args:null,outcome:null};
      return updateCompactionState({command},match);
    },`);
  }
  return Buffer.from(s);
}
export function patchCompactionProgress(bytes) {
  if (bytes.toString().includes(marker)) return bytes;
  let s=patchCompactionProgressModel(bytes).toString();
  const once=(a,b)=> { if(s.split(a).length!==2) throw Error('compaction progress renderer anchor changed: '+a.slice(0,80)); s=s.replace(a,b); };
  const replaceRegion=(start,end,value)=> { const a=s.indexOf(start),b=s.indexOf(end,a); if(a<0||b<a) throw Error('compaction progress renderer region changed'); s=s.slice(0,a)+value+'\n\t\t'+s.slice(b); };
  replaceRegion('const CompactionNodeView =', '/** Correlated retry-chain keyed Chat renderer. */', `const CompactionNodeView = (0, react.memo)(function CompactionNodeView({node,t}) {
    if (node.data.status) return (0, react_jsx_runtime.jsx)(XhCompactionProgressCard, {data:node.data,t});
    return (0, react_jsx_runtime.jsx)(CompactionItem, {node:node.data,t});
  });`);
  once('if (compaction !== void 0) return (0, react_jsx_runtime.jsx)(CompactionItem, {', 'if (compaction?.status) return (0, react_jsx_runtime.jsx)(XhCompactionProgressCard, {data:compaction,t});\n\t\t\tif (compaction !== void 0) return (0, react_jsx_runtime.jsx)(CompactionItem, {');
  // Assembly patches upstream bytes before the product namespace rewrite;
  // maintenance patches the already rewritten checked-in bundle.
  const primitives=s.includes('_deepseek_ai_dsh_client_ui_primitives.MarkdownText')
    ? '_deepseek_ai_dsh_client_ui_primitives' : '_xharness_dsh_client_ui_primitives';
  once(`children: (0, react_jsx_runtime.jsx)(${primitives}.MarkdownText, { text: node.summary })`, `children: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {children:[(0, react_jsx_runtime.jsx)(XhCompactionMetrics, {data:node,t}), (0, react_jsx_runtime.jsx)(${primitives}.MarkdownText, {text:node.summary})]})`);
  const catalogs = [
    {anchor:'"view.chat": "对话",', labels:{failed:'压缩未完成',unchanged:'原始历史未改变',counts:'已完成 {parts} 份摘要 · {calls} 次请求 · {splits} 次拆分 · {retries} 次重试',tokens:'请求输入 {before} → {after} tokens',retry:'第 {retry} 次重试 · {seconds} 秒后重试',controls:'任务在压缩边界等待；可使用对话中的暂停或停止。',preparing:'准备与计数',summarizing:'生成摘要',splitting:'拆分历史',merging:'合并摘要',retrying:'等待网络恢复',paused:'已暂停',validating:'验证输入预算',committing:'保存检查点'}},
    {anchor:'"view.chat": "Chat",', labels:{failed:'Compaction not completed',unchanged:'Original history unchanged',counts:'{parts} summaries completed · {calls} requests · {splits} splits · {retries} retries',tokens:'Request input {before} → {after} tokens',retry:'Retry {retry} · retrying in {seconds}s',controls:'Task waits at the compaction boundary; use the conversation pause or stop controls.',preparing:'Preparing and counting',summarizing:'Generating summary',splitting:'Splitting history',merging:'Merging summaries',retrying:'Waiting for network',paused:'Paused',validating:'Validating input budget',committing:'Saving checkpoint'}},
  ];
  for(const {anchor,labels} of catalogs) {
    const entries=Object.entries(labels).map(([key,value]) => `${JSON.stringify('xh.compact.'+(['preparing','summarizing','splitting','merging','retrying','paused','validating','committing'].includes(key)?'stage.':'')+key)}: ${JSON.stringify(value)},`).join('\n\t\t\t');
    once(anchor, anchor+'\n\t\t\t'+entries);
  }
  return Buffer.from(s);
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dist=resolve(process.argv[2]??'ui/dist'),path=resolve(dist,'plugins/@xharness/dsh-client-ui-conversation/client.js');
  const bytes=patchCompactionProgress(readFileSync(path)); writeFileSync(path,bytes);
  const hash=v=>createHash('sha256').update(v).digest('hex').slice(0,16);
  const gp=resolve(dist,'client-graph.json'),graph=JSON.parse(readFileSync(gp));
  const entry=graph.entries.find(e=>e.id==='@xharness/dsh-client-ui-conversation'),prev=entry.url;
  entry.rev=hash(bytes); entry.url='/plugins/'+entry.id+'/client.js?rev='+entry.rev;
  graph.rev=hash(JSON.stringify(graph.entries));writeFileSync(gp,JSON.stringify(graph,null,2)+'\n');
  const ip=resolve(dist,'index.html');writeFileSync(ip,readFileSync(ip,'utf8').replaceAll(prev,entry.url).replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
