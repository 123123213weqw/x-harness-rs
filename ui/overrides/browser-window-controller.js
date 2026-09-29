// xh-browser-window-controller/v1
// Keep native window sizing separate from React/layout. No bridge in an
// ordinary web tab: it returns 0 and AppFrame uses the non-resizing drawer.
function xhCreateBrowserWindowController(tauri) {
  const api = tauri?.window;
  const LogicalSize = api?.LogicalSize ?? tauri?.dpi?.LogicalSize;
  let lease = null;
  let queue = Promise.resolve(0);
  const resize = async (open, preferredWidth) => {
    if (typeof api?.getCurrentWindow !== 'function' || typeof api?.currentMonitor !== 'function' || typeof LogicalSize !== 'function') return 0;
    const nativeWindow = api.getCurrentWindow();
    if (!nativeWindow || typeof nativeWindow.setSize !== 'function') return 0;
    const size = await nativeWindow.innerSize();
    const scale = await nativeWindow.scaleFactor();
    if (!Number.isFinite(scale) || scale <= 0) return 0;
    if (!open) {
      if (lease !== null) {
        const expected = Math.round((lease.baseWidth + lease.addedWidth) * scale);
        const unchanged = Math.abs(size.width - expected) <= Math.max(8, Math.ceil(8 * scale));
        if (unchanged) await nativeWindow.setSize(new LogicalSize(lease.baseWidth, size.height / scale));
        lease = null;
      }
      return 0;
    }
    if (await nativeWindow.isMaximized() || await nativeWindow.isFullscreen()) { lease = null; return 0; }
    const monitor = await api.currentMonitor();
    if (!monitor?.workArea?.position || !monitor?.workArea?.size) return 0;
    const position = await nativeWindow.outerPosition();
    const outer = await nativeWindow.outerSize();
    const expected = lease === null ? 0 : Math.round((lease.baseWidth + lease.addedWidth) * scale);
    if (lease !== null && Math.abs(size.width - expected) > Math.max(8, Math.ceil(8 * scale))) lease = null;
    const baseWidth = lease?.baseWidth ?? size.width / scale;
    const priorAdded = lease?.addedWidth ?? 0;
    const rightEdge = monitor.workArea.position.x + monitor.workArea.size.width;
    const available = Math.max(0, (rightEdge - position.x - outer.width) / scale - 8);
    const maxAdded = priorAdded + available;
    const wanted = Math.max(360, Math.min(900, Math.round(preferredWidth)));
    const granted = Math.min(wanted, maxAdded);
    if (granted < 360) return 0;
    if (Math.abs(granted - priorAdded) > 1) {
      await nativeWindow.setSize(new LogicalSize(baseWidth + granted, size.height / scale));
    }
    lease = { baseWidth, addedWidth: granted };
    return granted;
  };
  return {
    set(open, preferredWidth = 440) {
      // Open, resize, and close can be triggered by separate render cycles.
      // Serialize them so a late resize cannot undo a later close.
      queue = queue.catch(() => 0).then(() => resize(open, preferredWidth));
      return queue.catch(() => 0);
    },
  };
}
