/**
 * Host transport for the settings-namespace scope contract. The contract types
 * live in `dsh-client-runtime` (the common dependency of every feature that
 * owns a preference); this file owns the per-namespace derivation over the
 * shared {@link SettingsDescribeMirror} and the serialized write path, both of
 * which are Settings-surface concerns. Reads never touch the wire here: the
 * mirror is the one `settings.describe` reader, and every scope is a selector
 * over its snapshot.
 */

import {cordisSettingsContext, settingsContext} from './context'
import { Service as CordisService } from '@xharness/cordis'
import type {SettingsContext as Context} from './contracts'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView, SettingsPathOpView,
} from './contracts'
import type {SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec, SnapshotStore} from './contracts'
import {
  createSnapshotStore,
} from '@xharness/dsh-client-runtime/client'
// Type-only, and deliberately NOT `@xharness/dsh-api-remotes/client`: this
// package is reachable from the Host build graph through its feature-package
// callers, and api-remotes' Client face imports a Host-tsdown-generated
// `/remote` artifact, which would deadlock the Host tsc phase. The gateway's
// Client half declares `ctx.remote` with no generated import, and the
// allowlist's `types` subpath is a pure-type source file, so the pair supplies
// `$on` and its key face without dragging a build artifact in. The runtime
// `remote` injection belongs to the providing plugin's apply, which registers
// the mirror's invalidation subscriptions.
// The forwarded event's own declaration: `$on`'s key face is
// `Extract<keyof Events, keyof Selection>`, so the allowlist alone resolves to
// never — the owning package's client-safe, type-only subpath supplies the
// cordis `Events` entry (and with it the branded `SettingsNamespace`).
import type { SettingsSchemaService } from './schema'
import { SettingsDescribeMirror, type SettingsDescribeFace } from './settings-mirror'
import { settingsSaveFeedback } from './save-feedback'

const Service = CordisService

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * One namespace's derived view over the shared describe mirror, plus that
 * namespace's serialized Host writes. Writes carry the latest known namespace
 * revision, fold their answers back into the mirror, and teardown waits for
 * the operation already crossing the wire.
 */
abstract class SettingsScopeBase<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private readonly unsubscribe: (() => void) | undefined
  /**
   * Revision answered by a superseded write still ahead of the mirror: the
   * mirror only folds the LATEST settlement in, so a queued successor takes
   * its fence from here first.
   */
  private pendingRevision: number | undefined

  /**
   * @param api - settings wire face (writes only; reads ride the mirror).
   * @param spec - namespace identity and optional narrowing decoder.
   * @param mirror - the shared describe mirror this scope derives from.
   * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
   * @param schema - settings-owned schema operations.
   */
  constructor(
    private readonly api: SettingsFace,
    protected readonly spec: SettingsScopeSpec<T>,
    private readonly mirror: SettingsDescribeMirror,
    private readonly persistence: 'host' | 'memory',
    protected readonly schema: SettingsSchemaService,
  ) {
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: persistence === 'host' ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: persistence,
    })
    if (persistence === 'host') {
      this.unsubscribe = mirror.subscribe(() => { this.derive() })
      this.derive()
    }
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Queue one field write; see {@link SettingsScope.set} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  /**
   * Queue one field clear; see {@link SettingsScope.unset} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.pendingRevision ?? this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
      } catch (_settingsWriteFailure) {
        await this.recover(generation)
        return
      }
      if (!response.result.ok) {
        await this.recover(generation)
        return
      }
      if (this.disposed) return
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(response.result.value)
        settingsSaveFeedback(this.spec.namespace, false)
      } else {
        this.pendingRevision = response.result.value.revision
      }
    })
  }

  /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    try { await this.mirror.load() } catch { /* A failed reread is still a failed save. */ }
    if (!this.disposed && generation === this.writeGeneration) settingsSaveFeedback(this.spec.namespace, true)
  }

  /**
   * Stop queued operations, stop deriving, and wait for the current wire call
   * to settle.
   * @returns settlement after the controller reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.persistence === 'memory' || this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    // The returned task carries its own settlement to the caller; the queue
    // tail is kept fulfilled so one failed subscriber cannot strand later operations.
    this.tail = task.catch(() => {})
    return task
  }

  private derive(): void {
    if (this.disposed) return
    const mirrored = this.mirror.getSnapshot()
    if (mirrored.view === undefined) return
    const { writable } = mirrored.view
    const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = 'unavailable'
        draft.writable = writable
      })
      return
    }
    const decoded = this.decode(view)
    const previous = this.store.getSnapshot()
    const next: SettingsScopeSnapshot<T> = {
      ...previous, revision:view.revision, base:view.base, user:view.user, writable,
      ...(decoded === undefined ? {} : {status:'ready',value:decoded}),
    }
    // A decoded generic value is a replacement, never an unproved Immer Draft<T>.
    // Preserve the recipe's no-op identity/notification behavior when every field
    // is unchanged; the store remains the only publication boundary.
    if (next.revision !== previous.revision || next.base !== previous.base
      || next.user !== previous.user || next.writable !== previous.writable
      || next.status !== previous.status || next.value !== previous.value) this.store.set(next)
  }

  protected abstract decode(view: SettingsNamespaceView): T | undefined

}



/** Default public JS controller preserves optional-decoder behavior. Without a
 * domain decoder it validates a record, never promises an arbitrary T. */
