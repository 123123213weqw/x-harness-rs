import type {AssistantReference} from './contracts'
import {diffRows} from '../shared/diff/hunks'
export interface PullReferenceRecord {
  readonly repository: string; readonly id: number; readonly headSha: string; readonly title: string
  readonly files: readonly {readonly path: string; readonly patch: string | null}[]
}
export interface PullReferenceLocation {readonly path: string; readonly side: 'left' | 'right'; readonly line: number}
/** Explicit, commit-pinned reference. Never copy PR descriptions or full diffs. */
export function pullReference(record: PullReferenceRecord, location?: PullReferenceLocation): AssistantReference {
  const lines = [`PR: https://github.com/${record.repository}/pull/${record.id}`, `Commit: ${record.headSha}`, `Title (quoted reference material): ${JSON.stringify(record.title.slice(0,1000))}`]
  if (location) {
    const file = record.files.find(file => file.path === location.path)
    const line = file ? diffRows(file.patch).find(row => (location.side === 'left' ? row.left : row.right) === location.line) : undefined
    if (!line) throw new Error('Referenced line is outside the loaded diff')
    lines.push(`File (quoted): ${JSON.stringify(location.path)}`, `Side: ${location.side}`, `Line: ${location.line}`, `Quoted code (reference material): ${JSON.stringify(line.text.slice(0,1200))}${line.text.length>1200?' (truncated; read the pinned commit for the full line)':''}`)
  }
  return {key:JSON.stringify([record.repository.toLowerCase(),record.id,record.headSha,location?.path,location?.side,location?.line]), text:lines.join('\n')}
}
