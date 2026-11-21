import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {objectValue} from '../shared/runtime-types'
export type ProjectCI = 'none'|'unknown'|'outdated'|'pending'|'passing'|'failing'|'neutral'
export type ProjectGitHub = {kind: 'unsupported'|'ambiguous'|'no_pr'; ci: ProjectCI} | {
  kind: 'ready'; ci: ProjectCI; repository: string; branch: string; localSha: string; headSha: string
  number: number; url: string; state: 'OPEN'|'CLOSED'|'MERGED'; draft: boolean
}
export type ReadProjectStatus = (workspaceId: string, signal: AbortSignal) => Promise<ProjectGitHub>
function isCI(v: unknown): v is ProjectCI {return v === 'none' || v === 'unknown' || v === 'outdated' || v === 'pending' || v === 'passing' || v === 'failing' || v === 'neutral'}
function isPRState(v: unknown): v is 'OPEN'|'CLOSED'|'MERGED' {return v === 'OPEN' || v === 'CLOSED' || v === 'MERGED'}
export function parseProjectGitHub(raw: unknown): ProjectGitHub {
  const v = objectValue(raw)
  if (!isCI(v.ci)) throw Error('Invalid project CI status')
  const ci = v.ci
  if (v.kind === 'unsupported' || v.kind === 'ambiguous' || v.kind === 'no_pr') {
    if (ci !== 'none' && ci !== 'unknown') throw Error('Invalid absent PR status')
    return {kind: v.kind, ci}
  }
  if (v.kind !== 'ready' || typeof v.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) ||
      v.repository.split('/').some(s => s === '.' || s === '..') || typeof v.branch !== 'string' || !v.branch || v.branch.length > 1024 || /[\x00-\x1f\x7f]/.test(v.branch) ||
      typeof v.localSha !== 'string' || !/^[a-f0-9]{40}$/i.test(v.localSha) || typeof v.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(v.headSha) ||
      typeof v.number !== 'number' || !Number.isSafeInteger(v.number) || v.number < 1 || typeof v.draft !== 'boolean' ||
      !isPRState(v.state) || typeof v.url !== 'string' || v.url !== `https://github.com/${v.repository}/pull/${v.number}` ||
      (v.localSha !== v.headSha && ci !== 'outdated')) throw Error('Invalid project GitHub status')
  return {kind: 'ready', ci, repository: v.repository, branch: v.branch, localSha: v.localSha, headSha: v.headSha,
    number: v.number, url: v.url, state: v.state, draft: v.draft}
}
export function projectStatusReader(rpc: ClientConnectionRpc): ReadProjectStatus {
  return async (workspaceId, signal) => {
    const response = await rpc.call('/api', 'github/project-status', {workspaceId}, AbortSignal.any([signal, AbortSignal.timeout(50_000)]))
    if (!response.ok) throw Error(response.error.message)
    return parseProjectGitHub(response.value)
  }
}
/** One mounted row/Host generation. No scheduled refreshes or persisted cache.
 * A superseded/disposed response cannot update a different project or Host. */
export class ProjectStatusRequest {
  private controller: AbortController | undefined
  private disposed = false
  constructor(private readonly read: ReadProjectStatus, private readonly id: string) {}
  async refresh(publish: (value: ProjectGitHub|undefined, error: string|undefined, loading: boolean) => void): Promise<void> {
    if (this.disposed || this.controller) return
    const controller = new AbortController(); this.controller = controller
    publish(undefined, undefined, true)
    try {
      const value = await this.read(this.id, controller.signal)
      if (!this.disposed && !controller.signal.aborted) publish(value, undefined, false)
    } catch (e: unknown) {
      if (!this.disposed && !controller.signal.aborted) publish(undefined, e instanceof Error ? e.message : 'Project status failed', false)
    } finally {if (this.controller === controller) this.controller = undefined}
  }
  dispose(): void {this.disposed = true; this.controller?.abort(); this.controller = undefined}
}
