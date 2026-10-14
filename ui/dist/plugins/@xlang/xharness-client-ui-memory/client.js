// Generated from src/modules/memory/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-memory",
factory: (__externalRequire) => {
const __units = {
"src/modules/memory/index.js": function(module, exports, require) {
// source: src/modules/memory/index.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
exports.MemorySettings = MemorySettings;
/// <reference path="../shared/assets.d.ts" />
const Memory_css_1 = __importDefault(require("./Memory.css"));
const react_1 = require("react");
const runtime_types_1 = require("../shared/runtime-types");
const client_1 = require("./client");
const NS = 'xharness.memory';
const zh = {
    nav: '工作区记忆', title: '工作区记忆', subtitle: '保存在本机应用数据目录，按工作区共享，不随模型变化，也不写入 Git。',
    workspace: '工作区', none: '暂无工作区', loading: '读取中…', mode: '保存方式', off: '关闭', manual: '仅明确要求时', auto: '自动整理（可选）',
    policy: '手动模式：明确说“记住……”才会保存。自动模式：允许模型在合适的任务节点整理已验证事实，不保证每轮都更新。不保存密钥、完整对话或临时选择。',
    document: 'MEMORY.md', hint: '顶部简短索引会进入下一轮上下文，完整记录由模型按需读取。正在运行的上下文不会被改写。',
    reload: '重新读取', save: '保存', clear: '清空', saved: '已保存', working: '处理中…', unavailable: '此部署未启用工作区记忆。',
    damaged: '文件过大或含无效编码，不能覆盖保存；可备份后清空修复。', clearConfirm: '清空当前工作区记忆？不会删除对话历史或已记录的请求快照。',
    reloadConfirm: '放弃当前未保存修改并重新读取？', autoConfirm: '允许模型自动保存已验证的长期事实？仍使用现有文件工具和审批权限。',
    failure: '操作未确认，请重新读取后重试。你的草稿仍保留。', disabled: '关闭后，新工具调用不能再访问记忆；已进入模型上下文的内容不会被撤回。',
};
const en = {
    nav: 'Workspace memory', title: 'Workspace memory', subtitle: 'Local app data, shared within this workspace across models. Never written to Git.',
    workspace: 'Workspace', none: 'No workspaces yet', loading: 'Loading…', mode: 'Memory mode', off: 'Off', manual: 'Only when asked', auto: 'Auto curate (optional)',
    policy: 'Manual: say “remember…” explicitly. Auto: lets the model curate verified facts at useful milestones, not necessarily every turn. Never store secrets, full conversations or temporary choices.',
    document: 'MEMORY.md', hint: 'A short top index enters the next turn. The model reads details on demand. Running context is not rewritten.',
    reload: 'Reload', save: 'Save', clear: 'Clear memory', saved: 'Saved', working: 'Working…', unavailable: 'Workspace memory is not enabled in this deployment.',
    damaged: 'Oversized or invalid-encoding file: saving is disabled. Back it up before clearing to repair.', clearConfirm: 'Clear this workspace memory? Conversation history and recorded request snapshots remain.',
    reloadConfirm: 'Discard your unsaved draft and reload?', autoConfirm: 'Allow automatic curation of verified long-term facts? Existing file tools and approval permissions still apply.',
    failure: 'Operation not confirmed. Reload before retrying; your draft is preserved.', disabled: 'Off denies new memory tool calls; content already in a running context cannot be retracted.',
};
function MemorySettings({ client, t }) {
    const [workspaces, setWorkspaces] = (0, react_1.useState)([]);
    const [selected, setSelected] = (0, react_1.useState)('');
    const [entries, setEntries] = (0, react_1.useState)({});
    const [listError, setListError] = (0, react_1.useState)('');
    const lifetime = (0, react_1.useRef)();
    (0, react_1.useEffect)(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void client.workspaces(controller.signal).then(rows => {
            if (!controller.signal.aborted) {
                setWorkspaces(rows);
                setSelected(rows[0]?.id ?? '');
            }
        }).catch((e) => { if (!controller.signal.aborted)
            setListError((0, runtime_types_1.errorText)(e)); });
        return () => controller.abort();
    }, [client]);
    const patch = (id, next) => {
        if (!lifetime.current?.signal.aborted)
            setEntries(old => ({ ...old, [id]: { ...old[id], ...next } }));
    };
    async function load(id) {
        const signal = lifetime.current?.signal;
        if (!signal)
            return;
        patch(id, { busy: true, error: '', notice: '' });
        try {
            const view = await client.view(id, signal);
            if (!signal.aborted)
                patch(id, { view, draft: view.content });
        }
        catch (e) {
            if (!signal.aborted)
                patch(id, { error: (0, runtime_types_1.errorText)(e) });
        }
        finally {
            if (!signal.aborted)
                patch(id, { busy: false });
        }
    }
    (0, react_1.useEffect)(() => { if (selected && !entries[selected])
        void load(selected); }, [selected]);
    const entry = entries[selected] ?? {}, view = entry.view;
    const dirty = view !== undefined && entry.draft !== view.content;
    async function change(action, mode) {
        const signal = lifetime.current?.signal;
        if (!view || !signal || entry.busy)
            return;
        if (action === 'clear' && !window.confirm(t('clearConfirm')))
            return;
        if (mode === 'auto' && !window.confirm(t('autoConfirm')))
            return;
        const id = selected;
        patch(id, { busy: true, error: '', notice: '' });
        try {
            const payload = action === 'configure' && mode ? { action: 'configure', mode, settingsVersion: view.settingsVersion } :
                action === 'clear' ? { action: 'clear', version: view.version } : { action: 'save', content: entry.draft ?? '', version: view.version };
            const version = await client.mutate(id, payload, signal);
            if (signal.aborted)
                return;
            const next = action === 'configure' ? { ...view, mode: mode ?? view.mode, settingsVersion: version, settingsError: '' } :
                { ...view, version, content: action === 'clear' ? '' : entry.draft ?? '', tooLarge: false, invalidUtf8: false };
            patch(id, { view: next, ...(action === 'configure' ? {} : { draft: next.content }), notice: t('saved') });
        }
        catch (e) {
            if (!signal.aborted)
                patch(id, { error: `${t('failure')} ${(0, runtime_types_1.errorText)(e)}` });
        }
        finally {
            if (!signal.aborted)
                patch(id, { busy: false });
        }
    }
    return (0, react_1.createElement)('section', { className: 'xhm-root' }, (0, react_1.createElement)('h2', null, t('title')), (0, react_1.createElement)('p', null, t('subtitle')), listError && (0, react_1.createElement)('p', { role: 'alert' }, listError), (0, react_1.createElement)('label', null, t('workspace'), (0, react_1.createElement)('select', { 'aria-label': t('workspace'), value: selected, onChange: (event) => setSelected(event.target.value) }, workspaces.length ? workspaces.map(w => (0, react_1.createElement)('option', { key: w.id, value: w.id }, `${w.title} · ${w.path}`)) : (0, react_1.createElement)('option', { value: '' }, t('none')))), selected && !view && !entry.error && (0, react_1.createElement)('p', { role: 'status' }, t('loading')), view && !view.available && (0, react_1.createElement)('p', null, t('unavailable')), view?.available && (0, react_1.createElement)('div', null, (0, react_1.createElement)('label', null, t('mode'), (0, react_1.createElement)('select', { 'aria-label': t('mode'), value: view.mode ?? '', disabled: entry.busy,
        onChange: (event) => { const mode = event.target.value; if (mode === 'off' || mode === 'manual' || mode === 'auto')
            void change('configure', mode); } }, view.mode === null && (0, react_1.createElement)('option', { value: '', disabled: true }, '—'), ['off', 'manual', 'auto'].map(mode => (0, react_1.createElement)('option', { key: mode, value: mode }, t(mode))))), (0, react_1.createElement)('p', null, t('policy')), view.mode === 'off' && (0, react_1.createElement)('p', null, t('disabled')), view.settingsError && (0, react_1.createElement)('p', { role: 'alert' }, view.settingsError), (0, react_1.createElement)('label', null, t('document'), (0, react_1.createElement)('textarea', { value: entry.draft ?? '', disabled: entry.busy || view.tooLarge || view.invalidUtf8,
        spellCheck: false, onChange: (event) => patch(selected, { draft: event.target.value, notice: '' }) })), (0, react_1.createElement)('p', null, t('hint'), ` · ${new TextEncoder().encode(entry.draft ?? '').length} / 65536 bytes`), (view.tooLarge || view.invalidUtf8) && (0, react_1.createElement)('p', { role: 'alert' }, t('damaged')), (0, react_1.createElement)('div', { className: 'xhm-actions' }, (0, react_1.createElement)('button', { type: 'button', disabled: entry.busy || !dirty || view.tooLarge || view.invalidUtf8 || new TextEncoder().encode(entry.draft ?? '').length > 65536, onClick: () => void change('save') }, t('save')), (0, react_1.createElement)('button', { type: 'button', disabled: entry.busy || view.version === null, onClick: () => void change('clear') }, t('clear')))), selected && (0, react_1.createElement)('button', { type: 'button', disabled: entry.busy, onClick: () => { if (!dirty || window.confirm(t('reloadConfirm')))
            void load(selected); } }, t('reload')), entry.busy && (0, react_1.createElement)('p', { role: 'status' }, t('working')), entry.error && (0, react_1.createElement)('p', { role: 'alert' }, entry.error), entry.notice && (0, react_1.createElement)('p', { role: 'status' }, entry.notice));
}
const inject = ['slots', 'locale', 'connection'];
exports.inject = inject;
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-memory: locale');
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = Memory_css_1.default; document.head.append(style); return () => style.remove(); }, 'workspace-memory: style');
    const client = new client_1.MemoryClient(ctx.get('connection').rpc), t = ctx.locale.bind(NS);
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'memory', order: 31, label: () => t('nav'), inject: () => ({ client, t }) }, MemorySettings));
}

},
"src/modules/memory/Memory.css": function(module, exports, require) {
// source: src/modules/memory/Memory.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhm-root { color:var(--dsr-text-0, inherit); max-width:760px; padding:20px 24px; }\n.xhm-root h2 { font-size:22px; margin:0 0 12px; font-weight:600; }\n.xhm-root p { color:var(--dsr-text-2, #888); font-size:13px; line-height:1.6; margin:12px 0; overflow-wrap:anywhere; }\n.xhm-root label { display:flex; flex-direction:column; gap:8px; margin:20px 0 12px; font-size:14px; }\n.xhm-root select,.xhm-root textarea,.xhm-root button { font:inherit; color:inherit; background:transparent; border:1px solid var(--dsr-border-1, #8885); border-radius:8px; padding:9px 12px; }\n.xhm-root select { width:100%; min-width:0; }\n.xhm-root textarea { box-sizing:border-box; width:100%; min-height:260px; resize:vertical; font-family:ui-monospace,monospace; line-height:1.6; }\n.xhm-root button { cursor:pointer; font-size:13px; margin:0 8px 8px 0; }\n.xhm-root :disabled { opacity:.45; cursor:default; }\n.xhm-root :focus-visible { outline:2px solid currentColor; outline-offset:2px; }\n.xhm-root [role=alert] { color:inherit; border-inline-start:2px solid currentColor; padding-inline-start:12px; }\n.xhm-actions { display:flex; gap:4px; margin:16px 0 4px; flex-wrap:wrap; }\n";

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
"src/modules/memory/client.js": function(module, exports, require) {
// source: src/modules/memory/client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryClient = void 0;
const runtime_types_1 = require("../shared/runtime-types");
class MemoryClient {
    constructor(rpc) {
        this.rpc = rpc;
    }
    async call(endpoint, payload, signal) {
        const result = await this.rpc.call('/api', endpoint, payload, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
        if (!result.ok)
            throw Error(result.error.message);
        return result.value;
    }
    async workspaces(signal) {
        const reply = (0, runtime_types_1.objectValue)(await this.call('workspace.list', {}, signal));
        if (!Array.isArray(reply.items))
            throw Error('Invalid workspace response');
        return reply.items.map((raw) => {
            const row = (0, runtime_types_1.objectValue)(raw);
            if (typeof row.workspaceId !== 'string' || typeof row.title !== 'string' || typeof row.path !== 'string')
                throw Error('Invalid workspace');
            return { id: row.workspaceId, title: row.title, path: row.path };
        });
    }
    async view(workspaceId, signal) {
        const row = (0, runtime_types_1.objectValue)(await this.call('workspace/memory', { workspaceId, action: 'view' }, signal));
        if (row.available === false)
            return { available: false, mode: null, content: '', version: null, settingsVersion: null, tooLarge: false, invalidUtf8: false, settingsError: '' };
        const version = (v) => v === null || typeof v === 'string';
        if (row.available !== true || !version(row.version) || !version(row.settingsVersion) || typeof row.content !== 'string' ||
            !(row.mode === null || row.mode === 'off' || row.mode === 'manual' || row.mode === 'auto'))
            throw Error('Invalid memory response');
        return { available: true, mode: row.mode, content: row.content, version: row.version,
            settingsVersion: row.settingsVersion, tooLarge: row.tooLarge === true, invalidUtf8: row.invalidUtf8 === true,
            settingsError: typeof row.settingsError === 'string' ? row.settingsError : '' };
    }
    async mutate(workspaceId, change, signal) {
        const reply = (0, runtime_types_1.objectValue)(await this.call('workspace/memory', { workspaceId, ...change }, signal));
        if (reply.saved !== true || typeof reply.version !== 'string')
            throw Error('Invalid memory save response');
        return reply.version;
    }
}
exports.MemoryClient = MemoryClient;

}
};
const __dependencies = {"src/modules/memory/index.js":{"./Memory.css":"src/modules/memory/Memory.css","../shared/runtime-types":"src/modules/shared/runtime-types.js","./client":"src/modules/memory/client.js"},"src/modules/memory/Memory.css":{},"src/modules/shared/runtime-types.js":{},"src/modules/memory/client.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"}};
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
return __load("src/modules/memory/index.js");
}
});
