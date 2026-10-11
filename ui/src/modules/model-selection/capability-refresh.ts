import type { ModelDirectory } from './directory'

// One coordinator per Host connection, not one force-refresh per composer.
// Only metadata from an already configured discovery source is eligible.
type Directory = Pick<ModelDirectory, 'store' | 'load' | 'available' | 'disposed'>
type Scheduler = { now(): number; later(run: () => void): () => void }
const scheduler: Scheduler = {
  now: () => Date.now(),
  later: run => { const timer = setTimeout(run, 1500); return () => { clearTimeout(timer) } },
}
function staleProvider(directory: Directory): string | undefined {
  if (directory.disposed || !directory.available()) return undefined
  const state = directory.store.getSnapshot()
  if (state.status !== 'ready' || state.current === null) return undefined
  const provider = state.groups.find(group => group.id === state.current?.provider)
  const capability = provider?.models.find(model => model.id === state.current?.model)?.reasoningCapability
  if (!capability?.stale || capability.state === 'disabled') return undefined
  if (!['provider_reported', 'last_known_good', 'discovery_failed'].includes(capability.source ?? '')) return undefined
  return provider?.id
}
export class CapabilityRefresh {
  private readonly waiting = new Map<Directory, () => void>()
  private readonly attempts = new Map<string, number>()
  private running = false
  constructor(private readonly clock: Scheduler = scheduler) {}
  cancel(directory: Directory): void { this.waiting.get(directory)?.(); this.waiting.delete(directory) }
  schedule(directory: Directory): void {
    if (staleProvider(directory) === undefined) { this.cancel(directory); return }
    if (this.waiting.has(directory)) return
    this.waiting.set(directory, this.clock.later(() => {
      this.waiting.delete(directory)
      void this.refresh(directory)
    }))
  }
  private async refresh(directory: Directory): Promise<void> {
    const provider = staleProvider(directory)
    if (provider === undefined || this.running) return
    const at = this.clock.now(), previous = this.attempts.get(provider)
    if (previous !== undefined && at - previous < 5 * 60_000) return
    // Even a failed attempt has a cooldown; reopening a menu must not spin.
    this.attempts.delete(provider); this.attempts.set(provider, at)
    if (this.attempts.size > 128) {
      const oldest = this.attempts.keys().next()
      if (!oldest.done) this.attempts.delete(oldest.value)
    }
    this.running = true
    try { await directory.load(true) }
    catch { /* Directory retains last-good choices and reports the real error. */ }
    finally { this.running = false }
  }
}
