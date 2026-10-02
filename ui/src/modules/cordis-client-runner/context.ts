/** Narrow, page-only Cordis seam used by the dynamic package lifecycle. */
import * as Cordis from '@xharness/cordis'
import type { RemoteResult } from '../api-gateway/contracts'
import type * as Wire from './wire'
import type { CordisRunRequest } from './orchestrator'
import type { ClientCordisInspectRegistry } from './inspect-registry'
import type { CordisRunnerFace } from './index'
import type { DynamicCordisRenderFailure, CordisErrorDetails } from './runtime'

export interface Loader {
  create(options: {name: string}): Promise<string>
  resolve(id: string): {fiber?: {inject: Record<string, unknown>; await(): Promise<unknown>}}
  remove(id: string): Promise<unknown>
}
export interface ThemeRuntime {
  overrideTokens(source: string, tokens: unknown): () => void
  getSnapshot(): unknown
  exportInspectTokens(): Wire.JsonValue[]
}
export interface LiveSlotNode {
  name: string; kind: string; scope: string; declaredBy?: string
  occupants: {registrant?: string; key?: string; id?: string; order?: number; priority: number; active: boolean}[]
  children: LiveSlotNode[]
}
export interface SlotRegistry {
  snapshot(root?: string): LiveSlotNode[]
  spec(key: string): {kind?: string} | undefined
  onEntryError(listener: (slot: string, entry: unknown, error: unknown, info: {abdicated: boolean}) => void): () => void
  getSnapshot(): unknown
  register(options: object, component: unknown): () => void
}
export interface RunnerEvents {
  'cordis/request-run': (request: CordisRunRequest) => void
  'cordis/request-run-resolved': (resolved: {requestId: Wire.ApprovalRequestId}) => void
  'cordis/dynamic-retract': (retracted: {pluginId: Wire.CordisDynamicPluginId; pluginRunId: Wire.CordisDynamicPluginRunId}) => void
  'cordis/inspect-query': (request: Wire.CordisInspectQueryRequest) => void
  'cordis/inspect-query-resolved': (resolved: {requestId: Wire.CordisInspectRequestId}) => void
}
export interface RunnerRemote {
  $on<E extends keyof RunnerEvents>(event: E, listener: RunnerEvents[E]): () => void
  dynamicCordisRunner: {
    syncInspectManifest(providers: readonly Wire.CordisInspectProviderManifest[]): Promise<RemoteResult<unknown>>
    resolveInspectQuery(agentId: Wire.SessionId, requestId: Wire.CordisInspectRequestId, resolution: Wire.CordisInspectQueryResolution): Promise<RemoteResult<unknown>>
    invoke(pluginId: Wire.CordisDynamicPluginId, pluginRunId: Wire.CordisDynamicPluginRunId, method: string, args: unknown): Promise<RemoteResult<Wire.DynamicCordisInvokeResult>>
    reportRenderFailure(agentId: Wire.SessionId, pluginId: Wire.CordisDynamicPluginId, pluginRunId: Wire.CordisDynamicPluginRunId, failure: DynamicCordisRenderFailure): Promise<RemoteResult<unknown>>
    reportClientGuardFailure(agentId: Wire.SessionId, pluginId: Wire.CordisDynamicPluginId, pluginRunId: Wire.CordisDynamicPluginRunId, failure: CordisErrorDetails): Promise<RemoteResult<unknown>>
    runHostHalf(agentId: Wire.SessionId, pluginId: Wire.CordisDynamicPluginId, packageId: Wire.CordisDynamicPackageId, mode: Wire.CordisDynamicRunMode, requestId: Wire.ApprovalRequestId | null, approveFutureVersions: boolean): Promise<RemoteResult<Wire.DynamicCordisHostHalfResult>>
    getClientCode(agentId: Wire.SessionId, pluginId: Wire.CordisDynamicPluginId, pluginRunId: Wire.CordisDynamicPluginRunId): Promise<RemoteResult<Wire.DynamicCordisClientSource>>
    resolveRequestRun(requestId: Wire.ApprovalRequestId, resolution: Wire.DynamicCordisRunResolution): Promise<RemoteResult<Wire.DynamicCordisResolveAck>>
    settleUserRun(agentId: Wire.SessionId, pluginId: Wire.CordisDynamicPluginId, resolution: Wire.DynamicCordisRunResolution): Promise<RemoteResult<Wire.DynamicCordisRunResponse>>
  }
}
export interface Context {
  [key: string]: unknown
  fiber: {inject: Record<string, unknown>}
  loader: Loader
  remote: RunnerRemote
  get(name: 'slots'): SlotRegistry | undefined
  get(name: 'theme'): ThemeRuntime | undefined
  get(name: string): unknown
  effect(effect: () => () => void, label?: string): () => void
  on(event: 'connection/reset', listener: () => void): () => void
  provide(name: 'cordisInspect', value: ClientCordisInspectRegistry): void
  provide(name: 'dynamicCordisRunner', value: CordisRunnerFace): void
  mixin(service: string, methods: readonly string[]): void
}
export const Context = Cordis.Context
export const Service = Cordis.Service
