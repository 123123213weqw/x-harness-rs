// Generated from src/modules/attachment/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-attachment",
factory: (__externalRequire) => {
const __units = {
"src/modules/attachment/index.js": function(module, exports, require) {
// source: src/modules/attachment/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/// <reference path="./external.d.ts" />
const ComposerAttachments_1 = require("./ComposerAttachments");
const MessageImages_1 = require("./MessageImages");
exports.inject = ['slots'];
function apply(ctx) {
    ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({ name: 'conversation.input.attachments', locale: 'conversation' }, ComposerAttachments_1.ComposerAttachments));
    ctx.slots.inject('conversation.message.images', () => ctx.slots.register({ name: 'conversation.message.images', locale: 'conversation' }, MessageImages_1.MessageImages));
}

},
"src/modules/attachment/ComposerAttachments.js": function(module, exports, require) {
// source: src/modules/attachment/ComposerAttachments.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComposerAttachments = ComposerAttachments;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const AttachmentRail_1 = require("./AttachmentRail");
const DropOverlay_1 = require("./DropOverlay");
const ImageLightbox_1 = require("./ImageLightbox");
const labels_1 = require("./labels");
const styles_1 = require("./styles");
function ComposerAttachments({ attachments, canAcceptDrop, onAddImages, onRemoveImage, dropLimits, t }) {
    const [preview, setPreview] = (0, react_1.useState)(null), [dragActive, setDragActive] = (0, react_1.useState)(false);
    const dragDepth = (0, react_1.useRef)(0);
    const closePreview = (0, react_1.useCallback)(() => { setPreview(null); }, []);
    (0, react_1.useEffect)(() => { if (preview !== null && !attachments.some(attachment => attachment.id === preview.id))
        setPreview(null); }, [attachments, preview]);
    (0, react_1.useEffect)(() => {
        const fileTransfer = (event) => { const transfer = event.dataTransfer; return transfer === null || !transfer.types.includes('Files') ? null : transfer; };
        const reset = () => { dragDepth.current = 0; setDragActive(false); };
        const onDragEnter = (event) => {
            if (fileTransfer(event) === null)
                return;
            event.preventDefault();
            ++dragDepth.current;
            setDragActive(true);
        };
        const onDragOver = (event) => { const transfer = fileTransfer(event); if (transfer !== null) {
            event.preventDefault();
            transfer.dropEffect = canAcceptDrop ? 'copy' : 'none';
        } };
        const onDragLeave = (event) => {
            if (fileTransfer(event) === null)
                return;
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0)
                setDragActive(false);
            const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
            if ((event.target === document.documentElement || event.target === document.body) && leftViewport)
                reset();
        };
        const onDrop = (event) => { const transfer = fileTransfer(event); if (transfer === null)
            return; event.preventDefault(); reset(); if (canAcceptDrop)
            onAddImages([...transfer.files]); };
        document.addEventListener('dragenter', onDragEnter);
        document.addEventListener('dragover', onDragOver);
        document.addEventListener('dragleave', onDragLeave);
        document.addEventListener('drop', onDrop);
        window.addEventListener('dragend', reset);
        return () => {
            document.removeEventListener('dragenter', onDragEnter);
            document.removeEventListener('dragover', onDragOver);
            document.removeEventListener('dragleave', onDragLeave);
            document.removeEventListener('drop', onDrop);
            window.removeEventListener('dragend', reset);
        };
    }, [canAcceptDrop, onAddImages]);
    const railItems = (0, react_1.useMemo)(() => attachments.map(attachment => ({ id: attachment.id, previewUrl: attachment.previewUrl, alt: attachment.file.name || t('image.pending'), removeLabel: t('image.remove', { name: attachment.file.name }), attachment })), [attachments, t]);
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [dragActive && (0, jsx_runtime_1.jsx)(DropOverlay_1.DropOverlay, { disabled: !canAcceptDrop, labels: (0, labels_1.dropOverlayLabels)(t, canAcceptDrop, dropLimits) }), railItems.length > 0 && (0, jsx_runtime_1.jsx)("div", { className: styles_1.ComposerAttachmentsCss.rail, children: (0, jsx_runtime_1.jsx)(AttachmentRail_1.AttachmentRail, { items: railItems, labels: (0, labels_1.attachmentRailLabels)(t), onOpen: item => { setPreview(item.attachment); }, onRemove: item => { onRemoveImage(item.attachment.id); } }) }), preview !== null && (0, jsx_runtime_1.jsx)(ImageLightbox_1.ImageLightbox, { src: preview.previewUrl, alt: preview.file.name || t('image.original'), labels: (0, labels_1.lightboxLabels)(t), onClose: closePreview })] });
}

},
"src/modules/attachment/AttachmentRail.js": function(module, exports, require) {
// source: src/modules/attachment/AttachmentRail.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentRail = AttachmentRail;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const styles_1 = require("./styles");
const FileCard_1 = require("./FileCard");
const WHEEL_LINE_PX = 16;
function pageBehavior() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }
function AttachmentRail({ items, labels, onOpen, onRemove }) {
    const railRef = (0, react_1.useRef)(null), countRef = (0, react_1.useRef)(null);
    const [edges, setEdges] = (0, react_1.useState)({ left: false, right: false });
    const updateEdges = (0, react_1.useCallback)(() => {
        const element = railRef.current;
        if (element === null)
            return;
        const left = element.scrollLeft > 1, right = element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
        setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    }, []);
    (0, react_1.useLayoutEffect)(() => {
        const grew = countRef.current !== null && items.length > countRef.current;
        countRef.current = items.length;
        const element = railRef.current;
        if (element === null)
            return;
        if (grew)
            element.scrollLeft = element.scrollWidth - element.clientWidth;
        updateEdges();
    }, [items.length, updateEdges]);
    (0, react_1.useEffect)(() => {
        const element = railRef.current;
        if (element === null)
            return;
        let disconnect = () => { };
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(updateEdges);
            observer.observe(element);
            disconnect = () => { observer.disconnect(); };
        }
        const onWheel = (event) => {
            if (event.deltaY === 0)
                return;
            const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
            event.preventDefault();
            element.scrollBy({ left: event.deltaX !== 0 ? event.deltaX * scale : Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * scale, 60), behavior: 'auto' });
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => { disconnect(); element.removeEventListener('wheel', onWheel); };
    }, [updateEdges]);
    const page = (direction) => { const element = railRef.current; if (element !== null)
        element.scrollBy({ left: direction * Math.max(element.clientWidth - 64, 200), behavior: pageBehavior() }); };
    return (0, jsx_runtime_1.jsxs)("div", { className: styles_1.AttachmentRailCss.root, children: [edges.left && (0, jsx_runtime_1.jsx)("button", { type: "button", className: `${styles_1.AttachmentRailCss.arrow} ${styles_1.AttachmentRailCss.arrowLeft}`, "aria-label": labels.scrollLeft, onClick: () => { page(-1); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronLeftOutline14, {}) }), (0, jsx_runtime_1.jsx)("div", { ref: railRef, className: styles_1.AttachmentRailCss.rail, role: "group", "aria-label": labels.group, onScroll: updateEdges, children: items.map(item => item.attachment.kind === 'file' ? (0, jsx_runtime_1.jsx)(FileCard_1.FileCard, { name: item.attachment.file.name, bytes: item.attachment.file.size, onRemove: () => { onRemove(item); }, removeLabel: item.removeLabel }, item.id) : (0, jsx_runtime_1.jsxs)("div", { className: styles_1.AttachmentRailCss.item, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.AttachmentRailCss.thumbnail, title: labels.open, onClick: () => { onOpen(item); }, children: (0, jsx_runtime_1.jsx)("img", { src: item.previewUrl, alt: item.alt }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.AttachmentRailCss.remove, "aria-label": item.removeLabel, onClick: () => { onRemove(item); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseFill14, { size: 12 }) })] }, item.id)) }), edges.right && (0, jsx_runtime_1.jsx)("button", { type: "button", className: `${styles_1.AttachmentRailCss.arrow} ${styles_1.AttachmentRailCss.arrowRight}`, "aria-label": labels.scrollRight, onClick: () => { page(1); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, {}) })] });
}

},
"src/modules/attachment/styles.js": function(module, exports, require) {
// source: src/modules/attachment/styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageImageCss = exports.ComposerAttachmentsCss = exports.ImageLightboxCss = exports.DropOverlayCss = exports.AttachmentRailCss = void 0;
const AttachmentRail_css_1 = __importDefault(require("./AttachmentRail.css"));
const DropOverlay_css_1 = __importDefault(require("./DropOverlay.css"));
const ImageLightbox_css_1 = __importDefault(require("./ImageLightbox.css"));
const ComposerAttachments_css_1 = __importDefault(require("./ComposerAttachments.css"));
const MessageImage_css_1 = __importDefault(require("./MessageImage.css"));
const FileCard_css_1 = __importDefault(require("./FileCard.css"));
exports.AttachmentRailCss = {
    "arrow": "sfWyaW_arrow",
    "arrowLeft": "sfWyaW_arrowLeft",
    "arrowRight": "sfWyaW_arrowRight",
    "item": "sfWyaW_item",
    "rail": "sfWyaW_rail",
    "remove": "sfWyaW_remove",
    "root": "sfWyaW_root",
    "thumbnail": "sfWyaW_thumbnail"
};
exports.DropOverlayCss = {
    "desc": "VhJ6zG_desc",
    "fade-in": "VhJ6zG_fade-in",
    "illustration": "VhJ6zG_illustration",
    "mask": "VhJ6zG_mask",
    "title": "VhJ6zG_title",
    "wrap": "VhJ6zG_wrap"
};
exports.ImageLightboxCss = {
    "backdrop": "Yq4GiW_backdrop",
    "close": "Yq4GiW_close",
    "image": "Yq4GiW_image",
    "mask": "Yq4GiW_mask"
};
exports.ComposerAttachmentsCss = { "rail": "ArGB1q_rail" };
exports.MessageImageCss = {
    "error": "_0TeX1a_error",
    "frame": "_0TeX1a_frame",
    "gallery": "_0TeX1a_gallery",
    "loading": "_0TeX1a_loading"
};
/** Preserve the current distribution's stylesheet cascade order. */
function injectCss(tagId, css) {
    if (typeof document === 'undefined')
        return;
    if (tagId !== undefined && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null)
        return;
    const tag = document.createElement('style');
    if (tagId !== undefined) {
        tag.dataset.plugin = '@xharness/dsh-client-ui-attachment';
        tag.dataset.pluginCss = tagId;
    }
    tag.textContent = css;
    document.head.appendChild(tag);
}
injectCss('@xharness/dsh-client-ui-attachment/AttachmentRail.module.css', AttachmentRail_css_1.default);
injectCss('@xharness/dsh-client-ui-attachment/DropOverlay.module.css', DropOverlay_css_1.default);
injectCss('@xharness/dsh-client-ui-attachment/ImageLightbox.module.css', ImageLightbox_css_1.default);
injectCss('@xharness/dsh-client-ui-attachment/ComposerAttachments.module.css', ComposerAttachments_css_1.default);
injectCss(undefined, FileCard_css_1.default);
injectCss('@xharness/dsh-client-ui-attachment/MessageImage.module.css', MessageImage_css_1.default);

},
"src/modules/attachment/AttachmentRail.css": function(module, exports, require) {
// source: src/modules/attachment/AttachmentRail.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".sfWyaW_root{min-width:0;position:relative}.sfWyaW_rail{scrollbar-width:none;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);gap:10px;display:flex;overflow:auto hidden}.sfWyaW_rail::-webkit-scrollbar{display:none}.sfWyaW_item{flex:0 0 64px;width:64px;height:64px;position:relative}.sfWyaW_thumbnail{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-interactive-bg-hover);cursor:zoom-in;border-radius:16px;width:64px;height:64px;padding:0;overflow:hidden}.sfWyaW_thumbnail img{object-fit:cover;width:100%;height:100%;display:block}.sfWyaW_remove{z-index:1;background:var(--dsw-alias-button-contrast-fill);width:18px;height:18px;color:var(--dsw-alias-label-primary-inverted);cursor:pointer;opacity:0;border:none;border-radius:50%;place-items:center;padding:0;transition:opacity .2s ease-in-out;display:grid;position:absolute;top:4px;right:4px}.sfWyaW_item:hover .sfWyaW_remove,.sfWyaW_remove:focus-visible{opacity:1}@media (pointer:coarse){.sfWyaW_remove{opacity:1}}@media (prefers-reduced-motion:reduce){.sfWyaW_remove{transition:none}}.sfWyaW_arrow{z-index:2;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);width:24px;height:24px;color:var(--dsw-alias-label-secondary);box-shadow:var(--dsw-shadow-lv2);cursor:pointer;border-radius:999px;place-items:center;padding:0;display:grid;position:absolute;top:50%;transform:translateY(-50%)}.sfWyaW_arrow:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.sfWyaW_arrowLeft{left:4px}.sfWyaW_arrowRight{right:4px}";

},
"src/modules/attachment/DropOverlay.css": function(module, exports, require) {
// source: src/modules/attachment/DropOverlay.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".VhJ6zG_mask{z-index:1000;pointer-events:none;background-color:var(--dsw-alias-bg-mask-drop);backdrop-filter:blur(10px);justify-content:center;align-items:center;animation:.16s ease-out VhJ6zG_fade-in;display:flex;position:fixed;inset:0}@keyframes VhJ6zG_fade-in{0%{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){.VhJ6zG_mask{animation:none}}.VhJ6zG_wrap{color:var(--dsw-alias-label-primary);text-align:center;flex-direction:column;align-items:center;margin-top:-3%;padding:0 40px;display:flex}.VhJ6zG_illustration{width:115px;height:84px}.VhJ6zG_title{font:var(--dsw-font-l-20);margin-top:16px}.VhJ6zG_desc{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;margin-top:16px}";

},
"src/modules/attachment/ImageLightbox.css": function(module, exports, require) {
// source: src/modules/attachment/ImageLightbox.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Yq4GiW_backdrop{z-index:1000;place-items:center;padding:40px;display:grid;position:fixed;inset:0}.Yq4GiW_mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}.Yq4GiW_image{object-fit:contain;background:var(--dsw-specific-input-major);max-width:min(100%,1600px);max-height:calc(100vh - 80px);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;position:relative}.Yq4GiW_close{z-index:1;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);width:36px;height:36px;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:999px;place-items:center;display:grid;position:fixed;top:20px;right:20px}";

},
"src/modules/attachment/ComposerAttachments.css": function(module, exports, require) {
// source: src/modules/attachment/ComposerAttachments.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".ArGB1q_rail{min-width:0;padding:4px 12px 0}";

},
"src/modules/attachment/MessageImage.css": function(module, exports, require) {
// source: src/modules/attachment/MessageImage.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._0TeX1a_gallery{flex-wrap:wrap;gap:10px;max-width:100%;display:flex}._0TeX1a_gallery[data-align=end]{justify-content:flex-end;align-self:flex-end}._0TeX1a_gallery[data-align=start]{justify-content:flex-start;align-self:flex-start}._0TeX1a_frame{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-interactive-bg-hover);cursor:zoom-in;border-radius:16px;flex:none;place-items:center;min-width:44px;min-height:44px;padding:0;display:grid;overflow:hidden}._0TeX1a_frame[data-variant=tile]{width:64px;min-width:64px;height:64px;min-height:64px}._0TeX1a_frame img{object-fit:cover;width:100%;height:100%;display:block}._0TeX1a_loading,._0TeX1a_error{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}._0TeX1a_error{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-interactive-bg-hover-danger);cursor:pointer;border-radius:10px;max-width:240px;padding:10px 12px}._0TeX1a_error[data-variant=tile]{border-radius:16px;width:64px;height:64px;padding:4px;overflow:hidden}";

},
"src/modules/attachment/FileCard.css": function(module, exports, require) {
// source: src/modules/attachment/FileCard.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xh-file-card{box-sizing:border-box;position:relative;flex:0 0 240px;max-width:100%;width:240px;height:64px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:16px;background:var(--dsw-alias-interactive-bg-hover);padding:10px 32px 10px 12px;display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-primary)}.xh-file-card button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}.xh-file-card .xh-file-info{min-width:0;overflow:hidden;text-align:left;display:flex;flex-direction:column;gap:4px}.xh-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:175px;font-size:13px}.xh-file-size{font-size:11px;color:var(--dsw-alias-label-tertiary)}.xh-file-remove{position:absolute;right:6px;top:4px;width:24px;height:24px}.xh-file-card :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}";

},
"src/modules/attachment/FileCard.js": function(module, exports, require) {
// source: src/modules/attachment/FileCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCard = FileCard;
exports.HistoryFile = HistoryFile;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
function FileCard({ name, bytes, onRemove, removeLabel, onDownload, busy, error }) {
    const size = bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB';
    const Info = onDownload ? 'button' : 'div';
    return (0, jsx_runtime_1.jsxs)("div", { className: "xh-file-card", children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": true, children: "\u25A4" }), (0, jsx_runtime_1.jsxs)(Info, { className: "xh-file-info", onClick: onDownload, ...(Info === 'button' ? { disabled: busy } : {}), title: name, children: [(0, jsx_runtime_1.jsx)("span", { className: "xh-file-name", children: name || '附件' }), (0, jsx_runtime_1.jsx)("span", { className: "xh-file-size", role: error ? 'alert' : undefined, children: busy ? '正在读取…' : error ? '读取失败，点击重试' : size + (onDownload ? ' · 下载' : '') })] }), onRemove && (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xh-file-remove", onClick: onRemove, "aria-label": removeLabel || '移除 ' + name, children: "\u00D7" })] });
}
function HistoryFile({ attachment, load }) {
    const [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(false);
    const download = async () => {
        if (busy)
            return;
        setBusy(true);
        setError(false);
        try {
            const url = await load(attachment);
            const link = document.createElement('a');
            link.href = url;
            link.download = attachment.name || 'attachment';
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
        catch {
            setError(true);
        }
        finally {
            setBusy(false);
        }
    };
    return (0, jsx_runtime_1.jsx)(FileCard, { name: attachment.name, bytes: attachment.bytes, onDownload: () => { void download(); }, busy: busy, error: error });
}

},
"src/modules/attachment/DropOverlay.js": function(module, exports, require) {
// source: src/modules/attachment/DropOverlay.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DropOverlay = DropOverlay;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_dom_1 = require("react-dom");
const styles_1 = require("./styles");
/**
 * Full-viewport invitation shown while a file drag is over the page
 * (DeepSeek Chat's DragMask). Decoration only: `pointer-events: none` keeps
 * drag targeting on the page below, so the owner's document-level listeners
 * keep an accurate enter/leave count and own accept/reject. Rendered through
 * a body portal for the same transformed-ancestor reason as the lightbox.
 *
 * @param props.disabled - drops are currently refused; renders the blocked
 * illustration and drops the desc line.
 * @param props.labels - resolved title and limits strings.
 * @returns the overlay layer.
 */
function DropOverlay({ disabled, labels }) {
    return (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)("div", { className: styles_1.DropOverlayCss.mask, role: "status", children: (0, jsx_runtime_1.jsxs)("div", { className: styles_1.DropOverlayCss.wrap, children: [(0, jsx_runtime_1.jsx)("div", { className: styles_1.DropOverlayCss.illustration, "aria-hidden": "true", children: disabled ? (0, jsx_runtime_1.jsx)(UploadDisabledIllustration, {}) : (0, jsx_runtime_1.jsx)(UploadIllustration, {}) }), (0, jsx_runtime_1.jsx)("div", { className: styles_1.DropOverlayCss.title, children: labels.title }), !disabled && labels.desc !== undefined && (0, jsx_runtime_1.jsx)("div", { className: styles_1.DropOverlayCss.desc, children: labels.desc })] }) }), document.body);
}
/** Tilted photo-and-note cards (DeepSeek Chat upload illustration). */
const UploadIllustration = () => ((0, jsx_runtime_1.jsxs)("svg", { width: "115", height: "84", viewBox: "0 0 115 84", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [(0, jsx_runtime_1.jsxs)("g", { clipPath: "url(#dshDropOverlayClip)", children: [(0, jsx_runtime_1.jsx)("rect", { y: "17.0742", width: "44.1832", height: "43.6431", rx: "12", transform: "rotate(-22.7338 0 17.0742)", fill: "#9CE5ED" }), (0, jsx_runtime_1.jsx)("rect", { x: "73.4043", y: "8.54297", width: "43.7267", height: "50.5284", rx: "8", transform: "rotate(17.403 73.4043 8.54297)", fill: "#679EFE" }), (0, jsx_runtime_1.jsx)("path", { d: "M30.4917 28.1369L40.8865 33.4564L37.2232 34.9524L29.5302 31.0159L26.7919 39.2122L23.1285 40.7082L26.8287 29.6338L16.8967 24.5516L20.5601 23.0556L27.7902 26.7549L30.3639 19.052L34.0273 17.556L30.4917 28.1369Z", fill: "white" }), (0, jsx_runtime_1.jsx)("path", { d: "M77.5088 26.3047L101.057 33.7966", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M72.2646 42.7871L86.3938 47.2823", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M74.8867 34.5469L98.4353 42.0388", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("rect", { x: "31.583", y: "38.6641", width: "44.9157", height: "44.3666", rx: "12", transform: "rotate(-0.134233 31.583 38.6641)", fill: "#3964FE" }), (0, jsx_runtime_1.jsx)("path", { d: "M38.9521 73.0337C39.6129 71.7086 41.7113 66.0937 43.5113 61.1663C44.1607 59.3885 46.7484 59.3923 47.4591 61.1465C48.9728 64.8828 50.7969 68.6922 51.9988 69.1925C54.2946 70.1482 57.9854 59.3573 68.0064 70.1801", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("circle", { cx: "60.6157", cy: "52.247", r: "4.38794", transform: "rotate(22.5996 60.6157 52.247)", fill: "white" })] }), (0, jsx_runtime_1.jsx)("defs", { children: (0, jsx_runtime_1.jsx)("clipPath", { id: "dshDropOverlayClip", children: (0, jsx_runtime_1.jsx)("rect", { width: "115", height: "84", fill: "white" }) }) })] }));
/** Greyed cards with a blocked badge (DeepSeek Chat disabled illustration). */
const UploadDisabledIllustration = () => ((0, jsx_runtime_1.jsxs)("svg", { width: "115", height: "84", viewBox: "0 0 115 84", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [(0, jsx_runtime_1.jsx)("path", { d: "M29.6829 4.63701L11.0677 12.4368C4.95519 14.998 2.07624 22.0294 4.6374 28.1419L12.2285 46.259C14.7896 52.3715 21.8211 55.2505 27.9336 52.6893L46.5488 44.8895C52.6613 42.3283 55.5403 35.2969 52.9791 29.1844L45.388 11.0673C42.8269 4.9548 35.7954 2.07585 29.6829 4.63701Z", fill: "#979DA6" }), (0, jsx_runtime_1.jsx)("path", { d: "M30.4915 28.1375L40.8863 33.4569L37.223 34.9529L29.53 31.0165L26.7917 39.2128L23.1283 40.7088L26.8285 29.6344L16.8965 24.5522L20.5599 23.0562L27.79 26.7555L30.3637 19.0526L34.0271 17.5566L30.4915 28.1375Z", fill: "white" }), (0, jsx_runtime_1.jsx)("path", { d: "M107.496 19.2285L81.0381 10.9357C76.8221 9.61423 72.333 11.9607 71.0116 16.1768L60.6844 49.1246C59.363 53.3406 61.7095 57.8297 65.9255 59.1511L92.383 67.4439C96.599 68.7654 101.088 66.4189 102.41 62.2029L112.737 29.255C114.058 25.039 111.712 20.55 107.496 19.2285Z", fill: "#979DA6" }), (0, jsx_runtime_1.jsx)("path", { d: "M77.5088 26.3047L101.057 33.7967", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M72.2646 42.7871L86.3938 47.2823", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M74.8867 34.5469L98.4353 42.0388", stroke: "white", strokeWidth: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M66.5798 30.1418L41.481 30.2006C33.5281 30.2193 27.0962 36.6815 27.1148 44.6343L27.172 69.0742C27.1907 77.0271 33.6529 83.459 41.6057 83.4404L66.7045 83.3816C74.6574 83.363 81.0894 76.9008 81.0707 68.9479L81.0135 44.5081C80.9949 36.5552 74.5327 30.1232 66.5798 30.1418Z", fill: "#F59E0B" }), (0, jsx_runtime_1.jsx)("path", { d: "M54 70.7969C61.732 70.7969 68 64.5289 68 56.7969C68 49.0649 61.732 42.7969 54 42.7969C46.268 42.7969 40 49.0649 40 56.7969C40 64.5289 46.268 70.7969 54 70.7969Z", stroke: "white", strokeWidth: "3.5" }), (0, jsx_runtime_1.jsx)("path", { d: "M44 46.7969L64 66.7969", stroke: "white", strokeWidth: "3.5", strokeLinecap: "round" })] }));

},
"src/modules/attachment/ImageLightbox.js": function(module, exports, require) {
// source: src/modules/attachment/ImageLightbox.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageLightbox = ImageLightbox;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const styles_1 = require("./styles");
function ImageLightbox({ src, alt, labels, onClose }) {
    const closeRef = (0, react_1.useRef)(null), restoreRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (event) => { if (event.key === 'Escape')
            onClose(); };
        window.addEventListener('keydown', onKeyDown);
        return () => { window.removeEventListener('keydown', onKeyDown); restoreRef.current?.focus(); };
    }, [onClose]);
    return (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsxs)("div", { className: styles_1.ImageLightboxCss.backdrop, role: "dialog", "aria-modal": "true", "aria-label": labels.dialog, children: [(0, jsx_runtime_1.jsx)("div", { className: styles_1.ImageLightboxCss.mask, "aria-hidden": "true", onMouseDown: onClose }), (0, jsx_runtime_1.jsx)("img", { className: styles_1.ImageLightboxCss.image, src: src, alt: alt }), (0, jsx_runtime_1.jsx)("button", { ref: closeRef, type: "button", className: styles_1.ImageLightboxCss.close, "aria-label": labels.close, onClick: onClose, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 16 }) })] }), document.body);
}

},
"src/modules/attachment/labels.js": function(module, exports, require) {
// source: src/modules/attachment/labels.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lightboxLabels = lightboxLabels;
exports.messageImageLabels = messageImageLabels;
exports.dropOverlayLabels = dropOverlayLabels;
exports.attachmentRailLabels = attachmentRailLabels;
function lightboxLabels(t) { return { dialog: t('image.preview'), close: t('image.closePreview') }; }
function messageImageLabels(t) {
    return { image: t('image.label'), open: t('image.openOriginal'), openNamed: label => t('image.openOriginalLabel', { label }), loading: t('image.loading'), loadFailed: t('image.loadFailed'), lightbox: lightboxLabels(t) };
}
function dropOverlayLabels(t, accepting, _limits) {
    return accepting ? { title: '拖入图片或文件', desc: '图片 ≤ 20 MiB / 张，普通文件 ≤ 32 MiB；本次合计 ≤ 96 MiB' } : { title: t('image.dropBlocked') };
}
function attachmentRailLabels(t) {
    return { group: t('image.pending'), open: t('image.openOriginal'), scrollLeft: t('image.scrollLeft'), scrollRight: t('image.scrollRight') };
}

},
"src/modules/attachment/MessageImages.js": function(module, exports, require) {
// source: src/modules/attachment/MessageImages.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageImages = MessageImages;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const styles_1 = require("./styles");
const FileCard_1 = require("./FileCard");
const ImageLightbox_1 = require("./ImageLightbox");
const labels_1 = require("./labels");
function isImageAttachment(attachment) {
    return typeof attachment.width === 'number' && typeof attachment.height === 'number';
}
/** Clamp aspect ratio while never upscaling beyond the admitted image. */
function singleFit(attachment) {
    const natural = attachment.width / attachment.height, ratio = Math.min(4, Math.max(.25, natural));
    const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
    const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height);
    return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)), objectPosition: natural < .25 ? 'center top' : natural > 4 ? 'left center' : 'center' };
}
function MessageImage({ attachment, load, variant, labels }) {
    const [src, setSrc] = (0, react_1.useState)(null), [error, setError] = (0, react_1.useState)(false), [open, setOpen] = (0, react_1.useState)(false), [attempt, setAttempt] = (0, react_1.useState)(0);
    const request = (0, react_1.useCallback)(() => { setAttempt(value => value + 1); }, []), close = (0, react_1.useCallback)(() => { setOpen(false); }, []);
    const fit = (0, react_1.useMemo)(() => variant === 'single' ? singleFit(attachment) : undefined, [attachment, variant]);
    (0, react_1.useEffect)(() => {
        let live = true;
        setError(false);
        setSrc(null);
        void load(attachment).then(url => { if (live)
            setSrc(url); }).catch(() => { if (live)
            setError(true); });
        return () => { live = false; };
    }, [attachment, load, attempt]);
    const label = attachment.name ?? labels.image;
    if (error)
        return (0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.MessageImageCss.error, "data-variant": variant, onClick: request, children: labels.loadFailed });
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: styles_1.MessageImageCss.frame, "data-variant": variant, style: fit === undefined ? undefined : { width: fit.width, height: fit.height }, title: labels.open, "aria-label": labels.openNamed(label), onClick: () => { if (src !== null)
                    setOpen(true); }, children: src === null ? (0, jsx_runtime_1.jsx)("span", { className: styles_1.MessageImageCss.loading, children: labels.loading }) : (0, jsx_runtime_1.jsx)("img", { src: src, alt: label, style: fit === undefined ? undefined : { objectPosition: fit.objectPosition } }) }), open && src !== null && (0, jsx_runtime_1.jsx)(ImageLightbox_1.ImageLightbox, { src: src, alt: label, labels: labels.lightbox, onClose: close })] });
}
function MessageImages({ images, loadImage, align, t }) {
    if (images.length === 0)
        return null;
    const labels = (0, labels_1.messageImageLabels)(t), variant = images.length === 1 ? 'single' : 'tile';
    return (0, jsx_runtime_1.jsx)("div", { className: styles_1.MessageImageCss.gallery, "data-align": align, children: images.map((image, index) => {
            const attachment = image.attachment, key = `${attachment.attachmentId}:${index}`;
            if (image.kind === 'file' || !isImageAttachment(attachment))
                return (0, jsx_runtime_1.jsx)(FileCard_1.HistoryFile, { attachment: attachment, load: loadImage }, key);
            // Host image admission requires both dimensions. Keep the durable reference
            // intact: loadImage performs session authorization and URL resolution.
            return (0, jsx_runtime_1.jsx)(MessageImage, { attachment: attachment, load: loadImage, variant: variant, labels: labels }, key);
        }) });
}

}
};
const __dependencies = {"src/modules/attachment/index.js":{"./ComposerAttachments":"src/modules/attachment/ComposerAttachments.js","./MessageImages":"src/modules/attachment/MessageImages.js"},"src/modules/attachment/ComposerAttachments.js":{"./AttachmentRail":"src/modules/attachment/AttachmentRail.js","./DropOverlay":"src/modules/attachment/DropOverlay.js","./ImageLightbox":"src/modules/attachment/ImageLightbox.js","./labels":"src/modules/attachment/labels.js","./styles":"src/modules/attachment/styles.js"},"src/modules/attachment/AttachmentRail.js":{"./styles":"src/modules/attachment/styles.js","./FileCard":"src/modules/attachment/FileCard.js"},"src/modules/attachment/styles.js":{"./AttachmentRail.css":"src/modules/attachment/AttachmentRail.css","./DropOverlay.css":"src/modules/attachment/DropOverlay.css","./ImageLightbox.css":"src/modules/attachment/ImageLightbox.css","./ComposerAttachments.css":"src/modules/attachment/ComposerAttachments.css","./MessageImage.css":"src/modules/attachment/MessageImage.css","./FileCard.css":"src/modules/attachment/FileCard.css"},"src/modules/attachment/AttachmentRail.css":{},"src/modules/attachment/DropOverlay.css":{},"src/modules/attachment/ImageLightbox.css":{},"src/modules/attachment/ComposerAttachments.css":{},"src/modules/attachment/MessageImage.css":{},"src/modules/attachment/FileCard.css":{},"src/modules/attachment/FileCard.js":{},"src/modules/attachment/DropOverlay.js":{"./styles":"src/modules/attachment/styles.js"},"src/modules/attachment/ImageLightbox.js":{"./styles":"src/modules/attachment/styles.js"},"src/modules/attachment/labels.js":{},"src/modules/attachment/MessageImages.js":{"./styles":"src/modules/attachment/styles.js","./FileCard":"src/modules/attachment/FileCard.js","./ImageLightbox":"src/modules/attachment/ImageLightbox.js","./labels":"src/modules/attachment/labels.js"}};
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
return __load("src/modules/attachment/index.js");
}
});
