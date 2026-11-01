// Preview/test scaffolding only. Goal controls and overlays are the real source components.
window.addEventListener('preview-platform-ready',()=>{
 const React=staticModules.react,DOM=staticModules['react-dom'],h=React.createElement;
 const load=id=>previewRegistrations[id].factory(name=>{if(!(name in staticModules))throw Error('Unexpected preview import '+name);return staticModules[name]});
 const {GoalDock}=load('@xharness/dsh-client-ui-goal'),labels=load('preview-goal-labels');
 const params=new URL(location.href).searchParams;
 const makeProjection=(state='running',phase='active',id='preview-goal')=>({goal:{id,revision:1,objective:'修复登录问题，补齐测试并运行回归；不要发布',phase,roundsStarted:12,maxGoalRounds:100},execution:{state,roundsStarted:12,maxGoalRounds:100,report:{summary:'已定位登录状态恢复问题，正在补充回归测试。',remaining:['运行回归'],evidence:[{kind:'artifact',reference:'tests/login.test.ts'}]}}});
 const f=window.goalPreview={calls:[],fail:false,hold:false,pendingResolve:null,projection:makeProjection(),lang:params.get('lang')==='en'?'en':'zh',dark:params.get('theme')!=='light'};
 const root=DOM.createRoot(document.getElementById('root'));
 const paint=()=>DOM.flushSync(()=>root.render(h(App)));
 window.renderGoal=(state='running',phase='active',id='preview-goal',objective)=>{f.projection=state==='absent'?null:makeProjection(state,phase,id);if(f.projection&&objective)f.projection.goal.objective=objective;paint()};
 const action=name=>async(...args)=>{
  const id=f.projection?.goal.id;
  f.calls.push({name,args});
  if(f.hold)await new Promise(resolve=>{f.pendingResolve=resolve});
  if(f.fail)throw Error('connection lost');
  if(f.projection?.goal.id!==id)return {ok:false,error:{code:'stale',message:'goal changed'}};
  if(name==='clear')f.projection=null;
  else if(f.projection){
   const p=structuredClone(f.projection);p.goal.revision++;
   if(name==='pause'||name==='edit'){p.goal.phase='paused';p.execution.state='paused'}
   if(name==='resume'){p.goal.phase='active';p.execution.state='running'}
   if(name==='complete'){p.goal.phase='complete';p.execution.state='complete'}
   if(name==='edit')p.goal.objective=args[0];
   f.projection=p;
  }
  paint();return {ok:true,value:{}};
 };
 const actions={onComplete:action('complete'),onPause:action('pause'),onResume:action('resume'),onClear:action('clear'),onEdit:action('edit')};
 function App(){
  React.useEffect(()=>{document.body.toggleAttribute('data-ds-dark-theme',f.dark);document.documentElement.lang=f.lang},[f.dark,f.lang]);
  const t=key=>labels[f.lang][key]??key;
  return h(React.Fragment,null,
   h('header',{id:'preview-controls'},h('span',null,f.lang==='zh'?'Goal 交互预览 · 示例目标 · 未连接 Host':'Goal preview · sample target · no Host connection'),
    h('select',{'aria-label':'Preview state',value:f.projection?.execution.state??'absent',onChange:e=>{const state=e.target.value;renderGoal(state,state==='paused'?'paused':state==='blocked'?'blocked':state==='complete'?'complete':'active')}},...['running','paused','blocked','awaiting_confirmation','disabled','network_backoff','complete','absent'].map(state=>h('option',{key:state,value:state},state))),
    h('button',{onClick:()=>{f.dark=!f.dark;paint()}},f.dark?'Light':'Dark'),h('button',{onClick:()=>{f.lang=f.lang==='zh'?'en':'zh';paint()}},f.lang==='zh'?'English':'中文')),
   h('main',null,h('div',{className:'preview-message'},f.lang==='zh'?'我会先复现登录问题，再补充回归测试。现有发布配置保持不变。':'I will reproduce the login issue, then add regression coverage. Release configuration stays unchanged.'),
    h('section',{id:'fixture-goal'},h(GoalDock,{...actions,t,useProjection:()=>f.projection})),
    h('div',{className:'preview-composer'},h('textarea',{'aria-label':'Preview message',placeholder:f.lang==='zh'?'给 Agent 发消息':'Message the agent'}),h('div',{className:'preview-footer'},h('span',null,'＋'),h('span',{className:'preview-send','aria-hidden':true},'↑')))));
 }
 paint();
});
