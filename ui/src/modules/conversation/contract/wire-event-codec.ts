import { z } from 'zod'
import { TurnEndDataInputSchema } from '../../shared/generated/session-terminal'
import type { SessionWireEvent } from '../../client-connection/contracts/host/apiproxy/api/sessions'
import type { SessionEvent, SessionEventMap, AssistantChunk } from '../types/wire'

const n=z.number(), s=z.string(), content=z.array(z.unknown())
const coords={turn:n,step:n}
const failure=z.looseObject({message:s,code:s})
const chunk: z.ZodType<AssistantChunk> = z.union([
 z.looseObject({type:z.literal('block-start'),index:n,blockType:s}),
 z.looseObject({type:z.enum(['text-delta','reasoning-delta']),index:n,text:s}),
 z.looseObject({type:z.literal('tool-call-delta'),index:n,id:s,name:s.optional(),argumentsDelta:s}),
 z.looseObject({type:z.literal('block-end'),index:n,block:z.unknown()}),
 z.looseObject({type:z.literal('usage'),usage:z.unknown()}),
 z.looseObject({type:z.literal('finish'),reason:z.unknown().optional()}),
])
const dispatch={parentCallId:s,rootCallId:s,subCallId:s,name:s,arguments:z.unknown()}
const compact={compactionId:s,sourceCommandId:s.optional()}
const retry={...coords,retryId:s,retry:n,delayMs:n,policyKey:s,provider:s,failure}
const schemas: { [K in keyof SessionEventMap]: z.ZodType<SessionEventMap[K]> } = {
 'turn/start':z.looseObject({turn:n}),
 'run/checkpoint':z.looseObject({turn:n,notice:z.object({kind:s,message:s}).optional()}),
 'turn/end':TurnEndDataInputSchema,
 'step/start':z.looseObject(coords), 'step/end':z.looseObject({...coords,reason:z.unknown().optional()}),
 'assistant/chunk':z.looseObject({...coords,chunk}),
 'assistant/message':z.looseObject({...coords,message:z.looseObject({id:s,content}),usage:z.unknown().optional(),interrupted:z.boolean().optional()}),
 'user/message':z.looseObject({id:s,content,source:z.looseObject({kind:s})}),
 'tool/call':z.looseObject({...coords,callId:s,name:s,arguments:s}),
 'tool/result':z.looseObject({...coords,message:z.looseObject({source:z.looseObject({callId:s}),content:z.tuple([z.looseObject({type:z.literal('tool-result'),content,isError:z.boolean().optional()})]).rest(z.unknown())}),error:z.object({name:s,code:s}).optional(),meta:z.unknown().optional()}),
 'tool/code-dispatch-start':z.looseObject(dispatch), 'tool/code-dispatch':z.looseObject({...dispatch,content:content.optional(),isError:z.boolean().optional()}),
 'command/run':z.looseObject({commandId:s,name:s,args:s.optional()}),
 'command/done':z.looseObject({commandId:s,kind:z.enum(['success','error']),text:s.optional(),sourceEventSeq:n.optional()}),
 'compaction/start':z.looseObject(compact), 'compaction/end':z.looseObject({...compact,error:s.nullable().optional()}),
 'compaction/progress':z.looseObject({...compact,progress:z.unknown()}),
 'compaction/summary':z.looseObject({...compact,summary:content,shadowedSeqs:z.array(n),shadowedTokenCount:n}),
 'agent/inbox/spliced':z.looseObject({target:z.enum(['next-turn','next-step']),start:n,removedCount:n.optional(),inserted:z.array(z.looseObject({id:s})),outcome:z.literal('canceled').optional()}),
 'llm/retry':z.union([z.looseObject({...retry,mode:z.literal('normal'),maxRetries:n}),z.looseObject({...retry,mode:z.literal('always')})]),
 'llm/retry-started':z.looseObject({...coords,retryId:s,retry:n}),
 unknown:z.unknown(),
}
/** Validate just this owner-consumed DTO; preserve the immutable carrier and all foreign fields. */
export function isSessionEvent<K extends keyof SessionEventMap>(event: SessionWireEvent | undefined, kind: K): event is SessionWireEvent & SessionEvent<K> {
 return event !== undefined && event.type === kind && schemas[kind].safeParse(event.data).success
}

/** A recognized malformed compaction is a failed history transaction, not foreign fallback.
 * The assembler must retain the previous window and expose its retry/error state.
 */
export function validateCompactionEvent(event: SessionWireEvent): void {
 switch (event.type) {
  case 'compaction/start': if (!isSessionEvent(event, 'compaction/start')) throw new Error('invalid compaction/start data'); break
  case 'compaction/progress': if (!isSessionEvent(event, 'compaction/progress')) throw new Error('invalid compaction/progress data'); break
  case 'compaction/summary': if (!isSessionEvent(event, 'compaction/summary')) throw new Error('invalid compaction/summary data'); break
  case 'compaction/end': if (!isSessionEvent(event, 'compaction/end')) throw new Error('invalid compaction/end data'); break
 }
}
