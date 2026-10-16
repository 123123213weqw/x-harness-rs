// Native acceptance only: distinguish a still-live old version, a retired CDP
// page, and a genuinely healthy new app. Never turn a failed new Host into success.
export function attachmentState(expectedVersion, status, requireHydration = false) {
  // A live process may still expose only /desktop/starting while restoring
  // sessions. Older releases without startup telemetry remain compatible.
  const productReady = status?.startup == null
    || (Number.isFinite(status.startup.hostReadyMs) && status.startup.hostReadyMs >= 0)
  const hydrated = Number.isFinite(status?.startup?.frontendHydratedMs)
    && Number.isFinite(status?.startup?.firstFrameMs)
  return {
    ready: status?.version === expectedVersion && status?.hostRunning === true
      && status?.updaterConfigured === true && status?.startupError == null
      && productReady && (!requireHydration || hydrated),
    retired: status?.version !== expectedVersion && status?.hostRunning === false,
  }
}

// Acceptance follows the production updater's snapshot. Background preparation
// may have consumed the available state before the test can observe it.
export class UpdatePreparationError extends Error {}

export function preparationAction(expectedVersion, status, { corrupt = false, corruptRequestSeen = false, retryRejected = false } = {}) {
  if (status?.phase === 'idle' || status?.phase === 'up-to-date') return 'check'
  if (status?.phase === 'checking') return 'wait'
  if (status?.version !== expectedVersion) throw new UpdatePreparationError('Updater candidate version differs from the exact acceptance target')
  if (status.phase === 'available') return 'download'
  if (status.phase === 'downloading') return 'wait'
  if (status.phase === 'downloaded') {
    if (corrupt) throw new UpdatePreparationError('Corrupted updater fixture was accepted')
    return 'ready'
  }
  if (status.phase === 'error' && status.retryAction === 'download') {
    if (corrupt && corruptRequestSeen) return 'rejected'
    if (!corrupt && retryRejected) return 'download'
  }
  throw new UpdatePreparationError(status?.message || 'Unexpected updater preparation phase')
}
