// Generated from src/modules/sidebar/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-sidebar",
factory: (__externalRequire) => {
const __units = {
"src/modules/sidebar/index.js": function(module, exports, require) {
// source: src/modules/sidebar/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const SidebarRoot_1 = require("./SidebarRoot");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin (shell controls copy). */
const NS = 'sidebar';
/** Services required by the sidebar plugin. */
exports.inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale'];
/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-sidebar: dictionaries');
    const injectProps = () => ({
        // The shell's New Session button rides the runtime's shared action
        // (current Session Workspace, then recent Workspace).
        startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId); },
        toggleSidebar: () => { ctx.layout.toggleSidebar(); },
    });
    ctx.effect(() => ctx.slots.register({
        name: 'sidebar',
        locale: NS,
        // The shell owns geometry; ui-workspace registers the whole browsing
        // region (header, search, session list, workspace dialogs), ui-settings
        // registers the foot trigger + settings panel.
        children: {
            'sidebar.brand.mark': { kind: 'single', scope: 'root' },
            'sidebar.brand.name': { kind: 'single', scope: 'root' },
            'sidebar.workspaces': { kind: 'single', scope: 'root' },
            'sidebar.settings': { kind: 'single', scope: 'root' },
            'sidebar.footer.action': { kind: 'list', scope: 'root' },
            'sidebar.primary.action': { kind: 'list', scope: 'root' },
        },
        inject: injectProps,
    }, SidebarRoot_1.SidebarRoot), 'ui-sidebar: slot registration');
}

},
"src/modules/sidebar/SidebarRoot.js": function(module, exports, require) {
// source: src/modules/sidebar/SidebarRoot.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidebarRoot = SidebarRoot;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Sidebar shell: column geometry only. Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the four upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * the New Session button and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
const react_1 = require("react");
const views_types_1 = require("../views-types");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const SidebarRoot_styles_1 = __importDefault(require("./SidebarRoot.styles"));
/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150;
/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000;
/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
function SidebarRoot({ collapsed, width, startSession, toggleSidebar, t, renderSlot, }) {
    // Wide content stays mounted while the collapse animates (fading via
    // .collapsed .wide), unmounts at settle, and remounts right away on expand.
    const [settled, setSettled] = (0, react_1.useState)(collapsed);
    (0, react_1.useEffect)(() => {
        if (!collapsed) {
            setSettled(false);
            return;
        }
        const timer = window.setTimeout(() => { setSettled(true); }, COLLAPSE_SETTLE_MS);
        return () => { window.clearTimeout(timer); };
    }, [collapsed]);
    const wide = !collapsed || !settled;
    // Freeze the content at its expanded width while it fades out (collapsed
    // && wide): the sliding column then clips it instead of reflowing it. The
    // rail layout (.collapsed styles) only applies once the fade settles.
    const lastWideWidth = (0, react_1.useRef)(width);
    if (!collapsed)
        lastWideWidth.current = width;
    // Rail-in only crossfades a live collapse: a refresh straight into the
    // collapsed state renders the rail statically (no delay-hidden icons).
    const everWide = (0, react_1.useRef)(!collapsed);
    if (!collapsed)
        everWide.current = true;
    // Scrollbars in the column follow the pointer (.quietBars rebinds them
    // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
    // leaves. A pointer that returns within that window cancels the pending
    // hide rather than restarting from a hidden bar.
    const column = (0, react_1.useRef)(null);
    const [pointerInside, setPointerInside] = (0, react_1.useState)(false);
    const lingerTimer = (0, react_1.useRef)(undefined);
    const armLinger = () => {
        if (lingerTimer.current !== undefined)
            return;
        lingerTimer.current = window.setTimeout(() => {
            lingerTimer.current = undefined;
            setPointerInside(false);
        }, SCROLLBAR_LINGER_MS);
    };
    const cancelLinger = () => {
        window.clearTimeout(lingerTimer.current);
        lingerTimer.current = undefined;
    };
    // Leaving is decided by the column's BOX, not by DOM containment, and only
    // while the bars are drawn. ui-settings renders its full-viewport panel as a
    // fixed-position DESCENDANT of this column, so a pointer moved onto that
    // panel — or onto the conversation once it closes — fires no `pointerleave`
    // here, and the bars would stay drawn over a column nobody is pointing at.
    // The element's own leave stays as the one signal geometry cannot give: a
    // pointer that leaves the window emits no further moves.
    (0, react_1.useEffect)(() => {
        if (!pointerInside)
            return;
        const onMove = (event) => {
            const rect = column.current?.getBoundingClientRect();
            /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
            if (rect === undefined)
                return;
            const inside = event.clientX >= rect.left && event.clientX < rect.right
                && event.clientY >= rect.top && event.clientY < rect.bottom;
            if (inside)
                cancelLinger();
            else
                armLinger();
        };
        document.addEventListener('pointermove', onMove);
        return () => {
            document.removeEventListener('pointermove', onMove);
            cancelLinger();
        };
    }, [pointerInside]);
    return ((0, jsx_runtime_1.jsxs)("div", { ref: column, className: (0, views_types_1.classNames)(SidebarRoot_styles_1.default.root, !wide && SidebarRoot_styles_1.default.collapsed, !wide && everWide.current && SidebarRoot_styles_1.default.railIn, collapsed && wide && SidebarRoot_styles_1.default.fading, !pointerInside && SidebarRoot_styles_1.default.quietBars), style: wide ? { width: collapsed ? lastWideWidth.current : width } : undefined, onPointerEnter: () => {
            cancelLinger();
            setPointerInside(true);
        }, onPointerLeave: () => { armLinger(); }, children: [(0, jsx_runtime_1.jsxs)("div", { className: SidebarRoot_styles_1.default.logoRow, children: [wide && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: (0, views_types_1.classNames)(SidebarRoot_styles_1.default.brand, SidebarRoot_styles_1.default.wide), "aria-label": t('session.new.label'), onClick: () => { startSession(); }, children: (0, jsx_runtime_1.jsxs)("span", { className: SidebarRoot_styles_1.default.brandIdentity, "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("span", { className: SidebarRoot_styles_1.default.brandMark, children: renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.FishLogo, { size: 24 }) }) }), (0, jsx_runtime_1.jsx)("span", { className: SidebarRoot_styles_1.default.brandName, children: renderSlot('sidebar.brand.name', {}, {
                                        fallback: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: SidebarRoot_styles_1.default.fallbackBrandName, children: "XHarness" }), (0, jsx_runtime_1.jsx)("span", { className: SidebarRoot_styles_1.default.buildRevision, children: "141eb6f" })] })),
                                    }) })] }) })), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: collapsed ? t('toggle.open') : t('toggle.collapse'), delayMs: 500, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: (0, views_types_1.classNames)(SidebarRoot_styles_1.default.iconButton, SidebarRoot_styles_1.default.toggle), "aria-label": collapsed ? t('toggle.open') : t('toggle.collapse'), "data-sidebar-toggle": true, onClick: () => { toggleSidebar(); }, children: [!wide && ((0, jsx_runtime_1.jsx)("span", { className: SidebarRoot_styles_1.default.railMark, "aria-hidden": "true", children: renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.FishLogo, { size: 24 }) }) })), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { className: SidebarRoot_styles_1.default.panelIcon, size: wide ? 16 : 18 })] }) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhsidebar-primary-actions", "data-wide": wide, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('session.new.label'), delayMs: 500, disabled: wide, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: SidebarRoot_styles_1.default.newSession, "aria-label": t('session.new.label'), onClick: () => { startSession(); }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconNewChatOutline16, { size: wide ? 16 : 18 }), wide && (0, jsx_runtime_1.jsx)("span", { className: (0, views_types_1.classNames)(SidebarRoot_styles_1.default.newSessionLabel, SidebarRoot_styles_1.default.wide), children: t('session.new') })] }) }), renderSlot('sidebar.primary.action', { wide })] }), (0, jsx_runtime_1.jsx)("div", { className: SidebarRoot_styles_1.default.regionArea, children: renderSlot('sidebar.workspaces', {
                    wide,
                    expandSidebar: () => { if (collapsed)
                        toggleSidebar(); },
                }) }), (0, jsx_runtime_1.jsxs)("div", { className: SidebarRoot_styles_1.default.footArea, children: [(0, jsx_runtime_1.jsx)("div", { id: "xharness-sidebar-updater-slot", hidden: true }), (0, jsx_runtime_1.jsx)("div", { className: SidebarRoot_styles_1.default.footerActions, children: renderSlot('sidebar.footer.action', { wide }) }), (0, jsx_runtime_1.jsx)("div", { className: SidebarRoot_styles_1.default.settingsArea, children: renderSlot('sidebar.settings', { wide }) })] })] }));
}

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
"src/modules/sidebar/SidebarRoot.styles.js": function(module, exports, require) {
// source: src/modules/sidebar/SidebarRoot.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SidebarRoot_css_1 = __importDefault(require("./SidebarRoot.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-sidebar/SidebarRoot.module.css", "@xharness/dsh-client-ui-sidebar", SidebarRoot_css_1.default);
const styles = {
    "brand": "U910La_brand",
    "brandIdentity": "U910La_brandIdentity",
    "brandMark": "U910La_brandMark",
    "brandName": "U910La_brandName",
    "buildRevision": "U910La_buildRevision",
    "collapsed": "U910La_collapsed",
    "fading": "U910La_fading",
    "fallbackBrandName": "U910La_fallbackBrandName",
    "footArea": "U910La_footArea",
    "footerActions": "U910La_footerActions",
    "iconButton": "U910La_iconButton",
    "logoRow": "U910La_logoRow",
    "newSession": "U910La_newSession",
    "newSessionLabel": "U910La_newSessionLabel",
    "panelIcon": "U910La_panelIcon",
    "quietBars": "U910La_quietBars",
    "rail-fade-in": "U910La_rail-fade-in",
    "rail-in": "U910La_rail-in",
    "railIn": "U910La_railIn",
    "railMark": "U910La_railMark",
    "regionArea": "U910La_regionArea",
    "root": "U910La_root",
    "settingsArea": "U910La_settingsArea",
    "toggle": "U910La_toggle",
    "wide": "U910La_wide",
    "wide-in": "U910La_wide-in"
};
exports.default = styles;

},
"src/modules/sidebar/SidebarRoot.css": function(module, exports, require) {
// source: src/modules/sidebar/SidebarRoot.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".U910La_root{--dsh-sidebar-inline-padding:12px;height:100%;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;font-size:14px;display:flex}.U910La_root.U910La_collapsed{padding:18px 10px 6px}.U910La_root.U910La_quietBars{--dsh-scrollbar-thumb:transparent;--dsh-scrollbar-thumb-hover:transparent}.U910La_fading>*{opacity:0;transition:opacity .15s var(--ds-ease-in-out)}.U910La_wide{animation:U910La_wide-in .2s var(--ds-ease-in-out)}@keyframes U910La_wide-in{0%{opacity:0}}.U910La_railIn .U910La_iconButton,.U910La_railIn .U910La_newSession,.U910La_railIn .U910La_regionArea{animation:U910La_rail-in .15s var(--ds-ease-in-out) backwards}.U910La_railIn .U910La_footArea{animation:U910La_rail-fade-in .15s var(--ds-ease-in-out) backwards}@keyframes U910La_rail-in{0%{opacity:0;transform:translate(49px)}}@keyframes U910La_rail-fade-in{0%{opacity:0}}.U910La_logoRow{box-sizing:border-box;flex:none;justify-content:flex-end;align-items:center;gap:8px;height:60px;margin-bottom:8px;padding:8px 0 8px 4px;display:flex;overflow:hidden}.U910La_collapsed .U910La_logoRow{justify-content:flex-start;height:36px;margin-bottom:12px;padding:0}.U910La_brand{min-width:0;color:inherit;cursor:pointer;background:0 0;border:none;flex:1;align-items:center;padding:0;display:inline-flex;overflow:hidden}.U910La_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}.U910La_brandMark{flex:none;justify-content:center;align-items:center;display:inline-flex}.U910La_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}.U910La_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}.U910La_iconButton{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.U910La_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.U910La_collapsed .U910La_iconButton{width:36px;height:36px}.U910La_collapsed .U910La_toggle .U910La_panelIcon{display:none}.U910La_collapsed .U910La_toggle:hover .U910La_panelIcon{display:inline}.U910La_collapsed .U910La_toggle:hover .U910La_railMark{display:none}.U910La_railMark{justify-content:center;align-items:center;display:inline-flex}.U910La_collapsed .U910La_iconButton{color:var(--dsw-alias-label-primary)}.U910La_buildRevision{height:16px;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);border-radius:3px;align-items:center;padding:0 4px;font-size:8px;font-weight:500;line-height:16px;display:inline-flex}.U910La_newSession{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);height:38px;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:12px;flex:none;justify-content:center;align-items:center;gap:6px;margin:0 2px 8px;padding:8px 16px;font-size:14px;font-weight:500;line-height:22px;display:flex;overflow:hidden}.U910La_newSession:hover{background:var(--dsw-alias-button-floating-hover)}.U910La_collapsed .U910La_newSession{background:0 0;border-color:#0000;align-self:flex-start;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.U910La_collapsed .U910La_newSession:hover{background:var(--dsw-alias-interactive-bg-hover)}.U910La_newSessionLabel{white-space:nowrap;max-width:200px;overflow:hidden}.U910La_collapsed .U910La_newSessionLabel{max-width:0}.U910La_regionArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-sidebar-inline-padding));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:hidden}.U910La_collapsed .U910La_regionArea{margin-left:0;margin-right:0;padding-left:0}.U910La_footArea{flex-direction:column;flex:none;display:flex}.U910La_settingsArea,.U910La_footerActions{flex:none;width:100%;min-width:0}.U910La_footerActions{display:flex}.U910La_collapsed .U910La_footArea{align-items:center}.U910La_collapsed .U910La_settingsArea,.U910La_collapsed .U910La_footerActions{justify-content:center;width:auto;display:flex}@media (prefers-reduced-motion:reduce){.U910La_wide,.U910La_fading>*,.U910La_railIn .U910La_iconButton,.U910La_railIn .U910La_newSession,.U910La_railIn .U910La_footArea,.U910La_railIn .U910La_regionArea{transition:none;animation:none}}\n\n/* The shell owns peer-action geometry; feature slots retain their own behavior. */\n.xhsidebar-primary-actions{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:8px;flex:none;margin:0 2px 8px;min-width:0}\n.xhsidebar-primary-actions[data-wide=true] .U910La_newSession{min-width:0;width:100%;height:38px;margin:0;padding:7px 12px;justify-content:flex-start;gap:8px;background:none;border:0;box-shadow:none}\n.xhsidebar-primary-actions[data-wide=true] .U910La_newSessionLabel{max-width:none}\n.xhsidebar-primary-actions[data-wide=false]{display:flex;flex-direction:column;align-items:center;width:36px;gap:12px;margin:0 0 12px}\n.xhsidebar-primary-actions[data-wide=false] .U910La_newSession{width:36px;height:36px;margin:0;padding:0}\n\n.xhsidebar-primary-actions[data-wide=true] .U910La_newSession:hover{background:var(--dsw-alias-interactive-bg-hover)}\n";

},
"src/modules/sidebar/locales.js": function(module, exports, require) {
// source: src/modules/sidebar/locales.ts

"use strict";
/** `sidebar` namespace dictionaries: shell controls (brand row, New Session, fold toggle). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'session.new': '新会话',
    'session.new.label': '新建会话',
    'toggle.open': '打开侧边栏',
    'toggle.collapse': '收起侧边栏',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'session.new': 'New Session',
    'session.new.label': 'New session',
    'toggle.open': 'Open sidebar',
    'toggle.collapse': 'Collapse sidebar',
};

}
};
const __dependencies = {"src/modules/sidebar/index.js":{"./SidebarRoot":"src/modules/sidebar/SidebarRoot.js","./locales":"src/modules/sidebar/locales.js"},"src/modules/sidebar/SidebarRoot.js":{"../views-types":"src/modules/views-types.js","./SidebarRoot.styles":"src/modules/sidebar/SidebarRoot.styles.js"},"src/modules/views-types.js":{},"src/modules/sidebar/SidebarRoot.styles.js":{"./SidebarRoot.css":"src/modules/sidebar/SidebarRoot.css","../views-types":"src/modules/views-types.js"},"src/modules/sidebar/SidebarRoot.css":{},"src/modules/sidebar/locales.js":{}};
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
return __load("src/modules/sidebar/index.js");
}
});
