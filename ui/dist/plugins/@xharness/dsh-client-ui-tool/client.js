// Generated from src/modules/tool/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-tool",
factory: (__externalRequire) => {
const __units = {
"src/modules/tool/index.js": function(module, exports, require) {
// source: src/modules/tool/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.apply = void 0;
/** Browser Tool plugin: whole-call composition and keyed atomic Tool views. */
var apply_1 = require("./apply");
Object.defineProperty(exports, "apply", { enumerable: true, get: function () { return apply_1.apply; } });
Object.defineProperty(exports, "inject", { enumerable: true, get: function () { return apply_1.inject; } });

},
"src/modules/tool/apply.js": function(module, exports, require) {
// source: src/modules/tool/apply.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const ToolCallTree_1 = require("./tool/ToolCallTree");
const ToolDetails_1 = require("./tool/ToolDetails");
const locale_1 = require("./locale");
const ask_question_row_1 = require("./tool/toolviews/ask-question-row");
const bash_sample_1 = require("./tool/toolviews/bash-sample");
const file_mutation_row_1 = require("./tool/toolviews/file-mutation-row");
const read_row_1 = require("./tool/toolviews/read-row");
const search_row_1 = require("./tool/toolviews/search-row");
const todo_row_1 = require("./tool/toolviews/todo-row");
const web_row_1 = require("./tool/toolviews/web-row");
/** Required services: the slot registry and the Host description used for POSIX `~`. */
exports.inject = ['slots', 'connection'];
/**
 * Mount the whole-Tool renderers and built-in atomic Tool registrations.
 * @param ctx - Client root context.
 */
function apply(ctx) {
    const connection = ctx.get('connection');
    const toolInject = () => ({ hooks: { hostDescription: connection.hostDescription } });
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'tool-call',
        locale: locale_1.CONVERSATION_NS,
        children: {
            'tool.call.toolview': { kind: 'keyed', scope: 'session' },
        },
        inject: toolInject,
    }, ToolCallTree_1.ToolCallTree));
    ctx.slots.inject('conversation.details.tool', () => ctx.slots.register({
        name: 'conversation.details.tool',
        locale: locale_1.CONVERSATION_NS,
        inject: toolInject,
    }, ToolDetails_1.ToolDetails));
    ctx.plugin(bash_sample_1.bashToolviewSample);
    ctx.plugin(read_row_1.readToolview);
    ctx.plugin(file_mutation_row_1.fileMutationToolview);
    ctx.plugin(search_row_1.searchToolview);
    ctx.plugin(web_row_1.webToolview);
    ctx.plugin(todo_row_1.todoToolview);
    ctx.plugin(ask_question_row_1.askQuestionToolview);
}

},
"src/modules/tool/tool/ToolCallTree.js": function(module, exports, require) {
// source: src/modules/tool/tool/ToolCallTree.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolCallTree = ToolCallTree;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Root/subcall Tool composition with one keyed atomic dispatch path. */
const react_1 = require("react");
const GenericToolCard_1 = require("./toolviews/GenericToolCard");
const ToolCallTree_styles_1 = __importDefault(require("./ToolCallTree.styles"));
/** Resolve a Tool call's wire name from either lifecycle form. */
function callName(node) {
    return 'kind' in node ? node.call?.name ?? '' : node.name;
}
/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = (0, react_1.memo)(function ToolCall({ renderSlot, callId, toolName, block, openFile, selected, cwd, home, inspectCall, t, children, }) {
    const owner = (0, react_1.useMemo)(() => ({
        callId,
        toolName,
        block,
        openFile,
        cwd,
        home,
        inspect: () => { inspectCall(callId); },
    }), [callId, toolName, block, openFile, cwd, home, inspectCall]);
    return ((0, jsx_runtime_1.jsxs)("div", { className: ToolCallTree_styles_1.default.callRow, "data-chat-anchor-key": `call:${callId}`, "data-chat-call-id": callId, "data-selected": selected || undefined, children: [renderSlot('tool.call.toolview', owner, {
                entryKey: toolName,
                fallback: (0, jsx_runtime_1.jsx)(GenericToolCard_1.GenericToolCard, { ...owner, t: t }),
            }), children] }));
});
const ToolCallBranch = (0, react_1.memo)(function ToolCallBranch({ renderSlot, block, selectedCallId, cwd, home, openFile, inspectCall, t, }) {
    return ((0, jsx_runtime_1.jsx)(ToolCall, { renderSlot: renderSlot, callId: block.callId, toolName: callName(block), block: block, openFile: openFile, selected: block.callId === selectedCallId, cwd: cwd, home: home, inspectCall: inspectCall, t: t, children: block.subCalls.length > 0 ? ((0, jsx_runtime_1.jsx)("div", { className: ToolCallTree_styles_1.default.subCalls, "data-subcalls": true, children: block.subCalls.map(child => ((0, jsx_runtime_1.jsx)(ToolCallBranch, { renderSlot: renderSlot, block: child, selectedCallId: selectedCallId, cwd: cwd, home: home, openFile: openFile, inspectCall: inspectCall, t: t }, child.callId))) })) : null }));
});
/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
function ToolCallTree({ renderSlot, node, selectedCallId, cwd, openFile, inspectCall, useHostDescription, t, }) {
    const home = useHostDescription(description => description?.home);
    const block = node.data.root;
    return ((0, jsx_runtime_1.jsx)(ToolCallBranch, { renderSlot: renderSlot, block: block, selectedCallId: selectedCallId, cwd: cwd, home: home, openFile: openFile, inspectCall: inspectCall, t: t }));
}

},
"src/modules/tool/tool/toolviews/GenericToolCard.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/GenericToolCard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericToolCard = GenericToolCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../../primitives");
const read_card_model_1 = require("../models/read-card-model");
const diff_card_model_1 = require("../models/diff-card-model");
const search_card_model_1 = require("../models/search-card-model");
const terminal_card_model_1 = require("../models/terminal-card-model");
const web_card_model_1 = require("../models/web-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const agent_communication_model_1 = require("../models/agent-communication-model");
/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS = {
    search: (0, jsx_runtime_1.jsx)(primitives_1.IconSearchOutline16, { size: 14 }),
    read: (0, jsx_runtime_1.jsx)(primitives_1.IconBrowseOutline16, { size: 14 }),
    bash: (0, jsx_runtime_1.jsx)(primitives_1.IconApiOutline14, { size: 14 }),
    write: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 14 }),
    edit: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 14 }),
    code: (0, jsx_runtime_1.jsx)(primitives_1.IconCodeOutline16, { size: 14 }),
    others: (0, jsx_runtime_1.jsx)(primitives_1.IconSparkle16, { size: 14 }),
};
function GenericToolCard({ toolName, block, cwd, home, openFile, inspect, t }) {
    const communication = (0, agent_communication_model_1.agentCommunicationModel)(toolName, block);
    const communicationCopy = communication === null ? null
        : (0, agent_communication_model_1.agentCommunicationCopy)(communication, document.documentElement.lang.toLowerCase().startsWith('zh'));
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block, cwd, home);
    const terminal = (0, terminal_card_model_1.terminalCardModel)(block, cwd);
    const read = (0, read_card_model_1.readCardModel)(block, cwd, home);
    const diff = (0, diff_card_model_1.diffCardModel)(block);
    const search = (0, search_card_model_1.searchCardModel)(block);
    const web = (0, web_card_model_1.webCardModel)(block);
    // A failing exit status is the terminal card's own error signal (the call
    // itself settles isError:false), surfaced as the row's red state dot.
    const state = model.state === 'ok' && terminal !== null && (0, terminal_card_model_1.terminalFailed)(terminal)
        ? 'error'
        : model.state;
    const singleFile = model.filePath !== undefined;
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: VARIANT_ICONS[model.variant], title: communicationCopy?.title ?? model.title,
        // A terminal presenter's description is the contract's above-card text, so
        // it outranks the args-derived summary here exactly as it does in BashRow;
        // a search result view's replacement title outranks it the same way.
        summary: communicationCopy?.summary ?? terminal?.description ?? search?.title ?? model.summary, summarySuffix: communicationCopy?.status,
        // Single-file tools never expose an args body — the path link is the only
        // args interaction. A card is not an args body: a read/write/edit row is
        // single-file AND carries a card, so the card expands under the path link.
        body: communicationCopy?.body ?? (singleFile ? null : model.body), output: communication?.output ?? model.output, errorSummary: communication === null ? model.errorSummary : null, terminal: terminal, diff: diff, read: read, search: search, web: web, state: communication?.state ?? state, filePath: model.filePath, onOpenFile: singleFile ? openFile : undefined, inspect: inspect }));
}

},
"src/modules/tool/primitives.js": function(module, exports, require) {
// source: src/modules/tool/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconGlobeOutline14 = exports.IconChecklistOutline14 = exports.IconChevronDownOutline14 = exports.IconQuestionOutline14 = exports.IconSparkle16 = exports.IconSearchOutline16 = exports.IconEditOutline16 = exports.IconCodeOutline16 = exports.IconBrowseOutline16 = exports.IconApiOutline14 = exports.IconInspectOutline12 = exports.DisclosureRow = exports.StateDot = exports.CodeBlock = exports.TerminalBlock = exports.WebBlock = exports.SearchBlock = exports.ReadBlock = exports.DiffBlock = void 0;
/** Implementations and props come from the real platform source. */
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "DiffBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.DiffBlock; } });
Object.defineProperty(exports, "ReadBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.ReadBlock; } });
Object.defineProperty(exports, "SearchBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.SearchBlock; } });
Object.defineProperty(exports, "WebBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.WebBlock; } });
Object.defineProperty(exports, "TerminalBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.TerminalBlock; } });
Object.defineProperty(exports, "CodeBlock", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.CodeBlock; } });
Object.defineProperty(exports, "StateDot", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.StateDot; } });
Object.defineProperty(exports, "DisclosureRow", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.DisclosureRow; } });
Object.defineProperty(exports, "IconInspectOutline12", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconInspectOutline12; } });
Object.defineProperty(exports, "IconApiOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconApiOutline14; } });
Object.defineProperty(exports, "IconBrowseOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconBrowseOutline16; } });
Object.defineProperty(exports, "IconCodeOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconCodeOutline16; } });
Object.defineProperty(exports, "IconEditOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconEditOutline16; } });
Object.defineProperty(exports, "IconSearchOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSearchOutline16; } });
Object.defineProperty(exports, "IconSparkle16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSparkle16; } });
Object.defineProperty(exports, "IconQuestionOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconQuestionOutline14; } });
Object.defineProperty(exports, "IconChevronDownOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronDownOutline14; } });
Object.defineProperty(exports, "IconChecklistOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChecklistOutline14; } });
Object.defineProperty(exports, "IconGlobeOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconGlobeOutline14; } });

},
"src/modules/tool/tool/models/read-card-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/read-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_READ_MAX_LINES = void 0;
exports.readCardModel = readCardModel;
const view_codec_1 = require("./view-codec");
/**
 * Pure derivation of the read-card props from a frozen call slice: the
 * `card:'read'` render intent the read tool declares arrives on the snapshot as
 * the settled result node's `resultView`, and this is the one place that turns
 * it into what {@link ReadBlock} draws. Both conversation render sites (the chat
 * tool row's resident body and the details panel's Output section) call this, so
 * the path, lines, total, and language they show are derived once.
 *
 * The read card is result-side only ([read card note](../../../../../../.agents/notes/implemented/feature/2026-07-30-web-read-card.md)):
 * a call carries no file content until `execute` returns, so the pending call
 * stays a generic card (`kind: 'read'`). A running read therefore has no read
 * card, and this returns null for it — the row keeps its args-derived summary
 * until the result arrives.
 * @module
 */
const runtime_1 = require("../../runtime");
const tool_call_model_1 = require("./tool-call-model");
/**
 * Content lines the chat row's resident read body shows before collapsing the
 * middle — half the primitive's own default, which the details panel keeps. A
 * chat row is a summary surface inside the message flow: the flow must stay
 * scannable across many calls, while the details panel is the single-call
 * reading surface. A design constant of this UI's row geometry, not a
 * deployment choice, so it is fixed here rather than a plugin Config field. The
 * same split [`CHAT_TERMINAL_MAX_LINES`](./terminal-card-model.ts) draws for
 * terminal output.
 */
exports.CHAT_READ_MAX_LINES = 8;
/**
 * Derive the read-card props for a tool call, or null when this call is not a
 * read card and belongs on the generic path.
 *
 * The read card is result-side only, so only a settled call whose result view
 * declares `card:'read'` produces one. Every other case is null — the
 * documented generic-card default:
 *
 * - A running call: it has no result view yet, and a read carries no content at
 *   call time.
 * - A settled call whose result view is not a read card — including a `card`
 *   value this UI version does not know, which arrives over the wire and cannot
 *   be trusted to be one of the compiled variants, and the read tool's own
 *   generic fallback for an error result or a non-envelope body.
 *
 * The label is the read view's `title` when the tool supplied one (the
 * presentation contract's replacement-title rule), otherwise the file path
 * shortened the same way the row summary is: workspace-relative first, then
 * POSIX `~` for a leftover host-home path.
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @param sessionCwd - the session workspace root; a workspace-rooted absolute
 *   path label displays relative to it. Absent leaves the path as authored.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the read-card props, or null for the generic path.
 */
function readCardModel(block, sessionCwd, home) {
    // Running has no result view; a read carries no content until execute returns.
    if (!('kind' in block))
        return null;
    const result = (0, view_codec_1.isView)(block.resultView, 'read') ? block.resultView : null;
    if (result === null)
        return null;
    // Lines arrive frozen off the snapshot; copy into the primitive's own line
    // shape so the card never holds a reference into the runtime's cache.
    const lines = result.lines.map(line => ({ number: line.number, text: line.text }));
    return {
        label: result.title ?? (0, runtime_1.abbreviateHomePath)((0, tool_call_model_1.relativizeToCwd)(result.path, sessionCwd), home),
        lines,
        totalLines: result.totalLines,
        lang: result.lang,
    };
}

},
"src/modules/tool/tool/models/view-codec.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/view-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isView = isView;
const zod_1 = require("zod");
/** ToolEventView wire admits arbitrary card tags; only consumed presentation fields are decoded here. */
const title = { title: zod_1.z.string().optional() };
const terminalCall = zod_1.z.looseObject({ card: zod_1.z.literal('terminal'), title: zod_1.z.string().optional(), description: zod_1.z.string().optional(), cwd: zod_1.z.string().optional() });
const terminalResult = zod_1.z.looseObject({ card: zod_1.z.literal('terminal'), ...title, output: zod_1.z.string().optional(), exitCode: zod_1.z.number().optional(), signal: zod_1.z.string().optional() });
const diff = zod_1.z.looseObject({ card: zod_1.z.literal('diff'), diffs: zod_1.z.unknown() });
const read = zod_1.z.looseObject({ card: zod_1.z.literal('read'), ...title, path: zod_1.z.string(), lines: zod_1.z.array(zod_1.z.looseObject({ number: zod_1.z.number(), text: zod_1.z.string() })), totalLines: zod_1.z.number(), lang: zod_1.z.string().optional() });
const search = zod_1.z.looseObject({ card: zod_1.z.literal('search'), ...title, truncated: zod_1.z.boolean(), total: zod_1.z.number(), shape: zod_1.z.string(), files: zod_1.z.unknown().optional(), paths: zod_1.z.unknown().optional() });
const web = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.looseObject({ card: zod_1.z.literal('web'), kind: zod_1.z.literal('search'), answer: zod_1.z.string().optional(), sources: zod_1.z.array(zod_1.z.looseObject({ url: zod_1.z.string(), title: zod_1.z.string().optional(), snippet: zod_1.z.string().optional(), publishedAt: zod_1.z.string().optional() })), truncated: zod_1.z.boolean() }),
    zod_1.z.looseObject({ card: zod_1.z.literal('web'), kind: zod_1.z.literal('fetch'), url: zod_1.z.string(), statusCode: zod_1.z.number(), truncated: zod_1.z.boolean() }),
]);
const schemas = { terminalCall, terminalResult, diff, read, search, web };
/** Validation never replaces the original view or discards foreign producer fields. */
function isView(value, kind) {
    return schemas[kind].safeParse(value).success;
}

},
"src/modules/tool/runtime.js": function(module, exports, require) {
// source: src/modules/tool/runtime.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkspacePath = exports.abbreviateHomePath = void 0;
/** Display-only path helpers; no filesystem operation runs here. */
var client_1 = require("@xharness/dsh-client-runtime/client");
Object.defineProperty(exports, "abbreviateHomePath", { enumerable: true, get: function () { return client_1.abbreviateHomePath; } });
Object.defineProperty(exports, "resolveWorkspacePath", { enumerable: true, get: function () { return client_1.resolveWorkspacePath; } });

},
"src/modules/tool/tool/models/tool-call-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/tool-call-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VARIANT_TITLES = void 0;
exports.classifyTool = classifyTool;
exports.resultText = resultText;
exports.relativizeToCwd = relativizeToCwd;
exports.toolRowModel = toolRowModel;
/**
 * Pure row-model derivation for tool summary rows: variant classification,
 * one-line summary, expanded-body text, and flattened result output from the
 * frozen call slice. Input material comes from the call ARGUMENTS; output and
 * error material from the settled result node. A call whose render intent is
 * a terminal card gets its expanded body from the views instead, through
 * `terminalCardModel` in terminal-card-model.ts.
 */
// The block union's defining home is runtime (fold-product types); this
// contract only forwards it (type-definition authority stays with the layer
// that produces the values).
const value_guards_1 = require("../../value-guards");
const shell_error_summary_1 = require("./shell-error-summary");
const runtime_1 = require("../../runtime");
/** Figma row titles per variant (design literals, not translatable copy). */
exports.VARIANT_TITLES = {
    search: 'Search', read: 'Read', bash: 'Bash',
    write: 'Write', edit: 'Edit', code: 'Code', others: 'Tool call',
};
/**
 * Known tool name -> variant.
 *
 * `cordis_define` is deliberately absent: ui-cordis registers a keyed
 * `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row
 * (this table is only reached through GenericToolCard, the dispatch fallback in
 * ToolCallTree). An entry here would be unreachable, and a second title for the
 * same call would be a second answer to a question the card already owns.
 */
const TOOL_VARIANTS = {
    bash: 'bash',
    // The PowerShell twin is a shell tool: the bash row family (icon, colors)
    // with its own title from TOOL_TITLES, not the generic `others` row.
    pwsh: 'bash',
    read: 'read',
    web_fetch: 'read',
    web_search: 'search',
    grep: 'search',
    glob: 'search',
    write: 'write',
    edit: 'edit',
    run_code: 'code',
    cordis_package_inspect: 'read',
    cordis_runtime_inspect: 'read',
    // The three run-control verbs take one package id and produce a receipt, so
    // the generic row is the decided intent, not an unclassified default: there is
    // no program to show (that is `cordis_define`'s card) and no file to open. The
    // id lands in the summary slot, and the titles below name the act.
    cordis_run: 'others',
    cordis_stop: 'others',
    cordis_undefine: 'others',
};
/** Tool-owned titles that refine a generic row variant without replacing it. */
const TOOL_TITLES = {
    cordis_package_inspect: 'Inspect',
    cordis_runtime_inspect: 'Inspect',
    cordis_run: 'Run Cordis Plugin',
    cordis_stop: 'Stop Cordis Plugin',
    cordis_undefine: 'Remove Cordis Plugin',
    pwsh: 'Pwsh',
};
/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, others when unknown.
 */
function classifyTool(toolName) {
    return TOOL_VARIANTS[toolName] ?? 'others';
}
/**
 * Flatten a settled result's content blocks to display text: text blocks
 * verbatim, other block shapes as pretty JSON. Empty content on a failed call
 * falls back to the structured error's `name: code` line.
 * @param node - the settled result node.
 * @returns the flattened result text (may be empty).
 */
function resultText(node) {
    const parts = [];
    for (const block of node.content) {
        if ((0, value_guards_1.isRecord)(block) && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        else {
            const text = JSON.stringify(block, null, 2);
            if (text !== undefined)
                parts.push(text);
        }
    }
    if (parts.length === 0 && node.error !== undefined) {
        parts.push(`${node.error.name}: ${node.error.code}`);
    }
    return parts.join('\n');
}
function parseArgs(argsRaw) {
    try {
        const parsed = JSON.parse(argsRaw);
        return parsed;
    }
    catch {
        // Non-JSON args (mid-stream truncation): summary/body fall back to the raw string.
        return undefined;
    }
}
function firstLine(text) {
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
}
function pickString(args, keys) {
    for (const key of keys) {
        const v = args[key];
        if (typeof v === 'string' && v !== '')
            return v;
    }
    return undefined;
}
/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
const SUMMARY_KEYS = {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description'],
    others: [],
};
/**
 * Strip the workspace root from a workspace-rooted absolute path (display only).
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
function relativizeToCwd(text, cwd) {
    if (cwd === undefined || cwd === '')
        return text;
    const root = cwd.replace(/[/\\]+$/, '');
    if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`))
        return text.slice(root.length + 1);
    return text;
}
function deriveSummary(variant, argsRaw) {
    const parsed = parseArgs(argsRaw);
    if (!(0, value_guards_1.isRecord)(parsed))
        return firstLine(argsRaw);
    const args = parsed;
    if (variant === 'search' && (0, value_guards_1.isUnknownArray)(args.queries)) {
        const queries = args.queries.filter((query) => typeof query === 'string' && query !== '');
        if (queries.length > 0)
            return queries.map(firstLine).join(', ');
    }
    const picked = pickString(args, SUMMARY_KEYS[variant]);
    if (picked !== undefined)
        return firstLine(picked);
    for (const v of Object.values(args)) {
        if (typeof v === 'string' && v !== '')
            return firstLine(v);
    }
    return firstLine(argsRaw);
}
/** Path keys only — never `url` (web_fetch lands on the read variant). */
const FILE_PATH_KEYS = ['path', 'file_path'];
/** File-tool variants whose summary may be an openable workspace path. */
const FILE_PATH_VARIANTS = new Set(['read', 'write', 'edit']);
function deriveFilePath(variant, argsRaw) {
    if (!FILE_PATH_VARIANTS.has(variant))
        return undefined;
    const parsed = parseArgs(argsRaw);
    if (!(0, value_guards_1.isRecord)(parsed))
        return undefined;
    const picked = pickString(parsed, FILE_PATH_KEYS);
    return picked === undefined ? undefined : firstLine(picked);
}
function deriveBody(variant, argsRaw) {
    if (argsRaw === '')
        return null;
    const parsed = parseArgs(argsRaw);
    if (parsed === undefined)
        return argsRaw;
    // The code row's expanded body IS the program (monospace via the row's
    // variant styling), not the args JSON envelope around it.
    if (variant === 'code' && (0, value_guards_1.isRecord)(parsed)) {
        const code = parsed.code;
        if (typeof code === 'string' && code !== '')
            return code;
    }
    return JSON.stringify(parsed, null, 2) ?? null;
}
/**
 * Derive the full row model from a frozen call slice.
 * @param toolName - wire tool name (dispatch-supplied; survives windowless results).
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @param cwd - session workspace root; workspace-rooted path summaries display relative to it.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the row model.
 */
function toolRowModel(toolName, block, cwd, home) {
    const variant = classifyTool(toolName);
    const done = 'kind' in block;
    const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? '';
    const state = !done ? argsRaw === '' ? 'preparing' : 'running'
        : block.error?.code === 'interrupted' ? 'stopped'
            : block.isError ? 'error' : 'ok';
    const base = argsRaw === ''
        ? ''
        : (0, runtime_1.abbreviateHomePath)(relativizeToCwd(deriveSummary(variant, argsRaw), cwd), home);
    const toolTitle = TOOL_TITLES[toolName];
    // Others keeps the static "Tool call" title (figma literal); the real tool
    // name rides the mutable summary slot unless the tool owns a specific title.
    const summary = variant === 'others' && toolName !== '' && toolTitle === undefined
        ? `${toolName} · ${base}`
        : base;
    // The empty string is "no text" for both derived result fields: a settled
    // call with blank content has nothing to expand, and a blank first line
    // would erase the collapsed error row's summary slot.
    const output = done ? (resultText(block) || null) : null;
    const errorSummary = done
        ? (0, shell_error_summary_1.shellErrorSummary)(toolName, block, output ?? '')
            ?? (state === 'error' && output !== null ? firstLine(output) : null) : null;
    return {
        variant,
        title: toolTitle ?? exports.VARIANT_TITLES[variant],
        summary,
        filePath: deriveFilePath(variant, argsRaw),
        body: deriveBody(variant, argsRaw),
        output,
        errorSummary,
        state,
    };
}

},
"src/modules/tool/value-guards.js": function(module, exports, require) {
// source: src/modules/tool/value-guards.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRecord = isRecord;
exports.isUnknownArray = isUnknownArray;
/** Object/array admission does not assign unverified fields a domain type. */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isUnknownArray(value) {
    return Array.isArray(value);
}

},
"src/modules/tool/tool/models/shell-error-summary.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/shell-error-summary.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellErrorSummary = shellErrorSummary;
/** Presentation only: never reinterpret a process exit as successful execution. */
const zod_1 = require("zod");
const view_codec_1 = require("./view-codec");
const processResult = zod_1.z.looseObject({
    kind: zod_1.z.literal('foreground'),
    stdout: zod_1.z.string(),
    stderr: zod_1.z.string(),
    exit_code: zod_1.z.number().int().safe().nullable(),
    signal: zod_1.z.union([zod_1.z.string(), zod_1.z.number().int().safe()]).nullable(),
    success: zod_1.z.boolean(),
    termination: zod_1.z.string().optional(),
});
const hostEnvelope = zod_1.z.looseObject({
    ok: zod_1.z.boolean(),
    error: zod_1.z.string(),
    truncated: zod_1.z.boolean(),
    content: zod_1.z.unknown(),
});
const MAX_ENVELOPE_CHARS = 256 * 1024;
const SCAN_CHARS = 32 * 1024;
const LINE_CHARS = 240;
function parse(text) {
    if (text.length > MAX_ENVELOPE_CHARS)
        return undefined;
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
function lines(text) {
    // Bound only the collapsed preview. Full output stays untouched in details.
    const window = text.length > SCAN_CHARS * 2
        ? text.slice(0, SCAN_CHARS) + '\n' + text.slice(-SCAN_CHARS) : text;
    return window
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
}
function summary(exitCode, signal, stdout, stderr, termination) {
    const prefix = termination === 'timedout' ? 'Timed out'
        : termination === 'cancelled' ? 'Cancelled'
            : signal !== null ? `Signal ${signal}`
                : exitCode !== null && exitCode !== 0 ? `Exit ${exitCode}` : 'Tool failed';
    const errors = [...lines(stderr), ...lines(stdout)];
    const diagnostic = errors.find(line => /^(?:error(?:\[[^\]]+\])?:|fatal(?: error)?:|Traceback\b|.*command not found:)/i.test(line))
        ?? lines(stderr)[0];
    return diagnostic === undefined ? prefix : `${prefix} · ${diagnostic.slice(0, LINE_CHARS)}`;
}
/** Accept only shell tools and known Host process/view envelopes. Generic tool
 * JSON, raw result output, success state and interruption semantics are retained.
 */
function shellErrorSummary(toolName, node, output) {
    if (toolName !== 'bash' && toolName !== 'pwsh')
        return null;
    if (node.error?.code === 'interrupted')
        return null;
    const terminal = (0, view_codec_1.isView)(node.resultView, 'terminalResult') ? node.resultView : null;
    const legacyExit = terminal !== null && ((terminal.exitCode !== undefined && terminal.exitCode !== 0) || terminal.signal !== undefined);
    if (!node.isError && !legacyExit)
        return null;
    const metadata = processResult.safeParse(node.meta);
    if (metadata.success) {
        const p = metadata.data;
        return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination);
    }
    if (terminal !== null && (terminal.exitCode !== undefined || terminal.signal !== undefined)) {
        return summary(terminal.exitCode ?? null, terminal.signal ?? null, terminal.output ?? '', '');
    }
    const decoded = parse(output);
    const direct = processResult.safeParse(decoded);
    if (direct.success) {
        const p = direct.data;
        return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination);
    }
    const envelope = hostEnvelope.safeParse(decoded);
    if (!envelope.success)
        return null;
    const inner = processResult.safeParse(typeof envelope.data.content === 'string'
        ? parse(envelope.data.content) : envelope.data.content);
    if (inner.success) {
        const p = inner.data;
        return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination);
    }
    // Execution/permission failures may not have launched a process at all.
    return envelope.data.ok === false ? lines(envelope.data.error)[0]?.slice(0, LINE_CHARS) ?? null : null;
}

},
"src/modules/tool/tool/models/diff-card-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/diff-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_DIFF_MAX_LINES = void 0;
exports.diffCardModel = diffCardModel;
const view_codec_1 = require("./view-codec");
/**
 * Pure derivation of the diff-card props from a frozen call slice: the
 * `card:'diff'` render intent the write/edit tools declare arrives on the
 * snapshot as `callView`/`resultView`, and this is the one place that turns
 * that pair into what {@link DiffBlock} draws. Both conversation render sites
 * (the chat tool row's expanded body and the details panel's Output section)
 * call this, so the hunks they show are derived once.
 * @module
 */
const value_guards_1 = require("../../value-guards");
/**
 * Diff-body lines the chat row shows before collapsing the middle — half the
 * primitive's own default, which the details panel keeps. A chat row is a
 * summary surface inside the message flow: the flow must stay scannable across
 * many calls, while the details panel is the single-call reading surface. The
 * same split {@link CHAT_TERMINAL_MAX_LINES} draws for a terminal card, so the
 * two card kinds cap a long body at the same place in the flow. A design
 * constant of this UI's row geometry, not a deployment choice.
 */
exports.CHAT_DIFF_MAX_LINES = 8;
/**
 * Narrow a wire `card:'diff'` view's `diffs` to well-formed hunks. The event
 * view crosses the wire and `toolEventViewSchema` validates only the `card`
 * string, so a version mismatch or an anomalous plugin can deliver a `diff` card
 * whose `diffs` is absent, not an array, or carries malformed hunks. Returning
 * null for any of those routes the block to the generic path instead of letting
 * DiffBlock's `for...of`/`split` throw and crash the row or the details panel.
 * @param diffs - the view's `diffs` field, unverified.
 * @returns the validated hunks, or null when the payload is not usable.
 */
function narrowDiffs(diffs) {
    if (!(0, value_guards_1.isUnknownArray)(diffs) || diffs.length === 0)
        return null;
    const out = [];
    for (const hunk of diffs) {
        if (!(0, value_guards_1.isRecord)(hunk))
            return null;
        const { path, oldText, newText } = hunk;
        if (typeof path !== 'string')
            return null;
        if (oldText !== null && typeof oldText !== 'string')
            return null;
        if (typeof newText !== 'string')
            return null;
        out.push({ path, oldText, newText });
    }
    return out;
}
/**
 * Derive the diff-card props for a tool call, or null when this call is not a
 * diff card and belongs on the generic path.
 *
 * The result side is authoritative once the call settles: the write/edit tools
 * return the applied contextual hunks there (an edit's real before/after, a
 * create's whole-file diff), which replace the call-time diff derived from the
 * arguments alone. While the call is still running only the call side exists,
 * so a running write/edit shows its intended change. Null is the documented
 * generic-card default and covers every non-diff card — including a `card`
 * value this UI version does not know, which arrives over the wire and cannot
 * be trusted to be one of the compiled variants — and a settled call whose
 * result view is generic (how write/edit keep their execution errors on the
 * generic path).
 *
 * This derivation consumes only `diffs`; the render intent's `title` field is
 * deliberately dropped. The row supplies its own title (`Edit`/`Write · path`
 * from the args), which outranks the view's `title`. A tool that names its own
 * diff header therefore does not surface that text on the Web row.
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @returns the diff-card props, or null for the generic path.
 */
function diffCardModel(block) {
    if (!('kind' in block)) {
        // Running: the call view may carry the intended diff; the result is absent.
        const call = (0, view_codec_1.isView)(block.callView, 'diff') ? block.callView : null;
        const diffs = call === null ? null : narrowDiffs(call.diffs);
        return diffs === null ? null : { card: { diffs } };
    }
    // Settled: the result view's applied hunks replace the call-time diff. A
    // window that dropped the call head leaves only the result, which still
    // renders — the result view carries the whole change.
    const result = (0, view_codec_1.isView)(block.resultView, 'diff') ? block.resultView : null;
    const diffs = result === null ? null : narrowDiffs(result.diffs);
    return diffs === null ? null : { card: { diffs } };
}

},
"src/modules/tool/tool/models/search-card-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/search-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_SEARCH_MAX_LINES = void 0;
exports.searchCardModel = searchCardModel;
const view_codec_1 = require("./view-codec");
/**
 * Pure derivation of the search-card props from a frozen call slice: the
 * `card:'search'` render intent the `grep` and `glob` tools declare arrives on
 * the snapshot as `resultView`, and this is the one place that turns it into
 * what {@link SearchBlock} draws. Both conversation render sites (the chat tool
 * row's resident body and the details panel's Output section) call this, so the
 * grouped matches or the path list they show are derived once.
 *
 * The search card is result-time only: a search call has no matches or paths
 * before `execute`, so its pending state stays a `GenericCallView`
 * ({@link module:@xharness/dsh-tools/src/presentation}). This derivation
 * therefore reads only `resultView` and returns null for a still-running call,
 * unlike the terminal card whose call view carries the command before
 * execution.
 *
 * A capped result also carries a recovery locator (grep/glob's `Full … stored
 * at …` footer) in the raw `tool/result` content, not in the structured
 * matches/paths the view carries. Since both render sites replace that raw
 * result with the card, this derivation surfaces the block's own result text as
 * {@link SearchCardModel.recovery} so the one path to the dropped rows is not
 * lost.
 * @module
 */
