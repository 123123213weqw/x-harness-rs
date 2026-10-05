import {objectValue} from '../shared/runtime-types'

export interface AutomationSettings {mode: 'reminder' | 'task'; target: 'current_chat' | 'new_chat'; paused: boolean}
export interface ScheduleRecord {id: string; prompt: string; scheduledAt: string; kind: 'after' | 'at' | 'every'; everySeconds?: number; automation?: AutomationSettings}

function validSettings(raw: unknown): raw is AutomationSettings {
  const value = objectValue(raw)
  return (value.mode === 'reminder' || value.mode === 'task')
    && (value.target === 'current_chat' || value.target === 'new_chat') && typeof value.paused === 'boolean'
}
export interface AutomationEntry {sessionId: string; sessionTitle: string; record: ScheduleRecord}
export interface AutomationCatalog {entries: AutomationEntry[]; incompleteSessions: number}

/** Same schedule record validation used by the existing conversation projection. */
export function validRecord(raw: unknown): raw is ScheduleRecord {
  const value = objectValue(raw)
  return typeof value.id === 'string' && typeof value.prompt === 'string'
    && typeof value.scheduledAt === 'string'
    && typeof value.kind === 'string' && ['after', 'at', 'every'].includes(value.kind)
    && Number.isFinite(Date.parse(value.scheduledAt))
    && (value.automation === undefined || validSettings(value.automation))
}

/** Read only the schedules projection in listed chats; never request history bodies. */
export function automationCatalog(value: unknown): AutomationCatalog {
  const items = objectValue(value).items
  if (!Array.isArray(items)) throw Error('Invalid session list')
  const listed: readonly unknown[] = items
  const entries: AutomationEntry[] = []
  let incompleteSessions = 0
  for (const item of listed) {
    const session = objectValue(item)
    if (typeof session.sessionId !== 'string') { incompleteSessions++; continue }
    const projections = objectValue(objectValue(session.projections).values)
    if (!Array.isArray(projections.schedules)) { incompleteSessions++; continue }
    const records: readonly unknown[] = projections.schedules
    const title = typeof projections.title === 'string' && projections.title.trim() !== ''
      ? projections.title : session.sessionId
    const seen = new Set<string>()
    let incomplete = false
    for (const raw of records) {
      if (!validRecord(raw)) { incomplete = true; continue }
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      const record: ScheduleRecord = {id: raw.id, prompt: raw.prompt, kind: raw.kind, scheduledAt: raw.scheduledAt}
      if (typeof raw.everySeconds === 'number' && Number.isFinite(raw.everySeconds) && raw.everySeconds > 0) record.everySeconds = raw.everySeconds
      else if (record.kind === 'every') incomplete = true
      if (raw.automation !== undefined) {
        const {mode, target, paused} = raw.automation
        record.automation = {mode, target, paused}
      }
      entries.push({sessionId: session.sessionId, sessionTitle: title, record})
    }
    if (incomplete) incompleteSessions++
  }
  return {entries: entries.sort((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt)), incompleteSessions}
}
