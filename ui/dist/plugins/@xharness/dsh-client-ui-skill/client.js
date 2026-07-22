// Generated from src/modules/skill/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-skill",
factory: (__externalRequire) => {
const __units = {
"src/modules/skill/index.js": function(module, exports, require) {
// source: src/modules/skill/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
const SkillRow_1 = require("./SkillRow");
const locales_1 = require("./locales");
/** Required services: reference source faces plus the tool-row and locale registries. */
exports.inject = ['inputTriggers', 'connection', 'sessions', 'slots', 'locale', 'remote'];
/**
 * Client plugin body: register the '/' source, dictionaries, and keyed tool row.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-skill: dictionaries');
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'skill', locale: locales_1.NS }, SkillRow_1.SkillRow));
    const skills = (ctx.get('connection')).api.skills;
    const sessions = ctx.get('sessions');
    // Session-keyed catalog cache; single-flight per key. Plugin-closure state:
    // the fiber effect below is its teardown boundary.
    const fetches = new Map();
    // Per-session lexicon invalidation listeners (subscribeLexicon consumers).
    const lexiconListeners = new Map();
    const notifyLexicon = (sessionId) => {
        for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
            try {
                listener();
            }
            catch (error) {
                // Contain listener failures: settlement notifies from an ignored
                // promise chain (a throw would surface as an unhandled rejection)
                // and one faulty consumer must not starve the others.
                console.error('[ui-skill] lexicon listener failed:', error);
            }
        }
    };
    const fetchCatalog = (sessionId) => {
        if (sessions.subagentAddress(sessionId) !== undefined)
            return Promise.resolve([]);
        const existing = fetches.get(sessionId);
        if (existing !== undefined)
            return existing.promise;
        const abort = new AbortController();
        const promise = (async () => {
            const { result } = await skills.list({ sessionId }, abort.signal);
            if (!result.ok)
                throw new Error(`skill.list failed: ${result.error.code}: ${result.error.message}`);
            return result.value.skills;
        })();
        const entry = { promise, abort };
        fetches.set(sessionId, entry);
        promise.then(
        // Settled snapshot backs the synchronous lexicon reads.
        (skills) => {
            entry.settled = skills;
            notifyLexicon(sessionId);
        },
        // A failed fetch must not poison the key: the next consumer retries.
        () => {
            if (fetches.get(sessionId) === entry)
                fetches.delete(sessionId);
        });
        return promise;
    };
    const invalidate = (key) => {
        const entry = fetches.get(key);
        if (entry === undefined)
            return;
        fetches.delete(key);
        entry.abort.abort();
        notifyLexicon(key);
    };
    const clearAll = () => {
        for (const key of [...fetches.keys()])
            invalidate(key);
    };
    // The bound translate resolves against the registered dictionaries with the
    // locale service's own fallback ladder; candidate-time reads stay plain text.
    const t = ctx.locale.bind(locales_1.NS);
    const source = {
        trigger: '/',
        name: 'skill',
        order: 2,
        async candidates(session, { query, signal }) {
            const skills = await fetchCatalog(session.sessionId);
            // Superseded keystroke: the shared fetch stays warm, this caller yields.
            if (signal.aborted)
                return [];
            return skills
                .filter(skill => skill.name.startsWith(query))
                .map(skill => ({
                name: skill.name,
                // The user-only marker rides the description (the menu's only
                // secondary text); `hint` is the claim-state ghost text, not a badge.
                description: skill.modelInvocable ? skill.description : `${t('menu.userOnly')} · ${skill.description}`,
            }));
        },
        warm(session) {
            // Fire-and-forget scope-birth prewarm; the shared fetch reports
            // through candidates.
            fetchCatalog(session.sessionId).catch(() => { });
        },
        lexicon(session) {
            return fetches.get(session.sessionId)?.settled?.map(skill => skill.name);
        },
        subscribeLexicon(session, listener) {
            const key = session.sessionId;
            const listeners = lexiconListeners.get(key) ?? new Set();
            listeners.add(listener);
            lexiconListeners.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0)
                    lexiconListeners.delete(key);
            };
        },
        onPick({ candidate }) {
            // Plain-text-reference decision (web-input-machine note): the pick
            // lands plain text and the prompt ships the same
            // literal. Determinism lives host-side — the host's
            // pre-step boundary (dsh-tool-skill) recognizes the leading /name and
            // injects the rendered body for every entry point. A name shared with a
            // host command still resolves to the command: adjudication claims the
            // line client-side before it ever becomes a prompt.
            return { text: `/${candidate.name} ` };
        },
    };
    const inputTriggers = ctx.get('inputTriggers');
    // A preset decides which skill providers an agent reads, so a switched
    // session's cached catalog belongs to the composition it no longer runs.
    ctx.remote.$on('agent-preset/selected', invalidate);
    ctx.on('connection/reset', clearAll);
    ctx.effect(() => {
        const unregister = inputTriggers.registerSource(source);
        return () => {
            unregister();
            clearAll();
        };
    }, 'ui-skill: source');
}

},
"src/modules/skill/SkillRow.js": function(module, exports, require) {
// source: src/modules/skill/SkillRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillRow = SkillRow;
const jsx_runtime_1 = require("react/jsx-runtime");
// Skill toolview registrant: a domain-owned row over the keyed toolview hole.
// The compact accent row keeps loaded instructions scannable in the transcript;
// the exact durable tool output remains available in a bounded disclosure card.
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const SkillRow_styles_1 = __importDefault(require("./SkillRow.styles"));
/** First physical line for the collapsed error summary and malformed-args fallback. */
function firstLine(text) {
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
}
/** Skill names are the only call argument the compact row presents. */
function skillName(argsRaw, callId) {
    try {
        const parsed = JSON.parse(argsRaw);
        if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
            const name = parsed.name;
            if (typeof name === 'string' && name !== '')
                return firstLine(name);
        }
    }
    catch {
        // Streaming can expose a truncated JSON prefix; its first line is still
        // more useful than replacing the call with an unrelated catalog lookup.
    }
    return argsRaw === '' ? callId : firstLine(argsRaw);
}
/** Flatten durable result blocks under the generic Tool-row text contract.
 *  Keep aligned with ui-tool's models/tool-call-model.ts `resultText`. */
function resultText(block) {
    if (!('kind' in block))
        return null;
    const parts = [];
    for (const item of block.content) {
        parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2));
    }
    if (parts.length === 0 && block.error !== undefined) {
        parts.push(`${block.error.name}: ${block.error.code}`);
    }
    return parts.join('\n') || null;
}
/** Derive display state without consulting the live skill catalog. */
function skillRowModel(block) {
    const settled = 'kind' in block;
    const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
    const state = !settled
        ? 'running'
        : block.error?.code === 'interrupted'
            ? 'stopped'
            : block.isError ? 'error' : 'ok';
    const output = resultText(block);
    return {
        name: skillName(argsRaw, block.callId),
        output,
        errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
        state,
    };
}
/** State substitution for the collapsed leading slot. */
function leadingFor(state) {
    switch (state) {
        case 'error': return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" });
        case 'stopped': return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "warning" });
        default: return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconSkillOutline16, { size: 14 });
    }
}
/** Leading disclosure slot: state icon at rest, chevron on hover or while open. */
function disclosureLeading(state, open, expandable) {
    if (open)
        return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: SkillRow_styles_1.default.chevron });
    const icon = leadingFor(state);
    if (!expandable)
        return icon;
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: SkillRow_styles_1.default.iconIdle, children: icon }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: `${SkillRow_styles_1.default.chevron} ${SkillRow_styles_1.default.chevronHover}` })] }));
}
/** Visually hidden state copy for the colour-only lifecycle cues. */
function stateStatus(state, t) {
    switch (state) {
        case 'running': return t('row.running');
        case 'error': return t('row.failed');
        case 'stopped': return t('row.stopped');
        default: return null;
    }
}
/**
 * Render one `skill` tool call as an accent summary and instructions disclosure.
 * @param props - keyed toolview payload plus the skill locale seat.
 * @returns the dedicated skill row.
 */
