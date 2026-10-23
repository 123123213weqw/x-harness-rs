import type {TauriBridge,NativeUnlisten} from '../shared/tauri'
import {objectValue} from '../shared/runtime-types'

interface ActivityEvent {
  id:string;owner:string;tabId:string
  phase:'started'|'finished'
}

function activityEvent(raw:unknown):ActivityEvent|undefined {
  const value=objectValue(raw)
  if(value.backend!=='embedded'||typeof value.id!=='string'||!/^[1-9]\d{0,19}$/.test(value.id)
    ||typeof value.owner!=='string'||!value.owner||value.owner.length>128
    ||typeof value.tabId!=='string'||!/^[A-Za-z0-9:_-]{1,64}$/.test(value.tabId)
    ||typeof value.operation!=='string'||!['open','close','observe','perform','screenshot','input'].includes(value.operation)
    ||(value.phase!=='started'&&value.phase!=='finished'))return
  return{id:value.id,owner:value.owner,tabId:value.tabId,phase:value.phase}
}

/** Presentation only, scoped to the actual native owner+tab. No timer guesses,
 * commands, persisted state, polling or background-browser activity. A pane
 * arriving after a start may miss that brief highlight; it must not invent one.
 * Provisional opens use their existing authenticated modelRequestId instead. */
export function listenModelBrowserActivity(native:TauriBridge,owner:string,tabId:string,onCount:(count:number)=>void):()=>void {
  let disposed=false
  let unlisten:NativeUnlisten|undefined
  const active=new Set<string>()
  const finished=new Set<string>()
  let retired=0n
  onCount(0)
  void native.event.listen('xharness-browser-activity',event=>{
    if(disposed)return
    const value=activityEvent(event.payload)
    if(!value||value.owner!==owner||value.tabId!==tabId)return
    const before=active.size
    if(value.phase==='finished'){
      active.delete(value.id)
      // Bounded tombstones prevent delayed/duplicate starts resurrecting an
      // ended invocation; native calls are bounded by the existing bridge.
      finished.add(value.id)
      if(finished.size>128){
        const first=finished.values().next().value
        if(first!==undefined){
          finished.delete(first)
          // Native IDs increase process-wide. Once a finish tombstone is
          // evicted, never resurrect an older unknown start. Already-observed
          // in-flight IDs remain active until their own finish arrives.
          const id=BigInt(first);if(id>retired)retired=id
        }
      }
    }else if(BigInt(value.id)>retired&&!finished.has(value.id)&&active.size<16)active.add(value.id)
    if(before!==active.size)onCount(active.size)
  }).then(stop=>{if(disposed)stop();else unlisten=stop}).catch(()=>{
    if(!disposed){active.clear();onCount(0)}
  })
  return()=>{disposed=true;unlisten?.();active.clear();finished.clear();onCount(0)}
}
