import type Schema from './vendor/schemastery/index'
import {isObjectRecord} from '../shared/runtime-types'

/** Wire format actually emitted by Schemastery's toJSON() (index.ts:296–306).
 * Child references are UID numbers, not live callable schema objects. */
export interface SerializedSchemaNode extends Record<string, unknown> { type: string }
export interface SerializedSchemaRefs extends Record<string, unknown> {
  uid: number
  refs: Record<string, SerializedSchemaNode>
}
export type SerializedSchemaEnvelope = SerializedSchemaNode | SerializedSchemaRefs

declare global {
  namespace Schemastery {
    interface Static {
      /** The unchanged vendor constructor reconstructs this serialized graph.
       * Output is deliberately unknown; only its own resolver validates data. */
      new (options: SerializedSchemaEnvelope): Schema<unknown, unknown>
    }
  }
}

function isNode(raw: unknown, refs?: Readonly<Record<string, unknown>>): raw is SerializedSchemaNode {
  if (!isObjectRecord(raw) || typeof raw.type !== 'string') return false
  if (raw.meta !== undefined && !isObjectRecord(raw.meta)) return false
  const child = (value: unknown): boolean => value === undefined || (refs === undefined
    ? isNode(value) : typeof value === 'number' && Number.isSafeInteger(value) && isObjectRecord(refs[value]))
  if (!child(raw.inner) || !child(raw.sKey)) return false
  if (raw.list !== undefined && (!Array.isArray(raw.list) || !raw.list.every(child))) return false
  if (raw.dict !== undefined && (!isObjectRecord(raw.dict) || !Object.values(raw.dict).every(child))) return false
  return true
}
function isEnvelope(raw: unknown): raw is SerializedSchemaEnvelope {
  if (!isObjectRecord(raw)) return false
  if (raw.refs === undefined) return isNode(raw)
  if (!isObjectRecord(raw.refs) || typeof raw.uid !== 'number' || !Number.isSafeInteger(raw.uid) || !isObjectRecord(raw.refs[raw.uid])) return false
  const refs = raw.refs
  return Object.values(refs).every(value => isNode(value, refs))
}
export function serializedSchemaEnvelope(raw: unknown): SerializedSchemaEnvelope {
  if (!isEnvelope(raw)) throw new TypeError('ui-settings: malformed serialized schema envelope')
  return raw
}
