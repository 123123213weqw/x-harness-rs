// Generated from src/modules/deliverables/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-deliverables",
factory: (__externalRequire) => {
const __units = {
"src/modules/deliverables/index.js": function(module, exports, require) {
// source: src/modules/deliverables/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.producedForClosing = exports.ProducedFiles = void 0;
exports.apply = apply;
/**
 * Deliverables plugin, browser half: registers the produced-files row into
 * the chat view's turn-tail chain, and provides the `chatFileMentions`
 * service that links inline-code mentions of produced files in the closing
 * prose. All policy lives here — the derivation from the mutation tools'
 * `locations`, the mention matching, the bounded file cards, and the copy — so
 * composing this plugin out of cordis.yml removes both surfaces entirely;
 * the owning view renders an empty chain and inert prose at zero cost.
 */
const path_1 = require("../client-runtime/workspaces/path");
const ProducedFiles_1 = require("./ProducedFiles");
const file_inspection_1 = require("../shared/file-inspection");
const locales_1 = require("./locales");
const turn_deliverables_1 = require("./turn-deliverables");
var ProducedFiles_2 = require("./ProducedFiles");
Object.defineProperty(exports, "ProducedFiles", { enumerable: true, get: function () { return ProducedFiles_2.ProducedFiles; } });
var turn_deliverables_2 = require("./turn-deliverables");
Object.defineProperty(exports, "producedForClosing", { enumerable: true, get: function () { return turn_deliverables_2.producedForClosing; } });
/** Required services for the tail-slot registration and its dictionaries. */
exports.inject = ['slots', 'locale', 'conversationEvents', 'connection', 'sessions'];
/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const connection = ctx.get('connection');
    const sessions = ctx.get('sessions');
    const inspections = new file_inspection_1.FileInspectionCache(connection.rpc);
    ctx.conversationEvents.register(turn_deliverables_1.deliverablesDefinition);
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-deliverables: dictionaries');
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select: turn_deliverables_1.selectProducedFiles,
        locale: locales_1.NS,
        inject: (sessionId) => {
            const resolveFilePath = (path) => {
                const row = sessions.list.getSnapshot().byId[sessionId];
                const cwd = typeof row === 'object' && row !== null && 'cwd' in row && typeof row.cwd === 'string' ? row.cwd : undefined;
                return (0, path_1.resolveWorkspacePath)(cwd, path);
            };
            return ({
                resolveFilePath,
                inspectFile: (path, revision, thumbnail, signal) => inspections.read(sessionId, path, revision, thumbnail, signal),
                isLoopback: connection.isLoopback,
                hooks: { hostDescription: connection.hostDescription },
                openNativeFile: async (path, mode) => {
                    const capability = connection.hostDescription.getSnapshot();
                    if (!connection.isLoopback || capability?.canOpenPath !== true
                        || (mode === 'reveal' && capability.canRevealPath !== true)) {
                        throw new Error('Native file opening is unavailable on this connection');
                    }
                    const row = sessions.list.getSnapshot().byId[sessionId];
                    const cwd = typeof row === 'object' && row !== null && 'cwd' in row
                        && typeof row.cwd === 'string' ? row.cwd : undefined;
                    const resolved = (0, path_1.resolveWorkspacePath)(cwd, path);
                    if (!(resolved.startsWith('/') || /^[a-z]:[\\/]/i.test(resolved) || resolved.startsWith('\\\\')) || resolved.includes('\0')) {
                        throw new Error('Native file opening requires a resolved absolute path');
                    }
                    const reply = await connection.api.host.openPath({ path: resolved, ...(mode === 'reveal' ? { mode } : {}) });
                    if (!reply.result.ok)
                        throw new Error(reply.result.error.message);
                },
            });
        },
    }, ProducedFiles_1.ProducedFiles));
    // The prose side of the same vocabulary: the chat view reaches this face
    // via ctx.get, so its absence — this plugin composed out — is the off state.
    const t = ctx.locale.bind(locales_1.NS);
    const mentions = {
        forClosing(owner) {
            // Same claim test the turn-tail chain entry runs: no produced files,
            // no vocabulary — the two surfaces agree by construction.
            const paths = (0, turn_deliverables_1.selectProducedFiles)(owner);
            if (paths === null)
                return undefined;
            return (0, turn_deliverables_1.producedFileMentions)(paths, owner.openFile, path => t('produced.open', { name: path }));
        },
    };
    ctx.provide('chatFileMentions', mentions);
}

},
"src/modules/client-runtime/workspaces/path.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/path.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkspacePath = resolveWorkspacePath;
exports.abbreviateHomePath = abbreviateHomePath;
/**
 * Resolve a workspace-relative path into the Host-facing spelling used by openPath.
 * @param cwd - session workspace root, when known.
 * @param path - absolute or workspace-relative path.
 * @returns an absolute path when a workspace root is available, otherwise the original path.
 */
function resolveWorkspacePath(cwd, path) {
    if (path.startsWith('/') || isWindowsStylePath(path))
        return path;
    if (cwd === undefined || cwd === '')
        return path;
    const base = cwd.replace(/[/\\]+$/, '');
    const rel = path.replace(/^[/\\]+/, '');
    return `${base}/${rel}`;
}
/** Drive-letter or UNC path; Web display must not rewrite these as `~`. */
function isWindowsStylePath(value) {
    return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\');
}
/**
 * Display-only POSIX home abbreviation. Windows drive and UNC paths stay
 * verbatim, including when `home` itself is a Windows path. A missing, empty,
 * or filesystem-root `home` leaves `path` unchanged so `/` cannot become `~`.
 * @param path - absolute or already-short display path.
 * @param home - host account home from `host.describe`; absent skips abbreviation.
 * @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
 */
