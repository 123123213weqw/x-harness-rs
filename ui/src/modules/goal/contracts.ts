import type { ApiResult, ClientContext, ConversationNodeDefinition } from '../views-types'
export interface GoalRef { id: string; revision: number }
export interface GoalSnapshot extends GoalRef {
  objective: string; phase: 'active' | 'paused' | 'blocked' | 'complete'
  maxGoalRounds: number; roundsStarted?: number; blockedReason?: { message: string }
}
export interface GoalExecution {
  state: string; roundsStarted?: number; maxGoalRounds?: number; pauseReason?: string; pauseDetail?: string
  report?: { summary?: string; remaining?: readonly string[]; evidence?: readonly { kind: string; reference?: string; execution_id?: string }[] }
}
export interface GoalProjection { goal: GoalSnapshot; execution?: GoalExecution }
export type GoalActionResult = ApiResult<unknown>
export interface GoalBarActions {
  onEdit(objective: string): Promise<GoalActionResult>
  onPause(): Promise<GoalActionResult>
  onResume(): Promise<GoalActionResult>
  onClear(): Promise<GoalActionResult>
  onComplete(): Promise<GoalActionResult>
  onBudget(maxGoalRounds: number): Promise<GoalActionResult>
}
export interface GoalContext extends Omit<ClientContext, 'remote'> {
  sessions: { binding(id: string): { session: { projections: { faceOf(name: 'goal'): { getSnapshot(): GoalProjection | null | undefined } | undefined } } } | undefined }
  remote: ClientContext['remote'] & { goals: {
    edit(id: string, ref: GoalRef, patch: { objective?: string; maxGoalRounds?: number }): Promise<GoalActionResult>
    pause(id: string, ref: GoalRef): Promise<GoalActionResult>
    resume(id: string, ref: GoalRef): Promise<GoalActionResult>
    clear(id: string, ref: GoalRef): Promise<GoalActionResult>
    complete(id: string, ref: GoalRef): Promise<GoalActionResult>
  } }
}
export type { ConversationNodeDefinition }
