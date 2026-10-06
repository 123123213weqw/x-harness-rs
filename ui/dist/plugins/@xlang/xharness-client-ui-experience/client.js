// Generated from src/modules/experience/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-experience",
factory: (__externalRequire) => {
const __units = {
"src/modules/experience/index.js": function(module, exports, require) {
// source: src/modules/experience/index.tsx

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._test = exports.inject = void 0;
exports.apply = apply;
/// <reference path="../shared/assets.d.ts" />
const React = __importStar(require("react"));
const Experience_css_1 = __importDefault(require("./Experience.css"));
const process_display_1 = require("../shared/process-display");
const InstallationStatistics_1 = require("./InstallationStatistics");
const h = React.createElement;
const { useEffect, useState } = React;
const MODES = ['auto', 'expanded'];
function isMode(value) { return MODES.some(mode => mode === value); }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const MODE_KEY = process_display_1.PROCESS_MODE_KEY;
const SHORTCUT_KEY = 'xharness.ui.shortcuts.v1';
const DEFAULT_SHORTCUTS = Object.freeze({ cycleMode: 'Mod+Shift+J', focusComposer: 'Mod+Shift+L' });
const labels = {
    zh: { nav: '显示与快捷键', title: '显示与快捷键', subtitle: '只改变工作过程的呈现，不改变模型、工具或历史记录。',
        display: '工作步骤展示', auto: '自动', expanded: '全部展开',
        autoHint: '按空间折叠，保留运行与异常', expandedHint: '默认展开过程与详情，可手动收起',
        shortcut: '键盘快捷键', search: '搜索快捷键', cycleMode: '切换工作步骤展示', focusComposer: '聚焦输入框',
        record: '按下新组合键…', reset: '恢复默认', conflict: '该组合键已被其他操作使用', invalid: '请同时按修饰键',
        empty: '没有匹配的快捷键', local: '这些偏好只保存在当前设备。' },
    en: { nav: 'Display & shortcuts', title: 'Display & shortcuts', subtitle: 'Changes presentation only; model, tools and history remain intact.',
        display: 'Work process display', auto: 'Automatic', expanded: 'Expand all',
        autoHint: 'Fold by space; keep live and failed work', expandedHint: 'Expand work and details; allow manual collapse',
        shortcut: 'Keyboard shortcuts', search: 'Search shortcuts', cycleMode: 'Cycle process display', focusComposer: 'Focus composer',
        record: 'Press a new shortcut…', reset: 'Reset defaults', conflict: 'This shortcut is already in use', invalid: 'Include a modifier key',
        empty: 'No matching shortcuts', local: 'These preferences are stored on this device only.' },
};
function readStorage(key) { try {
    return localStorage.getItem(key);
}
catch {
    return null;
} }
function writeStorage(key, value) { try {
    localStorage.setItem(key, value);
}
catch { /* memory-only preference */ } }
function initialMode() { return (0, process_display_1.normalizeProcessMode)(readStorage(MODE_KEY)); }
function initialShortcuts() {
    try {
        const saved = JSON.parse(readStorage(SHORTCUT_KEY) || 'null');
        if (isRecord(saved)) {
            const result = { ...DEFAULT_SHORTCUTS };
            for (const key of Object.keys(result))
                if (typeof saved[key] === 'string' && saved[key].length < 70)
                    result[key] = saved[key];
            if (new Set(Object.values(result)).size === Object.values(result).length)
                return result;
        }
    }
    catch { /* invalid/old settings fall back */ }
    return { ...DEFAULT_SHORTCUTS };
}
let mode = initialMode();
let shortcuts = initialShortcuts();
const listeners = new Set();
function publish() { for (const listener of listeners)
    listener(); }
function setMode(next) {
    if (!isMode(next))
        return false;
    mode = next;
    document.documentElement.dataset.xhProcessMode = next;
    writeStorage(MODE_KEY, next);
    window.dispatchEvent(new Event('xh-process-mode'));
    publish();
    return true;
}
function setShortcuts(next) {
    if (Object.values(next).some(value => typeof value !== 'string') || new Set(Object.values(next)).size !== Object.values(next).length)
        return false;
    const accepted = {};
    for (const [key, value] of Object.entries(next)) {
        if (typeof value !== 'string')
            return false;
        accepted[key] = value;
    }
    shortcuts = accepted;
    writeStorage(SHORTCUT_KEY, JSON.stringify(shortcuts));
    publish();
    return true;
}
function chord(event) {
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key))
        return '';
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    return [event.metaKey || event.ctrlKey ? 'Mod' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+');
}
function handleShortcut(event) {
    if (event.isComposing || event.repeat || event.defaultPrevented)
        return;
    const pressed = chord(event);
    if (pressed === shortcuts.cycleMode) {
        event.preventDefault();
        setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    }
    else if (pressed === shortcuts.focusComposer) {
        const composer = document.querySelector('[contenteditable="true"], textarea:not([readonly])');
        if (composer) {
            event.preventDefault();
            composer.focus();
        }
    }
}
function useSnapshot() {
    const [, render] = useState(0);
    useEffect(() => { const listener = () => render(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
    return { mode, shortcuts };
}
function Settings({ t }) {
    const state = useSnapshot();
    const [query, setQuery] = useState('');
    const [recording, setRecording] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        if (recording === null)
            return;
        const capture = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') {
                setRecording(null);
                setError('');
                return;
            }
            const pressed = chord(event);
            if (!pressed)
                return;
            if (!pressed.includes('Mod') && !pressed.includes('Alt')) {
                setError(t('invalid'));
                return;
            }
            if (Object.entries(shortcuts).some(([id, value]) => id !== recording && value === pressed)) {
                setError(t('conflict'));
                return;
            }
            setShortcuts({ ...shortcuts, [recording]: pressed });
            setRecording(null);
            setError('');
        };
        window.addEventListener('keydown', capture, true);
        return () => window.removeEventListener('keydown', capture, true);
    }, [recording, t]);
    const visible = Object.keys(DEFAULT_SHORTCUTS).filter(id => `${t(id)} ${state.shortcuts[id]}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return h('div', { className: 'xhe-root' }, [
        h('header', { key: 'header' }, [h('h2', { key: 'title' }, t('title')), h('p', { key: 'subtitle' }, t('subtitle'))]),
        h('section', { key: 'display' }, [h('h3', { key: 'title' }, t('display')),
            h('div', { className: 'xhe-options', role: 'group', 'aria-label': t('display'), key: 'options' }, MODES.map(id => h('button', {
                type: 'button', className: 'xhe-option', 'aria-pressed': state.mode === id, onClick: () => setMode(id), key: id,
            }, [h('strong', { key: 'name' }, t(id)), h('span', { key: 'hint' }, t(`${id}Hint`))])))]),
        h('section', { key: 'shortcuts' }, [h('h3', { key: 'title' }, t('shortcut')),
            h('input', { className: 'xhe-search', type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: (event) => setQuery(event.target.value), key: 'search' }),
            h('div', { className: 'xhe-shortcuts', key: 'list' }, visible.length ? visible.map(id => h('div', { className: 'xhe-shortcut', key: id }, [
                h('span', { key: 'label' }, t(id)), h('button', { className: 'xhe-key', type: 'button', 'data-recording': recording === id, onClick: () => { setRecording(id); setError(''); }, key: 'key' }, recording === id ? t('record') : state.shortcuts[id]),
            ])) : h('p', { key: 'empty' }, t('empty'))),
            error && h('p', { className: 'xhe-note', role: 'alert', key: 'error' }, error),
            h('div', { className: 'xhe-footer', key: 'footer' }, h('button', { className: 'xhe-reset', type: 'button', onClick: () => { setShortcuts(DEFAULT_SHORTCUTS); setRecording(null); setError(''); } }, t('reset'))),
            h('p', { key: 'local' }, t('local'))]),
    ]);
}
exports.inject = ['slots', 'locale'];
function apply(ctx) {
    ctx.effect(() => ctx.locale.register('xharness-installations', InstallationStatistics_1.statisticsLabels), 'xharness-installations: locale');
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'installation-statistics', order: 36, label: () => ctx.locale.bind('xharness-installations')('nav'), inject: () => ({ t: ctx.locale.bind('xharness-installations') }),
    }, InstallationStatistics_1.InstallationStatistics));
    ctx.effect(() => ctx.locale.register('xharness-experience', labels), 'xharness-experience: locale');
    ctx.effect(() => {
        if (document.getElementById('xharness-experience-css'))
            return () => { };
        const style = document.createElement('style');
        style.id = 'xharness-experience-css';
        style.textContent = Experience_css_1.default;
        document.head.append(style);
        return () => style.remove();
    }, 'xharness-experience: styles');
    ctx.effect(() => {
        setMode(mode);
        window.addEventListener('keydown', handleShortcut);
        return () => window.removeEventListener('keydown', handleShortcut);
    }, 'xharness-experience: shortcuts');
    const t = ctx.locale.bind('xharness-experience');
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'experience', order: 35, label: () => t('nav'), inject: () => ({ t }),
    }, Settings));
}
exports._test = { chord, setMode, setShortcuts, initialMode, initialShortcuts, MODE_KEY, SHORTCUT_KEY };

},
"src/modules/experience/Experience.css": function(module, exports, require) {
// source: src/modules/experience/Experience.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "\n.xhe-root{display:grid;gap:25px;padding:5px 0 24px;color:var(--dsw-alias-label-primary)}\n.xhe-root h2{margin:0;font-size:23px;font-weight:600;letter-spacing:-.03em}\n.xhe-root h3{margin:0 0 9px;font-size:14px;font-weight:600}\n.xhe-root p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}\n.xhe-root section{min-width:0}.xhe-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}\n.xhe-option{min-height:66px;text-align:left;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}\n.xhe-option:hover,.xhe-option:focus-visible{border-color:var(--dsw-alias-label-secondary);outline:none}\n.xhe-option[aria-pressed=true]{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}\n.xhe-option strong{display:block;font-size:13px}.xhe-option span{display:block;margin-top:4px;font-size:11px;opacity:.7}\n.xhe-search{box-sizing:border-box;width:100%;height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}\n.xhe-search:focus-visible,.xhe-key:focus-visible,.xhe-reset:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}\n.xhe-shortcuts{display:grid;gap:0;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;overflow:hidden}\n.xhe-shortcut{display:flex;align-items:center;gap:12px;min-height:46px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}.xhe-shortcut:last-child{border-bottom:0}\n.xhe-shortcut span{flex:1;min-width:0;font-size:12px}.xhe-key,.xhe-reset{font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px}\n.xhe-key[data-recording=true]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}\n.xhe-note{color:var(--dsw-alias-state-error-primary)!important}.xhe-footer{display:flex;justify-content:flex-end;margin-top:9px}\n@media(max-width:700px){.xhe-options{grid-template-columns:repeat(2,minmax(0,1fr))}}\n\n/* Consent is a small native-top-layer modal, not an onboarding takeover. */\n.xhi-dialog{width:min(460px,100%)!important;padding:0!important;border-radius:20px!important;max-height:calc(100dvh - 48px);overflow:auto!important}\n.xhi-card{box-sizing:border-box;width:100%;padding:30px;color:var(--dsw-alias-label-primary);font-family:inherit}\n.xhi-card h2{margin:0 0 14px;font-size:23px;line-height:1.25;font-weight:600;letter-spacing:-.025em}\n.xhi-card p{margin:10px 0;font-size:14px;line-height:1.65;color:var(--dsw-alias-label-secondary)}\n.xhi-links{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:18px;color:var(--dsw-alias-label-secondary)}\n.xhi-links button{border:0;padding:2px 0;background:transparent;color:inherit;font:inherit;font-size:12px;text-decoration:underline;text-underline-offset:3px;cursor:pointer}\n.xhi-card .xhi-disclosure{padding:12px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;font-size:12px}\n.xhi-disclosure p{font-size:12px}\n.xhi-disclosure p:first-child{margin-top:0}.xhi-disclosure p:last-child{margin-bottom:0}\n.xhi-actions{display:flex;gap:10px;margin-top:26px}\n.xhi-actions button{flex:1;min-width:0;min-height:44px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:500;cursor:pointer}\n.xhi-actions .xhi-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-label-primary)}\n.xhi-card button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}\n.xhi-card button:disabled{opacity:.55;cursor:wait}\n.xhi-card .xhi-error{color:var(--dsw-alias-state-error-primary);font-size:12px}\n@media(max-width:480px){.xhi-card{padding:24px}.xhi-card h2{font-size:21px}.xhi-links{gap:8px}}\n";

},
"src/modules/shared/process-display.js": function(module, exports, require) {
// source: src/modules/shared/process-display.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROCESS_MODE_KEY = void 0;
exports.normalizeProcessMode = normalizeProcessMode;
exports.useProcessMode = useProcessMode;
const react_1 = require("react");
exports.PROCESS_MODE_KEY = 'xharness.ui.process-mode.v1';
function normalizeProcessMode(value) {
    // Keep the old preference key: no data migration or destructive storage reset.
    return value === 'expanded' || value === 'verbose' ? 'expanded' : 'auto';
}
function useProcessMode() {
    const read = () => normalizeProcessMode(typeof document === 'undefined' ? undefined : document.documentElement.dataset.xhProcessMode);
    const [mode, setMode] = (0, react_1.useState)(read);
    (0, react_1.useEffect)(() => {
        const update = () => { setMode(read()); };
        window.addEventListener('xh-process-mode', update);
        update();
        return () => { window.removeEventListener('xh-process-mode', update); };
    }, []);
    return mode;
}

},
"src/modules/experience/InstallationStatistics.js": function(module, exports, require) {
// source: src/modules/experience/InstallationStatistics.tsx

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.statisticsLabels = void 0;
exports.decodeStatus = decodeStatus;
exports.InstallationStatistics = InstallationStatistics;
const React = __importStar(require("react"));
const h = React.createElement;
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function decodeStatus(value) {
    if (!isRecord(value))
        throw new Error('Invalid statistics status');
    const s = value;
    if ((s.noticeRequired !== undefined && typeof s.noticeRequired !== 'boolean') || typeof s.enabled !== 'boolean' || typeof s.configured !== 'boolean' || typeof s.deletionPending !== 'boolean'
        || typeof s.pendingReports !== 'number' || !Number.isSafeInteger(s.pendingReports) || s.pendingReports < 0 || s.pendingReports > 64
        || typeof s.droppedEvents !== 'number' || !Number.isSafeInteger(s.droppedEvents) || s.droppedEvents < 0
        || (s.error !== null && typeof s.error !== 'string'))
        throw new Error('Invalid statistics status');
    return { noticeRequired: s.noticeRequired === true, enabled: s.enabled, configured: s.configured, deletionPending: s.deletionPending, pendingReports: s.pendingReports, droppedEvents: s.droppedEvents, error: s.error };
}
exports.statisticsLabels = {
    zh: { nav: '安装统计与隐私', title: '安装统计与隐私', intro: '自愿帮助我们了解安装量、版本分布和更新成功率。默认关闭，不影响 AI 和更新功能。',
        privacy: '仅发送随机安装 ID、版本、系统、架构、通道和启动 / 更新结果。不发送对话、图片、密钥、文件路径或硬件标识。',
        retention: '原始事件保存 90 天；连续 365 天未上报的安装移除。关闭后清除本机待发事件并申请删除服务端设备记录；离线时延后删除，期间不再上报。',
        enabled: '安装统计已开启', disabled: '安装统计已关闭', enable: '开启统计', disable: '关闭并删除记录', pending: '条记录待补发', deletion: '删除请求待联网完成。完成前不能重新开启。',
        web: '此设置仅用于桌面软件；普通 Web 页面不会登记为一次安装。', unavailable: '此构建未配置统计服务，无法开启。', error: '统计暂时不可用，不影响任务；没有发送日志或错误正文。', loading: '读取设置中…', busy: '正在保存…', retrySave: '重试保存关闭设置', unsavedOff: '统计已停止，但关闭设置尚未保存。请修复存储后重试；重启可能恢复旧设置。' },
    en: { nav: 'Installation statistics & privacy', title: 'Installation statistics & privacy', intro: 'Optionally help us understand installs, versions and successful updates. Off by default; AI and updates work independently.',
        privacy: 'Sends only a random installation ID, version, OS, architecture, channel and startup / update outcomes. Never conversations, images, keys, paths or hardware identifiers.',
        retention: 'Raw events expire after 90 days; devices inactive for 365 days are removed. Opting out clears queued events and requests server deletion. Offline deletion waits for connectivity; reporting stops immediately.',
        enabled: 'Installation statistics enabled', disabled: 'Installation statistics disabled', enable: 'Enable statistics', disable: 'Disable & delete records', pending: 'reports queued', deletion: 'Deletion awaits connectivity. Re-enabling requires deletion to finish.',
        web: 'Desktop only. Ordinary Web pages are not registered as installations.', unavailable: 'This build has no configured statistics service.', error: 'Statistics unavailable; tasks are unaffected. Logs and error bodies are not reported.', loading: 'Reading settings…', busy: 'Saving…', retrySave: 'Retry saving opt-out', unsavedOff: 'Reporting stopped, but opt-out could not be saved. Fix storage and retry; a restart may restore the old preference.' },
};
function InstallationStatistics({ t }) {
    const invoke = window.__TAURI__?.core?.invoke;
    const [status, setStatus] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const epoch = React.useRef(0);
    const pending = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        if (!invoke)
            return;
        let active = true;
        mounted.current = true;
        const refresh = async () => { if (pending.current)
            return; const id = ++epoch.current; try {
            const next = decodeStatus(await invoke('desktop_installation_status'));
            if (active && id === epoch.current) {
                setStatus(next);
                setError(false);
            }
        }
        catch {
            if (active && id === epoch.current)
                setError(true);
        } };
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 5000);
        return () => { active = false; mounted.current = false; ++epoch.current; window.clearInterval(timer); };
    }, [invoke]);
    async function toggle() {
        if (!invoke || !status || pending.current || busy)
            return;
        const id = ++epoch.current;
        pending.current = true;
        setBusy(true);
        setError(false);
        try {
            const next = decodeStatus(await invoke('desktop_set_installation_statistics', { enabled: status.error === 'statistics_optout_not_persisted' ? false : !status.enabled }));
            if (mounted.current && id === epoch.current)
                setStatus(next);
        }
        catch {
            if (mounted.current && id === epoch.current) {
                setError(true);
                try {
                    const next = decodeStatus(await invoke('desktop_installation_status'));
                    if (mounted.current && id === epoch.current)
                        setStatus(next);
                }
                catch { /* retain visible error */ }
            }
        }
        finally {
            pending.current = false;
            if (mounted.current)
                setBusy(false);
        }
    }
    return h('div', { className: 'xhe-root' }, [
        h('header', { key: 'header' }, [h('h2', { key: 'title' }, t('title')), h('p', { key: 'intro' }, t('intro'))]),
        h('section', { key: 'settings' }, [h('p', { key: 'privacy' }, t('privacy')), h('p', { key: 'retention' }, t('retention')),
            !invoke ? h('p', { key: 'web', role: 'status' }, t('web')) : status ? h(React.Fragment, { key: 'status' }, [
                h('h3', { key: 'label' }, t(status.enabled ? 'enabled' : 'disabled')),
                !status.configured && h('p', { key: 'unconfigured' }, t('unavailable')),
                status.deletionPending && h('p', { key: 'deletion', role: 'status' }, t('deletion')),
                status.pendingReports > 0 && h('p', { key: 'pending' }, `${status.pendingReports} ${t('pending')}`),
                h('button', { key: 'toggle', className: 'xhe-reset', type: 'button', disabled: busy || (!status.enabled && status.error !== 'statistics_optout_not_persisted' && (!status.configured || status.deletionPending)), onClick: toggle }, t(busy ? 'busy' : status.error === 'statistics_optout_not_persisted' ? 'retrySave' : status.enabled ? 'disable' : 'enable')),
            ]) : !error && h('p', { key: 'loading' }, t('loading')),
            (error || status?.error) && h('p', { key: 'error', role: 'alert', className: 'xhe-note' }, t(status?.error === 'statistics_optout_not_persisted' ? 'unsavedOff' : 'error')),
        ]),
    ]);
}

}
};
const __dependencies = {"src/modules/experience/index.js":{"./Experience.css":"src/modules/experience/Experience.css","../shared/process-display":"src/modules/shared/process-display.js","./InstallationStatistics":"src/modules/experience/InstallationStatistics.js"},"src/modules/experience/Experience.css":{},"src/modules/shared/process-display.js":{},"src/modules/experience/InstallationStatistics.js":{}};
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
return __load("src/modules/experience/index.js");
}
});
