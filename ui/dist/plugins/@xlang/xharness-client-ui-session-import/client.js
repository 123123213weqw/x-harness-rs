// Generated from src/modules/session-import/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-session-import",
factory: (__externalRequire) => {
const __units = {
"src/modules/session-import/index.js": function(module, exports, require) {
// source: src/modules/session-import/index.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/// <reference path="../shared/assets.d.ts" />
const Import_css_1 = __importDefault(require("./Import.css"));
const Import_1 = require("./Import");
const NS = 'xharness.session-import';
const zh = { retry: '重试预览', nav: '导入会话', title: '导入会话', description: '将 Claude Code 或 Codex 的本地历史带入 XHarness，继续原来的任务。', source: '来源', file: '会话文件', fileHelp: '选择 JSONL 文件，最大 8 MiB；不会修改原文件。', fileError: '请选择不超过 8 MiB 的 .jsonl 文件；压缩日志请先解压。', destination: '目标工作目录（可选）', defaultCwd: '使用当前 XHarness 服务的默认目录', destinationHelp: '目录属于当前连接的 XHarness 服务；不会自动使用旧日志里的路径。', working: '正在处理…', counts: '{messages} 条历史记录 · {tools} 次历史工具调用', preview: '查看内容预览', safety: '旧工具只作为记录，不重新执行。导入不会调用模型；继续聊天时使用当前模型和权限。', import: '导入并打开', missingSession: '服务没有返回导入会话，请重试。', 'warning.incomplete-tail-skipped': '已跳过日志末尾尚未写完的一行。', 'warning.unfinished-tools-recorded-only': '存在结果未知的旧工具调用，仅保留记录。', 'warning.attachments-not-imported': '旧图片和附件未导入；需要时请重新选择原文件。', 'warning.provider-private-reasoning-omitted': '原模型的私有推理状态未导入。', 'warning.unsupported-content-block-omitted': '部分不支持的内容块未导入。' };
const en = { retry: 'Retry preview', nav: 'Import session', title: 'Import session', description: 'Bring local Claude Code or Codex history into XHarness and continue the task.', source: 'Source', file: 'Session file', fileHelp: 'Choose a JSONL file, up to 8 MiB. The original stays unchanged.', fileError: 'Choose a .jsonl file up to 8 MiB. Decompress compressed logs first.', destination: 'Working directory (optional)', defaultCwd: 'Use the connected XHarness Host default directory', destinationHelp: 'This path belongs to the connected XHarness Host. Source paths are never applied automatically.', working: 'Working…', counts: '{messages} historical records · {tools} historical tool calls', preview: 'Preview content', safety: 'Old tools are records only, never re-executed. Import makes no model request; continuing uses your current model and permissions.', import: 'Import & open', missingSession: 'The service did not return an imported session. Please retry.', 'warning.incomplete-tail-skipped': 'An incomplete final log line was skipped.', 'warning.unfinished-tools-recorded-only': 'Some old tool calls have unknown results; records only.', 'warning.attachments-not-imported': 'Historical images and attachments were not imported. Select the originals again if needed.', 'warning.provider-private-reasoning-omitted': 'Provider-private reasoning state was not imported.', 'warning.unsupported-content-block-omitted': 'Some unsupported content blocks were omitted.' };
exports.inject = ['slots', 'locale', 'connection', 'sessions'];
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-import: labels');
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = Import_css_1.default; document.head.append(style); return () => style.remove(); }, 'session-import: styles');
    const t = ctx.locale.bind(NS), api = ctx.get('connection').api;
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'session-import', order: 35, label: () => t('nav'), inject: () => ({ api, sessions: ctx.sessions, t }) }, Import_1.ImportSettings));
}

},
"src/modules/session-import/Import.css": function(module, exports, require) {
// source: src/modules/session-import/Import.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhsi-root{display:grid;gap:14px;color:var(--dsw-alias-label-primary,#222)}.xhsi-root h2{margin:0;font-size:22px;font-weight:600}.xhsi-root p{margin:0;font-size:13px;line-height:1.6}.xhsi-root>p,.xhsi-root small{color:var(--dsw-alias-label-secondary,#777)}.xhsi-root label{display:grid;gap:7px;font-size:13px}.xhsi-root select,.xhsi-root input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-interactive-bg-hover,#f6f6f6);color:inherit;padding:10px 12px;border-radius:9px;font:inherit}.xhsi-root small{font-size:11px;line-height:1.5;overflow-wrap:anywhere}.xhsi-preview{padding:14px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;display:grid;gap:9px}.xhsi-preview strong{overflow-wrap:anywhere}.xhsi-preview summary{font-size:12px;cursor:pointer}.xhsi-preview pre{font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}.xhsi-root .xhsi-error{color:#d04444}.xhsi-warning{color:var(--dsw-alias-label-secondary,#777)}.xhsi-submit{justify-self:start;background:var(--dsw-alias-label-primary,#222);color:var(--dsw-alias-bg-base,#fff);border:0;border-radius:9px;padding:10px 16px;font:inherit;font-size:13px;cursor:pointer}.xhsi-submit:disabled{opacity:.4;cursor:default}.xhsi-root select:focus-visible,.xhsi-root input:focus-visible,.xhsi-submit:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#222);outline-offset:2px}\n";

},
"src/modules/session-import/Import.js": function(module, exports, require) {
// source: src/modules/session-import/Import.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportSettings = ImportSettings;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const runtime_types_1 = require("../shared/runtime-types");
const MAX_BYTES = 8 * 1024 * 1024;
/** File choice and preview never create a session; only the explicit Import click does. */
function ImportSettings({ api, sessions, t, close }) {
    const [source, setSource] = (0, react_1.useState)('claude-code');
    const [jsonl, setJsonl] = (0, react_1.useState)(''), [name, setName] = (0, react_1.useState)(''), [cwd, setCwd] = (0, react_1.useState)('');
    const [report, setReport] = (0, react_1.useState)(null), [error, setError] = (0, react_1.useState)(''), [busy, setBusy] = (0, react_1.useState)(false);
    const revision = (0, react_1.useRef)(0), request = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => () => { revision.current++; request.current?.abort(); }, []);
    function reset() { revision.current++; request.current?.abort(); setReport(null); setError(''); setJsonl(''); setName(''); setBusy(false); }
    async function choose(file) {
        reset();
        if (!file)
            return;
        if (!file.name.endsWith('.jsonl') || file.size > MAX_BYTES) {
            setError(t('fileError'));
            return;
        }
        const version = revision.current;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setName(file.name);
        try {
            const text = await file.text();
            if (version !== revision.current)
                return;
            setJsonl(text);
            const { result } = await api.sessions.importHistory({ source, jsonl: text, preview: true }, controller.signal);
            if (version !== revision.current)
                return;
            if (!result.ok)
                throw result.error;
            setReport(result.value);
        }
        catch (e) {
            if (version === revision.current)
                setError((0, runtime_types_1.errorText)(e));
        }
        finally {
            if (version === revision.current)
                setBusy(false);
        }
    }
    async function retryPreview() {
        if (busy || !jsonl)
            return;
        const version = revision.current;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        try {
            const { result } = await api.sessions.importHistory({ source, jsonl, preview: true }, controller.signal);
            if (version !== revision.current)
                return;
            if (!result.ok)
                throw result.error;
            setReport(result.value);
        }
        catch (e) {
            if (version === revision.current)
                setError((0, runtime_types_1.errorText)(e));
        }
        finally {
            if (version === revision.current)
                setBusy(false);
        }
    }
    async function commit() {
        if (!report || busy || !jsonl)
            return;
        setBusy(true);
        setError('');
        const version = revision.current;
        const controller = new AbortController();
        request.current = controller;
        try {
            const { result } = await api.sessions.importHistory({ source, jsonl, preview: false, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }, controller.signal);
            if (version !== revision.current)
                return;
            if (!result.ok)
                throw result.error;
            if (!result.value.sessionId)
                throw Error(t('missingSession'));
            await sessions.refresh();
            sessions.open(result.value.sessionId);
            close();
        }
        catch (e) {
            if (version === revision.current)
                setError((0, runtime_types_1.errorText)(e));
        }
        finally {
            if (version === revision.current)
                setBusy(false);
        }
    }
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhsi-root", children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("p", { children: t('description') }), (0, jsx_runtime_1.jsxs)("label", { children: [t('source'), (0, jsx_runtime_1.jsxs)("select", { value: source, disabled: busy, onChange: e => { reset(); setSource(e.currentTarget.value === 'codex' ? 'codex' : 'claude-code'); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "claude-code", children: "Claude Code" }), (0, jsx_runtime_1.jsx)("option", { value: "codex", children: "Codex" })] })] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('file'), (0, jsx_runtime_1.jsx)("input", { type: "file", accept: ".jsonl", disabled: busy, onChange: e => { void choose(e.currentTarget.files?.item(0) ?? null); } }, source)] }), (0, jsx_runtime_1.jsxs)("small", { children: [source === 'codex' ? '~/.codex/sessions/ · ~/.codex/archived_sessions/' : '~/.claude/projects/', " \u2014 ", t('fileHelp')] }), (0, jsx_runtime_1.jsxs)("label", { children: [t('destination'), (0, jsx_runtime_1.jsx)("input", { value: cwd, disabled: busy, placeholder: t('defaultCwd'), onChange: e => setCwd(e.currentTarget.value) })] }), (0, jsx_runtime_1.jsx)("small", { children: t('destinationHelp') }), busy && (0, jsx_runtime_1.jsx)("p", { role: "status", children: t('working') }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: "xhsi-error", children: error }), error && jsonl && !report && (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy, onClick: () => { void retryPreview(); }, children: t('retry') }), report && (0, jsx_runtime_1.jsxs)("div", { className: "xhsi-preview", children: [(0, jsx_runtime_1.jsx)("strong", { children: report.title }), (0, jsx_runtime_1.jsxs)("p", { children: [name, " \u00B7 ", t('counts', { messages: report.messages, tools: report.tools })] }), report.warnings.map(w => (0, jsx_runtime_1.jsx)("p", { className: "xhsi-warning", children: t('warning.' + w) }, w)), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: t('preview') }), report.preview.map((m, i) => (0, jsx_runtime_1.jsxs)("pre", { children: [m.role, ": ", m.content] }, i))] })] }), (0, jsx_runtime_1.jsx)("p", { className: "xhsi-note", children: t('safety') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhsi-submit", disabled: busy || !report, onClick: () => { void commit(); }, children: t('import') })] });
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

}
};
const __dependencies = {"src/modules/session-import/index.js":{"./Import.css":"src/modules/session-import/Import.css","./Import":"src/modules/session-import/Import.js"},"src/modules/session-import/Import.css":{},"src/modules/session-import/Import.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{}};
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
return __load("src/modules/session-import/index.js");
}
});
