import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {ACTIVE,parseCatalog,parseOutput,type JobCatalog,type JobOutput,type RunRef,type Cursor} from './model'
export type JobCommand = {action:'list'} | {action:'output';reference:RunRef;cursor?:Cursor} | {action:'cancel_run';reference:RunRef} | {action:'pause_plan'|'resume_plan'|'cancel_future';planId:string}
export interface JobSnapshot {catalog?:JobCatalog;error?:string;loading:boolean}
interface Node {snapshot:JobSnapshot;listeners:Set<()=>void>;seq:number;timer?:ReturnType<typeof setTimeout>|undefined;request?:Promise<void>|undefined;controller?:AbortController|undefined}
/** One owner per connection, one in-flight read per observed session. Polls are
 * transport reads, not model calls. Idle/unmounted/hidden scopes stop polling. */
export class JobClient {
  private nodes=new Map<string,Node>()
  private connected=true
  constructor(private readonly rpc:ClientConnectionRpc) {}
  private node(session:string):Node {let n=this.nodes.get(session);if(!n){n={snapshot:{loading:false},listeners:new Set(),seq:0};this.nodes.set(session,n)}return n}
  snapshot(session:string):JobSnapshot {return this.node(session).snapshot}
  private publish(n:Node,snapshot:JobSnapshot) {n.snapshot=snapshot;for(const listener of [...n.listeners]){try{listener()}catch(error){console.error('Job projection listener failed',error)}}}
  subscribe(session:string,listener:()=>void):()=>void {
    const n=this.node(session);n.listeners.add(listener)
    if(n.listeners.size===1)void this.refresh(session)
    const visible=()=>{if(!document.hidden)void this.refresh(session)}
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',visible)
    return ()=>{n.listeners.delete(listener);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visible);if(!n.listeners.size){clearTimeout(n.timer);n.controller?.abort();n.seq++;n.request=undefined;n.controller=undefined;n.snapshot={loading:false}}}
  }
  reset(connected:boolean) {
    this.connected=connected
    for(const [id,n] of this.nodes){clearTimeout(n.timer);n.controller?.abort();n.seq++;n.request=undefined;n.controller=undefined;this.publish(n,{loading:false,...(connected?{}:{error:'Host connection unavailable'})});if(connected&&n.listeners.size)void this.refresh(id)}
  }
  private async call(session:string,command:JobCommand,signal?:AbortSignal):Promise<unknown> {
    const controller=new AbortController(),abort=()=>controller.abort()
    if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true})
    const timeout=setTimeout(abort,15_000)
    try {const result=await this.rpc.call('/api','job/manage',{sessionId:session,command},controller.signal);if(!result.ok)throw Error(result.error.message);return result.value}
    finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
  }
  refresh(session:string):Promise<void> {
    const n=this.node(session)
    if(n.request)return n.request
    if(!this.connected||typeof document!=='undefined'&&document.hidden)return Promise.resolve()
    clearTimeout(n.timer)
    const seq=++n.seq,controller=new AbortController();n.controller=controller
    const request=Promise.resolve().then(()=>this.call(session,{action:'list'},controller.signal)).then(raw=>{
      if(seq!==n.seq)return
      const catalog=parseCatalog(raw,session);this.publish(n,{catalog,loading:false})
    }).catch((error:unknown)=>{if(seq===n.seq)this.publish(n,{loading:false,error:error instanceof Error?error.message:String(error)})}).finally(()=>{
      if(seq!==n.seq)return
      n.request=undefined;n.controller=undefined
      const c=n.snapshot.catalog
      const delay=n.snapshot.error?15_000:c?.runs.some(r=>ACTIVE.has(r.state))?1500:c?.plans.some(p=>p.state==='scheduled'||p.state==='overdue')?15_000:undefined
      if(delay!==undefined&&n.listeners.size&&this.connected)n.timer=setTimeout(()=>void this.refresh(session),delay)
    })
    n.request=request;this.publish(n,{...n.snapshot,loading:true});return request
  }
  async control(session:string,command:Exclude<JobCommand,{action:'list'}|{action:'output'}>):Promise<void> {
    const receipt=await this.call(session,command)
    if(receipt===null||typeof receipt!=='object'||!('version' in receipt)||receipt.version!==1||!('accepted' in receipt)||receipt.accepted!==true)throw Error('Invalid Job control receipt')
    const n=this.node(session);clearTimeout(n.timer);n.controller?.abort();n.seq++;n.request=undefined
    if(n.listeners.size)await this.refresh(session);else n.snapshot={loading:false}
  }
  async output(session:string,reference:RunRef,signal?:AbortSignal,cursor?:Cursor):Promise<JobOutput> {return parseOutput(await this.call(session,{action:'output',reference,...(cursor?{cursor}:{})},signal),session,reference)}
}
