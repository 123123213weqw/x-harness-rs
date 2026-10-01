// Rebuild-time patch of upstream AppFrame. Browser, tool details and future
// files use one workspace column rather than separate right-hand columns.
import { readFileSync } from 'node:fs'

export const WORKSPACE_MARKER = 'xharness-workspace-pane/v1'
export const BROWSER_DOCK_MARKER = WORKSPACE_MARKER // Existing rebuild/test import.

export function patchBrowserDock(bytes) {
  let source = bytes.toString()
  const controller = readFileSync(new URL('../ui/overrides/browser-window-controller.js', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../ui/overrides/workspace-pane.js', import.meta.url), 'utf8')
  if (source.includes(WORKSPACE_MARKER)) {
    // Product-only refreshes must update the embedded helpers too. Otherwise
    // a changed source file appears in Git but the shipped layout keeps an old
    // copy forever because this patch was previously treated as a no-op.
    const start = source.indexOf('// xh-browser-window-controller/v1')
    const end = source.indexOf('function computeColumns(', start)
    if (start < 0 || end < 0) throw Error('browser layout helper markers missing')
    source = source.slice(0, start) + controller + '\n' + workspace + '\n' + source.slice(end)
    source = source.replace('XhWorkspacePane, { space, renderSlot,', 'XhWorkspacePane, { space, sessionId: spaceKey === "__global__" ? null : spaceKey, renderSlot,')
    // Rebuilds usually start from the checked-in, already-patched bundle.
    // Refresh the column policy as well as the embedded helper sources.
    source = source.replace(
      'const workspaceDrawer = workspaceOpen && (nativeWorkspaceWidth < 360 || workspaceAvailable < 360);',
      'const workspaceDrawer = workspaceOpen && workspaceAvailable < 360;',
    ).replace(
      'const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, nativeWorkspaceWidth, workspaceAvailable) : 0;',
      'const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, workspaceAvailable) : 0;',
    )
    source = source.replace(
      'const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, nativeWorkspaceWidth >= 360 ? nativeWorkspaceWidth : workspaceAvailable, workspaceAvailable) : 0;',
      'const workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, workspaceAvailable) : 0;',
    ).replace(
      '\t\t\tconst [nativeWorkspaceWidth, setNativeWorkspaceWidth] = (0, react.useState)(0);\n',
      '',
    ).replace(
      '(0, react.useEffect)(() => { let active = true; xhWorkspaceWindow.set(space.items.length > 0, workspaceWidth).then(width => { if (active) setNativeWorkspaceWidth(width); }); return () => { active = false; }; }, [space.items.length > 0, workspaceWidth]);',
      '(0, react.useEffect)(() => { void xhWorkspaceWindow.set(space.items.length > 0, 440); }, [space.items.length > 0]);',
    )
    if (!source.includes('browserRestored')) {
      source = source.replace('const [spaces, setSpaces] = (0, react.useState)({});',
        'const [spaces, setSpaces] = (0, react.useState)(xhLoadBrowserSpaces);\n'
        + '\t\t\tconst [browserRestored, setBrowserRestored] = (0, react.useState)(!window.__TAURI__?.core?.invoke);')
      source = source.replace('const nextWorkspaceId = (0, react.useRef)(0);',
        'const nextWorkspaceId = (0, react.useRef)(xhNextWorkspaceId(spaces));\n'
        + '\t\t\t(0, react.useEffect)(() => { if (browserRestored) xhSaveBrowserSpaces(spaces); nextWorkspaceId.current = Math.max(nextWorkspaceId.current, xhNextWorkspaceId(spaces)); }, [spaces, browserRestored]);\n'
        + '\t\t\t(0, react.useEffect)(() => { if (!window.__TAURI__?.core?.invoke) return; let alive = true; window.__TAURI__.core.invoke("desktop_browser_restore").then(snapshot => { if (alive && snapshot) setSpaces(xhLoadBrowserSpaces(snapshot)); }).catch(() => {}).finally(() => { if (alive) setBrowserRestored(true); }); return () => { alive = false; }; }, []);')
    }
    if (!source.includes('xharness:browser-close')) {
      source = source.replace('const closeWorkspace = id => { if (id === "tool") actions.closeDetails(); updateSpace(value => xhWorkspaceClose(value, id)); };',
        'const closeWorkspace = id => { if (id === "tool") actions.closeDetails(); if (space.items.some(item => item.id === id && item.kind === "browser")) window.dispatchEvent(new CustomEvent("xharness:browser-close", { detail: { id } })); updateSpace(value => xhWorkspaceClose(value, id)); };')
    }
    source = source.replace('entries: [], position: -1 };', 'entries: detail.url ? [detail.url] : [], position: detail.url ? 0 : -1 };')
    source = source.replace('const onWorkspaceDrag = dx => setWorkspaceWidth(clampWidth(workspaceBase.current - dx, 360, 900));',
      'const onWorkspaceDrag = dx => { if (dx < 0) setWorkspaceWidth(Math.max(workspaceBase.current, Math.min(900, workspaceAvailable, workspaceBase.current - dx))); };')
    if (!source.includes("._84hhiq_frame:not([data-xhworkspace-open]){transition:none}")) source = source.replace("._84hhiq_overlayLayer>*{pointer-events:auto}", "._84hhiq_overlayLayer>*{pointer-events:auto}._84hhiq_frame:not([data-xhworkspace-open]){transition:none}._84hhiq_handle[data-side=details]{cursor:w-resize}")
    return Buffer.from(source.replace(".xhworkspace-body,.xhworkspace-item{flex:1;min-height:0;min-width:0;overflow:hidden}", ".xhworkspace-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item{flex:1;min-height:0;min-width:0;overflow:hidden}"))
  }
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw Error(`workspace layout anchor changed: ${before.slice(0, 100)}`)
    source = source.replace(before, after)
  }
  once('function computeColumns(viewport, sidebar, details) {', controller + '\n' + workspace + '\nfunction computeColumns(viewport, sidebar, details, minCenter = 640) {')
  const start = source.indexOf('function computeColumns(')
  const end = source.indexOf('\n\t\t//#endregion', start)
  if (start < 0 || end < 0) throw Error('workspace column solver not found')
  const solver = source.slice(start, end).replaceAll('640', 'minCenter').replace('minCenter = minCenter', 'minCenter = 640')
  source = source.slice(0, start) + solver + source.slice(end)
  once('function AppFrame({ useStore, useSessions, actions, renderSlot }) {',
    'const xhWorkspaceWindow = xhCreateBrowserWindowController(typeof window === "undefined" ? void 0 : window.__TAURI__);\n\t\tfunction AppFrame({ useStore, useSessions, actions, renderSlot }) {')
  const css = '._84hhiq_frame:not([data-xhworkspace-open]){transition:none}._84hhiq_handle[data-side=details]{cursor:w-resize}.xhworkspace{height:100%;min-width:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}.xhworkspace-tabs{display:flex;align-items:center;flex:none;min-height:40px;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:thin}.xhworkspace-tab{display:flex;align-items:center;flex:none;max-width:180px;min-width:90px;height:35px;border-radius:7px 7px 0 0;color:var(--dsw-alias-label-tertiary)}.xhworkspace-tab[data-active]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.xhworkspace-tab>button[role=tab]{display:flex;align-items:center;gap:6px;min-width:0;flex:1;padding:0 8px;border:0;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}.xhworkspace-kind{flex:none}.xhworkspace-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhworkspace-tab-close,.xhworkspace-new{flex:none;width:25px;height:25px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}.xhworkspace-tab-close:hover,.xhworkspace-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhworkspace-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item{flex:1;min-height:0;min-width:0;overflow:hidden}.xhworkspace-item[hidden]{display:none}.xhworkspace-tool>div>div:first-child{display:none}._84hhiq_frame[data-xhworkspace-drawer] ._84hhiq_detailsCol{position:absolute;right:0;top:0;bottom:0;width:min(560px,calc(100% - 44px));z-index:25;box-shadow:-14px 0 40px #0004}._84hhiq_workspaceScrim{position:absolute;inset:0;z-index:24;border:0;background:#0008}';
  once('._84hhiq_overlayLayer>*{pointer-events:auto}', '._84hhiq_overlayLayer>*{pointer-events:auto}' + css)
  once('"sidebarCol": "_84hhiq_sidebarCol"', '"sidebarCol": "_84hhiq_sidebarCol",\n\t\t\t"workspaceScrim": "_84hhiq_workspaceScrim"')
  once('const [viewport, setViewport] = (0, react.useState)(() => window.innerWidth);',
    'const [viewport, setViewport] = (0, react.useState)(() => window.innerWidth);\n'
    + '\t\t\tconst spaceKey = useSessions(s => s.current ?? "__global__");\n'
    + '\t\t\tconst spaceKeyRef = (0, react.useRef)(spaceKey); spaceKeyRef.current = spaceKey;\n'
    + '\t\t\tconst [spaces, setSpaces] = (0, react.useState)(xhLoadBrowserSpaces);\n'
    + '\t\t\tconst [browserRestored, setBrowserRestored] = (0, react.useState)(!window.__TAURI__?.core?.invoke);\n'
    + '\t\t\tconst space = spaces[spaceKey] ?? xhWorkspaceEmpty;\n'
    + '\t\t\tconst nextWorkspaceId = (0, react.useRef)(xhNextWorkspaceId(spaces));\n'
    + '\t\t\t(0, react.useEffect)(() => { if (browserRestored) xhSaveBrowserSpaces(spaces); nextWorkspaceId.current = Math.max(nextWorkspaceId.current, xhNextWorkspaceId(spaces)); }, [spaces, browserRestored]);\n'
    + '\t\t\t(0, react.useEffect)(() => { if (!window.__TAURI__?.core?.invoke) return; let alive = true; window.__TAURI__.core.invoke("desktop_browser_restore").then(snapshot => { if (alive && snapshot) setSpaces(xhLoadBrowserSpaces(snapshot)); }).catch(() => {}).finally(() => { if (alive) setBrowserRestored(true); }); return () => { alive = false; }; }, []);\n'
    + '\t\t\tconst [workspaceWidth, setWorkspaceWidth] = (0, react.useState)(440);\n'
    + '\t\t\tconst updateSpace = fn => setSpaces(all => { const key = spaceKeyRef.current; return { ...all, [key]: fn(all[key] ?? xhWorkspaceEmpty) }; });\n'
    + '\t\t\tconst openWorkspace = (kind, fresh = false, detail = {}) => {\n'
    + '\t\t\t\tconst id = kind === "tool" ? "tool" : `${kind}:${++nextWorkspaceId.current}`;\n'
    + '\t\t\t\tconst source = kind === "file" ? detail.source : kind;\n'
    + '\t\t\t\tconst item = { id, kind, source, sessionId: detail.sessionId, title: kind === "tool" ? "工具详情" : kind === "file" ? (detail.title || source.split(/[\\\\/]/).pop()) : "新标签页", entries: detail.url ? [detail.url] : [], position: detail.url ? 0 : -1 };\n'
    + '\t\t\t\tupdateSpace(value => xhWorkspaceOpen(value, item, !fresh));\n'
    + '\t\t\t};\n'
    + '\t\t\tconst closeWorkspace = id => { if (id === "tool") actions.closeDetails(); if (space.items.some(item => item.id === id && item.kind === "browser")) window.dispatchEvent(new CustomEvent("xharness:browser-close", { detail: { id } })); updateSpace(value => xhWorkspaceClose(value, id)); };\n'
    + '\t\t\t(0, react.useEffect)(() => {\n'
    + '\t\t\t\tconst onOpen = event => { const detail = event.detail; if (detail?.kind === "browser" || detail?.kind === "tool" || (detail?.kind === "file" && typeof detail.source === "string" && detail.source.length > 0)) openWorkspace(detail.kind, detail.fresh === true, detail); };\n'
    + '\t\t\t\tconst onCloseTool = () => updateSpace(value => xhWorkspaceClose(value, "tool"));\n'
    + '\t\t\t\twindow.addEventListener("xharness:workspace-open", onOpen);\n'
    + '\t\t\t\twindow.addEventListener("xharness:workspace-close-tool", onCloseTool);\n'
    + '\t\t\t\treturn () => { window.removeEventListener("xharness:workspace-open", onOpen); window.removeEventListener("xharness:workspace-close-tool", onCloseTool); };\n'
    + '\t\t\t}, []);\n'
    + '\t\t\t(0, react.useEffect)(() => { setSpaces(all => { let changed = false; const next = { ...all }; for (const key of Object.keys(next)) if (key !== spaceKey && next[key].items.some(item => item.kind === "tool")) { next[key] = xhWorkspaceClose(next[key], "tool"); changed = true; } return changed ? next : all; }); }, [spaceKey]);\n'
    + '\t\t\t(0, react.useEffect)(() => { void xhWorkspaceWindow.set(space.items.length > 0, 440); }, [space.items.length > 0]);\n'
    + '\t\t\t(0, react.useEffect)(() => () => { void xhWorkspaceWindow.set(false); }, []);')
  once('const cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, detailsSession === void 0 ? 0 : panels.details);',
    'const sidebarWidth = sidebarCollapsed ? 56 : panels.sidebar === 0 ? 280 : clampWidth(panels.sidebar, 264, 420);\n'
    + '\t\t\tconst workspaceOpen = space.items.length > 0;\n'
    + '\t\t\tconst workspaceAvailable = viewport - sidebarWidth - 480;\n'
    + '\t\t\tconst workspaceDrawer = workspaceOpen && workspaceAvailable < 360;\n'
    + '\t\t\tconst workspaceDockWidth = workspaceOpen && !workspaceDrawer ? Math.min(workspaceWidth, workspaceAvailable) : 0;\n'
    + '\t\t\tconst cols = computeColumns(viewport - workspaceDockWidth, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, 0, workspaceDockWidth > 0 ? 480 : 640);')
  once('const detailsBase = (0, react.useRef)(0);', 'const detailsBase = (0, react.useRef)(0);\n\t\t\tconst workspaceBase = (0, react.useRef)(0);')
  once('const onDetailsDrag = (0, react.useCallback)((dx) => {\n\t\t\t\tactions.setDetails(detailsBase.current - dx);\n\t\t\t}, [actions]);',
    'const onDetailsDrag = (0, react.useCallback)((dx) => {\n\t\t\t\tactions.setDetails(detailsBase.current - dx);\n\t\t\t}, [actions]);\n'
    + '\t\t\tconst onWorkspaceStart = () => { workspaceBase.current = workspaceDockWidth; setDragging(true); };\n'
    + '\t\t\tconst onWorkspaceDrag = dx => { if (dx < 0) setWorkspaceWidth(Math.max(workspaceBase.current, Math.min(900, workspaceAvailable, workspaceBase.current - dx))); };')
  once('style: { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` },',
    'style: { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${workspaceDockWidth}px` },\n'
    + '\t\t\t\t"data-xhworkspace-open": workspaceOpen || void 0,\n'
    + '\t\t\t\t"data-xhworkspace-drawer": workspaceDrawer || void 0,')
  once('"data-details-collapsed": cols.details === 0 || void 0,', '"data-details-collapsed": !workspaceOpen || void 0,')
  once('(0, react_jsx_runtime.jsx)(DetailsColumn, { children: renderSlot("details", {}) })',
    'workspaceDrawer && (0, react_jsx_runtime.jsx)("button", { type: "button", className: AppFrame_module_css_default.workspaceScrim, "aria-label": "关闭工作区", onClick: () => closeWorkspace(space.activeId) }),\n'
    + '\t\t\t\t\t(0, react_jsx_runtime.jsx)(DetailsColumn, { children: (0, react_jsx_runtime.jsx)(XhWorkspacePane, { space, sessionId: spaceKey === "__global__" ? null : spaceKey, renderSlot, onSelect: id => updateSpace(value => ({ ...value, activeId: id })), onClose: closeWorkspace, onUpdate: (id, patch) => updateSpace(value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) })), onNewBrowser: () => openWorkspace("browser", true) }) })')
  once('cols.details > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {\n\t\t\t\t\t\tside: "details",\n\t\t\t\t\t\tleft: viewport - cols.details,\n\t\t\t\t\t\tonStart: onDetailsStart,\n\t\t\t\t\t\tonDrag: onDetailsDrag,',
    'workspaceDockWidth > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {\n\t\t\t\t\t\tside: "details",\n\t\t\t\t\t\tleft: viewport - workspaceDockWidth,\n\t\t\t\t\t\tonStart: onWorkspaceStart,\n\t\t\t\t\t\tonDrag: onWorkspaceDrag,')
  once('this.#require().openDetails();', 'this.#require().openDetails();\n\t\t\t\twindow.dispatchEvent(new CustomEvent("xharness:workspace-open", { detail: { kind: "tool" } }));')
  once('this.#require().closeDetails();', 'this.#require().closeDetails();\n\t\t\t\twindow.dispatchEvent(new Event("xharness:workspace-close-tool"));')
  once('"shell.overlay": {\n\t\t\t\t\t\t\tkind: "list",\n\t\t\t\t\t\t\tscope: "root"\n\t\t\t\t\t\t}',
    '"shell.overlay": {\n\t\t\t\t\t\t\tkind: "list",\n\t\t\t\t\t\t\tscope: "root"\n\t\t\t\t\t\t},\n'
    + '\t\t\t\t\t\t"workspace.item": { kind: "list", scope: "root" }')
  return Buffer.from(source)
}
