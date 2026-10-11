/** Version 1 execution contract. Tool results only supply lookup hints. */
export const RUN_STATES = ['preparing','queued','running','waiting','stopping','completed','failed','cancelled','interrupted','incomplete','unavailable'] as const
export const PLAN_STATES = ['scheduled','overdue','paused','finished','deleted','inherited','inactive'] as const
export type RunState = typeof RUN_STATES[number]
export type PlanState = typeof PLAN_STATES[number]
export type RunRef = {kind:'process';id:string} | {kind:'automation';planId:string;inputId:string}
export interface JobRun {id:string;label:string;sourceSessionId:string;targetSessionId:string;planId:string|null;state:RunState;reference:RunRef;capabilities:{cancelRun:boolean;readOutput:boolean;openSession:boolean};startedAtMs:number|null;scheduledAtMs:number|null;finishedAtMs:number|null;detail:string|null}
export interface JobPlan {id:string;label:string;state:PlanState;nextAt:string;everySeconds:number|null}
export interface JobCatalog {version:1;sessionId:string;plans:JobPlan[];runs:JobRun[]}
export interface Cursor {job_id:string;stdout:number;stderr:number}
export interface JobOutput {stdout:string;stderr:string;stdoutTruncated:boolean;stderrTruncated:boolean;nextCursor:Cursor;run:JobRun}
export const ACTIVE = new Set<RunState>(['preparing','queued','running','waiting','stopping'])
function isObject(v:unknown):v is Record<string,unknown> {return v!==null&&typeof v==='object'&&!Array.isArray(v)}
function object(v:unknown):Record<string,unknown> {return isObject(v)?v:{}}
function list(v:unknown):readonly unknown[] {return Array.isArray(v)?v:[]}
function text(v:unknown):v is string {return typeof v==='string'&&v.length>0}
function timestamp(v:unknown):v is number|null {return v===null||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0}
function runState(v:unknown):v is RunState {return RUN_STATES.some(s=>s===v)}
function planState(v:unknown):v is PlanState {return PLAN_STATES.some(s=>s===v)}
function parseRef(raw:unknown):RunRef {
  const r=object(raw)
  if(r.kind==='process'&&text(r.id))return {kind:'process',id:r.id}
  if(r.kind==='automation'&&text(r.planId)&&text(r.inputId))return {kind:'automation',planId:r.planId,inputId:r.inputId}
  throw Error('Invalid Job execution reference')
}
export function parseRun(raw:unknown, session:string):JobRun {
  const v=object(raw),reference=parseRef(v.reference),c=object(v.capabilities)
  if(!text(v.id)||!text(v.label)||v.sourceSessionId!==session||!text(v.targetSessionId)
    ||!runState(v.state)||!(v.planId===null||text(v.planId))
    ||typeof c.cancelRun!=='boolean'||typeof c.readOutput!=='boolean'||typeof c.openSession!=='boolean'
    ||!timestamp(v.startedAtMs)||!timestamp(v.scheduledAtMs)||!timestamp(v.finishedAtMs)
    ||!(v.detail===null||typeof v.detail==='string'))throw Error('Invalid Job execution projection')
  if(reference.kind==='process'?reference.id!==v.id:reference.inputId!==v.id||reference.planId!==v.planId)throw Error('Job reference identity mismatch')
  return {id:v.id,label:v.label,sourceSessionId:session,targetSessionId:v.targetSessionId,planId:v.planId,state:v.state,reference,capabilities:{cancelRun:c.cancelRun,readOutput:c.readOutput,openSession:c.openSession},startedAtMs:v.startedAtMs,scheduledAtMs:v.scheduledAtMs,finishedAtMs:v.finishedAtMs,detail:v.detail}
}
export function parseCatalog(raw:unknown, session:string):JobCatalog {
  const v=object(raw)
  if(v.version!==1||v.sessionId!==session||!Array.isArray(v.runs)||!Array.isArray(v.plans))throw Error('Unsupported or foreign Job contract')
  const runs=list(v.runs).map(run=>parseRun(run,session)),plans=list(v.plans).map((raw):JobPlan=>{
    const p=object(raw)
    if(!text(p.id)||!text(p.label)||!planState(p.state)||!text(p.nextAt)||!Number.isFinite(Date.parse(p.nextAt))||!(p.everySeconds===null||typeof p.everySeconds==='number'&&Number.isSafeInteger(p.everySeconds)&&p.everySeconds>0))throw Error('Invalid Job plan projection')
    return {id:p.id,label:p.label,state:p.state,nextAt:p.nextAt,everySeconds:p.everySeconds}
  })
  if(new Set(runs.map(r=>r.id)).size!==runs.length||new Set(plans.map(p=>p.id)).size!==plans.length)throw Error('Duplicate Job identity')
  return {version:1,sessionId:session,runs,plans}
}
export function parseOutput(raw:unknown, session:string, ref:RunRef):JobOutput {
  const v=object(raw),c=object(v.nextCursor)
  if(v.version!==1||ref.kind!=='process'||typeof v.stdout!=='string'||typeof v.stderr!=='string'||typeof v.stdoutTruncated!=='boolean'||typeof v.stderrTruncated!=='boolean'||c.job_id!==ref.id||typeof c.stdout!=='number'||!Number.isSafeInteger(c.stdout)||c.stdout<0||typeof c.stderr!=='number'||!Number.isSafeInteger(c.stderr)||c.stderr<0)throw Error('Invalid Job output projection')
  const run=parseRun(v.run,session)
  if(run.id!==ref.id)throw Error('Job output identity changed')
  return {stdout:v.stdout,stderr:v.stderr,stdoutTruncated:v.stdoutTruncated,stderrTruncated:v.stderrTruncated,nextCursor:{job_id:ref.id,stdout:c.stdout,stderr:c.stderr},run}
}
/** Nested legacy envelopes are ID hints only, never executable instructions. */
export function processHint(block:unknown):string|undefined {
  const b=object(block),call=object(b.call)
  const parse=(value:unknown):unknown=>{if(typeof value!=='string'||value.length>1_048_576)return undefined;try{return JSON.parse(value)}catch{return undefined}}
  const args=object(parse(call.argsRaw??b.argsRaw))
  if(text(args.job_id))return args.job_id
  let out=object(parse(list(b.content).map(p=>{const o=object(p);return o.type==='text'&&typeof o.text==='string'?o.text:''}).join('\n')))
  if(out.ok===false||b.isError===true)return undefined
  if(typeof out.content==='string')out=object(parse(out.content))
  const snapshot=object(out.snapshot)
  return text(out.job_id)?out.job_id:text(snapshot.id)?snapshot.id:undefined
}
