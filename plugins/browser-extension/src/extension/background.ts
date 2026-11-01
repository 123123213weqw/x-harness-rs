import {HOST_NAME,command,object,text,id,tabId,httpOrigin,failure,mayMutate,type Command} from '../protocol.js'
import {observeDom,resolveRef,invalidateObservation} from './dom.js'
interface Client {contextId:string;contextLabel:string}
interface Remembered {contextId:string;origin:string}
interface Grant {clientId:string;origin:string;generation:string;active:boolean;held?:{kind:'mouse';x:number;y:number}|{kind:'key';key:string;code:string;windowsVirtualKeyCode:number};pending?:{url:string;loaderId?:string}}
let port:chrome.runtime.Port|undefined,connected=false,lastError=''
const clients=new Map<string,Client>(),grants=new Map<number,Grant>(),cancelled=new Set<string>()
const queues=new Map<number,Promise<void>>()
let outstanding=0,authorizationEpoch=0,screenshotBusy=false
const granting=new Set<number>(),retiring=new Set<number>()
const remembered=new Map<number,Remembered>()
let retryMinutes=0.5
let autoConnect=false,persistTail=Promise.resolve(),restoreTail=Promise.resolve()
const RETRY='xharness-native-reconnect'
function saveBindings():Promise<void> {
  const rows=[...remembered].map(([target,binding])=>({tabId:target,...binding}))
  persistTail=persistTail.catch(()=>{}).then(()=>chrome.storage.session.set({bindings:rows}))
  return persistTail
}
function forget(target:number):void {remembered.delete(target);void saveBindings().catch(()=>{})}
const initialized=(async()=>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
  const settings=await chrome.storage.local.get('autoConnect')
  autoConnect=settings.autoConnect===true
  const state=await chrome.storage.session.get('bindings')
  if(Array.isArray(state.bindings))for(const value of state.bindings.slice(0,16)){
    try{const row=object(value),contextId=text(row.contextId,64);if(!/^[a-f0-9]{64}$/.test(contextId))continue;remembered.set(tabId(row.tabId),{contextId,origin:httpOrigin(row.origin)})}catch{/* Malformed entries are never authority. */}
  }
})()
function retryConnection():void {
  if(autoConnect){void chrome.alarms.create(RETRY,{delayInMinutes:retryMinutes});retryMinutes=Math.min(5,retryMinutes*2)}
}
function restoreBindings():void {
  restoreTail=restoreTail.catch(()=>{}).then(async()=>{
    const epoch=authorizationEpoch
    for(const [target,binding]of remembered){
      if(!connected||epoch!==authorizationEpoch)return
      const matches=[...clients].filter(([,client])=>client.contextId===binding.contextId)
      if(matches.length!==1)continue // Ambiguous/replayed contexts never select an arbitrary owner.
      const client=matches[0];if(!client||grants.has(target)||granting.has(target)||retiring.has(target)||queues.has(target))continue
      try{await authorize(target,client[0],binding)}catch{/* Restore never changes site or tab scope. */}
    }
  })
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===RETRY)void initialized.then(()=>{if(autoConnect&&!port)connectNative()})})
chrome.runtime.onStartup.addListener(()=>{void initialized.then(()=>{if(autoConnect)connectNative()})})
void initialized.then(()=>{if(autoConnect)connectNative()}).catch(()=>{lastError='Could not load private browser preferences'})
function updateBadge():void {
  const count=grants.size
  void chrome.action.setBadgeText({text:count?String(count):''})
  void chrome.action.setBadgeBackgroundColor({color:count?'#6e59e8':'#777777'})
}
async function releaseHeld(target:number,grant:Grant):Promise<void> {
  const held=grant.held;delete grant.held
  if(!held)return
  if(held.kind==='mouse')await cdp(target,'Input.dispatchMouseEvent',{type:'mouseReleased',x:held.x,y:held.y,button:'left',clickCount:1})
  else await cdp(target,'Input.dispatchKeyEvent',{type:'keyUp',key:held.key,code:held.code,windowsVirtualKeyCode:held.windowsVirtualKeyCode})
}
function settleBounded(task:Promise<unknown>):Promise<void> {
  return new Promise(resolve=>{const timer=setTimeout(resolve,1000);const done=()=>{clearTimeout(timer);resolve()};void task.then(done,done)})
}
async function retire(target:number,grant:Grant|undefined):Promise<void> {
  retiring.add(target)
  try{
    if(grant)await settleBounded(releaseHeld(target,grant))
    await settleBounded(chrome.scripting.executeScript({target:{tabId:target},func:invalidateObservation}))
    await settleBounded(chrome.debugger.detach({tabId:target}))
  }finally{retiring.delete(target)}
}
async function revoke(target:number):Promise<void> {
  forget(target)
  const grant=grants.get(target);grants.delete(target);updateBadge();await retire(target,grant)
}
async function stop(clientId?:string,preserveBindings=false):Promise<void> {
  authorizationEpoch++
  if(!preserveBindings){
    const context=clientId?clients.get(clientId)?.contextId:undefined
    for(const [target,binding]of remembered)if(!clientId||context===binding.contextId||grants.get(target)?.clientId===clientId)remembered.delete(target)
  }
  const targets=[...grants].filter(([,grant])=>!clientId||grant.clientId===clientId)
  // Revoke every lease synchronously before waiting for gesture cleanup/detach.
  for(const [target] of targets)grants.delete(target)
  updateBadge();await Promise.all([...(preserveBindings?[]:[saveBindings()]),...targets.map(([target,grant])=>retire(target,grant))])
}
function disconnect():void {
  connected=false;port=undefined;clients.clear();void stop(undefined,true).finally(()=>{restoreBindings();retryConnection()})
}
function connectNative():void {
  if(port)return
  lastError='';const next=chrome.runtime.connectNative(HOST_NAME);port=next
  const handshake=setTimeout(()=>{if(port===next&&!connected)next.disconnect()},8000)
  next.onDisconnect.addListener(()=>{clearTimeout(handshake);if(port!==next)return;lastError=chrome.runtime.lastError?.message??'Disconnected';disconnect()})
  next.onMessage.addListener((value:unknown)=>{
    if(port!==next)return
    try{
      const message=object(value)
      if(message.type==='ready'){if(message.version!==1)throw Error('Bridge version mismatch');clearTimeout(handshake);connected=true;retryMinutes=0.5;void chrome.alarms.clear(RETRY);restoreBindings();return}
      const clientId=id(message.clientId)
      if(message.type==='client'){
        if(clients.size>=16&&!clients.has(clientId))throw Error('Client limit reached')
        const contextId=text(message.contextId,64),contextLabel=text(message.contextLabel,96)
        if(!/^[a-f0-9]{64}$/.test(contextId))throw Error('Invalid Host conversation identity')
        const existing=clients.get(clientId);if(existing&&(existing.contextId!==contextId||existing.contextLabel!==contextLabel))throw Error('Conversation identity changed')
        clients.set(clientId,{contextId,contextLabel})
        const duplicates=[...clients].filter(([,client])=>client.contextId===contextId)
        if(duplicates.length>1)for(const [duplicate]of duplicates)void stop(duplicate,true)
        else restoreBindings()
        return
      }
      if(message.type==='clientGone'){void stop(clientId,true).finally(()=>restoreBindings());clients.delete(clientId);return}
      const requestId=id(message.requestId),key=clientId+':'+requestId
      if(message.type==='cancel'){if(cancelled.size<256)cancelled.add(key);setTimeout(()=>cancelled.delete(key),30000);void stop(clientId);return}
      if(message.type!=='command'||!clients.has(clientId))throw Error('Invalid browser command')
      const op=command(message.command)
      if(outstanding>=16){next.postMessage({type:'result',clientId,requestId,result:failure(Error('Browser queue is full'))});return}
      outstanding++
      const target='tabId'in op?op.tabId:-1,admittedGrant=grants.get(target)
      if(target!==-1&&(!admittedGrant||admittedGrant.clientId!==clientId)){
        outstanding--;next.postMessage({type:'result',clientId,requestId,result:failure(Error('Authorize this tab for this conversation first'))});return
      }
      const old=queues.get(target)??Promise.resolve()
      const run=old.then(async()=>{
        let dispatched=false
        try{
          if(port!==next||cancelled.has(key)||target!==-1&&grants.get(target)!==admittedGrant)throw Error('Cancelled, disconnected or authorization changed')
          const result=await execute(clientId,op,()=>{if(port!==next||cancelled.has(key))throw Error('Cancelled or disconnected');dispatched=mayMutate(op)})
          if(port===next&&!cancelled.has(key))next.postMessage({type:'result',clientId,requestId,result})
        }catch(error){if(port===next)next.postMessage({type:'result',clientId,requestId,result:failure(error,dispatched)})}
      }).finally(()=>{outstanding--;cancelled.delete(key);if(queues.get(target)===run)queues.delete(target);restoreBindings()})
      queues.set(target,run)
    }catch(error){lastError=error instanceof Error?error.message:'Invalid bridge message';next.disconnect();disconnect()}
  })
  next.postMessage({type:'hello',version:1})
}
async function lease(clientId:string,target:number):Promise<Grant> {
  const grant=grants.get(target)
  if(!grant||grant.clientId!==clientId||!clients.has(clientId)||[...clients.values()].filter(client=>client.contextId===clients.get(clientId)?.contextId).length!==1)throw Error('This tab is not authorized for this client')
  const tab=await chrome.tabs.get(target)
  if(tab.discarded||object(tab).frozen===true)throw Error('This tab is frozen or discarded; restore it before browser operations')
  if(tab.incognito||httpOrigin(tab.url)!==grant.origin){await revoke(target);throw Error('Tab origin changed; explicit authorization is required')}
  if(grants.get(target)!==grant)throw Error('Tab authorization was revoked')
  if(tab.status==='loading'||grant.pending&&!await navigationReady(target,grant))throw Error('Page is still navigating; wait before another operation')
  return grant
}
function boundedBrowser<T>(target:number,operation:()=>Promise<T>):Promise<T> {
  const leaseAtCall=grants.get(target)
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(leaseAtCall&&grants.get(target)===leaseAtCall)void revoke(target);reject(Error('Browser command timed out; effect may be unknown; do not replay'))},8000)
    try{void operation().then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})}catch(error){clearTimeout(timer);reject(error)}
  })
}
async function cdp(target:number,method:string,params:Record<string,unknown>={}):Promise<unknown> {
  return boundedBrowser(target,()=>chrome.debugger.sendCommand({tabId:target},method,params))
}
async function navigationReady(target:number,grant:Grant):Promise<boolean> {
  const tab=await chrome.tabs.get(target)
  if(httpOrigin(tab.url)!==grant.origin){await revoke(target);throw Error('Navigation left the authorized origin')}
  if(tab.status==='loading')return false
  if(!grant.pending)return true
  const tree=object(object(await cdp(target,'Page.getFrameTree')).frameTree),frame=object(tree.frame)
  if(grant.pending.loaderId?frame.loaderId!==grant.pending.loaderId:new URL(text(frame.url,4096)).href!==new URL(grant.pending.url).href)return false
  delete grant.pending;return true
}
async function execute(clientId:string,op:Command,beforeEffect:()=>void):Promise<Record<string,unknown>> {
  if(op.action==='status')return {ok:true,connected:true,contextId:clients.get(clientId)?.contextId,authorizedTabs:[...grants].filter(([,g])=>g.clientId===clientId).map(([target,g])=>({tabId:target,origin:g.origin})),background:true}
  if(op.action==='tabs'){
    const tabs=[]
    for(const [target,g]of grants)if(g.clientId===clientId){const grant=await lease(clientId,target),tab=await chrome.tabs.get(target);tabs.push({tabId:target,title:tab.title??'',origin:grant.origin,active:tab.active})}
    return {ok:true,tabs}
  }
  if(op.action==='stop'){await stop(clientId);return {ok:true,revoked:true}}
  const target=op.tabId,grant=await lease(clientId,target)
  const current=():void=>{if(grants.get(target)!==grant)throw Error('Authorization revoked');beforeEffect()}
  grant.active=true;updateBadge()
  try{
    if(op.action==='observe'){
      const results=await boundedBrowser(target,()=>chrome.scripting.executeScript({target:{tabId:target},func:observeDom,args:[crypto.randomUUID(),op.cursor??null]}))
      current();const result=results[0]?.result;if(!result)throw Error('Page observation unavailable')
      // Raw DOM URLs and input values are not included by the fixed observer.
      return {ok:true,...result}
    }
    if(op.action==='screenshot'){
      if(screenshotBusy)throw Error('Another screenshot is in progress')
      screenshotBusy=true
      try{const result=object(await cdp(target,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true}))
      current();const data=text(result.data,2_796_204)
      if(!data.startsWith('iVBORw0KGgo')||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('Invalid PNG screenshot')
      if(data.length%4!==0||data.length*3/4-(data.endsWith('==')?2:data.endsWith('=')?1:0)>2097152)throw Error('Screenshot exceeds the PNG byte budget')
      const header=Uint8Array.from(atob(data.slice(0,44)),char=>char.charCodeAt(0)),view=new DataView(header.buffer)
      const width=view.getUint32(16),height=view.getUint32(20)
      if(width<1||height<1||width>8192||height>8192||width*height>16000000)throw Error('Screenshot dimensions exceed the image budget')
      return {ok:true,pngBase64:data,width,height,mediaType:'image/png',untrusted:true}
      }finally{screenshotBusy=false}
    }
    if(op.action==='navigate'){
      if(httpOrigin(op.url)!==grant.origin)throw Error('Navigation leaves the authorized origin')
      await boundedBrowser(target,()=>chrome.scripting.executeScript({target:{tabId:target},func:invalidateObservation}))
      current();grant.pending={url:op.url}
      const result=object(await cdp(target,'Page.navigate',{url:op.url}))
      if(result.errorText)throw Error(text(result.errorText))
      if(typeof result.loaderId==='string')grant.pending.loaderId=text(result.loaderId,128)
      const deadline=Date.now()+10000
      while(!await navigationReady(target,grant)){current();if(Date.now()>deadline)throw Error('Page readiness timed out; inspect before another effect');await new Promise(resolve=>setTimeout(resolve,100))}
      current();return {ok:true,outcome:'applied',ready:true,verificationRequired:true}
    }
    if(op.action==='press'){
      await boundedBrowser(target,()=>chrome.scripting.executeScript({target:{tabId:target},func:invalidateObservation}))
      const codes:Readonly<Record<string,number>>={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowRight:39,ArrowUp:38,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,' ':32}
      current();grant.held={kind:'key',key:op.key,code:op.key===' '?'Space':op.key,windowsVirtualKeyCode:codes[op.key]??0}
      try{await cdp(target,'Input.dispatchKeyEvent',{type:'keyDown',key:grant.held.key,code:grant.held.code,windowsVirtualKeyCode:grant.held.windowsVirtualKeyCode,...(op.key==='Enter'?{text:'\r'}:op.key===' '?{text:' '}:{})});current()}
      finally{if(grants.get(target)===grant)await releaseHeld(target,grant)}
      return {ok:true,outcome:'applied',verificationRequired:true}
    }
    current() // The fixed resolver may scroll/focus; a lost reply is already an uncertain effect.
    const results=await boundedBrowser(target,()=>chrome.scripting.executeScript({target:{tabId:target},func:resolveRef,args:[op.observationId,op.ref,op.action==='fill']}))
    const point=results[0]?.result;if(!point)throw Error('No target geometry')
    current()
    if(op.action==='fill')await cdp(target,'Input.insertText',{text:op.text})
    else{
      grant.held={kind:'mouse',x:point.x,y:point.y}
      try{await cdp(target,'Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});current()}
      finally{if(grants.get(target)===grant)await releaseHeld(target,grant)}
    }
    return {ok:true,outcome:'applied',verificationRequired:true}
  }finally{grant.active=false;updateBadge()}
}
/** The caller is the trusted popup or a saved exact-tab/same-context binding. */
async function authorize(target:number,clientId:string,restoring?:Remembered):Promise<void> {
  const client=clients.get(clientId)
  if(!connected||!client)throw Error('Conversation is no longer connected')
  if([...clients.values()].filter(item=>item.contextId===client.contextId).length!==1)throw Error('Duplicate conversation connections; close the conflicting client first')
  if(grants.size>=16||remembered.size>=16&&!remembered.has(target))throw Error('At most 16 tabs can be authorized at once')
  if(grants.has(target)||granting.has(target)||retiring.has(target)||queues.has(target))throw Error('Stop the current tab owner before authorizing another')
  const epoch=authorizationEpoch;granting.add(target)
  try{
    const tab=await chrome.tabs.get(target),origin=httpOrigin(tab.url)
    if(tab.incognito||tab.discarded||object(tab).frozen===true)throw Error('Restore a normal non-incognito tab first')
    if(restoring&&(restoring.contextId!==client.contextId||restoring.origin!==origin||remembered.get(target)!==restoring)){forget(target);throw Error('Saved authorization is no longer valid')}
    if(!await chrome.permissions.contains({origins:[origin+'/*']})){forget(target);throw Error('Authorize this site from the extension popup first')}
    const valid=():boolean=>connected&&clients.get(clientId)===client&&epoch===authorizationEpoch&&(!restoring||remembered.get(target)===restoring)&&[...clients.values()].filter(item=>item.contextId===client.contextId).length===1
    if(!valid())throw Error('Authorization cancelled')
    await chrome.debugger.attach({tabId:target},'1.3')
    if(!valid()){await retire(target,undefined);throw Error('Conversation disconnected or authorization cancelled')}
    if(httpOrigin((await chrome.tabs.get(target)).url)!==origin||!valid()){await revoke(target);throw Error('Page or authorization changed during attach')}
    if(!restoring){remembered.set(target,{contextId:client.contextId,origin});try{await saveBindings()}catch(error){await revoke(target);throw error}}
    if(!valid()){await retire(target,undefined);throw Error('Authorization cancelled')}
    grants.set(target,{clientId,origin,generation:crypto.randomUUID(),active:false});updateBadge()
  }finally{granting.delete(target)}
}
chrome.debugger.onDetach.addListener(source=>{if(source.tabId!==undefined){grants.delete(source.tabId);if(!retiring.has(source.tabId))forget(source.tabId);updateBadge()}})
chrome.permissions.onRemoved.addListener(()=>{void initialized.then(()=>stop())})
chrome.tabs.onRemoved.addListener(target=>{if(granting.has(target))authorizationEpoch++;void revoke(target)})
chrome.tabs.onUpdated.addListener((target,change)=>{
  if(change.url&&granting.has(target))authorizationEpoch++
  const binding=remembered.get(target);if(!binding||!change.url)return
  try{if(httpOrigin(change.url)!==binding.origin)void revoke(target)}catch{void revoke(target)}
})
// Grant/revoke are only reachable from the packaged popup, never a page or model command.
chrome.runtime.onMessage.addListener((value:unknown,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false
  void (async()=>{
    await initialized
    const message=object(value)
    if(message.action==='connect'){autoConnect=true;await chrome.storage.local.set({autoConnect:true});connectNative()}
    else if(message.action==='stop')await stop()
    else if(message.action==='disconnect'){
      autoConnect=false;const stopped=stop() // revoke live authority before any persistence wait
      try{await Promise.all([stopped,chrome.storage.local.set({autoConnect:false}),chrome.alarms.clear(RETRY)])}
      finally{const old=port;port=undefined;old?.disconnect();disconnect()}
    }
    else if(message.action==='grant'){await authorize(tabId(message.tabId),id(message.clientId))}
    else if(message.action!=='state')throw Error('Unknown popup action')
    const tabs=(await chrome.tabs.query({})).filter(tab=>{try{return !tab.incognito&&!!httpOrigin(tab.url)}catch{return false}}).map(tab=>({id:tab.id,title:tab.title??'',origin:httpOrigin(tab.url)}))
    reply({ok:true,connected,autoConnect,error:lastError,clients:[...clients].map(([clientId,client])=>({clientId,contextId:client.contextId,contextLabel:client.contextLabel,conflict:[...clients.values()].filter(other=>other.contextId===client.contextId).length!==1})),grants:[...grants].map(([target,grant])=>({tabId:target,clientId:grant.clientId,origin:grant.origin,active:grant.active})),tabs})
  })().catch(error=>reply(failure(error)))
  return true
})
