/** Current master/source persisted owned pages on the actual platform and
 * actual runtime engine. No snapshot-store/defineStore proxy is substituted. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const deps=process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps',require=createRequire(resolve(deps,'package.json')),{chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER??'chromium',implementation=process.env.UI_TEST_IMPL??'source'
const modules=[['@xharness/dsh-client-runtime','client-runtime'],...['workspace','trajectory','theme','layout'].map(name=>['@xharness/dsh-client-ui-'+name,name])]
const outputs=implementation==='source'?compileSourceModules('ui',modules.map(([id,name])=>({id,source:'src/modules/'+name+'/index.ts'}))):undefined
const featureSeams={workspace:['src/modules/workspace/stores.js','createWorkspaceViewStore'],trajectory:['src/modules/trajectory/duration-store.js','createTrajectoryDurationStore'],theme:['src/modules/theme/settings-store.js','createAppearanceRowStore'],layout:['src/modules/layout/stores.js','createLayoutStore']}
const codes=modules.map(([id,name])=>{
 let code=outputs?.get(id).bytes.toString()??readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8')
 if(name!=='client-runtime'){
  const [path,helper]=featureSeams[name]
  if(implementation==='legacy')code=code.replace('return module.exports;',`exports.${helper}=${helper};return module.exports;`)
  else{const pattern=/return __load\(("[^"\n]+")\);\n\}\n\}\);\s*$/;assert.ok(pattern.test(code));code=code.replace(pattern,`return { ...__load($1), ...__load(${JSON.stringify(path)}) };\n}\n});`)}
 }
 return code
})
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try{
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewPlatform(page,implementation)
 await page.evaluate(()=>{window.registrations=[];window.__ModuleLoader__={load:row=>registrations.push(row)}})
 for(const content of codes)await page.addScriptTag({content})
 const result=await page.evaluate(implementation=>{
  const exported={};for(const row of registrations)exported[row.id]=row.factory(name=>{if(name==='@xharness/dsh-client-runtime/client')return exported['@xharness/dsh-client-runtime'];if(name in staticModules)return staticModules[name];throw Error(name)})
  const workspace=exported['@xharness/dsh-client-ui-workspace'],trajectory=exported['@xharness/dsh-client-ui-trajectory'],theme=exported['@xharness/dsh-client-ui-theme'],layout=exported['@xharness/dsh-client-ui-layout']
  const check=(condition,message)=>{if(!condition)throw Error(message)}
  const workspaceKey='dsh.workspace.view.v5',durationKey='dsh.trajectory.duration',saved={groupBy:'flat',orderBy:'manual',groupExpansion:{w:true,old:false},sessionOrderByAccount:{w:['s2','s1'],old:['old']},sessionUpdatedAtByAccount:{w:{s1:1,s2:2},old:{old:3}},foreign:{kept:['opaque',17],nested:{custom:true}}}
  localStorage.setItem(workspaceKey,JSON.stringify(saved));const handle=workspace.createWorkspaceViewStore(),instance=handle.create();check(JSON.stringify(instance.getSnapshot())===JSON.stringify(saved),'legal v5 account and foreign fields rehydrate verbatim')
  const foreign=instance.getSnapshot().foreign;let notices=0;const off=instance.subscribe(()=>notices++)
  instance.actions.setGroupBy('workspace');instance.actions.setOrderBy('updated');instance.actions.setGroupExpanded('w',false);instance.actions.syncSessionOrderAccount('w',['s3','s2','s1'],{s1:1,s2:2,s3:3});instance.actions.setSessionOrder('w',['s1','s3','s2']);instance.actions.retainAccountKeys(['w'])
  check(notices===6,'all six real bound actions publish once');check(instance.getSnapshot().foreign===foreign,'foreign fields remain original identity through own draft writes');off();const after=instance.getSnapshot();check(!('old' in after.groupExpansion)&&!('old' in after.sessionOrderByAccount)&&!('old' in after.sessionUpdatedAtByAccount),'only stale account keys are pruned');check(JSON.stringify(JSON.parse(localStorage.getItem(workspaceKey)))===JSON.stringify(after),'persisted account matches live state');check(JSON.stringify(handle.create().getSnapshot())===JSON.stringify(after),'legal remount retains updated order')
  // Scoped create keeps the exact historical suffix. Clearing the scoped key never clears root.
  const scoped=handle.create('s');check(scoped.getSnapshot().groupBy==='workspace','scoped initial state isolated');scoped.actions.setGroupBy('flat');check(JSON.parse(localStorage.getItem(workspaceKey+'.s')).groupBy==='flat','session suffix storage name');scoped.clearPersisted();check(localStorage.getItem(workspaceKey+'.s')===null&&localStorage.getItem(workspaceKey)!==null,'scoped persistence clearing')
  const durationValues=[];for(const value of [true,false]){localStorage.setItem(durationKey,JSON.stringify(value));const store=trajectory.createTrajectoryDurationStore();check(store.getSnapshot()===value,'legal persisted boolean');store.set(!value);check(JSON.parse(localStorage.getItem(durationKey))===!value,'scalar is not object-spread');check(trajectory.createTrajectoryDurationStore().getSnapshot()===!value,'scalar remount');durationValues.push(value)}
  const appearance=theme.createAppearanceRowStore().create();let appearanceNotices=0;appearance.subscribe(()=>appearanceNotices++);appearance.actions.sync('dark',3);const themeState=appearance.getSnapshot();appearance.actions.sync('light',2);check(appearance.getSnapshot()===themeState&&appearanceNotices===1,'stale appearance sync remains exact no-op')
  const frame=layout.createLayoutStore().create();frame.actions.setSidebar(10);frame.actions.setDetails(900);frame.actions.setNarrow(true);frame.actions.toggleSidebar();check(frame.getSnapshot().narrowExpanded===true,'narrow override');frame.actions.setNarrow(false);check(frame.getSnapshot().narrowExpanded===false&&frame.getSnapshot().sidebar===264,'widen retains clamped preference');frame.actions.closeDetails();check(frame.getSnapshot().details===0,'close details');frame.actions.openDetails();check(frame.getSnapshot().details===360,'reopen details')
  // Syntax failures already fell back in frozen JS. Typed shape validation is
  // new source-owned boundary hardening, not claimed invalid-value parity.
  const warnings=[],original=console.error;console.error=(...args)=>warnings.push(String(args[0]));let badShape
  try{
   localStorage.setItem(workspaceKey,'{');check(workspace.createWorkspaceViewStore().create().getSnapshot().groupBy==='workspace','invalid JSON retains initial state');check(localStorage.getItem(workspaceKey)==='{','failed read does not erase storage')
   localStorage.setItem(durationKey,'{');check(trajectory.createTrajectoryDurationStore().getSnapshot()===false,'invalid boolean JSON fallback')
   localStorage.setItem(workspaceKey,'{"groupBy":"unknown"}');const bad=workspace.createWorkspaceViewStore().create().getSnapshot();badShape=implementation==='source'?'rejected':'raw-legacy';check(implementation==='source'?bad.groupBy==='workspace':bad.groupBy==='unknown','explicit invalid-shape boundary behavior');check(localStorage.getItem(workspaceKey)==='{"groupBy":"unknown"}','shape rejection never clears stored value')
   localStorage.setItem(durationKey,'"foreign"');check(implementation==='source'?trajectory.createTrajectoryDurationStore().getSnapshot()===false:trajectory.createTrajectoryDurationStore().getSnapshot()==='foreign','explicit invalid-scalar boundary behavior')
  }finally{console.error=original}
  check(warnings.length===(implementation==='source'?4:2),'only expected rehydration diagnostics')
  return{workspace:after,notices,durationValues,theme:themeState,appearanceNotices,layout:frame.getSnapshot(),badShape,expectedRehydrationDiagnostics:warnings.length}
 },implementation)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,implementation,actualPlatform:true,actualRuntimeEngine:true,legalForeignStoragePreserved:true,scopedStorageAndClear:true,allConcreteActionsBound:true,primitivePersistence:true,invalidStorageNotDeleted:true,invalidShapeBoundaryIsExplicit:true,result,pageErrors:errors}))
}finally{await browser.close()}
