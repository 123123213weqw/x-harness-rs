window.__ModuleLoader__.load({
	id: "@xharness/dsh-client-ui-layout",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _xharness_dsh_client_runtime_client = require("@xharness/dsh-client-runtime/client");
		/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
		* LG breakpoint); a manual toggle below it re-expands over the squeezed center
		* (stores.ts narrowExpanded). */
		const SIDEBAR_AUTO_COLLAPSE = 1024;
		/**
		* Clamp a panel width into its contract range.
		* @param px - requested width.
		* @param min - range lower bound.
		* @param max - range upper bound.
		* @returns the clamped width.
		*/
		function clampWidth(px, min, max) {
			return Math.min(max, Math.max(min, Math.round(px)));
		}
		/**
		* Solve the three column widths for one viewport frame. Pure: no hysteresis —
		* the output is a function of (viewport, preferences) only, so recovery on
		* re-widening is automatic. Preferences re-clamp here because they cross the
		* store boundary and callers may still supply stale ranges.
		* @param viewport - available frame width in px.
		* @param sidebar - sidebar width preference in px (0 = closed).
		* @param details - details width preference in px (0 = closed).
		* @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
		*/
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

function computeColumns(viewport, sidebar, details, minCenter = 640) {
			const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
			const d0 = details === 0 ? 0 : clampWidth(details, 300, 520);
			if (s + d0 + minCenter <= viewport) return {
				sidebar: s,
				center: viewport - s - d0,
				details: d0
			};
			const d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - minCenter);
			if (s + d1 + minCenter <= viewport) return {
				sidebar: s,
				center: minCenter,
				details: d1
			};
			return {
				sidebar: s,
				center: Math.max(0, viewport - s),
				details: 0
			};
		}
		//#endregion
		//#region \0dsh-css:deepseek-harness/packages/client/ui-layout/src/client/AppFrame.module.css.mjs
		const css = "._84hhiq_frame{background:var(--dsw-alias-bg-base);height:100%;transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);grid-template-rows:100%;display:grid;position:relative;overflow:hidden}._84hhiq_frame[data-dragging]{transition:none}@media (prefers-reduced-motion:reduce){._84hhiq_frame{transition:none}}._84hhiq_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}._84hhiq_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}._84hhiq_detailsCol{border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}._84hhiq_frame[data-details-collapsed] ._84hhiq_detailsCol{border-left:none}._84hhiq_handle{cursor:col-resize;z-index:2;touch-action:none;width:8px;transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out);margin-left:-4px;position:absolute;top:0;bottom:0}._84hhiq_frame[data-dragging] ._84hhiq_handle{transition:none}@media (prefers-reduced-motion:reduce){._84hhiq_handle{transition:none}}._84hhiq_handle[data-side=details]:after{content:\"\";box-sizing:border-box;background:var(--dsw-alias-button-floating-fill);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);opacity:0;width:12px;height:32px;transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out), background var(--ds-transition-duration-slow) var(--ds-ease-in-out);border-radius:10px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}._84hhiq_detailsCol:hover~._84hhiq_handle[data-side=details]:after,._84hhiq_handle[data-side=details]:hover:after,._84hhiq_handle[data-side=details][data-dragging=true]:after{opacity:1}._84hhiq_handle[data-side=details]:hover:after,._84hhiq_handle[data-side=details][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}._84hhiq_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}._84hhiq_overlayLayer>*{pointer-events:auto}._84hhiq_frame:not([data-xhworkspace-open]){transition:none}._84hhiq_handle[data-side=details]{cursor:w-resize}.xhworkspace{height:100%;min-width:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}.xhworkspace-tabs{display:flex;align-items:center;flex:none;min-height:40px;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:thin}.xhworkspace-tab{display:flex;align-items:center;flex:none;max-width:180px;min-width:90px;height:35px;border-radius:7px 7px 0 0;color:var(--dsw-alias-label-tertiary)}.xhworkspace-tab[data-active]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.xhworkspace-tab>button[role=tab]{display:flex;align-items:center;gap:6px;min-width:0;flex:1;padding:0 8px;border:0;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}.xhworkspace-kind{flex:none}.xhworkspace-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhworkspace-tab-close,.xhworkspace-new{flex:none;width:25px;height:25px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}.xhworkspace-tab-close:hover,.xhworkspace-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhworkspace-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item{flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item[hidden]{display:none}.xhworkspace-tool>div>div:first-child{display:none}._84hhiq_frame[data-xhworkspace-drawer] ._84hhiq_detailsCol{position:absolute;right:0;top:0;bottom:0;width:min(560px,calc(100% - 44px));z-index:25;box-shadow:-14px 0 40px #0004}._84hhiq_workspaceScrim{position:absolute;inset:0;z-index:24;border:0;background:#0008}";
		const tagId = "@xharness/dsh-client-ui-layout/AppFrame.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@xharness/dsh-client-ui-layout";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var AppFrame_module_css_default = {
			"centerCol": "_84hhiq_centerCol",
			"detailsCol": "_84hhiq_detailsCol",
			"frame": "_84hhiq_frame",
			"handle": "_84hhiq_handle",
			"overlayLayer": "_84hhiq_overlayLayer",
			"sidebarCol": "_84hhiq_sidebarCol",
			"workspaceScrim": "_84hhiq_workspaceScrim"
		};
		//#endregion
		//#region lib/types/client/AppFrame.js
		/**
		* Three-column shell frame, registered into the built-in 'root' slot (the web
		* shell renders only 'root'). Owns the grid tracks (sidebar | center |
		* details), the drag handles (pointer capture + rAF throttle), the concession
		* chain (columns.ts), and the child-slot render decisions: the sidebar slot
		* renders HERE with live parameters from the concession solve, and the
		* session-aware occupants render in fixed column positions; strict entries
		* gate themselves on current-session availability while session-maybe
		* entries retain identity. Pure component: everything arrives
		* through the three framework shares — zero cordis or framework imports,
		* zero self-made hooks.
		*/
		/** Center column grid item (session-body building block). */
		function CenterColumn(props) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.centerCol,
				children: props.children
			});
		}
		/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
		function DetailsColumn(props) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.detailsCol,
				children: props.children
			});
		}
		/**
		* One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
		* `side` keys the hover-reveal CSS to the owning column.
		*/
		function DragHandle(props) {
			const [dragging, setDragging] = (0, react.useState)(false);
			const origin = (0, react.useRef)(0);
			const latest = (0, react.useRef)(0);
			const frame = (0, react.useRef)(null);
			const callbacks = (0, react.useRef)({
				onStart: props.onStart,
				onDrag: props.onDrag,
				onEnd: props.onEnd
			});
			callbacks.current = {
				onStart: props.onStart,
				onDrag: props.onDrag,
				onEnd: props.onEnd
			};
			const onPointerDown = (0, react.useCallback)((e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				origin.current = e.clientX;
				latest.current = e.clientX;
				callbacks.current.onStart();
				setDragging(true);
			}, []);
			const onPointerMove = (0, react.useCallback)((e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				latest.current = e.clientX;
				frame.current ??= requestAnimationFrame(() => {
					frame.current = null;
					callbacks.current.onDrag(latest.current - origin.current);
				});
			}, []);
			const onPointerUp = (0, react.useCallback)((e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				e.currentTarget.releasePointerCapture(e.pointerId);
				if (frame.current !== null) {
					cancelAnimationFrame(frame.current);
					frame.current = null;
				}
				callbacks.current.onDrag(latest.current - origin.current);
				setDragging(false);
				callbacks.current.onEnd();
			}, []);
			return (0, react_jsx_runtime.jsx)("div", {
				className: AppFrame_module_css_default.handle,
				style: { left: props.left },
				"data-side": props.side,
				"data-dragging": dragging || void 0,
				onPointerDown,
				onPointerMove,
				onPointerUp
			});
		}
		/** The three-column frame (see module doc). */
		const xhWorkspaceWindow = xhCreateBrowserWindowController(typeof window === "undefined" ? void 0 : window.__TAURI__);
		function AppFrame({ useStore, useSessions, actions, renderSlot }) {
			const panels = useStore((s) => s);
			const detailsSession = useSessions((s) => {
				const current = s.current;
				return current !== void 0 && s.byId[current]?.blank === false ? current : void 0;
			});
			const frameRef = (0, react.useRef)(null);
			const [pluginCenterOpen, setPluginCenterOpen] = (0, react.useState)(false);
			const closePluginCenter = () => {
				setPluginCenterOpen(false);
				window.dispatchEvent(new Event("xharness:plugins:closed"));
			};
			(0, react.useEffect)(() => {
				const open = () => setPluginCenterOpen(true);
				window.addEventListener("xharness:plugins:open", open);
				return () => window.removeEventListener("xharness:plugins:open", open);
			}, []);
			const [viewport, setViewport] = (0, react.useState)(() => window.innerWidth);
			const spaceKey = useSessions(s => s.current ?? "__global__");
			const spaceKeyRef = (0, react.useRef)(spaceKey); spaceKeyRef.current = spaceKey;
			const [spaces, setSpaces] = (0, react.useState)(xhLoadBrowserSpaces);
			const [browserRestored, setBrowserRestored] = (0, react.useState)(!window.__TAURI__?.core?.invoke);
			const space = spaces[spaceKey] ?? xhWorkspaceEmpty;
			const nextWorkspaceId = (0, react.useRef)(xhNextWorkspaceId(spaces));
			(0, react.useEffect)(() => { if (browserRestored) xhSaveBrowserSpaces(spaces); nextWorkspaceId.current = Math.max(nextWorkspaceId.current, xhNextWorkspaceId(spaces)); }, [spaces, browserRestored]);
			(0, react.useEffect)(() => { if (!window.__TAURI__?.core?.invoke) return; let alive = true; window.__TAURI__.core.invoke("desktop_browser_restore").then(snapshot => { if (alive && snapshot) setSpaces(xhLoadBrowserSpaces(snapshot)); }).catch(() => {}).finally(() => { if (alive) setBrowserRestored(true); }); return () => { alive = false; }; }, []);
			const [workspaceWidth, setWorkspaceWidth] = (0, react.useState)(440);
			const updateSpace = fn => setSpaces(all => { const key = spaceKeyRef.current; return { ...all, [key]: fn(all[key] ?? xhWorkspaceEmpty) }; });
			const openWorkspace = (kind, fresh = false, detail = {}) => {
				const id = kind === "tool" ? "tool" : `${kind}:${++nextWorkspaceId.current}`;
				const source = kind === "file" ? detail.source : kind;
				const item = { id, kind, source, sessionId: detail.sessionId, title: kind === "tool" ? "工具详情" : kind === "file" ? (detail.title || source.split(/[\\/]/).pop()) : "新标签页", entries: detail.url ? [detail.url] : [], position: detail.url ? 0 : -1 };
				updateSpace(value => xhWorkspaceOpen(value, item, !fresh));
			};
			const closeWorkspace = id => { if (id === "tool") actions.closeDetails(); if (space.items.some(item => item.id === id && item.kind === "browser")) window.dispatchEvent(new CustomEvent("xharness:browser-close", { detail: { id } })); updateSpace(value => xhWorkspaceClose(value, id)); };
			(0, react.useEffect)(() => {
				const onOpen = event => { const detail = event.detail; if (detail?.kind === "browser" || detail?.kind === "tool" || (detail?.kind === "file" && typeof detail.source === "string" && detail.source.length > 0)) openWorkspace(detail.kind, detail.fresh === true, detail); };
				const onCloseTool = () => updateSpace(value => xhWorkspaceClose(value, "tool"));
				window.addEventListener("xharness:workspace-open", onOpen);
				window.addEventListener("xharness:workspace-close-tool", onCloseTool);
				return () => { window.removeEventListener("xharness:workspace-open", onOpen); window.removeEventListener("xharness:workspace-close-tool", onCloseTool); };
			}, []);
			(0, react.useEffect)(() => { setSpaces(all => { let changed = false; const next = { ...all }; for (const key of Object.keys(next)) if (key !== spaceKey && next[key].items.some(item => item.kind === "tool")) { next[key] = xhWorkspaceClose(next[key], "tool"); changed = true; } return changed ? next : all; }); }, [spaceKey]);
			(0, react.useEffect)(() => { void xhWorkspaceWindow.set(space.items.length > 0, 440); }, [space.items.length > 0]);
			(0, react.useEffect)(() => () => { void xhWorkspaceWindow.set(false); }, []);
			const lastSession = (0, react.useRef)(detailsSession);
			(0, react.useLayoutEffect)(() => {
				if (detailsSession === void 0) return;
				if (lastSession.current !== void 0 && lastSession.current !== detailsSession) actions.closeDetails();
				lastSession.current = detailsSession;
			}, [actions, detailsSession]);
			(0, react.useEffect)(() => {
				const el = frameRef.current;
				/* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
				if (el === null) return;
				let raf = null;
				const observer = new ResizeObserver(() => {
					raf ??= requestAnimationFrame(() => {
						raf = null;
						const width = el.getBoundingClientRect().width;
						if (width > 0) setViewport(width);
					});
				});
				observer.observe(el);
				return () => {
					observer.disconnect();
					if (raf !== null) cancelAnimationFrame(raf);
				};
			}, []);
			const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
			(0, react.useEffect)(() => {
				actions.setNarrow(narrow);
			}, [actions, narrow]);
			const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0;
			const sidebarWidth = sidebarCollapsed ? 56 : panels.sidebar === 0 ? 280 : clampWidth(panels.sidebar, 264, 420);
			const workspaceOpen = space.items.length > 0;
			const workspaceAvailable = viewport - sidebarWidth - 480;
			const workspaceDrawer = workspaceOpen && workspaceAvailable < 360;
			const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, workspaceAvailable) : 0;
			const cols = computeColumns(viewport - workspaceDockWidth, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, 0, workspaceDockWidth > 0 ? 480 : 640);
			const colsRef = (0, react.useRef)(cols);
			colsRef.current = cols;
			const sidebarBase = (0, react.useRef)(0);
			const detailsBase = (0, react.useRef)(0);
			const workspaceBase = (0, react.useRef)(0);
			const [dragging, setDragging] = (0, react.useState)(false);
			const onDragEnd = (0, react.useCallback)(() => {
				setDragging(false);
			}, []);
			const onSidebarStart = (0, react.useCallback)(() => {
				sidebarBase.current = colsRef.current.sidebar;
				setDragging(true);
			}, []);
			const onDetailsStart = (0, react.useCallback)(() => {
				detailsBase.current = colsRef.current.details;
				setDragging(true);
			}, []);
			const onSidebarDrag = (0, react.useCallback)((dx) => {
				actions.setSidebar(sidebarBase.current + dx);
			}, [actions]);
			const onDetailsDrag = (0, react.useCallback)((dx) => {
				actions.setDetails(detailsBase.current - dx);
			}, [actions]);
			const onWorkspaceStart = () => { workspaceBase.current = workspaceDockWidth; setDragging(true); };
			const onWorkspaceDrag = dx => { if (dx < 0) setWorkspaceWidth(Math.max(workspaceBase.current, Math.min(900, workspaceAvailable, workspaceBase.current - dx))); };
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: frameRef,
				className: AppFrame_module_css_default.frame,
				style: { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${workspaceDockWidth}px` },
				"data-xhworkspace-open": workspaceOpen || void 0,
				"data-xhworkspace-drawer": workspaceDrawer || void 0,
				"data-sidebar-collapsed": sidebarCollapsed || void 0,
				"data-details-collapsed": !workspaceOpen || void 0,
				"data-dragging": dragging || void 0,
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.sidebarCol,
						onClickCapture: (event) => {
							if (pluginCenterOpen && !event.target.closest?.("[data-xharness-plugin-nav]")) closePluginCenter();
						},
						children: renderSlot("sidebar", {
							collapsed: sidebarCollapsed,
							width: cols.sidebar
						})
					}),
					(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: pluginCenterOpen ? (0, react_jsx_runtime.jsxs)("main", {
							style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "24px clamp(20px, 5vw, 56px)" },
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: { cursor: "pointer", background: "none", border: 0, color: "var(--dsw-alias-label-secondary)", padding: "0 0 24px", font: "inherit" },
								"aria-label": "Back to chat",
								onClick: closePluginCenter,
								children: "← " + (navigator.language.startsWith("zh") ? "返回对话" : "Back to chat")
							}), renderSlot("plugins.center", {})]
						}) : renderSlot("conversation", {}) }), workspaceDrawer && (0, react_jsx_runtime.jsx)("button", { type: "button", className: AppFrame_module_css_default.workspaceScrim, "aria-label": "关闭工作区", onClick: () => closeWorkspace(space.activeId) }),
					(0, react_jsx_runtime.jsx)(DetailsColumn, { children: (0, react_jsx_runtime.jsx)(XhWorkspacePane, { space, sessionId: spaceKey === "__global__" ? null : spaceKey, renderSlot, onSelect: id => updateSpace(value => ({ ...value, activeId: id })), onClose: closeWorkspace, onUpdate: (id, patch) => updateSpace(value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) })), onNewBrowser: () => openWorkspace("browser", true) }) })] }),
					(0, react_jsx_runtime.jsx)("div", {
						className: AppFrame_module_css_default.overlayLayer,
						"data-shell-overlay": true,
						children: renderSlot("shell.overlay", {})
					}),
					!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {
						side: "sidebar",
						left: cols.sidebar,
						onStart: onSidebarStart,
						onDrag: onSidebarDrag,
						onEnd: onDragEnd
					}),
					workspaceDockWidth > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {
						side: "details",
						left: viewport - workspaceDockWidth,
						onStart: onWorkspaceStart,
						onDrag: onWorkspaceDrag,
						onEnd: onDragEnd
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/stores.js
		/**
		* The root entry's transient layout store: panel geometry as plain widths in
		* px (0 = closed). Module level exports the factory only — a module-level
		* handle would pin the store's identity in the module
		* cache (a de-facto singleton surviving plugin reloads). register() receives
		* the factory (exclusive use: the framework instantiates per entry), AppFrame
		* derives its PropsStore share from the return type, and the service face
		* receives the bound actions through the registration's inject hook.
		*/
		/**
		* Create the layout panel store handle. The preference IS the width, so
		* closing a panel forgets its drag width — reopening restores the contract
		* default. Actions are the complete write set: drag writes clamp
		* into the panel's contract range and never cross the open/closed line;
		* open/close transitions write 0 / the default explicitly. Below the
		* auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
		* flips the narrowExpanded override instead of the preference.
		* @returns the store handle (spec + type + identity + factory in one).
		*/
		function createLayoutStore() {
			return (0, _xharness_dsh_client_runtime_client.defineStore)({
				init: () => ({
					sidebar: 280,
					details: 0,
					narrow: false,
					narrowExpanded: false
				}),
				actions: {
					setSidebar: (d, px) => {
						d.sidebar = clampWidth(px, 264, 420);
					},
					setDetails: (d, px) => {
						d.details = clampWidth(px, 300, 520);
					},
					toggleSidebar: (d) => {
						if (d.narrow) d.narrowExpanded = !d.narrowExpanded;
						else d.sidebar = d.sidebar === 0 ? 280 : 0;
					},
					setNarrow: (d, narrow) => {
						if (d.narrow === narrow) return;
						d.narrow = narrow;
						d.narrowExpanded = false;
					},
					openDetails: (d) => {
						if (d.details === 0) d.details = 360;
					},
					closeDetails: (d) => {
						d.details = 0;
					}
				}
			});
		}
		//#endregion
		//#region lib/types/client/service.js
		/** Cross-plugin panel-action face (ctx.layout). */
		var LayoutController = class {
			#panels;
			/**
			* Adopt the root entry's bound store actions. Called from the root
			* registration's inject hook (a sanctioned assembly side effect), so the
			* face is live from the entry's first render; on entry re-register the
			* fresh actions overwrite the stale set.
			* @param actions - bound actions of the entry's layout store instance.
			*/
			attachPanels(actions) {
				this.#panels = actions;
			}
			/** Toggle the sidebar panel (closed ⟷ contract default width). */
			toggleSidebar() {
				this.#require().toggleSidebar();
			}
			/** Open the details panel (no-op when already open). */
			openDetails() {
				this.#require().openDetails();
				window.dispatchEvent(new CustomEvent("xharness:workspace-open", { detail: { kind: "tool" } }));
			}
			/** Close the details panel. */
			closeDetails() {
				this.#require().closeDetails();
				window.dispatchEvent(new Event("xharness:workspace-close-tool"));
			}
			#require() {
				if (this.#panels === void 0) throw new Error("layout: panel actions not wired (root entry not mounted)");
				return this.#panels;
			}
		};
		//#endregion
		//#region lib/types/client/theme-presenter.js
		/** Body attribute selecting the dark base palette in the token stylesheets. */
		const DARK_ATTRIBUTE = "data-ds-dark-theme";
		/** Applies theme snapshots to the document; one instance per plugin fiber. */
		var ThemePresenter = class {
			/** Token names this presenter wrote in the last apply (its retraction set). */
			appliedTokens = [];
			/** The single metadata node this presenter inserts and removes. */
			themeColorMeta;
			/** Create the presenter-owned metadata node before the first snapshot arrives. */
			constructor() {
				this.themeColorMeta = document.createElement("meta");
				this.themeColorMeta.name = "theme-color";
			}
			/**
			* Project a snapshot onto the document: set root `color-scheme` and the body
			* palette attribute from `active.colorScheme` (never the id — `system` is
			* resolved upstream), then replace the previously applied token variables
			* with `active.tokens`. Browser theme-color metadata follows the computed
			* body background after those writes, so the rendered palette remains the
			* color authority.
			* @param snapshot - resolved theme snapshot from ctx.theme.
			*/
			apply(snapshot) {
				const scheme = snapshot.active.colorScheme;
				document.documentElement.style.colorScheme = scheme;
				const body = document.body;
				if (scheme === "dark") body.setAttribute(DARK_ATTRIBUTE, "");
				else body.removeAttribute(DARK_ATTRIBUTE);
				for (const name of this.appliedTokens) body.style.removeProperty(name);
				this.appliedTokens = [];
				for (const [name, value] of Object.entries(snapshot.active.tokens)) {
					body.style.setProperty(name, value);
					this.appliedTokens.push(name);
				}
				this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
				if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
			}
			/** Retract root color-scheme, the palette attribute, token variables, and the owned metadata node. */
			dispose() {
				document.documentElement.style.removeProperty("color-scheme");
				const body = document.body;
				body.removeAttribute(DARK_ATTRIBUTE);
				for (const name of this.appliedTokens) body.style.removeProperty(name);
				this.appliedTokens = [];
				this.themeColorMeta.remove();
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
		const inject = ["slots", "theme"];
		/**
		* Client plugin body: provide ctx.layout, then one register() call — AppFrame
		* into 'root' with the four child-slot declarations, the layout store seat,
		* and the inject hook that hands the store's bound actions to the service.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const layout = new LayoutController();
			ctx.effect(() => {
				const disposeService = ctx.reflect.provide("layout", layout);
				const disposeRegistration = ctx.slots.register({
					name: "root",
					children: {
						"sidebar": {
							kind: "single",
							scope: "root"
						},
						"conversation": {
							kind: "single",
							scope: "session-maybe"
						},
						"plugins.center": {
							kind: "single",
							scope: "root"
						},
						"details": {
							kind: "single",
							scope: "session"
						},
						"shell.overlay": {
							kind: "list",
							scope: "root"
						},
						"workspace.item": { kind: "list", scope: "root" }
					},
					store: createLayoutStore,
					inject: (actions) => {
						layout.attachPanels(actions);
						return {};
					}
				}, AppFrame);
				return () => {
					disposeRegistration();
					disposeService();
				};
			}, "ui-layout: service + root registration");
			ctx.effect(() => {
				const presenter = new ThemePresenter();
				presenter.apply(ctx.theme.getTheme());
				const off = ctx.on("theme/change", (snapshot) => {
					presenter.apply(snapshot);
				});
				return () => {
					off();
					presenter.dispose();
				};
			}, "ui-layout: theme presenter");
		}
		//#endregion
		exports.LayoutController = LayoutController;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
