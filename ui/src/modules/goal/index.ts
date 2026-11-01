/**
 * Goal surface plugin, browser half: the GoalBar entry in the
 * conversation.input.dock strip. Projection-mode surface — the live goal
 * arrives through `useProjection('goal')` (seeded by the history tail page,
 * updated by session/projection frames), so this plugin owns no store, no
 * refresh chain, and no event listener. The inject face carries only the
 * four mutation verbs through the generated Goal Remote API;
 * their CAS ref reads the session's current projected value at call time.
 * Goal creation stays on the /goal host command.
 */
import type { SessionId } from '../views-types'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
// Type-only: the `goal` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type { GoalContext, GoalRef, GoalActionResult, GoalBarActions } from './contracts'
import { GoalDock } from './GoalBar'
import { ProgressDock } from './ProgressDock'
import { GoalCommandInputView } from './GoalCommandInputView'
import { goalCommandInputDefinition } from './goal-command-input'
import { en, zh, type GoalKey } from './locales'

export { GoalBar, GoalDock } from './GoalBar'
export { ProgressDock } from './ProgressDock'
export type { GoalActionResult, GoalBarActions } from './contracts'
export type { GoalKey } from './locales'



/** Dictionary namespace owned by this plugin. */
const NS = 'goal'

/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents']

/**
 * Client plugin body: the GoalBar dock entry with its mutation verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: GoalContext): void {
  ctx.conversationEvents.register(goalCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command-input',
    locale: NS,
  }, GoalCommandInputView))

  const sessions = ctx.sessions

  /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
  const refOf = (sessionId: SessionId): GoalRef | undefined => {
    const face = sessions.binding(sessionId)?.session.projections.faceOf('goal')
    const projection = face?.getSnapshot()
    if (projection == null) return undefined
    return { id: projection.goal.id, revision: projection.goal.revision }
  }

  const noCurrentGoal: GoalActionResult = {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate', details: {} },
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): GoalBarActions => ({
      onEdit: async (objective, expected) => {
        // Bind the draft to the viewed text/identity, not a stale round-stat revision.
        const projection = sessions.binding(sessionId)?.session.projections.faceOf('goal')?.getSnapshot()
        if (projection == null) return noCurrentGoal
        const current = projection.goal
        if (expected !== undefined && (expected.id !== current.id || expected.objective !== current.objective)) {
          return {ok: false, error: {code: 'goal-changed', message: 'Goal changed while editing; draft retained. Reload the latest Goal before saving.', details: {}}}
        }
        return await ctx.remote.goals.edit(sessionId, {id: current.id, revision: current.revision}, { objective })
      },
      onPause: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.pause(sessionId, ref)
      },
      onResume: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.resume(sessionId, ref)
      },
      onComplete: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.complete(sessionId, ref)
      },
      onClear: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.clear(sessionId, ref)
      },
    }),
  }, GoalDock))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'task-progress', order: 9, locale: NS,
  }, ProgressDock))
}
