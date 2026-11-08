import type { EnvironmentCatalogueClient } from './install'

/** Real optional Gateway discovery belongs to the production wire root. A
 * fixture connection never installs this capability and cannot leak HTTP. */
export function createWebEnvironmentCatalogue(): EnvironmentCatalogueClient {
  return {
    async read(signal) {
      if (typeof location === 'undefined' || location.origin === 'null') throw new Error('environment catalogue requires a browser origin')
      const response = await globalThis.fetch(new URL('/api/environments', location.origin), {
        signal, cache: 'no-store', credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`environment catalogue unavailable: HTTP ${response.status}`)
      const value: unknown = await response.json()
      return value
    },
  }
}