const value_guards_1 = require("../../value-guards");
/**
 * Result rows the chat row's resident search body shows before collapsing the
 * middle — half the primitive's own default, which the details panel keeps. A
 * chat row is a summary surface inside the message flow: the flow must stay
 * scannable across many calls, while the details panel is the single-call
 * reading surface. A design constant of this UI's row geometry, not a
 * deployment choice, so it is fixed here rather than a plugin Config field.
 */
exports.CHAT_SEARCH_MAX_LINES = 8;
/**
 * Whether every file group in a matches view is structurally valid: the wire
 * frame carries `shape` and `card` as strings the host schema checks, but not the
 * grouped `files` fields, so a version mismatch or loose producer could deliver
 * `shape: 'matches'` with a missing or malformed `files`. Rendering that would
 * crash {@link SearchBlock} at `.reduce`/`.map`; invalid fields select the
 * generic path instead.
 * @param files - the candidate `files` field off the untrusted result view.
 * @returns whether `files` is a valid {@link SearchFileGroup} array.
 */
function isValidFiles(files) {
    return (0, value_guards_1.isUnknownArray)(files) && files.every(file => (0, value_guards_1.isRecord)(file) && typeof file.path === 'string' && (0, value_guards_1.isUnknownArray)(file.matches)
        && file.matches.every(match => (0, value_guards_1.isRecord)(match)
            && typeof match.lineNumber === 'number' && typeof match.line === 'string'));
}
/**
 * Flatten a settled tool result's content blocks to their text, joined by
 * newlines. The search view carries no result text — a UI without a card falls
 * back to the raw `tool/result` content — so the truncation recovery footer is
 * read from the block's own content here. Non-text blocks (a search result
 * carries none) are skipped.
 * @param content - the result node's content blocks.
 * @returns the joined text, or undefined when empty.
 */
