/**
 * approvals domain zod schemas (respond is a client-response; the payload schema serves
 * the /api/respond endpoint's second parse after routing via the pending table).
 * ApprovalRequestId brand cast point: one.
 */

import { z } from 'zod'
import type { ApprovalRequestId } from '../../../interaction/user-approval/types'
import type { ApprovalResponsePayload } from './approvals'
import type { Wire } from './rpc.schema'
import { sessionIdSchema } from './sessions.schema'

/** ApprovalRequestId: one brand cast after schema validation (the only cast point in this domain). */
export const approvalRequestIdSchema = z.string().min(1).brand<'ApprovalRequestId'>().transform(value => value) satisfies z.ZodType<ApprovalRequestId>

/** Approval answer payload (the result.value slot of a client-response). */
export const approvalResponsePayloadSchema = z.object({
  sessionId: sessionIdSchema,
  approvalId: approvalRequestIdSchema,
  outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),
}) satisfies z.ZodType<Wire<ApprovalResponsePayload>>
