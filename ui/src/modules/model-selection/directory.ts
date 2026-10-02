import {castDraft} from 'immer'
import { createSnapshotStore } from '@xharness/dsh-client-runtime/client'
import { errorText } from '../shared/runtime-types'
import type { ModelDirectoryState, ModelSelection, SessionsWire, DirectoryRequestOwner, MutableModelStore } from './contracts'

const modelStore = createSnapshotStore

/** Reports network errors only to the operation that still owns the directory. */
async function modelRequest<T>(directory: DirectoryRequestOwner, generation: number, request: Promise<T>): Promise<T> {
  try { return await request }
  catch (error: unknown) {
    if (!directory.disposed && directory.generation === generation) {
      directory.store.update(state => { state.status = 'error'; state.error = errorText(error) })
    }
    throw error
  }
}

/** Both /model and the composer resolve this same per-session state. */
export class ModelDirectory {
  readonly store = modelStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })
  generation = 0
  disposed = false
  constructor(readonly sessions: SessionsWire, readonly sessionId: string, readonly available: () => boolean) {}

  async load(refreshCapabilities = false) {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update(state => { state.status = 'loading'; state.error = null })
    const { result } = await modelRequest(this, generation, this.sessions.models({ sessionId: this.sessionId, refreshCapabilities }))
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    if (!result.ok) {
      this.store.update(state => { state.status = 'error'; state.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.store.update(state => {
      state.current = current; state.routable = routable; state.groups = castDraft(groups)
      state.failures = castDraft(failures); state.status = 'ready'; state.error = null
    })
    return result.value
  }
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update(state => { state.status = 'selecting'; state.error = null })
    const { result } = await modelRequest(this, generation, this.sessions.selectModel({
      sessionId: this.sessionId, provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      ...(selection.contextWindowTokens === undefined ? {} : { contextWindowTokens: selection.contextWindowTokens }),
    }))
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update(state => { state.status = 'error'; state.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    this.store.update(state => { state.current = result.value.selected; state.routable = true; state.status = 'ready'; state.error = null })
  }
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update(state => {
      state.current = null; state.routable = null; state.groups = []; state.failures = []; state.status = 'idle'; state.error = null
    })
    if (this.available()) void this.load().catch(() => {})
  }
  dispose(): void { this.disposed = true }
  assertAvailable(): void {
    if (!this.available()) throw new Error('model selection is unavailable for addressed subagent sessions')
  }
}