export class SettingsScopeController extends SettingsScopeBase<unknown> {
  protected decode(view: SettingsNamespaceView): unknown {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Sections are plain objects by construction; schemastery alone would
    // resolve null or an array through object defaults instead of refusing.
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // A schema envelope this client cannot rehydrate vouches for no section;
      // the value is treated exactly like a schema-invalid one.
      return undefined
    }
    return failure === undefined ? view.value : undefined
  }
}
interface DecodedSettingsScopeSpec<T> extends SettingsScopeSpec<T> {
  decode(section: unknown): T | undefined
}
class DecodedSettingsScopeController<T> extends SettingsScopeBase<T> {
  constructor(api: SettingsFace, spec: DecodedSettingsScopeSpec<T>, mirror: SettingsDescribeMirror,
    persistence: 'host' | 'memory', schema: SettingsSchemaService) {
    super(api, spec, mirror, persistence, schema)
  }
  protected decode(view: SettingsNamespaceView): T | undefined {
    return this.spec.decode?.(view.value)
  }
}

/**
 * The settings domain's base service. Features that own a preference reach the
 * settings transport through this service rather than a shared function: the
 * client bundle purity gate forbids cross-plugin value imports and directs
 * cross-plugin collaboration through cordis services
 * (`packages/client/tsdown.client.ts`).
 */
export class SettingsScopeBinder extends Service {
  private readonly mirror: SettingsDescribeMirror
  private readonly schema: SettingsSchemaService

  /**
   * @param ctx - the providing plugin's context.
   * @param config - the shared describe mirror every bound scope derives from,
   * plus the settings-owned schema operations.
   */
  constructor(ctx: Context, config: { mirror: SettingsDescribeMirror; schema: SettingsSchemaService }) {
    super(cordisSettingsContext(ctx), 'settingsScope')
    this.mirror = config.mirror
    this.schema = config.schema
  }

  /**
   * The shared mirror's read/fold face for cross-namespace surfaces (schema
   * introspection, the served-namespace directory). Per-namespace consumers
   * use {@link bind}; both derive from the same snapshot, so they can never
   * disagree about the document.
   * @returns the describe face over the shared mirror.
   */
  describe(): SettingsDescribeFace {
    return this.mirror
  }

  /**
   * Bind one namespace scope on the CALLER's plugin lifecycle — the service
   * proxy binds `this.ctx` to the caller at call time, so the scope's disposer
   * belongs to the calling fiber. The scope derives from the shared mirror
   * (whose invalidation subscriptions live with the providing plugin), so
   * binding adds no wire read of its own and activation never blocks on the
   * settings transport.
   * @param spec - domain-owned namespace contract.
   * @returns the bound scope consumed by the domain's services and rows.
   */
  bind<T>(spec: DecodedSettingsScopeSpec<T>): SettingsScope<T>
  bind(spec: {namespace: string}): SettingsScope<unknown>
  bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<unknown> {
    const traced: unknown = this.ctx
    const ctx = settingsContext(traced)
    const connection = ctx.get('connection')
    const persistence = connection.isLoopback ? 'host' : 'memory'
    const controller = spec.decode === undefined
      ? new SettingsScopeController(connection.api, spec, this.mirror, persistence, this.schema)
      : new DecodedSettingsScopeController(connection.api,
        {namespace: spec.namespace, decode: spec.decode}, this.mirror, persistence, this.schema)
    ctx.effect(() => {
      void this.mirror.ensure()
      return async () => {
        await controller.dispose()
      }
    }, `ui-settings: ${spec.namespace} settings scope`)
    return controller
  }
}
