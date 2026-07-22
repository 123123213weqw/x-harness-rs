/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @xharness/dsh-client-web/src/boot
 */
import { Context } from '@xharness/cordis'
import Loader from '@xharness/cordis-plugin-loader'
import type {
  ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@xharness/dsh-client-modules/client'
import { BootPage } from './boot-page'
import { getStaticModules } from './seed'
import { STATE_LABELS } from './loader-status'
import './base.css'

interface UiRenderer { mount(container: HTMLElement): () => void }
function isUiRenderer(value: unknown): value is UiRenderer {
  return typeof value === 'object' && value !== null && 'mount' in value && typeof value.mount === 'function'
}

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      const win: DshWindow = window
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      const modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...this.seams,
      })

      const prefetching = this.prefetchImmediateTier(modules)
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, modules, prefetching)
      await this.mountApp(ctx)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      const renderer: unknown = scope.get('uiRenderer')
      if (!isUiRenderer(renderer)) throw new Error('web boot: uiRenderer service has no mount operation')
      scope.effect(() => renderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(modules: ClientModuleSystem): Promise<void> {
    await Promise.all(modules.manifest.plugins
      .filter(row => row.immediately)
      .map(row => modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, modules: ClientModuleSystem, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // The original SDK models Node's loader. The browser adapter deliberately
    // installs ClientModuleSystem, whose import/cache ABI is consumed by EntryTree.
    Object.assign(loader, {internal: modules})

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = modules.manifest.plugins.map(row => row.id)
    this.page.setTotal(rows.length)
    await prefetching
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
