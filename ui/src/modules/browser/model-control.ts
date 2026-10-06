import type { TauriBridge, NativeUnlisten } from '../shared/tauri'
import { objectValue } from '../shared/runtime-types'

export interface ModelBrowserOpen {requestId:string;owner:string;url:string}
export function modelBrowserOpen(raw:unknown):ModelBrowserOpen|undefined {
  const value=objectValue(raw)
  if(typeof value.requestId!=='string'||!/^[0-9a-f]{32}$/.test(value.requestId)
    ||typeof value.owner!=='string'||!value.owner||value.owner.length>128||typeof value.url!=='string'||value.url.length>4096)return
  try {
    const url=new URL(value.url)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return
    return{requestId:value.requestId,owner:value.owner,url:url.href}
  }catch{return}
}
export interface ModelBrowserUI {
  currentOwner():string
  ready():boolean
  open(request:ModelBrowserOpen):void
  cancel(requestId:string):void
}
/** Always mounted at AppFrame, even when settings or another center occludes
 * the browser. Events never change the selected chat or borrow its identity. */
export function listenModelBrowser(native:TauriBridge,ui:ModelBrowserUI):()=>void {
  let disposed=false
  const unlisten:NativeUnlisten[]=[]
  const requests=new Set<string>()
  const recent:string[]=[]
  const remember=(id:string)=>{if(!recent.includes(id)){recent.push(id);if(recent.length>128)recent.shift()}}
  const bind=(event:string,handle:(raw:unknown)=>void)=>{
    void native.event.listen(event,event=>{if(!disposed)handle(event.payload)}).then(stop=>{
      if(disposed)stop();else unlisten.push(stop)
    }).catch(()=>{})
  }
  bind('xharness-browser-control-open',raw=>{
    const request=modelBrowserOpen(raw)
    if(!request)return
    if(recent.includes(request.requestId))return
    remember(request.requestId)
    if(ui.currentOwner()!==request.owner||!ui.ready()){
      void native.core.invoke('desktop_browser_control_reply',{requestId:request.requestId,reply:{status:'failed'}}).catch(()=>{})
      return
    }
    requests.add(request.requestId)
    ui.open(request)
  })
  bind('xharness-browser-control-cancel',raw=>{
    if(typeof raw!=='string'||!/^[0-9a-f]{32}$/.test(raw))return
    remember(raw)
    if(!requests.delete(raw))return
    ui.cancel(raw)
  })
  // Ready tabs no longer need a cancellation tombstone. Native controls ignore
  // late replies; marking completion is local-only and contains no page data.
  const settled=(event:Event)=>{
    if(event instanceof CustomEvent&&typeof event.detail==='string')requests.delete(event.detail)
  }
  window.addEventListener('xharness:browser-control-settled',settled)
  return()=>{
    disposed=true;unlisten.forEach(stop=>stop())
    window.removeEventListener('xharness:browser-control-settled',settled)
    for(const requestId of requests){
      ui.cancel(requestId)
      void native.core.invoke('desktop_browser_control_reply',{requestId,reply:{status:'failed'}}).catch(()=>{})
    }
    requests.clear()
  }
}
