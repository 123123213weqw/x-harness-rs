import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
export interface PullSummary {id:number;repository:string;title:string;author:string;updatedAt:string;state:string;draft:boolean;headSha:string;branch:string}
export interface ReviewFile {path:string;status:string;patch:string|null;additions:number;deletions:number}
export interface ReviewComment {id:number;author:string;body:string;createdAt:string}
export interface Review {id:number;author:string;state:string;body:string}
export interface ReviewCheck {id:string;name:string;status:string;conclusion:string|null;description:string}
export interface PullDetail extends PullSummary {body:string;baseBranch:string;additions:number;deletions:number;changedFiles:number;mergeable:boolean|null;mergeableState:string|null;files:ReviewFile[];comments:ReviewComment[];reviews:Review[];checks:ReviewCheck[];filesHasMore:boolean;commentsHasMore:boolean;reviewsHasMore:boolean;checksTruncated:boolean;inlineCommentCount:number;commentCount:number}
export interface Page<T> {items:T[];hasMore:boolean}
export interface Identity {account:string;source:string}
export class GitHubError extends Error {constructor(readonly kind:string,message:string){super(message);this.name='GitHubError'}}
function invalid():never {throw new GitHubError('protocol','Invalid GitHub response')}
function isObject(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function object(v:unknown):Record<string,unknown>{if(!isObject(v))return invalid();return v}
function string(v:unknown):string{if(typeof v!=='string')return invalid();return v}
function bool(v:unknown):boolean{if(typeof v!=='boolean')return invalid();return v}
function number(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return invalid();return v}
function nullableString(v:unknown):string|null{return v===null?null:string(v)}
function nullableBool(v:unknown):boolean|null{return v===null?null:bool(v)}
function list<T>(v:unknown,parse:(item:unknown)=>T):T[]{if(!Array.isArray(v))return invalid();return v.map((item:unknown)=>parse(item))}
export function summary(value:unknown):PullSummary{const v=object(value);const updatedAt=string(v.updatedAt);if(!Number.isFinite(Date.parse(updatedAt)))return invalid();const id=number(v.id);if(!id)return invalid();return {id,repository:string(v.repository),title:string(v.title),author:string(v.author),updatedAt,state:string(v.state),draft:bool(v.draft),headSha:string(v.headSha),branch:string(v.branch)}}
function file(value:unknown):ReviewFile{const v=object(value);return {path:string(v.path),status:string(v.status),patch:nullableString(v.patch),additions:number(v.additions),deletions:number(v.deletions)}}
function comment(value:unknown):ReviewComment{const v=object(value);return {id:number(v.id),author:string(v.author),body:string(v.body),createdAt:string(v.createdAt)}}
function review(value:unknown):Review{const v=object(value);return {id:number(v.id),author:string(v.author),state:string(v.state),body:string(v.body)}}
function check(value:unknown):ReviewCheck{const v=object(value);return {id:string(v.id),name:string(v.name),status:string(v.status),conclusion:nullableString(v.conclusion),description:string(v.description)}}
export function detail(value:unknown):PullDetail{const v=object(value);return {...summary(v),body:string(v.body),baseBranch:string(v.baseBranch),additions:number(v.additions),deletions:number(v.deletions),changedFiles:number(v.changedFiles),mergeable:nullableBool(v.mergeable),mergeableState:nullableString(v.mergeableState),files:list(v.files,file),comments:list(v.comments,comment),reviews:list(v.reviews,review),checks:list(v.checks,check),filesHasMore:bool(v.filesHasMore),commentsHasMore:bool(v.commentsHasMore),reviewsHasMore:bool(v.reviewsHasMore),checksTruncated:bool(v.checksTruncated),inlineCommentCount:number(v.inlineCommentCount),commentCount:number(v.commentCount)}}
export function page<T>(v:unknown,parse:(item:unknown)=>T):Page<T>{const value=object(v);return {items:list(value.items,parse),hasMore:bool(value.hasMore)}}
export function unwrap(value:unknown):unknown {const v=object(value);if(v.ok===true){if('error' in v)return invalid();return v.value}if(v.ok===false){const error=object(v.error),details=object(error.details);throw new GitHubError(typeof details.kind==='string'?details.kind:string(error.code),string(error.message))}return invalid()}
export class GitHubClient {
 constructor(private readonly rpc:ClientConnectionRpc,private readonly foreground?:()=>((success:boolean)=>void)){}
 private async read(endpoint:string,args:object,signal:AbortSignal):Promise<unknown>{const release=this.foreground?.();let success=false;try{const result=unwrap(await this.rpc.call('/api',endpoint,{args},signal));success=true;return result}finally{release?.(success)}}
 async auth(signal:AbortSignal):Promise<Identity>{const v=object(await this.read('github/auth',{},signal));return {account:string(v.account),source:string(v.source)}}
 async repos(account:string,index:number,signal:AbortSignal):Promise<Page<string>>{return page(await this.read('github/repos',{account,page:index},signal),string)}
 async pulls(account:string,repository:string,index:number,signal:AbortSignal):Promise<Page<PullSummary>>{return page(await this.read('github/pulls',{account,repository,page:index},signal),summary)}
 async detail(account:string,repository:string,id:number,signal:AbortSignal):Promise<PullDetail>{return detail(await this.read('github/detail',{account,repository,number:id},signal))}
 async files(account:string,record:PullDetail,index:number,signal:AbortSignal):Promise<Page<ReviewFile>>{return page(await this.read('github/files',{account,repository:record.repository,number:record.id,sha:record.headSha,page:index},signal),file)}
 async comments(account:string,record:PullDetail,index:number,signal:AbortSignal):Promise<Page<ReviewComment>>{return page(await this.read('github/comments',{account,repository:record.repository,number:record.id,sha:record.headSha,page:index},signal),comment)}
 async reviews(account:string,record:PullDetail,index:number,signal:AbortSignal):Promise<Page<Review>>{return page(await this.read('github/reviews',{account,repository:record.repository,number:record.id,sha:record.headSha,page:index},signal),review)}
}
