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
const ProducedFiles_1 = require("./ProducedFiles");
const locales_1 = require("./locales");
const turn_deliverables_1 = require("./turn-deliverables");
var ProducedFiles_2 = require("./ProducedFiles");
Object.defineProperty(exports, "ProducedFiles", { enumerable: true, get: function () { return ProducedFiles_2.ProducedFiles; } });
var turn_deliverables_2 = require("./turn-deliverables");
Object.defineProperty(exports, "producedForClosing", { enumerable: true, get: function () { return turn_deliverables_2.producedForClosing; } });
/** Required services for the tail-slot registration and its dictionaries. */
exports.inject = ['slots', 'locale', 'conversationEvents', 'connection'];
/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
function apply(ctx) {
    const connection = ctx.get('connection');
    ctx.conversationEvents.register(turn_deliverables_1.deliverablesDefinition);
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-deliverables: dictionaries');
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select: turn_deliverables_1.selectProducedFiles,
        locale: locales_1.NS,
        inject: () => ({
            isLoopback: connection.isLoopback,
            hooks: { hostDescription: connection.hostDescription },
        }),
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
"src/modules/deliverables/ProducedFiles.js": function(module, exports, require) {
// source: src/modules/deliverables/ProducedFiles.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fitProducedFiles = fitProducedFiles;
exports.ProducedFiles = ProducedFiles;
const jsx_runtime_1 = require("react/jsx-runtime");
// ProducedFiles: the produced-file row a finished turn ends with. The paths
// come pre-matched by the turn-tail chain from the mutation tools'
// follow-along locations, never from the closing prose. Clicking one goes
// through the same openFile the tool rows use — the Host's own opener, on the
// Host machine.
const react_1 = require("react");
const turn_deliverables_1 = require("./turn-deliverables");
const ProducedFiles_styles_1 = __importDefault(require("./ProducedFiles.styles"));
/** At most six chips compete for the one-line summary; every other path stays counted. */
const SHOWN_LIMIT = 6;
/**
 * Select the largest prefix whose measured chips and exact remainder fit.
 * @param available - usable width of the one-line file lane.
 * @param gap - computed flex gap between adjacent visible items.
 * @param chipWidths - measured widths for the candidate file chips.
 * @param moreWidthsByShown - exact localized remainder width for each shown count.
 * @returns Number of leading chips to render.
 */
function fitProducedFiles(available, gap, chipWidths, moreWidthsByShown) {
    if (available <= 0)
        return chipWidths.length;
    const prefix = [0];
    let prefixWidth = 0;
    for (const width of chipWidths) {
        prefixWidth += width;
        prefix.push(prefixWidth);
    }
    let largestFit = 0;
    for (const [shown, width] of prefix.entries()) {
        const more = moreWidthsByShown[shown];
        const items = shown + (more === undefined ? 0 : 1);
        const needed = width + (more ?? 0) + Math.max(0, items - 1) * gap;
        if (needed <= available)
            largestFit = shown;
    }
    return largestFit;
}
function moreLabel(t, count) {
    return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) });
}
/**
 * Render one turn's produced files as openable chips.
 * @param props - selector-matched paths, the chat view's file opener, and the locale seat.
 * @returns The produced-files row.
 */
