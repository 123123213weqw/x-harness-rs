// Generated from src/modules/cordis/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-cordis",
factory: (__externalRequire) => {
const __units = {
"src/modules/cordis/index.js": function(module, exports, require) {
// source: src/modules/cordis/index.ts

"use strict";
/// <reference path="./externals.d.ts" />
/** Cordis dynamic-plugin cards, inventory panel, business-view host, and `@pluginId` source. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const CordisActionRow_1 = require("./CordisActionRow");
const CordisDefineRow_1 = require("./CordisDefineRow");
const CordisRunRow_1 = require("./CordisRunRow");
const CordisPanel_1 = require("./CordisPanel");
const inventory_1 = require("./inventory");
const run_card_index_1 = require("./run-card-index");
const locales_1 = require("./locales");
/** Required services for the two Tool cards, panel, Remote lifecycle, and Slash source. */
exports.inject = [
    'slots', 'locale', 'inputTriggers', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner',
];
/** Mount every Cordis browser surface over the shared Host inventory. */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-cordis: dictionaries');
    const port = {
        stop: async (sessionId, pluginId) => {
            const answered = await ctx.remote.dynamicCordisRunner.stopFromPanel(sessionId, pluginId);
            if (!answered.ok)
                return { ok: false, message: `${answered.error.code}: ${answered.error.message}` };
            if (answered.value.ok || answered.value.reason === 'not-running')
                return { ok: true };
            return { ok: false, message: answered.value.message };
        },
        remove: async (sessionId, pluginId) => {
            const answered = await ctx.remote.dynamicCordisRunner.undefineFromPanel(sessionId, pluginId);
            if (!answered.ok)
                return { ok: false, message: `${answered.error.code}: ${answered.error.message}` };
            return answered.value.ok ? { ok: true } : { ok: false, message: answered.value.message };
        },
        inventory: async () => {
            const answered = await ctx.remote.dynamicCordisRunner.inventory();
            if (!answered.ok)
                throw new Error(`${answered.error.code}: ${answered.error.message}`);
            return answered.value;
        },
    };
    const inventory = (0, inventory_1.createCordisInventory)(port, (error) => {
        console.error('[ui-cordis] reading the Cordis inventory failed:', error);
    });
    const runner = ctx.dynamicCordisRunner;
    const loaded = { getSnapshot: () => runner.getSnapshot(), subscribe: (fn) => runner.subscribe(fn) };
    const runCards = new run_card_index_1.CordisRunCardRegistry();
    ctx.effect(() => inventory.subscribe(() => {
        const snapshot = inventory.getSnapshot();
        if (snapshot.read)
            runner.reconcileApprovals(snapshot.rows);
    }), 'ui-cordis: reconcile pending approvals');
    ctx.remote.$on('cordis/dynamic-package', () => { inventory.refresh(); });
    ctx.remote.$on('cordis/dynamic-retract', () => { inventory.refresh(); });
    ctx.remote.$on('cordis/request-run', (request) => {
        if (!inventory.getSnapshot().rows.some(row => row.pluginId === request.pluginId))
            inventory.refresh();
    });
    ctx.remote.$on('cordis/request-run-resolved', () => { inventory.refresh(); });
    ctx.on('connection/reset', () => {
        inventory.reset();
        inventory.refresh();
    });
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'cordis-panel',
        locale: locales_1.NS,
        inject: () => ({
            hooks: {
                inventory,
                activeRuns: runner.activeRuns,
                runErrors: runner.lastRunError,
                loaded,
                renderFailures: runner.renderFailures,
            },
            onApprove: (requestId, approveFutureVersions) => runner.approve(requestId, approveFutureVersions),
            onDecline: requestId => runner.decline(requestId),
            onRun: request => runner.startUserRun(request),
            onStop: async (sessionId, pluginId) => {
                const result = await port.stop(sessionId, pluginId);
                inventory.refresh();
                return result;
            },
            onRemove: async (sessionId, pluginId) => {
                const result = await port.remove(sessionId, pluginId);
                if (result.ok)
                    inventory.retire(pluginId);
                inventory.refresh();
                return result;
            },
            onRefresh: () => { inventory.refresh(); },
        }),
    }, CordisPanel_1.CordisPanel));
    const cardFace = () => ({ hooks: { inventory, loaded } });
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'cordis_define',
        locale: locales_1.NS,
        inject: cardFace,
    }, CordisDefineRow_1.CordisDefineRow));
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'cordis_run',
        locale: locales_1.NS,
        children: { 'tool.view.cordis': { kind: 'keyed', scope: 'session' } },
        inject: (sessionId) => {
            const store = runCards.forSession(sessionId);
            return {
                hooks: { inventory, loaded, runCards: store, activeRuns: runner.activeRuns },
                onObserveRunCard: (pointer) => { store.observe(pointer); },
            };
        },
    }, CordisRunRow_1.CordisRunRow));
    ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({
            name: 'tool.call.toolview', key: 'cordis_stop', locale: locales_1.NS,
        }, CordisActionRow_1.CordisActionRow);
        yield ctx.slots.register({
            name: 'tool.call.toolview', key: 'cordis_undefine', locale: locales_1.NS,
        }, CordisActionRow_1.CordisActionRow);
    });
    const rowsOf = (sessionId, query) => inventory.getSnapshot().rows
        .filter(row => row.agentId === sessionId && String(row.pluginId).includes(query));
    const source = {
        trigger: '@',
        name: 'cordis',
        order: 1,
        candidates(session, { query }) {
            const rows = rowsOf(session.sessionId, query);
            return Promise.resolve(rows.map((row) => {
                const packageId = row.nextPackageId ?? row.currentPackageId ?? row.packages.at(-1)?.packageId;
                const pkg = packageId === undefined ? undefined : row.packages.find(candidate => candidate.packageId === packageId);
                return {
                    name: String(row.pluginId),
                    ...pkg === undefined ? {} : { description: pkg.purpose },
                };
            }));
        },
        warm() { inventory.refresh(); },
        lexicon(session) { return rowsOf(session.sessionId, '').map(row => String(row.pluginId)); },
        subscribeLexicon(_session, listener) { return inventory.subscribe(listener); },
        onPick({ candidate }) { return { text: `@${candidate.name} ` }; },
    };
    const slash = ctx.get('inputTriggers');
    ctx.effect(() => slash.registerSource(source), 'ui-cordis: @pluginId source');
    inventory.refresh();
}

},
"src/modules/cordis/CordisActionRow.js": function(module, exports, require) {
// source: src/modules/cordis/CordisActionRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CordisActionRow = CordisActionRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
/** Localized cards for `cordis_stop` and `cordis_undefine`. */
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const card_model_1 = require("./card-model");
const CordisRunRow_styles_1 = __importDefault(require("./CordisRunRow.styles"));
/** Render one Stop or Remove call with Cordis-owned localized copy. */
function CordisActionRow({ callId, toolName, block, inspect, t }) {
    const card = (0, card_model_1.cordisActionCard)(block);
    const remove = toolName === 'cordis_undefine';
    const summary = card.errorSummary ?? card.pluginId ?? callId;
    return ((0, jsx_runtime_1.jsxs)("div", { className: CordisRunRow_styles_1.default.card, "data-tool": toolName, "data-state": card.state, children: [(0, jsx_runtime_1.jsxs)("div", { className: CordisRunRow_styles_1.default.row, children: [(0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.icon, children: card.state === 'error'
                            ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" })
                            : card.state === 'stopped'
                                ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "warning" })
                                : remove ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTrashOutline16, { size: 14 }) : (0, jsx_runtime_1.jsx)(primitives_1.IconStopFill16, { size: 14 }) }), (0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.title, children: t(remove ? 'row.removeTitle' : 'row.stopTitle') }), (0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: card.errorSummary === null ? CordisRunRow_styles_1.default.summary : CordisRunRow_styles_1.default.error, children: summary }), inspect !== undefined && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: CordisRunRow_styles_1.default.inspect, "aria-label": "Inspect", onClick: inspect, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconInspectOutline12, {}) }))] }), card.output !== null && (0, jsx_runtime_1.jsx)("pre", { className: CordisRunRow_styles_1.default.output, children: card.output })] }));
}

},
"src/modules/cordis/primitives.js": function(module, exports, require) {
// source: src/modules/cordis/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeBlock = exports.IconCordisPluginOutline14 = exports.IconCodeOutline16 = exports.IconStopFill16 = void 0;
/** Genuine platform components and props; no local shadow facade. */
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "IconStopFill16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconStopFill16; } });
Object.defineProperty(exports, "IconCodeOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconCodeOutline16; } });
Object.defineProperty(exports, "IconCordisPluginOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconCordisPluginOutline14; } });
Object.defineProperty(exports, "CodeBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.CodeBlock; } });

},
"src/modules/cordis/card-model.js": function(module, exports, require) {
// source: src/modules/cordis/card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cordisDefineCard = cordisDefineCard;
exports.cordisRunCard = cordisRunCard;
exports.cordisActionCard = cordisActionCard;
const runtime_types_1 = require("../shared/runtime-types");
const wire_1 = require("../cordis-client-runner/wire");
function pluginId(value) { return value === null ? null : wire_1.CordisDynamicPluginId.parse(value); }
function packageId(value) { return value === null ? null : wire_1.CordisDynamicPackageId.parse(value); }
function pluginRunId(value) { return value === null ? null : wire_1.CordisDynamicPluginRunId.parse(value); }
function firstLine(text) {
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
}
function stringAt(source, key) {
    const value = source[key];
    return typeof value === 'string' && value !== '' ? value : null;
}
function objectAt(source, key) {
    const value = source[key];
    return (0, runtime_types_1.isObjectRecord)(value) ? value : null;
}
function parseArgs(argsRaw) {
    try {
        const parsed = JSON.parse(argsRaw);
        return (0, runtime_types_1.isObjectRecord)(parsed) ? parsed : null;
    }
    catch {
        // Running calls can expose a truncated JSON prefix.
        return null;
    }
}
function resultText(block) {
    const text = block.content
        .map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
        .join('\n');
    if (text !== '')
        return text;
    return block.error === undefined ? null : `${block.error.name}: ${block.error.code}`;
}
function stateOf(block) {
    if (!('kind' in block))
        return 'running';
    if (block.error?.code === 'interrupted')
        return 'stopped';
    return block.isError ? 'error' : 'ok';
}
function metaObject(block) {
    if (!('kind' in block) || block.isError || !(0, runtime_types_1.isObjectRecord)(block.meta))
        return null;
    return block.meta;
}
/**
 * Derive one Define card from its frozen call/result slice.
 * @param block - active or settled tool-call block.
 * @returns normalized Define card fields.
 */
function cordisDefineCard(block) {
    const settled = 'kind' in block;
    const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
    const args = parseArgs(argsRaw);
    const code = args === null ? null : objectAt(args, 'code');
    const state = stateOf(block);
    const output = settled ? resultText(block) : null;
    const meta = metaObject(block);
    const rawName = argsRaw === '' ? null : firstLine(argsRaw);
    return {
        pluginId: pluginId(meta === null ? null : stringAt(meta, 'pluginId')),
        packageId: packageId(meta === null ? null : stringAt(meta, 'packageId')),
        name: args === null ? rawName : stringAt(args, 'name') ?? rawName,
        purpose: args === null ? null : stringAt(args, 'purpose'),
        hostCode: code === null ? null : stringAt(code, 'host'),
        clientCode: code === null ? null : stringAt(code, 'client'),
        output,
        errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
        state,
    };
}
/**
 * Derive one Run card and its successful activation metadata.
 * @param block - active or settled tool-call block.
 * @returns normalized Run card fields.
 */
function cordisRunCard(block) {
    const settled = 'kind' in block;
    const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
    const args = parseArgs(argsRaw);
    const meta = metaObject(block);
    const state = stateOf(block);
    const output = settled ? resultText(block) : null;
    const rawMode = args === null ? null : stringAt(args, 'mode');
    const argsPluginId = args === null ? null : stringAt(args, 'pluginId');
    const argsPackageId = args === null ? null : stringAt(args, 'packageId');
    return {
        pluginId: pluginId(meta === null ? argsPluginId : stringAt(meta, 'pluginId') ?? argsPluginId),
        packageId: packageId(meta === null ? argsPackageId : stringAt(meta, 'packageId') ?? argsPackageId),
        pluginRunId: pluginRunId(meta === null ? null : stringAt(meta, 'pluginRunId')),
        mode: rawMode === 'run' || rawMode === 'update' ? rawMode : null,
        seq: settled ? block.seq : null,
        output,
        errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
        state,
    };
}
/**
 * Derive one Stop or Remove card from its frozen call/result slice.
 * @param block - active or settled tool-call block.
 * @returns normalized lifecycle-action card fields.
 */
function cordisActionCard(block) {
    const settled = 'kind' in block;
    const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
    const args = parseArgs(argsRaw);
    const state = stateOf(block);
    const output = settled ? resultText(block) : null;
    return {
        pluginId: pluginId(args === null ? null : stringAt(args, 'pluginId') ?? stringAt(args, 'id')),
        output,
        errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
        state,
    };
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

},
"src/modules/cordis-client-runner/wire.js": function(module, exports, require) {
// source: src/modules/cordis-client-runner/wire.ts

"use strict";
/**
 * Client-safe wire vocabulary of the dynamic Cordis plugin runner.
 * @module @xharness/dsh-cordis-host-runner/types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonValueSchema = exports.CordisInspectRequestId = exports.ApprovalRequestId = exports.CordisDynamicPluginRunId = exports.CordisDynamicPackageId = exports.CordisDynamicPluginId = void 0;
exports.requireJsonValue = requireJsonValue;
exports.isJsonValue = isJsonValue;
const zod_1 = require("zod");
exports.CordisDynamicPluginId = zod_1.z.string().brand();
exports.CordisDynamicPackageId = zod_1.z.string().brand();
exports.CordisDynamicPluginRunId = zod_1.z.string().brand();
exports.ApprovalRequestId = zod_1.z.string().brand();
exports.CordisInspectRequestId = zod_1.z.string().brand();
exports.jsonValueSchema = zod_1.z.json();
/** Validate without replacing the object used by provider/handler identity. */
function requireJsonValue(value) {
    if (!isJsonValue(value))
        throw new TypeError('Cordis inspect result must be JSON');
    return value;
}
function isJsonValue(value) { return exports.jsonValueSchema.safeParse(value).success; }

},
"src/modules/cordis/CordisRunRow.styles.js": function(module, exports, require) {
// source: src/modules/cordis/CordisRunRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const CordisRunRow_css_1 = __importDefault(require("./CordisRunRow.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-cordis/CordisRunRow.module.css", '@xharness/dsh-client-ui-cordis', CordisRunRow_css_1.default);
const styles = {
    "business": "KkBbda_business",
    "card": "KkBbda_card",
    "error": "KkBbda_error",
    "icon": "KkBbda_icon",
    "inspect": "KkBbda_inspect",
    "message": "KkBbda_message",
    "output": "KkBbda_output",
    "row": "KkBbda_row",
    "separator": "KkBbda_separator",
    "status": "KkBbda_status",
    "summary": "KkBbda_summary",
    "title": "KkBbda_title"
};
exports.default = styles;

},
"src/modules/cordis/CordisRunRow.css": function(module, exports, require) {
// source: src/modules/cordis/CordisRunRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".KkBbda_card{flex-direction:column;gap:8px;display:flex}.KkBbda_row{align-items:center;min-height:32px;display:flex}.KkBbda_icon{color:var(--dsw-alias-state-business-primary);flex:none;margin-right:8px;display:inline-flex}.KkBbda_title{color:var(--dsw-alias-state-business-primary);flex:none;font-size:14px;font-weight:500;line-height:24px}.KkBbda_separator{background:var(--dsw-alias-state-business-primary);border-radius:50%;flex:none;width:2px;height:2px;margin:0 8px}.KkBbda_summary,.KkBbda_error{min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;line-height:24px;overflow:hidden}.KkBbda_error{color:var(--dsw-alias-state-error-primary)}.KkBbda_status{color:var(--dsw-alias-label-caption);flex:none;margin-left:8px;font-size:12px;line-height:24px}.KkBbda_card[data-cordis-status=awaiting-approval] .KkBbda_status,.KkBbda_card[data-cordis-status=client-pending] .KkBbda_status{color:var(--dsw-alias-state-warn-label)}.KkBbda_card[data-cordis-status=running] .KkBbda_status{color:var(--dsw-alias-state-success-primary)}.KkBbda_card[data-cordis-status=failed] .KkBbda_status{color:var(--dsw-alias-state-error-primary)}.KkBbda_inspect{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;margin-left:4px;padding:0;display:inline-flex}.KkBbda_card:hover .KkBbda_inspect,.KkBbda_inspect:focus-visible{opacity:1}.KkBbda_inspect:hover{background:var(--dsw-alias-interactive-bg-hover)}.KkBbda_message{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-tertiary);border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px}.KkBbda_business{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;min-width:0;overflow:hidden}.KkBbda_output{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;margin:0;padding:10px 12px;overflow:auto}.KkBbda_business .KkBbda_output{border:none;border-radius:0}";

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
"src/modules/cordis/CordisDefineRow.js": function(module, exports, require) {
// source: src/modules/cordis/CordisDefineRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CordisDefineRow = CordisDefineRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
/** Read-only `cordis_define` card with Host and Client source tabs. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const card_model_1 = require("./card-model");
const status_1 = require("./status");
const CordisDefineRow_styles_1 = __importDefault(require("./CordisDefineRow.styles"));
const transcript_state_1 = require("./transcript-state");
const READING_LABELS = {
    idle: 'status.idle',
    'client-pending': 'status.clientPending',
    running: 'status.running',
    removed: 'status.removed',
};
function stateStatus(state) {
    switch (state) {
        case 'running': return 'a11y.defining';
        case 'error': return 'a11y.failed';
        case 'stopped': return 'a11y.stopped';
        default: return null;
    }
}
function leadingFor(state) {
    switch (state) {
        case 'error': return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" });
        case 'stopped': return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "warning" });
        default: return (0, jsx_runtime_1.jsx)(primitives_1.IconCodeOutline16, { size: 14 });
    }
}
/** Render one immutable Package definition. */
function CordisDefineRow({ callId, block, inspect, useInventory, useLoaded, t, }) {
    const card = (0, card_model_1.cordisDefineCard)(block);
    const inventory = useInventory(snapshot => snapshot);
    const loaded = useLoaded(snapshot => snapshot);
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('cordis-expanded:' + callId, false);
    const [selectedSource, setSelectedSource] = (0, transcript_state_1.useTranscriptState)('cordis-source:' + callId, card.clientCode !== null ? 'client' : 'host');
    const sourcePanelId = (0, react_1.useId)();
    const row = card.pluginId === null
        ? undefined
        : inventory.rows.find(candidate => candidate.pluginId === card.pluginId);
    const reading = card.pluginId !== null && inventory.removed.has(card.pluginId)
        ? 'removed'
        : row !== undefined && card.packageId !== null
            ? (0, status_1.cordisVisibleStatus)(row, card.packageId, loaded)
            : 'idle';
    const name = card.name ?? callId;
    const expandable = card.hostCode !== null || card.clientCode !== null || card.output !== null;
    const open = expanded && expandable;
    const a11yState = stateStatus(card.state);
    const hasSource = card.clientCode !== null || card.hostCode !== null;
    const activeSource = selectedSource === 'client' && card.clientCode !== null
        ? 'client'
        : selectedSource === 'host' && card.hostCode !== null
            ? 'host'
            : card.clientCode !== null ? 'client' : 'host';
    const activeCode = activeSource === 'client' ? card.clientCode : card.hostCode;
    return ((0, jsx_runtime_1.jsxs)("div", { className: CordisDefineRow_styles_1.default.card, "data-tool": "cordis_define", "data-state": card.state, "data-terminal": reading === 'removed' || undefined, "data-cordis-plugin-id": card.pluginId ?? undefined, "data-cordis-package-id": card.packageId ?? undefined, "data-cordis-status": reading, children: [a11yState !== null && (0, jsx_runtime_1.jsx)("span", { className: CordisDefineRow_styles_1.default.visuallyHidden, children: t(a11yState) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.DisclosureRow, { rowClassName: CordisDefineRow_styles_1.default.row, titleClassName: CordisDefineRow_styles_1.default.title, chevronClassName: CordisDefineRow_styles_1.default.chevron, icon: leadingFor(card.state), title: t('row.defineTitle'), open: open, expandable: expandable, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: () => { setExpanded(value => !value); }, collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: CordisDefineRow_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: card.errorSummary === null ? CordisDefineRow_styles_1.default.name : CordisDefineRow_styles_1.default.errorSummary, children: card.errorSummary ?? name }), card.errorSummary === null && ((0, jsx_runtime_1.jsx)("span", { className: CordisDefineRow_styles_1.default.purpose, children: card.purpose ?? t('purpose.missing') })), card.pluginId !== null && ((0, jsx_runtime_1.jsx)("span", { className: CordisDefineRow_styles_1.default.readout, children: (0, jsx_runtime_1.jsx)("span", { className: CordisDefineRow_styles_1.default.statusLabel, children: t(READING_LABELS[reading]) }) }))] })), children: (0, jsx_runtime_1.jsxs)("div", { className: CordisDefineRow_styles_1.default.bodyWrap, children: [hasSource && activeCode !== null && ((0, jsx_runtime_1.jsxs)("section", { className: CordisDefineRow_styles_1.default.sourceCard, children: [(0, jsx_runtime_1.jsx)("div", { className: CordisDefineRow_styles_1.default.sourceTabs, role: "tablist", "aria-label": t('body.source'), children: ['client', 'host'].map((source) => {
                                        const available = source === 'client' ? card.clientCode !== null : card.hostCode !== null;
                                        return ((0, jsx_runtime_1.jsx)("button", { id: `${sourcePanelId}-${source}`, type: "button", role: "tab", "aria-controls": sourcePanelId, "aria-selected": activeSource === source, className: activeSource === source ? `${CordisDefineRow_styles_1.default.sourceTab} ${CordisDefineRow_styles_1.default.sourceTabActive}` : CordisDefineRow_styles_1.default.sourceTab, disabled: !available, onClick: () => { setSelectedSource(source); }, children: t(source === 'client' ? 'body.clientCode' : 'body.hostCode') }, source));
                                    }) }), (0, jsx_runtime_1.jsx)("div", { id: sourcePanelId, className: CordisDefineRow_styles_1.default.sourcePanel, role: "tabpanel", "aria-labelledby": `${sourcePanelId}-${activeSource}`, children: (0, jsx_runtime_1.jsx)(primitives_1.CodeBlock, { code: activeCode, lang: "javascript", copyLabel: t('body.copy'), copiedLabel: t('body.copied'), className: CordisDefineRow_styles_1.default.sourceCode }) })] })), card.output !== null && ((0, jsx_runtime_1.jsxs)("section", { className: CordisDefineRow_styles_1.default.codeSection, children: [(0, jsx_runtime_1.jsx)("div", { className: CordisDefineRow_styles_1.default.sectionLabel, children: t('body.output') }), (0, jsx_runtime_1.jsx)("pre", { className: CordisDefineRow_styles_1.default.output, "data-error": card.state === 'error' || undefined, children: card.output })] })), card.pluginId !== null && (0, jsx_runtime_1.jsx)("div", { className: CordisDefineRow_styles_1.default.panelHint, children: t('panel.hint') }), inspect !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: CordisDefineRow_styles_1.default.inspectButton, onClick: inspect, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconInspectOutline12, {}), "Inspect"] }))] }) })] }));
}

},
"src/modules/cordis/status.js": function(module, exports, require) {
// source: src/modules/cordis/status.ts

"use strict";
/** Shared status derivation over Host inventory and this page's Client live set. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.packageOf = packageOf;
exports.cordisVisibleStatus = cordisVisibleStatus;
/**
 * Locate one immutable Package inside a Plugin row.
 * @param row - owning Plugin inventory row.
 * @param packageId - immutable Package identity to locate.
 * @returns the matching Package metadata, or `undefined` when absent.
 */
function packageOf(row, packageId) {
    return row.packages.find(pkg => pkg.packageId === packageId);
}
/**
 * Derive the visible state of one Package.
 * @param row - owning Plugin inventory row.
 * @param packageId - Package being described.
 * @param loaded - Client activations loaded in this page.
 * @returns idle, Host-running/Client-pending, or fully running.
 */
function cordisVisibleStatus(row, packageId, loaded) {
    const run = row.activeRun;
    if (run === undefined || run.packageId !== packageId)
        return 'idle';
    const pkg = packageOf(row, packageId);
    if (pkg?.hasClientHalf !== true)
        return 'running';
    return loaded.some(live => live.pluginId === row.pluginId
        && live.packageId === packageId
        && live.pluginRunId === run.pluginRunId)
        ? 'running'
        : 'client-pending';
}

},
"src/modules/cordis/CordisDefineRow.styles.js": function(module, exports, require) {
// source: src/modules/cordis/CordisDefineRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const CordisDefineRow_css_1 = __importDefault(require("./CordisDefineRow.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-cordis/CordisDefineRow.module.css", '@xharness/dsh-client-ui-cordis', CordisDefineRow_css_1.default);
const styles = {
    "approvalPrompt": "tCdZ6q_approvalPrompt",
    "bodyWrap": "tCdZ6q_bodyWrap",
    "card": "tCdZ6q_card",
    "chevron": "tCdZ6q_chevron",
    "codeSection": "tCdZ6q_codeSection",
    "errorSummary": "tCdZ6q_errorSummary",
    "inspectButton": "tCdZ6q_inspectButton",
    "name": "tCdZ6q_name",
    "notice": "tCdZ6q_notice",
    "output": "tCdZ6q_output",
    "panelHint": "tCdZ6q_panelHint",
    "purpose": "tCdZ6q_purpose",
    "readout": "tCdZ6q_readout",
    "requestError": "tCdZ6q_requestError",
    "row": "tCdZ6q_row",
    "sectionLabel": "tCdZ6q_sectionLabel",
    "separator": "tCdZ6q_separator",
    "sourceCard": "tCdZ6q_sourceCard",
    "sourceCode": "tCdZ6q_sourceCode",
    "sourcePanel": "tCdZ6q_sourcePanel",
    "sourceTab": "tCdZ6q_sourceTab",
    "sourceTabActive": "tCdZ6q_sourceTabActive",
    "sourceTabs": "tCdZ6q_sourceTabs",
    "statusLabel": "tCdZ6q_statusLabel",
    "switch": "tCdZ6q_switch",
    "title": "tCdZ6q_title",
    "visuallyHidden": "tCdZ6q_visuallyHidden"
};
exports.default = styles;

},
"src/modules/cordis/CordisDefineRow.css": function(module, exports, require) {
// source: src/modules/cordis/CordisDefineRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".tCdZ6q_card{flex-direction:column;display:flex}.tCdZ6q_card .tCdZ6q_title,.tCdZ6q_card .tCdZ6q_chevron{color:var(--dsw-alias-state-business-primary)}.tCdZ6q_title{flex:none;font-size:14px;font-weight:500;line-height:24px}.tCdZ6q_row{gap:0}.tCdZ6q_separator{background:var(--dsw-alias-state-business-primary);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.tCdZ6q_name{text-overflow:ellipsis;white-space:nowrap;max-width:40%;color:var(--dsw-alias-label-secondary);flex:none;font-size:14px;line-height:24px;overflow:hidden}.tCdZ6q_purpose{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;margin-left:8px;font-size:13px;line-height:24px;overflow:hidden}.tCdZ6q_errorSummary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-state-error-primary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.tCdZ6q_requestError{text-overflow:ellipsis;white-space:nowrap;max-width:40%;color:var(--dsw-alias-state-error-primary);flex:none;margin-left:8px;font-size:12px;line-height:24px;overflow:hidden}.tCdZ6q_readout{flex:none;align-items:center;margin-left:8px;display:inline-flex}.tCdZ6q_panelHint{color:var(--dsw-alias-label-caption);margin:4px 0 2px 4px;font-size:11px;line-height:16px}.tCdZ6q_statusLabel{color:var(--dsw-alias-label-caption);font-size:12px;line-height:24px}.tCdZ6q_approvalPrompt{text-overflow:ellipsis;white-space:nowrap;max-width:40%;color:var(--dsw-alias-label-secondary);flex:none;margin-left:8px;font-size:12px;line-height:24px;overflow:hidden}.tCdZ6q_notice{text-overflow:ellipsis;white-space:nowrap;max-width:40%;color:var(--dsw-alias-label-caption);flex:none;margin-left:8px;font-size:12px;line-height:24px;overflow:hidden}.tCdZ6q_switch{height:22px;padding:0 8px;font-size:12px}.tCdZ6q_card[data-terminal] .tCdZ6q_title,.tCdZ6q_card[data-terminal] .tCdZ6q_name,.tCdZ6q_card[data-terminal] .tCdZ6q_purpose,.tCdZ6q_card[data-terminal] .tCdZ6q_statusLabel{color:var(--dsw-alias-label-caption)}.tCdZ6q_card[data-terminal] .tCdZ6q_separator{background:var(--dsw-alias-label-caption)}.tCdZ6q_bodyWrap{flex-direction:column;display:flex}.tCdZ6q_sourceCard{flex-direction:column;margin:4px 0 4px 4px;display:flex}.tCdZ6q_sourceTabs{border-bottom:1px solid var(--dsw-alias-border-l2);height:32px;display:flex}.tCdZ6q_sourceTab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;padding:0 10px;position:relative}.tCdZ6q_sourceTab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.tCdZ6q_sourceTab:disabled{cursor:default;opacity:.4}.tCdZ6q_sourceTabActive{color:var(--dsw-alias-state-business-primary)}.tCdZ6q_sourceTabActive:after{background:var(--dsw-alias-state-business-primary);content:\"\";border-radius:1px 1px 0 0;height:2px;position:absolute;bottom:0;left:10px;right:10px}.tCdZ6q_sourceTab:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}.tCdZ6q_sourcePanel{max-height:260px;overflow:auto}.tCdZ6q_sourceCode{margin:0}.tCdZ6q_codeSection{flex-direction:column;max-height:260px;margin:4px 0 4px 4px;display:flex;overflow:auto}.tCdZ6q_sectionLabel{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;flex:none;padding:2px 0;font-size:11px;font-weight:500;line-height:16px}.tCdZ6q_output{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary);border-radius:8px;margin:0;padding:8px 10px}.tCdZ6q_output[data-error]{color:var(--dsw-alias-state-error-primary)}.tCdZ6q_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}.tCdZ6q_card:hover .tCdZ6q_inspectButton,.tCdZ6q_inspectButton:focus-visible{opacity:1}.tCdZ6q_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.tCdZ6q_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@media (prefers-reduced-motion:reduce){.tCdZ6q_inspectButton{transition:none}}";

},
"src/modules/cordis/transcript-state.js": function(module, exports, require) {
// source: src/modules/cordis/transcript-state.ts

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
exports.useTranscriptState = useTranscriptState;
const React = __importStar(require("react"));
function useTranscriptState(key, initial) {
    const bridge = globalThis.__xhTranscriptState?.get(React.createElement);
    if (typeof initial === 'boolean')
        return bridge ? bridge.useState(key, initial) : React.useState(initial);
    return bridge ? bridge.useState(key, initial) : React.useState(initial);
}

},
"src/modules/cordis/CordisRunRow.js": function(module, exports, require) {
// source: src/modules/cordis/CordisRunRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CordisRunRow = CordisRunRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
/** `cordis_run` card and the host seat for Package-owned interactive UI. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const card_model_1 = require("./card-model");
const run_card_index_1 = require("./run-card-index");
const status_1 = require("./status");
const CordisRunRow_styles_1 = __importDefault(require("./CordisRunRow.styles"));
const READING_LABELS = {
    idle: 'status.idle',
    'awaiting-approval': 'status.awaitingApproval',
    failed: 'status.failed',
    'client-pending': 'status.clientPending',
    running: 'status.running',
    removed: 'status.removed',
    superseded: 'status.superseded',
};
/** Render one activation result and, when eligible, its Package-owned view. */
function CordisRunRow({ callId, block, inspect, renderSlot, useInventory, useLoaded, useRunCards, useActiveRuns, onObserveRunCard, t, }) {
    const card = (0, card_model_1.cordisRunCard)(block);
    const inventory = useInventory(snapshot => snapshot);
    const loaded = useLoaded(snapshot => snapshot);
    const latest = useRunCards(snapshot => snapshot);
    const activeRuns = useActiveRuns(snapshot => snapshot);
    const key = card.state === 'ok'
        && card.pluginId !== null
        && card.packageId !== null
        && card.pluginRunId !== null
        && card.seq !== null
        ? (0, run_card_index_1.cordisToolViewKey)(card.pluginId, card.packageId)
        : null;
    (0, react_1.useEffect)(() => {
        if (key === null || card.seq === null || card.pluginRunId === null)
            return;
        onObserveRunCard({ key, callId, seq: card.seq, pluginRunId: card.pluginRunId });
    }, [callId, card.pluginRunId, card.seq, key, onObserveRunCard]);
    const row = card.pluginId === null
        ? undefined
        : inventory.rows.find(candidate => candidate.pluginId === card.pluginId);
    const pointer = key === null ? undefined : latest.get(key);
    const superseded = pointer !== undefined && pointer.callId !== callId && pointer.seq >= (card.seq ?? -1);
    const activity = card.pluginId === null ? undefined : activeRuns.get(card.pluginId);
    const attempt = card.pluginRunId !== null && row?.latestRun?.pluginRunId === card.pluginRunId
        ? row.latestRun
        : undefined;
    const awaitingApproval = attempt?.status === 'awaiting-approval' || (card.packageId !== null
        && activity?.phase === 'awaiting-approval'
        && activity.packageId === card.packageId
        && (card.mode === null || activity.mode === card.mode));
    const reading = card.pluginId !== null && inventory.removed.has(card.pluginId)
        ? 'removed'
        : superseded
            ? 'superseded'
            : awaitingApproval
                ? 'awaiting-approval'
                : attempt?.status === 'failed'
                    ? 'failed'
                    : row !== undefined && card.packageId !== null
                        ? (0, status_1.cordisVisibleStatus)(row, card.packageId, loaded)
                        : 'idle';
    const status = t(READING_LABELS[reading]);
    const summary = card.errorSummary
        ?? (card.pluginId === null ? callId : `${card.pluginId}${card.packageId === null ? '' : ` · ${card.packageId}`}`);
    const showBusiness = reading === 'running' && key !== null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: CordisRunRow_styles_1.default.card, "data-tool": "cordis_run", "data-state": card.state, "data-cordis-plugin-id": card.pluginId ?? undefined, "data-cordis-package-id": card.packageId ?? undefined, "data-cordis-run-id": card.pluginRunId ?? undefined, "data-cordis-status": reading, children: [(0, jsx_runtime_1.jsxs)("div", { className: CordisRunRow_styles_1.default.row, children: [(0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.icon, children: card.state === 'error'
                            ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" })
                            : card.state === 'stopped'
                                ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "warning" })
                                : (0, jsx_runtime_1.jsx)(primitives_1.IconCodeOutline16, { size: 14 }) }), (0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.title, children: t(card.mode === 'update' ? 'row.updateTitle' : 'row.runTitle') }), (0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: card.errorSummary === null ? CordisRunRow_styles_1.default.summary : CordisRunRow_styles_1.default.error, children: summary }), (0, jsx_runtime_1.jsx)("span", { className: CordisRunRow_styles_1.default.status, children: status }), inspect !== undefined && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: CordisRunRow_styles_1.default.inspect, "aria-label": "Inspect", onClick: inspect, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconInspectOutline12, {}) }))] }), reading === 'removed' && (0, jsx_runtime_1.jsx)("div", { className: CordisRunRow_styles_1.default.message, children: t('run.removed') }), reading === 'superseded' && (0, jsx_runtime_1.jsx)("div", { className: CordisRunRow_styles_1.default.message, children: t('run.superseded') }), reading === 'failed' && attempt?.error !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: CordisRunRow_styles_1.default.message, children: attempt.error.message })), showBusiness && card.pluginId !== null && card.packageId !== null && card.pluginRunId !== null && ((0, jsx_runtime_1.jsx)("div", { className: CordisRunRow_styles_1.default.business, "data-cordis-business-view": key, children: renderSlot('tool.view.cordis', {
                    pluginId: card.pluginId,
                    packageId: card.packageId,
                    pluginRunId: card.pluginRunId,
                }, {
                    entryKey: key,
                    fallback: card.output === null ? null : (0, jsx_runtime_1.jsx)("pre", { className: CordisRunRow_styles_1.default.output, children: card.output }),
                }) })), !showBusiness && reading !== 'removed' && reading !== 'superseded' && card.output !== null && ((0, jsx_runtime_1.jsx)("pre", { className: CordisRunRow_styles_1.default.output, children: card.output }))] }));
}

},
"src/modules/cordis/run-card-index.js": function(module, exports, require) {
// source: src/modules/cordis/run-card-index.ts

"use strict";
/** Session-local ownership index for Package business views on `cordis_run` cards. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CordisRunCardRegistry = void 0;
exports.cordisToolViewKey = cordisToolViewKey;
function createStore() {
    const pointers = new Map();
    const listeners = new Set();
    let cache;
    return {
        getSnapshot: () => cache ?? (cache = new Map(pointers)),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        observe: (pointer) => {
            const current = pointers.get(pointer.key);
            if (current !== undefined && current.seq >= pointer.seq)
                return;
            pointers.set(pointer.key, pointer);
            cache = undefined;
            for (const listener of [...listeners])
                listener();
        },
    };
}
/** Page-lifetime registry that gives all cards of one session the same Store. */
class CordisRunCardRegistry {
    constructor() {
        this.sessions = new Map();
    }
    /**
     * Return the persistent page-local Store for a session.
     * @param sessionId - session whose cards share supersession state.
     * @returns the page-local Store retained for that session.
     */
    forSession(sessionId) {
        let store = this.sessions.get(sessionId);
        if (store === undefined) {
            store = createStore();
            this.sessions.set(sessionId, store);
        }
        return store;
    }
}
exports.CordisRunCardRegistry = CordisRunCardRegistry;
/**
 * Build the Package business-view key shared by registrations and Run cards.
 * @param pluginId - stable Plugin identity.
 * @param packageId - immutable Package identity.
 * @returns the shared business-view key.
 */
function cordisToolViewKey(pluginId, packageId) {
    return `${pluginId}.${packageId}`;
}

},
"src/modules/cordis/CordisPanel.js": function(module, exports, require) {
// source: src/modules/cordis/CordisPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CordisPanel = CordisPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
/** Frame-wide dynamic Plugin inventory, approvals, versions, and lifecycle actions. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const status_1 = require("./status");
const CordisPanel_styles_1 = __importDefault(require("./CordisPanel.styles"));
const STATUS_LABELS = {
    idle: 'status.idle',
    'awaiting-approval': 'status.awaitingApproval',
    'client-pending': 'status.clientPending',
    running: 'status.running',
    failed: 'status.failed',
};
const RENDER_FAILURE_LABELS = {
    abdicated: 'render.failedAbdicated',
    held: 'render.failedHeld',
};
function selectedPackageIdOf({ pluginId, listed, activity }, selected) {
    const selectedPackageId = selected[pluginId];
    if (selectedPackageId !== undefined
        && listed?.packages.some(pkg => pkg.packageId === selectedPackageId))
        return selectedPackageId;
    return listed?.nextPackageId
        ?? listed?.currentPackageId
        ?? listed?.packages.at(-1)?.packageId
        ?? activity?.packageId;
}
function visiblePanelStatus(view, selectedPackageId, loaded) {
    const { listed, activity } = view;
    const latest = listed?.latestRun;
    if (activity?.phase === 'awaiting-approval' || latest?.status === 'awaiting-approval') {
        return 'awaiting-approval';
    }
    if (latest?.status === 'failed' && latest.packageId === selectedPackageId)
        return 'failed';
    if (listed?.activeRun === undefined)
        return 'idle';
    return (0, status_1.cordisVisibleStatus)(listed, listed.activeRun.packageId, loaded);
}
function blockingFirst(rows) {
    return [
        ...rows.filter(row => row.activity?.phase === 'awaiting-approval'),
        ...rows.filter(row => row.activity?.phase !== 'awaiting-approval'),
    ];
}
function RowAction({ label, children, ...props }) {
    return ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: label, side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: CordisPanel_styles_1.default.actionButton, "aria-label": label, ...props, children: children }) }));
}
function DoubleCheckIcon() {
    return ((0, jsx_runtime_1.jsxs)("span", { className: CordisPanel_styles_1.default.doubleCheck, "aria-hidden": true, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 12 }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 12 })] }));
}
/** Render the inventory panel and its unified footer action. */
function CordisPanel({ wide, useSessions, useInventory, useActiveRuns, useRunErrors, useLoaded, useRenderFailures, onApprove, onDecline, onRun, onStop, onRemove, onRefresh, t, }) {
    const inventory = useInventory(snapshot => snapshot);
    const activeRuns = useActiveRuns(snapshot => snapshot);
    const errors = useRunErrors(snapshot => snapshot);
    const loaded = useLoaded(snapshot => snapshot);
    const renderFailures = useRenderFailures(snapshot => snapshot);
    const current = useSessions(state => state.current);
    const [open, setOpen] = (0, react_1.useState)(false);
    const [selected, setSelected] = (0, react_1.useState)({});
    const [pending, setPending] = (0, react_1.useState)(new Set());
    const [actionErrors, setActionErrors] = (0, react_1.useState)(new Map());
    const visibleRequests = (0, react_1.useRef)(new Set());
    const rootRef = (0, react_1.useRef)(null);
    const [anchor, setAnchor] = (0, react_1.useState)();
    // The panel is position: fixed (the sidebar clips overflow), so it hugs the
    // trigger through a measured offset instead of document flow.
    (0, react_1.useLayoutEffect)(() => {
        if (!open)
            return;
        const place = () => {
            const rect = rootRef.current?.getBoundingClientRect();
            if (rect !== undefined) {
                setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
            }
        };
        place();
        window.addEventListener('resize', place);
        return () => { window.removeEventListener('resize', place); };
    }, [open]);
    (0, dsh_client_ui_primitives_1.useDismissOnOutsidePointer)(rootRef, open, setOpen);
    (0, react_1.useEffect)(() => {
        const now = new Set();
        for (const activity of activeRuns.values()) {
            if (activity.phase === 'awaiting-approval')
                now.add(activity.requestId);
        }
        const discovered = [...now].some(requestId => !visibleRequests.current.has(requestId));
        visibleRequests.current = now;
        if (discovered)
            setOpen(true);
    }, [activeRuns]);
    (0, react_1.useEffect)(() => { onRefresh(); }, [onRefresh]);
    (0, react_1.useEffect)(() => { if (open)
        onRefresh(); }, [onRefresh, open]);
    const byPlugin = new Map();
    for (const listed of inventory.rows) {
        const activity = activeRuns.get(listed.pluginId);
        byPlugin.set(listed.pluginId, {
            pluginId: listed.pluginId,
            agentId: activity?.agentId ?? listed.agentId,
            listed,
            ...activity === undefined ? {} : { activity },
        });
    }
    for (const [pluginId, activity] of activeRuns) {
        if (byPlugin.has(pluginId))
            continue;
        byPlugin.set(pluginId, { pluginId, agentId: activity.agentId, activity });
    }
    const all = [...byPlugin.values()];
    const mine = blockingFirst(all.filter(row => current !== undefined && row.agentId === current));
    const theirs = blockingFirst(all.filter(row => current === undefined || row.agentId !== current));
    const approvals = [...activeRuns.values()].filter(activity => activity.phase === 'awaiting-approval').length;
    const running = all.filter(view => visiblePanelStatus(view, selectedPackageIdOf(view, selected), loaded) === 'running').length;
    if (all.length === 0)
        return null;
    const runAction = async (pluginId, action) => {
        if (pending.has(pluginId))
            return;
        setPending(currentPending => new Set(currentPending).add(pluginId));
        setActionErrors((currentErrors) => {
            const next = new Map(currentErrors);
            next.delete(pluginId);
            return next;
        });
        try {
            const result = await action();
            if (result !== undefined && !result.ok) {
                setActionErrors(currentErrors => new Map(currentErrors).set(pluginId, result.message ?? 'operation failed'));
            }
        }
        catch (error) {
            setActionErrors(currentErrors => new Map(currentErrors).set(pluginId, error instanceof Error ? error.message : String(error)));
        }
        finally {
            setPending((currentPending) => {
                const next = new Set(currentPending);
                next.delete(pluginId);
                return next;
            });
            onRefresh();
        }
    };
    const renderRow = (view) => {
        const { pluginId, listed, activity } = view;
        const selectedPackageId = selectedPackageIdOf(view, selected);
        const selectedPackage = listed !== undefined && selectedPackageId !== undefined
            ? (0, status_1.packageOf)(listed, selectedPackageId)
            : undefined;
        const activePackage = listed?.activeRun === undefined
            ? undefined
            : (0, status_1.packageOf)(listed, listed.activeRun.packageId);
        const name = selectedPackage?.name
            ?? (activity?.phase === 'awaiting-approval' ? activity.name : pluginId);
        const purpose = selectedPackage?.purpose
            ?? (activity?.phase === 'awaiting-approval' ? activity.purpose : '');
        const latest = listed?.latestRun;
        const awaiting = activity?.phase === 'awaiting-approval'
            ? activity.requestId
            : latest?.status === 'awaiting-approval' ? latest.approvalRequestId : undefined;
        const status = visiblePanelStatus(view, selectedPackageId, loaded);
        const busy = pending.has(pluginId) || activity?.phase === 'orchestrating';
        const failure = errors.get(pluginId);
        const hostFailure = latest?.status === 'failed' ? latest.error : undefined;
        const renderFailure = renderFailures.get(pluginId);
        const actionError = actionErrors.get(pluginId);
        const nextPackageId = listed?.nextPackageId !== undefined
            && listed.nextPackageId !== listed.currentPackageId ? listed.nextPackageId : undefined;
        const currentPackageId = listed?.currentPackageId;
        const runMode = listed?.currentPackageId !== undefined
            && selectedPackageId !== listed.currentPackageId ? 'update' : 'run';
        return ((0, jsx_runtime_1.jsxs)("li", { className: CordisPanel_styles_1.default.row, "data-cordis-row": pluginId, "data-cordis-status": status, "data-cordis-awaiting": awaiting !== undefined || undefined, children: [(0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.rowHead, children: [(0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.rowId, children: pluginId }), (0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.rowName, children: name }), (0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.rowStatus, children: t(STATUS_LABELS[status]) })] }), listed !== undefined && listed.packages.length > 1 && selectedPackageId !== undefined && ((0, jsx_runtime_1.jsxs)("label", { className: CordisPanel_styles_1.default.versionPicker, children: [(0, jsx_runtime_1.jsx)("span", { children: t('panel.version') }), (0, jsx_runtime_1.jsx)("select", { value: selectedPackageId, disabled: busy, onChange: (event) => {
                                const selectedPackage = listed.packages.find(pkg => pkg.packageId === event.target.value);
                                if (selectedPackage === undefined)
                                    return;
                                setSelected(currentSelected => ({
                                    ...currentSelected,
                                    [pluginId]: selectedPackage.packageId,
                                }));
                            }, children: listed.packages.map(pkg => ((0, jsx_runtime_1.jsx)("option", { value: pkg.packageId, children: `${pkg.name} · ${pkg.packageId}` }, pkg.packageId))) })] })), (0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.rowDetail, children: [(0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.rowPurpose, children: purpose }), (0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.rowActions, children: [awaiting !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(RowAction, { label: t('action.approveOnce'), "data-cordis-approve": awaiting, disabled: busy, onClick: () => {
                                                void runAction(pluginId, async () => {
                                                    await onApprove(awaiting, false);
                                                    setOpen(false);
                                                });
                                            }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 14 }) }), (0, jsx_runtime_1.jsx)(RowAction, { label: t('action.approvePlugin'), "data-cordis-approve-plugin": awaiting, disabled: busy, onClick: () => {
                                                void runAction(pluginId, async () => {
                                                    await onApprove(awaiting, true);
                                                    setOpen(false);
                                                });
                                            }, children: (0, jsx_runtime_1.jsx)(DoubleCheckIcon, {}) }), (0, jsx_runtime_1.jsx)(RowAction, { label: t('action.decline'), "data-cordis-decline": awaiting, disabled: busy, onClick: () => {
                                                void runAction(pluginId, async () => {
                                                    await onDecline(awaiting);
                                                    setOpen(false);
                                                });
                                            }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 14 }) })] })), awaiting === undefined && listed !== undefined
                                    && selectedPackageId !== undefined && listed.activeRun === undefined && ((0, jsx_runtime_1.jsx)(RowAction, { label: t('action.run'), "data-cordis-switch": "run", disabled: busy, onClick: () => {
                                        void runAction(pluginId, () => onRun({
                                            agentId: listed.agentId,
                                            pluginId,
                                            packageId: selectedPackageId,
                                            mode: runMode,
                                            hasClientHalf: selectedPackage?.hasClientHalf === true,
                                        }));
                                    }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, { size: 14 }) })), awaiting === undefined && listed !== undefined && listed.activeRun !== undefined
                                    && selectedPackageId !== listed.activeRun.packageId && selectedPackage !== undefined && ((0, jsx_runtime_1.jsx)(RowAction, { label: t('action.run'), "data-cordis-switch": "run", disabled: busy, onClick: () => {
                                        void runAction(pluginId, () => onRun({
                                            agentId: listed.agentId,
                                            pluginId,
                                            packageId: selectedPackage.packageId,
                                            mode: runMode,
                                            hasClientHalf: selectedPackage.hasClientHalf,
                                        }));
                                    }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, { size: 14 }) })), awaiting === undefined && listed !== undefined && listed.activeRun !== undefined && status === 'client-pending'
                                    && activePackage !== undefined && selectedPackageId === listed.activeRun.packageId && ((0, jsx_runtime_1.jsx)(RowAction, { label: t('action.run'), "data-cordis-switch": "run", disabled: busy, onClick: () => {
                                        void runAction(pluginId, () => onRun({
                                            agentId: listed.agentId,
                                            pluginId,
                                            packageId: activePackage.packageId,
                                            mode: 'run',
                                            hasClientHalf: true,
                                        }));
                                    }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, { size: 14 }) })), awaiting === undefined && listed !== undefined && listed.activeRun !== undefined && ((0, jsx_runtime_1.jsx)(RowAction, { label: t('action.stop'), "data-cordis-switch": "stop", disabled: busy, onClick: () => { void runAction(pluginId, () => onStop(listed.agentId, pluginId)); }, children: (0, jsx_runtime_1.jsx)(primitives_1.IconStopFill16, { size: 14 }) })), awaiting === undefined && listed !== undefined && ((0, jsx_runtime_1.jsx)(RowAction, { label: t('action.remove'), "data-cordis-remove": pluginId, disabled: busy, onClick: () => { void runAction(pluginId, () => onRemove(listed.agentId, pluginId)); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTrashOutline16, { size: 14 }) }))] })] }), awaiting === undefined && nextPackageId !== undefined && listed !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.transition, children: [(0, jsx_runtime_1.jsx)("span", { children: currentPackageId === undefined ? '' : t('panel.current', { packageId: currentPackageId }) }), (0, jsx_runtime_1.jsx)("span", { children: t('panel.next', { packageId: nextPackageId }) }), (0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.transitionActions, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy, onClick: () => {
                                        void runAction(pluginId, () => onRun({
                                            agentId: listed.agentId,
                                            pluginId,
                                            packageId: nextPackageId,
                                            mode: currentPackageId === undefined ? 'run' : 'update',
                                            hasClientHalf: (0, status_1.packageOf)(listed, nextPackageId)?.hasClientHalf === true,
                                        }));
                                    }, children: t('action.retry') }), currentPackageId !== undefined && ((0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy, onClick: () => {
                                        void runAction(pluginId, () => onRun({
                                            agentId: listed.agentId,
                                            pluginId,
                                            packageId: currentPackageId,
                                            mode: 'run',
                                            hasClientHalf: (0, status_1.packageOf)(listed, currentPackageId)?.hasClientHalf === true,
                                        }));
                                    }, children: t('action.rollback') }))] })] })), failure !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: CordisPanel_styles_1.default.rowError, role: "alert", children: `${failure.message} (${failure.reason})` })), failure === undefined && hostFailure !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: CordisPanel_styles_1.default.rowError, role: "alert", children: `${hostFailure.message} (${hostFailure.phase})` })), actionError !== undefined && (0, jsx_runtime_1.jsx)("div", { className: CordisPanel_styles_1.default.rowError, role: "alert", children: actionError }), renderFailure !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: CordisPanel_styles_1.default.rowError, role: "alert", "data-cordis-render-failure": renderFailure.slot, "data-cordis-render-abdicated": renderFailure.abdicated || undefined, children: `${t(RENDER_FAILURE_LABELS[renderFailure.abdicated ? 'abdicated' : 'held'], {
                        slot: renderFailure.slot,
                    })} ${renderFailure.message}` })), activePackage !== undefined && activePackage.packageId !== selectedPackageId && ((0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.activeVersion, children: `${t('status.running')}: ${activePackage.name} · ${activePackage.packageId}` }))] }, pluginId));
    };
    return ((0, jsx_runtime_1.jsxs)("div", { ref: rootRef, className: wide ? CordisPanel_styles_1.default.layer : `${CordisPanel_styles_1.default.layer} ${CordisPanel_styles_1.default.rail}`, children: [open && anchor !== undefined && ((0, jsx_runtime_1.jsxs)("section", { className: CordisPanel_styles_1.default.panel, style: anchor, "data-cordis-panel": true, "aria-label": t('panel.title'), children: [(0, jsx_runtime_1.jsx)("header", { className: CordisPanel_styles_1.default.header, children: (0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.title, children: t('panel.title') }) }), (0, jsx_runtime_1.jsxs)("div", { className: CordisPanel_styles_1.default.body, children: [inventory.error !== undefined && ((0, jsx_runtime_1.jsx)("p", { className: CordisPanel_styles_1.default.readError, role: "alert", children: t('panel.readFailed', { message: inventory.error }) })), !inventory.read && inventory.error === undefined && (0, jsx_runtime_1.jsx)("p", { className: CordisPanel_styles_1.default.note, children: t('panel.loading') }), inventory.read && all.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: CordisPanel_styles_1.default.note, children: t('panel.empty') }), mine.length > 0 && ((0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { className: CordisPanel_styles_1.default.group, children: t('panel.group.current') }), (0, jsx_runtime_1.jsx)("ul", { className: CordisPanel_styles_1.default.rows, children: mine.map(renderRow) })] })), theirs.length > 0 && ((0, jsx_runtime_1.jsxs)("section", { children: [(0, jsx_runtime_1.jsx)("h3", { className: CordisPanel_styles_1.default.group, children: t('panel.group.others') }), (0, jsx_runtime_1.jsx)("ul", { className: CordisPanel_styles_1.default.rows, children: theirs.map(renderRow) })] }))] })] })), (0, jsx_runtime_1.jsx)("div", { className: CordisPanel_styles_1.default.footerButtons, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: CordisPanel_styles_1.default.badge, "data-cordis-badge": all.length, "data-cordis-approval-badge": approvals, "data-active": approvals > 0 || undefined, "aria-label": t('panel.plugins.aria'), "aria-expanded": open, onClick: () => { setOpen(value => !value); }, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconCordisPluginOutline14, { size: wide ? 16 : 18 }), wide && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.badgeLabel, children: t('panel.trigger') }), (0, jsx_runtime_1.jsx)("span", { className: CordisPanel_styles_1.default.badgeCount, children: t('panel.runningCount', { count: running }) })] }))] }) })] }));
}

},
"src/modules/cordis/CordisPanel.styles.js": function(module, exports, require) {
// source: src/modules/cordis/CordisPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const CordisPanel_css_1 = __importDefault(require("./CordisPanel.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-cordis/CordisPanel.module.css", '@xharness/dsh-client-ui-cordis', CordisPanel_css_1.default);
const styles = {
    "actionButton": "kuOQDq_actionButton",
    "activeVersion": "kuOQDq_activeVersion",
    "badge": "kuOQDq_badge",
    "badgeCount": "kuOQDq_badgeCount",
    "badgeLabel": "kuOQDq_badgeLabel",
    "body": "kuOQDq_body",
    "doubleCheck": "kuOQDq_doubleCheck",
    "footerButtons": "kuOQDq_footerButtons",
    "group": "kuOQDq_group",
    "header": "kuOQDq_header",
    "layer": "kuOQDq_layer",
    "note": "kuOQDq_note",
    "panel": "kuOQDq_panel",
    "rail": "kuOQDq_rail",
    "readError": "kuOQDq_readError",
    "row": "kuOQDq_row",
    "rowActions": "kuOQDq_rowActions",
    "rowDetail": "kuOQDq_rowDetail",
    "rowError": "kuOQDq_rowError",
    "rowHead": "kuOQDq_rowHead",
    "rowId": "kuOQDq_rowId",
    "rowName": "kuOQDq_rowName",
    "rowPurpose": "kuOQDq_rowPurpose",
    "rowStatus": "kuOQDq_rowStatus",
    "rows": "kuOQDq_rows",
    "title": "kuOQDq_title",
    "transition": "kuOQDq_transition",
    "transitionActions": "kuOQDq_transitionActions",
    "versionPicker": "kuOQDq_versionPicker"
};
exports.default = styles;

},
"src/modules/cordis/CordisPanel.css": function(module, exports, require) {
// source: src/modules/cordis/CordisPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".kuOQDq_layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}.kuOQDq_footerButtons{align-items:center;width:100%;display:flex}.kuOQDq_badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}.kuOQDq_badge:hover,.kuOQDq_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}.kuOQDq_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.kuOQDq_badgeCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}.kuOQDq_layer.kuOQDq_rail{width:36px;height:36px;margin:0}.kuOQDq_rail .kuOQDq_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}.kuOQDq_rail .kuOQDq_footerButtons{flex-direction:column;gap:2px}.kuOQDq_panel{z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:420px;max-width:calc(100vw - 24px);max-height:60vh;box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}.kuOQDq_header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex}.kuOQDq_body{flex:1;min-height:0;padding:0 12px 12px;overflow-y:auto}.kuOQDq_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}.kuOQDq_note,.kuOQDq_readError{color:var(--dsw-alias-label-tertiary);margin:4px 0;font-size:12px;line-height:18px}.kuOQDq_readError{color:var(--dsw-alias-state-error-primary)}.kuOQDq_group{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:8px 0;font-size:11px;font-weight:500;line-height:16px}.kuOQDq_rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.kuOQDq_row{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:8px;padding:14px 12px 10px;display:flex}.kuOQDq_row[data-cordis-awaiting]{border-color:var(--dsw-alias-state-business-primary)}.kuOQDq_rowHead{align-items:center;gap:8px;display:flex}.kuOQDq_rowId{color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-mono,monospace);flex:none;font-size:11px;line-height:20px}.kuOQDq_rowName{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.kuOQDq_rowStatus{background:var(--dsw-alias-button-ghost-active-fill);height:20px;color:var(--dsw-alias-label-caption);border-radius:10px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:20px;display:inline-flex}.kuOQDq_row[data-cordis-status=idle] .kuOQDq_rowStatus{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-caption)}.kuOQDq_row[data-cordis-status=awaiting-approval] .kuOQDq_rowStatus,.kuOQDq_row[data-cordis-status=client-pending] .kuOQDq_rowStatus{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}.kuOQDq_row[data-cordis-status=failed] .kuOQDq_rowStatus{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.kuOQDq_row[data-cordis-status=running] .kuOQDq_rowStatus{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}.kuOQDq_rowDetail{align-items:center;gap:8px;min-height:28px;display:flex}.kuOQDq_versionPicker{color:var(--dsw-alias-label-caption);align-items:center;gap:8px;font-size:11px;line-height:18px;display:flex}.kuOQDq_versionPicker select{border:1px solid var(--dsw-alias-border-l2);min-width:0;height:26px;color:var(--dsw-alias-label-secondary);font:inherit;background:0 0;border-radius:7px;flex:1;padding:0 8px}.kuOQDq_rowPurpose{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:18px;overflow:hidden}.kuOQDq_rowError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.kuOQDq_rowActions{flex:none;align-items:center;gap:10px;display:flex}.kuOQDq_transition{min-width:0;color:var(--dsw-alias-label-caption);align-items:center;gap:8px;font-size:11px;line-height:18px;display:flex}.kuOQDq_transitionActions{gap:6px;margin-left:auto;display:flex}.kuOQDq_transitionActions button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:999px;padding:2px 8px}.kuOQDq_transitionActions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.kuOQDq_transitionActions button:disabled{opacity:.4;cursor:default}.kuOQDq_activeVersion{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}.kuOQDq_actionButton{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}.kuOQDq_actionButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.kuOQDq_actionButton:disabled{opacity:.4;cursor:default}.kuOQDq_doubleCheck{width:17px;height:14px;display:inline-block;position:relative}.kuOQDq_doubleCheck svg{position:absolute;top:1px}.kuOQDq_doubleCheck svg:first-child{opacity:.7;left:0}.kuOQDq_doubleCheck svg:last-child{left:5px}";

},
"src/modules/cordis/inventory.js": function(module, exports, require) {
// source: src/modules/cordis/inventory.ts

"use strict";
/**
 * The host's definition registry as this page last read it, owned by the
 * plugin's apply closure.
 *
 * The panel is a frame-wide surface, so it cannot derive this from any session:
 * the registry is global and the read is a single global call. The rows are
 * re-read rather than patched, because the wire announcements
 * (`cordis/dynamic-package` / `/retract`) carry no labels and a definition
 * can appear or disappear between them — a patch-in-place cache would drift into
 * showing definitions the host no longer holds.
 *
 * Reads are single-flight: several announcements settling at once, or a badge
 * opening while a reconnect re-reads, must not multiply the call. Single-flight
 * alone would be wrong across a reconnect, though — the in-flight read belongs to
 * the previous connection, so a reset both discards its answer and frees the slot
 * for a fresh one. Without that, a reconnect either loses its re-read to the old
 * call or has the old host's rows published on top of it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCordisInventory = createCordisInventory;
/**
 * Create the inventory source.
 * @param port - the RPC seam the read goes through.
 * @param onError - reporter for a failed read (console in production, captured in specs).
 * @returns the inventory observable and its read trigger.
 */
function createCordisInventory(port, onError) {
    const listeners = new Set();
    let snapshot = { rows: [], removed: new Set(), read: false };
    let inFlight;
    // Bumped by reset; a read whose generation is stale publishes nothing.
    let generation = 0;
    const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners])
            listener();
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
            listeners.add(fn);
            return () => { listeners.delete(fn); };
        },
        refresh: () => {
            if (inFlight !== undefined)
                return;
            const issued = generation;
            inFlight = port.inventory().then((rows) => {
                if (issued !== generation)
                    return;
                const removed = new Set(snapshot.removed);
                const live = new Set(rows.map(row => row.pluginId));
                for (const previous of snapshot.rows) {
                    if (!live.has(previous.pluginId))
                        removed.add(previous.pluginId);
                }
                publish({ rows, removed, read: true });
            }, (error) => {
                if (issued !== generation)
                    return;
                onError(error);
                // A failed read keeps whatever was shown and says why: dropping the
                // rows would turn a transient wire failure into "nothing is defined".
                publish({
                    rows: snapshot.rows,
                    removed: snapshot.removed,
                    read: snapshot.read,
                    error: error instanceof Error ? error.message : 'reading the cordis inventory failed',
                });
            }).then(() => { if (issued === generation)
                inFlight = undefined; });
        },
        retire: (pluginId) => {
            const removed = new Set(snapshot.removed);
            removed.add(pluginId);
            publish({ ...snapshot, rows: snapshot.rows.filter(row => row.pluginId !== pluginId), removed });
        },
        reset: () => {
            generation += 1;
            inFlight = undefined;
            publish({ rows: [], removed: snapshot.removed, read: false });
        },
    };
}

},
"src/modules/cordis/locales.js": function(module, exports, require) {
// source: src/modules/cordis/locales.ts

"use strict";
/** Cordis dynamic-plugin UI dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
exports.NS = 'cordis';
/** Simplified Chinese Cordis UI messages. */
exports.zh = {
    'row.defineTitle': '注册 Cordis 插件',
    'row.runTitle': '运行 Cordis 插件',
    'row.updateTitle': '更新 Cordis 插件',
    'row.stopTitle': '停止 Cordis 插件',
    'row.removeTitle': '移除 Cordis 插件',
    'purpose.missing': '(未填写用途)',
    'status.idle': '待激活',
    'status.awaitingApproval': '待审批',
    'status.failed': '运行失败',
    'status.clientPending': 'Client 待激活',
    'status.running': '运行中',
    'status.removed': '已移除',
    'status.superseded': '已有更新',
    'run.removed': '包已不存在',
    'run.superseded': '已有更新的运行卡片，请查看下方',
    'panel.hint': '运行控制在左下角设置上方的 Cordis 面板',
    'panel.plugins.aria': 'Cordis 插件',
    'panel.approvals.aria': 'Cordis 审批',
    'panel.trigger': 'Cordis Plugin',
    'panel.runningCount': '{count} running',
    'panel.title': 'Cordis 插件',
    'panel.empty': '还没有定义任何插件',
    'panel.loading': '读取中…',
    'panel.readFailed': '读取插件清单失败：{message}',
    'panel.group.current': '当前会话',
    'panel.group.others': '其他会话',
    'panel.version': '版本',
    'panel.current': '当前：{packageId}',
    'panel.next': '待切换：{packageId}',
    'action.approve': '允许',
    'action.approveOnce': '仅允许此版本',
    'action.approvePlugin': '允许此插件的后续版本',
    'action.decline': '拒绝',
    'action.run': '运行',
    'action.stop': '停止',
    'action.remove': '移除',
    'action.retry': '重试',
    'action.rollback': '回退',
    'render.failedAbdicated': '{slot} 渲染失败，已恢复默认界面：',
    'render.failedHeld': '{slot} 渲染失败：',
    'a11y.defining': '正在定义插件',
    'a11y.failed': '定义失败',
    'a11y.stopped': '定义已中断',
    'body.source': '插件代码',
    'body.hostCode': 'Host',
    'body.clientCode': 'Client',
    'body.output': '结果',
    'body.copy': '复制',
    'body.copied': '已复制',
};
/** English Cordis UI messages. */
exports.en = {
    'row.defineTitle': 'Register Cordis Plugin',
    'row.runTitle': 'Run Cordis Plugin',
    'row.updateTitle': 'Update Cordis Plugin',
    'row.stopTitle': 'Stop Cordis Plugin',
    'row.removeTitle': 'Remove Cordis Plugin',
    'purpose.missing': '(no purpose given)',
    'status.idle': 'Ready',
    'status.awaitingApproval': 'Awaiting approval',
    'status.failed': 'Run failed',
    'status.clientPending': 'Client ready to activate',
    'status.running': 'Running',
    'status.removed': 'Removed',
    'status.superseded': 'Newer run available',
    'run.removed': 'This package no longer exists',
    'run.superseded': 'A newer run card is available below',
    'panel.hint': 'Run controls live in the Cordis panel above Settings',
    'panel.plugins.aria': 'Cordis plugins',
    'panel.approvals.aria': 'Cordis approvals',
    'panel.trigger': 'Cordis Plugin',
    'panel.runningCount': '{count} running',
    'panel.title': 'Cordis plugins',
    'panel.empty': 'No plugins defined yet',
    'panel.loading': 'Reading…',
    'panel.readFailed': 'Reading the plugin inventory failed: {message}',
    'panel.group.current': 'This session',
    'panel.group.others': 'Other sessions',
    'panel.version': 'Version',
    'panel.current': 'Current: {packageId}',
    'panel.next': 'Next: {packageId}',
    'action.approve': 'Allow',
    'action.approveOnce': 'Allow this version only',
    'action.approvePlugin': 'Allow future versions of this plugin',
    'action.decline': 'Decline',
    'action.run': 'Run',
    'action.stop': 'Stop',
    'action.remove': 'Remove',
    'action.retry': 'Retry',
    'action.rollback': 'Roll back',
    'render.failedAbdicated': 'Rendering failed in {slot}; the default UI was restored:',
    'render.failedHeld': 'Rendering failed in {slot}:',
    'a11y.defining': 'Defining the plugin',
    'a11y.failed': 'Definition failed',
    'a11y.stopped': 'Definition interrupted',
    'body.source': 'Plugin source',
    'body.hostCode': 'Host',
    'body.clientCode': 'Client',
    'body.output': 'Result',
    'body.copy': 'Copy',
    'body.copied': 'Copied',
};

}
};
const __dependencies = {"src/modules/cordis/index.js":{"./CordisActionRow":"src/modules/cordis/CordisActionRow.js","./CordisDefineRow":"src/modules/cordis/CordisDefineRow.js","./CordisRunRow":"src/modules/cordis/CordisRunRow.js","./CordisPanel":"src/modules/cordis/CordisPanel.js","./inventory":"src/modules/cordis/inventory.js","./run-card-index":"src/modules/cordis/run-card-index.js","./locales":"src/modules/cordis/locales.js"},"src/modules/cordis/CordisActionRow.js":{"./primitives":"src/modules/cordis/primitives.js","./card-model":"src/modules/cordis/card-model.js","./CordisRunRow.styles":"src/modules/cordis/CordisRunRow.styles.js"},"src/modules/cordis/primitives.js":{},"src/modules/cordis/card-model.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","../cordis-client-runner/wire":"src/modules/cordis-client-runner/wire.js"},"src/modules/shared/runtime-types.js":{},"src/modules/cordis-client-runner/wire.js":{},"src/modules/cordis/CordisRunRow.styles.js":{"./CordisRunRow.css":"src/modules/cordis/CordisRunRow.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/cordis/CordisRunRow.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/cordis/CordisDefineRow.js":{"./primitives":"src/modules/cordis/primitives.js","./card-model":"src/modules/cordis/card-model.js","./status":"src/modules/cordis/status.js","./CordisDefineRow.styles":"src/modules/cordis/CordisDefineRow.styles.js","./transcript-state":"src/modules/cordis/transcript-state.js"},"src/modules/cordis/status.js":{},"src/modules/cordis/CordisDefineRow.styles.js":{"./CordisDefineRow.css":"src/modules/cordis/CordisDefineRow.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/cordis/CordisDefineRow.css":{},"src/modules/cordis/transcript-state.js":{},"src/modules/cordis/CordisRunRow.js":{"./primitives":"src/modules/cordis/primitives.js","./card-model":"src/modules/cordis/card-model.js","./run-card-index":"src/modules/cordis/run-card-index.js","./status":"src/modules/cordis/status.js","./CordisRunRow.styles":"src/modules/cordis/CordisRunRow.styles.js"},"src/modules/cordis/run-card-index.js":{},"src/modules/cordis/CordisPanel.js":{"./primitives":"src/modules/cordis/primitives.js","./status":"src/modules/cordis/status.js","./CordisPanel.styles":"src/modules/cordis/CordisPanel.styles.js"},"src/modules/cordis/CordisPanel.styles.js":{"./CordisPanel.css":"src/modules/cordis/CordisPanel.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/cordis/CordisPanel.css":{},"src/modules/cordis/inventory.js":{},"src/modules/cordis/locales.js":{}};
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
return __load("src/modules/cordis/index.js");
}
});
