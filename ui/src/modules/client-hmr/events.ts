import {isRecord} from '../client-runtime/value-guards'
/** Dev SSE protocol. Transport values are validated before a reload is admitted. */
export type PluginsEventFrame =
  | { type: 'graph'; graph: unknown }
  | { type: 'rebuilt'; id: string; rev: string }

export const EVENTS_ENDPOINT = '/plugins/events'

export function parsePluginsEventFrame(value: unknown): PluginsEventFrame | undefined {
  if (!isRecord(value)) return undefined
  const frame = value
  if (frame.type === 'graph') return { type: 'graph', graph: frame.graph }
  if (frame.type === 'rebuilt' && typeof frame.id === 'string' && typeof frame.rev === 'string') {
    return { type: 'rebuilt', id: frame.id, rev: frame.rev }
  }
  return undefined
}
