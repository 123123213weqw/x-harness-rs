import type {PullSummary,ReviewCheck} from './client'
export function recordKey(record:PullSummary):string{return `${record.repository.toLowerCase()}#${record.id}`}
export interface PullLink {repository:string;id:number}
export function parsePullLink(query:string):PullLink|null {
 const match=/^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/(\d+)\/?$/i.exec(query.trim())
 if(!match||!match[1]||!match[2])return null
 const id=Number(match[2]);return Number.isSafeInteger(id)&&id>0?{repository:match[1],id}:null
}
export function filterPulls(list:readonly PullSummary[],query:string,author:string|null):readonly PullSummary[]{const text=query.trim().toLowerCase(),link=parsePullLink(query);return list.filter(item=>(author===null||item.author===author)&&(link?item.repository.toLowerCase()===link.repository.toLowerCase()&&item.id===link.id:`${item.title} ${item.repository} #${item.id}`.toLowerCase().includes(text)))}
export type CheckState='passed'|'failed'|'pending'|'neutral'
export function checkState(check:ReviewCheck):CheckState {if(check.status!=='completed')return 'pending';if(check.conclusion==='success')return 'passed';if(['failure','error','timed_out','cancelled','action_required','startup_failure'].includes(check.conclusion??''))return 'failed';return 'neutral'}
export function age(updatedAt:string):string{const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(updatedAt))/60000));return minutes<60?`${minutes}m`:minutes<1440?`${Math.floor(minutes/60)}h`:`${Math.floor(minutes/1440)}d`}
/** Each async lane owns a cancellable generation; late old responses cannot
 * replace a newer repository/PR selection, even if transport ignores abort. */
export class RequestLane {
 private generation=0
 private controller=new AbortController()
 start():{signal:AbortSignal;current():boolean}{this.controller.abort();this.controller=new AbortController();const generation=++this.generation;return {signal:this.controller.signal,current:()=>generation===this.generation&&!this.controller.signal.aborted}}
 cancel():void{this.generation++;this.controller.abort()}
}
