// Generated from src/modules/settings-plugin-inventory/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-settings-plugin-inventory",
factory: (__externalRequire) => {
const __units = {
"src/modules/settings-plugin-inventory/index.js": function(module, exports, require) {
// source: src/modules/settings-plugin-inventory/index.ts

"use strict";
/// <reference path="./externals.d.ts" />
/** Read-only Host plugin inventory registered into Web Settings. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.NS = void 0;
exports.apply = apply;
const PluginInventorySettingsTab_1 = require("./PluginInventorySettingsTab");
const locales_1 = require("./locales");
/** Dictionary namespace owned by this plugin. */
exports.NS = 'settings.pluginInventory';
/** Services required by the Settings registration and generated Remote face. */
exports.inject = ['slots', 'locale', 'remote', 'remote.pluginInventory'];
/** Contribute the lazy inventory tab to the Plugins settings section. */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(exports.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-settings-plugin-inventory: dictionaries');
    const t = ctx.locale.bind(exports.NS);
    const list = async () => {
        const result = await ctx.remote.pluginInventory.list();
        if (!result.ok) {
            throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
        }
        return result.value;
    };
    const injected = () => ({ list });
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'all',
        order: 10,
        label: () => t('tab'),
        locale: exports.NS,
        inject: injected,
    }, PluginInventorySettingsTab_1.PluginInventorySettingsTab));
}

},
"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.js": function(module, exports, require) {
// source: src/modules/settings-plugin-inventory/PluginInventorySettingsTab.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginInventorySettingsTab = PluginInventorySettingsTab;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const PluginInventorySettingsTab_styles_1 = __importDefault(require("./PluginInventorySettingsTab.styles"));
const PHASE_KEYS = {
    pending: 'pending',
    loading: 'loadingPhase',
    active: 'active',
    failed: 'failed',
    unloading: 'unloading',
};
/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase, t) {
    return phase === null ? t('unobserved') : t(PHASE_KEYS[phase]);
}
/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName) {
    const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName;
    return unscoped
        .replace(/^cordis:/, '')
        .replace(/^cordis-plugin-/, '')
        .replace(/^dsh-(?:host-|client-)?/, '');
}
/** Whether an inventory row matches the local catalog query. */
function matches(entry, normalizedQuery) {
    if (normalizedQuery.length === 0)
        return true;
    return [entry.moduleName, entry.entryId]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery));
}
/** Render the read-only current Loader inventory. */
function PluginInventorySettingsTab({ list, t }) {
    const catalogId = (0, react_1.useId)();
    const [request, setRequest] = (0, react_1.useState)(0);
    const [query, setQuery] = (0, react_1.useState)('');
    const [expanded, setExpanded] = (0, react_1.useState)(null);
    const [state, setState] = (0, react_1.useState)({ status: 'loading' });
    (0, react_1.useEffect)(() => {
        let current = true;
        void Promise.resolve().then(() => list()).then((snapshot) => { if (current)
            setState({ status: 'ready', snapshot }); }, () => { if (current)
            setState({ status: 'error' }); });
        return () => { current = false; };
    }, [list, request]);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredEntries = (0, react_1.useMemo)(() => state.status === 'ready'
        ? state.snapshot.entries.filter(entry => matches(entry, normalizedQuery))
        : [], [normalizedQuery, state]);
    (0, react_1.useEffect)(() => {
        if (expanded !== null && !filteredEntries.some(entry => entry.entryId === expanded)) {
            setExpanded(null);
        }
    }, [expanded, filteredEntries]);
    const retry = () => {
        setState({ status: 'loading' });
        setRequest(value => value + 1);
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: PluginInventorySettingsTab_styles_1.default.section, "aria-busy": state.status === 'loading', children: [state.status === 'loading' ? (0, jsx_runtime_1.jsx)("p", { className: PluginInventorySettingsTab_styles_1.default.status, children: t('loading') }) : null, state.status === 'error' ? ((0, jsx_runtime_1.jsxs)("div", { className: PluginInventorySettingsTab_styles_1.default.failure, children: [(0, jsx_runtime_1.jsx)("p", { role: "alert", children: t('error') }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: retry, children: t('retry') })] })) : null, state.status === 'ready' ? ((0, jsx_runtime_1.jsxs)("div", { className: PluginInventorySettingsTab_styles_1.default.catalog, children: [(0, jsx_runtime_1.jsxs)("label", { className: PluginInventorySettingsTab_styles_1.default.search, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSearchOutline16, { "aria-hidden": "true" }), (0, jsx_runtime_1.jsx)("span", { className: PluginInventorySettingsTab_styles_1.default.visuallyHidden, children: t('search') }), (0, jsx_runtime_1.jsx)("input", { type: "search", value: query, placeholder: t('search'), "aria-label": t('search'), onChange: (event) => { setQuery(event.currentTarget.value); } })] }), (0, jsx_runtime_1.jsxs)("div", { className: PluginInventorySettingsTab_styles_1.default.catalogHeading, children: [(0, jsx_runtime_1.jsx)("h3", { children: t('catalog') }), (0, jsx_runtime_1.jsx)("span", { "data-plugin-count": filteredEntries.length, children: filteredEntries.length })] }), state.snapshot.entries.length === 0 ? (0, jsx_runtime_1.jsx)("p", { className: PluginInventorySettingsTab_styles_1.default.status, children: t('empty') }) : null, state.snapshot.entries.length > 0 && filteredEntries.length === 0
                        ? (0, jsx_runtime_1.jsx)("p", { className: PluginInventorySettingsTab_styles_1.default.status, children: t('emptySearch') })
                        : null, filteredEntries.length > 0 ? ((0, jsx_runtime_1.jsx)("ul", { className: PluginInventorySettingsTab_styles_1.default.cards, children: filteredEntries.map((entry) => {
                            const status = phaseLabel(entry.fiberPhase, t);
                            const title = moduleShortName(entry.moduleName);
                            const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag');
                            const open = expanded === entry.entryId;
                            const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`;
                            return ((0, jsx_runtime_1.jsxs)("li", { className: PluginInventorySettingsTab_styles_1.default.card, "data-plugin-entry": entry.entryId, "data-open": open ? 'true' : undefined, children: [(0, jsx_runtime_1.jsxs)("button", { className: PluginInventorySettingsTab_styles_1.default.cardContent, type: "button", "aria-expanded": open, "aria-controls": detailId, "aria-label": entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`, onClick: () => {
                                            setExpanded(current => current === entry.entryId ? null : entry.entryId);
                                        }, children: [(0, jsx_runtime_1.jsx)("strong", { className: PluginInventorySettingsTab_styles_1.default.cardTitle, title: entry.moduleName, children: title }), (0, jsx_runtime_1.jsxs)("span", { className: PluginInventorySettingsTab_styles_1.default.cardTrailing, children: [entry.enabled ? ((0, jsx_runtime_1.jsx)("span", { className: PluginInventorySettingsTab_styles_1.default.statusDot, "data-phase": entry.fiberPhase ?? 'unobserved', role: "img", "aria-label": status, title: status })) : null, (0, jsx_runtime_1.jsx)("span", { className: PluginInventorySettingsTab_styles_1.default.configTag, "data-enabled": entry.enabled ? 'true' : 'false', children: configuration }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: PluginInventorySettingsTab_styles_1.default.chevron, size: 12, "aria-hidden": "true" })] })] }), open ? ((0, jsx_runtime_1.jsxs)("div", { className: PluginInventorySettingsTab_styles_1.default.cardDetails, id: detailId, children: [(0, jsx_runtime_1.jsx)("code", { className: PluginInventorySettingsTab_styles_1.default.entryValue, "data-loader-entry": true, children: entry.entryId }), (0, jsx_runtime_1.jsxs)("dl", { className: PluginInventorySettingsTab_styles_1.default.details, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: t('configuration') }), (0, jsx_runtime_1.jsx)("dd", { children: configuration })] }), entry.enabled ? ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: t('cordis') }), (0, jsx_runtime_1.jsx)("dd", { children: status })] })) : null] })] })) : null] }, entry.entryId));
                        }) })) : null] })) : null] }));
}

},
"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.styles.js": function(module, exports, require) {
// source: src/modules/settings-plugin-inventory/PluginInventorySettingsTab.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const PluginInventorySettingsTab_css_1 = __importDefault(require("./PluginInventorySettingsTab.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-settings-plugin-inventory/PluginInventorySettingsTab.module.css", "@xharness/dsh-client-ui-settings-plugin-inventory", PluginInventorySettingsTab_css_1.default);
const styles = {
    "card": "HJnQtG_card",
    "cardContent": "HJnQtG_cardContent",
    "cardDetails": "HJnQtG_cardDetails",
    "cardTitle": "HJnQtG_cardTitle",
    "cardTrailing": "HJnQtG_cardTrailing",
    "cards": "HJnQtG_cards",
    "catalog": "HJnQtG_catalog",
    "catalogHeading": "HJnQtG_catalogHeading",
    "chevron": "HJnQtG_chevron",
    "configTag": "HJnQtG_configTag",
    "details": "HJnQtG_details",
    "entryValue": "HJnQtG_entryValue",
    "failure": "HJnQtG_failure",
    "search": "HJnQtG_search",
    "section": "HJnQtG_section",
    "status": "HJnQtG_status",
    "statusDot": "HJnQtG_statusDot",
    "visuallyHidden": "HJnQtG_visuallyHidden"
};
exports.default = styles;

},
"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.css": function(module, exports, require) {
// source: src/modules/settings-plugin-inventory/PluginInventorySettingsTab.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".HJnQtG_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}.HJnQtG_catalogHeading h3,.HJnQtG_status,.HJnQtG_failure p{margin:0}.HJnQtG_status,.HJnQtG_failure{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.HJnQtG_failure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:10px;display:flex}.HJnQtG_failure button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px}.HJnQtG_catalog{flex-direction:column;gap:12px;display:flex}.HJnQtG_search{width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}.HJnQtG_search>svg{pointer-events:none;position:absolute;left:12px}.HJnQtG_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 34px 0 36px;font-size:13px}.HJnQtG_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.HJnQtG_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}.HJnQtG_catalogHeading{align-items:baseline;gap:7px;padding:0 2px;display:flex}.HJnQtG_catalogHeading h3{font-size:13px;font-weight:600;line-height:20px}.HJnQtG_catalogHeading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}.HJnQtG_cards{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;margin:0;padding:0;list-style:none;display:grid}.HJnQtG_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;overflow:hidden}.HJnQtG_card[data-open=true]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}.HJnQtG_cardContent{box-sizing:border-box;width:100%;min-height:52px;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;display:flex}.HJnQtG_cardContent:hover,.HJnQtG_card[data-open=true]>.HJnQtG_cardContent{background:var(--dsw-alias-interactive-bg-hover)}.HJnQtG_cardContent:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.HJnQtG_cardTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;font-weight:600;line-height:20px;overflow:hidden}.HJnQtG_cardTrailing{color:var(--dsw-alias-label-tertiary);flex:none;align-items:center;gap:7px;display:inline-flex}.HJnQtG_statusDot{background:var(--dsw-alias-label-tertiary);border-radius:999px;flex:none;width:7px;height:7px;display:inline-block}.HJnQtG_statusDot[data-phase=active]{background:var(--dsw-alias-state-success-primary)}.HJnQtG_statusDot[data-phase=failed]{background:var(--dsw-alias-state-error-primary)}.HJnQtG_statusDot[data-phase=loading]{background:var(--dsw-alias-state-business-primary)}.HJnQtG_configTag{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;align-items:center;padding:1px 6px;font-size:11px;line-height:16px;display:inline-flex}.HJnQtG_configTag[data-enabled=true]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}.HJnQtG_chevron{color:var(--dsw-alias-label-tertiary);flex:none}.HJnQtG_card[data-open=true] .HJnQtG_chevron{transform:rotate(180deg)}.HJnQtG_cardDetails{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);padding:10px 14px 12px}.HJnQtG_entryValue{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;display:block}.HJnQtG_details{grid-template-columns:76px minmax(0,1fr);gap:6px 10px;margin:8px 0 0;display:grid}.HJnQtG_details div{display:contents}.HJnQtG_details dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.HJnQtG_details dd{overflow-wrap:anywhere;min-width:0;color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:17px}.HJnQtG_visuallyHidden{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:no-preference){.HJnQtG_chevron{transition:transform .14s var(--ds-ease-in-out)}}@media (width<=680px){.HJnQtG_cards{grid-template-columns:minmax(0,1fr)}}";

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
"src/modules/settings-plugin-inventory/locales.js": function(module, exports, require) {
// source: src/modules/settings-plugin-inventory/locales.ts

"use strict";
/** Copy dictionaries for the plugin inventory Settings section. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary and key source of truth. */
exports.zh = {
    tab: '插件列表',
    loading: '正在读取插件…',
    error: '暂时无法读取插件。',
    retry: '重试',
    search: '搜索插件',
    catalog: '插件列表',
    empty: '暂无插件。',
    emptySearch: '没有匹配的插件。',
    enabledTag: '已启用',
    disabledTag: '已停用',
    configuration: '配置状态',
    cordis: 'Cordis 状态',
    unobserved: '未挂载',
    pending: '等待依赖',
    loadingPhase: '加载中',
    active: '已挂载',
    failed: '挂载失败',
    unloading: '卸载中',
};
/** English dictionary checked against the Chinese key set. */
exports.en = {
    tab: 'Plugin list',
    loading: 'Reading plugins…',
    error: 'Plugins are temporarily unavailable.',
    retry: 'Retry',
    search: 'Search plugins',
    catalog: 'Plugin list',
    empty: 'No plugins are available.',
    emptySearch: 'No matching plugins.',
    enabledTag: 'Enabled',
    disabledTag: 'Disabled',
    configuration: 'Configuration',
    cordis: 'Cordis status',
    unobserved: 'Not mounted',
    pending: 'Waiting for dependencies',
    loadingPhase: 'Loading',
    active: 'Mounted',
    failed: 'Mount failed',
    unloading: 'Unloading',
};

}
};
const __dependencies = {"src/modules/settings-plugin-inventory/index.js":{"./PluginInventorySettingsTab":"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.js","./locales":"src/modules/settings-plugin-inventory/locales.js"},"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.js":{"./PluginInventorySettingsTab.styles":"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.styles.js"},"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.styles.js":{"./PluginInventorySettingsTab.css":"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.css","../views-types":"src/modules/views-types.js"},"src/modules/settings-plugin-inventory/PluginInventorySettingsTab.css":{},"src/modules/views-types.js":{},"src/modules/settings-plugin-inventory/locales.js":{}};
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
return __load("src/modules/settings-plugin-inventory/index.js");
}
});
