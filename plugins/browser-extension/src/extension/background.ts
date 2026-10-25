import {HOST_NAME,command,object,text,id,tabId,httpOrigin,failure,mayMutate,type Command} from '../protocol.js'
import {observeDom,resolveRef,invalidateObservation} from './dom.js'
interface Client {pairCode:string}
interface Grant {clientId:string;origin:string;generation:string;active:boolean;held?:{kind:'mouse';x:number;y:number}|{kind:'key';key:string;code:string;windowsVirtualKeyCode:number};pending?:{url:string;loaderId?:string}}
let port:chrome.runtime.Port|undefined,connected=false,lastError=''
const clients=new Map<string,Client>(),grants=new Map<number,Grant>(),cancelled=new Set<string>()
const queues=new Map<number,Promise<void>>()
let outstanding=0,authorizationEpoch=0,screenshotBusy=false
const granting=new Set<number>(),retiring=new Set<number>()
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
    await settleBounded(chrome.debugger.detach({tabId:target}))
  }finally{retiring.delete(target)}
}
async function revoke(target:number):Promise<void> {
  const grant=grants.get(target);grants.delete(target);updateBadge();await retire(target,grant)
}
async function stop(clientId?:string):Promise<void> {
  authorizationEpoch++
  const targets=[...grants].filter(([,grant])=>!clientId||grant.clientId===clientId)
  // Revoke every lease synchronously before waiting for gesture cleanup/detach.
  for(const [target] of targets)grants.delete(target)
  updateBadge();await Promise.all(targets.map(([target,grant])=>retire(target,grant)))
}
function disconnect():void {
  connected=false;port=undefined;clients.clear();void stop()
}
function connectNative():void {
  if(port)return
  lastError='';const next=chrome.runtime.connectNative(HOST_NAME);port=next
  next.onDisconnect.addListener(()=>{if(port!==next)return;lastError=chrome.runtime.lastError?.message??'Disconnected';disconnect()})
  next.onMessage.addListener((value:unknown)=>{
    if(port!==next)return
    try{
      const message=object(value)
      if(message.type==='ready'){if(message.version!==1)throw Error('Bridge version mismatch');connected=true;return}
      const clientId=id(message.clientId)
      if(message.type==='client'){if(clients.size>=16&&!clients.has(clientId))throw Error('Client limit reached');clients.set(clientId,{pairCode:text(message.pairCode,8)});return}
      if(message.type==='clientGone'){clients.delete(clientId);void stop(clientId);return}
      const requestId=id(message.requestId),key=clientId+':'+requestId
      if(message.type==='cancel'){if(cancelled.size<256)cancelled.add(key);setTimeout(()=>cancelled.delete(key),30000);void stop(clientId);return}
      if(message.type!=='command'||!clients.has(clientId))throw Error('Invalid browser command')
      const op=command(message.command)
      if(outstanding>=16){next.postMessage({type:'result',clientId,requestId,result:failure(Error('Browser queue is full'))});return}
      outstanding++
      const target='tabId'in op?op.tabId:-1,admittedGrant=grants.get(target)
      if(target!==-1&&(!admittedGrant||admittedGrant.clientId!==clientId)){
        outstanding--;next.postMessage({type:'result',clientId,requestId,result:failure(Error('Authorize this tab for this pairing code first'))});return
      }
      const old=queues.get(target)??Promise.resolve()
      const run=old.then(async()=>{
        let dispatched=false
        try{
          if(port!==next||cancelled.has(key)||target!==-1&&grants.get(target)!==admittedGrant)throw Error('Cancelled, disconnected or authorization changed')
          const result=await execute(clientId,op,()=>{if(port!==next||cancelled.has(key))throw Error('Cancelled or disconnected');dispatched=mayMutate(op)})
          if(port===next&&!cancelled.has(key))next.postMessage({type:'result',clientId,requestId,result})
        }catch(error){if(port===next)next.postMessage({type:'result',clientId,requestId,result:failure(error,dispatched)})}
      }).finally(()=>{outstanding--;cancelled.delete(key);if(queues.get(target)===run)queues.delete(target)})
      queues.set(target,run)
    }catch(error){lastError=error instanceof Error?error.message:'Invalid bridge message';next.disconnect();disconnect()}
  })
  next.postMessage({type:'hello',version:1})
}
async function lease(clientId:string,target:number):Promise<Grant> {
  const grant=grants.get(target)
  if(!grant||grant.clientId!==clientId||!clients.has(clientId))throw Error('This tab is not authorized for this client')
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
  if(op.action==='status')return {ok:true,connected:true,pairCode:clients.get(clientId)?.pairCode,authorizedTabs:[...grants].filter(([,g])=>g.clientId===clientId).map(([target,g])=>({tabId:target,origin:g.origin})),background:true}
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
      const results=await boundedBrowser(target,()=>chrome.scripting.executeScript({target:{tabId:target},func:observeDom,args:[crypto.randomUUID()]}))
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
chrome.debugger.onDetach.addListener(source=>{if(source.tabId!==undefined){grants.delete(source.tabId);updateBadge()}})
chrome.permissions.onRemoved.addListener(()=>{void stop()})
chrome.tabs.onRemoved.addListener(target=>{void revoke(target)})
chrome.tabs.onUpdated.addListener((target,change)=>{
  const grant=grants.get(target);if(!grant||!change.url)return
  try{if(httpOrigin(change.url)!==grant.origin)void revoke(target)}catch{void revoke(target)}
})
// Grant/revoke are only reachable from the packaged popup, never a page or model command.
chrome.runtime.onMessage.addListener((value:unknown,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false
  void (async()=>{
    const message=object(value)
    if(message.action==='connect')connectNative()
    else if(message.action==='stop')await stop()
    else if(message.action==='disconnect'){await stop();port?.disconnect();disconnect()}
    else if(message.action==='grant'){
      const target=tabId(message.tabId),clientId=id(message.clientId)
      if(!connected||!clients.has(clientId))throw Error('Pairing client is no longer connected')
      if(grants.size>=16)throw Error('At most 16 tabs can be authorized at once')
      if(grants.has(target)||granting.has(target)||retiring.has(target)||queues.has(target))throw Error('Stop the current tab owner before authorizing another')
      const epoch=authorizationEpoch;granting.add(target)
      try{const tab=await chrome.tabs.get(target),origin=httpOrigin(tab.url)
      if(tab.incognito)throw Error('Incognito tabs are not supported')
      if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw Error('Authorize this site from the extension popup first')
      if(!connected||!clients.has(clientId)||epoch!==authorizationEpoch)throw Error('Authorization cancelled')
      await chrome.debugger.attach({tabId:target},'1.3')
      if(!connected||!clients.has(clientId)||epoch!==authorizationEpoch){await revoke(target);throw Error('Client disconnected or authorization cancelled')}
      if(httpOrigin((await chrome.tabs.get(target)).url)!==origin){await revoke(target);throw Error('Page changed during authorization')}
      grants.set(target,{clientId,origin,generation:crypto.randomUUID(),active:false});updateBadge()
      }finally{granting.delete(target)}
    }else if(message.action!=='state')throw Error('Unknown popup action')
    const tabs=(await chrome.tabs.query({})).filter(tab=>{try{return !tab.incognito&&!!httpOrigin(tab.url)}catch{return false}}).map(tab=>({id:tab.id,title:tab.title??'',origin:httpOrigin(tab.url)}))
    reply({ok:true,connected,error:lastError,clients:[...clients].map(([clientId,client])=>({clientId,pairCode:client.pairCode})),grants:[...grants].map(([target,grant])=>({tabId:target,clientId:grant.clientId,origin:grant.origin,active:grant.active})),tabs})
  })().catch(error=>reply(failure(error)))
  return true
})
