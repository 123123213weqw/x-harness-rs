import {z} from 'zod'
import {isObjectRecord} from '../shared/runtime-types'
import {imageAttachmentRefSchema} from '../client-connection/contracts/host/apiproxy/api/sessions.schema'
import {promptSchema,requestConfigSchema} from './wire-event-codec'
import type {TrajectorySnapshot} from './trajectory-contract'

const s=z.string(), n=z.number(), content=z.array(z.unknown()), nullable=s.nullable()
const base={seq:n,time:n}
const provenance=z.looseObject({provider:s,model:s})
const callView=z.looseObject({card:s}).nullable()
const blocks=z.array(z.union([
 z.looseObject({kind:z.enum(['text','reasoning']),text:s}),
 z.looseObject({kind:z.literal('tool-call'),callId:s,name:s,argsRaw:s}),
 z.looseObject({kind:z.literal('image'),attachment:imageAttachmentRefSchema}),
 z.looseObject({kind:z.literal('other'),block:z.unknown()}),
]))
/** Optional properties in native JSON are absent, not own undefined fields.
 * Keep valid original records; this check does not normalize or strip them. */
function exactOptionals(value:Record<string,unknown>,keys:readonly string[]):boolean {
 return keys.every(key => !Object.hasOwn(value,key) || value[key]!==undefined)
}
const config=requestConfigSchema.refine(value => exactOptionals(value,['purpose','thinking','reasoningEffort','temperature','maxTokens','stop']))
const assistant=z.looseObject({...base,kind:z.literal('assistant'),turn:n,step:n,blocks,
 messageId:s.optional(),usage:z.unknown().optional(),provenance:provenance.optional(),requestConfig:config.optional(),
 timing:z.looseObject({stepStartTime:n.nullable(),firstTokenTime:n.nullable(),completedTime:n}).optional(),interrupted:z.literal(true).optional(),
}).refine(value => exactOptionals(value,['messageId','provenance','requestConfig','timing','interrupted']))
const tool:z.ZodType<unknown>=z.lazy(()=>z.union([
 z.looseObject({callId:s,name:s,argsRaw:s,turn:n,step:n,time:n,callView,subCalls:z.array(tool)}).refine(value => !('kind' in value)),
 z.looseObject({...base,kind:z.literal('tool-result'),callId:s,call:z.looseObject({name:s,argsRaw:s}).nullable(),callTime:n.nullable(),content,isError:z.boolean(),error:z.looseObject({name:s,code:s}).optional(),meta:z.unknown().optional(),callView,resultView:callView,subCalls:z.array(tool)}).refine(value => exactOptionals(value,['error'])),
]))
const retryFacts={...base,kind:z.literal('model-retry'),retryId:s,turn:n,step:n,provider:s,policyKey:s,retry:n,delayMs:n,failure:z.looseObject({message:s,code:s}),retryState:z.enum(['scheduled','started','cancelled'])}
const node=z.union([
 z.looseObject({...base,kind:z.literal('user'),content,source:z.unknown()}),
 z.looseObject({...base,kind:z.literal('steering'),messageId:s,content,source:z.unknown()}),
 z.looseObject({...base,kind:z.literal('context'),content,source:z.unknown(),provenance:z.looseObject({role:z.enum(['inject','recall']),label:nullable}),form:z.enum(['instructions','catalog','snapshot','notice','relay','recall']).nullable()}),
 assistant,
 // A finalized root is the tool-result arm, never a running call masquerading as a node.
 tool.refine(value => isObjectRecord(value) && value.kind==='tool-result'),
 z.looseObject({...retryFacts,mode:z.literal('normal'),maxRetries:n}),
 z.looseObject({...retryFacts,mode:z.literal('always')}),
 z.looseObject({...base,kind:z.literal('turn-error'),turn:n,step:n,message:s,code:s.optional()}).refine(value => exactOptionals(value,['code'])),
 z.looseObject({...base,kind:z.literal('turn-max-tokens'),turn:n,step:n}),
 z.looseObject({...base,kind:z.literal('compaction'),summary:nullable,summaryEventSeq:n.nullable(),shadowedItemCount:n.nullable(),shadowedTokenCount:n.nullable()}),
 z.looseObject({...base,kind:z.literal('command'),commandId:s,name:nullable,args:nullable,outcome:z.looseObject({kind:z.enum(['success','error']),text:s.optional(),sourceEventSeq:n.optional()}).refine(value => exactOptionals(value,['text','sourceEventSeq'])).nullable()}),
 z.looseObject({...base,kind:z.literal('unknown'),type:s,data:z.unknown()}),
])
const change=z.looseObject({seq:n,time:n,kind:z.enum(['initial','system','tools','system-and-tools']),previous:promptSchema.optional()}).refine(value => exactOptionals(value,['previous']))
const requestFacts={startSeq:n,startedAt:n,completedAt:n.nullable(),status:z.enum(['running','complete','error']),error:s.optional(),provenance:provenance.optional(),requestConfig:config.optional(),usage:z.unknown().optional(),resultSeq:n.optional()}
const request=z.union([
 z.looseObject({...requestFacts,purpose:z.literal('assistant'),turn:n,step:n,prompt:promptSchema.optional(),promptChange:change.optional(),retry:n.optional(),maxRetries:n.optional(),retryDelayMs:n.optional()}),
 z.looseObject({...requestFacts,purpose:z.literal('compaction'),turn:n.nullable(),step:z.literal(0),replacementSeq:n.optional(),summary:content.optional(),rawOutput:content.optional()}),
]).refine(value => exactOptionals(value,['error','provenance','requestConfig','resultSeq','prompt','promptChange','retry','maxRetries','retryDelayMs','replacementSeq','summary','rawOutput']))
const location=z.union([
 z.looseObject({kind:z.enum(['session','unresolved'])}),
 z.looseObject({kind:z.literal('turn'),turn:z.looseObject({turn:n})}),
 z.looseObject({kind:z.literal('step'),turn:z.looseObject({turn:n}),step:z.looseObject({step:n})}),
])
function isMap(value:unknown,key:(value:unknown)=>boolean,item:(value:unknown)=>boolean):boolean {
 if (!(value instanceof Map)) return false
 const entries:Iterable<readonly [unknown,unknown],unknown,unknown>=value
 for (const [k,v] of entries) if (!key(k) || !item(v)) return false
 return true
}
const snapshot=z.looseObject({eventNodes:z.array(node),eventLocations:z.unknown(),requests:z.array(request),callSchemas:z.unknown(),partial:z.looseObject({turn:n,step:n,blocks}).nullable(),runningCalls:z.array(tool.refine(value => isObjectRecord(value) && !('kind' in value)))})
const produced=new WeakMap<object,TrajectorySnapshot>()
/** Typed producer witness is an ownership proof, not a wire-shape assertion. */
export function producedTrajectorySnapshot(value:TrajectorySnapshot):TrajectorySnapshot {
 produced.set(value,value)
 return value
}
/** This target's complete read currency is owner-decoded, not a generic Map<T>
 * assertion. Typed owner snapshots use a witness; raw legacy snapshots are validated on every read. */
export function isTrajectorySnapshot(value:unknown):value is TrajectorySnapshot {
 if (!isObjectRecord(value)) return false
 if (produced.has(value)) return true
 if (!snapshot.safeParse(value).success
   || !isMap(value.eventLocations,key=>typeof key==='number',item=>location.safeParse(item).success)
   || !isMap(value.callSchemas,key=>typeof key==='string',item=>promptSchema.shape.tools.element.safeParse(item).success)) return false
 return true
}
