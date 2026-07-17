// xharness-workspace-pane/v1
// This is injected into the upstream layout module at build time. The pane
// owns tabs and placement; each item type owns only its content renderer.
const xhWorkspaceEmpty = { items: [], activeId: null };
const xhWorkspaceStorageKey = 'xharness:browser-spaces-v1';
let xhBrowserPersistQueue = Promise.resolve();
let xhLastBrowserSnapshot = null;

function xhLoadBrowserSpaces(snapshot) {
  try {
    const stored = JSON.parse(snapshot ?? localStorage.getItem(xhWorkspaceStorageKey) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const result = {};
    for (const [key, space] of Object.entries(stored).slice(-50)) {
      if (typeof key !== 'string' || !Array.isArray(space?.items)) continue;
      const items = space.items.filter(item => item?.kind === 'browser' && typeof item.id === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(item.id))
        .slice(-128).map(item => {
          const valid = (Array.isArray(item.entries) ? item.entries : []).filter(url => {
            try { const parsed = new URL(url); return url.length <= 4096 && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
          });
          return {
            id: item.id, kind: 'browser', source: 'browser',
            title: typeof item.title === 'string' ? item.title.slice(0, 160) : '新标签页',
            entries: valid.slice(-50),
            position: Number.isInteger(item.position) ? item.position - Math.max(0, valid.length - 50) : -1,
          };
        });
      for (const item of items) item.position = Math.max(-1, Math.min(item.position, item.entries.length - 1));
      if (items.length) result[key] = { items, activeId: items.some(item => item.id === space.activeId) ? space.activeId : items[0].id };
    }
    return result;
  } catch { return {}; }
}

function xhSaveBrowserSpaces(spaces) {
  const stored = {};
  for (const [key, space] of Object.entries(spaces).slice(-50)) {
    const items = space.items.filter(item => item.kind === 'browser');
    if (items.length) stored[key] = { items, activeId: space.activeId };
  }
  const snapshot = JSON.stringify(xhLoadBrowserSpaces(JSON.stringify(stored)));
  try { localStorage.setItem(xhWorkspaceStorageKey, snapshot); } catch { /* Origin storage can be blocked. */ }
  if (window.__TAURI__?.core?.invoke && snapshot !== xhLastBrowserSnapshot) {
    xhLastBrowserSnapshot = snapshot;
    xhBrowserPersistQueue = xhBrowserPersistQueue.catch(() => {}).then(() =>
      window.__TAURI__.core.invoke('desktop_browser_persist', { snapshot })).catch(() => {
      xhLastBrowserSnapshot = null;
    });
  }
}

function xhNextWorkspaceId(spaces) {
  return Math.max(0, ...Object.values(spaces).flatMap(space => space.items.map(item => Number(item.id.match(/^browser:(\d+)$/)?.[1]) || 0)));
}

function xhWorkspaceOpen(space, item, reuse = true) {
  const existing = reuse && space.items.find(value => value.kind === item.kind && value.source === item.source);
  if (existing) return { ...space, activeId: existing.id };
  return { items: [...space.items, item], activeId: item.id };
}

function xhWorkspaceClose(space, id) {
  const index = space.items.findIndex(item => item.id === id);
  if (index < 0) return space;
  const items = space.items.filter(item => item.id !== id);
  return { items, activeId: space.activeId === id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : space.activeId };
}

function XhWorkspacePane({ space, sessionId, renderSlot, onSelect, onClose, onUpdate, onNewBrowser }) {
  const h = react.createElement;
  const active = space.items.find(item => item.id === space.activeId);
  const closeItem = item => onClose(item.id);
  return h('section', { className: 'xhworkspace', 'aria-label': '工作区' },
    h('div', { className: 'xhworkspace-tabs', role: 'tablist', 'aria-label': '工作区标签' },
      space.items.map(item => h('div', { className: 'xhworkspace-tab', key: item.id, 'data-active': item.id === space.activeId || undefined },
        h('button', { type: 'button', role: 'tab', 'aria-selected': item.id === space.activeId,
          onClick: () => onSelect(item.id), title: item.title },
          h('span', { className: 'xhworkspace-kind', 'aria-hidden': true }, item.kind === 'browser' ? '◎' : item.kind === 'tool' ? '⌘' : '▤'),
          h('span', { className: 'xhworkspace-title' }, item.title)),
        h('button', { type: 'button', className: 'xhworkspace-tab-close', 'aria-label': `关闭 ${item.title}`,
          onClick: () => closeItem(item), title: '关闭标签' }, '×'))),
      h('button', { type: 'button', className: 'xhworkspace-new', 'aria-label': '新建浏览器标签',
        onClick: onNewBrowser, title: '新建浏览器标签' }, '+')),
    h('div', { className: 'xhworkspace-body' },
      active && h('div', { key: active.id, className: `xhworkspace-item xhworkspace-${active.kind}`,
        role: 'tabpanel' },
        active.kind === 'tool' ? renderSlot('details', {}) : renderSlot('workspace.item', {
          item: active, sessionId, open: true, onUpdate: patch => onUpdate(active.id, patch),
          onClose: () => onClose(active.id), onNewBrowser,
        }))));
}
