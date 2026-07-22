/** Parser-time queue ABI. This script runs before the parser-preloaded modules
 * and runtime factories and before the ESM main imports its singleton seed. */
import type { ClientBundleRegistration, ClientModuleLoaderTarget } from '../client-modules/manifest'
import type { createClientModuleSystem } from '../client-modules/index'

interface BootstrapModule extends Record<string, unknown> {
  createClientModuleSystem: typeof createClientModuleSystem
  apply(context: unknown): void
}
function isBootstrapModule(value: Record<string, unknown>): value is BootstrapModule {
  return typeof value.createClientModuleSystem === 'function' && typeof value.apply === 'function'
}
const pendingQueue: ClientBundleRegistration[] = []
const loader: ClientModuleLoaderTarget = {
  mode: 'queue',
  pendingQueue,
  load(registration) { pendingQueue.push(registration) },
  create(options) {
    if (this.mode !== 'queue') throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
    const index = pendingQueue.findIndex(registration => registration.id === '@xharness/dsh-client-modules')
    const registration = pendingQueue[index]
    if (registration === undefined) throw new Error('client-modules: HTML did not preload @xharness/dsh-client-modules/client.js')
    pendingQueue.splice(index, 1)
    const exports = registration.factory(specifier => {
      throw new Error('client-modules: @xharness/dsh-client-modules/client.js requested external "' + specifier + '" before the module system existed')
    })
    if (typeof exports !== 'object' || exports === null || !isBootstrapModule(exports)) {
      throw new Error('client-modules: @xharness/dsh-client-modules/client.js did not export the bootstrap module face')
    }
    return exports.createClientModuleSystem(this, {id: registration.id, exports}, options)
  },
}
window.__ModuleLoader__ = loader