function flattenContent(content) {
    const text = content
        .filter((block) => (0, value_guards_1.isRecord)(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
    return text === '' ? undefined : text;
}
/**
 * Derive the search-card props for a tool call, or null when this call is not a
 * search card and belongs on the generic path.
 *
 * Only the result side matters: the search card carries no call-time state, so
 * a still-running call (no result view) is null, as is a settled call whose
 * result view is not a search card — including a `card` value this UI version
 * does not know, which arrives over the wire and cannot be trusted to be one of
 * the compiled variants, a `card: 'search'` view whose `shape` is neither
 * `matches` nor `paths` (equally untrusted wire data), and a generic result a
 * `grep`/`glob` failure or nested `run_code` dispatch produces (its text keeps
 * the generic path).
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @returns the search-card props, or null for the generic path.
 */
function searchCardModel(block) {
    // Running: no result view exists yet, and a search card is result-only.
    if (!('kind' in block))
        return null;
    const result = (0, view_codec_1.isView)(block.resultView, 'search') ? block.resultView : null;
    if (result === null)
        return null;
    const common = { truncated: result.truncated, total: result.total };
    // The recovery footer only matters when the tool capped the result: an
    // uncapped card holds every match/path, so the raw text adds nothing the card
    // does not already show. When capped, the raw result's `Full … stored at …`
    // locator is the only way to retrieve the omitted rows, so include it.
    const recovery = result.truncated ? flattenContent(block.content) : undefined;
    if (result.shape === 'matches') {
        // `files` rides the untrusted wire frame: the host schema checks `card`/`shape`
        // strings but not the grouped `files` fields, so validate them before
        // SearchBlock, which would crash on a missing or malformed `files`.
        // Invalid fields select the generic view.
        if (!isValidFiles(result.files))
            return null;
        return { title: result.title, recovery, card: { kind: 'matches', files: result.files, ...common } };
    }
    // `shape` rides the same untrusted wire frame as `card`, so a version mismatch
    // or a loose protocol producer could deliver a `card: 'search'` subtype this
    // client does not compile. Guard the paths shape explicitly: an unknown shape
    // falls to the generic path rather than being rendered as a paths card, which
    // would leave SearchBlock calling `.length`/`.map` on an absent `paths`.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- shape is wire data; the compiled union cannot prove this exhaustive.
    if (result.shape !== 'paths')
        return null;
    // `paths` is likewise unchecked by the wire schema; a known shape with a
    // missing/malformed array would crash the paths card at `.map`.
    if (!(0, value_guards_1.isUnknownArray)(result.paths) || !result.paths.every((path) => typeof path === 'string'))
        return null;
    return { title: result.title, recovery, card: { kind: 'paths', paths: result.paths, ...common } };
}

},
"src/modules/tool/tool/models/terminal-card-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/terminal-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.terminalBlockLabels = terminalBlockLabels;
exports.terminalFailed = terminalFailed;
exports.terminalCardModel = terminalCardModel;
const view_codec_1 = require("./view-codec");
/**
 * Pure derivation of the terminal-card props from a frozen call slice: the
 * `card:'terminal'` render intent the shell tools declare arrives on the
 * snapshot as `callView`/`resultView`, and this is the one place that turns
 * that pair into what {@link TerminalBlock} draws. Both conversation render
 * sites (the chat tool row's expanded body and the details panel's Output
 * section) call this, so the command, cwd, output and exit status they show
 * are derived once.
 * @module
 */
const runtime_1 = require("../../runtime");
/**
 * Build the TerminalBlock display copy from the conversation locale seat —
 * the one place the primitive's label surface pairs with this package's
 * dictionary, shared by every terminal render site (chat row, bash row,
 * details panel).
 * @param t - the render site's conversation locale seat.
 * @returns the full label set for {@link TerminalBlockProps}'s `labels`.
 */
function terminalBlockLabels(t) {
    return {
        signal: signal => t('terminal.signal', { signal }),
        exitCode: code => t('terminal.exitCode', { code }),
        running: t('terminal.running'),
        failed: t('terminal.failed'),
        done: t('terminal.done'),
        copy: t('copy'),
        copied: t('copied'),
        noOutput: t('terminal.noOutput'),
        collapseAria: t('terminal.collapseAria'),
        collapse: t('collapse'),
        expandAria: hidden => t('terminal.expandAria', { n: hidden }),
        expand: hidden => t('terminal.expandRest', { n: hidden }),
    };
}
/**
 * True when a settled terminal card reports a failing exit — a non-zero code
 * or a terminating signal. The bash tool settles a failing command as a
 * completed call (`isError` stays false: the exit status is result data), so
 * this is the collapsed row's only failure signal; without it the red exit
 * pill would be visible only after expanding the card.
 * @param model - a derived terminal card.
 * @returns whether the card's exit status is a failure.
 */
function terminalFailed(model) {
    const { exitCode, signal, running } = model.card;
    return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined);
}
/**
 * Resolve a terminal view's working directory the way the render-intent
 * contract assigns to the UI bridge: an absolute path is used as-is, a relative
 * one joins under the session workspace, and an omitted one IS the session
 * workspace. A pure presenter cannot see the session cwd, which is why this
 * resolution belongs here rather than in the tool. Without a session cwd there
 * is nothing to resolve against, so a relative path stays as authored and an
 * omitted one stays absent (the prompt row then draws a bare `$`).
 * @param viewCwd - the cwd the terminal call view carries, if any.
 * @param sessionCwd - the session workspace root, if the caller knows it.
 * @returns the working directory for the prompt label, or undefined.
 */
function resolveTerminalCwd(viewCwd, sessionCwd) {
    if (viewCwd === undefined || viewCwd === '')
        return sessionCwd;
    if (sessionCwd === undefined || sessionCwd === '')
        return normalizeSegments(viewCwd);
    return normalizeSegments((0, runtime_1.resolveWorkspacePath)(sessionCwd, viewCwd));
}
/**
 * Collapse `.` and `..` segments so the prompt label names the directory the
 * command actually ran in. The bash executor resolves the workdir before
 * running, so a joined `/w/app/..` must display as `w`, not as `..`. Separators
 * are preserved as authored (a Windows path keeps its backslashes) because this
 * value is only ever displayed; a `..` that would climb past the root is
 * dropped, which is what a filesystem does with it. A UNC path's `server` and
 * `share` are part of its root, not poppable segments: Windows cannot climb
 * above a share, so `\\\\server\\share` with a `..` stays there.
 * @param path - a joined or absolute path, possibly carrying `.`/`..` segments.
 * @returns the same path with those segments resolved.
 */
