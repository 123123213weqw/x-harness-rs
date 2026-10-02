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
 * Provide the download controller and mount its modal into the Session Header.
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
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const Dialog_1 = require("./Dialog");
const HeaderAction_styles_1 = __importDefault(require("./HeaderAction.styles"));
/**
 * Render the Session Header export capsule and its shared result dialog.
 * @param props - Session runtime, download controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
function SessionLogDownloadHeaderAction(props) {
    const { sessionId, useSessionLogDownload, request } = props;
    const entry = useSessionLogDownload(state => state.bySession[String(sessionId)]);
    const busy = entry?.status === 'downloading';
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: HeaderAction_styles_1.default.sessionLogButton, disabled: busy, "aria-busy": busy, onClick: () => { void request(sessionId); }, children: [(0, jsx_runtime_1.jsx)("span", { children: "Session log" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDownloadOutline16, { size: 12 })] }), (0, jsx_runtime_1.jsx)(Dialog_1.SessionLogDownloadDialog, { ...props })] }));
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
exports.default = { sessionLogButton: 'SPhQuq_sessionLogButton' };

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
exports.default = ".SPhQuq_sessionLogButton {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-width: 111px;\n  height: 32px;\n  padding: 6px 12px;\n  gap: 4px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 18px;\n  color: var(--dsw-alias-label-primary);\n  background: transparent;\n  font-family: var(--dsw-font-family);\n  font-size: 13px;\n  font-weight: 400;\n  line-height: 20px;\n  cursor: pointer;\n}\n\n.SPhQuq_sessionLogButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.SPhQuq_sessionLogButton:disabled {\n  color: var(--dsw-alias-label-dimmed);\n  cursor: wait;\n}\n\n.SPhQuq_sessionLogButton span,\n.SPhQuq_sessionLogButton svg {\n  flex: none;\n}\n\n.SPhQuq_sessionLogButton span {\n  white-space: nowrap;\n}\n";

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
    'dialog.preparingTitle': '正在导出 Session',
    'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
    'dialog.successTitle': 'Session 导出已开始下载',
    'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
    'dialog.errorTitle': 'Session 导出失败',
    'dialog.close': '关闭',
    'dialog.commandFailed': '无法启动 Session 导出。',
};
/** English Session export strings. */
exports.en = {
    'dialog.preparingTitle': 'Exporting Session',
    'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
    'dialog.successTitle': 'Session download started',
    'dialog.successDescription': 'The browser is downloading the Session ZIP.',
    'dialog.errorTitle': 'Session export failed',
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
