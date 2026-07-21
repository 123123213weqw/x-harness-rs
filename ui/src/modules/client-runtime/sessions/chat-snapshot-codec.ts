/** Compatibility boundary for untyped view publishers; readers validate every returned value. */
import { z } from 'zod'
import { imageAttachmentRefSchema } from '../../client-connection/contracts/host/apiproxy/api/sessions.schema'
import { isRecord, isUnknownArray } from '../value-guards'
import type { ConversationLocationDataStore, ConversationStepDataMap, ConversationTurnDataMap, TurnLocation, ConversationTimelineSnapshot, ChatConversationViewNode } from '../contract/conversation'
import type { ChatSnapshot, ConversationNode, LegacyConversationSlice, ToolCallBlock, RunningToolCall, AssistantBlock } from './conversation'
import { EMPTY_CHAT_SNAPSHOT, isChatSnapshot } from './conversation'
const n=z.number(), s=z.string(), maybeNumber=n.optional(), maybeString=s.optional()
const dataStore=z.custom<ConversationLocationDataStore<ConversationStepDataMap & ConversationTurnDataMap>>(value=>isRecord(value)&&typeof value.get==='function')
const wire={seq:n,time:n,sourceEventSeqs:z.array(n).optional(),surfaceOp:z.unknown().optional(),ignorable:z.literal(true).optional()}
const turnStart=z.looseObject({...wire,type:z.literal('turn/start'),data:z.looseObject({turn:n})})
const turnEnd=z.looseObject({...wire,type:z.literal('turn/end'),data:z.looseObject({turn:n})})
const stepStart=z.looseObject({...wire,type:z.literal('step/start'),data:z.looseObject({turn:n,step:n})})
const stepEnd=z.looseObject({...wire,type:z.literal('step/end'),data:z.looseObject({turn:n,step:n})})
const status=z.enum(['open','closed','unknown'])
const step=z.looseObject({turn:n,step:n,start:stepStart.optional(),end:stepEnd.optional(),status,data:dataStore}).transform(value=>({...value,start:value.start,end:value.end}))
const turn: z.ZodType<TurnLocation>=z.looseObject({turn:n,start:turnStart.optional(),end:turnEnd.optional(),status,steps:z.array(step),data:dataStore}).transform(value=>({...value,start:value.start,end:value.end}))
const timeline: z.ZodType<ConversationTimelineSnapshot>=z.looseObject({turnOrder:z.array(n),turns:z.map(n,turn)})
const location=z.union([z.object({kind:z.enum(['session','unresolved'])}),z.object({kind:z.literal('turn'),turn}),z.object({kind:z.literal('step'),turn,step})])
const chatNode: z.ZodType<ChatConversationViewNode>=z.looseObject({key:s,kind:s,id:s,target:z.literal('chat'),data:z.unknown(),anchorSeq:n,location,visibility:z.enum(['visible','hidden'])})
const card=z.looseObject({card:s}).nullable()
const tool: z.ZodType<ToolCallBlock>=z.lazy(()=>z.union([
  z.looseObject({callId:s,name:s,argsRaw:s,turn:n,step:n,time:n,callView:card,subCalls:z.array(tool)}).refine(value=>!('kind' in value)),
  z.looseObject({kind:z.literal('tool-result'),seq:n,time:n,callId:s,call:z.object({name:s,argsRaw:s}).nullable(),callTime:n.nullable(),content:z.array(z.unknown()),isError:z.boolean(),error:z.object({name:s,code:s}).optional(),meta:z.unknown().optional(),callView:card,resultView:card,subCalls:z.array(tool)}),
]))
const running: z.ZodType<RunningToolCall>=z.looseObject({callId:s,name:s,argsRaw:s,turn:n,step:n,time:n,callView:card,subCalls:z.array(tool)})
const block: z.ZodType<AssistantBlock>=z.union([
  z.object({kind:z.literal('text'),text:s}),z.object({kind:z.literal('reasoning'),text:s}),
  z.object({kind:z.literal('image'),attachment:imageAttachmentRefSchema}),
  z.object({kind:z.literal('tool-call'),callId:s,name:s,argsRaw:s}),z.object({kind:z.literal('other'),block:z.unknown()}),
])
const blocks=z.array(block),base={seq:n,time:n}
const progress=z.object({stage:z.enum(['preparing','summarizing','splitting','merging','retrying','paused','validating','committing']),calls:n,completedParts:n,splits:n,retries:n,delayMs:n.nullish(),inputTokensBefore:n.nullish(),inputTokensAfter:n.nullish()})
const retryBase={...base,kind:z.literal('model-retry'),turn:n,step:n,retryId:s,retry:n,retryState:z.enum(['scheduled','started','cancelled'])}
const failure=z.looseObject({message:s,code:s,status:maybeNumber,providerRetryAfterMs:maybeNumber,requestId:maybeString})
const retryFacts={provider:s,policyKey:s,delayMs:n,failure,partial:z.literal(true).optional()}
const legacyNode: z.ZodType<ConversationNode>=z.union([
  z.looseObject({...base,kind:z.literal('user'),content:z.array(z.unknown()),source:z.unknown()}),
  z.looseObject({...base,kind:z.literal('steering'),messageId:s,content:z.array(z.unknown()),source:z.unknown()}),
  z.looseObject({...base,kind:z.literal('context'),content:z.array(z.unknown()),source:z.unknown(),provenance:z.object({role:z.enum(['inject','recall']),label:s.nullable()}),form:z.enum(['instructions','catalog','snapshot','notice','relay','recall']).nullable()}),
  z.looseObject({...base,kind:z.literal('assistant'),messageId:maybeString,turn:n,step:n,blocks,usage:z.unknown().optional(),provenance:z.object({provider:s,model:s}).optional(),requestConfig:z.looseObject({provider:s,model:s,purpose:maybeString,thinking:maybeString,reasoningEffort:maybeString,temperature:maybeNumber,maxTokens:maybeNumber,stop:z.array(s).optional()}).optional(),timing:z.object({stepStartTime:n.nullable(),firstTokenTime:n.nullable(),completedTime:n}).optional(),interrupted:z.literal(true).optional()}),
  z.looseObject({...base,kind:z.literal('tool-result'),callId:s,call:z.object({name:s,argsRaw:s}).nullable(),callTime:n.nullable(),content:z.array(z.unknown()),isError:z.boolean(),error:z.object({name:s,code:s}).optional(),meta:z.unknown().optional(),callView:card,resultView:card,subCalls:z.array(tool)}),
  z.looseObject({...base,kind:z.literal('command'),commandId:s,name:s.nullable(),args:s.nullable(),outcome:z.object({kind:z.enum(['success','error']),text:maybeString,sourceEventSeq:maybeNumber}).nullable()}),
  z.looseObject({...base,kind:z.literal('turn-error'),turn:n,step:n,message:s,code:maybeString}),
  z.looseObject({...base,kind:z.literal('turn-max-tokens'),turn:n,step:n}),
  z.looseObject({...base,kind:z.literal('unknown'),type:s,data:z.unknown()}),
  z.looseObject({...base,kind:z.literal('compaction'),summary:s.nullable(),summaryEventSeq:n.nullable(),shadowedItemCount:n.nullable(),shadowedTokenCount:n.nullable(),progress:progress.optional(),startedAt:maybeNumber,endedAt:maybeNumber}),
  z.looseObject({...base,kind:z.literal('compaction'),status:z.enum(['running','failed']),progress:progress.optional(),progressTime:maybeNumber,error:s.nullable(),endedAt:maybeNumber}),
  z.looseObject({...retryBase,...retryFacts,mode:z.literal('normal'),maxRetries:n}),
  z.looseObject({...retryBase,...retryFacts,mode:z.literal('always')}),
  z.looseObject({...retryBase,partial:z.literal(true),delayMs:z.undefined().optional(),mode:z.undefined().optional(),policyKey:z.undefined().optional(),failure:z.undefined().optional(),maxRetries:z.undefined().optional()}),
])
const legacy: z.ZodType<LegacyConversationSlice>=z.looseObject({nodes:z.array(legacyNode),turnTimings:z.map(n,z.object({startTime:n,endTime:maybeNumber})).optional(),turnEnds:z.map(n,n),partial:z.object({turn:n,step:n,blocks}).nullable(),runningCalls:z.array(running)}).transform(value=>({...value,turnTimings:value.turnTimings}))
const decoded = new WeakMap<object,ChatSnapshot>()
function isTimeline(value: unknown): value is ConversationTimelineSnapshot { return timeline.safeParse(value).success }
function isLegacy(value: unknown): value is LegacyConversationSlice { return legacy.safeParse(value).success }
function isChatNode(value: unknown): value is ChatConversationViewNode { return chatNode.safeParse(value).success }
function strings(value: unknown): readonly string[] {
  if (!isUnknownArray(value)||!value.every(item=>typeof item==='string')) throw new Error('chat view returned invalid key list')
  return value
}
function invoke(receiver: Record<string,unknown>,name:string,args:readonly unknown[]):unknown {
  const fn=receiver[name]
  if(typeof fn!=='function')throw new Error(`chat view reader ${name} is not callable`)
  const value:unknown=Reflect.apply(fn,receiver,args)
  return value
}
/** Old JS targets use checked adapters; typed owned publications retain their exact identity. */
export function readChatSnapshot(value:unknown):ChatSnapshot {
  if(value===undefined)return EMPTY_CHAT_SNAPSHOT
  if(isChatSnapshot(value))return value
  if(!isRecord(value)||!isRecord(value.nodes)||!isRecord(value.locations)||!isLegacy(value.legacy)||!isTimeline(value.timeline)) throw new Error('invalid chat view publication')
  const old=decoded.get(value)
  if(old!==undefined)return old
  const nodes=value.nodes,locations=value.locations
  const snapshot:ChatSnapshot={
    order:strings(value.order),legacy:value.legacy,timeline:value.timeline,
    nodes:{get(key){const node=invoke(nodes,'get',[key]);if(node===undefined)return undefined;if(!isChatNode(node))throw new Error('chat view returned invalid node');return node},
      values(){const list=invoke(nodes,'values',[]);if(!isUnknownArray(list)||!list.every(isChatNode))throw new Error('chat view returned invalid nodes');return list}},
    locations:{getTurn(turn){return strings(invoke(locations,'getTurn',[turn]))},getStep(turn,step){return strings(invoke(locations,'getStep',[turn,step]))}},
  }
  decoded.set(value,snapshot)
  return snapshot
}
