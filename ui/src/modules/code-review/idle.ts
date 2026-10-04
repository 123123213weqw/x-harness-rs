/** Cooperative best-effort work, not a CPU utilization meter. One cancellable
 * job at a time; never force work through an idle timeout or a busy frame.
 */
export interface IdleBudget {timeRemaining():number}
export interface IdleEnvironment {
 now():number
 ready():boolean
 request(run:(budget:IdleBudget)=>void):()=>void
 delay(run:()=>void,ms:number):()=>void
 listen(change:()=>void,input:()=>void):()=>void
}
interface Job {key:string;run(signal:AbortSignal):Promise<void>;priority:number;notBefore:number}
export class ReviewIdleQueue {
 private jobs=new Map<string,Job>()
 private active:{job:Job;controller:AbortController}|undefined
 private cancelScheduled:(()=>void)|undefined
 private unlisten:()=>void
 private foregroundCount=0
 private quietUntil:number
 private stopped=false
 private blocked=false
 constructor(private readonly env:IdleEnvironment,private readonly shouldStop:(error:unknown)=>boolean=()=>true){
  this.quietUntil=env.now()+1500
  this.unlisten=env.listen(()=>{if(!env.ready())this.yield();else this.schedule()},()=>this.input())
 }
 enqueue(key:string,run:Job['run'],priority=0,delayMs=0):void {
  if(this.stopped)return
  if(this.active?.job.key===key)this.active.controller.abort()
  this.jobs.delete(key);this.jobs.set(key,{key,run,priority,notBefore:this.env.now()+delayMs})
  while(this.jobs.size>6){const oldest=[...this.jobs.values()].find(job=>job!==this.active?.job);if(!oldest)break;this.jobs.delete(oldest.key)}
  this.schedule()
 }
 remove(key:string):void{this.jobs.delete(key);if(this.active?.job.key===key)this.active.controller.abort()}
 private yield():void{this.cancelScheduled?.();this.cancelScheduled=undefined;this.active?.controller.abort()}
 private input():void{this.quietUntil=this.env.now()+1500;this.yield();this.schedule()}
 /** Frontend requests do not wait for speculative requests to settle. */
 foreground(): (success?:boolean)=>void {
  this.foregroundCount++;this.input();let released=false
  return success=>{if(released)return;released=true;this.foregroundCount--;if(success)this.blocked=false;this.quietUntil=this.env.now()+1500;this.schedule()}
 }
 reset():void{this.yield();this.jobs.clear();this.blocked=false;this.quietUntil=this.env.now()+1500}
 private schedule():void {
  if(this.stopped||this.blocked||this.foregroundCount||this.active||this.cancelScheduled||!this.jobs.size||!this.env.ready())return
  const wait=Math.max(this.quietUntil-this.env.now(),Math.min(...[...this.jobs.values()].map(job=>job.notBefore))-this.env.now())
  if(wait>0){this.cancelScheduled=this.env.delay(()=>{this.cancelScheduled=undefined;this.schedule()},wait);return}
  this.cancelScheduled=this.env.request(budget=>{
   this.cancelScheduled=undefined
   if(!this.env.ready()||this.foregroundCount||this.stopped||this.blocked)return
   if(budget.timeRemaining()<8){this.quietUntil=this.env.now()+250;this.schedule();return}
   const job=[...this.jobs.values()].filter(job=>job.notBefore<=this.env.now()).sort((a,b)=>b.priority-a.priority)[0];if(!job)return
   const controller=new AbortController();this.active={job,controller}
   void job.run(controller.signal).catch((error:unknown)=>{
    if(!controller.signal.aborted&&this.shouldStop(error)){this.blocked=true;this.jobs.clear()}
   }).finally(()=>{
    if(!controller.signal.aborted&&this.jobs.get(job.key)===job)this.jobs.delete(job.key)
    this.active=undefined;this.quietUntil=Math.max(this.quietUntil,this.env.now()+250);this.schedule()
   })
  })
 }
 dispose():void{this.stopped=true;this.yield();this.jobs.clear();this.unlisten()}
}
export class BrowserIdleEnvironment implements IdleEnvironment {
 now():number{return performance.now()}
 ready():boolean{return document.visibilityState==='visible'&&navigator.onLine}
 delay(run:()=>void,ms:number):()=>void{const timer=window.setTimeout(run,ms);return()=>window.clearTimeout(timer)}
 request(run:(budget:IdleBudget)=>void):()=>void {
  if(typeof window.requestIdleCallback==='function'){const id=window.requestIdleCallback(run);return()=>window.cancelIdleCallback(id)}
  // WebKit fallback: defer, then measure a frame. Background tabs never force it.
  let frame:number|undefined
  const timer=window.setTimeout(()=>{frame=window.requestAnimationFrame(start=>run({timeRemaining:()=>Math.max(0,16-(performance.now()-start))}))},80)
  return()=>{window.clearTimeout(timer);if(frame!==undefined)window.cancelAnimationFrame(frame)}
 }
 listen(change:()=>void,input:()=>void):()=>void {
  const events=['pointerdown','keydown','wheel','scroll','touchstart']
  for(const name of events)document.addEventListener(name,input,{capture:true,passive:true})
  document.addEventListener('visibilitychange',change);window.addEventListener('online',change);window.addEventListener('offline',change)
  return()=>{for(const name of events)document.removeEventListener(name,input,true);document.removeEventListener('visibilitychange',change);window.removeEventListener('online',change);window.removeEventListener('offline',change)}
 }
}
