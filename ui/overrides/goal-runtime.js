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
// Empty state is an explicit entry, not an automatically created task.
function XhGoalCreate({onCreate}) {
 const [editing,setEditing]=react.useState(false),[draft,setDraft]=react.useState(''),[pending,setPending]=react.useState(false),[error,setError]=react.useState('');
 const lock=react.useRef(false),alive=react.useRef(true);
 react.useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const submit=async ev=>{ev.preventDefault();const text=draft.trim();if(!text||lock.current)return;lock.current=true;setPending(true);setError('');try{const r=await onCreate(text);if(alive.current){if(!r?.ok)setError(r?.error?.message??'创建失败，请重试');else{setEditing(false);setDraft('')}}}catch(e){if(alive.current)setError(String(e?.message??e))}finally{if(alive.current){lock.current=false;setPending(false)}}};
 return react_jsx_runtime.jsx('div',{className:GoalBar_module_css_default.dock,'data-goal-create':true,children:react_jsx_runtime.jsxs('form',{className:GoalBar_module_css_default.bar,style:{minHeight:36,height:'auto',flexWrap:'wrap'},onSubmit:submit,children:[
  react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.IconGoalOutline16,{size:14}),
  react_jsx_runtime.jsx('span',{className:GoalBar_module_css_default.label,children:'Goal'}),
  editing?react_jsx_runtime.jsx('input',{className:GoalBar_module_css_default.objectiveInput,'aria-label':'目标内容',placeholder:'描述要持续推进的目标',value:draft,disabled:pending,autoFocus:true,onChange:e=>setDraft(e.target.value),onKeyDown:e=>{if(e.key==='Escape'&&!pending){setEditing(false);setError('')}}}):react_jsx_runtime.jsx('span',{className:GoalBar_module_css_default.objective,children:'未设置目标'}),
  error&&react_jsx_runtime.jsx('span',{className:GoalBar_module_css_default.error,role:'alert',children:error}),
  editing?react_jsx_runtime.jsxs('span',{className:GoalBar_module_css_default.actions,children:[react_jsx_runtime.jsx('button',{type:'submit',className:GoalBar_module_css_default.iconBtn,disabled:pending||!draft.trim(),'aria-label':'创建并启动目标',title:'创建并启动目标',children:'✓'}),react_jsx_runtime.jsx('button',{type:'button',className:GoalBar_module_css_default.iconBtn,disabled:pending,'aria-label':'取消创建目标',onClick:()=>{setEditing(false);setError('')},children:'×'})]}):react_jsx_runtime.jsx('button',{type:'button',className:GoalBar_module_css_default.iconBtn,style:{width:'auto',padding:'0 8px'},'aria-label':'设定目标',onClick:()=>setEditing(true),children:'设定目标'})
 ]})});
}
// xh-goal-runtime/end
