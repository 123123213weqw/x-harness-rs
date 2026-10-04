import {detail,page,summary,GitHubError} from './client'
import type {GitHubClient,Identity,Page,PullDetail,PullSummary} from './client'
import type {PullLink} from './data'
import type {ReviewStorage} from './storage'
import {ReviewIdleQueue} from './idle'
import type {IdleEnvironment} from './idle'
interface Entry<T>{value:T;expires:number}
interface Bootstrap{identity:Identity;repos:Page<string>}
interface StoredDetail extends Entry<PullDetail>{bytes:number}
const LIST_TTL=60_000,DETAIL_TTL=30_000,RETENTION=24*60*60*1000
const MAX_DETAIL_BYTES=2*1024*1024,MAX_SNAPSHOT_BYTES=2*1024*1024
const key=(account:string,link:PullLink)=>`${account}:${link.repository.toLowerCase()}#${link.id}`
function isObject(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function object(value:unknown):Record<string,unknown>{if(!isObject(value))throw new Error('Invalid cache');return value}
function string(value:unknown):string{if(typeof value!=='string')throw new Error('Invalid cache');return value}
function rows(value:unknown):unknown[]{if(!Array.isArray(value))throw new Error('Invalid cache');return value}
/** Fresh data is reused; expired data remains displayable for one day while
 * refreshing. No cached identity grants access: activate follows live auth.
 */
export class ReviewCache{
 private account:string|undefined
 private boot:Entry<Bootstrap>|undefined
 private lists=new Map<string,Entry<Page<PullSummary>>>()
 private details=new Map<string,StoredDetail>()
 private warmController:AbortController|undefined
 private idle:ReviewIdleQueue|undefined
 private idleClient:GitHubClient|undefined
 private lastViewed:string|undefined
 private generation=0
 private loaded=false
 private restore:Promise<void>|undefined
 private saveTimer:ReturnType<typeof setTimeout>|undefined
 private storageQueue:Promise<void>=Promise.resolve()
 constructor(private readonly now:()=>number=Date.now,private readonly storage?:ReviewStorage){}
 private retained(expires:number):boolean{return Number.isFinite(expires)&&expires>this.now()-RETENTION&&expires<=this.now()+LIST_TTL}
 /** Hydrate only after /user verifies the account. Corrupt/foreign/old snapshots
  * are removed, not trusted. Late restore cannot undo reconnect/account switch.
  */
 async activate(account:string):Promise<void>{
  if(this.account!==undefined&&this.account!==account)this.clear()
  this.account=account
  if(this.loaded){await this.restore;return}
  this.loaded=true
  const pending=this.hydrate(account,this.generation);this.restore=pending
  await pending;if(this.restore===pending)this.restore=undefined
 }
 private async hydrate(account:string,generation:number):Promise<void>{
  try{
   const raw=await this.storage?.read()
   if(generation!==this.generation||this.account!==account||raw===undefined)return
   if(raw.length*2>MAX_SNAPSHOT_BYTES)throw new Error('Oversized cache')
   const snapshot=object(JSON.parse(raw))
   if(snapshot.version!==1||snapshot.account!==account)throw new Error('Foreign cache')
   const expiry=(value:unknown):number=>{if(typeof value!=='number'||!this.retained(value))throw new Error('Expired cache');return value}
   // Validate every row before installing any of it.
   const boot=snapshot.boot===null?undefined:object(snapshot.boot)
   const restoredBoot=boot?{value:{identity:{account,source:'github-cli'},repos:page(boot.value,string)},expires:expiry(boot.expires)}:undefined
   const listRows=rows(snapshot.lists),detailRows=rows(snapshot.details)
   if(listRows.length>3||detailRows.length>3)throw new Error('Too many cache entries')
   const lists=new Map<string,Entry<Page<PullSummary>>>(),details=new Map<string,StoredDetail>()
   for(const row of listRows){const entry=object(row),repository=string(entry.repository),value=page(entry.value,summary);if(value.items.some(item=>item.repository.toLowerCase()!==repository.toLowerCase()))throw new Error('Repository mismatch');lists.set(`${account}:${repository.toLowerCase()}`,{value,expires:expiry(entry.expires)})}
   for(const row of detailRows){const entry=object(row),value=detail(entry.value);details.set(key(account,value),{value,expires:expiry(entry.expires),bytes:JSON.stringify(value).length*2})}
   if(restoredBoot&&!this.boot)this.boot=restoredBoot
   for(const [id,value] of lists)if(!this.lists.has(id))this.lists.set(id,value)
   for(const [id,value] of details)if(!this.details.has(id))this.details.set(id,value)
  }catch{if(generation===this.generation)this.enqueue(undefined)}
 }
 bootstrap(account:string):Bootstrap|undefined {if(!this.boot||!this.retained(this.boot.expires)||this.boot.value.identity.account!==account)return undefined;return this.boot.value}
 bootstrapFresh(account:string):boolean{return this.bootstrap(account)!==undefined&&(this.boot?.expires??0)>this.now()}
 putBootstrap(identity:Identity,repos:Page<string>):void {if(this.account!==undefined&&this.account!==identity.account)this.clear();this.account=identity.account;if(JSON.stringify(repos).length*2>128*1024)return;this.boot={value:{identity,repos},expires:this.now()+LIST_TTL};this.scheduleSave()}
 list(account:string,repository:string):Page<PullSummary>|undefined {const entry=this.lists.get(`${account}:${repository.toLowerCase()}`);if(!entry||!this.retained(entry.expires))return undefined;return entry.value}
 listFresh(account:string,repository:string):boolean{return this.list(account,repository)!==undefined&&(this.lists.get(`${account}:${repository.toLowerCase()}`)?.expires??0)>this.now()}
 putList(account:string,repository:string,value:Page<PullSummary>):void {
  const id=`${account}:${repository.toLowerCase()}`;this.lists.delete(id)
  if(JSON.stringify(value).length*2>512*1024)return
  this.lists.set(id,{value,expires:this.now()+LIST_TTL})
  while(this.lists.size>3){const oldest=this.lists.keys().next().value;if(oldest===undefined)break;this.lists.delete(oldest)}
  // A known new head immediately invalidates the old diff, not just its TTL.
  for(const item of value.items){const entry=this.details.get(key(account,item));if(entry&&entry.value.headSha!==item.headSha)this.details.delete(key(account,item))}
  this.scheduleSave()
 }
 detail(account:string,link:PullLink,headSha?:string):PullDetail|undefined {
  const id=key(account,link),entry=this.details.get(id)
  if(!entry)return undefined
  if(!this.retained(entry.expires)||(headSha!==undefined&&entry.value.headSha!==headSha)){this.details.delete(id);this.scheduleSave();return undefined}
  this.details.delete(id);this.details.set(id,entry);return entry.value
 }
 detailFresh(account:string,link:PullLink,headSha?:string):boolean{return this.detail(account,link,headSha)!==undefined&&(this.details.get(key(account,link))?.expires??0)>this.now()}
 putDetail(account:string,value:PullDetail):void {
  const id=key(account,value),bytes=JSON.stringify(value).length*2;this.details.delete(id)
  if(bytes>MAX_DETAIL_BYTES)return
  this.details.set(id,{value,bytes,expires:this.now()+DETAIL_TTL})
  // A verified detail may observe a commit before the list refresh does.
  const listId=`${account}:${value.repository.toLowerCase()}`,listed=this.lists.get(listId)
  if(listed)this.lists.set(listId,{...listed,value:{...listed.value,items:listed.value.items.map(item=>item.id===value.id?{...item,headSha:value.headSha}:item)}})

  while(this.details.size>3||[...this.details.values()].reduce((sum,row)=>sum+row.bytes,0)>MAX_DETAIL_BYTES){const oldest=this.details.keys().next().value;if(oldest===undefined)break;this.details.delete(oldest)}
  this.scheduleSave()
 }
 private enqueue(value:string|undefined):void{this.storageQueue=this.storageQueue.then(()=>this.storage?.write(value)).catch(()=>{/* Quota/private-mode/storage errors never break GitHub reads. */})}
 private scheduleSave():void{if(!this.storage||this.saveTimer!==undefined)return;this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.persist()},200)}
 /** Persist a bounded newest-first snapshot, never the full pagination history. */
 private persist():Promise<void>{
  if(this.saveTimer!==undefined)clearTimeout(this.saveTimer);this.saveTimer=undefined
  if(this.storage&&this.account){
   const account=this.account,prefix=`${account}:`
   const lists=[...this.lists].filter(([id,row])=>id.startsWith(prefix)&&this.retained(row.expires)).map(([id,row])=>({repository:id.slice(prefix.length),...row}))
   const details=[...this.details].filter(([id,row])=>id.startsWith(prefix)&&this.retained(row.expires)).map(([,row])=>({value:row.value,expires:row.expires}))
   const boot=this.boot&&this.retained(this.boot.expires)?{value:this.boot.value.repos,expires:this.boot.expires}:null
   let raw=JSON.stringify({version:1,account,boot,lists,details})
   while(raw.length*2>MAX_SNAPSHOT_BYTES&&(details.length||lists.length)){if(details.length)details.shift();else lists.shift();raw=JSON.stringify({version:1,account,boot,lists,details})}
   this.enqueue(raw.length*2<=MAX_SNAPSHOT_BYTES?raw:undefined)
  }
  return this.storageQueue
 }
 flush():Promise<void>{return this.persist()}
 clear():void {
  this.generation++;this.warmController?.abort();this.warmController=undefined;this.cancelPrefetch();this.idle?.reset()
  if(this.saveTimer!==undefined)clearTimeout(this.saveTimer);this.saveTimer=undefined
  this.account=undefined;this.loaded=false;this.restore=undefined;this.boot=undefined;this.lists.clear();this.details.clear();this.enqueue(undefined)
 }
 /** Module disposal cancels work, but preserves the bounded disk snapshot. */
 private skipSpeculative(account:string,item:PullSummary):boolean{
  const cached=this.details.get(key(account,item))
  // An older queued/list hint must not evict a newer foreground-verified diff.
  return cached!==undefined&&this.retained(cached.expires)&&(cached.value.headSha!==item.headSha||cached.expires>this.now())
 }
 dispose():void{void this.flush();this.generation++;this.warmController?.abort();this.idle?.dispose();this.idle=undefined;this.idleClient=undefined}
 startIdle(client:GitHubClient,environment:IdleEnvironment):void {
  this.idle?.dispose();this.idleClient=client
  this.idle=new ReviewIdleQueue(environment,error=>!(error instanceof GitHubError)||!['head_changed','not_found'].includes(error.kind))
  this.idle.enqueue('bootstrap',signal=>this.warm(client,signal))
 }
 foreground():(success?:boolean)=>void{return this.idle?.foreground()??(()=>{})}
 viewed(account:string,item:PullLink):void{this.lastViewed=key(account,item);this.cancelPrefetch()}
 /** At most two automatic details from the loaded first page, recent PR first.
  * No polling, page walking, all-repository or all-PR downloads.
  */
 scheduleDetails(account:string,items:readonly PullSummary[]):void {
  const client=this.idleClient,queue=this.idle;if(!client||!queue)return
  const recent=items.find(item=>key(account,item)===this.lastViewed)
  const shortlist=(recent?[recent,...items.filter(item=>item!==recent)]:items).slice(0,2)
  queue.remove('auto-0');queue.remove('auto-1')
  for(const [index,item] of shortlist.entries())if(!this.skipSpeculative(account,item))queue.enqueue(`auto-${index}`,signal=>this.readSpeculative(client,account,item,signal))
 }
 private async readSpeculative(client:GitHubClient,account:string,item:PullSummary,signal:AbortSignal):Promise<void>{
  if(this.skipSpeculative(account,item))return
  const generation=this.generation,value=await client.detail(account,item.repository,item.id,signal)
  if(!signal.aborted&&generation===this.generation&&this.account===account&&value.headSha===item.headSha)this.putDetail(account,value)
 }
 async warm(client:GitHubClient,signal?:AbortSignal):Promise<void> {
  this.warmController?.abort()
  const controller=new AbortController(),generation=this.generation;this.warmController=controller
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
  const current=()=>generation===this.generation&&!controller.signal.aborted
  try{
   const identity=await client.auth(controller.signal);if(!current())return
   await this.activate(identity.account);if(!current())return
   const cached=this.bootstrap(identity.account)
   const repos=this.bootstrapFresh(identity.account)&&cached?cached.repos:await client.repos(identity.account,1,controller.signal)
   if(!current())return;if(!this.bootstrapFresh(identity.account))this.putBootstrap(identity,repos)
   const repository=repos.items[0]
   if(repository){let value=this.list(identity.account,repository);if(!this.listFresh(identity.account,repository)){value=await client.pulls(identity.account,repository,1,controller.signal);if(current())this.putList(identity.account,repository,value)}if(current()&&value)this.scheduleDetails(identity.account,value.items)}
  }catch(error:unknown){if(current())throw error}finally{signal?.removeEventListener('abort',abort)}
 }
 prefetch(client:GitHubClient,account:string,item:PullSummary):void {
  this.cancelPrefetch();if(this.skipSpeculative(account,item))return
  this.idle?.enqueue('hover',signal=>this.readSpeculative(this.idleClient??client,account,item,signal),10,350)
 }
 cancelPrefetch():void{this.idle?.remove('hover')}
}
