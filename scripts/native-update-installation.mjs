// Native acceptance only. Select the owned runner installation, never migrate
// into a user's installation or hide a failed advertised preflight command.
import { win32 } from 'node:path'
import { UpdatePreparationError } from './native-desktop-attachment.mjs'

export async function currentInstallation(invoke, status, ownedDirectory, requirePreflight = false) {
  const capability = status?.updatePreflightSupported
  if (capability != null && typeof capability !== 'boolean') throw new UpdatePreparationError('Invalid native installation preflight capability')
  if (capability !== true) {
    if (requirePreflight) throw new UpdatePreparationError('Source-bound cache rehearsal requires native installation preflight')
    // Older production baselines do not expose this command. Their updater
    // ignores the extra placement field while retaining confirmStop consent.
    return { plan: null, args: { confirmStop: true, placement: 'current' } }
  }
  const plan = await invoke('desktop_update_preflight')
  const validPath = path => typeof path === 'string' && win32.isAbsolute(path)
    && !path.split(/[\\/]/).includes('..') && win32.normalize(path) !== win32.parse(path).root
  if (!plan || typeof plan.needsChoice !== 'boolean' || typeof plan.migrationAvailable !== 'boolean'
      || !validPath(plan.currentDirectory) || !validPath(ownedDirectory)
      || win32.normalize(plan.currentDirectory).toLowerCase() !== win32.normalize(ownedDirectory).toLowerCase()) {
    throw new UpdatePreparationError('Native preflight does not identify the owned runner installation')
  }
  return { plan, args: { confirmStop: true, placement: 'current' } }
}
