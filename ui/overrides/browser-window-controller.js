// xh-browser-window-controller/v1
// Prefer a full rightward native expansion when the monitor has room. If it
// does not, AppFrame borrows the same width from the conversation on the left.
// Never partially grow the native window: a partial lease makes the layout
// jump between two directions and is hard to restore safely.
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
    const logicalWidth = size.width / scale;
    const logicalHeight = size.height / scale;
    const unchanged = lease !== null && Math.abs(logicalWidth - lease.baseWidth - lease.addedWidth) <= 8;
    if (!unchanged) lease = null; // A manual resize belongs to the user.
    if (!open) {
      if (lease !== null) await nativeWindow.setSize(new LogicalSize(lease.baseWidth, logicalHeight));
      lease = null;
      return 0;
    }
    if (await nativeWindow.isMaximized() || await nativeWindow.isFullscreen()) {
      // The OS owns maximized/fullscreen geometry. Retain a valid lease so a
      // later close can undo our earlier growth if the window is restored.
      return lease?.addedWidth ?? 0;
    }
    const monitor = await api.currentMonitor();
    if (!monitor?.workArea?.position || !monitor?.workArea?.size) return lease?.addedWidth ?? 0;
    const position = await nativeWindow.outerPosition();
    const outer = await nativeWindow.outerSize();
    const wanted = Math.max(360, Math.min(900, Math.round(preferredWidth)));
    const rightEdge = monitor.workArea.position.x + monitor.workArea.size.width;
    const spare = Math.max(0, (rightEdge - position.x - outer.width) / scale - 8);
    const priorAdded = lease?.addedWidth ?? 0;
    if (spare + priorAdded < wanted) {
      if (lease !== null) await nativeWindow.setSize(new LogicalSize(lease.baseWidth, logicalHeight));
      lease = null;
      return 0;
    }
    const baseWidth = lease?.baseWidth ?? logicalWidth;
    if (Math.abs(wanted - priorAdded) > 1) await nativeWindow.setSize(new LogicalSize(baseWidth + wanted, logicalHeight));
    lease = { baseWidth, addedWidth: wanted };
    return wanted;
  };
  return {
    set(open, preferredWidth = 440) {
      // React can request open, drag, and close on successive render cycles.
      queue = queue.catch(() => 0).then(() => resize(open, preferredWidth));
      return queue.catch(() => 0);
    },
  };
}
