// Browser interaction acceptance of current retained bundle versus TS source.
import assert from 'node:assert/strict'
import{readFileSync}from'node:fs';import{createRequire}from'node:module';import{resolve}from'node:path';
import{compileSourceModules}from'./build-source-modules.mjs';
const id='@xharness/dsh-client-ui-settings-models';
const names=['ModelsSection','ModelListEditor','ProviderEditor','CustomProviderCard'];
const source=process.env.UI_TEST_IMPL==='legacy'?readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8').replace('return module.exports;',`Object.assign(exports,{${names.join(',')}});return module.exports;`):compileSourceModules('ui',[{id,source:'src/modules/settings-models/test-exports.ts'}]).get(id).bytes.toString();
const deps=process.env.UI_TEST_DEPS??'/tmp/xharness-model-ui-tests',require=createRequire(resolve(deps,'package.json'));const{chromium,webkit}=require('playwright');const engine=process.env.UI_TEST_BROWSER??'chromium';const browser=await({chromium,webkit}[engine]).launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:780}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent('<html><head></head><body><div id="root" style="width:650px"></div></body></html>');
 for(const file of ['react/umd/react.development.js','react-dom/umd/react-dom.development.js'])await page.addScriptTag({path:resolve(deps,'node_modules',file)});
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>window.registration=row}'});await page.addScriptTag({content:source});
 await page.evaluate(()=>{
  const jsx=(type,props,key)=>React.createElement(type,key===undefined?props:{...props,key});const Button=({variant,size,...props})=>jsx('button',props);const Modal=props=>props.open?jsx('div',{role:'dialog','aria-label':props.title,children:[jsx('button',{'aria-label':props.closeLabel,onClick:props.onClose,children:props.closeLabel}),props.children,props.footer]}):null;
  window.plugin=registration.factory(name=>name==='react'?React:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:React.Fragment}:name==='@xharness/dsh-client-ui-primitives'?new Proxy({Button,Modal},{get:(o,k)=>o[k]??(()=>null)}):{createSnapshotStore:initial=>{let current=initial;const listeners=new Set();return{getSnapshot:()=>current,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},set:next=>{current=next;for(const f of listeners)f()},update:f=>{current={...current};f(current);for(const l of listeners)l()}}}});
  window.root=ReactDOM.createRoot(document.getElementById('root'));window.mode='models';window.models=[{id:'existing',contextWindow:32768,maxTokens:4096,unknown:{keep:true},reasoning:{efforts:[{id:'ultra'}]}}];window.calls=[];window.closes=[];window.modelsDisabled=false;window.modelProtocol='openai-completions';window.failKeys=true;window.failProbe=false;window.conflict=false;
  window.api={llm:{discoverModels:async p=>{calls.push(['discover',p]);if(failProbe)throw Error('probe offline');return{result:{ok:true,value:{models:[{id:'existing',contextWindow:999999},{id:'new',name:'New',imageInput:true,contextWindow:262144,maxTokens:49152,reasoning:{defaultEffort:'low',efforts:[{id:'off'},{id:'high'}]}},{id:'no-image',imageInput:false}]}}}}},credentials:{describe:async()=>({result:{ok:true,value:{credentials:{TEST_API_KEY:{configured:true,writable:true}}}}}),set:async p=>{calls.push(['key',p]);return failKeys?{result:{ok:false,error:{message:'key unavailable'}}}:{result:{ok:true,value:{}}}}},settings:{mutate:async p=>{calls.push(['mutate',p]);return conflict?{result:{ok:false,error:{code:'settings-conflict',message:'conflict'}}}:{result:{ok:true,value:{...namespace,user:nextUser(p.ops),revision:8}}}}}};
  const getPath=(v,p)=>p.reduce((v,k)=>v?.[k],v);const setPath=(v,p,next)=>{const result=structuredClone(v);let target=result;for(const k of p.slice(0,-1)){target[k]??={};target=target[k]}target[p.at(-1)]=next;return result};const deletePath=(v,p)=>{const result=structuredClone(v);let target=result;for(const k of p.slice(0,-1)){if(!target[k])return result;target=target[k]}delete target[p.at(-1)];return result};
  window.namespace={ns:'llm-pi-ai',revision:7,schema:{},base:{providers:{}},user:{providers:{test:{api:'openai-completions',baseURL:'https://old.example',models:[{id:'existing',contextWindow:32768,maxTokens:4096,unknown:{keep:true}}],extension:{keep:true}}}},value:{providers:{test:{api:'openai-completions',baseURL:'https://old.example',models:[{id:'existing',contextWindow:32768,maxTokens:4096,unknown:{keep:true}}],extension:{keep:true}}}}};
  window.nextUser=ops=>ops.reduce((v,op)=>op.op==='set'?setPath(v,op.path,op.value):deletePath(v,op.path),namespace.user);
  window.schema={rehydrate:()=>({meta:{}}),nodeAtPath:(_root,path)=>path.at(-1)==='api'?{type:'union',list:[{value:'openai-completions'},{value:'openai-responses'}],meta:{}}:{meta:{}},validate:()=>undefined,getPath,hasPath:(v,p)=>getPath(v,p)!==undefined,setPath,deletePath};
  const t=k=>k;
  window.render=()=>ReactDOM.flushSync(()=>root.render(mode==='models'?jsx(plugin.ModelListEditor,{key:mode,models,onChange:next=>{models=next;render()},probe:{settingsNs:'llm-pi-ai',provider:'test',baseURL:'https://probe.example',api:modelProtocol},api,t,disabled:modelsDisabled}):mode==='custom'?jsx(plugin.CustomProviderCard,{key:mode,taken:['taken'],protocols:['openai-completions','openai-responses'],revision:7,api,t,readOnly:false,onClose:changed=>closes.push(changed)}):jsx(plugin.ProviderEditor,{key:mode,provider:'test',displayName:'Test',namespace,schema,settingsPath:['providers','test'],api,t,declared:true,readOnly:mode==='readonly',onClose:changed=>closes.push(changed)})));render();
 });
 await page.getByRole('button',{name:'fetchModels',exact:true}).click();await page.getByRole('dialog',{name:'fetchTitle'}).waitFor();assert.equal(await page.getByLabel('existing',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('new',{exact:true}).isChecked(),true);await page.getByRole('button',{name:'fetchAdopt',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>models[1].reasoning),{defaultEffort:'low',efforts:[{id:'off'},{id:'high'}]});assert.equal(await page.evaluate(()=>models[0].contextWindow),32768);
 // Actual capability controls preserve absent vs explicitly false and reject read-only writes.
 assert.equal(await page.evaluate(()=>models[1].imageInput),true);assert.equal(await page.evaluate(()=>models[2].imageInput),false);
 await page.getByRole('button',{name:'modelAdvanced 1',exact:true}).click();const capability=page.getByRole('checkbox',{name:'支持图片输入 1',exact:true});assert.equal(await capability.isChecked(),false);await page.getByText('视觉能力未声明；请确认模型 API 支持后启用。',{exact:true}).waitFor();
 await capability.check();assert.equal(await page.evaluate(()=>models[0].imageInput),true);assert.deepEqual(await page.evaluate(()=>models[0].unknown),{keep:true});await capability.uncheck();assert.equal(await page.evaluate(()=>models[0].imageInput),false);await page.getByText('不支持视觉时明确报错，不自动丢弃图片。',{exact:true}).waitFor();
 await page.evaluate(()=>{modelsDisabled=true;render()});assert.equal(await capability.isDisabled(),true);assert.equal(await capability.isChecked(),false);await page.evaluate(()=>{modelsDisabled=false;render()});
 // Explicit local-server recipes: selecting alone must not edit a draft.
 if(process.env.UI_TEST_IMPL!=='legacy'){
  const recipe=page.getByRole('combobox',{name:'reasoningRecipe 1',exact:true});
  const apply=page.getByRole('button',{name:'reasoningApply 1',exact:true});
  assert.equal(await apply.isDisabled(),true);
  await recipe.selectOption('enable-thinking');
  assert.deepEqual(await page.evaluate(()=>models[0].reasoning),{efforts:[{id:'ultra'}]});
  await apply.click();
  assert.deepEqual(await page.evaluate(()=>models[0].reasoning),{default_effort:'on',efforts:[{id:'off',name:'Off',request_patch:{chat_template_kwargs:{enable_thinking:false}}},{id:'on',name:'On',request_patch:{chat_template_kwargs:{enable_thinking:true}}}]});
  assert.equal(await recipe.inputValue(),'keep');assert.equal(await apply.isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>models[1].reasoning),{defaultEffort:'low',efforts:[{id:'off'},{id:'high'}]});
  assert.deepEqual(await page.evaluate(()=>models[0].unknown),{keep:true});assert.equal(await page.evaluate(()=>models[0].contextWindow),32768);
  await recipe.selectOption('native-effort');await apply.click();
  assert.deepEqual(await page.evaluate(()=>models[0].reasoning.efforts.map(e=>e.id)),['low','medium','high']);
  await recipe.selectOption('disabled');await apply.click();assert.equal(await page.evaluate(()=>models[0].reasoning),null);
  await page.evaluate(()=>{modelsDisabled=true;render()});assert.equal(await recipe.isDisabled(),true);assert.equal(await apply.isDisabled(),true);
  await page.evaluate(()=>{modelsDisabled=false;modelProtocol='openai-responses';render()});assert.equal(await recipe.count(),0);
  await page.evaluate(()=>{modelProtocol='openai-completions';render()});
 }
 // Keeping buffer text while typing and reindexing after deleting a row.
 await page.getByRole('button',{name:'modelAdvanced 2',exact:true}).click();await page.getByRole('textbox',{name:'modelContextWindow 2',exact:true}).fill('1M');assert.equal(await page.evaluate(()=>models[1].contextWindow),1000000);
 if(process.env.UI_TEST_IMPL!=='legacy')await page.getByRole('combobox',{name:'reasoningRecipe 2',exact:true}).selectOption('thinking');await page.getByRole('button',{name:'removeModel 1',exact:true}).click();if(process.env.UI_TEST_IMPL!=='legacy'){assert.equal(await page.getByRole('combobox',{name:'reasoningRecipe 1',exact:true}).inputValue(),'thinking');await page.getByRole('button',{name:'reasoningApply 1',exact:true}).click();assert.equal(await page.evaluate(()=>models[0].reasoning.efforts[1].request_patch.chat_template_kwargs.thinking),true);}assert.equal(await page.getByRole('textbox',{name:'modelContextWindow 1',exact:true}).inputValue(),'1M');await page.getByRole('textbox',{name:'modelMaxTokens 1',exact:true}).fill('bad');assert.equal(await page.getByRole('textbox',{name:'modelMaxTokens 1',exact:true}).inputValue(),'bad');
 await page.evaluate(()=>{failProbe=true});await page.getByRole('button',{name:'fetchModels',exact:true}).click();await page.getByText('probe offline',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'fetchModels',exact:true}).isEnabled(),true);
 // Custom create keeps profile committed when the separate credential write fails.
 await page.evaluate(()=>{mode='custom';render()});await page.getByRole('textbox',{name:'customRoute',exact:true}).fill('1bad');await page.getByText('customRouteInvalid',{exact:true}).waitFor();await page.getByRole('textbox',{name:'customRoute',exact:true}).fill('custom');await page.getByRole('textbox',{name:'baseUrl',exact:true}).fill('https://custom.example');await page.getByLabel('keyInput',{exact:true}).fill(' sk-test ');await page.getByRole('button',{name:'addModel',exact:true}).click();await page.getByRole('textbox',{name:'modelId 1',exact:true}).fill('coder');await page.getByRole('button',{name:'create',exact:true}).click();await page.getByText('key unavailable',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'customRoute',exact:true}).isDisabled(),true);
 const creates=await page.evaluate(()=>calls.filter(c=>c[0]==='mutate'));assert.equal(creates.length,1);assert.equal(creates[0][1].expectedRevision,7);assert.equal(creates[0][1].ops[0].value.apiKeyEnv,'CUSTOM_API_KEY');
 await page.evaluate(()=>{failKeys=false});await page.getByRole('button',{name:'create',exact:true}).click();await page.waitForFunction(()=>closes.length===1);assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='mutate').length),1);assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='key').at(-1)[1].value),'sk-test');
 // Existing provider: hidden fields survive, conflicts and key-only retry remain actionable.
 await page.evaluate(()=>{mode='editor';calls=[];closes=[];failKeys=true;render()});await page.getByText('customized',{exact:true}).click();await page.getByRole('textbox',{name:'baseUrl',exact:true}).fill('https://new.example');await page.getByLabel('keyInput',{exact:true}).fill('sk-new');await page.getByRole('button',{name:'apply',exact:true}).click();await page.getByText('key unavailable',{exact:true}).waitFor();const edits=await page.evaluate(()=>calls.filter(c=>c[0]==='mutate'));assert.equal(edits.length,1);assert.deepEqual(edits[0][1].ops.map(o=>o.path.at(-1)),['baseURL','apiKeyEnv']);assert.equal(edits[0][1].expectedRevision,7);
 await page.evaluate(()=>{failKeys=false});await page.getByRole('button',{name:'apply',exact:true}).click();await page.waitForFunction(()=>closes.length===1);assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='mutate').length),1);
 if(process.env.UI_TEST_IMPL!=='legacy'){
  // End-to-end provider draft save: only models change; hidden settings survive.
  await page.evaluate(()=>{mode='editor-recipe';calls=[];closes=[];render()});
  await page.getByText('customized',{exact:true}).click();
  await page.getByRole('button',{name:'modelAdvanced 1',exact:true}).click();
  await page.getByRole('combobox',{name:'reasoningRecipe 1',exact:true}).selectOption('native-effort');
  await page.getByRole('button',{name:'reasoningApply 1',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='mutate').length),0);
  await page.getByRole('button',{name:'apply',exact:true}).click();
  await page.waitForFunction(()=>closes.length===1);
  const saved=await page.evaluate(()=>calls.find(c=>c[0]==='mutate')[1]);
  assert.equal(saved.expectedRevision,7);assert.deepEqual(saved.ops.map(o=>o.path),[['providers','test','models']]);
  assert.equal(saved.ops[0].value[0].reasoning.default_effort,'medium');
  assert.deepEqual(saved.ops[0].value[0].unknown,{keep:true});
  assert.equal(saved.ops[0].value[0].contextWindow,32768);
  await page.evaluate(()=>{mode='editor-recipe-cancel';calls=[];closes=[];render()});
  await page.getByText('customized',{exact:true}).click();await page.getByRole('button',{name:'modelAdvanced 1',exact:true}).click();
  await page.getByRole('combobox',{name:'reasoningRecipe 1',exact:true}).selectOption('disabled');await page.getByRole('button',{name:'reasoningApply 1',exact:true}).click();
  await page.getByRole('button',{name:'cancel',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='mutate').length),0);assert.equal(await page.evaluate(()=>closes[0]),false);
 }
 await page.evaluate(()=>{mode='editor-conflict';conflict=true;render()});await page.getByText('customized',{exact:true}).click();await page.getByRole('textbox',{name:'baseUrl',exact:true}).fill('https://conflict.example');await page.getByRole('button',{name:'apply',exact:true}).click();await page.getByText('conflict',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'cancel',exact:true}).isEnabled(),true);
 await page.evaluate(()=>{mode='readonly';render()});assert.equal(await page.getByRole('button',{name:'apply',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'cancel',exact:true}).isEnabled(),true);
 // A legacy hidden minimum can contradict an edited visible maximum. Reject
 // before RPC, then permit a valid edit and preserve the hidden/user metadata.
 if(process.env.UI_TEST_IMPL!=='legacy'){
  await page.evaluate(()=>{calls=[];closes=[];conflict=false;failKeys=false;mode='editor-budget-invalid';namespace.user.providers.test.models[0].minimumOutputTokens=8192;render()});
  await page.getByText('model 1: modelOutputBudgetInvalid',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'apply',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='mutate').length),0);
  await page.getByText('customized',{exact:true}).click();
  await page.getByRole('button',{name:'modelAdvanced 1',exact:true}).click();
  await page.getByRole('textbox',{name:'modelMaxTokens 1',exact:true}).fill('32K');
  assert.equal(await page.getByRole('button',{name:'apply',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'apply',exact:true}).click();
  await page.waitForFunction(()=>closes.length===1);
  const saved=await page.evaluate(()=>calls.find(c=>c[0]==='mutate')[1].ops.find(op=>op.path.at(-1)==='models').value[0]);
  assert.equal(saved.maxTokens,32000);assert.equal(saved.minimumOutputTokens,8192);assert.deepEqual(saved.unknown,{keep:true});
 }
 await page.evaluate(()=>root.unmount());assert.deepEqual(errors,[]);console.log(`${engine} ${process.env.UI_TEST_IMPL??'source'}: discovery/reasoning/imageInput capability checkbox/read-only, capacity buffers/reindex, probe failure, custom partial retry, minimal edits, conflicts/read-only passed`);
}finally{await browser.close()}
