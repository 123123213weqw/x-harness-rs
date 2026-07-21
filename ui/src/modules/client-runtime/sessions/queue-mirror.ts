import { isRecord } from '../value-guards'
import type { MuxFrame } from '../../client-connection/index'
import type { SessionWireEvent } from '../../client-connection/contracts/host/apiproxy/api/sessions'
import type { QueuedMessage } from './conversation'

const QUEUE_PREVIEW_CHARS = 200

function previewOf(content: readonly { type: string }[]): string {
  const flat = content
    .map(block => (block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: readonly { type: string }[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => 'text' in block && typeof block.text === 'string' ? block.text : '').join('')
}

type QueueItems = Extract<MuxFrame, { type: 'session/queue' }>['items']

/** Authoritative transient queue projection and durable steering handoff. */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []

  /**
   * Return the current immutable queue projection.
   * @returns current queue rows.
   */
  snapshot(): readonly QueuedMessage[] {
    return this.current
  }

  /**
   * Drop the stale generation before its replacement queue baseline arrives.
   * @returns whether any projected queue row was removed.
   */
  reset(): boolean {
    if (this.current.length === 0) return false
    this.current = []
    return true
  }

  /**
   * Replace from one authoritative stream queue frame.
   * @param items - complete host queue snapshot.
   */
  replace(items: QueueItems): void {
    this.current = items.map(item => ({
      id: item.id,
      messageId: item.message.id,
      placement: item.placement,
      content: item.message.content,
      preview: previewOf(item.message.content),
      text: textOf(item.message.content),
    }))
  }

  /**
   * Retire a transient steering row once its durable message enters the log.
   * @param event - newly contiguous durable Session event.
   * @returns whether the projection changed.
   */
  acceptDurable(event: SessionWireEvent): boolean {
    if (event.type !== 'user/message' || !isRecord(event.data) || typeof event.data.id !== 'string') return false
    const messageId = event.data.id
    const index = this.current.findIndex(item =>
      item.placement === 'steering' && item.messageId === messageId)
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
