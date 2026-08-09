import type {ReviewSnapshot} from './structured'
import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
export interface PullSummary {id:number;repository:string;title:string;author:string;updatedAt:string;state:string;draft:boolean;headSha:string;branch:string}
export interface ReviewFile {path:string;status:string;patch:string|null;additions:number;deletions:number}
export interface ReviewComment {id:number;author:string;body:string;createdAt:string}
export interface Review {id:number;author:string;state:string;body:string}
export interface ReviewCheck {id:string;name:string;status:string;conclusion:string|null;description:string;url?:string|null}
export interface PullDetail extends PullSummary {body:string;baseBranch:string;additions:number;deletions:number;changedFiles:number;mergeable:boolean|null;mergeableState:string|null;files:ReviewFile[];comments:ReviewComment[];reviews:Review[];checks:ReviewCheck[];filesHasMore:boolean;commentsHasMore:boolean;reviewsHasMore:boolean;checksTruncated:boolean;inlineCommentCount:number;commentCount:number}
export interface ReviewModel {provider:string;model:string;name:string}
export interface ReviewRun {sessionId?:string|null;id:string;target:{account:string;repository:string;number:number;sha:string};provider:string;model:string;mode:'review'|'question';question:string;status:'running'|'completed'|'failed'|'cancelled';text:string;snapshot:ReviewSnapshot;error:string|null;stale:boolean}
export interface CursorPage<T> {items:T[];hasMore:boolean;cursor:string|null}
export interface ThreadComment {id:string;author:string;body:string;createdAt:string;url:string}
export interface ReviewThread {id:string;path:string;side:'left'|'right';line:number|null;startLine:number|null;resolved:boolean;outdated:boolean;comments:CursorPage<ThreadComment>}
export interface WorkflowRun {id:number;name:string;status:string;conclusion:string|null;headSha:string;attempt:number;mergeTest:boolean}
export interface WorkflowStep {number:number;name:string;status:string;conclusion:string|null}
export interface WorkflowJob {id:number;name:string;status:string;conclusion:string|null;steps:WorkflowStep[]}
export interface JobLog {text:string;truncated:boolean}
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
function check(value:unknown):ReviewCheck{const v=object(value);return {id:string(v.id),name:string(v.name),status:string(v.status),conclusion:nullableString(v.conclusion),description:string(v.description),url:v.url===undefined?null:nullableString(v.url)}}
export function detail(value:unknown):PullDetail{const v=object(value);return {...summary(v),body:string(v.body),baseBranch:string(v.baseBranch),additions:number(v.additions),deletions:number(v.deletions),changedFiles:number(v.changedFiles),mergeable:nullableBool(v.mergeable),mergeableState:nullableString(v.mergeableState),files:list(v.files,file),comments:list(v.comments,comment),reviews:list(v.reviews,review),checks:list(v.checks,check),filesHasMore:bool(v.filesHasMore),commentsHasMore:bool(v.commentsHasMore),reviewsHasMore:bool(v.reviewsHasMore),checksTruncated:bool(v.checksTruncated),inlineCommentCount:number(v.inlineCommentCount),commentCount:number(v.commentCount)}}
export function page<T>(v:unknown,parse:(item:unknown)=>T):Page<T>{const value=object(v);return {items:list(value.items,parse),hasMore:bool(value.hasMore)}}
function nullableNumber(v:unknown):number|null{return v===null?null:number(v)}
function cursorPage<T>(value:unknown,parse:(v:unknown)=>T):CursorPage<T>{const v=object(value);const result={...page(v,parse),cursor:nullableString(v.cursor)};if(result.hasMore&&!result.cursor)return invalid();return result}
function threadComment(value:unknown):ThreadComment{const v=object(value);return {id:string(v.id),author:string(v.author),body:string(v.body),createdAt:string(v.createdAt),url:string(v.url)}}
function thread(value:unknown):ReviewThread{const v=object(value),side=string(v.side);if(side!=='left'&&side!=='right')return invalid();return {id:string(v.id),path:string(v.path),side,line:nullableNumber(v.line),startLine:nullableNumber(v.startLine),resolved:bool(v.resolved),outdated:bool(v.outdated),comments:cursorPage(v.comments,threadComment)}}
function run(value:unknown):WorkflowRun{const v=object(value);return {id:number(v.id),name:string(v.name),status:string(v.status),conclusion:nullableString(v.conclusion),headSha:string(v.headSha),attempt:number(v.attempt),mergeTest:bool(v.mergeTest)}}
function step(value:unknown):WorkflowStep{const v=object(value);return {number:number(v.number),name:string(v.name),status:string(v.status),conclusion:nullableString(v.conclusion)}}
function job(value:unknown):WorkflowJob{const v=object(value);return {id:number(v.id),name:string(v.name),status:string(v.status),conclusion:nullableString(v.conclusion),steps:list(v.steps,step)}}
export function parseThreads(value:unknown):CursorPage<ReviewThread>{return cursorPage(value,thread)}
export function parseRuns(value:unknown):Page<WorkflowRun>{return page(value,run)}
export function parseJobs(value:unknown):Page<WorkflowJob>{return page(value,job)}
export function reviewRun(value:unknown):ReviewRun{
 const v=object(value),t=object(v.target),snap=object(v.snapshot),mode=string(v.mode),status=string(v.status)
 if(mode!=='review'&&mode!=='question'||status!=='running'&&status!=='completed'&&status!=='failed'&&status!=='cancelled')return invalid()
 const target={account:string(t.account),repository:string(t.repository),number:number(t.number),sha:string(t.sha)}
 const snapshot:ReviewSnapshot={account:string(snap.account),repository:string(snap.repository),number:number(snap.number),headSha:string(snap.headSha),files:list(snap.files,file),filesHasMore:bool(snap.filesHasMore),changedFiles:number(snap.changedFiles)}
 if(snapshot.account!==target.account||snapshot.repository.toLowerCase()!==target.repository.toLowerCase()||snapshot.number!==target.number||snapshot.headSha!==target.sha)return invalid()
 return {...(v.sessionId===undefined?{}:{sessionId:nullableString(v.sessionId)}),id:string(v.id),target,provider:string(v.provider),model:string(v.model),mode,status,question:string(v.question),text:string(v.text),snapshot,error:nullableString(v.error),stale:bool(v.stale)}
}
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
 private evidenceArgs(account:string,record:PullDetail):object{return {account,repository:record.repository,number:record.id,sha:record.headSha}}
 async threads(account:string,record:PullDetail,cursor:string|null,signal:AbortSignal):Promise<CursorPage<ReviewThread>>{return parseThreads(await this.read('github/threads',{...this.evidenceArgs(account,record),cursor},signal))}
 async threadComments(account:string,record:PullDetail,thread:string,cursor:string|null,signal:AbortSignal):Promise<CursorPage<ThreadComment>>{return cursorPage(await this.read('github/thread-comments',{...this.evidenceArgs(account,record),thread,cursor},signal),threadComment)}
 async runs(account:string,record:PullDetail,index:number,signal:AbortSignal):Promise<Page<WorkflowRun>>{return parseRuns(await this.read('github/runs',{...this.evidenceArgs(account,record),page:index},signal))}
 async jobs(account:string,record:PullDetail,run:WorkflowRun,index:number,signal:AbortSignal):Promise<Page<WorkflowJob>>{return parseJobs(await this.read('github/jobs',{...this.evidenceArgs(account,record),run:run.id,attempt:run.attempt,page:index},signal))}
 async logs(account:string,record:PullDetail,run:WorkflowRun,job:number,signal:AbortSignal):Promise<JobLog>{const v=object(await this.read('github/logs',{...this.evidenceArgs(account,record),run:run.id,attempt:run.attempt,job},signal));return {text:string(v.text),truncated:bool(v.truncated)}}

 async reviewModels(signal:AbortSignal):Promise<ReviewModel[]>{const v=object(await this.read('github/review-models',{},signal));return list(v.items,item=>{const m=object(item);return {provider:string(m.provider),model:string(m.model),name:string(m.name)}})}
 async reviewHistory(account:string,record:PullDetail,signal:AbortSignal):Promise<ReviewRun[]>{const v=object(await this.read('github/review-history',this.evidenceArgs(account,record),signal));return list(v.items,reviewRun)}
 async startReview(account:string,record:PullDetail,model:ReviewModel,mode:'review'|'question',question:string,signal:AbortSignal):Promise<ReviewRun>{return reviewRun(await this.read('github/review-start',{...this.evidenceArgs(account,record),provider:model.provider,model:model.model,mode,question},signal))}
 async reviewStatus(run:ReviewRun,action:'status'|'cancel',signal:AbortSignal):Promise<ReviewRun>{const value=object(await this.read(`github/review-${action}`,{...run.target,id:run.id},signal));return reviewRun({...value,snapshot:value.snapshot===null?run.snapshot:value.snapshot})}

}