function abbreviateHomePath(path, home) {
    if (home === undefined || home === '')
        return path;
    if (isWindowsStylePath(path) || isWindowsStylePath(home))
        return path;
    const root = home.replace(/\/+$/, '');
    if (root === '' || root === '/')
        return path;
    if (path.replace(/\/+$/, '') === root)
        return '~';
    if (path.startsWith(`${root}/`))
        return `~${path.slice(root.length)}`;
    return path;
}

},
"src/modules/deliverables/ProducedFiles.js": function(module, exports, require) {
// source: src/modules/deliverables/ProducedFiles.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProducedFiles = ProducedFiles;
const jsx_runtime_1 = require("react/jsx-runtime");
// Evidence comes from successful mutation tools, never the assistant's prose.
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const file_kind_1 = require("./file-kind");
const file_inspection_1 = require("../shared/file-inspection");
const turn_deliverables_1 = require("./turn-deliverables");
const ProducedFiles_styles_1 = __importDefault(require("./ProducedFiles.styles"));
const icons = { website: dsh_client_ui_primitives_1.IconGlobeOutline14, pdf: dsh_client_ui_primitives_1.IconPdfOutline24, markdown: dsh_client_ui_primitives_1.IconMarkdownOutline24, code: dsh_client_ui_primitives_1.IconCodeOutline16, image: dsh_client_ui_primitives_1.IconPhotoOutline24, spreadsheet: dsh_client_ui_primitives_1.IconSpreadsheetOutline24, presentation: dsh_client_ui_primitives_1.IconPresentationOutline24, document: dsh_client_ui_primitives_1.IconDocumentOutline24, video: dsh_client_ui_primitives_1.IconMovieOutline24, audio: dsh_client_ui_primitives_1.IconAudioOutline24, archive: dsh_client_ui_primitives_1.IconArchiveOutline20, data: dsh_client_ui_primitives_1.IconDatabaseOutline24, file: dsh_client_ui_primitives_1.IconFileOutline24 };
function useNearViewport(ref) {
    const [visible, setVisible] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        const element = ref.current;
        if (!element)
            return;
        if (typeof IntersectionObserver === 'undefined') {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '80px' });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return visible;
}
function FileCard({ path, revision, change, duplicate, openFile, openNativeFile, inspectFile, resolveFilePath, canOpen, canReveal, t }) {
    const [menuOpen, setMenuOpen] = (0, react_1.useState)(false), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(''), [feedback, setFeedback] = (0, react_1.useState)(''), [details, setDetails] = (0, react_1.useState)(false);
    const [info, setInfo] = (0, react_1.useState)(), [url, setUrl] = (0, react_1.useState)(), [imageFailed, setImageFailed] = (0, react_1.useState)(false);
    const menuId = (0, react_1.useId)(), detailId = (0, react_1.useId)(), trigger = (0, react_1.useRef)(null), card = (0, react_1.useRef)(null), visible = useNearViewport(card);
    const type = (0, file_kind_1.fileType)(path), Icon = icons[type.kind];
    const preview = info ? ['text', 'markdown', 'image', 'pdf'].includes(info.preview) : type.preview !== 'none';
    const close = () => setMenuOpen(false);
    (0, react_1.useEffect)(() => {
        if (!visible || !inspectFile)
            return;
        const controller = new AbortController();
        void inspectFile(path, revision, type.kind === 'image', controller.signal).then(value => { if (!controller.signal.aborted)
            setInfo(value); }).catch(() => { });
        return () => controller.abort();
    }, [visible, inspectFile, path, revision, type.kind]);
    (0, react_1.useEffect)(() => {
        if (!visible || !info?.thumbnail) {
            setUrl(undefined);
            return;
        }
        let next;
        try {
            next = (0, file_inspection_1.thumbnailObjectUrl)(info);
            setImageFailed(false);
            setUrl(next);
        }
        catch {
            setUrl(undefined);
        }
        return () => { if (next)
            URL.revokeObjectURL(next); };
    }, [info, visible]);
    (0, react_1.useEffect)(() => { if (!feedback)
        return; const timer = window.setTimeout(() => setFeedback(''), 1800); return () => window.clearTimeout(timer); }, [feedback]);
    (0, react_1.useEffect)(() => {
        if (!menuOpen)
            return;
        const frame = requestAnimationFrame(() => document.getElementById(menuId)?.querySelector('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }));
        return () => cancelAnimationFrame(frame);
    }, [menuOpen, menuId, preview]);
    const navigateMenu = (event) => {
        if (!menuOpen || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
            return;
        const menu = document.getElementById(menuId);
        if (!menu?.contains(event.target instanceof Node ? event.target : null))
            return;
        const entries = Array.from(menu.querySelectorAll('button[role="menuitem"]:not(:disabled)')), index = entries.findIndex(item => item === document.activeElement);
        const next = event.key === 'Home' ? entries[0] : event.key === 'End' ? entries.at(-1) : entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length];
        if (next) {
            event.preventDefault();
            next.focus({ preventScroll: true });
        }
    };
    const activate = () => { if (preview)
        openFile(path);
    else
        setDetails(value => !value); };
    const select = async (id) => {
        close();
        trigger.current?.focus({ preventScroll: true });
        setError('');
        if (id === 'preview') {
            if (preview)
                openFile(path);
            return;
        }
        if (id === 'info') {
            setDetails(true);
            return;
        }
        if (id === 'copy') {
            try {
                const full = resolveFilePath?.(info?.path ?? path) ?? info?.path ?? path;
                if (await (0, dsh_client_ui_primitives_1.writeClipboard)(full))
                    setFeedback(t('produced.copied'));
                else
                    setError(t('produced.copyFailed'));
            }
            catch {
                setError(t('produced.copyFailed'));
            }
            return;
        }
        if (id !== 'open' && id !== 'reveal')
            return;
        setBusy(true);
        try {
            await openNativeFile(path, id);
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const items = [preview ? { id: 'preview', label: t('produced.preview') } : { id: 'info', label: t('produced.info') }];
    if (canReveal)
        items.push({ id: 'reveal', label: t('produced.showInFolder'), disabled: busy });
    if (canOpen)
        items.push({ id: 'open', label: t('produced.external'), disabled: busy });
    items.push({ id: 'copy', label: t('produced.copyPath') });
    const metadata = [t(`produced.type.${type.kind}`), info ? (0, file_kind_1.formatFileSize)(info.bytes) : '', info?.width && info.height ? `${info.width} × ${info.height}` : ''].filter(Boolean).join(' · ');
    return (0, jsx_runtime_1.jsxs)("div", { ref: card, className: ProducedFiles_styles_1.default.cardGroup, children: [(0, jsx_runtime_1.jsxs)("div", { className: ProducedFiles_styles_1.default.card, "data-kind": type.kind, onKeyDown: navigateMenu, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: ProducedFiles_styles_1.default.main, title: path, "aria-label": t(preview ? 'produced.previewFile' : 'produced.infoFile', { name: path }), "aria-description": [metadata, change ? t(`produced.${change}`) : ''].filter(Boolean).join(' · '), "aria-expanded": !preview ? details : undefined, "aria-controls": !preview && details ? detailId : undefined, onClick: activate, children: [(0, jsx_runtime_1.jsx)("span", { className: ProducedFiles_styles_1.default.icon, style: { color: type.color }, "aria-hidden": "true", children: url && !imageFailed ? (0, jsx_runtime_1.jsx)("img", { src: url, alt: "", decoding: "async", onError: () => setImageFailed(true) }) : (0, jsx_runtime_1.jsx)(Icon, { size: 22 }) }), (0, jsx_runtime_1.jsxs)("span", { className: ProducedFiles_styles_1.default.meta, children: [(0, jsx_runtime_1.jsxs)("span", { className: ProducedFiles_styles_1.default.title, children: [(0, jsx_runtime_1.jsx)("strong", { children: (0, file_kind_1.fileName)(path) }), change && (0, jsx_runtime_1.jsx)("span", { className: ProducedFiles_styles_1.default.badge, "data-change": change, children: t(`produced.${change}`) })] }), (0, jsx_runtime_1.jsx)("small", { children: metadata }), duplicate && (0, jsx_runtime_1.jsx)("small", { className: ProducedFiles_styles_1.default.parent, children: (0, file_kind_1.parentPath)(path) || '.' })] })] }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { id: menuId, open: menuOpen, portal: true, align: "end", compact: true, items: items, onClose: close, onSelect: id => { void select(id); }, anchor: (0, jsx_runtime_1.jsxs)("button", { ref: trigger, type: "button", className: ProducedFiles_styles_1.default.open, disabled: busy, "aria-busy": busy, "aria-label": t('produced.openInFile', { name: path }), "aria-haspopup": "menu", "aria-expanded": menuOpen, "aria-controls": menuOpen ? menuId : undefined, onClick: () => setMenuOpen(value => !value), onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                event.preventDefault();
                                setMenuOpen(true);
                            } }, children: [t('produced.openIn'), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 12 })] }) })] }), details && (0, jsx_runtime_1.jsxs)("div", { id: detailId, className: ProducedFiles_styles_1.default.details, role: "region", "aria-label": t('produced.infoFile', { name: path }), children: [(0, jsx_runtime_1.jsx)("p", { children: preview ? t('produced.info') : info?.preview === 'tooLarge' ? t('produced.tooLarge') : t('produced.noPreview') }), (0, jsx_runtime_1.jsx)("code", { children: info?.path ?? resolveFilePath?.(path) ?? path }), info?.modifiedMs != null && (0, jsx_runtime_1.jsxs)("small", { children: [t('produced.modifiedAt'), " ", (0, jsx_runtime_1.jsx)("time", { dateTime: new Date(info.modifiedMs).toISOString(), children: new Date(info.modifiedMs).toLocaleString() })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setDetails(false), children: t('produced.closeInfo') })] }), feedback && (0, jsx_runtime_1.jsx)("p", { className: ProducedFiles_styles_1.default.feedback, role: "status", children: feedback }), error && (0, jsx_runtime_1.jsx)("p", { role: "alert", className: ProducedFiles_styles_1.default.error, children: error })] });
}
/** Fold by default; large result sets expand in bounded pages instead of one huge DOM. */
function ProducedFiles({ matched: paths, openFile, openNativeFile, inspectFile, resolveFilePath, isLoopback, useHostDescription, t, turn, seq }) {
    const hostCanOpen = useHostDescription(value => value?.canOpenPath === true), hostCanReveal = useHostDescription(value => value?.canRevealPath === true);
    const [limit, setLimit] = (0, react_1.useState)(1), listId = (0, react_1.useId)();
    const artifacts = new Map((0, turn_deliverables_1.producedArtifactsForClosing)(turn?.data.get('deliverables'), seq).map(item => [item.path, item]));
    const counts = new Map();
    for (const path of paths)
        counts.set((0, file_kind_1.fileName)(path), (counts.get((0, file_kind_1.fileName)(path)) ?? 0) + 1);
    if (paths.length === 0)
        return null;
    const expanded = limit > 1, shown = paths.slice(0, limit), remaining = paths.length - shown.length;
    return (0, jsx_runtime_1.jsxs)("div", { className: ProducedFiles_styles_1.default.root, children: [(0, jsx_runtime_1.jsx)("div", { id: listId, className: ProducedFiles_styles_1.default.list, children: shown.map(path => { const fact = artifacts.get(path); return (0, jsx_runtime_1.jsx)(FileCard, { path: path, revision: fact?.seq ?? 0, change: fact?.change, duplicate: (counts.get((0, file_kind_1.fileName)(path)) ?? 0) > 1, openFile: openFile, openNativeFile: openNativeFile, inspectFile: inspectFile, resolveFilePath: resolveFilePath, canOpen: isLoopback && hostCanOpen, canReveal: isLoopback && hostCanOpen && hostCanReveal, t: t }, `${path}:${fact?.seq ?? 0}`); }) }), paths.length > 1 && (0, jsx_runtime_1.jsxs)("div", { className: ProducedFiles_styles_1.default.fold, children: [remaining > 0 && (0, jsx_runtime_1.jsxs)("button", { type: "button", className: ProducedFiles_styles_1.default.toggle, "aria-label": t(expanded ? 'produced.loadMore' : 'produced.actions'), "aria-expanded": expanded, "aria-controls": listId, onClick: () => setLimit(value => value === 1 ? 20 : value + 20), children: [t('produced.remaining', { count: String(remaining) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 12 })] }), expanded && (0, jsx_runtime_1.jsxs)("button", { type: "button", className: ProducedFiles_styles_1.default.toggle, "aria-label": t('produced.actions'), "aria-expanded": true, "aria-controls": listId, onClick: () => setLimit(1), children: [t('produced.collapse'), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronUpOutline14, { size: 12 })] })] })] });
}

},
"src/modules/deliverables/file-kind.js": function(module, exports, require) {
// source: src/modules/deliverables/file-kind.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatFileSize = exports.parentPath = exports.fileName = exports.fileType = exports.producedFileKind = void 0;
// Compatibility facade; format policy is shared with the workspace preview.
var file_types_1 = require("../shared/file-types");
Object.defineProperty(exports, "producedFileKind", { enumerable: true, get: function () { return file_types_1.producedFileKind; } });
Object.defineProperty(exports, "fileType", { enumerable: true, get: function () { return file_types_1.fileType; } });
Object.defineProperty(exports, "fileName", { enumerable: true, get: function () { return file_types_1.fileName; } });
Object.defineProperty(exports, "parentPath", { enumerable: true, get: function () { return file_types_1.parentPath; } });
Object.defineProperty(exports, "formatFileSize", { enumerable: true, get: function () { return file_types_1.formatFileSize; } });

},
"src/modules/shared/file-types.js": function(module, exports, require) {
// source: src/modules/shared/file-types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_TYPES = void 0;
exports.fileName = fileName;
exports.parentPath = parentPath;
exports.fileType = fileType;
exports.producedFileKind = producedFileKind;
exports.formatFileSize = formatFileSize;
const fallback = { kind: 'file', extensions: [], color: '#8c8e97', preview: 'none' };
exports.FILE_TYPES = [
    { kind: 'website', extensions: ['html', 'htm'], color: '#33caf2', preview: 'text' },
    { kind: 'pdf', extensions: ['pdf'], color: '#cb665d', preview: 'pdf' },
    { kind: 'markdown', extensions: ['md', 'markdown', 'mdown'], color: '#7488aa', preview: 'text' },
    { kind: 'code', extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'c', 'h', 'cpp', 'java', 'swift', 'sh', 'bash', 'zsh', 'json', 'css', 'toml', 'yaml', 'yml', 'sql', 'xml', 'ipynb', 'diff', 'patch'], color: '#7275ce', preview: 'text' },
    { kind: 'image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'heic', 'bmp', 'tiff'], color: '#4baf87', preview: 'image' },
    { kind: 'spreadsheet', extensions: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods'], color: '#398964', preview: 'none' },
    { kind: 'presentation', extensions: ['ppt', 'pptx', 'pptm', 'key', 'odp'], color: '#cf7b3e', preview: 'none' },
    { kind: 'document', extensions: ['doc', 'docx', 'docm', 'odt', 'pages', 'rtf', 'txt', 'log'], color: '#4b85cf', preview: 'none' },
    { kind: 'video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'], color: '#9b78bd', preview: 'none' },
    { kind: 'audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'], color: '#bd779f', preview: 'none' },
    { kind: 'archive', extensions: ['zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz'], color: '#a28a5a', preview: 'none' },
    { kind: 'data', extensions: ['sqlite', 'sqlite3', 'db', 'parquet', 'arrow'], color: '#5d9b9b', preview: 'none' },
    fallback,
];
function fileName(path) { return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1); }
function parentPath(path) { const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return at < 0 ? '' : path.slice(0, at) || path.slice(0, 1); }
function fileType(path) {
    const name = fileName(path), dot = name.lastIndexOf('.'), ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const type = exports.FILE_TYPES.find(item => item.extensions.includes(ext)) ?? fallback;
    // These small text formats share a visual category with their binary cousins.
    if (['csv', 'tsv', 'txt', 'log', 'svg'].includes(ext))
        return { ...type, preview: 'text' };
    if (type.kind === 'image' && !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext))
        return { ...type, preview: 'none' };
    return type;
}
function producedFileKind(path) { return fileType(path).kind; }
function formatFileSize(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
        return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0, value = bytes;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
}

},
"src/modules/shared/file-inspection.js": function(module, exports, require) {
// source: src/modules/shared/file-inspection.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileInspectionCache = void 0;
exports.validateInspection = validateInspection;
exports.thumbnailObjectUrl = thumbnailObjectUrl;
const file_display_1 = require("./generated/file-display");
function validateInspection(value) {
    const info = file_display_1.DisplayInspectionSchema.parse(value);
    if (!info.path || info.path.length > 4096 || info.path.includes('\0') || !Number.isSafeInteger(info.bytes) || info.bytes < 0)
        throw Error('Invalid file metadata');
    if (info.width != null && (!Number.isSafeInteger(info.width) || info.width < 1) || info.height != null && (!Number.isSafeInteger(info.height) || info.height < 1))
        throw Error('Invalid image dimensions');
    if (info.modifiedMs != null && (!Number.isSafeInteger(info.modifiedMs) || info.modifiedMs < 0 || info.modifiedMs > 8640000000000000))
        throw Error('Invalid modified time');
    const thumb = info.thumbnail;
    if (thumb && (thumb.width < 1 || thumb.height < 1 || thumb.width > 96 || thumb.height > 96 || thumb.dataBase64.length > 65536 || thumb.dataBase64.length % 4 !== 0 || !thumb.dataBase64.startsWith('iVBORw0KGgo') || !(/^[A-Za-z0-9+/]*={0,2}$/).test(thumb.dataBase64)))
        throw Error('Invalid thumbnail');
    return info;
}
/** Per-connection bounded metadata cache. No object URLs or full document bytes. */
class FileInspectionCache {
    constructor(rpc) {
        this.rpc = rpc;
        this.cache = new Map();
        this.queue = [];
        this.active = 0;
        this.unavailableUntil = 0;
    }
    async read(sessionId, path, revision, thumbnail, signal) {
        signal.throwIfAborted();
        const key = JSON.stringify([sessionId, path, revision, thumbnail]), now = Date.now(), cached = this.cache.get(key);
        if (cached && now - cached.time < 15000) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached.value;
        }
        if (now < this.unavailableUntil)
            return undefined;
        if (this.queue.length >= 64)
            throw Error('File metadata queue is full');
        return new Promise((resolve, reject) => {
            let started = false;
            const cancel = () => { if (!started) {
                const at = this.queue.indexOf(job);
                if (at >= 0)
                    this.queue.splice(at, 1);
                reject(new DOMException('Aborted', 'AbortError'));
            } };
            const job = { signal, cancel, start: () => {
                    started = true;
                    signal.removeEventListener('abort', cancel);
                    this.active++;
                    void this.fetch(sessionId, path, thumbnail, signal).then(value => {
                        if (value && !signal.aborted) {
                            this.cache.set(key, { time: Date.now(), value });
                            this.trim();
                        }
                        signal.throwIfAborted();
                        resolve(value);
                    }).catch(reject).finally(() => { this.active--; this.pump(); });
                } };
            signal.addEventListener('abort', cancel, { once: true });
            this.queue.push(job);
            this.pump();
        });
    }
    async fetch(sessionId, path, thumbnail, signal) {
        if (Date.now() < this.unavailableUntil)
            return undefined;
        const reply = await this.rpc.call('/api', 'display/inspect', { sessionId, path, thumbnail }, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (!reply.ok) {
            // Old Hosts are normal. A missing file must not disable other inspections.
            if (/unknown (?:endpoint|method)|inspection is unavailable/i.test(reply.error.message))
                this.unavailableUntil = Date.now() + 30000;
            return undefined;
        }
        return validateInspection(reply.value);
    }
    pump() { while (this.active < 2 && this.queue.length) {
        const next = this.queue.shift();
        if (!next)
            break;
        if (next.signal.aborted)
            next.cancel();
        else
            next.start();
    } }
    trim() {
        let bytes = 0;
        for (const item of this.cache.values())
            bytes += item.value.thumbnail?.dataBase64.length ?? 0;
        while (this.cache.size > 24 || bytes > 1024 * 1024) {
            const key = this.cache.keys().next().value;
            if (key === undefined)
                break;
            bytes -= this.cache.get(key)?.value.thumbnail?.dataBase64.length ?? 0;
            this.cache.delete(key);
        }
    }
    /** Diagnostics expose budgets, never filenames or content. */
    get stats() { return { entries: this.cache.size, active: this.active, queued: this.queue.length }; }
}
exports.FileInspectionCache = FileInspectionCache;
function thumbnailObjectUrl(info) {
    const data = info.thumbnail?.dataBase64;
    if (!data)
        return undefined;
    const binary = atob(data);
    if (binary.length > 48 * 1024)
        throw Error('Oversized thumbnail');
    return URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: 'image/png' }));
}

},
"src/modules/shared/generated/file-display.js": function(module, exports, require) {
// source: src/modules/shared/generated/file-display.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitDiffScopeSchema = exports.DisplayThumbnailSchema = exports.DisplayReadSchema = exports.DisplayPreviewKindSchema = exports.DisplayOpenSchema = exports.DisplayInspectionSchema = exports.DisplayInspectSchema = exports.DisplayFileSchema = exports.DisplayDiffSourceSchema = exports.FILE_DISPLAY_SCHEMA_SHA256 = exports.FILE_DISPLAY_CONTRACT = void 0;
// GENERATED from crates/xharness-api/src/display.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-file-display-contract.mjs.
const zod_1 = require("zod");
exports.FILE_DISPLAY_CONTRACT = "xharness-file-display-v1";
exports.FILE_DISPLAY_SCHEMA_SHA256 = "b4c98a1027088c93e600b3b31461bcf4ca51d376159be93bbe1d227edc9cbd5d";
exports.DisplayDiffSourceSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.literal("patch"), zod_1.z.literal("working"), zod_1.z.literal("staged"), zod_1.z.literal("head")]));
exports.DisplayFileSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.strictObject({ "kind": zod_1.z.literal("markdown"), "path": zod_1.z.string(), "text": zod_1.z.string() }), zod_1.z.strictObject({ "kind": zod_1.z.literal("text"), "path": zod_1.z.string(), "text": zod_1.z.string() }), zod_1.z.strictObject({ "kind": zod_1.z.literal("diff"), "path": zod_1.z.string(), "source": exports.DisplayDiffSourceSchema, "text": zod_1.z.string() }), zod_1.z.strictObject({ "dataBase64": zod_1.z.string(), "kind": zod_1.z.literal("pdf"), "path": zod_1.z.string() }), zod_1.z.strictObject({ "dataBase64": zod_1.z.string(), "height": zod_1.z.number().int().min(0).max(4294967295).min(0), "kind": zod_1.z.literal("image"), "mediaType": zod_1.z.string(), "path": zod_1.z.string(), "width": zod_1.z.number().int().min(0).max(4294967295).min(0) })]));
exports.DisplayInspectSchema = zod_1.z.lazy(() => zod_1.z.strictObject({ "path": zod_1.z.string(), "sessionId": zod_1.z.string(), "thumbnail": zod_1.z.boolean().optional() }));
exports.DisplayInspectionSchema = zod_1.z.lazy(() => zod_1.z.strictObject({ "bytes": zod_1.z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).min(0), "height": zod_1.z.union([zod_1.z.number().int().min(0).max(4294967295).min(0), zod_1.z.null()]).optional(), "modifiedMs": zod_1.z.union([zod_1.z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).min(0), zod_1.z.null()]).optional(), "path": zod_1.z.string(), "preview": exports.DisplayPreviewKindSchema, "thumbnail": zod_1.z.union([exports.DisplayThumbnailSchema, zod_1.z.null()]).optional(), "width": zod_1.z.union([zod_1.z.number().int().min(0).max(4294967295).min(0), zod_1.z.null()]).optional() }));
exports.DisplayOpenSchema = zod_1.z.lazy(() => zod_1.z.strictObject({ "gitDiff": zod_1.z.union([exports.GitDiffScopeSchema, zod_1.z.null()]).optional(), "path": zod_1.z.string(), "sessionId": zod_1.z.string() }));
exports.DisplayPreviewKindSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.literal("text"), zod_1.z.literal("markdown"), zod_1.z.literal("image"), zod_1.z.literal("pdf"), zod_1.z.literal("unsupported"), zod_1.z.literal("tooLarge")]));
exports.DisplayReadSchema = zod_1.z.lazy(() => zod_1.z.strictObject({ "gitDiff": zod_1.z.union([exports.GitDiffScopeSchema, zod_1.z.null()]).optional(), "path": zod_1.z.string(), "relativeTo": zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(), "sessionId": zod_1.z.string() }));
exports.DisplayThumbnailSchema = zod_1.z.lazy(() => zod_1.z.strictObject({ "dataBase64": zod_1.z.string(), "height": zod_1.z.number().int().min(0).max(4294967295).min(0), "width": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.GitDiffScopeSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.literal("working"), zod_1.z.literal("staged"), zod_1.z.literal("head")]));

},
"src/modules/deliverables/turn-deliverables.js": function(module, exports, require) {
// source: src/modules/deliverables/turn-deliverables.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliverablesDefinition = void 0;
exports.producedForClosing = producedForClosing;
exports.producedArtifactsForClosing = producedArtifactsForClosing;
exports.selectProducedFiles = selectProducedFiles;
exports.basename = basename;
exports.producedFileMentions = producedFileMentions;
const client_1 = require("@xharness/dsh-client-runtime/client");
/**
 * Paths a call view reports having created or changed, by render intent rather
 * than tool name: a diff card, or a generic card whose kind is `edit` (the
 * shape `str_replace_editor`'s insert presents). Every other card produces
 * nothing to open — a read looked, a delete removed, a terminal ran. Only
 * root call views enter this Turn accumulator; nested Code Mode dispatches
 * preserve the pre-assembly behavior and do not contribute independently.
 */
function producedPaths(view) {
    if (view === null)
        return [];
    if (view.card === 'diff')
        return (view.locations ?? []).map(location => location.path);
    if (view.card === 'generic' && view.kind === 'edit') {
        return (view.locations ?? []).map(location => location.path);
    }
    return [];
}
/**
 * Files produced by one Turn data value.
 *
 * The source is the mutation tools' own follow-along `locations`, not the
 * closing prose: a produced file must be listed whether or not the model
 * remembered to name it. A mutation is recognized by render intent, not by
 * tool name — a diff card, or a generic card whose `kind` is `edit` (the shape
 * `str_replace_editor`'s insert presents) — so a new mutation tool joins by
 * declaring what it does. Reads contribute nothing (looking at a file does not
 * produce it), and neither do deletes (there is nothing left to open) or
 * failed calls. Paths keep first-seen order and appear once, so a file written
 * and then edited in the same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
function producedForClosing(data, seq = Number.POSITIVE_INFINITY) {
    return producedArtifactsForClosing(data, seq).map(item => item.path);
}
/** Preserve first-seen order/status and newest evidence sequence within this closing turn. */
function producedArtifactsForClosing(data, seq = Number.POSITIVE_INFINITY) {
    const files = new Map();
    for (const item of data?.produced ?? []) {
        if (item.seq > seq)
            continue;
        const old = files.get(item.path);
        const change = old?.deleted ? item.change : old?.change ?? item.change;
        files.set(item.path, { path: item.path, seq: item.seq, ...change ? { change } : {}, ...item.deleted ? { deleted: true } : {} });
    }
    return [...files.values()].filter(item => !item.deleted);
}
function mutationChange(result, path, view) {
    for (const block of result.content ?? []) {
        if (block.type !== 'text' || !block.text || block.text.length > 8192)
            continue;
        try {
            const parsed = JSON.parse(block.text);
            // Native tool output envelopes preserve structured handler metadata. The
            // original tool-facing text stays unchanged in history/model context.
            const values = [parsed, typeof parsed === 'object' && parsed !== null && 'metadata' in parsed ? parsed.metadata : undefined];
            for (const value of values) {
                if (typeof value === 'object' && value !== null && 'created' in value && typeof value.created === 'boolean' && 'path' in value && typeof value.path === 'string') {
                    const actual = value.path.replaceAll('\\', '/'), requested = path.replaceAll('\\', '/');
                    if (actual === requested || !requested.startsWith('/') && !/^[a-z]:/i.test(requested) && actual.endsWith('/' + requested))
                        return value.created ? 'created' : 'modified';
                }
            }
        }
        catch { /* Non-JSON tool text is not mutation status evidence. */ }
    }
    const diff = view?.diffs?.find(item => item.path === path);
    // null is also used for overwrites with no before-image, so it NEVER proves creation.
    if (diff && typeof diff.oldText === 'string' && diff.oldText !== diff.newText)
        return 'modified';
    return undefined;
}
/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced paths as the component's match, or null to decline before mount.
 */
function selectProducedFiles(owner) {
    const paths = producedForClosing(owner.turn.data.get('deliverables'), owner.seq);
    return paths.length === 0 ? null : paths;
}
/** Turn-local successful mutation accumulator; it publishes no view Node. */
exports.deliverablesDefinition = {
    kind: 'deliverables',
    match: (event) => {
        if (event.type === 'turn/start')
            return { id: String(event.data.turn), role: 'start' };
        if (event.type === 'tool/call')
            return { id: String(event.data.turn), role: 'update' };
        if (event.type === 'tool/result' && (0, client_1.isAppendSurfaceEvent)(event)) {
            return { id: String(event.data.turn), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'turn/start')
            throw new Error('deliverables start requires turn/start');
        return { turn: match.event.data.turn, calls: new Map(), produced: [] };
    },
    update: (context, match) => {
        if (match.event.type === 'tool/call') {
            const calls = new Map(context.state.calls);
            calls.set(String(match.event.data.callId), match.view?.for === 'call' ? match.view.view : null);
            return { ...context.state, calls };
        }
        if (match.event.type !== 'tool/result')
            return context.state;
        const result = match.event.data.message.content[0];
        if (result.isError === true)
            return context.state;
        const callId = String(match.event.data.message.source.callId);
        const call = context.state.calls.get(callId) ?? null;
        const deleted = call?.kind === 'delete';
        const additions = (deleted ? (call.locations ?? []).map(location => location.path) : producedPaths(call))
            .map(path => { const change = mutationChange(result, path, match.view?.for === 'result' ? match.view.view : null); return { seq: match.event.seq, path, ...change ? { change } : {}, ...deleted ? { deleted: true } : {} }; });
        return additions.length === 0
            ? context.state
            : { ...context.state, produced: [...context.state.produced, ...additions] };
    },
    buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
        ? null
        : {
            kind: 'turn',
            turn: context.state.turn,
            key: 'deliverables',
            value: { produced: context.state.produced },
        },
};
/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
function basename(path) {
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return at === -1 ? path : path.slice(at + 1);
}
/**
 * File-mention vocabulary over one turn's produced paths, for the closing
 * message's prose: an inline-code token opens the file it names. A token
 * resolves by exact path, or by being exactly the basename of exactly one
 * produced path — a basename two paths share stays inert rather than
 * guessing, so a mention link can never open the wrong file or 404.
 * @param paths - The turn's produced paths (tool order, already deduped).
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
function producedFileMentions(paths, openFile, label) {
    return {
        resolve(value) {
            const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value);
            if (path === undefined)
                return undefined;
            return { open: () => { openFile(path); }, label: label(path), title: path };
        },
    };
}
/** The single produced path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths, value) {
    const matches = paths.filter(path => basename(path) === value);
    return matches.length === 1 ? matches[0] : undefined;
}

},
"src/modules/deliverables/ProducedFiles.styles.js": function(module, exports, require) {
// source: src/modules/deliverables/ProducedFiles.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ProducedFiles_css_1 = __importDefault(require("./ProducedFiles.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/dsh-client-ui-deliverables/ProducedFiles.module.css', '@xharness/dsh-client-ui-deliverables', ProducedFiles_css_1.default);
const styles = { root: 'iftpVG_root', list: 'iftpVG_list', cardGroup: 'iftpVG_cardGroup', card: 'iftpVG_card', main: 'iftpVG_main', icon: 'iftpVG_icon', meta: 'iftpVG_meta', open: 'iftpVG_open', toggle: 'iftpVG_toggle', error: 'iftpVG_error', title: 'iftpVG_title', badge: 'iftpVG_badge', parent: 'iftpVG_parent', details: 'iftpVG_details', feedback: 'iftpVG_feedback', fold: 'iftpVG_fold' };
exports.default = styles;

},
"src/modules/deliverables/ProducedFiles.css": function(module, exports, require) {
// source: src/modules/deliverables/ProducedFiles.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".iftpVG_root{display:flex;flex-direction:column;gap:8px;margin-top:16px;min-width:0;font:inherit}\n.iftpVG_list{display:flex;flex-direction:column;gap:8px;min-width:0}\n.iftpVG_cardGroup{min-width:0}\n.iftpVG_card{display:flex;align-items:center;gap:12px;min-height:66px;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e5e5e7);border-radius:13px;background:var(--dsw-alias-bg-base,#fff);box-sizing:border-box;min-width:0}\n.iftpVG_main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,#24272e);font:inherit;text-align:left;cursor:pointer;border-radius:8px}\n.iftpVG_icon{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#f7f7f7);color:#8c8e97}\n.iftpVG_card[data-kind=website] .iftpVG_icon{color:#33caf2}.iftpVG_card[data-kind=code] .iftpVG_icon{color:#7275ce}.iftpVG_card[data-kind=pdf] .iftpVG_icon{color:#cb665d}.iftpVG_card[data-kind=image] .iftpVG_icon{color:#4baf87}.iftpVG_card[data-kind=spreadsheet] .iftpVG_icon{color:#398964}.iftpVG_card[data-kind=presentation] .iftpVG_icon{color:#cf7b3e}.iftpVG_card[data-kind=document] .iftpVG_icon{color:#4b85cf}\n.iftpVG_meta{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.iftpVG_meta strong,.iftpVG_meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.iftpVG_meta strong{font-size:14px;line-height:20px;font-weight:500}.iftpVG_meta small{font-size:13px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary,#75777e)}\n.iftpVG_open{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;flex:none;border:1px solid var(--dsw-alias-border-l1,#e5e5e7);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#24272e);padding:4px 8px;min-height:28px;font:inherit;font-size:14px;line-height:18px;cursor:pointer;box-sizing:border-box}.iftpVG_open svg{color:var(--dsw-alias-label-tertiary,#94969c)}.iftpVG_open:hover,.iftpVG_open[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}.iftpVG_open:disabled{opacity:.5;cursor:wait}\n.iftpVG_toggle{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:12px;line-height:20px;cursor:pointer;padding:2px 4px}.iftpVG_toggle:hover{color:var(--dsw-alias-label-secondary,#777)}\n.iftpVG_main:focus-visible,.iftpVG_open:focus-visible,.iftpVG_toggle:focus-visible{outline:2px solid var(--dsw-alias-label-secondary,#777);outline-offset:2px}.iftpVG_error{font-size:12px;line-height:20px;margin:6px 0 0;padding:0 12px;color:var(--dsw-alias-error-primary,#bc5959)}\n@media(max-width:400px){.iftpVG_card{gap:8px;padding:10px}.iftpVG_main{gap:8px}.iftpVG_icon{width:36px;height:36px}.iftpVG_meta strong{font-size:14px}.iftpVG_open{font-size:13px;gap:5px}}\n\n.iftpVG_title{display:flex;align-items:center;gap:7px;min-width:0}.iftpVG_title strong{min-width:0}.iftpVG_badge{flex:none;font-size:10px;line-height:17px;font-weight:400;color:var(--dsw-alias-label-secondary,#75777e);border:1px solid var(--dsw-alias-border-l1,#e5e5e7);border-radius:4px;padding:0 4px}.iftpVG_meta .iftpVG_parent{font-size:11px;color:var(--dsw-alias-label-tertiary,#94969c)}.iftpVG_icon img{display:block;width:100%;height:100%;object-fit:cover;border-radius:9px}.iftpVG_details{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e5e7);border-top:0;border-radius:0 0 10px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#75777e)}.iftpVG_details p{margin:0 0 6px;font-size:12px;line-height:18px}.iftpVG_details code{display:block;overflow-wrap:anywhere;font-size:11px}.iftpVG_details small{display:block;margin-top:6px}.iftpVG_details button{font:inherit;border:0;background:none;color:inherit;padding:5px 0 0;cursor:pointer}.iftpVG_feedback{font-size:12px;color:var(--dsw-alias-label-secondary,#75777e);margin:4px 12px}.iftpVG_fold{display:flex;gap:10px;align-items:center}\n";

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
"src/modules/deliverables/locales.js": function(module, exports, require) {
// source: src/modules/deliverables/locales.ts

"use strict";
/** `deliverables` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'deliverables';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'produced.label': '文件',
    'produced.moreOne': '+ 1 个文件',
    'produced.more': '+ {count} 个文件',
    'produced.open': '打开 {name}',
    'produced.showInFolder': '在文件夹中显示',
    'produced.actions': '文件操作',
    'produced.expand': '展开',
    'produced.collapse': '收起',
    'produced.preview': '内置预览',
    'produced.external': '默认应用打开',
    'produced.previewFile': '预览 {name}',
    'produced.revealFile': '在文件夹中显示 {name}',
    'produced.externalFile': '用默认应用打开 {name}',
    'produced.openIn': 'Open in',
    'produced.openInFile': '选择 {name} 的打开方式',
    'produced.type.website': 'Website',
    'produced.type.pdf': 'PDF document',
    'produced.type.markdown': 'Markdown',
    'produced.type.code': 'Source code',
    'produced.type.image': 'Image',
    'produced.type.spreadsheet': 'Spreadsheet',
    'produced.type.presentation': 'Presentation',
    'produced.type.document': 'Document',
    'produced.type.video': 'Video',
    'produced.type.audio': 'Audio',
    'produced.type.archive': 'Archive',
    'produced.type.file': 'File',
    'produced.type.data': 'Data file',
    'produced.info': '文件信息',
    'produced.infoFile': '{name} 的文件信息',
    'produced.copyPath': '复制路径',
    'produced.copied': '路径已复制',
    'produced.copyFailed': '路径复制失败',
    'produced.noPreview': '暂不支持内置预览，请从 Open in 选择打开方式。',
    'produced.tooLarge': '文件超过内置预览大小限制，可使用默认应用打开。',
    'produced.created': '新建',
    'produced.modified': '已修改',
    'produced.modifiedAt': '修改时间',
    'produced.closeInfo': '收起信息',
    'produced.remaining': '另有 {count} 个文件',
    'produced.loadMore': '显示更多文件',
};
/** English dictionary (same key set). */
exports.en = {
    'produced.label': 'Produced',
    'produced.moreOne': '+ 1 file',
    'produced.more': '+ {count} files',
    'produced.open': 'Open {name}',
    'produced.showInFolder': 'Show in folder',
    'produced.actions': 'File actions',
    'produced.expand': 'Expand',
    'produced.collapse': 'Collapse',
    'produced.preview': 'Preview',
    'produced.external': 'Open with default app',
    'produced.previewFile': 'Preview {name}',
    'produced.revealFile': 'Show {name} in folder',
    'produced.externalFile': 'Open {name} with default app',
    'produced.openIn': 'Open in',
    'produced.openInFile': 'Open in options for {name}',
    'produced.type.website': 'Website',
    'produced.type.pdf': 'PDF document',
    'produced.type.markdown': 'Markdown',
    'produced.type.code': 'Source code',
    'produced.type.image': 'Image',
    'produced.type.spreadsheet': 'Spreadsheet',
    'produced.type.presentation': 'Presentation',
    'produced.type.document': 'Document',
    'produced.type.video': 'Video',
    'produced.type.audio': 'Audio',
    'produced.type.archive': 'Archive',
    'produced.type.file': 'File',
    'produced.type.data': 'Data file',
    'produced.info': 'File information',
    'produced.infoFile': 'File information for {name}',
    'produced.copyPath': 'Copy path',
    'produced.copied': 'Path copied',
    'produced.copyFailed': 'Could not copy path',
    'produced.noPreview': 'No built-in preview. Choose an option from Open in.',
    'produced.tooLarge': 'Too large for built-in preview. Open with the default app.',
    'produced.created': 'Created',
    'produced.modified': 'Modified',
    'produced.modifiedAt': 'Modified',
    'produced.closeInfo': 'Close information',
    'produced.remaining': '{count} more files',
    'produced.loadMore': 'Show more files',
};

}
};
const __dependencies = {"src/modules/deliverables/index.js":{"../client-runtime/workspaces/path":"src/modules/client-runtime/workspaces/path.js","./ProducedFiles":"src/modules/deliverables/ProducedFiles.js","../shared/file-inspection":"src/modules/shared/file-inspection.js","./locales":"src/modules/deliverables/locales.js","./turn-deliverables":"src/modules/deliverables/turn-deliverables.js"},"src/modules/client-runtime/workspaces/path.js":{},"src/modules/deliverables/ProducedFiles.js":{"./file-kind":"src/modules/deliverables/file-kind.js","../shared/file-inspection":"src/modules/shared/file-inspection.js","./turn-deliverables":"src/modules/deliverables/turn-deliverables.js","./ProducedFiles.styles":"src/modules/deliverables/ProducedFiles.styles.js"},"src/modules/deliverables/file-kind.js":{"../shared/file-types":"src/modules/shared/file-types.js"},"src/modules/shared/file-types.js":{},"src/modules/shared/file-inspection.js":{"./generated/file-display":"src/modules/shared/generated/file-display.js"},"src/modules/shared/generated/file-display.js":{},"src/modules/deliverables/turn-deliverables.js":{},"src/modules/deliverables/ProducedFiles.styles.js":{"./ProducedFiles.css":"src/modules/deliverables/ProducedFiles.css","../views-types":"src/modules/views-types.js"},"src/modules/deliverables/ProducedFiles.css":{},"src/modules/views-types.js":{},"src/modules/deliverables/locales.js":{}};
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
return __load("src/modules/deliverables/index.js");
}
});
