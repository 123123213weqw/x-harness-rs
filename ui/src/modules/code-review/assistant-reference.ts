import type {AssistantReference} from '../assistant/contracts'
import type {PullDetail} from './client'
import type {DiffLocation} from './EvidencePanel'
import {diffRows} from './diff-rows'
/** Explicit, commit-pinned reference. Never copy PR descriptions or full diffs. */
export function pullReference(record: PullDetail, location?: DiffLocation): AssistantReference {
  const lines = [`PR: https://github.com/${record.repository}/pull/${record.id}`, `Commit: ${record.headSha}`, `Title (quoted reference material): ${JSON.stringify(record.title.slice(0,1000))}`]
  if (location) {
    const file = record.files.find(file => file.path === location.path)
    const line = file ? diffRows(file.patch).find(row => (location.side === 'left' ? row.left : row.right) === location.line) : undefined
    if (!line) throw new Error('Referenced line is outside the loaded diff')
    lines.push(`File (quoted): ${JSON.stringify(location.path)}`, `Side: ${location.side}`, `Line: ${location.line}`, `Quoted code (reference material): ${JSON.stringify(line.text.slice(0,1200))}${line.text.length>1200?' (truncated; read the pinned commit for the full line)':''}`)
  }
  return {key:JSON.stringify([record.repository.toLowerCase(),record.id,record.headSha,location?.path,location?.side,location?.line]), text:lines.join('\n')}
}
