// Native acceptance only: distinguish a still-live old version, a retired CDP
// page, and a genuinely healthy new app. Never turn a failed new Host into success.
export function attachmentState(expectedVersion, status, requireHydration = false) {
  const hydrated = Number.isFinite(status?.startup?.frontendHydratedMs)
    && Number.isFinite(status?.startup?.firstFrameMs)
  return {
    ready: status?.version === expectedVersion && status?.hostRunning === true
      && status?.updaterConfigured === true && (!requireHydration || hydrated),
    retired: status?.version !== expectedVersion && status?.hostRunning === false,
  }
}
