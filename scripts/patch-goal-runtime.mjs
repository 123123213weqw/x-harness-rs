import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function patchGoalRuntime(bytes) {
 let s=bytes.toString();const helper=readFileSync(new URL('../ui/overrides/goal-runtime.js',import.meta.url),'utf8');
 if(s.includes('// xh-goal-runtime/v1'))s=s.replace(/\/\/ xh-goal-runtime\/v1[\s\S]*?\/\/ xh-goal-runtime\/end\n?/,helper);
 else {
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Goal UI anchor changed: '+a);s=s.replace(a,b)};
 once('\t\tfunction GoalBar(',helper+'\n\t\tfunction GoalBar(');
 once('goal === null || goal.phase === "complete" ||','goal === null ||');
 once('blocked: "phase.blocked"','blocked: "phase.blocked", complete: "phase.complete"');
 once('children: t(PHASE_LABELS[goal.phase])','children: goal.phase === "complete" ? "已完成" : t(PHASE_LABELS[goal.phase])');
 once('goal.phase === "paused" &&','(goal.phase === "paused" || goal.phase === "blocked") &&');
 once('function GoalDock({ useProjection, onEdit, onPause, onResume, onClear, t }) {','function GoalDock({ useProjection, onEdit, onPause, onResume, onClear, onComplete, onBudget, t }) {');
 once('return (0, react_jsx_runtime.jsx)(GoalBar, {','return (0, react_jsx_runtime.jsxs)(react.Fragment, {children:[(0, react_jsx_runtime.jsx)(GoalBar, {');
 once('\t\t\t\tonClear,\n\t\t\t\tt\n\t\t\t});','\t\t\t\tonClear,\n\t\t\t\tt\n\t\t\t}),react_jsx_runtime.jsx(XhGoalDetails,{projection,onComplete,onResume,onBudget},projection?.goal?.id)]});');
 once('\t\t\t\t\tonClear: async () => {','\t\t\t\t\tonBudget: async (maxGoalRounds) => {const ref=refOf(sessionId);if(ref===void 0)return noCurrentGoal;return await ctx.remote.goals.edit(sessionId,ref,{maxGoalRounds});},\n\t\t\t\t\tonComplete: async () => { const ref=refOf(sessionId); if(ref===void 0)return noCurrentGoal;return await ctx.remote.goals.complete(sessionId,ref); },\n\t\t\t\t\tonClear: async () => {');
 once('const pendingRef = (0, react.useRef)(false);','const pendingRef = (0, react.useRef)(false); const actionEpoch=react.useRef(0);');
 once('setClearedGoalId(null);\n\t\t\t}, [goalId]);','setClearedGoalId(null); actionEpoch.current++;pendingRef.current=false;setPending(false);\n\t\t\t}, [goalId]);');
 once('pendingRef.current = true;','pendingRef.current = true; const epoch=actionEpoch.current;');
 // Network rejection must not leave upstream action lock stuck forever.
 once('const result = await action();\n\t\t\t\tpendingRef.current = false;', 'let result;try {result=await action();}catch(error){result={ok:false,error:{code:"network",message:String(error?.message??error)}}}\n\t\t\t\tif(epoch!==actionEpoch.current)return; pendingRef.current = false;');
 }
 if(!s.includes('// xh-goal-inline/v2')) {
  const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Goal inline UI anchor changed: '+a);s=s.replace(a,b)};
  once('function GoalBar({ goal, onEdit, onPause, onResume, onClear, t }) {','// xh-goal-inline/v2\nfunction GoalBar({ goal, projection, onComplete, onBudget, onEdit, onPause, onResume, onClear, t }) {');
  once('return (0, react_jsx_runtime.jsxs)(react.Fragment, {children:[(0, react_jsx_runtime.jsx)(GoalBar, {','return (0, react_jsx_runtime.jsx)(GoalBar, {projection,onComplete,onBudget,');
  once('}),react_jsx_runtime.jsx(XhGoalDetails,{projection,onComplete,onResume,onBudget},projection?.goal?.id)]});','});');
  once('children: goal.phase === "complete" ? "已完成" : t(PHASE_LABELS[goal.phase])','children: xhGoalStatus(goal,projection?.execution,t)');
  once('\t\t\t\t\ttitle,','\t\t\t\t\ttitle: xhGoalTitle(goal,projection?.execution),');
  once('goal.phase === "active" &&','goal.phase === "active" && projection?.execution?.state!=="disabled" &&');
  once('\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\tgoal.phase', '\t\t\t\t\t\t\tchildren: [react_jsx_runtime.jsx(XhGoalControls,{projection,onComplete,onResume,onBudget,runAction,pending},goal.id),\n\t\t\t\t\t\t\t\tgoal.phase');
 }
 if(!s.includes('// xh-goal-wrap/v1')) {
  const anchor='title: xhGoalTitle(goal,projection?.execution),';
  if(s.split(anchor).length!==2)throw Error('Goal wrap anchor changed');
  s=s.replace(anchor,anchor+' // xh-goal-wrap/v1\nstyle:{minHeight:36,height:"auto",flexWrap:"wrap"},');
 }
 if(!s.includes('// xh-goal-create/v1')) {
  const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Goal create UI anchor changed: '+a);s=s.replace(a,b)};
  once('function GoalDock({ useProjection, onEdit, onPause, onResume, onClear, onComplete, onBudget, t }) {','// xh-goal-create/v1\nfunction GoalDock({ useProjection, goalSessionId, onCreate, onEdit, onPause, onResume, onClear, onComplete, onBudget, t }) {');
  once('const projection = useProjection("goal");','const projection = useProjection("goal");\nif(!projection?.goal)return react_jsx_runtime.jsx(XhGoalCreate,{onCreate},goalSessionId);');
  once('inject: (sessionId) => ({','inject: (sessionId) => ({goalSessionId:sessionId,onCreate:async objective=>await ctx.remote.goals.create(sessionId,{objective}),');
 }
 return Buffer.from(s);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dist=resolve(process.argv[2]??'ui/dist'),p=resolve(dist,'plugins/@deepseek-ai/dsh-client-ui-goal/client.js');
 const bytes=patchGoalRuntime(readFileSync(p));writeFileSync(p,bytes);
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16),gp=resolve(dist,'client-graph.json'),g=JSON.parse(readFileSync(gp));
 const e=g.entries.find(e=>e.id==='@deepseek-ai/dsh-client-ui-goal');e.rev=hash(bytes);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;g.rev=hash(JSON.stringify(g.entries));writeFileSync(gp,JSON.stringify(g,null,2)+'\n');
 const ip=resolve(dist,'index.html');writeFileSync(ip,readFileSync(ip,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(g)}</script>`));
}
