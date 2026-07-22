/// <reference path="./external.d.ts" />
import { ComposerAttachments } from './ComposerAttachments'
import { MessageImages } from './MessageImages'
import type { SlotsService } from '../shared/runtime-types'
export const inject = ['slots']
export function apply(ctx: { slots: SlotsService }): void {
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({ name: 'conversation.input.attachments', locale: 'conversation' }, ComposerAttachments))
  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({ name: 'conversation.message.images', locale: 'conversation' }, MessageImages))
}
