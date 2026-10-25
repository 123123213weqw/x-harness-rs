import {object,text,id,tabId} from '../protocol.js'
const status=document.getElementById('status'),error=document.getElementById('error'),clientSelect=document.getElementById('client'),tabSelect=document.getElementById('tab'),authorized=document.getElementById('authorized')
if(!(status instanceof HTMLElement)||!(error instanceof HTMLElement)||!(clientSelect instanceof HTMLSelectElement)||!(tabSelect instanceof HTMLSelectElement)||!(authorized instanceof HTMLElement))throw Error('Missing popup elements')
const stateView={status,error,clientSelect,tabSelect,authorized}
let busy=false
async function refresh(action:Record<string,unknown>={action:'state'}):Promise<void> {
  const result=object(await chrome.runtime.sendMessage(action))
  if(result.ok!==true)throw Error(typeof result.error==='string'?result.error:'Browser extension request failed')
  const clientCount=Array.isArray(result.clients)?result.clients.length:0
  stateView.status.textContent=result.connected?(clientCount?'已连接 · '+clientCount+' 个对话':'桥接就绪 · 等待对话'):'尚未连接'
  stateView.status.dataset.connected=String(result.connected===true)
  stateView.error.textContent=typeof result.error==='string'?result.error:''
  const selectedClient=stateView.clientSelect.value,selectedTab=stateView.tabSelect.value
  stateView.clientSelect.replaceChildren();stateView.tabSelect.replaceChildren();stateView.authorized.replaceChildren()
  if(Array.isArray(result.clients))for(const entry of result.clients){const row=object(entry),option=document.createElement('option');option.value=id(row.clientId);option.textContent='配对码 '+text(row.pairCode,8);stateView.clientSelect.append(option)}
  if(Array.isArray(result.tabs))for(const entry of result.tabs){const row=object(entry),option=document.createElement('option');option.value=String(tabId(row.id));option.textContent=(text(row.title,2000)||text(row.origin,4096)).slice(0,80);option.dataset.origin=text(row.origin,4096);stateView.tabSelect.append(option)}
  if(stateView.clientSelect.options.length===0){const option=document.createElement('option');option.value='';option.textContent='先在对话中获取配对码';stateView.clientSelect.append(option)}
  if(stateView.tabSelect.options.length===0){const option=document.createElement('option');option.value='';option.textContent='请先打开一个网页';stateView.tabSelect.append(option)}
  if([...stateView.clientSelect.options].some(item=>item.value===selectedClient))stateView.clientSelect.value=selectedClient
  if([...stateView.tabSelect.options].some(item=>item.value===selectedTab))stateView.tabSelect.value=selectedTab
  if(Array.isArray(result.grants))for(const entry of result.grants){const row=object(entry),line=document.createElement('li');line.textContent=(row.active?'操作中 · ':'已授权 · ')+text(row.origin,4096);stateView.authorized.append(line)}
  if(stateView.authorized.childElementCount===0){const line=document.createElement('li');line.textContent='尚未授权标签页';line.className='empty';stateView.authorized.append(line)}
  const grant=document.getElementById('grant');if(grant instanceof HTMLButtonElement)grant.disabled=!result.connected||!stateView.clientSelect.value||!stateView.tabSelect.value
}
for(const name of ['connect','refresh','stop','disconnect','grant'])document.getElementById(name)?.addEventListener('click',()=>{
  if(busy)return;busy=true;stateView.error.textContent=''
  void (async()=>{
    if(name==='grant'){
      const option=stateView.tabSelect.selectedOptions[0],origin=option?.dataset.origin
      if(!origin)throw Error('请选择一个网页标签')
      // Permission request starts directly from the popup user gesture. The model cannot grant it.
      const allowed=await chrome.permissions.request({origins:[origin+'/*']})
      if(!allowed)throw Error('未授权该网站')
      await refresh({action:'grant',clientId:stateView.clientSelect.value,tabId:Number(stateView.tabSelect.value)})
    }else await refresh({action:name==='refresh'?'state':name})
  })().catch(error=>{stateView.error.textContent=error instanceof Error?error.message:'连接失败'}).finally(()=>{busy=false})
})
void refresh().catch(error=>{stateView.error.textContent=error instanceof Error?error.message:'连接失败'})
// Popup-only status refresh: closing the popup removes the timer; no page polling.
const timer=setInterval(()=>{if(!busy)void refresh().catch(()=>{})},1500)
addEventListener('pagehide',()=>clearInterval(timer),{once:true})
