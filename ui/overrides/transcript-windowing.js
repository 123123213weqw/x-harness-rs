// Product-owned transcript DOM windowing. No history/model data is removed.
// Initial mounting measures exact heights; eviction only starts after measurement.
// Interacted rows remain mounted until the conversation unmounts: upstream tool
// plugins own local state, so evicting them would silently lose drafts/expansion.
function createTranscriptWindowing(React) {
  const roots = new WeakMap();
  function controller(root) {
    let existing = roots.get(root);
    if (existing) return existing;
    const rows = new Map();
    let frame = 0, width = root.clientWidth, height = root.clientHeight;
    let intersection;
    const measure = new ResizeObserver(entries => {
      for (const entry of entries) {
        const row = rows.get(entry.target);
        if (!row || !row.mounted) continue;
        const rect = entry.target.getBoundingClientRect(), h = rect.height;
        if (h > 0) {
          // A re-mounted image/code row above the viewport may acquire a new
          // height. Compensate only when native anchoring is explicitly disabled;
          // otherwise doing both would double-adjust the reader's position.
          if (getComputedStyle(root).overflowAnchor === 'none' && row.height > 0
              && rect.top + row.height <= root.getBoundingClientRect().top
              && Math.abs(h - row.height) > 0.5) root.scrollTop += h - row.height;
          row.height = h;
        }
      }
    });
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const row of rows.values()) {
          const show = row.near || row.pinned || row.keep || !row.height;
          if (show !== row.mounted) {
            row.mounted = show;
            row.update({ mounted: show, height: row.height });
          }
        }
      });
    }
    function observe() {
      intersection?.disconnect();
      intersection = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const row = rows.get(entry.target);
          if (row) row.near = entry.isIntersecting;
        }
        schedule();
      }, { root, rootMargin: `${Math.max(1, root.clientHeight)}px 0px` });
      for (const element of rows.keys()) intersection.observe(element);
    }
    // A width change invalidates offscreen measurements. Remount before measuring
    // rather than applying stale heights (code wrapping and images are non-linear).
    const rootObserver = new ResizeObserver(() => {
      const nextWidth = root.clientWidth, nextHeight = root.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      const resized = nextWidth !== width;
      width = nextWidth; height = nextHeight;
      if (resized) {
        for (const row of rows.values()) {
          row.height = 0;
          row.near = true;
          row.mounted = true;
          row.update({ mounted: true, height: 0 });
        }
      }
      observe();
    });
    rootObserver.observe(root);
    observe();
    existing = {
      add(element, update, keep, pinned) {
        const row = { update, keep, pinned, near: true, mounted: true,
          height: element.getBoundingClientRect().height };
        rows.set(element, row);
        measure.observe(element);
        intersection.observe(element);
        return {
          keep(value) { row.keep = value; schedule(); },
          pin() { row.pinned = true; schedule(); },
          remove() {
            rows.delete(element); measure.unobserve(element); intersection.unobserve(element);
            if (!rows.size) {
              if (frame) cancelAnimationFrame(frame);
              rootObserver.disconnect(); intersection.disconnect(); measure.disconnect();
              roots.delete(root);
            }
          }
        };
      }
    };
    roots.set(root, existing);
    return existing;
  }
  return function TranscriptWindowRow({ children, keepMounted = false, ...attributes }) {
    const element = React.useRef(null), binding = React.useRef(null), pinned = React.useRef(false);
    const [view, setView] = React.useState({ mounted: true, height: 0 });
    React.useLayoutEffect(() => {
      const node = element.current;
      const root = node?.closest('[data-conversation-scroll]');
      // Unsupported runtimes/scrollers retain the original fully rendered path.
      if (!root || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
      const handle = controller(root).add(node, setView, keepMounted, pinned.current);
      binding.current = handle;
      return () => { handle.remove(); binding.current = null; };
    }, []);
    React.useLayoutEffect(() => { binding.current?.keep(keepMounted); }, [keepMounted]);
    const pin = () => { pinned.current = true; binding.current?.pin(); };
    return React.createElement('div', {
      ...attributes, ref: element,
      'data-transcript-mounted': view.mounted ? 'true' : 'false',
      onPointerDownCapture: pin, onKeyDownCapture: pin, onFocusCapture: pin,
      style: view.mounted ? attributes.style : { ...attributes.style, display: 'block', height: view.height, boxSizing: 'border-box' }
    }, view.mounted ? children : null);
  };
}
