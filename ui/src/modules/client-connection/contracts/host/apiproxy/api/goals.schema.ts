/**
 * goals domain zod schemas. Mutation-only shapes: every value schema is a
 * `{ ref }` acknowledgement (clear: `{ cleared }`) — the current goal state
 * travels exclusively on the 'goal' session projection.
 */

import { z } from 'zod'
import type { Wire } from './rpc.schema'
import type { GoalRef, RequestPayload, ResponseValue } from './index'

/** GoalRef schema. */
export const goalRefSchema = z.object({
  id: z.string().brand<'GoalId'>().transform(value => value),
  revision: z.number().int().positive(),
}) satisfies z.ZodType<Wire<GoalRef>>

/** Shared `{ ref }` acknowledgement value of every non-clear mutation. */
const goalRefValueSchema = z.object({ ref: goalRefSchema })

/** goal.create request payload. */
export const goalCreateRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  objective: z.string().min(1),
  maxGoalRounds: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'goal.create'>>>

/** goal.create response value. */
export const goalCreateValueSchema = goalRefValueSchema satisfies z.ZodType<Wire<ResponseValue<'goal.create'>>>

/** goal.edit request payload. */
export const goalEditRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  ref: goalRefSchema,
  objective: z.string().min(1).optional(),
  maxGoalRounds: z.number().int().positive().optional(),
}).refine(value => value.objective !== undefined || value.maxGoalRounds !== undefined, {
  message: 'goal.edit requires objective or maxGoalRounds',
}) satisfies z.ZodType<Wire<RequestPayload<'goal.edit'>>>

/** goal.edit response value. */
export const goalEditValueSchema = goalRefValueSchema satisfies z.ZodType<Wire<ResponseValue<'goal.edit'>>>

/** goal.pause request payload. */
export const goalPauseRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  ref: goalRefSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'goal.pause'>>>

/** goal.pause response value. */
export const goalPauseValueSchema = goalRefValueSchema satisfies z.ZodType<Wire<ResponseValue<'goal.pause'>>>

/** goal.resume request payload. */
export const goalResumeRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  ref: goalRefSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'goal.resume'>>>

/** goal.resume response value. */
export const goalResumeValueSchema = goalRefValueSchema satisfies z.ZodType<Wire<ResponseValue<'goal.resume'>>>

/** goal.complete request payload. */
export const goalCompleteRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  ref: goalRefSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'goal.complete'>>>

/** goal.complete response value. */
export const goalCompleteValueSchema = goalRefValueSchema satisfies z.ZodType<Wire<ResponseValue<'goal.complete'>>>

/** goal.clear request payload. */
export const goalClearRequestSchema = z.object({
  sessionId: z.string().brand<'SessionId'>().transform(value => value),
  ref: goalRefSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'goal.clear'>>>

/** goal.clear response value. */
export const goalClearValueSchema = z.object({
  cleared: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'goal.clear'>>>
