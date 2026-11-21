// Generated from src/modules/session-log-export/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-session-log-export",
factory: (__externalRequire) => {
const __units = {
"src/modules/session-log-export/index.js": function(module, exports, require) {
// source: src/modules/session-log-export/index.ts

"use strict";
/** Browser plugin owning Session export download state and its shared modal. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const controller_1 = require("./controller");
const HeaderAction_1 = require("./HeaderAction");
const locales_1 = require("./locales");
exports.inject = ['slots', 'locale'];
/**
 * Provide the download controller and the Session Header help menu/result modal.
 * @param ctx - browser context carrying slots and locale services.
 */
function apply(ctx) {
    const controller = new controller_1.SessionLogDownloadController();
    ctx.provide('sessionLogDownload', controller);
    ctx.effect(() => async () => { await controller.dispose(); }, 'session-log-download: browser download lifecycle');
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'session-log-download: browser dictionaries');
    ctx.on('command/executed', (sessionId, commandName, result) => {
        if (commandName === 'export' && result.kind === 'success')
            void controller.download(sessionId);
    });
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'session-log-download',
        locale: locales_1.NS,
        inject: () => ({
            hooks: { sessionLogDownload: controller.store },
            request: (sessionId) => controller.download(sessionId),
            dismiss: (sessionId) => { controller.dismiss(sessionId); },
        }),
    }, HeaderAction_1.SessionLogDownloadHeaderAction));
}

},
"src/modules/session-log-export/controller.js": function(module, exports, require) {
// source: src/modules/session-log-export/controller.ts

"use strict";
/** Browser download state shared by the Session Header button and `/export`. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionLogDownloadController = void 0;
exports.sessionLogZipFilename = sessionLogZipFilename;
exports.downloadUrl = downloadUrl;
const client_1 = require("@xharness/dsh-client-runtime/client");
const INITIAL = { bySession: {} };
/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
function sessionLogZipFilename(sessionId) {
    return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;
}
/**
 * Hand a Host download URL to the browser download manager.
 * @param url - same-origin Host download URL.
 * @param filename - browser download filename.
 */
function downloadUrl(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
}
/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase() {
    const origin = globalThis.location?.origin;
    return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal';
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Owns one in-flight browser download per Session and publishes modal state. */
class SessionLogDownloadController {
    /**
     * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
     * @param save - browser save operation.
     */
    constructor(fetcher = (input, init) => fetch(input, init), save = downloadUrl) {
        this.fetcher = fetcher;
        this.save = save;
        /** uSES-safe state source shared by every Session-scoped modal contribution. */
        this.store = (0, client_1.createSnapshotStore)(INITIAL);
        this.active = new Map();
        this.disposed = false;
    }
    /**
     * Download one Session tree; concurrent gestures for the same Session share one operation.
     * @param sessionId - root Session whose ZIP includes descendants and attachments.
     * @returns after the browser save starts, an error state is published, or a late post-disposal request is ignored.
     */
    download(sessionId) {
        const existing = this.active.get(sessionId);
        if (existing !== undefined)
            return existing.done;
        if (this.disposed)
            return Promise.resolve();
        const abort = new AbortController();
        const done = this.run(sessionId, abort.signal).finally(() => {
            this.active.delete(sessionId);
        });
        this.active.set(sessionId, { abort, done });
        return done;
    }
    /**
     * Close one Session's dialog without cancelling an in-flight browser download.
     * @param sessionId - Session whose modal closes.
     */
    dismiss(sessionId) {
        const current = this.store.getSnapshot().bySession[String(sessionId)];
        if (current === undefined || !current.open)
            return;
        this.publish(sessionId, { ...current, open: false });
    }
    /**
     * Abort active fetches and reach quiescence.
     * @returns after every active operation settles.
     */
    async dispose() {
        this.disposed = true;
        const active = [...this.active.values()];
        for (const operation of active)
            operation.abort.abort();
        await Promise.allSettled(active.map(operation => operation.done));
    }
    async run(sessionId, signal) {
        this.publish(sessionId, { open: true, status: 'downloading', error: null });
        try {
            const url = new URL('/api/session.export', hostBase());
            url.searchParams.set('sessionId', sessionId);
            url.searchParams.set('includeDescendants', 'true');
            const response = await this.fetcher(url, { method: 'HEAD', signal });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`);
            }
            this.save(url.toString(), sessionLogZipFilename(sessionId));
            const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true;
            this.publish(sessionId, { open, status: 'success', error: null });
        }
        catch (error) {
            if (signal.aborted)
                return;
            const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true;
            this.publish(sessionId, { open, status: 'error', error: messageOf(error) });
        }
    }
    publish(sessionId, entry) {
        this.store.update((state) => {
            state.bySession = { ...state.bySession, [String(sessionId)]: entry };
        });
    }
}
exports.SessionLogDownloadController = SessionLogDownloadController;

},
"src/modules/session-log-export/HeaderAction.js": function(module, exports, require) {
// source: src/modules/session-log-export/HeaderAction.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionLogDownloadHeaderAction = SessionLogDownloadHeaderAction;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const Dialog_1 = require("./Dialog");
const HeaderAction_styles_1 = __importDefault(require("./HeaderAction.styles"));
const DOCUMENTATION = 'https://github.com/123123213weqw/XHarness#readme';
const REPORT_ISSUE = 'https://github.com/123123213weqw/XHarness/issues/new/choose';
function openSupportLink(href) {
    // Fixed destinations, never populated with Session IDs, logs or user data.
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
}
/** The menu belongs to one Session. Its result dialog also serves /export. */
function SessionLogDownloadHeaderAction(props) {
    return (0, jsx_runtime_1.jsx)(SessionHelpMenu, { ...props }, props.sessionId);
}
function SessionHelpMenu(props) {
    const { sessionId, useSessionLogDownload, request, t } = props;
    const [open, setOpen] = (0, react_1.useState)(false);
    const menuId = (0, react_1.useId)();
    const trigger = (0, react_1.useRef)(null);
    const focusLast = (0, react_1.useRef)(false);
    const entry = useSessionLogDownload(state => state.bySession[sessionId]);
    const busy = entry?.status === 'downloading';
    const showMenu = open && entry?.open !== true;
    const close = (0, react_1.useCallback)(() => { setOpen(false); }, []);
    const choices = (0, react_1.useCallback)(() => Array.from(document.getElementById(menuId)?.querySelectorAll('button[role="menuitem"]:not(:disabled)') ?? []), [menuId]);
    (0, react_1.useEffect)(() => {
        if (!showMenu)
            return;
        // The portaled menu measures itself hidden first; wait until it is placed.
        const frame = window.requestAnimationFrame(() => {
            const rows = choices();
            rows.at(focusLast.current ? -1 : 0)?.focus({ preventScroll: true });
        });
        return () => { window.cancelAnimationFrame(frame); };
    }, [showMenu, choices]);
    (0, react_1.useEffect)(() => { if (entry?.open === true)
        close(); }, [entry?.open, close]);
    const onKeyDown = (event) => {
        if (!open && event.target === trigger.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            focusLast.current = event.key === 'ArrowUp';
            setOpen(true);
            return;
        }
        if (!open)
            return;
        if (event.key === 'Tab') {
            close();
            trigger.current?.focus({ preventScroll: true });
            return;
        }
        const rows = choices();
        if (rows.length === 0)
            return;
        const current = rows.findIndex(row => row === document.activeElement);
        let next;
        if (event.key === 'ArrowDown')
            next = (current + 1) % rows.length;
        else if (event.key === 'ArrowUp')
            next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
        else if (event.key === 'Home')
            next = 0;
        else if (event.key === 'End')
            next = rows.length - 1;
        else
            return;
        event.preventDefault();
        rows[next]?.focus();
    };
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: HeaderAction_styles_1.default.root, onKeyDown: onKeyDown, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { id: menuId, label: t('help.label'), listClassName: HeaderAction_styles_1.default.helpMenu, open: showMenu, portal: true, dense: true, align: "end", onClose: close, items: [
                        { id: 'docs', label: t('help.docs'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBrowseOutline16, {}) },
                        { id: 'issue', label: t('help.issue'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconListPenOutline16, {}) },
                        { type: 'separator', id: 'diagnostics' },
                        { id: 'export', label: t('help.export'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDownloadOutline16, {}), disabled: busy },
                    ], onSelect: id => {
                        close();
                        trigger.current?.focus({ preventScroll: true });
                        if (id === 'docs')
                            openSupportLink(DOCUMENTATION);
                        else if (id === 'issue')
                            openSupportLink(REPORT_ISSUE);
                        else if (id === 'export' && !busy)
                            void request(sessionId);
                    }, anchor: (0, jsx_runtime_1.jsx)("button", { ref: trigger, type: "button", className: HeaderAction_styles_1.default.helpButton, title: t('help.label'), "aria-label": t('help.label'), "aria-haspopup": "menu", "aria-expanded": showMenu, "aria-controls": showMenu ? menuId : undefined, onClick: () => {
                            focusLast.current = false;
                            setOpen(value => !value);
                        }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconQuestionOutline14, { size: 16 }) }) }) }), (0, jsx_runtime_1.jsx)(Dialog_1.SessionLogDownloadDialog, { ...props })] });
}

},
"src/modules/session-log-export/Dialog.js": function(module, exports, require) {
// source: src/modules/session-log-export/Dialog.tsx

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
exports.SessionLogDownloadDialog = SessionLogDownloadDialog;
const jsx_runtime_1 = require("react/jsx-runtime");
const Primitives = __importStar(require("@xharness/dsh-client-ui-primitives"));
const Button = Primitives.Button;
const Modal = Primitives.Modal;
/**
 * Modal shared by the Session Header button and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
function SessionLogDownloadDialog({ sessionId, useSessionLogDownload, dismiss, t, }) {
    const entry = useSessionLogDownload(state => state.bySession[String(sessionId)]);
    const status = entry?.status;
    const open = entry?.open === true;
    const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null;
    const title = status === 'downloading'
        ? t('dialog.preparingTitle')
        : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle');
    const description = status === 'downloading'
        ? t('dialog.preparingDescription')
        : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed');
    return ((0, jsx_runtime_1.jsx)(Modal, { open: open, onClose: () => { dismiss(sessionId); }, title: title, description: description, closeLabel: t('dialog.close'), footer: (0, jsx_runtime_1.jsx)(Button, { variant: "primary", onClick: () => { dismiss(sessionId); }, children: t('dialog.close') }) }));
}

},
"src/modules/session-log-export/HeaderAction.styles.js": function(module, exports, require) {
// source: src/modules/session-log-export/HeaderAction.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const foundation_styles_1 = require("../shared/foundation-styles");
const HeaderAction_css_1 = __importDefault(require("./HeaderAction.css"));
(0, foundation_styles_1.installStyles)('@xharness/dsh-session-log-export/HeaderAction.module.css', '@xharness/dsh-session-log-export', HeaderAction_css_1.default);
exports.default = { root: 'SPhQuq_helpRoot', helpButton: 'SPhQuq_helpButton', helpMenu: 'SPhQuq_helpMenu' };

},
"src/modules/shared/foundation-styles.js": function(module, exports, require) {
// source: src/modules/shared/foundation-styles.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installStyles = installStyles;
/** Runs at ModuleLoader factory materialization, never during script registration. */
function installStyles(tagId, plugin, css) {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = plugin;
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
}

},
"src/modules/session-log-export/HeaderAction.css": function(module, exports, require) {
// source: src/modules/session-log-export/HeaderAction.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".SPhQuq_helpRoot {\n  display: inline-flex;\n  flex: none;\n}\n\n.SPhQuq_helpButton {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  padding: 0;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.SPhQuq_helpButton:hover,\n.SPhQuq_helpButton[aria-expanded='true'] {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.SPhQuq_helpButton:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 2px;\n}\n\n/* The support card must remain distinct from either chat surface. The\n   scrolling menu viewport clips outside outlines, so focus stays inside. */\n.SPhQuq_helpMenu[role='menu'] {\n  border-color: var(--dsw-alias-border-l2);\n  box-shadow: var(--dsw-shadow-lv3, 0 5px 18px rgb(0 0 0 / 14%));\n}\n\n.SPhQuq_helpMenu [role='menuitem']:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: -2px;\n}\n";

},
"src/modules/session-log-export/locales.js": function(module, exports, require) {
// source: src/modules/session-log-export/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Locale namespace owned by Session export browser feedback. */
exports.NS = 'session-log-download';
/** Simplified-Chinese Session export strings. */
exports.zh = {
    'help.label': '帮助与诊断',
    'help.docs': '产品文档',
    'help.issue': '反馈问题',
    'help.export': '导出当前对话日志',
    'dialog.preparingTitle': '正在导出对话日志',
    'dialog.preparingDescription': '正在准备包含当前对话、子会话 和附件的 ZIP 文件。',
    'dialog.successTitle': '对话日志已开始下载',
    'dialog.successDescription': '浏览器正在下载对话日志 ZIP 文件。',
    'dialog.errorTitle': '对话日志导出失败',
    'dialog.close': '关闭',
    'dialog.commandFailed': '无法开始导出对话日志。',
};
/** English Session export strings. */
exports.en = {
    'help.label': 'Help and diagnostics',
    'help.docs': 'Product docs',
    'help.issue': 'Report an issue',
    'help.export': 'Export current chat logs',
    'dialog.preparingTitle': 'Exporting chat logs',
    'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
    'dialog.successTitle': 'Chat log download started',
    'dialog.successDescription': 'The browser is downloading the Session ZIP.',
    'dialog.errorTitle': 'Chat log export failed',
    'dialog.close': 'Close',
    'dialog.commandFailed': 'Could not start the Session export.',
};

}
};
const __dependencies = {"src/modules/session-log-export/index.js":{"./controller":"src/modules/session-log-export/controller.js","./HeaderAction":"src/modules/session-log-export/HeaderAction.js","./locales":"src/modules/session-log-export/locales.js"},"src/modules/session-log-export/controller.js":{},"src/modules/session-log-export/HeaderAction.js":{"./Dialog":"src/modules/session-log-export/Dialog.js","./HeaderAction.styles":"src/modules/session-log-export/HeaderAction.styles.js"},"src/modules/session-log-export/Dialog.js":{},"src/modules/session-log-export/HeaderAction.styles.js":{"../shared/foundation-styles":"src/modules/shared/foundation-styles.js","./HeaderAction.css":"src/modules/session-log-export/HeaderAction.css"},"src/modules/shared/foundation-styles.js":{},"src/modules/session-log-export/HeaderAction.css":{},"src/modules/session-log-export/locales.js":{}};
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
return __load("src/modules/session-log-export/index.js");
}
});
