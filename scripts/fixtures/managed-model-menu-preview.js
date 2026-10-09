window.addEventListener('preview-platform-ready',async()=>{
 const React=staticModules.react,ReactDOM=staticModules['react-dom'];
 const makeStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},update:fn=>{value=structuredClone(value);fn(value);listeners.forEach(fn=>fn())}}};
 const modules={...staticModules,'@xharness/dsh-client-runtime/client':{createSnapshotStore:makeStore}};
 const load=id=>previewRegistrations[id].factory(name=>{if(!(name in modules))throw Error('Unexpected preview dependency '+name);return modules[name]});
 const api=load('@xharness/dsh-client-ui-model-selection'),labels=load('preview-model-labels'),{SettingsRoot}=load('preview-settings-shell');
 const jsx=React.createElement;
 window.fixture={saved:{provider:'xharness-managed',model:'deepseek-flash'},calls:[],offline:false,account:true,custom:true};
 const account={id:'xharness-managed',name:'XHarness',models:[{id:'deepseek-flash',name:'DeepSeek Flash',contextWindow:1000000},{id:'glm-5.3-flash',name:'GLM Flash',contextWindow:200000}]};
 const custom=[{id:'bigmodel',name:'BigModel',models:[{id:'glm-5.3-flash',name:'My GLM',contextWindow:128000}]},{id:'byok',name:'XHarness',models:[{id:'local',name:'Local model',contextWindow:32768}]}];
 const wire={models:async()=>{if(fixture.offline)throw Error('offline');return {result:{ok:true,value:{current:fixture.saved,routable:true,groups:[...(fixture.account?[account]:[]),...(fixture.custom?custom:[])],failures:[]}}}},selectModel:async args=>{if(fixture.offline)throw Error('offline');fixture.calls.push(args);fixture.saved={...args};delete fixture.saved.sessionId;return {result:{ok:true,value:{selected:fixture.saved}}}}};
 fixture.directory=new api.ModelDirectory(wire,'preview-session',()=>true);await fixture.directory.load();
 const sectionListeners=new Set(), subscribe=fn=>{sectionListeners.add(fn);return()=>sectionListeners.delete(fn)},manage=()=>sectionListeners.forEach(fn=>fn('models'));
 function App(){
  const [lang,setLang]=React.useState(new URL(location.href).searchParams.get('lang')==='en'?'en':'zh');
  const [dark,setDark]=React.useState(new URL(location.href).searchParams.get('theme')!=='light');
  React.useEffect(()=>{document.body.toggleAttribute('data-ds-dark-theme',dark);document.documentElement.lang=lang},[lang,dark]);
  const t=(key,args)=>{let value=labels[lang][key]??key;for(const [name,v]of Object.entries(args??{}))value=value.replaceAll('{'+name+'}',String(v));return value};
  return jsx(React.Fragment,null,
   jsx('div',{id:'preview-controls'},jsx('span',null,lang==='zh'?'模型菜单预览 · 示例目录 · 无真实登录':'Model menu preview · fixture catalog · no real sign-in'),jsx('button',{onClick:()=>setLang(lang==='zh'?'en':'zh')},lang==='zh'?'English':'中文'),jsx('button',{onClick:()=>setDark(!dark)},dark?'Light':'Dark')),
   jsx('div',{id:'fixture-composer'},jsx('span',null,lang==='zh'?'在模型菜单中查看来源':'Model source in the model menu'),jsx('div',{id:'fixture-picker'},jsx(api.XHarnessModelSelect,{available:true,locked:false,t,directory:fixture.directory.store,load:()=>fixture.directory.load().catch(()=>{}),select:s=>fixture.directory.select(s).then(()=>true,()=>false),manageModels:manage}))),
   jsx(SettingsRoot,{wide:true,subscribeOpenSection:subscribe,useSections:select=>select([{id:'models',order:0,label:lang==='zh'?'模型':'Models'}]),useOnboardingSteps:select=>select([]),useSessions:select=>select({phase:'ready',current:'preview-session',byId:{'preview-session':{blank:false}}}),renderSlot:(name,_owner,opts)=> name==='settings.section'?jsx('div',{'data-testid':'models-settings'},jsx('h2',null,lang==='zh'?'管理模型':'Manage models'),jsx('p',null,lang==='zh'?'这是设置导航预览；未连接 Host，不保存配置。':'Settings navigation preview. No Host connection or configuration writes.')):name==='settings.header'?(lang==='zh'?'设置':'Settings'):name==='settings.close'?(lang==='zh'?'关闭':'Close'):null})
  )
 }
 ReactDOM.createRoot(document.getElementById('root')).render(jsx(App));
})
