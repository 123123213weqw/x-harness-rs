// Pending tool presentation (including Computer privacy effects) stays alive
// through settlement. Completed tool history is still disposable.
function xhTranscriptHasPendingTool(node) {
  if (node?.kind !== 'tool-call' || !node.data?.root) return false;
  const stack = [node.data.root];
  while (stack.length) {
    const block = stack.pop();
    if (!block || typeof block !== 'object') continue;
    if (!('kind' in block)) return true;
    for (const child of Array.isArray(block.subCalls) ? block.subCalls : []) stack.push(child);
  }
  return false;
}
// Product-owned bounded transcript DOM. Unmeasured rows are lightweight seats,
// not fully mounted messages. Heights are corrected only near the viewport.
function createTranscriptWindowing(React) {
  // UI state belongs to the stable row seat, not the disposable heavy subtree.
  // Shared React identity lets independently registered tools use the same hook.
  const registry = globalThis.__xhTranscriptState ??= new WeakMap();
  let state = registry.get(React.createElement);
  if (!state) {
    state = (() => {
      const Context = React.createContext(null);
      return { Context, useState(key, initial) {
        const store = React.useContext(Context);
        const [value, publish] = React.useState(() => {
          if (store?.has(key)) return store.get(key);
          const first = typeof initial === 'function' ? initial() : initial;
          store?.set(key, first);
          return first;
        });
        const current = React.useRef(value);
        const set = React.useCallback(next => {
          const result = typeof next === 'function' ? next(current.current) : next;
          current.current = result;
          store?.set(key, result);
          publish(result);
        }, [store, key]);
        return [value, set];
      }};
    })();
    registry.set(React.createElement, state);
  }
  const roots = new WeakMap();
  function controller(root) {
    let existing = roots.get(root);
    if (existing) return existing;
    const rows = new Map();
    let frame = 0, width = root.clientWidth, height = root.clientHeight;
    let intersection, anchor = null, following = false;
    const viewportTop = () => root.getBoundingClientRect().top;
    function remember() {
      following = root.scrollHeight - root.scrollTop - root.clientHeight <= 25;
      const top = viewportTop();
      anchor = null;
      for (const row of rows.values()) {
        if (!row.near && !row.mounted) continue;
        const rect = row.element.getBoundingClientRect();
        if (rect.bottom > top && rect.top < top + root.clientHeight) {
          if (!anchor || rect.top < anchor.top + top)
            anchor = { element: row.element, top: rect.top - top };
        }
      }
    }
    function compensate() {
      // Honor native anchoring when enabled; don't compensate twice.
      if (getComputedStyle(root).overflowAnchor === 'none') {
        if (following) root.scrollTop = root.scrollHeight;
        else if (anchor?.element.isConnected && rows.has(anchor.element))
          root.scrollTop += anchor.element.getBoundingClientRect().top - viewportTop() - anchor.top;
      }
      remember();
    }
    const measure = new ResizeObserver(entries => {
      for (const entry of entries) {
        const row = rows.get(entry.target);
        if (!row?.mounted) continue;
        const h = entry.target.getBoundingClientRect().height;
        if (Number.isFinite(h) && h >= 0) row.height = h;
      }
      compensate();
    });
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const row of rows.values()) {
          const show = row.near || row.focused || row.selected || row.keep;
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
        if (!anchor) remember();
        schedule();
      }, { root, rootMargin: `${Math.max(1, root.clientHeight)}px 0px` });
      for (const element of rows.keys()) intersection.observe(element);
    }
    const rootObserver = new ResizeObserver(() => {
      const nextWidth = root.clientWidth, nextHeight = root.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth; height = nextHeight;
      // Offscreen heights remain estimates at the new width. Only visible rows
      // are remeasured; never remount an entire conversation to refresh a cache.
      observe();
      compensate();
    });
    rootObserver.observe(root);
    observe();
    function selectionChanged() {
      const selection = document.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      for (const row of rows.values()) {
        // Protect already rendered selected text, never materialize hidden history
        // merely because Select All intersects lightweight placeholder seats.
        row.selected = !!(range && row.mounted && range.intersectsNode(row.element));
      }
      schedule();
    }
    root.addEventListener('scroll', remember, { passive: true });
    document.addEventListener('selectionchange', selectionChanged);
    existing = {
      add(element, update, keep, estimate) {
        const row = { element, update, keep, focused: false, selected: false, near: false,
          mounted: keep, height: estimate };
        rows.set(element, row);
        measure.observe(element);
        intersection.observe(element);
        if (rows.size === 1) remember();
        return {
          keep(value) { row.keep = value; schedule(); },
          focus(value) { row.focused = value; schedule(); },
          remove() {
            rows.delete(element); measure.unobserve(element); intersection.unobserve(element);
            if (!rows.size) {
              if (frame) cancelAnimationFrame(frame);
              root.removeEventListener('scroll', remember);
              document.removeEventListener('selectionchange', selectionChanged);
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
  return function TranscriptWindowRow({ children, keepMounted = false, estimatedHeight = 240, ...attributes }) {
    const element = React.useRef(null), binding = React.useRef(null);
    const values = React.useRef(null), details = React.useRef(null);
    values.current ??= new Map();
    details.current ??= new Map();
    const estimate = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 240;
    const [view, setView] = React.useState({ mounted: keepMounted, height: estimate });
    React.useLayoutEffect(() => {
      const node = element.current;
      const root = node?.closest('[data-conversation-scroll]');
      // Compatibility fallback is explicit; modern WebKit uses bounded mounting.
      if (!root || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
        setView(value => ({ ...value, mounted: true }));
        return;
      }
      const handle = controller(root).add(node, setView, keepMounted, estimate);
      binding.current = handle;
      return () => { handle.remove(); binding.current = null; };
    }, []);
    React.useLayoutEffect(() => { binding.current?.keep(keepMounted); }, [keepMounted]);
    React.useLayoutEffect(() => {
      if (!view.mounted) return;
      element.current.querySelectorAll('details').forEach((node, index) => {
        const key = detailKey(node, index);
        if (details.current.has(key)) node.open = details.current.get(key);
      });
    }, [view.mounted]);
    const focusedInput = () => {
      const active = document.activeElement;
      return !!(active && element.current?.contains(active) && active.matches('input,textarea,select,[contenteditable="true"]'));
    };
    const onFocus = () => binding.current?.focus(focusedInput());
    const onBlur = () => queueMicrotask(() => binding.current?.focus(focusedInput()));
    function detailKey(node, index) {
      return node.getAttribute('data-transcript-state-key') || node.id ||
        `${index}:${node.querySelector('summary')?.textContent?.slice(0, 120) ?? ''}`;
    }
    const onToggle = event => {
      const nodes = [...element.current.querySelectorAll('details')];
      const index = nodes.indexOf(event.target);
      if (index >= 0) details.current.set(detailKey(event.target, index), event.target.open);
    };
    return React.createElement('div', {
      ...attributes, ref: element,
      'data-transcript-mounted': view.mounted ? 'true' : 'false',
      onFocusCapture: event => { attributes.onFocusCapture?.(event); onFocus(); },
      onBlurCapture: event => { attributes.onBlurCapture?.(event); onBlur(); },
      onToggleCapture: event => { attributes.onToggleCapture?.(event); onToggle(event); },
      style: view.mounted ? attributes.style : { ...attributes.style, display: 'block', height: view.height, boxSizing: 'border-box' }
    }, view.mounted ? React.createElement(state.Context.Provider, { value: values.current }, children) : null);
  };
}