function normalizeSegments(path) {
    if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path))
        return path;
    // A UNC path is `\\\\server\\share\\...`: the server and share form the root,
    // so they are split off here and neither is a segment `..` may pop. Its
    // separator is fixed to a backslash, since a joined relative part may have
    // introduced a forward slash that UNC syntax does not use.
    const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path);
    if (unc !== null) {
        // Both groups are mandatory in the pattern, so destructuring types them as
        // strings without an assertion.
        const [matched, server, share] = unc;
        const root = `\\\\${String(server)}\\${String(share)}`;
        // Rooted: what follows the share hangs off it, so a `..` at the top is
        // dropped rather than kept — Windows cannot climb above a share.
        const rest = collapse(path.slice(matched.length), true);
        return rest === '' ? root : `${root}\\${rest}`;
    }
    const backslashed = path.includes('\\') && !path.includes('/');
    const separator = backslashed ? '\\' : '/';
    const rooted = /^[/\\]/.test(path);
    const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? '';
    const body = collapse(path.slice(drive.length), rooted || drive !== '', separator);
    const leading = rooted ? separator : '';
    return drive === '' ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`;
}
/**
 * Collapse the `.`/`..` segments of a path body against a known root state.
 * @param body - the path after any drive letter or UNC root.
 * @param rooted - the body hangs off a root, so a `..` at its top is dropped
 *   the way a filesystem drops one; without a root the `..` is kept, since it
 *   stays meaningful against a cwd this function cannot see.
 * @param separator - separator to rejoin with (default `/`).
 * @returns the collapsed body, without leading or trailing separators.
 */
function collapse(body, rooted, separator = '/') {
    const kept = [];
    for (const segment of body.split(/[/\\]/)) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (kept.length > 0 && kept[kept.length - 1] !== '..')
                kept.pop();
            else if (!rooted)
                kept.push(segment);
            continue;
        }
        kept.push(segment);
    }
    return kept.join(separator);
}
/**
 * Derive the terminal-card props for a tool call, or null when this call is
 * not a terminal card and belongs on the generic path.
 *
 * The call side supplies the command and its working directory; the result
 * side supplies the captured output and exit status. Three cases produce
 * null, all of them the documented generic-card default:
 *
 * - Neither side declares `card:'terminal'` — including a `card` value this
 *   UI version does not know, which arrives over the wire and therefore
 *   cannot be trusted to be one of the compiled variants.
 * - A settled call whose result view is not a terminal card: the result
 *   presentation decides how the settled call renders, and the bash tool
 *   returns a generic fenced card for an execution error or a background
 *   start, whose text and error styling the generic path preserves.
 *
 * Window truncation can drop the call head from a settled result (see
 * `ToolResultNode.call`/`callView` in dsh-client-runtime), leaving a terminal
 * result with no call side. That still renders: the command falls back to the
 * result view's replacement title, then to an empty command (the prompt line
 * draws bare), and the prompt shows no cwd.
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @param sessionCwd - the session workspace root, which resolves an omitted or
 *   relative view cwd (see {@link resolveTerminalCwd}); absent leaves both unresolved.
 * @returns the terminal-card props, or null for the generic path.
 */
function terminalCardModel(block, sessionCwd) {
    const call = (0, view_codec_1.isView)(block.callView, 'terminalCall') ? block.callView : null;
    if (!('kind' in block)) {
        // Running: the call view exists, the result view does not yet.
        return call === null ? null : {
            description: call.description,
            card: {
                command: call.title ?? '',
                cwd: resolveTerminalCwd(call.cwd, sessionCwd),
                output: undefined,
                exitCode: undefined,
                signal: undefined,
                running: true,
            },
        };
    }
    const result = (0, view_codec_1.isView)(block.resultView, 'terminalResult') ? block.resultView : null;
    if (result === null)
        return null;
    return {
        description: call?.description,
        card: {
            // The result's title REPLACES the pending one when the tool supplies it
            // (the presentation contract's replacement-title rule); the call title is
            // what a result without one keeps.
            command: result.title ?? call?.title ?? '',
            // Only a PRESENT call view can mean "omitted the cwd, so use the
            // workspace". When the window dropped the call head there is no cwd
            // anywhere — the result view carries none — and the original call may
            // well have used an explicit workdir, so the prompt draws a bare `$`
            // rather than naming a directory this card cannot know.
            cwd: call === null ? undefined : resolveTerminalCwd(call.cwd, sessionCwd),
            output: result.output,
            exitCode: result.exitCode,
            signal: result.signal,
            running: false,
        },
    };
}

},
"src/modules/tool/tool/models/web-card-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/web-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webCardModel = webCardModel;
const view_codec_1 = require("./view-codec");
/**
 * Derive the web-card props for a tool call, or null when this call is not a
 * web card and belongs on the generic path.
 *
 * The result side supplies the whole card: the sources and answer for a
 * `search`, the URL and status for a `fetch`. Cases producing null, all of
 * them the documented generic-card default:
 *
 * - A running call (no `resultView` yet): the web tools keep a generic pending
 *   card, so nothing web-shaped exists until the call settles.
 * - A settled call whose result view is not a web card — including a `card`
 *   value this UI version does not know, which arrives over the wire and so
 *   cannot be trusted to be one of the compiled variants, and a generic result
 *   view (a web tool's error path returns the generic card, whose text the
 *   generic path preserves).
 * - A web card whose `kind` this UI version does not know (a newer host's
 *   value): the wire cannot be trusted to be `search` or `fetch`, so it takes
 *   the generic path rather than rendering as a malformed fetch.
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @returns the web-card props, or null for the generic path.
 */
function webCardModel(block) {
    // Running calls have no result view; the web card is result-only.
    if (!('kind' in block))
        return null;
    const result = block.resultView;
    if (!(0, view_codec_1.isView)(result, 'web'))
        return null;
    if (result.kind === 'search') {
        return {
            kind: 'search',
            answer: result.answer,
            sources: result.sources.map(source => ({
                url: source.url,
                title: source.title,
                snippet: source.snippet,
                publishedAt: source.publishedAt,
            })),
            truncated: result.truncated,
        };
    }
    // Discriminate `fetch` explicitly rather than treating it as the else of
    // `search`: a `kind` this UI version does not know arrives over the wire from
    // a newer host, and reading it as a fetch would draw an empty URL and
    // `HTTP undefined`. It takes the generic path, the same wire-boundary default
    // an unknown `card` tag takes above. The static union narrows `kind` to
    // `'fetch'` here, but the runtime value is off the wire, so the guard and its
    // null fallthrough are load-bearing despite the type.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (result.kind === 'fetch') {
        return {
            kind: 'fetch',
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated,
        };
    }
    return null;
}

},
"src/modules/tool/tool/components/ToolRow.js": function(module, exports, require) {
// source: src/modules/tool/tool/components/ToolRow.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRow = ToolRow;
const jsx_runtime_1 = require("react/jsx-runtime");
// ToolRow: the single-line tool summary row (figma component set 122:9479) —
// 16px leading slot (state dot / tool icon, chevron on hover or expanded) + title +
// separator dot + FILL-truncated summary, drawn through the shared
// DisclosureRow chrome with the whole row as the expand toggle (click /
// Enter / Space, icon→chevron hover preview). The collapsed row is always
// one line; every row with body, output, or a card material (terminal, diff,
// read, search, web) is expandable; the summary stays inline while open.
// The expanded body — an IN/OUT gutter-labeled card (figma 1249:35657) for
// text input/output, the run_code program through CodeBlock, or a card
// primitive (TerminalBlock, DiffBlock, ReadBlock, SearchBlock, WebBlock) for a
// call that declared that render intent — lives in a max-height scroll
// container so a long payload scrolls internally instead of taking over the
// message flow. Every card kind starts collapsed, so a run of tool calls stays
// scannable; the details panel is the single-call full-height reading surface.
// Expand state is retained by callId across bounded transcript unmounts. File-tool summaries are path
// links that open through the host (stopPropagation keeps the two gestures
// independent); an error row's collapsed summary is the failure's first line in
// the error color.
const react_1 = require("react");
const transcript_state_1 = require("../../transcript-state");
const process_mode_1 = require("../../process-mode");
const class_names_1 = require("../../class-names");
const primitives_1 = require("../../primitives");
const diff_card_model_1 = require("../models/diff-card-model");
const read_card_model_1 = require("../models/read-card-model");
const search_card_model_1 = require("../models/search-card-model");
const terminal_card_model_1 = require("../models/terminal-card-model");
const ToolRow_styles_1 = __importDefault(require("./ToolRow.styles"));
const ReviewDiffBlock_1 = require("./ReviewDiffBlock");
/** Leading-slot state substitution: the tool icon yields to the terminal state
 *  semantic (error = red, interrupted = amber halo). Running keeps the icon —
 *  the row sweep (CSS on data-state) carries the in-flight signal. */
function leadingFor(state, icon) {
    switch (state) {
        case 'error': return (0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "error" });
        case 'stopped': return (0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "warning" });
        default: return icon;
    }
}
/** Visually hidden run-state label: the StateDot and the CSS sweep are both
 *  aria-hidden / colour-only, so assistive technology needs this text to know a
 *  row is running, failed, or interrupted. null in the ok state (the icon and
 *  summary already describe a settled row). */
function stateStatus(state, t) {
    switch (state) {
        case 'preparing':
        case 'running': return t('row.running');
        case 'error': return t('row.failed');
        case 'stopped': return t('row.stopped');
        default: return null;
    }
}
function ToolRow({ stateKey = '', t, variant, toolName, icon, title, summary, summarySuffix, body, output, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect, }) {
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('tool:' + stateKey, false);
    const processMode = (0, process_mode_1.useProcessMode)();
    const [appliedMode, setAppliedMode] = (0, transcript_state_1.useTranscriptState)('tool-mode:' + stateKey, null);
    (0, react_1.useEffect)(() => {
        if (appliedMode === processMode)
            return;
        setAppliedMode(processMode);
        setExpanded(processMode === 'expanded');
    }, [processMode, appliedMode, setAppliedMode, setExpanded]);
    const terminalBody = terminal ?? null;
    const diffBody = diff ?? null;
    const readBody = read ?? null;
    const searchBody = search ?? null;
    const webBody = web ?? null;
    const outputText = output ?? null;
    // A card replaces the text body; a call carries at most one card kind, so the
    // card props are mutually exclusive. Any of them, or a text body/output,
    // makes the row expandable.
    const card = terminalBody ?? diffBody ?? readBody ?? searchBody ?? webBody;
    const expandable = body !== null || outputText !== null || card !== null;
    const open = expanded && expandable;
    // The run-state label AT needs: the StateDot and the running sweep are both
    // aria-hidden / colour-only, so a stopped or running row is otherwise silent.
    const status = stateStatus(state, t);
    // An error row's collapsed summary IS the failure: the first error line in
    // the error color outranks both the args summary and a terminal description.
    const failureLine = state === 'error' ? errorSummary ?? null : null;
    const summaryText = failureLine ?? summary;
    const webHref = failureLine === null ? webHrefFor(toolName, summaryText) : null;
    // The failure line replaces the summary wholesale, so a suffix derived from
    // the call args has nothing left to sit beside.
    const suffix = failureLine === null ? summarySuffix ?? null : null;
    // The failure line is error prose, not the path: no open-file affordance.
    const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null;
    const toggleExpand = () => {
        setExpanded(v => !v);
    };
    const openFile = (event) => {
        event.stopPropagation();
        if (filePath !== undefined)
            onOpenFile?.(filePath);
    };
    // Keep Enter/Space on the focused path link from bubbling to the row's
    // keydown handler, which would preventDefault() the key and toggle expand
    // instead of activating the link — the keyboard analogue of openFile's
    // stopPropagation. The native button still fires its own onClick from the key.
    const fileLinkKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ')
            event.stopPropagation();
    };
    // The code variant's program renders through CodeBlock (shiki), so only its
    // output joins the IN/OUT card; every other variant's input does too.
    const cardBody = variant === 'code' ? null : body;
    // The state substitution rides the idle icon slot, so an expandable error
    // row keeps DisclosureRow's icon→chevron hover preview (its default) instead
    // of losing it with the icon.
    return ((0, jsx_runtime_1.jsxs)("div", { className: ToolRow_styles_1.default.root, "data-variant": variant, "data-tool": toolName, "data-state": state, children: [status !== null && (0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.visuallyHidden, children: status }), (0, jsx_runtime_1.jsx)(primitives_1.DisclosureRow, { rowClassName: ToolRow_styles_1.default.row, leadingClassName: ToolRow_styles_1.default.leading, titleClassName: ToolRow_styles_1.default.title, chevronClassName: ToolRow_styles_1.default.chevron, icon: leadingFor(state, icon), title: state === 'preparing' ? `${title} · ${(document.documentElement.lang || '').startsWith('zh') ? '准备中' : 'Preparing'}` : title, open: open, expandable: expandable, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: toggleExpand, collapsedContent: summaryText !== '' && (
                /* An empty summary drops the separator with it (a row that is only
                   its title shows no trailing dot). */
                (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.sep, "aria-hidden": true }), fileLink ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: ToolRow_styles_1.default.fileLink, onClick: openFile, onKeyDown: fileLinkKeyDown, children: summaryText })) : webHref !== null ? ((0, jsx_runtime_1.jsx)("a", { className: ToolRow_styles_1.default.fileLink, href: webHref, target: "_blank", rel: "noopener noreferrer", onClick: event => event.stopPropagation(), onKeyDown: event => event.stopPropagation(), children: summaryText })) : ((0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.clsx)(ToolRow_styles_1.default.summary, failureLine !== null && ToolRow_styles_1.default.errorSummary), children: summaryText })), suffix !== null && (0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.summarySuffix, children: suffix })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: ToolRow_styles_1.default.bodyWrap, children: [terminalBody !== null
                            ? ((0, jsx_runtime_1.jsx)(primitives_1.TerminalBlock, { ...terminalBody.card, maxLines: Infinity, labels: (0, terminal_card_model_1.terminalBlockLabels)(t), className: ToolRow_styles_1.default.terminalBody }))
                            : diffBody !== null
                                ? (0, jsx_runtime_1.jsx)(ReviewDiffBlock_1.ReviewDiffBlock, { stateKey: stateKey, ...diffBody.card, maxLines: diff_card_model_1.CHAT_DIFF_MAX_LINES, className: ToolRow_styles_1.default.diffBody })
                                : readBody !== null
                                    ? (0, jsx_runtime_1.jsx)(primitives_1.ReadBlock, { ...readBody, maxLines: read_card_model_1.CHAT_READ_MAX_LINES, className: ToolRow_styles_1.default.readBody })
                                    : searchBody !== null
                                        ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.SearchBlock, { ...searchBody.card, maxLines: search_card_model_1.CHAT_SEARCH_MAX_LINES, className: ToolRow_styles_1.default.searchBody }), searchBody.recovery !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: ToolRow_styles_1.default.searchRecovery, children: searchBody.recovery }))] }))
                                        : webBody !== null
                                            ? (0, jsx_runtime_1.jsx)(primitives_1.WebBlock, { ...webBody, className: ToolRow_styles_1.default.webBody })
                                            : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [variant === 'code' && body !== null && ((0, jsx_runtime_1.jsx)("div", { className: ToolRow_styles_1.default.bodyScroll, children: (0, jsx_runtime_1.jsx)(primitives_1.CodeBlock, { code: body, lang: "typescript", copyLabel: t('copy'), copiedLabel: t('copied'), className: ToolRow_styles_1.default.codeBody }) })), (cardBody !== null || outputText !== null) && ((0, jsx_runtime_1.jsxs)("div", { className: ToolRow_styles_1.default.ioCard, children: [cardBody !== null && ((0, jsx_runtime_1.jsxs)("div", { className: ToolRow_styles_1.default.ioSection, children: [(0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.ioLabel, children: "IN" }), (0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.ioText, children: cardBody })] })), cardBody !== null && outputText !== null && ((0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.ioDivider, "aria-hidden": true })), outputText !== null && ((0, jsx_runtime_1.jsxs)("div", { className: ToolRow_styles_1.default.ioSection, children: [(0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.ioLabel, children: "OUT" }), (0, jsx_runtime_1.jsx)("span", { className: ToolRow_styles_1.default.ioText, "data-error": state === 'error' || undefined, children: outputText })] }))] }))] })), inspect !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: ToolRow_styles_1.default.inspectButton, onClick: inspect, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconInspectOutline12, {}), "Inspect"] }))] }) })] }));
}
/** Only the existing web_fetch summary gains the upstream external-link affordance. */
function webHrefFor(toolName, summary) {
    if (toolName !== 'web_fetch')
        return null;
    try {
        const url = new URL(summary);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    }
    catch {
        return null;
    }
}

},
"src/modules/tool/transcript-state.js": function(module, exports, require) {
// source: src/modules/tool/transcript-state.ts

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
"src/modules/tool/process-mode.js": function(module, exports, require) {
// source: src/modules/tool/process-mode.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useProcessMode = void 0;
var process_display_1 = require("../shared/process-display");
Object.defineProperty(exports, "useProcessMode", { enumerable: true, get: function () { return process_display_1.useProcessMode; } });

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
"src/modules/tool/class-names.js": function(module, exports, require) {
// source: src/modules/tool/class-names.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clsx = clsx;
/** The consumed clsx surface is boolean/undefined string composition only. */
function clsx(...values) {
    return values.filter(value => typeof value === 'string' && value.length > 0).join(' ');
}

},
"src/modules/tool/tool/components/ToolRow.styles.js": function(module, exports, require) {
// source: src/modules/tool/tool/components/ToolRow.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ToolRow_css_1 = __importDefault(require("./ToolRow.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-tool/ToolRow.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-tool';
        tag.dataset.pluginCss = id;
        tag.textContent = ToolRow_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "bodyScroll": "Dh215a_bodyScroll",
    "bodyWrap": "Dh215a_bodyWrap",
    "chevron": "Dh215a_chevron",
    "codeBody": "Dh215a_codeBody",
    "diffBody": "Dh215a_diffBody",
    "dsh-tool-row-sweep": "Dh215a_dsh-tool-row-sweep",
    "errorSummary": "Dh215a_errorSummary",
    "fileLink": "Dh215a_fileLink",
    "inspectButton": "Dh215a_inspectButton",
    "ioCard": "Dh215a_ioCard",
    "ioDivider": "Dh215a_ioDivider",
    "ioLabel": "Dh215a_ioLabel",
    "ioSection": "Dh215a_ioSection",
    "ioText": "Dh215a_ioText",
    "leading": "Dh215a_leading",
    "readBody": "Dh215a_readBody",
    "root": "Dh215a_root",
    "row": "Dh215a_row",
    "searchBody": "Dh215a_searchBody",
    "searchRecovery": "Dh215a_searchRecovery",
    "sep": "Dh215a_sep",
    "summary": "Dh215a_summary",
    "summarySuffix": "Dh215a_summarySuffix",
    "terminalBody": "Dh215a_terminalBody",
    "title": "Dh215a_title",
    "visuallyHidden": "Dh215a_visuallyHidden",
    "webBody": "Dh215a_webBody"
};

},
"src/modules/tool/tool/components/ToolRow.css": function(module, exports, require) {
// source: src/modules/tool/tool/components/ToolRow.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".Dh215a_root{flex-direction:column;display:flex}.Dh215a_row{position:relative;overflow:hidden}.Dh215a_root[data-state=running] .Dh215a_row:after{content:\"\";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite Dh215a_dsh-tool-row-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes Dh215a_dsh-tool-row-sweep{0%{left:-300px}90%,to{left:100%}}.Dh215a_leading{flex-shrink:0}.Dh215a_root[data-tool^=cordis_] .Dh215a_leading,.Dh215a_root[data-tool^=cordis_] .Dh215a_title{color:var(--dsw-alias-state-business-primary)}.Dh215a_root[data-tool^=cordis_] .Dh215a_title{font-weight:500}.Dh215a_root[data-tool^=cordis_] .Dh215a_sep{background:var(--dsw-alias-state-business-primary)}.Dh215a_chevron{color:var(--dsw-alias-label-secondary)}.Dh215a_title{font-weight:400}.Dh215a_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.Dh215a_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.Dh215a_summarySuffix{white-space:nowrap;color:var(--dsw-alias-label-tertiary);flex:none;margin-left:4px;font-size:14px;line-height:24px}.Dh215a_fileLink{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit;text-align:left;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-decoration-color:var(--dsw-alias-label-quaternary);text-underline-offset:3px;cursor:pointer;background:0 0;border:none;flex:auto;margin:0;padding:0;font-size:14px;line-height:24px;overflow:hidden}.Dh215a_fileLink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}.Dh215a_errorSummary{color:var(--dsw-alias-state-error-primary)}.Dh215a_bodyWrap{flex-direction:column;display:flex}.Dh215a_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}.Dh215a_root:hover .Dh215a_inspectButton,.Dh215a_inspectButton:focus-visible{opacity:1}.Dh215a_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.Dh215a_bodyScroll{max-height:260px;overflow-y:auto}.Dh215a_ioCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);border-radius:12px;flex-direction:column;margin:4px 0 4px 4px;display:flex}.Dh215a_ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}.Dh215a_ioSection::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}.Dh215a_ioSection::-webkit-scrollbar-track{margin:6px 0}.Dh215a_ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}.Dh215a_ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:1px}.Dh215a_ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}.Dh215a_ioText[data-error]{color:var(--dsw-alias-state-error-primary)}.Dh215a_codeBody,.Dh215a_terminalBody,.Dh215a_diffBody,.Dh215a_readBody,.Dh215a_searchBody,.Dh215a_webBody{margin:4px 0 4px 4px}.Dh215a_searchRecovery{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:4px 0 4px 4px}.Dh215a_codeBody{--dsl-code-block-content-font:var(--dsw-font-markdown-code-block-small)}.Dh215a_terminalBody{--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:1px solid var(--dsw-alias-border-l1)}.Dh215a_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";

},
"src/modules/tool/tool/components/ReviewDiffBlock.js": function(module, exports, require) {
// source: src/modules/tool/tool/components/ReviewDiffBlock.tsx

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
exports.XHReviewDiffBlock = XHReviewDiffBlock;
exports.ReviewDiffBlock = XHReviewDiffBlock;
const React = __importStar(require("react"));
const primitives_1 = require("../../primitives");
const transcript_state_1 = require("../../transcript-state");
require("./ReviewDiffBlock.styles");
function diffLines(text) {
    if (text === null || text === '')
        return [];
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}
/** Same bounded, persisted review affordance as the latest frozen Tool factory. */
function XHReviewDiffBlock({ diffs, maxLines, className, stateKey = '' }) {
    const [layout, setLayout] = React.useState(() => {
        try {
            return localStorage.getItem('xharness.ui.diff-layout.v1') === 'split' ? 'split' : 'inline';
        }
        catch {
            return 'inline';
        }
    });
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('diff:' + stateKey, false);
    const [copied, setCopied] = React.useState(false);
    const translate = (zh, en) => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? zh : en;
    const changeLayout = (value) => {
        setLayout(value);
        try {
            localStorage.setItem('xharness.ui.diff-layout.v1', value);
        }
        catch { /* memory only */ }
    };
    const copy = async () => {
        const text = diffs.map(({ path, oldText, newText }) => `${path}\n--- before\n${oldText ?? ''}\n+++ after\n${newText}`).join('\n\n');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => { setCopied(false); }, 1200);
        }
        catch { /* no clipboard permission */ }
    };
    const maxPreview = 500;
    const panes = layout === 'split' ? diffs.map((diff, index) => {
        const oldLines = diffLines(diff.oldText);
        const newLines = diffLines(diff.newText);
        const length = Math.max(oldLines.length, newLines.length);
        const absoluteCap = 3000;
        const shown = Math.min(length, expanded ? absoluteCap : maxPreview);
        const left = React.createRef(), right = React.createRef();
        const syncing = { active: false };
        const sync = (from, to) => {
            if (syncing.active || !from || !to)
                return;
            syncing.active = true;
            to.scrollTop = from.scrollTop;
            to.scrollLeft = from.scrollLeft;
            requestAnimationFrame(() => { syncing.active = false; });
        };
        const side = (lines, other, title, ref, otherRef) => React.createElement('div', {
            className: 'xh-review-pane', ref, onScroll: (event) => { sync(event.currentTarget, otherRef.current); }, key: title,
        }, [React.createElement('span', { className: 'xh-review-pane-heading', key: 'heading' }, title),
            ...Array.from({ length: shown }, (_, lineIndex) => React.createElement('div', {
                className: 'xh-review-line', 'data-changed': lines[lineIndex] !== other[lineIndex], key: lineIndex,
            }, [React.createElement('span', { className: 'xh-review-line-number', key: 'number' }, lineIndex < lines.length ? lineIndex + 1 : ''),
                React.createElement('span', { className: 'xh-review-line-code', key: 'code' }, lines[lineIndex] ?? ' ')]))]);
        return React.createElement('div', { className: 'xh-review-file', key: `${diff.path}:${index}` }, [
            React.createElement('div', { className: 'xh-review-path', title: diff.path, key: 'path' }, diff.path),
            React.createElement('div', { className: 'xh-review-panes', key: 'panes' }, [
                side(oldLines, newLines, translate('修改前', 'Before'), left, right),
                side(newLines, oldLines, translate('修改后', 'After'), right, left),
            ]),
            length > maxPreview && React.createElement('button', {
                type: 'button', className: 'xh-review-truncated', onClick: () => { setExpanded(value => !value); }, key: 'more',
            }, expanded
                ? translate(length > absoluteCap ? `仅预览前 ${absoluteCap} 行 · 点击收起，完整内容可复制` : '收起', length > absoluteCap ? `Preview capped at ${absoluteCap} lines · full diff can be copied` : 'Show less')
                : translate(`展开预览（${length} 行）`, `Expand preview (${length} lines)`)),
        ]);
    }) : null;
    const layouts = ['inline', 'split'];
    return React.createElement('div', { className: `xh-review ${className || ''}`, 'data-xh-diff-layout': layout }, [
        React.createElement('div', { className: 'xh-review-toolbar', key: 'toolbar' }, [
            React.createElement('span', { className: 'xh-review-title', key: 'title' }, translate('文件差异', 'File diff')),
            React.createElement('div', { className: 'xh-review-actions', role: 'group', 'aria-label': translate('差异布局', 'Diff layout'), key: 'actions' }, [
                ...layouts.map(value => React.createElement('button', { type: 'button', 'aria-pressed': layout === value, onClick: () => { changeLayout(value); }, key: value }, value === 'inline' ? translate('行内', 'Inline') : translate('并排', 'Side by side'))),
                layout === 'split' && React.createElement('button', { type: 'button', onClick: copy, key: 'copy' }, copied ? translate('已复制', 'Copied') : translate('复制', 'Copy')),
            ]),
        ]),
        layout === 'inline'
            ? React.createElement(primitives_1.DiffBlock, { diffs, maxLines, className, key: 'inline' })
            : React.createElement('div', { key: 'split' }, panes),
    ]);
}

},
"src/modules/tool/tool/components/ReviewDiffBlock.styles.js": function(module, exports, require) {
// source: src/modules/tool/tool/components/ReviewDiffBlock.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ReviewDiffBlock_css_1 = __importDefault(require("./ReviewDiffBlock.css"));
if (typeof document !== 'undefined' && !document.getElementById('xh-review-diff-style')) {
    const style = document.createElement('style');
    style.id = 'xh-review-diff-style';
    style.textContent = ReviewDiffBlock_css_1.default;
    document.head.appendChild(style);
}

},
"src/modules/tool/tool/components/ReviewDiffBlock.css": function(module, exports, require) {
// source: src/modules/tool/tool/components/ReviewDiffBlock.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "\n.xh-review{min-width:0;margin:4px 0;color:var(--dsw-alias-label-primary)}\n.xh-review-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 4px}\n.xh-review-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}\n.xh-review-actions{display:flex;gap:3px;align-items:center}\n.xh-review-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}\n.xh-review-actions button:hover,.xh-review-actions button:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);outline:none}\n.xh-review-actions button[aria-pressed=true]{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}\n.xh-review-file{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin:4px 0 9px;background:var(--dsw-alias-markdown-code-block)}\n.xh-review-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font:600 11px/17px ui-monospace,SFMono-Regular,Menlo,monospace}\n.xh-review-panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}\n.xh-review-pane{min-width:0;max-height:400px;overflow:auto;scrollbar-gutter:stable;font:11px/19px ui-monospace,SFMono-Regular,Menlo,monospace}\n.xh-review-pane:first-child{border-right:1px solid var(--dsw-alias-border-l2)}\n.xh-review-pane-heading{position:sticky;top:0;z-index:1;display:block;padding:4px 8px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:600 10px/16px system-ui,sans-serif}\n.xh-review-line{display:flex;white-space:pre;min-height:19px;padding-right:8px}.xh-review-line[data-changed=true]{background:var(--dsw-alias-interactive-bg-hover)}\n.xh-review-line-number{position:sticky;left:0;flex:none;box-sizing:border-box;width:35px;text-align:right;padding-right:7px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-markdown-code-block);user-select:none}\n.xh-review-line-code{display:block}.xh-review-truncated{padding:7px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l2)}\n@media(max-width:650px){.xh-review-panes{grid-template-columns:minmax(0,1fr)}.xh-review-pane:first-child{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}}\n";

},
"src/modules/tool/tool/models/agent-communication-model.js": function(module, exports, require) {
// source: src/modules/tool/tool/models/agent-communication-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentCommunicationModel = agentCommunicationModel;
exports.agentCommunicationCopy = agentCommunicationCopy;
const value_guards_1 = require("../../value-guards");
const tool_call_model_1 = require("./tool-call-model");
function parse(text) {
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
function record(value) {
    return (0, value_guards_1.isRecord)(value) && !(0, value_guards_1.isUnknownArray)(value);
}
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}
/** Read only explicit Host acknowledgements, never an assistant's narrative.
 * The current tool pipeline wraps the receipt in ToolResult.content. Legacy
 * direct receipts are supported too. Truncated/failed envelopes fail closed.
 */
function receipt(output) {
    let value = parse(output);
    if (!record(value) || value.ok !== true || (value.truncated !== undefined && value.truncated !== false))
        return null;
    if (typeof value.content === 'string') {
        value = parse(value.content);
        if (!record(value) || value.ok !== true || (value.truncated !== undefined && value.truncated !== false))
            return null;
    }
    return value;
}
function agentCommunicationModel(toolName, block) {
    if (toolName !== 'agent')
        return null;
    const done = 'kind' in block;
    const args = parse((done ? block.call?.argsRaw : block.argsRaw) ?? '');
    if (!record(args))
        return null;
    const action = args.action;
    if (action !== 'start' && action !== 'send' && action !== 'stop' && action !== 'revert')
        return null;
    const checkpoint = action === 'revert' && typeof args.checkpoint_seq === 'number' && Number.isSafeInteger(args.checkpoint_seq) && args.checkpoint_seq >= 0 ? args.checkpoint_seq : null;
    const target = action === 'start' ? text(args.label) : text(args.agent_id);
    const message = text(action === 'start' ? args.task : args.message) ?? '';
    const output = done ? (0, tool_call_model_1.resultText)(block) || null : null;
    const ack = output === null ? null : receipt(output);
    const ackTarget = ack === null ? null : text(ack.agent_id);
    const messageId = ack === null ? null : text(ack.message_id);
    // An acknowledgement for another child is not evidence for this call.
    const matches = ackTarget !== null && (action === 'start' || (action === 'revert' ? ack !== null && text(ack.source_agent_id) === target && checkpoint !== null && ack.checkpoint_seq === checkpoint && ack.filesystem_rollback === false && ackTarget !== target : ackTarget === target));
    let phase = 'sending';
    if (done) {
        if (block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted')
            phase = 'unknown';
        else if (block.isError)
            phase = 'failed';
        else if (matches && ack !== null && action === 'stop' && ack.accepted === true)
            phase = 'stop-requested';
        else if (matches && ack !== null && action !== 'stop' && ack.status === 'accepted' && messageId !== null)
            phase = 'queued';
        else
            phase = 'unconfirmed';
    }
    const state = phase === 'sending' ? 'running'
        : phase === 'failed' ? 'error'
            : phase === 'unknown' || phase === 'unconfirmed' ? 'stopped' : 'ok';
    return { action, target: (action === 'start' || action === 'revert') && matches ? ackTarget : target, message,
        source: action === 'revert' ? target : null, checkpoint,
        messageId: phase === 'queued' ? messageId : null, phase, state, output };
}
/** Keep the status visible outside the clipped message preview. Full message
 * and stable identities remain in the expandable body; no extra RPC/polling.
 */
function agentCommunicationCopy(model, chinese) {
    const phases = chinese
        ? { sending: '发送中', queued: '已入队', 'stop-requested': '已请求停止', failed: '工具失败', unknown: '状态未知', unconfirmed: '未确认' }
        : { sending: 'Sending', queued: 'Queued', 'stop-requested': 'Stop requested', failed: 'Tool failed', unknown: 'Outcome unknown', unconfirmed: 'Unconfirmed' };
    const titles = chinese
        ? { start: '创建子 Agent', send: '发送给 Agent', stop: '停止 Agent', revert: '纠偏子 Agent' }
        : { start: 'Start agent', send: 'Message to agent', stop: 'Stop agent', revert: 'Correct agent' };
    const target = model.target ?? (chinese ? '目标待确认' : 'Target unconfirmed');
    const shortTarget = target.length > 24 ? target.slice(0, 12) + '…' + target.slice(-8) : target;
    const preview = model.message.replace(/\s+/g, ' ').slice(0, 160);
    const note = model.phase === 'queued'
        ? chinese ? 'Host 已接受并入队；不代表子 Agent 已读取或完成。' : 'Accepted into the Host inbox; not proof of reading or completion.'
        : model.phase === 'stop-requested'
            ? chinese ? '已接受停止请求；不代表已经停止。' : 'Stop request accepted; not proof the agent has stopped.'
            : model.phase === 'sending'
                ? chinese ? '等待 Host 回执。' : 'Waiting for a Host acknowledgement.'
                : chinese ? '未确认投递结果；不能据此断言消息没有发送。' : 'Delivery is unconfirmed; this does not prove the message was not sent.';
    return {
        title: titles[model.action],
        summary: preview === '' ? shortTarget : `${shortTarget} · ${preview}`,
        status: phases[model.phase],
        body: `${model.source === null ? '' : `${chinese ? '原 Agent' : 'Source agent'}: ${model.source} · ${chinese ? '检查点' : 'Checkpoint'}: ${model.checkpoint ?? '?'}\n${chinese ? '仅回推上下文，不回滚文件。' : 'Context branch only; files are not rolled back.'}\n`}${chinese ? '目标' : 'Target'}: ${target}\n${model.messageId === null ? '' : `${chinese ? '消息 ID' : 'Message ID'}: ${model.messageId}\n`}\n${model.message}\n\n${note}`,
    };
}

},
"src/modules/tool/tool/ToolCallTree.styles.js": function(module, exports, require) {
// source: src/modules/tool/tool/ToolCallTree.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ToolCallTree_css_1 = __importDefault(require("./ToolCallTree.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-tool/ToolCallTree.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-tool';
        tag.dataset.pluginCss = id;
        tag.textContent = ToolCallTree_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "callRow": "JWd3IW_callRow",
    "subCalls": "JWd3IW_subCalls"
};

},
"src/modules/tool/tool/ToolCallTree.css": function(module, exports, require) {
// source: src/modules/tool/tool/ToolCallTree.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".JWd3IW_callRow{border-radius:6px}.JWd3IW_subCalls{border-left:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:4px;margin:4px 0 2px 22px;padding-left:8px;display:flex}";

},
"src/modules/tool/tool/ToolDetails.js": function(module, exports, require) {
// source: src/modules/tool/tool/ToolDetails.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolDetails = ToolDetails;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Card-aware output body for the selected Tool call in details. */
const primitives_1 = require("../primitives");
const ReviewDiffBlock_1 = require("./components/ReviewDiffBlock");
const diff_card_model_1 = require("./models/diff-card-model");
const read_card_model_1 = require("./models/read-card-model");
const search_card_model_1 = require("./models/search-card-model");
const terminal_card_model_1 = require("./models/terminal-card-model");
const tool_call_model_1 = require("./models/tool-call-model");
const web_card_model_1 = require("./models/web-card-model");
const ToolDetails_styles_1 = __importDefault(require("./ToolDetails.styles"));
/**
 * Render the selected Tool call's structured output when its presentation
 * intent is known, otherwise preserve the flattened result text.
 * @param props - selected call slice, workspace root, host home, and locale seat.
 * @returns the details output body.
 */
function ToolDetails({ block, cwd, useHostDescription, t, }) {
    const home = useHostDescription(description => description?.home);
    const terminal = (0, terminal_card_model_1.terminalCardModel)(block, cwd);
    if (terminal !== null) {
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [terminal.description !== undefined ? ((0, jsx_runtime_1.jsx)("div", { className: ToolDetails_styles_1.default.description, children: terminal.description })) : null, (0, jsx_runtime_1.jsx)(primitives_1.TerminalBlock, { ...terminal.card, labels: (0, terminal_card_model_1.terminalBlockLabels)(t), className: ToolDetails_styles_1.default.cardBody })] }));
    }
    const read = (0, read_card_model_1.readCardModel)(block, cwd, home);
    if (read !== null)
        return (0, jsx_runtime_1.jsx)(primitives_1.ReadBlock, { ...read, className: ToolDetails_styles_1.default.read });
    const diff = (0, diff_card_model_1.diffCardModel)(block);
    if (diff !== null)
        return (0, jsx_runtime_1.jsx)(ReviewDiffBlock_1.ReviewDiffBlock, { ...diff.card, className: ToolDetails_styles_1.default.cardBody });
    const search = (0, search_card_model_1.searchCardModel)(block);
    if (search !== null) {
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.SearchBlock, { ...search.card, className: ToolDetails_styles_1.default.cardBody }), search.recovery !== undefined ? (0, jsx_runtime_1.jsx)("div", { className: ToolDetails_styles_1.default.recovery, children: search.recovery }) : null] }));
    }
    const web = (0, web_card_model_1.webCardModel)(block);
    if (web !== null) {
        const body = 'kind' in block ? (0, tool_call_model_1.resultText)(block) : '';
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(primitives_1.WebBlock, { ...web, className: ToolDetails_styles_1.default.web }), body !== '' ? (0, jsx_runtime_1.jsx)("pre", { className: ToolDetails_styles_1.default.code, children: body }) : null] }));
    }
    if (!('kind' in block))
        return (0, jsx_runtime_1.jsx)("div", { className: ToolDetails_styles_1.default.empty, children: t('details.running') });
    return ((0, jsx_runtime_1.jsx)("pre", { className: ToolDetails_styles_1.default.code, "data-error": block.isError || undefined, children: (0, tool_call_model_1.resultText)(block) }));
}

},
"src/modules/tool/tool/ToolDetails.styles.js": function(module, exports, require) {
// source: src/modules/tool/tool/ToolDetails.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ToolDetails_css_1 = __importDefault(require("./ToolDetails.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-tool/ToolDetails.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-tool';
        tag.dataset.pluginCss = id;
        tag.textContent = ToolDetails_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "cardBody": "_7Dw-cG_cardBody",
    "code": "_7Dw-cG_code",
    "description": "_7Dw-cG_description",
    "empty": "_7Dw-cG_empty",
    "read": "_7Dw-cG_read",
    "recovery": "_7Dw-cG_recovery",
    "web": "_7Dw-cG_web"
};

},
"src/modules/tool/tool/ToolDetails.css": function(module, exports, require) {
// source: src/modules/tool/tool/ToolDetails.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._7Dw-cG_description{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);margin:0 0 6px}._7Dw-cG_cardBody{margin:0}._7Dw-cG_recovery{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);margin:6px 0 0}._7Dw-cG_code{background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:12px;margin:0;padding:16px;font-size:13px;line-height:22px}._7Dw-cG_code[data-error]{color:var(--dsw-alias-state-error-primary)}._7Dw-cG_read,._7Dw-cG_web{margin:0}._7Dw-cG_empty{color:var(--dsw-alias-label-tertiary);padding:8px 0;font-size:13px;line-height:20px}";

},
"src/modules/tool/locale.js": function(module, exports, require) {
// source: src/modules/tool/locale.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONVERSATION_NS = void 0;
/** Locale namespace supplied by the conversation owner to Tool renderers. */
exports.CONVERSATION_NS = 'conversation';

},
"src/modules/tool/tool/toolviews/ask-question-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/ask-question-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.askQuestionToolview = void 0;
exports.AskQuestionRow = AskQuestionRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const value_guards_1 = require("../../value-guards");
// ask_user_question toolview: question-flavored summary row replacing the
// generic "Tool call" card, registered into the keyed
// 'tool.call.toolview' hole like todo-row. The row composes ToolRow
// (chrome, running sweep, whole-row expand) and swaps in the interaction
// outcome — `waiting` while pending, answered-count once settled, `cancelled`
// when the user dismissed the whole set — because the questions themselves
// render in the composer takeover.
const primitives_1 = require("../../primitives");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
function isAnswer(value) {
    return typeof value === 'object' && value !== null;
}
/** Answered-count summary from the result JSON (a skipped question has
 *  empty `selected` and no `custom`); null when answer fields are invalid. */
function answeredSummary(text, t) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!(0, value_guards_1.isRecord)(parsed))
        return null;
    const answers = parsed.answers;
    if (!(0, value_guards_1.isUnknownArray)(answers) || !answers.every(isAnswer))
        return null;
    const answered = answers.filter(a => ((0, value_guards_1.isUnknownArray)(a.selected) && a.selected.length > 0)
        || (typeof a.custom === 'string' && a.custom !== '')).length;
    return t('ask.answered', { answered, total: answers.length });
}
/** One-line question-interaction row (the whole row toggles the call's
 *  Input/Output sections, ToolRow's unified expand). */
function AskQuestionRow({ toolName, block, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block);
    // Composer verdicts settle the call as specific UserQuestionErrors
    // (apiproxy ask_user_question handler): 'ASK_CANCELLED' is the user's own
    // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
    // question was pending. Both name their verdict instead of the generic
    // failed shape, and the abort keeps the shared stopped (amber) semantics of
    // any other interrupted tool call.
    const code = 'kind' in block ? block.error?.code : undefined;
    let summary = model.summary;
    let state = model.state;
    if (code === 'ASK_CANCELLED') {
        summary = t('ask.cancelled');
    }
    else if (code === 'ASK_ABORTED') {
        summary = t('ask.interrupted');
        state = 'stopped';
    }
    else if (model.state === 'running') {
        summary = t('ask.waiting');
    }
    else if ('kind' in block && model.state === 'ok') {
        const text = block.content.filter((b) => (0, value_guards_1.isRecord)(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
        summary = answeredSummary(text, t) ?? model.summary;
    }
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconQuestionOutline14, {}), title: t('ask.rowTitle'), summary: summary, body: model.body, output: model.output, state: state, inspect: inspect }));
}
/**
 * The ask-question row as a plain registrant plugin following the chat
 * toolview declaration across independent activation and reload lifetimes.
 */
exports.askQuestionToolview = {
    name: 'ask-question-toolview',
    inject: ['slots'],
    /**
     * Register the ask-question row into the Tool-owned keyed view slot.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview', key: 'ask_user_question', locale: locale_1.CONVERSATION_NS,
        }, AskQuestionRow));
    },
};

},
"src/modules/tool/tool/toolviews/bash-sample.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/bash-sample.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bashToolviewSample = void 0;
exports.BashRow = BashRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const transcript_state_1 = require("../../transcript-state");
const class_names_1 = require("../../class-names");
const primitives_1 = require("../../primitives");
const terminal_card_model_1 = require("../models/terminal-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const locale_1 = require("../../locale");
const bash_sample_styles_1 = __importDefault(require("./bash-sample.styles"));
const RunPanel_1 = require("../../../jobs/RunPanel");
function leadingFor(state) {
    switch (state) {
        case 'error': return (0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "error" });
        case 'stopped': return (0, jsx_runtime_1.jsx)(primitives_1.StateDot, { state: "warning" });
        // Running keeps the icon — the row sweep carries the in-flight signal.
        default: return (0, jsx_runtime_1.jsx)(primitives_1.IconApiOutline14, { size: 14 });
    }
}
/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state, t) {
    switch (state) {
        case 'running': return t('bash.running');
        case 'error': return t('bash.failed');
        case 'stopped': return t('bash.stopped');
        default: return null;
    }
}
/**
 * Bash row: icon + Bash · {description} in the shared ToolRow chrome, the
 * whole row toggling the command's terminal or generic error card (ToolRow's unified
 * expand interaction, replicated locally per the registrant posture).
 */
function BashRow({ toolName, block, sessionId, useSessions, inspect, t, jobClient }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block);
    // Session workspace root: the terminal view's cwd resolves against it (an
    // omitted workdir IS the workspace), which the pure presenter cannot do.
    const cwd = useSessions(list => list.byId[sessionId]?.cwd);
    const terminal = (0, terminal_card_model_1.terminalCardModel)(block, cwd);
    // A failing exit status is the terminal card's own error signal (the call
    // itself settles isError:false), surfaced as the row's red state dot.
    const state = model.state === 'ok' && terminal !== null && (0, terminal_card_model_1.terminalFailed)(terminal)
        ? 'error'
        : model.state;
    const status = stateStatus(state, t);
    const [expanded, setExpanded] = (0, transcript_state_1.useTranscriptState)('bash:' + block.callId, false);
    // Execution failures (for example cancellation before the process reports a
    // terminal result) use the generic presenter. Keep their recorded args and
    // full error reachable instead of collapsing the row to the first line.
    const genericError = terminal === null
        && model.state === 'error'
        && (model.body !== null || model.output !== null);
    const expandable = terminal !== null || genericError;
    const open = expanded && expandable;
    const failureLine = model.state === 'error' ? model.errorSummary : null;
    const toggleExpand = () => {
        setExpanded(v => !v);
    };
    const toggleFromKeyboard = (event) => {
        if (!expandable || (event.key !== 'Enter' && event.key !== ' '))
            return;
        event.preventDefault();
        toggleExpand();
    };
    const leading = open
        ? (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, { className: bash_sample_styles_1.default.chevron })
        : expandable
            ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.iconIdle, children: leadingFor(state) }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronDownOutline14, { className: (0, class_names_1.clsx)(bash_sample_styles_1.default.chevron, bash_sample_styles_1.default.chevronHover) })] }))
            : leadingFor(state);
    return ((0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.card, children: [(0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.root, "data-sample": "bash", "data-variant": "bash", "data-state": state, "data-expandable": expandable || undefined, role: expandable ? 'button' : undefined, tabIndex: expandable ? 0 : undefined, "aria-expanded": expandable ? open : undefined, onClick: expandable ? toggleExpand : undefined, onKeyDown: expandable ? toggleFromKeyboard : undefined, children: [(0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.leading, children: leading }), status !== null && (0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.visuallyHidden, children: status }), (0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.title, children: model.title }), (0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.sep, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: (0, class_names_1.clsx)(bash_sample_styles_1.default.summary, failureLine !== null && bash_sample_styles_1.default.errorSummary), children: failureLine ?? terminal?.description ?? model.summary })] }), open && (
            /* Same hover-Inspect posture as ToolRow's expanded body, replicated
               locally per the registrant posture. */
            (0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.bodyWrap, children: [terminal !== null
                        ? ((0, jsx_runtime_1.jsx)(primitives_1.TerminalBlock, { ...terminal.card, maxLines: Infinity, labels: (0, terminal_card_model_1.terminalBlockLabels)(t), className: bash_sample_styles_1.default.terminal }))
                        : ((0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.ioCard, children: [model.body !== null && ((0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.ioSection, children: [(0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.ioLabel, children: "IN" }), (0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.ioText, children: model.body })] })), model.body !== null && model.output !== null && ((0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.ioDivider, "aria-hidden": true })), model.output !== null && ((0, jsx_runtime_1.jsxs)("div", { className: bash_sample_styles_1.default.ioSection, children: [(0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.ioLabel, children: "OUT" }), (0, jsx_runtime_1.jsx)("span", { className: bash_sample_styles_1.default.ioText, "data-error": true, children: model.output })] }))] })), inspect !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: bash_sample_styles_1.default.inspectButton, onClick: inspect, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconInspectOutline12, {}), "Inspect"] }))] })), jobClient && (0, jsx_runtime_1.jsx)(RunPanel_1.JobToolPanel, { client: jobClient, sessionId: sessionId, block: block })] }));
}
/**
 * The sample as a plain registrant plugin. Slot injection follows the chat
 * toolview declaration across independent activation and reload lifetimes.
 */
exports.bashToolviewSample = {
    name: 'bash-toolview-sample',
    inject: ['slots', 'connection'],
    /**
     * Register the bash row into the Tool-owned keyed view slot.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        const jobs = ctx.get?.('connection')?.jobs;
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', locale: locale_1.CONVERSATION_NS }, (props) => (0, jsx_runtime_1.jsx)(BashRow, { ...props, jobClient: jobs })));
    },
};

},
"src/modules/tool/tool/toolviews/bash-sample.styles.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/bash-sample.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bash_sample_css_1 = __importDefault(require("./bash-sample.css"));
if (typeof document !== 'undefined') {
    const id = '@xharness/dsh-client-ui-tool/bash-sample.module.css';
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@xharness/dsh-client-ui-tool';
        tag.dataset.pluginCss = id;
        tag.textContent = bash_sample_css_1.default;
        document.head.appendChild(tag);
    }
}
exports.default = {
    "bodyWrap": "ANgngG_bodyWrap",
    "card": "ANgngG_card",
    "chevron": "ANgngG_chevron",
    "chevronHover": "ANgngG_chevronHover",
    "dsh-bash-row-sweep": "ANgngG_dsh-bash-row-sweep",
    "errorSummary": "ANgngG_errorSummary",
    "iconIdle": "ANgngG_iconIdle",
    "inspectButton": "ANgngG_inspectButton",
    "ioCard": "ANgngG_ioCard",
    "ioDivider": "ANgngG_ioDivider",
    "ioLabel": "ANgngG_ioLabel",
    "ioSection": "ANgngG_ioSection",
    "ioText": "ANgngG_ioText",
    "leading": "ANgngG_leading",
    "root": "ANgngG_root",
    "sep": "ANgngG_sep",
    "summary": "ANgngG_summary",
    "terminal": "ANgngG_terminal",
    "title": "ANgngG_title",
    "visuallyHidden": "ANgngG_visuallyHidden"
};

},
"src/modules/tool/tool/toolviews/bash-sample.css": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/bash-sample.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".ANgngG_card{flex-direction:column;display:flex}.ANgngG_terminal{--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:1px solid var(--dsw-alias-border-l1);margin:4px 0 4px 4px}.ANgngG_ioCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);border-radius:12px;flex-direction:column;margin:4px 0 4px 4px;display:flex}.ANgngG_ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}.ANgngG_ioSection::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}.ANgngG_ioSection::-webkit-scrollbar-track{margin:6px 0}.ANgngG_ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}.ANgngG_ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:1px}.ANgngG_ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}.ANgngG_ioText[data-error]{color:var(--dsw-alias-state-error-primary)}.ANgngG_root[data-expandable]{cursor:pointer}.ANgngG_root{align-items:center;min-width:0;height:24px;display:flex;position:relative;overflow:hidden}.ANgngG_root[data-state=running]:after{content:\"\";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite ANgngG_dsh-bash-row-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes ANgngG_dsh-bash-row-sweep{0%{left:-300px}90%,to{left:100%}}.ANgngG_leading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}.ANgngG_chevron{color:var(--dsw-alias-label-secondary)}.ANgngG_iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}.ANgngG_chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}.ANgngG_root:hover .ANgngG_iconIdle{opacity:0}.ANgngG_root:hover .ANgngG_chevronHover{opacity:1}.ANgngG_title{color:var(--dsw-alias-label-secondary);flex:none;font-size:14px;line-height:24px}.ANgngG_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.ANgngG_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.ANgngG_errorSummary{color:var(--dsw-alias-state-error-primary)}.ANgngG_bodyWrap{flex-direction:column;display:flex}.ANgngG_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}.ANgngG_card:hover .ANgngG_inspectButton,.ANgngG_inspectButton:focus-visible{opacity:1}.ANgngG_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.ANgngG_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";

},
"src/modules/jobs/RunPanel.js": function(module, exports, require) {
// source: src/modules/jobs/RunPanel.tsx

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
exports.JobRunPanel = JobRunPanel;
exports.JobToolPanel = JobToolPanel;
exports.ExecutionsPage = ExecutionsPage;
const jsx_runtime_1 = require("react/jsx-runtime");
const React = __importStar(require("react"));
const RunPanel_css_1 = __importDefault(require("./RunPanel.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/jobs/RunPanel.css', '@xharness/jobs', RunPanel_css_1.default);
const model_1 = require("./model");
const zh = () => typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh');
const labels = { preparing: ['准备中', 'Preparing'], queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], waiting: ['等待中', 'Waiting'], stopping: ['停止中', 'Stopping'], completed: ['已完成', 'Completed'], failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], interrupted: ['已中断', 'Interrupted'], incomplete: ['未完成', 'Incomplete'], unavailable: ['不可用', 'Unavailable'], scheduled: ['等待触发', 'Scheduled'], overdue: ['等待调度', 'Overdue'], paused: ['未来触发已暂停', 'Future triggers paused'], finished: ['触发已结束', 'Trigger finished'], deleted: ['未来触发已取消', 'Future triggers cancelled'], inherited: ['继承记录', 'Inherited'], inactive: ['未启用', 'Inactive'] };
const label = (state) => labels[state]?.[zh() ? 0 : 1] ?? state;
function RunRow({ run, client, openSession }) {
    const [pending, setPending] = React.useState(false), [error, setError] = React.useState(''), [output, setOutput] = React.useState('');
    const controller = React.useRef(), alive = React.useRef(true), mutation = React.useRef(false);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, [run.id, run.sourceSessionId]);
    async function act(kind) {
        if (mutation.current)
            return;
        mutation.current = true;
        setPending(true);
        setError('');
        controller.current?.abort();
        controller.current = new AbortController();
        try {
            if (kind === 'cancel')
                await client.control(run.sourceSessionId, { action: 'cancel_run', reference: run.reference });
            else {
                const value = await client.output(run.sourceSessionId, run.reference, controller.current.signal);
                if (alive.current)
                    setOutput(`${value.stdout}${value.stderr ? `\n${value.stderr}` : ''}${value.stdoutTruncated || value.stderrTruncated ? `\n${zh() ? '[较早输出已被清理]' : '[Earlier output was evicted]'}` : ''}`);
            }
        }
        catch (e) {
            if (alive.current)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            mutation.current = false;
            if (alive.current)
                setPending(false);
        }
    }
    return (0, jsx_runtime_1.jsxs)("article", { className: "xhjob-run", "data-run-id": run.id, "data-run-state": run.state, children: [(0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-title", children: run.label }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-bottom", children: [(0, jsx_runtime_1.jsxs)("span", { children: [run.reference.kind === 'process' ? (zh() ? '命令' : 'Command') : (zh() ? 'Agent' : 'Agent'), " \u00B7 ", label(run.state)] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-actions", children: [run.capabilities.readOutput && (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void act('output'), children: zh() ? '读取输出' : 'Read output' }), run.capabilities.cancelRun && (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void act('cancel'), children: zh() ? '取消本次执行' : 'Cancel this run' }), run.capabilities.openSession && openSession && (0, jsx_runtime_1.jsx)("button", { onClick: () => openSession(run.targetSessionId), children: zh() ? '查看对话' : 'Open conversation' })] })] }), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: zh() ? '运行详情' : 'Run details' }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-muted", children: [(0, jsx_runtime_1.jsx)("code", { children: run.id }), run.startedAtMs !== null && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [" \u00B7 ", zh() ? '开始' : 'Started', " ", new Date(run.startedAtMs).toLocaleString()] })] })] }), run.detail && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-muted", children: run.detail }), output && (0, jsx_runtime_1.jsx)("pre", { "aria-label": zh() ? '运行输出' : 'Run output', children: output }), error && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-error", role: "alert", children: error })] });
}
function JobRunPanel({ client, sessionId, planId, runId, openSession }) {
    const subscribe = React.useCallback((f) => client.subscribe(sessionId, f), [client, sessionId]), snapshot = React.useCallback(() => client.snapshot(sessionId), [client, sessionId]);
    const state = React.useSyncExternalStore(subscribe, snapshot);
    const [pending, setPending] = React.useState(false), [error, setError] = React.useState(''), [confirm, setConfirm] = React.useState();
    const gate = React.useRef(false), alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [sessionId, planId]);
    async function control(id, action) {
        if (gate.current)
            return;
        gate.current = true;
        setPending(true);
        setError('');
        try {
            await client.control(sessionId, { action, planId: id });
            if (alive.current)
                setConfirm(undefined);
        }
        catch (e) {
            if (alive.current)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            gate.current = false;
            if (alive.current)
                setPending(false);
        }
    }
    const plans = runId === undefined ? state.catalog?.plans.filter(p => planId === undefined || p.id === planId) ?? [] : [], runs = state.catalog?.runs.filter(r => (planId === undefined || r.planId === planId) && (runId === undefined || r.id === runId)) ?? [];
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhauto-card xhjob-panel", "aria-label": zh() ? '执行记录' : 'Execution records', children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("span", { children: zh() ? '执行记录' : 'Execution records' }), (0, jsx_runtime_1.jsx)("button", { disabled: state.loading, onClick: () => void client.refresh(sessionId), children: zh() ? '刷新' : 'Refresh' })] }), state.loading && !state.catalog && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh() ? '读取中…' : 'Loading…' }), (state.error || error) && (0, jsx_runtime_1.jsx)("p", { className: "xhauto-card-error", role: "alert", children: state.error ?? error }), !state.error && plans.map(p => (0, jsx_runtime_1.jsxs)("div", { className: "xhjob-plan", children: [(0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-title", children: p.label }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-bottom", children: [(0, jsx_runtime_1.jsxs)("span", { children: [zh() ? '计划' : 'Plan', " \u00B7 ", label(p.state)] }), ['scheduled', 'overdue', 'paused'].includes(p.state) && (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-actions", children: [(0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void control(p.id, p.state === 'paused' ? 'resume_plan' : 'pause_plan'), children: p.state === 'paused' ? (zh() ? '恢复未来触发' : 'Resume future triggers') : (zh() ? '暂停未来触发' : 'Pause future triggers') }), confirm === p.id ? (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { children: zh() ? '取消后不再触发，正在运行的任务不受影响。' : 'Stop future triggers, without cancelling admitted runs?' }), (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void control(p.id, 'cancel_future'), children: zh() ? '确认' : 'Confirm' }), (0, jsx_runtime_1.jsx)("button", { onClick: () => setConfirm(undefined), children: zh() ? '返回' : 'Back' })] }) : (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => setConfirm(p.id), children: zh() ? '取消未来触发' : 'Cancel future triggers' })] })] })] }, p.id)), !state.error && runs.map(run => (0, jsx_runtime_1.jsx)(RunRow, { run: run, client: client, openSession: openSession }, JSON.stringify([sessionId, run.id]))), state.catalog && !state.error && runs.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: "xhauto-card-muted", children: runId ? (zh() ? '此运行已失效或已被清理；不会关联到新的同名任务。' : 'This run expired or was evicted; it will not resolve to another job.') : (zh() ? '暂无执行记录。等待触发不代表执行成功。' : 'No runs yet. A scheduled trigger is not execution success.') })] });
}
function JobToolPanel({ client, sessionId, block }) {
    const id = (0, model_1.processHint)(block);
    return id ? (0, jsx_runtime_1.jsx)(JobRunPanel, { client: client, sessionId: sessionId, runId: id }) : null;
}
function ExecutionsPage({ client, service, openSession }) {
    const snapshot = React.useSyncExternalStore(service.subscribe, service.getSnapshot), [selected, setSelected] = React.useState('');
    const sessions = snapshot.sessions;
    const current = sessions.some(s => s.sessionId === selected) ? selected : sessions[0]?.sessionId;
    React.useEffect(() => { const c = new AbortController(); void service.refresh(c.signal).catch(() => { }); return () => c.abort(); }, [service]);
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhauto-page", children: [(0, jsx_runtime_1.jsx)("h2", { children: zh() ? '任务执行' : 'Executions' }), snapshot.error && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: snapshot.error }), (0, jsx_runtime_1.jsxs)("label", { children: [zh() ? '对话' : 'Chat', " ", (0, jsx_runtime_1.jsx)("select", { "aria-label": zh() ? '执行记录所属对话' : 'Execution chat', value: current ?? '', onChange: e => setSelected(e.target.value), children: sessions.map(s => (0, jsx_runtime_1.jsx)("option", { value: s.sessionId, children: s.sessionId }, s.sessionId)) })] }), current ? (0, jsx_runtime_1.jsx)(JobRunPanel, { client: client, sessionId: current, openSession: openSession }, current) : snapshot.loading || snapshot.phase === 'pending' ? (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh() ? '读取对话中…' : 'Loading chats…' }) : (0, jsx_runtime_1.jsx)("p", { children: zh() ? '暂无对话' : 'No chats' })] });
}

},
"src/modules/jobs/RunPanel.css": function(module, exports, require) {
// source: src/modules/jobs/RunPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhauto-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;margin:8px 0;padding:12px 14px;max-width:100%;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-background-primary,transparent)}\n.xhauto-card header{display:flex;align-items:center;gap:8px}.xhauto-card header>span:first-of-type{font-weight:500}.xhauto-card header>span:last-child{margin-left:auto}\n.xhauto-card-task{padding-top:10px}.xhauto-card-task+.xhauto-card-task{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}\n.xhauto-card-title{line-height:1.5;font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}\n.xhauto-card-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px;font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.xhauto-card-bottom{display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:space-between;margin-top:9px;font-size:12px}.xhauto-card-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}\n.xhauto-card button{border:1px solid var(--dsw-alias-border-l1);padding:4px 9px;border-radius:7px;cursor:pointer;background:transparent;color:inherit;font:inherit}.xhauto-card button:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhauto-card button:disabled{opacity:.5;cursor:default}.xhauto-card button:focus-visible,.xhauto-card summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}\n.xhauto-card-muted,.xhauto-card details{font-size:12px;color:var(--dsw-alias-label-tertiary)}.xhauto-card-error{margin-top:8px;color:var(--dsw-alias-state-danger-primary,#ba3939);overflow-wrap:anywhere}.xhauto-card details{margin-top:10px}.xhauto-card summary{cursor:pointer;width:fit-content}.xhauto-card pre{max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}\n.xhjob-panel{overflow-wrap:anywhere}.xhjob-panel header{justify-content:space-between}.xhjob-run,.xhjob-plan{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px}.xhjob-run code{font-size:11px}.xhjob-panel .xhauto-card-muted{margin-top:6px}.xhjob-panel .xhauto-card-actions{min-width:0}.xhjob-panel select{font:inherit;color:inherit;background:var(--dsw-alias-background-primary);border:1px solid var(--dsw-alias-border-l1)}\n";

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
"src/modules/jobs/model.js": function(module, exports, require) {
// source: src/modules/jobs/model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVE = exports.PLAN_STATES = exports.RUN_STATES = void 0;
exports.parseRun = parseRun;
exports.parseCatalog = parseCatalog;
exports.parseOutput = parseOutput;
exports.processHint = processHint;
/** Version 1 execution contract. Tool results only supply lookup hints. */
exports.RUN_STATES = ['preparing', 'queued', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'incomplete', 'unavailable'];
exports.PLAN_STATES = ['scheduled', 'overdue', 'paused', 'finished', 'deleted', 'inherited', 'inactive'];
exports.ACTIVE = new Set(['preparing', 'queued', 'running', 'waiting', 'stopping']);
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function object(v) { return isObject(v) ? v : {}; }
function list(v) { return Array.isArray(v) ? v : []; }
function text(v) { return typeof v === 'string' && v.length > 0; }
function timestamp(v) { return v === null || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
function runState(v) { return exports.RUN_STATES.some(s => s === v); }
function planState(v) { return exports.PLAN_STATES.some(s => s === v); }
function parseRef(raw) {
    const r = object(raw);
    if (r.kind === 'process' && text(r.id))
        return { kind: 'process', id: r.id };
    if (r.kind === 'automation' && text(r.planId) && text(r.inputId))
        return { kind: 'automation', planId: r.planId, inputId: r.inputId };
    throw Error('Invalid Job execution reference');
}
function parseRun(raw, session) {
    const v = object(raw), reference = parseRef(v.reference), c = object(v.capabilities);
    if (!text(v.id) || !text(v.label) || v.sourceSessionId !== session || !text(v.targetSessionId)
        || !runState(v.state) || !(v.planId === null || text(v.planId))
        || typeof c.cancelRun !== 'boolean' || typeof c.readOutput !== 'boolean' || typeof c.openSession !== 'boolean'
        || !timestamp(v.startedAtMs) || !timestamp(v.scheduledAtMs) || !timestamp(v.finishedAtMs)
        || !(v.detail === null || typeof v.detail === 'string'))
        throw Error('Invalid Job execution projection');
    if (reference.kind === 'process' ? reference.id !== v.id : reference.inputId !== v.id || reference.planId !== v.planId)
        throw Error('Job reference identity mismatch');
    return { id: v.id, label: v.label, sourceSessionId: session, targetSessionId: v.targetSessionId, planId: v.planId, state: v.state, reference, capabilities: { cancelRun: c.cancelRun, readOutput: c.readOutput, openSession: c.openSession }, startedAtMs: v.startedAtMs, scheduledAtMs: v.scheduledAtMs, finishedAtMs: v.finishedAtMs, detail: v.detail };
}
function parseCatalog(raw, session) {
    const v = object(raw);
    if (v.version !== 1 || v.sessionId !== session || !Array.isArray(v.runs) || !Array.isArray(v.plans))
        throw Error('Unsupported or foreign Job contract');
    const runs = list(v.runs).map(run => parseRun(run, session)), plans = list(v.plans).map((raw) => {
        const p = object(raw);
        if (!text(p.id) || !text(p.label) || !planState(p.state) || !text(p.nextAt) || !Number.isFinite(Date.parse(p.nextAt)) || !(p.everySeconds === null || typeof p.everySeconds === 'number' && Number.isSafeInteger(p.everySeconds) && p.everySeconds > 0))
            throw Error('Invalid Job plan projection');
        return { id: p.id, label: p.label, state: p.state, nextAt: p.nextAt, everySeconds: p.everySeconds };
    });
    if (new Set(runs.map(r => r.id)).size !== runs.length || new Set(plans.map(p => p.id)).size !== plans.length)
        throw Error('Duplicate Job identity');
    return { version: 1, sessionId: session, runs, plans };
}
function parseOutput(raw, session, ref) {
    const v = object(raw), c = object(v.nextCursor);
    if (v.version !== 1 || ref.kind !== 'process' || typeof v.stdout !== 'string' || typeof v.stderr !== 'string' || typeof v.stdoutTruncated !== 'boolean' || typeof v.stderrTruncated !== 'boolean' || c.job_id !== ref.id || typeof c.stdout !== 'number' || !Number.isSafeInteger(c.stdout) || c.stdout < 0 || typeof c.stderr !== 'number' || !Number.isSafeInteger(c.stderr) || c.stderr < 0)
        throw Error('Invalid Job output projection');
    const run = parseRun(v.run, session);
    if (run.id !== ref.id)
        throw Error('Job output identity changed');
    return { stdout: v.stdout, stderr: v.stderr, stdoutTruncated: v.stdoutTruncated, stderrTruncated: v.stderrTruncated, nextCursor: { job_id: ref.id, stdout: c.stdout, stderr: c.stderr }, run };
}
/** Nested legacy envelopes are ID hints only, never executable instructions. */
function processHint(block) {
    const b = object(block), call = object(b.call);
    const parse = (value) => { if (typeof value !== 'string' || value.length > 1048576)
        return undefined; try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    } };
    const args = object(parse(call.argsRaw ?? b.argsRaw));
    if (text(args.job_id))
        return args.job_id;
    let out = object(parse(list(b.content).map(p => { const o = object(p); return o.type === 'text' && typeof o.text === 'string' ? o.text : ''; }).join('\n')));
    if (out.ok === false || b.isError === true)
        return undefined;
    if (typeof out.content === 'string')
        out = object(parse(out.content));
    const snapshot = object(out.snapshot);
    return text(out.job_id) ? out.job_id : text(snapshot.id) ? snapshot.id : undefined;
}

},
"src/modules/tool/tool/toolviews/file-mutation-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/file-mutation-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileMutationToolview = void 0;
exports.FileMutationRow = FileMutationRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../../primitives");
const diff_card_model_1 = require("../models/diff-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
/**
 * File-mutation row: icon + {Edit,Write} · {path} in the shared ToolRow chrome,
 * with the applied diff as the row's collapsed-by-default card body. The
 * summary is a path link (a file tool's interaction); the host's `openFile`
 * resolves it against the session cwd, so this passes the tool's own path
 * verbatim. An errored mutation has no diff card, so ToolRow surfaces the
 * model-facing error text through its Output section and its first line in the
 * collapsed summary instead.
 */
function FileMutationRow({ toolName, block, cwd, home, openFile, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block, cwd, home);
    const diff = (0, diff_card_model_1.diffCardModel)(block);
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconEditOutline16, { size: 14 }), title: model.title, summary: model.summary, body: null, output: model.output, errorSummary: model.errorSummary, diff: diff, state: model.state, filePath: model.filePath, onOpenFile: openFile, inspect: inspect }));
}
/**
 * The file-mutation rows as a plain registrant plugin following the chat
 * toolview declaration across independent activation and reload lifetimes.
 */
exports.fileMutationToolview = {
    name: 'file-mutation-toolview',
    inject: ['slots'],
    /**
     * Register the file-mutation row into the Tool-owned keyed view slot
     * under both mutation tool names.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', function* () {
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', locale: locale_1.CONVERSATION_NS }, FileMutationRow);
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', locale: locale_1.CONVERSATION_NS }, FileMutationRow);
        });
    },
};

},
"src/modules/tool/tool/toolviews/read-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/read-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readToolview = void 0;
exports.ReadRow = ReadRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../../primitives");
const read_card_model_1 = require("../models/read-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
/**
 * Read row: icon + Read · {path} in the shared ToolRow chrome, with the file's
 * read card as the row's collapsed-by-default card body. The summary path is an
 * openable host link when the row names a single file.
 */
function ReadRow({ toolName, block, cwd, home, openFile, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block, cwd, home);
    const read = (0, read_card_model_1.readCardModel)(block, cwd, home);
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconBrowseOutline16, { size: 14 }), title: model.title, summary: model.summary, body: null, output: model.output, errorSummary: model.errorSummary, read: read, state: model.state, filePath: model.filePath, onOpenFile: openFile, inspect: inspect }));
}
/**
 * The read row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
exports.readToolview = {
    name: 'read-toolview',
    inject: ['slots'],
    /**
     * Register the read row into the Tool-owned keyed view slot.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'read', locale: locale_1.CONVERSATION_NS }, ReadRow));
    },
};

},
"src/modules/tool/tool/toolviews/search-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/search-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchToolview = void 0;
exports.SearchRow = SearchRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../../primitives");
const search_card_model_1 = require("../models/search-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
const SEARCH_TITLES = {
    grep: 'Grep',
    glob: 'Glob',
};
/**
 * Search row: icon + Grep/Glob · {summary} in the shared ToolRow chrome, with the
 * completed search's card as the row's collapsed-by-default card body (a capped
 * search's recovery footer rides below it, inside ToolRow). Registered under
 * both `grep` and `glob`; the derived model's `kind` decides the card shape. A
 * settled call with no search card surfaces its model-facing text through
 * ToolRow's Output section, since the keyed SearchRow owns this render slot.
 */
function SearchRow({ toolName, block, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block);
    const search = (0, search_card_model_1.searchCardModel)(block);
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconSearchOutline16, { size: 14 }), title: SEARCH_TITLES[toolName] ?? model.title,
        // The result view's replacement title outranks the args-derived summary,
        // matching the terminal card's description precedence.
        summary: search?.title ?? model.summary, body: null,
        // A settled call with no search card (errored search, nested run_code
        // sub-dispatch, legacy generic result) has its text nowhere else to go;
        // ToolRow's Output section carries it, and errorSummary its first line.
        // When a card is present ToolRow renders it instead of the output, so
        // model.output passes unconditionally and the four card rows stay
        // symmetric.
        output: model.output, errorSummary: model.errorSummary, search: search, state: model.state, inspect: inspect }));
}
/**
 * The search view follows the atomic Tool-view declaration across activation
 * and reload. One component registers under both keys because `grep` and
 * `glob` are the same visual object discriminated by the result view's `kind`.
 */
exports.searchToolview = {
    name: 'search-toolview',
    inject: ['slots'],
    /**
     * Register the search row into the Tool-owned keyed view slot under both
     * the `grep` and `glob` tool names.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', function* () {
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'grep', locale: locale_1.CONVERSATION_NS }, SearchRow);
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'glob', locale: locale_1.CONVERSATION_NS }, SearchRow);
        });
    },
};

},
"src/modules/tool/tool/toolviews/todo-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/todo-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.todoToolview = void 0;
exports.TodoRow = TodoRow;
const jsx_runtime_1 = require("react/jsx-runtime");
// todo_write toolview: plan-flavored summary row replacing the generic
// "Tool call" card, registered into the keyed 'tool.call.toolview'
// hole like the bash sample (a product registration, not a sample). The row
// composes ToolRow (chrome, running sweep, whole-row expand) and swaps in a
// summary of the written list (counts + active items) from the call args, with
// the parallel-active count riding ToolRow's non-shrinking summary suffix so a
// narrow row never clips it; the durable list itself renders in the TodoPanel
// above the composer, so the row stays one line until expanded.
const value_guards_1 = require("../../value-guards");
const primitives_1 = require("../../primitives");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
const plan_summary_1 = require("./plan-summary");
function isItem(value) {
    return typeof value === 'object' && value !== null;
}
function summarize(argsRaw, t) {
    let parsed;
    try {
        parsed = JSON.parse(argsRaw);
    }
    catch {
        // Mid-stream truncation or malformed model JSON: fall back to the generic summary.
        return null;
    }
    // Valid JSON with invalid todo fields (null root, non-array todos, null items —
    // a rejected tool/call retains such args verbatim): same generic fallback.
    if (!(0, value_guards_1.isRecord)(parsed))
        return null;
    const todos = parsed.todos;
    if (!(0, value_guards_1.isUnknownArray)(todos) || !todos.every(isItem))
        return null;
    const { done, total, activeContent, activeExtra } = (0, plan_summary_1.planSummary)(todos);
    const head = t('todo.completed', { done, total });
    return {
        text: activeContent === null ? head : `${head} · ${activeContent}`,
        extra: activeExtra,
    };
}
/** One-line plan update row (the whole row toggles the call's Input/Output
 *  sections, ToolRow's unified expand). Non-ok execution states keep the
 *  shared row's dot semantics — a cancelled call wrote no todo/write, so it
 *  must not read as a completed update. */
function TodoRow({ toolName, block, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block);
    const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '';
    const summary = summarize(argsRaw, t) ?? { text: model.summary, extra: 0 };
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: (0, jsx_runtime_1.jsx)(primitives_1.IconChecklistOutline14, {}), title: t('todo.rowTitle'), summary: summary.text, summarySuffix: summary.extra > 0 ? `+${summary.extra}` : null, body: model.body, output: model.output, errorSummary: model.errorSummary, state: model.state, inspect: inspect }));
}
/**
 * The todo row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
exports.todoToolview = {
    name: 'todo-toolview',
    inject: ['slots'],
    /**
     * Register the todo row into the Tool-owned keyed view slot.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'todo_write', locale: locale_1.CONVERSATION_NS }, TodoRow));
    },
};

},
"src/modules/tool/tool/toolviews/plan-summary.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/plan-summary.ts

"use strict";
/**
 * Pure plan derivation for the todo_write row's one-line summary. Several items
 * may be `in_progress` at once — parallel work runs concurrent tasks, so a
 * summary built from one active item would silently drop the rest. The plan
 * strip header derives its own counts inline and shares nothing with this, so
 * this stays inside the toolviews domain rather than in `contract/` (the
 * inter-domain face).
 * @module
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.planSummary = planSummary;
/**
 * Derive the counts and the active summary from a whole-list snapshot. It names
 * the first `in_progress` item and counts the remaining active ones, so a
 * parallel plan reports how many tasks are running rather than naming one and
 * hiding the others. `activeContent` is null when nothing is in progress, or
 * when the first active item's content is missing, mistyped, or blank once
 * trimmed — the tool's own rule for usable content, applied here because a
 * rejected call keeps its args verbatim. The row then renders the counts alone
 * rather than falling back to the generic tool summary: the counts are already
 * known to be good, and the active-item clause is the only part an unusable
 * name costs.
 * @param todos - the whole list, in model order.
 * @returns the done/total counts and the two summary halves.
 */
function planSummary(todos) {
    const active = todos.filter(t => t.status === 'in_progress');
    const first = active[0]?.content;
    const named = typeof first === 'string' && first.trim() !== '';
    return {
        done: todos.filter(t => t.status === 'completed').length,
        total: todos.length,
        activeContent: named ? first : null,
        activeExtra: named ? active.length - 1 : 0,
    };
}

},
"src/modules/tool/tool/toolviews/web-row.js": function(module, exports, require) {
// source: src/modules/tool/tool/toolviews/web-row.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webToolview = void 0;
exports.WebRow = WebRow;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("../../primitives");
const web_card_model_1 = require("../models/web-card-model");
const tool_call_model_1 = require("../models/tool-call-model");
const ToolRow_1 = require("../components/ToolRow");
const locale_1 = require("../../locale");
/** web_fetch reads one URL; web_search queries. Titles are figma literals. */
const WEB_TITLES = {
    web_search: 'Search',
    web_fetch: 'Fetch',
};
/**
 * Web row: icon + Search/Fetch · {summary} in the shared ToolRow chrome, with
 * the completed retrieval's web card as the row's collapsed-by-default card
 * body. The row discriminates on `toolName` only to pick its icon and title.
 */
function WebRow({ toolName, block, inspect, t }) {
    const model = (0, tool_call_model_1.toolRowModel)(toolName, block);
    const web = (0, web_card_model_1.webCardModel)(block);
    // Web search uses a globe; local grep/glob keep the magnifier family.
    const icon = toolName === 'web_fetch' ? (0, jsx_runtime_1.jsx)(primitives_1.IconBrowseOutline16, { size: 14 }) : (0, jsx_runtime_1.jsx)(primitives_1.IconGlobeOutline14, { size: 14 });
    return ((0, jsx_runtime_1.jsx)(ToolRow_1.ToolRow, { stateKey: block.callId, t: t, variant: model.variant, toolName: toolName, icon: icon, title: WEB_TITLES[toolName] ?? model.title, summary: model.summary, body: null, output: model.output, errorSummary: model.errorSummary, web: web, state: model.state, inspect: inspect }));
}
/**
 * The web rows follow the atomic Tool-view declaration across activation and
 * reload. One WebRow component registers under both web tool names.
 */
exports.webToolview = {
    name: 'web-toolview',
    inject: ['slots'],
    /**
     * Register the web row under both web tool names' keyed toolview holes.
     * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
     */
    apply(ctx) {
        ctx.slots.inject('tool.call.toolview', function* () {
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_search', locale: locale_1.CONVERSATION_NS }, WebRow);
            yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_fetch', locale: locale_1.CONVERSATION_NS }, WebRow);
        });
    },
};

}
};
const __dependencies = {"src/modules/tool/index.js":{"./apply":"src/modules/tool/apply.js"},"src/modules/tool/apply.js":{"./tool/ToolCallTree":"src/modules/tool/tool/ToolCallTree.js","./tool/ToolDetails":"src/modules/tool/tool/ToolDetails.js","./locale":"src/modules/tool/locale.js","./tool/toolviews/ask-question-row":"src/modules/tool/tool/toolviews/ask-question-row.js","./tool/toolviews/bash-sample":"src/modules/tool/tool/toolviews/bash-sample.js","./tool/toolviews/file-mutation-row":"src/modules/tool/tool/toolviews/file-mutation-row.js","./tool/toolviews/read-row":"src/modules/tool/tool/toolviews/read-row.js","./tool/toolviews/search-row":"src/modules/tool/tool/toolviews/search-row.js","./tool/toolviews/todo-row":"src/modules/tool/tool/toolviews/todo-row.js","./tool/toolviews/web-row":"src/modules/tool/tool/toolviews/web-row.js"},"src/modules/tool/tool/ToolCallTree.js":{"./toolviews/GenericToolCard":"src/modules/tool/tool/toolviews/GenericToolCard.js","./ToolCallTree.styles":"src/modules/tool/tool/ToolCallTree.styles.js"},"src/modules/tool/tool/toolviews/GenericToolCard.js":{"../../primitives":"src/modules/tool/primitives.js","../models/read-card-model":"src/modules/tool/tool/models/read-card-model.js","../models/diff-card-model":"src/modules/tool/tool/models/diff-card-model.js","../models/search-card-model":"src/modules/tool/tool/models/search-card-model.js","../models/terminal-card-model":"src/modules/tool/tool/models/terminal-card-model.js","../models/web-card-model":"src/modules/tool/tool/models/web-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../models/agent-communication-model":"src/modules/tool/tool/models/agent-communication-model.js"},"src/modules/tool/primitives.js":{},"src/modules/tool/tool/models/read-card-model.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js","../../runtime":"src/modules/tool/runtime.js","./tool-call-model":"src/modules/tool/tool/models/tool-call-model.js"},"src/modules/tool/tool/models/view-codec.js":{},"src/modules/tool/runtime.js":{},"src/modules/tool/tool/models/tool-call-model.js":{"../../value-guards":"src/modules/tool/value-guards.js","./shell-error-summary":"src/modules/tool/tool/models/shell-error-summary.js","../../runtime":"src/modules/tool/runtime.js"},"src/modules/tool/value-guards.js":{},"src/modules/tool/tool/models/shell-error-summary.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js"},"src/modules/tool/tool/models/diff-card-model.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js","../../value-guards":"src/modules/tool/value-guards.js"},"src/modules/tool/tool/models/search-card-model.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js","../../value-guards":"src/modules/tool/value-guards.js"},"src/modules/tool/tool/models/terminal-card-model.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js","../../runtime":"src/modules/tool/runtime.js"},"src/modules/tool/tool/models/web-card-model.js":{"./view-codec":"src/modules/tool/tool/models/view-codec.js"},"src/modules/tool/tool/components/ToolRow.js":{"../../transcript-state":"src/modules/tool/transcript-state.js","../../process-mode":"src/modules/tool/process-mode.js","../../class-names":"src/modules/tool/class-names.js","../../primitives":"src/modules/tool/primitives.js","../models/diff-card-model":"src/modules/tool/tool/models/diff-card-model.js","../models/read-card-model":"src/modules/tool/tool/models/read-card-model.js","../models/search-card-model":"src/modules/tool/tool/models/search-card-model.js","../models/terminal-card-model":"src/modules/tool/tool/models/terminal-card-model.js","./ToolRow.styles":"src/modules/tool/tool/components/ToolRow.styles.js","./ReviewDiffBlock":"src/modules/tool/tool/components/ReviewDiffBlock.js"},"src/modules/tool/transcript-state.js":{},"src/modules/tool/process-mode.js":{"../shared/process-display":"src/modules/shared/process-display.js"},"src/modules/shared/process-display.js":{},"src/modules/tool/class-names.js":{},"src/modules/tool/tool/components/ToolRow.styles.js":{"./ToolRow.css":"src/modules/tool/tool/components/ToolRow.css"},"src/modules/tool/tool/components/ToolRow.css":{},"src/modules/tool/tool/components/ReviewDiffBlock.js":{"../../primitives":"src/modules/tool/primitives.js","../../transcript-state":"src/modules/tool/transcript-state.js","./ReviewDiffBlock.styles":"src/modules/tool/tool/components/ReviewDiffBlock.styles.js"},"src/modules/tool/tool/components/ReviewDiffBlock.styles.js":{"./ReviewDiffBlock.css":"src/modules/tool/tool/components/ReviewDiffBlock.css"},"src/modules/tool/tool/components/ReviewDiffBlock.css":{},"src/modules/tool/tool/models/agent-communication-model.js":{"../../value-guards":"src/modules/tool/value-guards.js","./tool-call-model":"src/modules/tool/tool/models/tool-call-model.js"},"src/modules/tool/tool/ToolCallTree.styles.js":{"./ToolCallTree.css":"src/modules/tool/tool/ToolCallTree.css"},"src/modules/tool/tool/ToolCallTree.css":{},"src/modules/tool/tool/ToolDetails.js":{"../primitives":"src/modules/tool/primitives.js","./components/ReviewDiffBlock":"src/modules/tool/tool/components/ReviewDiffBlock.js","./models/diff-card-model":"src/modules/tool/tool/models/diff-card-model.js","./models/read-card-model":"src/modules/tool/tool/models/read-card-model.js","./models/search-card-model":"src/modules/tool/tool/models/search-card-model.js","./models/terminal-card-model":"src/modules/tool/tool/models/terminal-card-model.js","./models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","./models/web-card-model":"src/modules/tool/tool/models/web-card-model.js","./ToolDetails.styles":"src/modules/tool/tool/ToolDetails.styles.js"},"src/modules/tool/tool/ToolDetails.styles.js":{"./ToolDetails.css":"src/modules/tool/tool/ToolDetails.css"},"src/modules/tool/tool/ToolDetails.css":{},"src/modules/tool/locale.js":{},"src/modules/tool/tool/toolviews/ask-question-row.js":{"../../value-guards":"src/modules/tool/value-guards.js","../../primitives":"src/modules/tool/primitives.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js"},"src/modules/tool/tool/toolviews/bash-sample.js":{"../../transcript-state":"src/modules/tool/transcript-state.js","../../class-names":"src/modules/tool/class-names.js","../../primitives":"src/modules/tool/primitives.js","../models/terminal-card-model":"src/modules/tool/tool/models/terminal-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../../locale":"src/modules/tool/locale.js","./bash-sample.styles":"src/modules/tool/tool/toolviews/bash-sample.styles.js","../../../jobs/RunPanel":"src/modules/jobs/RunPanel.js"},"src/modules/tool/tool/toolviews/bash-sample.styles.js":{"./bash-sample.css":"src/modules/tool/tool/toolviews/bash-sample.css"},"src/modules/tool/tool/toolviews/bash-sample.css":{},"src/modules/jobs/RunPanel.js":{"./RunPanel.css":"src/modules/jobs/RunPanel.css","../views-types":"src/modules/views-types.js","./model":"src/modules/jobs/model.js"},"src/modules/jobs/RunPanel.css":{},"src/modules/views-types.js":{},"src/modules/jobs/model.js":{},"src/modules/tool/tool/toolviews/file-mutation-row.js":{"../../primitives":"src/modules/tool/primitives.js","../models/diff-card-model":"src/modules/tool/tool/models/diff-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js"},"src/modules/tool/tool/toolviews/read-row.js":{"../../primitives":"src/modules/tool/primitives.js","../models/read-card-model":"src/modules/tool/tool/models/read-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js"},"src/modules/tool/tool/toolviews/search-row.js":{"../../primitives":"src/modules/tool/primitives.js","../models/search-card-model":"src/modules/tool/tool/models/search-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js"},"src/modules/tool/tool/toolviews/todo-row.js":{"../../value-guards":"src/modules/tool/value-guards.js","../../primitives":"src/modules/tool/primitives.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js","./plan-summary":"src/modules/tool/tool/toolviews/plan-summary.js"},"src/modules/tool/tool/toolviews/plan-summary.js":{},"src/modules/tool/tool/toolviews/web-row.js":{"../../primitives":"src/modules/tool/primitives.js","../models/web-card-model":"src/modules/tool/tool/models/web-card-model.js","../models/tool-call-model":"src/modules/tool/tool/models/tool-call-model.js","../components/ToolRow":"src/modules/tool/tool/components/ToolRow.js","../../locale":"src/modules/tool/locale.js"}};
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
return __load("src/modules/tool/index.js");
}
});
