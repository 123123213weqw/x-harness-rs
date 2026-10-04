import type {ReviewStorage} from './storage'
export interface ReviewSelection {repository:string;mine:boolean;recent:string[]}
const empty=():ReviewSelection=>({repository:'',mine:false,recent:[]})
export function validRepository(value:unknown):value is string{return typeof value==='string'&&value.length<=201&&value.split('/').length===2&&value.split('/').every(part=>part.length>0&&part.length<=100&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.-]+$/.test(part))}
function isObject(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function decode(raw:string,account:string):ReviewSelection {
 if(raw.length>8192)return empty()
 const value:unknown=JSON.parse(raw)
 if(!isObject(value)||value.version!==1||value.account!==account||!validRepository(value.repository)||typeof value.mine!=='boolean'||!Array.isArray(value.recent)||value.recent.length>6)return empty()
 const recent:unknown[]=value.recent
 if(!recent.every(validRepository))return empty()
 return {repository:value.repository,mine:value.mine,recent:[...new Set(recent)]}
}
/** Account-scoped UI choices only. Separate from response-cache invalidation;
 * no credential, token, PR body or permission grant is persisted here.
 */
export class ReviewPreferences {
 private account:string|undefined
 private value=empty()
 private generation=0
 private operations:Promise<void>=Promise.resolve()
 constructor(private readonly storage?:ReviewStorage){}
 async activate(account:string):Promise<ReviewSelection>{
  if(account===this.account){await this.operations;return this.current(account)}
  this.account=account;this.value=empty();const generation=++this.generation
  this.operations=this.operations.then(async()=>{
   if(this.account!==account||this.generation!==generation)return
   try{const raw=await this.storage?.read();if(this.account===account&&this.generation===generation&&raw!==undefined)this.value=decode(raw,account)}catch{/* Storage is optional. */}
  })
  await this.operations;return this.current(account)
 }
 current(account:string):ReviewSelection {return this.account===account?{...this.value,recent:[...this.value.recent]}:empty()}
 select(account:string,repository:string,mine:boolean):ReviewSelection {
  if(this.account!==account||!validRepository(repository))return this.current(account)
  this.generation++;this.value={repository,mine,recent:[repository,...this.value.recent.filter(item=>item!==repository)].slice(0,6)}
  const raw=JSON.stringify({version:1,account,...this.value})
  this.operations=this.operations.then(()=>this.storage?.write(raw)).catch(()=>{/* Quota/private-mode failure never prevents a selection. */})
  return this.current(account)
 }
 flush():Promise<void>{return this.operations}
}
export interface RepositoryGroup {label:'recent'|'other';items:string[]}
export function repositoryGroups(repositories:readonly string[],recent:readonly string[],query:string):RepositoryGroup[]{
 const match=query.trim().toLowerCase(),all=[...new Set(repositories)].filter(item=>item.toLowerCase().includes(match))
 const known=new Set(all),recentItems=[...new Set(recent)].filter(item=>known.has(item)).slice(0,6),recentSet=new Set(recentItems)
 const groups:RepositoryGroup[]=[{label:'recent',items:recentItems},{label:'other',items:all.filter(item=>!recentSet.has(item))}]
 return groups.filter(group=>group.items.length>0)
}
