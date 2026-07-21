import { isObjectRecord } from '../shared/runtime-types'
import type { ImageAttachmentRef } from './types/wire'
export function isUnknownArray(value: unknown): value is unknown[] { return Array.isArray(value) }
export function isImageAttachmentRef(value: unknown): value is ImageAttachmentRef {
  if (!isObjectRecord(value) || typeof value.attachmentId !== 'string' || typeof value.mediaType !== 'string' || typeof value.bytes !== 'number') return false
  return (value.name === undefined || typeof value.name === 'string')
    && (value.width == null || typeof value.width === 'number')
    && (value.height == null || typeof value.height === 'number')
}
