// Generated from src/modules/layout/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-layout",
factory: (__externalRequire) => {
const __units = {
"src/modules/layout/index.js": function(module, exports, require) {
// source: src/modules/layout/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.LayoutController = void 0;
exports.apply = apply;
const AppFrame_1 = require("./AppFrame");
const stores_1 = require("./stores");
const service_1 = require("./service");
const theme_presenter_1 = require("./theme-presenter");
// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
var service_2 = require("./service");
Object.defineProperty(exports, "LayoutController", { enumerable: true, get: function () { return service_2.LayoutController; } });
/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
exports.inject = ['slots', 'theme'];
/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const layout = new service_1.LayoutController();
    ctx.effect(() => {
        const disposeService = ctx.reflect.provide('layout', layout);
        const disposeRegistration = ctx.slots.register({
            name: 'root',
            children: {
                'sidebar': { kind: 'single', scope: 'root' },
                'conversation': { kind: 'single', scope: 'session-maybe' },
                'plugins.center': { kind: 'single', scope: 'root' },
                'details': { kind: 'single', scope: 'session' },
                'shell.overlay': { kind: 'list', scope: 'root' },
                'workspace.item': { kind: 'list', scope: 'root' },
            },
            // Exclusive store: the factory itself — the framework instantiates per
            // entry and delivers useStore/actions to AppFrame as standard props.
            store: stores_1.createLayoutStore,
            // The hook's only side effect connects the root store to ctx.layout;
            // conversation business actions belong to their registrants.
            inject: (actions) => {
                layout.attachPanels(actions);
                return {};
            },
        }, AppFrame_1.AppFrame);
        return () => {
            disposeRegistration();
            // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
            void disposeService();
        };
    }, 'ui-layout: service + root registration');
    // Theme presentation: pure DOM writes from resolved snapshots — initial
    // state through the getter once, then event-driven only; no React path.
    ctx.effect(() => {
        const presenter = new theme_presenter_1.ThemePresenter();
        presenter.apply(ctx.theme.getTheme());
        const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot); });
        return () => {
            off();
            presenter.dispose();
        };
    }, 'ui-layout: theme presenter');
}

},
"src/modules/layout/AppFrame.js": function(module, exports, require) {
// source: src/modules/layout/AppFrame.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppFrame = AppFrame;
const jsx_runtime_1 = require("react/jsx-runtime");
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
const react_1 = require("react");
const columns_1 = require("./columns");
const AppFrame_styles_1 = __importDefault(require("./AppFrame.styles"));
const browser_window_controller_1 = require("./browser-window-controller");
const workspace_pane_1 = require("./workspace-pane");
const xhWorkspaceWindow = (0, browser_window_controller_1.xhCreateBrowserWindowController)(typeof window === 'undefined' ? undefined : window.__TAURI__);
/** Center column grid item (session-body building block). */
function CenterColumn(props) {
    return (0, jsx_runtime_1.jsx)("div", { className: AppFrame_styles_1.default.centerCol, children: props.children });
}
/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props) {
    return (0, jsx_runtime_1.jsx)("div", { className: AppFrame_styles_1.default.detailsCol, children: props.children });
}
/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props) {
    const [dragging, setDragging] = (0, react_1.useState)(false);
    const origin = (0, react_1.useRef)(0);
    const latest = (0, react_1.useRef)(0);
    const frame = (0, react_1.useRef)(null);
    const callbacks = (0, react_1.useRef)({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd });
    callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd };
    const onPointerDown = (0, react_1.useCallback)((e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        origin.current = e.clientX;
        latest.current = e.clientX;
        callbacks.current.onStart();
        setDragging(true);
    }, []);
    const onPointerMove = (0, react_1.useCallback)((e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId))
            return;
        latest.current = e.clientX;
        frame.current ?? (frame.current = requestAnimationFrame(() => {
            frame.current = null;
            callbacks.current.onDrag(latest.current - origin.current);
        }));
    }, []);
    const onPointerUp = (0, react_1.useCallback)((e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId))
            return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
            frame.current = null;
        }
        callbacks.current.onDrag(latest.current - origin.current);
        setDragging(false);
        callbacks.current.onEnd();
    }, []);
    return ((0, jsx_runtime_1.jsx)("div", { className: AppFrame_styles_1.default.handle, style: { left: props.left }, "data-side": props.side, "data-dragging": dragging || undefined, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp }));
}
/** The three-column frame (see module doc). */
function AppFrame({ useStore, useSessions, actions, renderSlot, }) {
    const panels = useStore(s => s);
    const detailsSession = useSessions((s) => {
        const current = s.current;
        return current !== undefined && s.byId[current]?.blank === false ? current : undefined;
    });
    const frameRef = (0, react_1.useRef)(null);
    const [pluginCenterOpen, setPluginCenterOpen] = (0, react_1.useState)(false);
    const closePluginCenter = () => {
        setPluginCenterOpen(false);
        window.dispatchEvent(new Event('xharness:plugins:closed'));
    };
    (0, react_1.useEffect)(() => {
        const open = () => { setPluginCenterOpen(true); };
        window.addEventListener('xharness:plugins:open', open);
        return () => { window.removeEventListener('xharness:plugins:open', open); };
    }, []);
    const [viewport, setViewport] = (0, react_1.useState)(() => window.innerWidth);
    const spaceKey = useSessions(state => state.current ?? '__global__');
    const spaceKeyRef = (0, react_1.useRef)(spaceKey);
    spaceKeyRef.current = spaceKey;
    const [spaces, setSpaces] = (0, react_1.useState)(workspace_pane_1.xhLoadBrowserSpaces);
    const [browserRestored, setBrowserRestored] = (0, react_1.useState)(!window.__TAURI__?.core?.invoke);
    const space = spaces[spaceKey] ?? workspace_pane_1.xhWorkspaceEmpty;
    const nextWorkspaceId = (0, react_1.useRef)((0, workspace_pane_1.xhNextWorkspaceId)(spaces));
    (0, react_1.useEffect)(() => {
        if (browserRestored)
            (0, workspace_pane_1.xhSaveBrowserSpaces)(spaces);
        nextWorkspaceId.current = Math.max(nextWorkspaceId.current, (0, workspace_pane_1.xhNextWorkspaceId)(spaces));
    }, [spaces, browserRestored]);
    (0, react_1.useEffect)(() => {
        const native = window.__TAURI__;
        if (!native?.core?.invoke)
            return;
        let alive = true;
        native.core.invoke('desktop_browser_restore').then(snapshot => {
            if (alive && typeof snapshot === 'string' && snapshot)
                setSpaces((0, workspace_pane_1.xhLoadBrowserSpaces)(snapshot));
        }).catch(() => { }).finally(() => { if (alive)
            setBrowserRestored(true); });
        return () => { alive = false; };
    }, []);
    const [workspaceWidth, setWorkspaceWidth] = (0, react_1.useState)(440);
    const updateSpace = (fn) => setSpaces(all => {
        const key = spaceKeyRef.current;
        return { ...all, [key]: fn(all[key] ?? workspace_pane_1.xhWorkspaceEmpty) };
    });
    const openWorkspace = (kind, fresh = false, detail = {}) => {
        const id = kind === 'tool' ? 'tool' : `${kind}:${++nextWorkspaceId.current}`;
        const source = kind === 'file' ? detail.source : kind;
        if (source === undefined)
            return;
        const item = { id, kind, source, sessionId: detail.sessionId, title: kind === 'tool' ? '工具详情' : kind === 'file' ? (detail.title || source.split(/[\\/]/).at(-1) || '') : '新标签页', entries: detail.url ? [detail.url] : [], position: detail.url ? 0 : -1 };
        updateSpace(value => (0, workspace_pane_1.xhWorkspaceOpen)(value, item, !fresh));
    };
    const closeWorkspace = (id) => {
        if (id === 'tool')
            actions.closeDetails();
        if (space.items.some(item => item.id === id && item.kind === 'browser'))
            window.dispatchEvent(new CustomEvent('xharness:browser-close', { detail: { id } }));
        updateSpace(value => (0, workspace_pane_1.xhWorkspaceClose)(value, id));
    };
    (0, react_1.useEffect)(() => {
        const onOpen = (event) => {
            const value = event instanceof CustomEvent ? event.detail : undefined;
            const detail = (0, workspace_pane_1.workspaceOpenDetail)(value);
            if (detail)
                openWorkspace(detail.kind, detail.fresh === true, detail);
        };
        const onCloseTool = () => updateSpace(value => (0, workspace_pane_1.xhWorkspaceClose)(value, 'tool'));
        window.addEventListener('xharness:workspace-open', onOpen);
        window.addEventListener('xharness:workspace-close-tool', onCloseTool);
        return () => { window.removeEventListener('xharness:workspace-open', onOpen); window.removeEventListener('xharness:workspace-close-tool', onCloseTool); };
    }, []);
    (0, react_1.useEffect)(() => {
        setSpaces(all => {
            let changed = false;
            const next = { ...all };
            for (const [key, value] of Object.entries(next))
                if (key !== spaceKey && value.items.some(item => item.kind === 'tool')) {
                    next[key] = (0, workspace_pane_1.xhWorkspaceClose)(value, 'tool');
                    changed = true;
                }
            return changed ? next : all;
        });
    }, [spaceKey]);
    (0, react_1.useEffect)(() => { void xhWorkspaceWindow.set(space.items.length > 0, 440); }, [space.items.length > 0]);
    (0, react_1.useEffect)(() => () => { void xhWorkspaceWindow.set(false); }, []);
    const lastSession = (0, react_1.useRef)(detailsSession);
    (0, react_1.useLayoutEffect)(() => {
        if (detailsSession === undefined)
            return;
        if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
            actions.closeDetails();
        }
        lastSession.current = detailsSession;
    }, [actions, detailsSession]);
    // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
    (0, react_1.useEffect)(() => {
        const el = frameRef.current;
        /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
        if (el === null)
            return;
        let raf = null;
        const observer = new ResizeObserver(() => {
            raf ?? (raf = requestAnimationFrame(() => {
                raf = null;
                const width = el.getBoundingClientRect().width;
                if (width > 0)
                    setViewport(width);
            }));
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
            if (raf !== null)
                cancelAnimationFrame(raf);
        };
    }, []);
    // Narrow viewports auto-collapse the sidebar; the store mirror keeps
    // toggleSidebar's semantics right (narrow toggles flip the manual
    // re-expand override, stores.ts). A narrow manual expansion is a drawer:
    // the solver keeps the control rail reserved and never squeezes the center.
    const narrow = viewport < columns_1.SIDEBAR_AUTO_COLLAPSE;
    (0, react_1.useEffect)(() => { actions.setNarrow(narrow); }, [actions, narrow]);
    const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0;
    const sidebarDrawer = narrow && !sidebarCollapsed;
    const sidebarWidth = sidebarCollapsed || sidebarDrawer ? 56 : panels.sidebar === 0 ? columns_1.SIDEBAR_DEFAULT : (0, columns_1.clampWidth)(panels.sidebar, 264, 420);
    const workspaceOpen = space.items.length > 0;
    const workspaceAvailable = viewport - sidebarWidth - 480;
    const workspaceDrawer = workspaceOpen && workspaceAvailable < 360;
    const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, workspaceAvailable) : 0;
    const cols = (0, columns_1.computeColumns)(viewport - workspaceDockWidth, sidebarCollapsed || sidebarDrawer ? 0 : panels.sidebar === 0 ? columns_1.SIDEBAR_DEFAULT : panels.sidebar, 0, workspaceDockWidth > 0 ? 480 : 640);
    const colsRef = (0, react_1.useRef)(cols);
    colsRef.current = cols;
    // The drag base is the rendered width captured at drag start (grabbing a
    // concession-clamped panel must not jump back to the stored preference);
    // it stays frozen for the whole gesture so dx deltas do not compound.
    const sidebarBase = (0, react_1.useRef)(0);
    const workspaceBase = (0, react_1.useRef)(0);
    // Track-level transitions pause for the whole gesture: eased tracks would
    // detach the column edge from the pointer (AppFrame.module.css).
    const [dragging, setDragging] = (0, react_1.useState)(false);
    const onDragEnd = (0, react_1.useCallback)(() => { setDragging(false); }, []);
    const onSidebarStart = (0, react_1.useCallback)(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true); }, []);
    const onSidebarDrag = (0, react_1.useCallback)((dx) => {
        actions.setSidebar(sidebarBase.current + dx);
    }, [actions]);
    const onWorkspaceStart = () => { workspaceBase.current = workspaceDockWidth; setDragging(true); };
    const onWorkspaceDrag = (dx) => { if (dx < 0)
        setWorkspaceWidth(Math.max(workspaceBase.current, Math.min(900, workspaceAvailable, workspaceBase.current - dx))); };
    const updateItem = (id, patch) => updateSpace(value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) }));
    return ((0, jsx_runtime_1.jsxs)("div", { ref: frameRef, className: AppFrame_styles_1.default.frame, style: { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${workspaceDockWidth}px` }, "data-xhworkspace-open": workspaceOpen || undefined, "data-xhworkspace-drawer": workspaceDrawer || undefined, "data-sidebar-collapsed": sidebarCollapsed || undefined, "data-sidebar-drawer": sidebarDrawer || undefined, "data-details-collapsed": !workspaceOpen || undefined, "data-dragging": dragging || undefined, children: [sidebarDrawer && (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xh-sidebar-scrim", "aria-label": navigator.language.startsWith('zh') ? '关闭侧栏' : 'Close sidebar', onClick: actions.toggleSidebar }), (0, jsx_runtime_1.jsx)("div", { className: AppFrame_styles_1.default.sidebarCol, style: sidebarDrawer ? { width: Math.min(viewport - 24, panels.sidebar === 0 ? columns_1.SIDEBAR_DEFAULT : (0, columns_1.clampWidth)(panels.sidebar, 264, 420)) } : undefined, onClickCapture: event => {
                    const target = event.target;
                    if (pluginCenterOpen && (!(target instanceof Element) || !target.closest('[data-xharness-plugin-nav]')))
                        closePluginCenter();
                    if (sidebarDrawer && target instanceof Element && target.closest('[role="treeitem"][aria-selected]'))
                        actions.toggleSidebar();
                }, children: renderSlot('sidebar', {
                    collapsed: sidebarCollapsed,
                    width: sidebarDrawer ? Math.min(viewport - 24, panels.sidebar === 0 ? columns_1.SIDEBAR_DEFAULT : (0, columns_1.clampWidth)(panels.sidebar, 264, 420)) : cols.sidebar,
                }) }), (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(CenterColumn, { children: pluginCenterOpen ? (0, jsx_runtime_1.jsxs)("main", { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px clamp(20px, 5vw, 56px)' }, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", style: { cursor: 'pointer', background: 'none', border: 0, color: 'var(--dsw-alias-label-secondary)', padding: '0 0 24px', font: 'inherit' }, "aria-label": "Back to chat", onClick: closePluginCenter, children: ["\u2190 ", navigator.language.startsWith('zh') ? '返回对话' : 'Back to chat'] }), renderSlot('plugins.center', {})] }) : renderSlot('conversation', {}) }), workspaceDrawer && (0, jsx_runtime_1.jsx)("button", { type: "button", className: AppFrame_styles_1.default.workspaceScrim, "aria-label": "\u5173\u95ED\u5DE5\u4F5C\u533A", onClick: () => closeWorkspace(space.activeId) }), (0, jsx_runtime_1.jsx)(DetailsColumn, { children: (0, jsx_runtime_1.jsx)(workspace_pane_1.XhWorkspacePane, { space: space, sessionId: spaceKey === '__global__' ? null : spaceKey, renderSlot: renderSlot, onSelect: id => updateSpace(value => ({ ...value, activeId: id })), onClose: closeWorkspace, onUpdate: updateItem, onNewBrowser: () => openWorkspace('browser', true) }) })] }), (0, jsx_runtime_1.jsx)("div", { className: AppFrame_styles_1.default.overlayLayer, "data-shell-overlay": true, children: renderSlot('shell.overlay', {}) }), !sidebarCollapsed && !sidebarDrawer && (0, jsx_runtime_1.jsx)(DragHandle, { side: "sidebar", left: cols.sidebar, onStart: onSidebarStart, onDrag: onSidebarDrag, onEnd: onDragEnd }), workspaceDockWidth > 0 && (0, jsx_runtime_1.jsx)(DragHandle, { side: "details", left: viewport - workspaceDockWidth, onStart: onWorkspaceStart, onDrag: onWorkspaceDrag, onEnd: onDragEnd })] }));
}

},
"src/modules/layout/columns.js": function(module, exports, require) {
// source: src/modules/layout/columns.ts

"use strict";
/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), and center absorbs any remaining
 * deficit as the last resort. Inputs are the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DETAILS_DEFAULT = exports.DETAILS_MAX = exports.DETAILS_MIN = exports.SIDEBAR_AUTO_COLLAPSE = exports.SIDEBAR_COLLAPSED = exports.SIDEBAR_DEFAULT = exports.SIDEBAR_MAX = exports.SIDEBAR_MIN = exports.CENTER_MIN = void 0;
exports.clampWidth = clampWidth;
exports.computeColumns = computeColumns;
// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
exports.CENTER_MIN = 640;
/** Sidebar drag clamp floor. */
exports.SIDEBAR_MIN = 264;
/** Sidebar drag clamp ceiling. */
exports.SIDEBAR_MAX = 420;
/** Sidebar width before any user drag. */
exports.SIDEBAR_DEFAULT = 280;
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
exports.SIDEBAR_COLLAPSED = 56;
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
exports.SIDEBAR_AUTO_COLLAPSE = 1024;
/** Details drag clamp floor. */
exports.DETAILS_MIN = 300;
/** Details drag clamp ceiling. */
exports.DETAILS_MAX = 520;
/** Details width before any user drag. */
exports.DETAILS_DEFAULT = 360;
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
 * @param minCenter - center floor; the workspace dock may use its current constrained floor.
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
function computeColumns(viewport, sidebar, details, minCenter = exports.CENTER_MIN) {
    // The sidebar is fixed at its preference (or the rail) — it never concedes.
    const s = sidebar === 0 ? exports.SIDEBAR_COLLAPSED : clampWidth(sidebar, exports.SIDEBAR_MIN, exports.SIDEBAR_MAX);
    const d0 = details === 0 ? 0 : clampWidth(details, exports.DETAILS_MIN, exports.DETAILS_MAX);
    // Step 1: everything fits at preferred widths.
    if (s + d0 + minCenter <= viewport)
        return { sidebar: s, center: viewport - s - d0, details: d0 };
    // Step 2: shrink details toward its minimum.
    const d1 = d0 === 0 ? 0 : Math.max(exports.DETAILS_MIN, viewport - s - minCenter);
    if (s + d1 + minCenter <= viewport)
        return { sidebar: s, center: minCenter, details: d1 };
    // Step 3: auto-close details (derived — preferences untouched); center
    // absorbs any remaining deficit (may drop below CENTER_MIN).
    return { sidebar: s, center: Math.max(0, viewport - s), details: 0 };
}

},
"src/modules/layout/AppFrame.styles.js": function(module, exports, require) {
// source: src/modules/layout/AppFrame.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AppFrame_css_1 = __importDefault(require("./AppFrame.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-layout/AppFrame.module.css", "@xharness/dsh-client-ui-layout", AppFrame_css_1.default);
const styles = {
    "centerCol": "_84hhiq_centerCol",
    "detailsCol": "_84hhiq_detailsCol",
    "frame": "_84hhiq_frame",
    "handle": "_84hhiq_handle",
    "overlayLayer": "_84hhiq_overlayLayer",
    "sidebarCol": "_84hhiq_sidebarCol",
    "workspaceScrim": "_84hhiq_workspaceScrim"
};
exports.default = styles;

},
"src/modules/layout/AppFrame.css": function(module, exports, require) {
// source: src/modules/layout/AppFrame.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._84hhiq_frame{background:var(--dsw-alias-bg-base);height:100%;transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);grid-template-rows:100%;display:grid;position:relative;overflow:hidden}._84hhiq_frame[data-dragging]{transition:none}@media (prefers-reduced-motion:reduce){._84hhiq_frame{transition:none}}._84hhiq_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}._84hhiq_centerCol{isolation:isolate;z-index:0;flex-direction:column;min-width:0;display:flex;overflow:hidden}._84hhiq_detailsCol{isolation:isolate;z-index:0;border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}._84hhiq_frame[data-details-collapsed] ._84hhiq_detailsCol{border-left:none}._84hhiq_handle{cursor:col-resize;z-index:2;touch-action:none;width:8px;transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out);margin-left:-4px;position:absolute;top:0;bottom:0}._84hhiq_frame[data-dragging] ._84hhiq_handle{transition:none}@media (prefers-reduced-motion:reduce){._84hhiq_handle{transition:none}}._84hhiq_handle[data-side=details]:after{content:\"\";box-sizing:border-box;background:var(--dsw-alias-button-floating-fill);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);opacity:0;width:12px;height:32px;transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out), background var(--ds-transition-duration-slow) var(--ds-ease-in-out);border-radius:10px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}._84hhiq_detailsCol:hover~._84hhiq_handle[data-side=details]:after,._84hhiq_handle[data-side=details]:hover:after,._84hhiq_handle[data-side=details][data-dragging=true]:after{opacity:1}._84hhiq_handle[data-side=details]:hover:after,._84hhiq_handle[data-side=details][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}._84hhiq_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}._84hhiq_overlayLayer>*{pointer-events:auto}._84hhiq_frame:not([data-xhworkspace-open]){transition:none}._84hhiq_handle[data-side=details]{cursor:w-resize}.xhworkspace{height:100%;min-width:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}.xhworkspace-tabs{display:flex;align-items:center;flex:none;min-height:40px;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:thin}.xhworkspace-tab{display:flex;align-items:center;flex:none;max-width:180px;min-width:90px;height:35px;border-radius:7px 7px 0 0;color:var(--dsw-alias-label-tertiary)}.xhworkspace-tab[data-active]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.xhworkspace-tab>button[role=tab]{display:flex;align-items:center;gap:6px;min-width:0;flex:1;padding:0 8px;border:0;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}.xhworkspace-kind{flex:none}.xhworkspace-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhworkspace-tab-close,.xhworkspace-new{flex:none;width:25px;height:25px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}.xhworkspace-tab-close:hover,.xhworkspace-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhworkspace-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item{flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item[hidden]{display:none}.xhworkspace-tool>div>div:first-child{display:none}._84hhiq_frame[data-xhworkspace-drawer] ._84hhiq_detailsCol{position:absolute;right:0;top:0;bottom:0;width:min(560px,calc(100% - 44px));z-index:10;box-shadow:-14px 0 40px #0004}._84hhiq_workspaceScrim{position:absolute;inset:0;z-index:9;border:0;background:#0008}\n._84hhiq_sidebarCol{grid-column:1;grid-row:1}._84hhiq_centerCol{grid-column:2;grid-row:1}._84hhiq_detailsCol{grid-column:3;grid-row:1}._84hhiq_frame[data-sidebar-drawer] ._84hhiq_sidebarCol{position:absolute;left:0;top:0;bottom:0;z-index:30;box-shadow:12px 0 32px #0003;max-width:calc(100% - 24px)}.xh-sidebar-scrim{position:absolute;inset:0;z-index:29;border:0;padding:0;background:#0005}\n/* Absolute drawers use the frame, not the reserved 56px / zero-width grid\n   track, as their containing block. Docked occupants keep explicit tracks. */\n._84hhiq_frame[data-sidebar-drawer] ._84hhiq_sidebarCol,._84hhiq_frame[data-xhworkspace-drawer] ._84hhiq_detailsCol{grid-area:auto}\n";

},
"src/modules/views-types.js": function(module, exports, require) {
// source: src/modules/views-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classNames = classNames;
exports.installStyles = installStyles;
function classNames(...values) { return values.filter(Boolean).join(' '); }
/** Exact legacy style identity, but editable source rather than compiled input. */
function installStyles(id, plugin, css) {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = plugin;
    tag.dataset.pluginCss = id;
    tag.textContent = css;
    document.head.appendChild(tag);
}

},
"src/modules/layout/browser-window-controller.js": function(module, exports, require) {
// source: src/modules/layout/browser-window-controller.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhCreateBrowserWindowController = xhCreateBrowserWindowController;
/** Full rightward native lease; partial growth never replaces the left dock. */
function xhCreateBrowserWindowController(tauri) {
    const api = tauri?.window;
    const LogicalSize = api?.LogicalSize ?? tauri?.dpi?.LogicalSize;
    let lease = null;
    let queue = Promise.resolve(0);
    const resize = async (open, preferredWidth) => {
        if (typeof api?.getCurrentWindow !== 'function' || typeof api.currentMonitor !== 'function' || typeof LogicalSize !== 'function')
            return 0;
        const nativeWindow = api.getCurrentWindow();
        if (!nativeWindow || typeof nativeWindow.setSize !== 'function')
            return 0;
        const size = await nativeWindow.innerSize(), scale = await nativeWindow.scaleFactor();
        if (!Number.isFinite(scale) || scale <= 0)
            return 0;
        const logicalWidth = size.width / scale, logicalHeight = size.height / scale;
        const unchanged = lease !== null && Math.abs(logicalWidth - lease.baseWidth - lease.addedWidth) <= 8;
        if (!unchanged)
            lease = null;
        if (!open) {
            if (lease !== null)
                await nativeWindow.setSize(new LogicalSize(lease.baseWidth, logicalHeight));
            lease = null;
            return 0;
        }
        if (await nativeWindow.isMaximized() || await nativeWindow.isFullscreen())
            return lease?.addedWidth ?? 0;
        const monitor = await api.currentMonitor();
        if (!monitor?.workArea?.position || !monitor.workArea.size)
            return lease?.addedWidth ?? 0;
        const position = await nativeWindow.outerPosition(), outer = await nativeWindow.outerSize();
        const wanted = Math.max(360, Math.min(900, Math.round(preferredWidth)));
        const rightEdge = monitor.workArea.position.x + monitor.workArea.size.width;
        const spare = Math.max(0, (rightEdge - position.x - outer.width) / scale - 8), priorAdded = lease?.addedWidth ?? 0;
        if (spare + priorAdded < wanted) {
            if (lease !== null)
                await nativeWindow.setSize(new LogicalSize(lease.baseWidth, logicalHeight));
            lease = null;
            return 0;
        }
        const baseWidth = lease?.baseWidth ?? logicalWidth;
        if (Math.abs(wanted - priorAdded) > 1)
            await nativeWindow.setSize(new LogicalSize(baseWidth + wanted, logicalHeight));
        lease = { baseWidth, addedWidth: wanted };
        return wanted;
    };
    return { set(open, preferredWidth = 440) {
            queue = queue.catch(() => 0).then(() => resize(open, preferredWidth));
            return queue.catch(() => 0);
        } };
}

},
"src/modules/layout/workspace-pane.js": function(module, exports, require) {
// source: src/modules/layout/workspace-pane.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xhWorkspaceStorageKey = exports.xhWorkspaceEmpty = void 0;
exports.xhLoadBrowserSpaces = xhLoadBrowserSpaces;
exports.xhSaveBrowserSpaces = xhSaveBrowserSpaces;
exports.xhNextWorkspaceId = xhNextWorkspaceId;
exports.xhWorkspaceOpen = xhWorkspaceOpen;
exports.xhWorkspaceClose = xhWorkspaceClose;
exports.XhWorkspacePane = XhWorkspacePane;
exports.workspaceOpenDetail = workspaceOpenDetail;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../shared/runtime-types");
exports.xhWorkspaceEmpty = { items: [], activeId: null };
exports.xhWorkspaceStorageKey = 'xharness:browser-spaces-v1';
let xhBrowserPersistQueue = Promise.resolve();
let xhLastBrowserSnapshot = null;
const arrayValue = (value) => Array.isArray(value) ? value : [];
/** Historical bounded JSON currency: only browser items are persisted. */
function xhLoadBrowserSpaces(snapshot) {
    try {
        const stored = JSON.parse(snapshot ?? localStorage.getItem(exports.xhWorkspaceStorageKey) ?? '{}');
        if (!stored || typeof stored !== 'object' || Array.isArray(stored))
            return {};
        const result = {};
        for (const [key, rawSpace] of Object.entries((0, runtime_types_1.objectValue)(stored)).slice(-50)) {
            const space = (0, runtime_types_1.objectValue)(rawSpace);
            if (typeof key !== 'string' || !Array.isArray(space.items))
                continue;
            const items = arrayValue(space.items).map(runtime_types_1.objectValue).filter(item => item.kind === 'browser' && typeof item.id === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(item.id)).slice(-128).flatMap(item => {
                if (typeof item.id !== 'string')
                    return [];
                const valid = arrayValue(item.entries).filter((url) => {
                    try {
                        if (typeof url !== 'string')
                            return false;
                        const parsed = new URL(url);
                        return url.length <= 4096 && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
                    }
                    catch {
                        return false;
                    }
                });
                return [{ id: item.id, kind: 'browser', source: 'browser', title: typeof item.title === 'string' ? item.title.slice(0, 160) : '新标签页', entries: valid.slice(-50), position: typeof item.position === 'number' && Number.isInteger(item.position) ? item.position - Math.max(0, valid.length - 50) : -1 }];
            });
            for (const item of items)
                item.position = Math.max(-1, Math.min(item.position, item.entries.length - 1));
            const first = items[0];
            if (first !== undefined)
                result[key] = { items, activeId: typeof space.activeId === 'string' && items.some(item => item.id === space.activeId) ? space.activeId : first.id };
        }
        return result;
    }
    catch {
        return {};
    }
}
function xhSaveBrowserSpaces(spaces) {
    const stored = {};
    for (const [key, space] of Object.entries(spaces).slice(-50)) {
        const items = space.items.filter(item => item.kind === 'browser');
        if (items.length)
            stored[key] = { items, activeId: space.activeId };
    }
    const snapshot = JSON.stringify(xhLoadBrowserSpaces(JSON.stringify(stored)));
    try {
        localStorage.setItem(exports.xhWorkspaceStorageKey, snapshot);
    }
    catch { /* Origin storage can be blocked. */ }
    const native = window.__TAURI__;
    if (native?.core?.invoke && snapshot !== xhLastBrowserSnapshot) {
        xhLastBrowserSnapshot = snapshot;
        xhBrowserPersistQueue = xhBrowserPersistQueue.catch(() => { }).then(() => native.core.invoke('desktop_browser_persist', { snapshot })).catch(() => { xhLastBrowserSnapshot = null; });
    }
}
function xhNextWorkspaceId(spaces) {
    return Math.max(0, ...Object.values(spaces).flatMap(space => space.items.map(item => Number(item.id.match(/^browser:(\d+)$/)?.[1]) || 0)));
}
function xhWorkspaceOpen(space, item, reuse = true) {
    const existing = reuse && space.items.find(value => value.kind === item.kind && value.source === item.source);
    if (existing)
        return { ...space, activeId: existing.id };
    return { items: [...space.items, item], activeId: item.id };
}
function xhWorkspaceClose(space, id) {
    const index = space.items.findIndex(item => item.id === id);
    if (index < 0)
        return space;
    const items = space.items.filter(item => item.id !== id);
    return { items, activeId: space.activeId === id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : space.activeId };
}
function XhWorkspacePane({ space, sessionId, renderSlot, onSelect, onClose, onUpdate, onNewBrowser }) {
    const active = space.items.find(item => item.id === space.activeId);
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhworkspace", "aria-label": "\u5DE5\u4F5C\u533A", children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhworkspace-tabs", role: "tablist", "aria-label": "\u5DE5\u4F5C\u533A\u6807\u7B7E", children: [space.items.map(item => (0, jsx_runtime_1.jsxs)("div", { className: "xhworkspace-tab", "data-active": item.id === space.activeId || undefined, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", role: "tab", "aria-selected": item.id === space.activeId, onClick: () => onSelect(item.id), title: item.title, children: [(0, jsx_runtime_1.jsx)("span", { className: "xhworkspace-kind", "aria-hidden": true, children: item.kind === 'browser' ? '◎' : item.kind === 'tool' ? '⌘' : '▤' }), (0, jsx_runtime_1.jsx)("span", { className: "xhworkspace-title", children: item.title })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhworkspace-tab-close", "aria-label": `关闭 ${item.title}`, onClick: () => onClose(item.id), title: "\u5173\u95ED\u6807\u7B7E", children: "\u00D7" })] }, item.id)), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhworkspace-new", "aria-label": "\u65B0\u5EFA\u6D4F\u89C8\u5668\u6807\u7B7E", onClick: onNewBrowser, title: "\u65B0\u5EFA\u6D4F\u89C8\u5668\u6807\u7B7E", children: "+" })] }), (0, jsx_runtime_1.jsx)("div", { className: "xhworkspace-body", children: active && (0, jsx_runtime_1.jsx)("div", { className: `xhworkspace-item xhworkspace-${active.kind}`, role: "tabpanel", children: active.kind === 'tool' ? renderSlot('details', {}) : renderSlot('workspace.item', { item: active, sessionId, open: true, onUpdate: patch => onUpdate(active.id, patch), onClose: () => onClose(active.id), onNewBrowser }) }, active.id) })] });
}
/** Actual DOM event fields produced by BrowserToggle/ToolDetails/FileView. */
function workspaceOpenDetail(value) {
    const raw = (0, runtime_types_1.objectValue)(value);
    if (raw.kind !== 'browser' && raw.kind !== 'tool' && !(raw.kind === 'file' && typeof raw.source === 'string' && raw.source.length > 0))
        return undefined;
    const kind = raw.kind;
    if (kind !== 'browser' && kind !== 'tool' && kind !== 'file')
        return undefined;
    return { kind, ...typeof raw.fresh === 'boolean' ? { fresh: raw.fresh } : {}, ...typeof raw.source === 'string' ? { source: raw.source } : {}, ...typeof raw.title === 'string' ? { title: raw.title } : {}, ...typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}, ...typeof raw.url === 'string' ? { url: raw.url } : {} };
}

},
"src/modules/shared/runtime-types.js": function(module, exports, require) {
// source: src/modules/shared/runtime-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isObjectRecord = isObjectRecord;
exports.objectValue = objectValue;
exports.errorText = errorText;
exports.textValue = textValue;
exports.numberValue = numberValue;
function isObjectRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function objectValue(value) {
    return isObjectRecord(value) ? value : {};
}
function errorText(error) {
    const record = objectValue(error);
    const rpc = objectValue(record.rpcError);
    return typeof rpc.message === 'string' ? rpc.message : typeof record.message === 'string' ? record.message : String(error);
}
function textValue(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function numberValue(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

},
"src/modules/layout/stores.js": function(module, exports, require) {
// source: src/modules/layout/stores.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLayoutStore = createLayoutStore;
/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
const client_1 = require("@xharness/dsh-client-runtime/client");
const columns_1 = require("./columns");
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
    const handle = (0, client_1.defineStore)({
        bake: (bind, actions) => ({
            setSidebar: bind(actions.setSidebar), setDetails: bind(actions.setDetails),
            toggleSidebar: bind(actions.toggleSidebar), setNarrow: bind(actions.setNarrow),
            openDetails: bind(actions.openDetails), closeDetails: bind(actions.closeDetails),
        }),
        init: () => ({ sidebar: columns_1.SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false }),
        actions: {
            setSidebar: (d, px) => { d.sidebar = (0, columns_1.clampWidth)(px, columns_1.SIDEBAR_MIN, columns_1.SIDEBAR_MAX); },
            setDetails: (d, px) => { d.details = (0, columns_1.clampWidth)(px, columns_1.DETAILS_MIN, columns_1.DETAILS_MAX); },
            // Narrow toggles flip only the override: the width preference survives
            // untouched, so re-widening restores the pre-squeeze layout.
            toggleSidebar: (d) => {
                if (d.narrow)
                    d.narrowExpanded = !d.narrowExpanded;
                else
                    d.sidebar = d.sidebar === 0 ? columns_1.SIDEBAR_DEFAULT : 0;
            },
            // Crossing the breakpoint in either direction drops the override: the
            // narrow default is auto-collapsed, the wide state is the preference.
            setNarrow: (d, narrow) => {
                if (d.narrow === narrow)
                    return;
                d.narrow = narrow;
                d.narrowExpanded = false;
            },
            openDetails: (d) => { if (d.details === 0)
                d.details = columns_1.DETAILS_DEFAULT; },
            closeDetails: (d) => { d.details = 0; },
        },
    });
    return handle;
}

},
"src/modules/layout/service.js": function(module, exports, require) {
// source: src/modules/layout/service.ts

"use strict";
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _LayoutController_instances, _LayoutController_panels, _LayoutController_require;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LayoutController = void 0;
/** Cross-plugin panel-action face (ctx.layout). */
class LayoutController {
    constructor() {
        _LayoutController_instances.add(this);
        _LayoutController_panels.set(this, void 0);
    }
    /**
     * Adopt the root entry's bound store actions. Called from the root
     * registration's inject hook (a sanctioned assembly side effect), so the
     * face is live from the entry's first render; on entry re-register the
     * fresh actions overwrite the stale set.
     * @param actions - bound actions of the entry's layout store instance.
     */
    attachPanels(actions) {
        __classPrivateFieldSet(this, _LayoutController_panels, actions, "f");
    }
    /** Toggle the sidebar panel (closed ⟷ contract default width). */
    toggleSidebar() {
        __classPrivateFieldGet(this, _LayoutController_instances, "m", _LayoutController_require).call(this).toggleSidebar();
    }
    /** Open the details panel (no-op when already open). */
    openDetails() {
        __classPrivateFieldGet(this, _LayoutController_instances, "m", _LayoutController_require).call(this).openDetails();
        window.dispatchEvent(new CustomEvent('xharness:workspace-open', { detail: { kind: 'tool' } }));
    }
    /** Close the details panel. */
    closeDetails() {
        __classPrivateFieldGet(this, _LayoutController_instances, "m", _LayoutController_require).call(this).closeDetails();
        window.dispatchEvent(new Event('xharness:workspace-close-tool'));
    }
}
exports.LayoutController = LayoutController;
_LayoutController_panels = new WeakMap(), _LayoutController_instances = new WeakSet(), _LayoutController_require = function _LayoutController_require() {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (__classPrivateFieldGet(this, _LayoutController_panels, "f") === undefined)
        throw new Error('layout: panel actions not wired (root entry not mounted)');
    return __classPrivateFieldGet(this, _LayoutController_panels, "f");
};

},
"src/modules/layout/theme-presenter.js": function(module, exports, require) {
// source: src/modules/layout/theme-presenter.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThemePresenter = exports.DARK_ATTRIBUTE = void 0;
/** Body attribute selecting the dark base palette in the token stylesheets. */
exports.DARK_ATTRIBUTE = 'data-ds-dark-theme';
/** Applies theme snapshots to the document; one instance per plugin fiber. */
class ThemePresenter {
    /** Create the presenter-owned metadata node before the first snapshot arrives. */
    constructor() {
        /** Token names this presenter wrote in the last apply (its retraction set). */
        this.appliedTokens = [];
        this.themeColorMeta = document.createElement('meta');
        this.themeColorMeta.name = 'theme-color';
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
        if (scheme === 'dark')
            body.setAttribute(exports.DARK_ATTRIBUTE, '');
        else
            body.removeAttribute(exports.DARK_ATTRIBUTE);
        for (const name of this.appliedTokens)
            body.style.removeProperty(name);
        this.appliedTokens = [];
        for (const [name, value] of Object.entries(snapshot.active.tokens)) {
            body.style.setProperty(name, value);
            this.appliedTokens.push(name);
        }
        this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
        if (!this.themeColorMeta.isConnected)
            document.head.append(this.themeColorMeta);
    }
    /** Retract root color-scheme, the palette attribute, token variables, and the owned metadata node. */
    dispose() {
        document.documentElement.style.removeProperty('color-scheme');
        const body = document.body;
        body.removeAttribute(exports.DARK_ATTRIBUTE);
        for (const name of this.appliedTokens)
            body.style.removeProperty(name);
        this.appliedTokens = [];
        this.themeColorMeta.remove();
    }
}
exports.ThemePresenter = ThemePresenter;

}
};
const __dependencies = {"src/modules/layout/index.js":{"./AppFrame":"src/modules/layout/AppFrame.js","./stores":"src/modules/layout/stores.js","./service":"src/modules/layout/service.js","./theme-presenter":"src/modules/layout/theme-presenter.js"},"src/modules/layout/AppFrame.js":{"./columns":"src/modules/layout/columns.js","./AppFrame.styles":"src/modules/layout/AppFrame.styles.js","./browser-window-controller":"src/modules/layout/browser-window-controller.js","./workspace-pane":"src/modules/layout/workspace-pane.js"},"src/modules/layout/columns.js":{},"src/modules/layout/AppFrame.styles.js":{"./AppFrame.css":"src/modules/layout/AppFrame.css","../views-types":"src/modules/views-types.js"},"src/modules/layout/AppFrame.css":{},"src/modules/views-types.js":{},"src/modules/layout/browser-window-controller.js":{},"src/modules/layout/workspace-pane.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/layout/stores.js":{"./columns":"src/modules/layout/columns.js"},"src/modules/layout/service.js":{},"src/modules/layout/theme-presenter.js":{}};
const __cache = Object.create(null);
const __load = id => {
  if (__cache[id]) return __cache[id].exports;
  const unit = __units[id];
  if (!unit) throw Error('Unknown local UI module: ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  try {
    unit(module, module.exports, request => Object.prototype.hasOwnProperty.call(__dependencies[id], request)
      ? __load(__dependencies[id][request]) : __externalRequire(request));
  } catch (error) { delete __cache[id]; throw error; }
  return module.exports;
};
return __load("src/modules/layout/index.js");
}
});
