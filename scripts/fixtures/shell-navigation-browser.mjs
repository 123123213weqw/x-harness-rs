/** Observable session-selection port for isolated AppFrame fixtures.
 * The real layout owns ShellNavigation; this port models synchronous selection,
 * rather than stubbing navigation or forgetting the registration's inject face. */
export async function installShellSessionsFixture(page) {
  await page.evaluate(() => {
    window.createShellSessionsFixture = (initial = {}) => {
      let value = { current: undefined, ids: [], byId: {}, phase: 'ready', ...initial }
      const listeners = new Set()
      const update = next => { value = { ...value, ...next }; for (const listener of [...listeners]) listener() }
      return {
        list: { getSnapshot: () => value, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
        open: id => { if (!value.ids.includes(id)) throw Error('fixture session absent: ' + id); update({ current: id }) },
        clear: () => update({ current: undefined }), subagentAddress: () => undefined,
        update,
      }
    }
  })
}
