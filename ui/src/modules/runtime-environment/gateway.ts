import { validEnvironmentEntry, type EnvironmentCatalogue } from '../client-connection/contracts/environment-catalogue'
export { parseCatalogue } from '../client-connection/contracts/environment-catalogue'
export type { EnvironmentEntry, EnvironmentCatalogue } from '../client-connection/contracts/environment-catalogue'

/** A new-task pick opens another origin. It never rebinds a SessionManager or copies its
 * draft/history/attachment cache. A blocked popup is not a successful switch. */
export function openNewTaskEnvironment(catalogue: EnvironmentCatalogue, canChoose: boolean, id: string, open: (href: string) => Window | null): boolean {
  if (!canChoose) return false
  const target = catalogue.entries.find(e => e.id === id)
  if (target === undefined || id === catalogue.current || !validEnvironmentEntry(target)) return false
  // The target runtime consumes only this navigation intent, never a backend URL.
  return open(target.href + '#new-task') !== null
}
