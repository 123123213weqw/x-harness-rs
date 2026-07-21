import { z } from 'zod'
/** Attachment identifier brand. @module @deepseek-ai/dsh-attachment/brand */

import type { Branded } from '../../util/brand/index'

/** Opaque content-addressed identifier for one immutable attachment object. */
export type AttachmentId = Branded<'AttachmentId'>

/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
export function AttachmentId(value: string): AttachmentId {
  return z.string().brand<'AttachmentId'>().parse(value)
}
