import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {DisplayInspectionSchema} from './generated/file-display'
import type {DisplayInspection} from './generated/file-display'
export type {DisplayInspection} from './generated/file-display'
export function validateInspection(value:unknown):DisplayInspection{
 const info=DisplayInspectionSchema.parse(value)
 if(!info.path||info.path.length>4096||info.path.includes('\0')||!Number.isSafeInteger(info.bytes)||info.bytes<0)throw Error('Invalid file metadata')
 if(info.width!=null&&(!Number.isSafeInteger(info.width)||info.width<1)||info.height!=null&&(!Number.isSafeInteger(info.height)||info.height<1))throw Error('Invalid image dimensions')
 if(info.modifiedMs!=null&&(!Number.isSafeInteger(info.modifiedMs)||info.modifiedMs<0||info.modifiedMs>8640000000000000))throw Error('Invalid modified time')
 const thumb=info.thumbnail
 if(thumb&&(thumb.width<1||thumb.height<1||thumb.width>96||thumb.height>96||thumb.dataBase64.length>65536||thumb.dataBase64.length%4!==0||!thumb.dataBase64.startsWith('iVBORw0KGgo')||!(/^[A-Za-z0-9+/]*={0,2}$/).test(thumb.dataBase64)))throw Error('Invalid thumbnail')
 return info
}
interface Queued {signal:AbortSignal;start():void;cancel():void}
/** Per-connection bounded metadata cache. No object URLs or full document bytes. */
export class FileInspectionCache {
 private readonly cache=new Map<string,{time:number;value:DisplayInspection}>()
 private readonly queue:Queued[]=[]
 private active=0
 private unavailableUntil=0
 constructor(private readonly rpc:ClientConnectionRpc){}
 async read(sessionId:string,path:string,revision:number,thumbnail:boolean,signal:AbortSignal):Promise<DisplayInspection|undefined>{
  signal.throwIfAborted()
  const key=JSON.stringify([sessionId,path,revision,thumbnail]),now=Date.now(),cached=this.cache.get(key)
  if(cached&&now-cached.time<15000){this.cache.delete(key);this.cache.set(key,cached);return cached.value}
  if(now<this.unavailableUntil)return undefined
  if(this.queue.length>=64)throw Error('File metadata queue is full')
  return new Promise((resolve,reject)=>{
   let started=false
   const cancel=()=>{if(!started){const at=this.queue.indexOf(job);if(at>=0)this.queue.splice(at,1);reject(new DOMException('Aborted','AbortError'))}}
   const job:Queued={signal,cancel,start:()=>{
    started=true;signal.removeEventListener('abort',cancel);this.active++
    void this.fetch(sessionId,path,thumbnail,signal).then(value=>{
     if(value&&!signal.aborted){this.cache.set(key,{time:Date.now(),value});this.trim()}
     signal.throwIfAborted();resolve(value)
    }).catch(reject).finally(()=>{this.active--;this.pump()})
   }}
   signal.addEventListener('abort',cancel,{once:true});this.queue.push(job);this.pump()
  })
 }
 private async fetch(sessionId:string,path:string,thumbnail:boolean,signal:AbortSignal):Promise<DisplayInspection|undefined>{
  if(Date.now()<this.unavailableUntil)return undefined
  const reply=await this.rpc.call('/api','display/inspect',{sessionId,path,thumbnail},AbortSignal.any([signal,AbortSignal.timeout(10000)]))
  if(!reply.ok){
   // Old Hosts are normal. A missing file must not disable other inspections.
   if(/unknown (?:endpoint|method)|inspection is unavailable/i.test(reply.error.message))this.unavailableUntil=Date.now()+30000
   return undefined
  }
  return validateInspection(reply.value)
 }
 private pump():void{while(this.active<2&&this.queue.length){const next=this.queue.shift();if(!next)break;if(next.signal.aborted)next.cancel();else next.start()}}
 private trim():void{
  let bytes=0;for(const item of this.cache.values())bytes+=item.value.thumbnail?.dataBase64.length??0
  while(this.cache.size>24||bytes>1024*1024){const key=this.cache.keys().next().value;if(key===undefined)break;bytes-=this.cache.get(key)?.value.thumbnail?.dataBase64.length??0;this.cache.delete(key)}
 }
 /** Diagnostics expose budgets, never filenames or content. */
 get stats():{entries:number;active:number;queued:number}{return{entries:this.cache.size,active:this.active,queued:this.queue.length}}
}
export function thumbnailObjectUrl(info:DisplayInspection):string|undefined{
 const data=info.thumbnail?.dataBase64;if(!data)return undefined
 const binary=atob(data);if(binary.length>48*1024)throw Error('Oversized thumbnail')
 return URL.createObjectURL(new Blob([Uint8Array.from(binary,char=>char.charCodeAt(0))],{type:'image/png'}))
}
