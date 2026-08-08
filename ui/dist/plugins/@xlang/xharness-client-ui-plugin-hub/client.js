// Generated from src/modules/plugin-hub/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-plugin-hub",
factory: (__externalRequire) => {
const __units = {
"src/modules/plugin-hub/index.js": function(module, exports, require) {
// source: src/modules/plugin-hub/index.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/// <reference path="../shared/assets.d.ts" />
const PluginHub_css_1 = __importDefault(require("./PluginHub.css"));
const react_1 = require("react");
const xharness_client_plugin_api_1 = require("@xlang/xharness-client-plugin-api");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const NS = 'xharness.pluginHub';
const zh = {
    title: '插件', search: '搜索插件', installed: '已安装', public: '公开', personal: '个人',
    noInstalled: '还没有安装用户插件', noMatch: '没有匹配的插件', noCatalog: '尚未导入插件目录',
    noPersonal: '还没有个人插件', add: '添加目录', install: '安装', enable: '启用', disable: '停用',
    uninstall: '卸载', update: '更新', refresh: '刷新', working: '处理中…', unsupported: '当前支持 Skill 与本地 MCP',
    inspect: '来源和能力', source: '来源', digest: 'SHA-256', capabilities: '声明能力',
    skills: '技能', failed: '操作失败', imported: '目录已导入', confirmInstall: '确认安装此插件？将先校验 SHA-256，安装后默认停用。',
    confirmUninstall: '卸载此插件？', noSkills: '无可运行 Skill', allowMcp: '允许 MCP', stopMcp: '停用 MCP',
    confirmMcp: '允许此插件在本机启动以下 MCP 程序？只有调用时才启动。环境变量仅显示名称，不显示值。',
    cancel: '取消', close: '关闭',
};
const en = {
    title: 'Plugins', search: 'Search plugins', installed: 'Installed', public: 'Public', personal: 'Personal',
    noInstalled: 'No user plugins installed', noMatch: 'No matching plugins', noCatalog: 'No plugin catalog imported',
    noPersonal: 'No personal plugins yet', add: 'Import catalog', install: 'Install', enable: 'Enable', disable: 'Disable',
    uninstall: 'Uninstall', update: 'Update', refresh: 'Refresh', working: 'Working…', unsupported: 'Skills and local MCP are supported',
    inspect: 'Source and capabilities', source: 'Source', digest: 'SHA-256', capabilities: 'Declared capabilities',
    skills: 'Skills', failed: 'Operation failed', imported: 'Catalog imported', confirmInstall: 'Install this plugin? Its SHA-256 will be verified and it will remain disabled by default.',
    confirmUninstall: 'Uninstall this plugin?', noSkills: 'No runnable Skills', allowMcp: 'Allow MCP', stopMcp: 'Disable MCP',
    confirmMcp: 'Allow this plugin to launch these local MCP programs? They start only when called. Environment variable names are shown, not values.',
    cancel: 'Cancel', close: 'Close',
};
function PluginIcon() {
    return (0, react_1.createElement)('span', { className: 'xhph-symbol', 'aria-hidden': true }, (0, react_1.createElement)('svg', { width: 30, height: 30, viewBox: '0 0 16 16', fill: 'none' }, (0, react_1.createElement)('path', { d: 'M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z', transform: 'translate(0 -0.75) scale(1.2)', stroke: 'currentColor', strokeWidth: .9, strokeLinecap: 'round', strokeLinejoin: 'round' })));
}
function CatalogIcon({ name, icon }) {
    const [failedUrl, setFailedUrl] = (0, react_1.useState)(null);
    let url = null;
    if (icon && icon.length <= 4096) {
        try {
            const parsed = new URL(icon, window.location.href);
            if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password)
                url = parsed.href;
        }
        catch { /* Invalid metadata uses the same fallback as a missing icon. */ }
    }
    const showImage = url !== null && url !== failedUrl;
    return (0, react_1.createElement)('div', { className: `xhph-icon${showImage ? ' xhph-icon-artwork' : ''}`, 'aria-hidden': true }, showImage
        ? (0, react_1.createElement)('img', { src: url ?? undefined, alt: '', width: 42, height: 42, loading: 'lazy', decoding: 'async',
            referrerPolicy: 'no-referrer', onError: () => setFailedUrl(url) })
        : name.slice(0, 1).toUpperCase());
}
function PluginHub({ t, call }) {
    const [tab, setTab] = (0, react_1.useState)('public');
    const [query, setQuery] = (0, react_1.useState)('');
    const [catalog, setCatalog] = (0, react_1.useState)([]);
    const [installed, setInstalled] = (0, react_1.useState)([]);
    const [updates, setUpdates] = (0, react_1.useState)([]);
    const [busy, setBusy] = (0, react_1.useState)('');
    const [error, setError] = (0, react_1.useState)('');
    const [status, setStatus] = (0, react_1.useState)('');
    const [detail, setDetail] = (0, react_1.useState)(null);
    const [confirmation, setConfirmation] = (0, react_1.useState)(null);
    const pending = (0, react_1.useRef)(null);
    const life = (0, react_1.useRef)({ active: true, generation: 0, busy: false });
    const input = (0, react_1.useRef)(null);
    const current = (generation) => life.current.active && life.current.generation === generation;
    async function reload(generation = life.current.generation) {
        const [a, b, c] = await Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')]);
        if (current(generation)) {
            setCatalog(a.plugins ?? []);
            setInstalled(b.plugins ?? []);
            setUpdates(c.updates ?? []);
        }
    }
    (0, react_1.useEffect)(() => {
        life.current.active = true;
        life.current.busy = false;
        pending.current = null;
        setConfirmation(null);
        setBusy('');
        return () => { life.current.active = false; life.current.generation++; pending.current = null; };
    }, [call]);
    (0, react_1.useEffect)(() => {
        let active = true;
        Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')])
            .then(([a, b, c]) => { if (active) {
            setCatalog(a.plugins ?? []);
            setInstalled(b.plugins ?? []);
            setUpdates(c.updates ?? []);
        } })
            .catch((e) => { if (active)
            setError((0, xharness_client_plugin_api_1.errorMessage)(e)); });
        return () => { active = false; };
    }, [call]);
    async function run(key, action, reloadAfter = true) {
        if (!life.current.active || life.current.busy || pending.current)
            return;
        const generation = life.current.generation;
        life.current.busy = true;
        setBusy(key);
        setError('');
        setStatus('');
        try {
            const result = await action();
            if (current(generation) && reloadAfter)
                await reload(generation);
            return result;
        }
        catch (e) {
            if (current(generation))
                setError(`${t('failed')}: ${(0, xharness_client_plugin_api_1.errorMessage)(e)}`);
            return undefined;
        }
        finally {
            if (current(generation)) {
                life.current.busy = false;
                setBusy('');
            }
        }
    }
    function requestConfirmation(value) {
        if (!life.current.active || life.current.busy || pending.current)
            return;
        pending.current = value;
        setConfirmation(value);
    }
    function cancelConfirmation() { pending.current = null; setConfirmation(null); }
    function acceptConfirmation() {
        const value = pending.current;
        if (!value)
            return;
        // Consume the acknowledgement synchronously: rapid clicks cannot enqueue
        // a second mutation before React commits the disabled state.
        pending.current = null;
        setConfirmation(null);
        void run(value.key, value.action);
    }
    async function importFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file)
            return;
        if (file.size > 2 * 1024 * 1024) {
            setError('Catalog exceeds 2 MiB');
            return;
        }
        await run('import', async () => { await call('plugins/importCatalog', { content: await file.text(), scope: tab }); setStatus(t('imported')); });
    }
    async function toggleMcp(item) {
        if (!item.mcpEnabled) {
            const generation = life.current.generation;
            const preview = await run(item.name, () => call('plugins/mcpPreview', { name: item.name }), false);
            if (!preview || !current(generation))
                return;
            const summary = (preview.servers ?? []).map(server => {
                const bindings = Object.entries(server.envSources ?? {}).map(([key, source]) => `${key} ← ${source}`);
                return `${server.server}: ${server.command} ${(server.args ?? []).join(' ')}\nENV: ${bindings.length ? bindings.join(', ') : (server.envKeys ?? []).join(', ')}`;
            }).join('\n');
            requestConfirmation({ key: item.name, title: `${t('allowMcp')}: ${item.name}`, message: `${t('confirmMcp')}\n${summary}`,
                label: t('allowMcp'), action: () => call('plugins/mcpEnable', { name: item.name }) });
            return;
        }
        await run(item.name, () => call('plugins/mcpDisable', { name: item.name }));
    }
    const options = ['public', 'personal'];
    const selectedCatalog = catalog.find(item => item.name === detail);
    const selectedInstalled = installed.find(item => item.name === detail);
    const selected = selectedInstalled ? { ...selectedCatalog, ...selectedInstalled, source: selectedCatalog?.source } : selectedCatalog ?? null;
    const filtered = (list) => list.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    function itemCard(item, saved, updateAvailable = false) {
        const isInstalled = !!saved;
        const mcpOnly = !!saved && !saved.skills.length && saved.capabilities.includes('mcp');
        const label = updateAvailable ? 'update' : isInstalled ? (mcpOnly ? (saved?.mcpEnabled ? 'stopMcp' : 'allowMcp') : (saved?.enabled ? 'disable' : 'enable')) : 'install';
        return (0, react_1.createElement)('div', { className: 'xhph-item', key: item.name }, (0, react_1.createElement)(CatalogIcon, { name: item.name, icon: item.icon ?? catalog.find(entry => entry.name === item.name)?.icon }), (0, react_1.createElement)('div', { className: 'xhph-copy', onClick: () => setDetail(item.name), role: 'button', tabIndex: 0,
            onKeyDown: (e) => { if (e.key === 'Enter')
                setDetail(item.name); } }, (0, react_1.createElement)('div', { className: 'xhph-name' }, item.name), (0, react_1.createElement)('div', { className: 'xhph-desc' }, item.description || item.version)), (0, react_1.createElement)('button', { className: 'xhph-button', disabled: !!busy || !!confirmation, onClick: () => {
                if (!isInstalled || updateAvailable) {
                    requestConfirmation({ key: item.name, title: `${t(label)}: ${item.name}`, label: t(label),
                        message: `${t('confirmInstall')}\n${item.source?.url ?? ''}\nSHA-256: ${item.source?.sha256 ?? ''}`,
                        action: () => call('plugins/install', { name: item.name }) });
                }
                else if (mcpOnly && saved) {
                    void toggleMcp(saved);
                }
                else if (saved) {
                    void run(item.name, () => call(saved.enabled ? 'plugins/disable' : 'plugins/enable', { name: item.name }));
                }
            } }, busy === item.name ? t('working') : t(label)));
    }
    return (0, react_1.createElement)('section', { className: 'xhph', 'data-xharness-plugin-hub': true }, (0, react_1.createElement)('header', { className: 'xhph-head' }, (0, react_1.createElement)('h1', null, t('title')), (0, react_1.createElement)('div', { className: 'xhph-actions' }, (0, react_1.createElement)('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => run('refresh', reload) }, t('refresh')), (0, react_1.createElement)('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => input.current?.click() }, t('add')), (0, react_1.createElement)('input', { ref: input, type: 'file', accept: '.json,application/json', hidden: true, onChange: importFile }))), (0, react_1.createElement)('input', { className: 'xhph-search', type: 'search', value: query, onChange: (event) => setQuery(event.target.value), placeholder: t('search'), 'aria-label': t('search') }), (0, react_1.createElement)('div', { className: `xhph-status${error ? ' xhph-error' : ''}`, role: error ? 'alert' : 'status' }, error || status), (0, react_1.createElement)('section', { className: 'xhph-installed', 'aria-labelledby': 'xhph-installed-title' }, (0, react_1.createElement)('h2', { id: 'xhph-installed-title', className: 'xhph-section-title' }, t('installed')), filtered(installed).length ? (0, react_1.createElement)('div', { className: 'xhph-grid' }, filtered(installed).map(item => itemCard(item, item))) :
        (0, react_1.createElement)('div', { className: 'xhph-installed-empty' }, (0, react_1.createElement)(PluginIcon), (0, react_1.createElement)('span', null, t(query ? 'noMatch' : 'noInstalled')))), (0, react_1.createElement)('div', { role: 'tablist', 'aria-label': t('title'), className: 'xhph-tabs' }, options.map((key, index) => (0, react_1.createElement)('button', {
        key, type: 'button', role: 'tab', id: `xhph-tab-${key}`, 'aria-selected': tab === key,
        'aria-controls': `xhph-panel-${key}`, tabIndex: tab === key ? 0 : -1, className: 'xhph-tab', onClick: () => setTab(key),
        onKeyDown: (event) => { const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1; const nextTab = options[next]; if (nextTab !== undefined) {
            event.preventDefault();
            setTab(nextTab);
            document.getElementById(`xhph-tab-${nextTab}`)?.focus();
        } },
    }, t(key)))), (0, react_1.createElement)('section', { id: `xhph-panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `xhph-tab-${tab}` }, (0, react_1.createElement)('h2', { className: 'xhph-section-title' }, t(tab)), filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).length ? (0, react_1.createElement)('div', { className: 'xhph-grid' }, filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).map(item => {
        const saved = installed.find(p => p.name === item.name);
        return itemCard(saved ? { ...item, ...saved, source: item.source } : item, saved, updates.some(update => update.name === item.name));
    })) :
        (0, react_1.createElement)('div', { className: 'xhph-catalog-empty' }, t(query ? 'noMatch' : tab === 'public' ? 'noCatalog' : 'noPersonal'))), selected && (0, react_1.createElement)('aside', { className: 'xhph-detail' }, (0, react_1.createElement)('strong', null, `${t('inspect')}: ${selected.name}`), (0, react_1.createElement)('p', null, selected.description || ''), (0, react_1.createElement)('p', null, `${t('source')}: ${selected.source?.url ?? 'installed'}`), (0, react_1.createElement)('p', null, `${t('digest')}: `, (0, react_1.createElement)('code', null, selected.source?.sha256 ?? selected.digest ?? '')), (0, react_1.createElement)('p', null, `${t('capabilities')}: ${(selected.capabilities ?? []).join(', ') || t('noSkills')}`), selectedInstalled?.capabilities?.includes('mcp') && (0, react_1.createElement)('button', { className: 'xhph-button', type: 'button', disabled: !!busy,
        onClick: () => toggleMcp(selectedInstalled) }, t(selectedInstalled.mcpEnabled ? 'stopMcp' : 'allowMcp')), (0, react_1.createElement)('p', null, t('unsupported')), installed.some(p => p.name === selected.name) && (0, react_1.createElement)('button', { className: 'xhph-button', disabled: !!busy,
        onClick: () => requestConfirmation({ key: selected.name, title: `${t('uninstall')}: ${selected.name}`, message: t('confirmUninstall'),
            label: t('uninstall'), action: () => call('plugins/uninstall', { name: selected.name }) }) }, t('uninstall'))), (0, react_1.createElement)(dsh_client_ui_primitives_1.Modal, { open: !!confirmation, title: confirmation?.title ?? '', closeLabel: t('close'), onClose: cancelConfirmation,
        footer: (0, react_1.createElement)('div', { className: 'xhph-confirm-actions' }, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, { variant: 'outline', onClick: cancelConfirmation }, t('cancel')), (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, { variant: 'primary', onClick: acceptConfirmation }, confirmation?.label ?? '')) }, (0, react_1.createElement)('div', { className: 'xhph-confirm-message' }, confirmation?.message)));
}
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-plugin-hub: locale');
    ctx.effect(() => { if (document.getElementById('xharness-plugin-hub-style'))
        return () => { }; const style = document.createElement('style'); style.id = 'xharness-plugin-hub-style'; style.textContent = PluginHub_css_1.default; document.head.append(style); return () => style.remove(); }, 'xharness-plugin-hub: styles');
    const connection = ctx.get('connection');
    const call = (0, xharness_client_plugin_api_1.createPluginClient)(connection.rpc);
    ctx.slots.inject('plugins.center', () => ctx.slots.register({ name: 'plugins.center', id: 'plugin-hub', order: 0, locale: NS,
        inject: () => ({ call }), }, PluginHub));
}
const inject = ['slots', 'locale', 'connection'];
exports.inject = inject;

},
"src/modules/plugin-hub/PluginHub.css": function(module, exports, require) {
// source: src/modules/plugin-hub/PluginHub.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "\n.xhph{max-width:1260px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit}\n.xhph-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px}.xhph h1{font-size:30px;letter-spacing:-.045em;line-height:1.15;margin:0;font-weight:650}.xhph-actions{display:flex;gap:8px}.xhph-button{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer}.xhph-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.xhph-button:disabled{opacity:.5;cursor:default}\n.xhph-search{display:block;box-sizing:border-box;width:100%;height:48px;padding:0 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;outline:none}.xhph-search::placeholder{color:var(--dsw-alias-label-tertiary)}.xhph-search:focus{border-color:var(--dsw-alias-label-secondary)}\n.xhph-installed{margin-top:38px}.xhph-section-title{font-size:19px;font-weight:620;letter-spacing:-.02em;margin:0;padding:0 0 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhph-installed-empty{display:flex;align-items:center;gap:15px;min-height:82px;color:var(--dsw-alias-label-secondary);font-size:13px}.xhph-symbol{display:flex;align-items:center;justify-content:center;flex:none;width:46px;height:46px;border-radius:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}\n.xhph-tabs{display:flex;gap:7px;margin:28px 0 37px;transform:translateX(-15px)}.xhph-tab{border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;font-weight:580;padding:8px 15px;cursor:pointer}.xhph-tab:hover{color:var(--dsw-alias-label-primary)}.xhph-tab[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhph-catalog-empty{display:flex;align-items:center;min-height:100px;color:var(--dsw-alias-label-secondary);font-size:13px}\n.xhph-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 28px;padding-top:15px}.xhph-item{display:flex;align-items:center;gap:13px;min-width:0;padding:11px 5px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhph-icon{width:42px;height:42px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--dsw-alias-interactive-bg-hover);font-weight:650;color:var(--dsw-alias-label-secondary)}.xhph-copy{min-width:0;flex:1}.xhph-name{font-size:14px;font-weight:620}.xhph-desc{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.xhph-item button{flex:none}.xhph-status{min-height:22px;margin:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.xhph-error{color:#c54545}.xhph-detail{margin:5px 0 18px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow-wrap:anywhere;font-size:12px}.xhph-detail p{margin:7px 0}.xhph-detail code{font-size:11px}\n@media(max-width:700px){.xhph-grid{grid-template-columns:1fr}.xhph h1{font-size:25px}.xhph-head{align-items:flex-start}.xhph-installed{margin-top:30px}.xhph-tabs{margin:24px 0 30px}}\n.xhph-icon-artwork{background:transparent}.xhph-icon img{display:block;width:42px;height:42px;object-fit:contain}\n.xhph-confirm-message{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;font-size:13px;line-height:1.6}.xhph-confirm-actions{display:flex;justify-content:flex-end;gap:10px}\n";

}
};
const __dependencies = {"src/modules/plugin-hub/index.js":{"./PluginHub.css":"src/modules/plugin-hub/PluginHub.css"},"src/modules/plugin-hub/PluginHub.css":{}};
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
return __load("src/modules/plugin-hub/index.js");
}
});
