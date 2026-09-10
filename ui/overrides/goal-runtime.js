// xh-goal-runtime/v1
const XH_GOAL_STATES = {disabled:'未启用自动推进',running:'正在执行',queued:'已排队',waiting:'等待依赖或用户输入',awaiting_approval:'等待工具审批',awaiting_answer:'等待回答',awaiting_confirmation:'等待你确认完成',paused:'已暂停',blocked:'需要帮助',complete:'已完成'};
const XH_GOAL_REASONS = {round_budget:'轮数预算已到',cancelled:'用户停止',execution_error:'执行失败',step_limit:'步骤上限',output_limit:'输出上限',outcome_unknown:'上轮结果未知，未自动重放',report_protocol_stalled:'连续缺少进展报告'};
function XhGoalDetails({projection,onComplete,onResume,onBudget}) {
 const [budget,setBudget]=react.useState('');
 const [error,setError]=react.useState(''),[pending,setPending]=react.useState(false);
 const lock=react.useRef(false),identity=react.useRef(projection?.goal?.id);
 const id=projection?.goal?.id;
 react.useEffect(()=>{identity.current=id;lock.current=false;setPending(false);setError('');return()=>{identity.current=undefined}},[id]);
 if(!projection?.goal || !projection.execution)return null;
 const e=projection.execution,r=e.report;
 const run=async action=>{if(lock.current)return;const started=id;lock.current=true;setPending(true);setError('');try{const result=await action();if(identity.current===started && !result?.ok)setError(result?.error?.message??'操作失败，请重试');}catch(err){if(identity.current===started)setError(String(err?.message??err));}finally{if(identity.current===started){lock.current=false;setPending(false)}}};
 return react_jsx_runtime.jsxs('details',{'data-goal-runtime':true,style:{maxWidth:'min(760px,calc(100% - 32px))',margin:'4px auto',fontSize:12,overflowWrap:'anywhere'},children:[
  react_jsx_runtime.jsx('summary',{children:`${XH_GOAL_STATES[e.state]??e.state} · ${e.roundsStarted??projection.roundsStarted??0}/${e.maxGoalRounds??projection.goal.maxGoalRounds} 轮${e.pauseReason?' · '+(XH_GOAL_REASONS[e.pauseReason]??e.pauseReason):''}`}),
  e.state==='disabled' && react_jsx_runtime.jsx('button',{type:'button',disabled:pending,onClick:()=>run(onResume),children:'启用自动推进'}),
  projection.goal.blockedReason?.message && react_jsx_runtime.jsx('p',{children:projection.goal.blockedReason.message}),
  react_jsx_runtime.jsxs('form',{onSubmit:ev=>{ev.preventDefault();const n=Number(budget);if(Number.isSafeInteger(n)&&n>0)run(()=>onBudget(n))},children:[
   react_jsx_runtime.jsx('label',{children:['轮数预算 ',react_jsx_runtime.jsx('input',{type:'number',min:1,step:1,value:budget,placeholder:String(e.maxGoalRounds??projection.goal.maxGoalRounds),'aria-label':'轮数预算',onChange:ev=>setBudget(ev.target.value),style:{width:90}},'budget')]}),
   react_jsx_runtime.jsx('button',{type:'submit',disabled:pending||!Number.isSafeInteger(Number(budget))||Number(budget)<1,children:'保存预算（暂停自动推进）'})
  ]}),
  e.state==='paused' && react_jsx_runtime.jsx('p',{children:'暂停的是后续自动推进；若当前轮仍在运行，可使用对话的停止按钮取消。'}),
  e.pauseDetail && react_jsx_runtime.jsx('p',{role:'alert',children:e.pauseDetail}),
  r && react_jsx_runtime.jsx('p',{children:r.summary}),
  r?.remaining?.length>0 && react_jsx_runtime.jsx('ul',{children:r.remaining.map((text,i)=>react_jsx_runtime.jsx('li',{children:text},i))}),
  r?.evidence?.length>0 && react_jsx_runtime.jsx('ul',{children:r.evidence.map((item,i)=>react_jsx_runtime.jsx('li',{children:`${item.kind}: ${item.reference??item.execution_id}`},i))}),
  e.state==='awaiting_confirmation' && react_jsx_runtime.jsxs('div',{children:[react_jsx_runtime.jsx('button',{type:'button',disabled:pending,onClick:()=>run(onComplete),children:'确认完成'}),react_jsx_runtime.jsx('button',{type:'button',disabled:pending,onClick:()=>run(onResume),children:'尚未完成，继续'})]}),
  error && react_jsx_runtime.jsx('p',{role:'alert',children:error})
 ]});
}
// xh-goal-runtime/end
