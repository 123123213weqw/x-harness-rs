/** Actual shipped Work projection + Session/Workspace managers + typed API. */
import {ownedViewModuleTestInput} from '../owned-view-module-test-input.mjs'
import {exposeModuleUnit} from './module-unit-scope.mjs'
export async function installWorkCatalogFixture(page) {
  const source = ownedViewModuleTestInput('@xharness/dsh-client-runtime')
  await page.evaluate(() => {window.__workRegistrations=[]; window.__ModuleLoader__={load: row=>__workRegistrations.push(row)}})
  for(const [unit,name] of [['work/catalog','WorkCatalog'],['sessions/manager','SessionManager'],['workspaces/manager','WorkspaceManager']])
    await page.addScriptTag({content:exposeModuleUnit(source,'client-runtime',unit,name)})
  await page.addScriptTag({content:ownedViewModuleTestInput('@xharness/dsh-client-connection')})
  await page.evaluate(() => {
    const imports=id=>{if(id in staticModules)return staticModules[id];throw Error('Work fixture unexpected import '+id)}
    const modules=__workRegistrations.map(row=>row.factory(imports))
    const [{WorkCatalog},{SessionManager},{WorkspaceManager},connection]=modules
    class FixtureCarrier extends connection.AbstractApiClient {doFetch(input, options){return fetch(input,options)}}
    const api=new FixtureCarrier()
    // Publish the actual Connection handle without starting a second stream pump.
    // Schedule's tool-card contribution now consumes the same RPC owner as production.
    connection.apply({provide:(name, handle)=>{if(name==='connection')window.workConnection=handle}})
    const sessions=new SessionManager(api,{}),workspaces=new WorkspaceManager(api)
    const sessionList={subscribe:fn=>sessions.subscribe(fn),getSnapshot:()=>{
      const snap=sessions.getListSnapshot(),byId={}
      for(const row of snap.items)byId[row.sessionId]={...row,id:row.sessionId,projectionValues:row.projectionValues}
      return {ids:snap.items.map(row=>row.sessionId),byId,phase:snap.phase}
    }}
    const port={forgetDeletedSessions:ids=>sessions.forgetDeletedSessions(ids),list:sessionList,refresh:()=>sessions.refreshList(),catalogStatus:()=>sessions.getListSnapshot(),fork:async payload=>{const result=await sessions.fork(payload);if(!result.ok)throw Error(result.error.message);return result.value.sessionId}}
    const workspacePort={forgetDeletedSessions:ids=>workspaces.forgetDeletedSessions(ids),list:{subscribe:fn=>workspaces.subscribe(fn),getSnapshot:()=>workspaces.getSnapshot()},refresh:()=>workspaces.refresh(),archivedSummaries:()=>workspaces.archivedSummaries(),archiveSession:async id=>{const result=await workspaces.archiveSession(id);if(!result.ok)throw Error(result.error.message)}}
    window.workCatalog=new WorkCatalog(api,port,workspacePort)
    window.workManagers={sessions,workspaces,api}
  })
}