function ProducedFiles({ matched: paths, openFile, isLoopback, useHostDescription, t, }) {
    const hostCanOpenPath = useHostDescription(description => description?.canOpenPath === true);
    const canOpenPath = isLoopback && hostCanOpenPath;
    const limit = Math.min(paths.length, SHOWN_LIMIT);
    const [shownCount, setShownCount] = (0, react_1.useState)(limit);
    const rowRef = (0, react_1.useRef)(null);
    const chipProbes = (0, react_1.useRef)([]);
    const moreProbe = (0, react_1.useRef)(null);
    (0, react_1.useLayoutEffect)(() => {
        const row = rowRef.current;
        const remainderProbe = moreProbe.current;
        /* v8 ignore next -- React attaches both refs before the layout effect runs. */
        if (row === null || remainderProbe === null)
            return;
        const measure = () => {
            const styles = getComputedStyle(row);
            const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
            // React attaches every still-mounted callback ref before layout effects run.
            const activeChipProbes = chipProbes.current.slice(0, limit);
            if (!activeChipProbes.every((probe) => probe !== null))
                return;
            const chips = activeChipProbes.map(probe => probe.getBoundingClientRect().width);
            const more = Array.from({ length: limit + 1 }, (_, candidate) => {
                if (paths.length === candidate)
                    return undefined;
                remainderProbe.textContent = moreLabel(t, paths.length - candidate);
                return remainderProbe.getBoundingClientRect().width;
            });
            setShownCount(fitProducedFiles(row.clientWidth, gap, chips, more));
        };
        measure();
        if (typeof ResizeObserver === 'undefined')
            return;
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        for (const probe of [...chipProbes.current, moreProbe.current]) {
            if (probe !== null)
                observer.observe(probe);
        }
        return () => { observer.disconnect(); };
    }, [limit, paths, t]);
    const visibleCount = Math.min(shownCount, limit);
    const shown = paths.slice(0, visibleCount);
    const hidden = paths.length - shown.length;
    return ((0, jsx_runtime_1.jsxs)("div", { className: ProducedFiles_styles_1.default.root, children: [(0, jsx_runtime_1.jsx)("span", { className: ProducedFiles_styles_1.default.label, children: t('produced.label') }), (0, jsx_runtime_1.jsxs)("div", { ref: rowRef, className: ProducedFiles_styles_1.default.row, "data-produced-files-row": true, children: [shown.map(path => ((0, jsx_runtime_1.jsx)("button", { type: "button", className: ProducedFiles_styles_1.default.file,
                        // The full path is the disambiguator when two turns produce files
                        // that share a basename; the chip itself stays short.
                        title: path, "aria-label": t('produced.open', { name: path }), onClick: () => { openFile(path); }, children: (0, turn_deliverables_1.basename)(path) }, path))), hidden > 0 && (0, jsx_runtime_1.jsx)("span", { className: ProducedFiles_styles_1.default.more, children: moreLabel(t, hidden) })] }), hidden > 0 && canOpenPath && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: ProducedFiles_styles_1.default.showFolder, onClick: () => { openFile('.'); }, children: t('produced.showInFolder') })), (0, jsx_runtime_1.jsxs)("div", { className: ProducedFiles_styles_1.default.measure, "aria-hidden": "true", children: [paths.slice(0, limit).map((path, index) => ((0, jsx_runtime_1.jsx)("button", { ref: (node) => { chipProbes.current[index] = node; }, type: "button", tabIndex: -1, className: `${ProducedFiles_styles_1.default.file} ${ProducedFiles_styles_1.default.probe}`, children: (0, turn_deliverables_1.basename)(path) }, path))), (0, jsx_runtime_1.jsx)("span", { ref: moreProbe, className: `${ProducedFiles_styles_1.default.more} ${ProducedFiles_styles_1.default.probe}` })] })] }));
}

},
"src/modules/deliverables/turn-deliverables.js": function(module, exports, require) {
// source: src/modules/deliverables/turn-deliverables.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliverablesDefinition = void 0;
exports.producedForClosing = producedForClosing;
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
    if (data === undefined)
        return [];
    const paths = [];
    const seen = new Set();
    for (const produced of data.produced) {
        if (produced.seq > seq || seen.has(produced.path))
            continue;
        seen.add(produced.path);
        paths.push(produced.path);
    }
    return paths;
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
        const additions = producedPaths(context.state.calls.get(callId) ?? null)
            .map(path => ({ seq: match.event.seq, path }));
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
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-deliverables/ProducedFiles.module.css", "@xharness/dsh-client-ui-deliverables", ProducedFiles_css_1.default);
const styles = {
    "file": "iftpVG_file",
    "label": "iftpVG_label",
    "measure": "iftpVG_measure",
    "more": "iftpVG_more",
    "probe": "iftpVG_probe",
    "root": "iftpVG_root",
    "row": "iftpVG_row",
    "showFolder": "iftpVG_showFolder"
};
exports.default = styles;

},
"src/modules/deliverables/ProducedFiles.css": function(module, exports, require) {
// source: src/modules/deliverables/ProducedFiles.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".iftpVG_root{grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px 8px;margin-top:16px;font-size:13px;line-height:22px;display:grid;position:relative}.iftpVG_label{color:var(--dsw-alias-label-tertiary);grid-area:1/1}.iftpVG_row{flex-wrap:nowrap;grid-area:1/2;align-items:center;gap:8px;min-width:0;display:flex;overflow:hidden}.iftpVG_file{text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);max-width:320px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border:none;border-radius:6px;flex:none;margin:0;padding:0 8px;overflow:hidden}.iftpVG_file:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}.iftpVG_file:focus-visible,.iftpVG_showFolder:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3);outline:none}.iftpVG_more{white-space:nowrap;color:var(--dsw-alias-label-tertiary);flex:none}.iftpVG_showFolder{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:4px;grid-area:2/2;justify-self:start;margin:0;padding:0 2px;line-height:20px}.iftpVG_showFolder:hover{color:var(--dsw-alias-label-secondary);text-decoration:underline}.iftpVG_measure{visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;position:absolute;overflow:hidden}.iftpVG_probe{width:max-content;position:absolute;inset:0 auto auto 0}\n";

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
    'produced.label': '产物',
    'produced.moreOne': '+ 1 个文件',
    'produced.more': '+ {count} 个文件',
    'produced.open': '打开 {name}',
    'produced.showInFolder': '在文件夹中显示',
};
/** English dictionary (same key set). */
exports.en = {
    'produced.label': 'Produced',
    'produced.moreOne': '+ 1 file',
    'produced.more': '+ {count} files',
    'produced.open': 'Open {name}',
    'produced.showInFolder': 'Show in folder',
};

}
};
const __dependencies = {"src/modules/deliverables/index.js":{"./ProducedFiles":"src/modules/deliverables/ProducedFiles.js","./locales":"src/modules/deliverables/locales.js","./turn-deliverables":"src/modules/deliverables/turn-deliverables.js"},"src/modules/deliverables/ProducedFiles.js":{"./turn-deliverables":"src/modules/deliverables/turn-deliverables.js","./ProducedFiles.styles":"src/modules/deliverables/ProducedFiles.styles.js"},"src/modules/deliverables/turn-deliverables.js":{},"src/modules/deliverables/ProducedFiles.styles.js":{"./ProducedFiles.css":"src/modules/deliverables/ProducedFiles.css","../views-types":"src/modules/views-types.js"},"src/modules/deliverables/ProducedFiles.css":{},"src/modules/views-types.js":{},"src/modules/deliverables/locales.js":{}};
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
