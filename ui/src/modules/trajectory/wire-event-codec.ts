import {z} from 'zod'
import { TurnEndDataInputSchema } from '../shared/generated/session-terminal'
import type {SessionWireEvent} from '../client-connection/contracts/host/apiproxy/api/sessions'

const s=z.string(), n=z.number(), content=z.array(z.unknown())
const coords={turn:n,step:n}
const usage=z.looseObject({inputTokens:n,outputTokens:n,cacheReadTokens:n.optional(),cacheWriteTokens:n.optional(),reasoningTokens:n.optional()})
const chunk=z.union([
 z.looseObject({type:z.literal('block-start'),index:n,blockType:s}),
 z.looseObject({type:z.enum(['text-delta','reasoning-delta']),index:n,text:s}),
 z.looseObject({type:z.literal('tool-call-delta'),index:n,id:s,name:s.optional(),argumentsDelta:s}),
 z.looseObject({type:z.literal('block-end'),index:n,block:z.unknown()}),
 z.looseObject({type:z.literal('usage'),usage}),
 z.looseObject({type:z.literal('finish')}),
])
const dispatch={rootCallId:s,parentCallId:s,subCallId:s,name:s,arguments:z.unknown()}
export const requestConfigSchema=z.looseObject({provider:s,model:s,purpose:s.optional(),thinking:s.optional(),reasoningEffort:s.optional(),temperature:n.optional(),maxTokens:n.optional(),stop:z.array(s).optional()})
export const promptSchema=z.looseObject({config:requestConfigSchema,system:s,tools:z.array(z.looseObject({name:s,description:s,parameters:z.record(s,z.unknown())}))})
const schemas={
 'step/start':z.looseObject(coords),
 'step/end':z.looseObject(coords),
 'assistant/chunk':z.looseObject({...coords,chunk}),
 'assistant/message':z.looseObject({...coords,message:z.looseObject({id:s,content,source:z.looseObject({provider:s,model:s})}),usage:usage.optional(),interrupted:z.boolean().optional()}),
 'user/message':z.looseObject({id:s,content,source:z.looseObject({kind:s})}),
 'tool/call':z.looseObject({...coords,callId:s,name:s,arguments:s}),
 'tool/result':z.looseObject({message:z.looseObject({source:z.looseObject({callId:s}),content:z.tuple([z.looseObject({type:z.literal('tool-result'),content,isError:z.boolean().optional()})]).rest(z.unknown())}),error:z.looseObject({name:s,code:s}).optional(),meta:z.unknown().optional()}),
 'tool/code-dispatch-start':z.looseObject(dispatch),
 'tool/code-dispatch':z.looseObject({...dispatch,content:content.optional(),isError:z.boolean().optional()}),
 'compaction/start':z.looseObject({compactionId:s,turn:n.nullable()}),
 'compaction/summary':z.looseObject({compactionId:s,provider:s,model:s,summary:content,rawOutput:content.optional(),maxTokens:n.optional(),usage:z.unknown().optional()}),
 'compaction/end':z.looseObject({compactionId:s,error:s.optional()}),
 'agent/inbox/spliced':z.looseObject({target:s,start:n,removedCount:n.optional(),inserted:z.array(z.looseObject({id:s})),outcome:z.literal('canceled').optional()}),
 'llm/retry':z.union([z.looseObject({...coords,mode:z.literal('normal'),retry:n,maxRetries:n,delayMs:n,failure:z.unknown()}),z.looseObject({...coords,mode:z.literal('always'),retry:n,delayMs:n,failure:z.unknown()})]),
 'turn/end':TurnEndDataInputSchema,
 'request/header':z.looseObject({header:z.looseObject({config:requestConfigSchema,system:s.nullable().optional(),tools:promptSchema.shape.tools.optional()}),reason:s}),
}
type TrajectoryEventMap={ [K in keyof typeof schemas]: z.infer<typeof schemas[K]> }
/** Validate only fields this target consumes. No coercion, cloning, defaults or
 * carrier replacement: opaque blocks and foreign payload fields retain identity. */
export function isTrajectoryEvent<K extends keyof TrajectoryEventMap>(event:SessionWireEvent|undefined,kind:K):event is SessionWireEvent & {type:K;data:TrajectoryEventMap[K]} {
 return event!==undefined && event.type===kind && schemas[kind].safeParse(event.data).success
}
