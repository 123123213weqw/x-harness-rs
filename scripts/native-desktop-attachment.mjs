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