function SkillRow({ block, inspect, t }) {
    const model = skillRowModel(block);
    const [expanded, setExpanded] = (0, react_1.useState)(false);
    const expandable = model.output !== null;
    const open = expanded && expandable;
    const status = stateStatus(model.state, t);
    const summary = model.errorSummary ?? model.name;
    const toggleExpand = () => {
        setExpanded(value => !value);
    };
    const toggleFromKeyboard = (event) => {
        if (!expandable || (event.key !== 'Enter' && event.key !== ' '))
            return;
        event.preventDefault();
        toggleExpand();
    };
    const disclosureProps = expandable ? {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: toggleExpand,
        onKeyDown: toggleFromKeyboard,
    } : {};
    const leading = disclosureLeading(model.state, open, expandable);
    return ((0, jsx_runtime_1.jsxs)("div", { className: SkillRow_styles_1.default.card, "data-tool": "skill", "data-state": model.state, children: [(0, jsx_runtime_1.jsxs)("div", { className: SkillRow_styles_1.default.row, "data-expandable": expandable || undefined, ...disclosureProps, children: [(0, jsx_runtime_1.jsx)("span", { className: SkillRow_styles_1.default.leading, children: leading }), status !== null ? (0, jsx_runtime_1.jsx)("span", { className: SkillRow_styles_1.default.visuallyHidden, children: status }) : null, (0, jsx_runtime_1.jsx)("span", { className: SkillRow_styles_1.default.title, children: "Skill" }), (0, jsx_runtime_1.jsx)("span", { className: SkillRow_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: model.errorSummary === null ? SkillRow_styles_1.default.summary : `${SkillRow_styles_1.default.summary} ${SkillRow_styles_1.default.errorSummary}`, children: summary })] }), open ? ((0, jsx_runtime_1.jsxs)("div", { className: SkillRow_styles_1.default.bodyWrap, children: [(0, jsx_runtime_1.jsxs)("section", { className: SkillRow_styles_1.default.instructionsCard, "aria-label": t('row.instructions'), children: [(0, jsx_runtime_1.jsx)("div", { className: SkillRow_styles_1.default.instructionsHeader, children: t('row.instructions') }), (0, jsx_runtime_1.jsx)("pre", { className: SkillRow_styles_1.default.instructions, "data-error": model.state === 'error' || undefined, children: model.output })] }), inspect !== undefined ? ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: SkillRow_styles_1.default.inspectButton, onClick: inspect, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconInspectOutline12, {}), "Inspect"] })) : null] })) : null] }));
}

},
"src/modules/skill/SkillRow.styles.js": function(module, exports, require) {
// source: src/modules/skill/SkillRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SkillRow_css_1 = __importDefault(require("./SkillRow.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-skill/SkillRow.module.css", "@xharness/dsh-client-ui-skill", SkillRow_css_1.default);
const styles = {
    "bodyWrap": "q-Dsrq_bodyWrap",
    "card": "q-Dsrq_card",
    "chevron": "q-Dsrq_chevron",
    "chevronHover": "q-Dsrq_chevronHover",
    "dsh-skill-row-sweep": "q-Dsrq_dsh-skill-row-sweep",
    "errorSummary": "q-Dsrq_errorSummary",
    "iconIdle": "q-Dsrq_iconIdle",
    "inspectButton": "q-Dsrq_inspectButton",
    "instructions": "q-Dsrq_instructions",
    "instructionsCard": "q-Dsrq_instructionsCard",
    "instructionsHeader": "q-Dsrq_instructionsHeader",
    "leading": "q-Dsrq_leading",
    "row": "q-Dsrq_row",
    "separator": "q-Dsrq_separator",
    "summary": "q-Dsrq_summary",
    "title": "q-Dsrq_title",
    "visuallyHidden": "q-Dsrq_visuallyHidden"
};
exports.default = styles;

},
"src/modules/skill/SkillRow.css": function(module, exports, require) {
// source: src/modules/skill/SkillRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".q-Dsrq_card{flex-direction:column;display:flex}.q-Dsrq_row{align-items:center;min-width:0;height:24px;display:flex;position:relative;overflow:hidden}.q-Dsrq_row[data-expandable]{cursor:pointer}.q-Dsrq_card[data-state=running] .q-Dsrq_row:after{content:\"\";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite q-Dsrq_dsh-skill-row-sweep;position:absolute;inset:0 auto 0 0}@keyframes q-Dsrq_dsh-skill-row-sweep{0%{left:-300px}90%,to{left:100%}}.q-Dsrq_leading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}.q-Dsrq_chevron{color:var(--dsw-alias-label-secondary)}.q-Dsrq_iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}.q-Dsrq_chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}.q-Dsrq_row:hover .q-Dsrq_iconIdle{opacity:0}.q-Dsrq_row:hover .q-Dsrq_chevronHover{opacity:1}.q-Dsrq_title{color:var(--dsw-alias-label-secondary);flex:none;font-size:14px;line-height:24px}.q-Dsrq_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.q-Dsrq_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.q-Dsrq_errorSummary{color:var(--dsw-alias-state-error-primary)}.q-Dsrq_bodyWrap{flex-direction:column;display:flex}.q-Dsrq_instructionsCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);border-radius:12px;flex-direction:column;max-height:260px;margin:4px 0 4px 4px;display:flex;overflow:hidden}.q-Dsrq_instructionsHeader{border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;flex:none;padding:8px 12px;font-size:11px;font-weight:500;line-height:16px}.q-Dsrq_instructions{white-space:pre-wrap;overflow-wrap:anywhere;min-height:0;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary);margin:0;padding:10px 12px 12px;overflow:auto}.q-Dsrq_instructions[data-error]{color:var(--dsw-alias-state-error-primary)}.q-Dsrq_instructions::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}.q-Dsrq_instructions::-webkit-scrollbar-track{margin:6px 0}.q-Dsrq_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}.q-Dsrq_card:hover .q-Dsrq_inspectButton,.q-Dsrq_inspectButton:focus-visible{opacity:1}.q-Dsrq_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.q-Dsrq_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:reduce){.q-Dsrq_card[data-state=running] .q-Dsrq_row:after{animation:none;display:none}.q-Dsrq_iconIdle,.q-Dsrq_chevronHover,.q-Dsrq_inspectButton{transition:none}}\n";

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
"src/modules/skill/locales.js": function(module, exports, require) {
// source: src/modules/skill/locales.ts

"use strict";
/** `skill` namespace dictionaries for the dedicated tool row. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'skill';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'row.running': '正在加载 skill',
    'row.failed': 'skill 加载失败',
    'row.stopped': 'skill 加载已中止',
    'row.instructions': '说明',
    'menu.userOnly': '仅用户',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'row.running': 'Loading skill',
    'row.failed': 'Skill load failed',
    'row.stopped': 'Skill load stopped',
    'row.instructions': 'Instructions',
    'menu.userOnly': 'user-only',
};

}
};
const __dependencies = {"src/modules/skill/index.js":{"./SkillRow":"src/modules/skill/SkillRow.js","./locales":"src/modules/skill/locales.js"},"src/modules/skill/SkillRow.js":{"./SkillRow.styles":"src/modules/skill/SkillRow.styles.js"},"src/modules/skill/SkillRow.styles.js":{"./SkillRow.css":"src/modules/skill/SkillRow.css","../views-types":"src/modules/views-types.js"},"src/modules/skill/SkillRow.css":{},"src/modules/views-types.js":{},"src/modules/skill/locales.js":{}};
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
return __load("src/modules/skill/index.js");
}
});
