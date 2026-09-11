// xh-goal-runtime/v1
const XH_GOAL_STATES = {disabled:'未启用自动推进',running:'正在执行',queued:'已排队',waiting:'等待依赖或用户输入',awaiting_approval:'等待工具审批',awaiting_answer:'等待回答',awaiting_confirmation:'等待你确认完成',paused:'已暂停',blocked:'需要帮助',complete:'已完成'};
const XH_GOAL_REASONS = {round_budget:'轮数预算已到',cancelled:'用户停止',execution_error:'执行失败',step_limit:'步骤上限',output_limit:'输出上限',outcome_unknown:'上轮结果未知，未自动重放',report_protocol_stalled:'连续缺少进展报告'};
function xhGoalStatus(goal, execution, t) {
 const label=execution ? (XH_GOAL_STATES[execution.state]??execution.state) : goal.phase==='complete'?'已完成':t(PHASE_LABELS[goal.phase]);
 return `${label} · ${execution?.roundsStarted??goal.roundsStarted??0}/${execution?.maxGoalRounds??goal.maxGoalRounds} 轮`;
}
function xhGoalTitle(goal, execution) {
 const r=execution?.report;
 return [goal.objective,execution?.pauseReason&&(XH_GOAL_REASONS[execution.pauseReason]??execution.pauseReason),execution?.pauseDetail,goal.blockedReason?.message,r?.summary,...(r?.remaining??[]),...(r?.evidence??[]).map(e=>`${e.kind}: ${e.reference??e.execution_id}`)].filter(Boolean).join('\n');
}
// Controls live INSIDE the upstream GoalBar. Never append a second details panel.
function XhGoalControls({projection,onComplete,onResume,onBudget,runAction,pending}) {
 const [editing,setEditing]=react.useState(false),[budget,setBudget]=react.useState('');
 const id=projection?.goal?.id,identity=react.useRef(id);
 react.useEffect(()=>{identity.current=id;setEditing(false);setBudget('');return()=>{identity.current=undefined}},[id]);
 if(!projection?.goal)return null;
 const e=projection.execution;
 const glyph={'启用自动推进':'▶','确认完成':'✓','继续':'▶','预算':'⋯','取消预算修改':'×'};
 const button=(label,action)=>react_jsx_runtime.jsx('button',{type:'button',className:GoalBar_module_css_default.iconBtn,disabled:pending,'aria-label':label,title:label,onClick:action,style:{flexShrink:0,whiteSpace:'nowrap'},children:glyph[label]??label});
 return react_jsx_runtime.jsxs('span',{'data-goal-runtime':true,style:{display:'inline-flex',alignItems:'center',gap:6,flexWrap:'wrap'},children:[
  e?.state==='disabled'&&button('启用自动推进',()=>runAction(onResume)),
  e?.state==='awaiting_confirmation'&&button('确认完成',()=>runAction(onComplete)),
  e?.state==='awaiting_confirmation'&&button('继续',()=>runAction(onResume)),
  projection.goal.phase!=='complete'&&(editing ? react_jsx_runtime.jsxs('form',{style:{display:'inline-flex',alignItems:'center',gap:4},onSubmit:async ev=>{ev.preventDefault();const n=Number(budget);if(!Number.isSafeInteger(n)||n<1)return;const started=id;const result=await runAction(()=>onBudget(n));if(result?.ok&&identity.current===started)setEditing(false)},children:[
   react_jsx_runtime.jsx('input',{type:'number',min:1,step:1,value:budget,disabled:pending,'aria-label':'轮数预算',title:'保存后暂停自动推进',onChange:ev=>setBudget(ev.target.value),onKeyDown:ev=>{if(ev.key==='Escape')setEditing(false)},style:{width:64,minWidth:0}}),
   react_jsx_runtime.jsx('button',{type:'submit',className:GoalBar_module_css_default.iconBtn,disabled:pending||!Number.isSafeInteger(Number(budget))||Number(budget)<1,'aria-label':'保存轮数预算',title:'保存预算并暂停自动推进',children:'保存'}),
   button('取消预算修改',()=>setEditing(false))
  ]}):button('预算',()=>{setBudget(String(e?.maxGoalRounds??projection.goal.maxGoalRounds));setEditing(true)}))
 ]});
}
// xh-goal-runtime/end
