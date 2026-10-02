import type { ClientContext } from '../views-types'
export type SessionId = string
export interface SubagentAddress { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' }
export interface SessionProjectionMap {
  tokenUsage: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  subagentTiming: { settledMs: number; active?: { since: number; through: number } }
}
export interface SessionSummary {
  id: string; title?: string; origin?: 'subagent'; parentId?: string; running: boolean
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}
export type SubagentEntry =
  | { kind: 'diagnostic'; id: string; reason: 'corrupt' | 'unsupported' | 'unavailable' }
  | { kind: 'child'; id: string; activity: 'running' | 'inactive'; hasChildren: boolean; mode: 'one-shot' | 'continuable'; label?: string }
export interface SubagentCatalogSnapshot {
  entries: readonly SubagentEntry[]; parentAvailable: boolean; state: 'loading' | 'ready' | 'error'; error: { message: string } | null
}
export interface SessionListState {
  subagentsByParent: Readonly<Record<string, SubagentCatalogSnapshot>>
  byId: Readonly<Record<string, SessionSummary>>
}
export interface ComposerChainProps {
  session?: { running?: boolean; subagent?: { address: SubagentAddress; parentAvailable: boolean } | null }
}
export interface SubagentContext extends ClientContext {
  sessions: {
    openSubagent(address: SubagentAddress): void
    refreshSubagents(id: string): Promise<void>
    setSubagentCatalogOpen(id: string, open: boolean): void
  }
}
