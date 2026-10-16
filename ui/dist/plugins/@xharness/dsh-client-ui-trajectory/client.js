// Generated from src/modules/trajectory/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-trajectory",
factory: (__externalRequire) => {
const __units = {
"src/modules/trajectory/index.js": function(module, exports, require) {
// source: src/modules/trajectory/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
const duration_store_1 = require("./duration-store");
const locales_1 = require("./locales");
const trajectory_assistant_definition_1 = require("./trajectory-assistant-definition");
const trajectory_compaction_definition_1 = require("./trajectory-compaction-definition");
const trajectory_message_definitions_1 = require("./trajectory-message-definitions");
const trajectory_request_header_definition_1 = require("./trajectory-request-header-definition");
const trajectory_snapshot_builder_1 = require("./trajectory-snapshot-builder");
const trajectory_tool_definition_1 = require("./trajectory-tool-definition");
const TrajectoryView_1 = require("./TrajectoryView");
/** Required services: the conversation slot, registries, ordinary Session paging, and the locale service. */
exports.inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale'];
/**
 * Client plugin body: register the trajectory view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-trajectory: dictionaries');
    // Registration-time text (the view tab label) reads through the bound
    // translate as a thunk, so it follows the active locale without
    // re-registration.
    const t = ctx.locale.bind(locales_1.NS);
    const duration = (0, duration_store_1.createTrajectoryDurationStore)();
    (0, trajectory_message_definitions_1.registerTrajectoryMessageDefinitions)(ctx);
    (0, trajectory_request_header_definition_1.registerTrajectoryRequestHeaderDefinition)(ctx);
    (0, trajectory_assistant_definition_1.registerTrajectoryAssistantDefinition)(ctx);
    (0, trajectory_tool_definition_1.registerTrajectoryToolDefinition)(ctx);
    (0, trajectory_compaction_definition_1.registerTrajectoryCompactionDefinitions)(ctx);
    (0, trajectory_snapshot_builder_1.registerTrajectoryConversationView)(ctx);
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'trajectory',
        order: 10,
        locale: locales_1.NS,
        label: () => t('view.trajectory'),
        inject: (sessionId) => {
            const session = ctx.sessions.binding(sessionId)?.session;
            if (session === undefined) {
                throw new Error(`ui-trajectory: session "${sessionId}" is unavailable`);
            }
            return {
                hooks: { duration },
                loadOlder: async () => {
                    const before = session.getSnapshot().views.get('trajectory');
                    await session.loadOlder();
                    return session.getSnapshot().views.get('trajectory') !== before;
                },
                setActualDuration: (value) => { duration.set(value); },
            };
        },
    }, TrajectoryView_1.TrajectoryView));
}

},
"src/modules/trajectory/duration-store.js": function(module, exports, require) {
// source: src/modules/trajectory/duration-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTrajectoryDurationStore = createTrajectoryDurationStore;
const zod_1 = require("zod");
const runtime_1 = require("./runtime");
/**
 * Create the browser-wide trajectory duration preference source.
 * @returns a persisted source shared by every session view in one plugin lifecycle.
 */
function createTrajectoryDurationStore() {
    return (0, runtime_1.createSnapshotStore)(false, {
        persist: { name: 'dsh.trajectory.duration', decode: value => zod_1.z.boolean().parse(value) },
    });
}

},
"src/modules/trajectory/runtime.js": function(module, exports, require) {
// source: src/modules/trajectory/runtime.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contextProvenance = exports.contextForm = exports.toAssistantBlocks = exports.toAssistantBlock = exports.isTokenDelta = exports.emptyAssistantBlock = exports.displayFailureMessage = exports.createSnapshotStore = void 0;
/** Runtime delegates and their public types come from the actual source. */
var client_1 = require("@xharness/dsh-client-runtime/client");
Object.defineProperty(exports, "createSnapshotStore", { enumerable: true, get: function () { return client_1.createSnapshotStore; } });
Object.defineProperty(exports, "displayFailureMessage", { enumerable: true, get: function () { return client_1.displayFailureMessage; } });
Object.defineProperty(exports, "emptyAssistantBlock", { enumerable: true, get: function () { return client_1.emptyAssistantBlock; } });
Object.defineProperty(exports, "isTokenDelta", { enumerable: true, get: function () { return client_1.isTokenDelta; } });
Object.defineProperty(exports, "toAssistantBlock", { enumerable: true, get: function () { return client_1.toAssistantBlock; } });
Object.defineProperty(exports, "toAssistantBlocks", { enumerable: true, get: function () { return client_1.toAssistantBlocks; } });
Object.defineProperty(exports, "contextForm", { enumerable: true, get: function () { return client_1.contextForm; } });
Object.defineProperty(exports, "contextProvenance", { enumerable: true, get: function () { return client_1.contextProvenance; } });

},
"src/modules/trajectory/locales.js": function(module, exports, require) {
// source: src/modules/trajectory/locales.ts

"use strict";
/** `trajectory` namespace dictionaries (view tab label + toolbar strings). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'trajectory';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'view.trajectory': '轨迹',
    'toolbar.aria': '轨迹工具栏',
    'toolbar.duration': 'Duration',
    'toolbar.useActualDuration': 'Use actual duration',
    'toolbar.useEqualWidth': 'Use equal-width operations',
    'toolbar.actualTime': '实际时间',
    'toolbar.turns': 'Turns',
    'toolbar.expandTurns': 'Expand turns',
    'toolbar.collapseTurns': 'Collapse turns',
    'toolbar.calls': 'Calls',
    'toolbar.expandCalls': 'Expand calls',
    'toolbar.collapseCalls': 'Collapse calls',
    'toolbar.search': '搜索轨迹',
    'toolbar.searchPlaceholder': '搜索',
};
/** English dictionary. */
exports.en = {
    'view.trajectory': 'Trajectory',
    'toolbar.aria': 'Trajectory toolbar',
    'toolbar.duration': 'Duration',
    'toolbar.useActualDuration': 'Use actual duration',
    'toolbar.useEqualWidth': 'Use equal-width operations',
    'toolbar.actualTime': 'Actual time',
    'toolbar.turns': 'Turns',
    'toolbar.expandTurns': 'Expand turns',
    'toolbar.collapseTurns': 'Collapse turns',
    'toolbar.calls': 'Calls',
    'toolbar.expandCalls': 'Expand calls',
    'toolbar.collapseCalls': 'Collapse calls',
    'toolbar.search': 'Search trajectory',
    'toolbar.searchPlaceholder': 'Search',
};

},
"src/modules/trajectory/trajectory-assistant-definition.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-assistant-definition.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryAssistantDefinition = registerTrajectoryAssistantDefinition;
const reception_metrics_1 = require("../shared/reception-metrics");
const brand_1 = require("../client-connection/contracts/llm/llm/brand");
const wire_event_codec_1 = require("./wire-event-codec");
const runtime_1 = require("./runtime");
const trajectory_definition_common_1 = require("./trajectory-definition-common");
function initialState(turn, step, startSeq, startTime, started) {
    return {
        turn,
        step,
        startSeq,
        startTime,
        started,
        sawChunk: false,
        blocks: [],
        firstVisibleSeq: undefined,
        firstVisibleTime: undefined,
        firstTokenTime: undefined,
        final: undefined,
        usage: undefined,
        retry: undefined,
        stepEnd: undefined,
    };
}
function compactBlocks(blocks) {
    return blocks.filter((block) => block !== undefined);
}
function hasVisibleContent(blocks) {
    return blocks.some((block) => {
        if (block.kind === 'tool-call')
            return false;
        if (block.kind === 'text' || block.kind === 'reasoning')
            return block.text.trim() !== '';
        return true;
    });
}
function hasInterruptionEvidence(blocks) {
    return blocks.some((block) => {
        if (block.kind === 'text' || block.kind === 'reasoning')
            return block.text.trim() !== '';
        return true;
    });
}
function addUsage(current, next) {
    return {
        inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
        outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
        ...(current?.cacheReadTokens === undefined && next.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }),
        ...(current?.cacheWriteTokens === undefined && next.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) }),
        ...(current?.reasoningTokens === undefined && next.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }),
    };
}
function updateChunk(state, match) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'assistant/chunk'))
        return state;
    const chunk = match.event.data.chunk;
    if (chunk.type === 'usage') {
        return { ...state, sawChunk: true, usage: addUsage(state.usage, chunk.usage) };
    }
    const blocks = [...state.blocks];
    switch (chunk.type) {
        case 'block-start':
            blocks[chunk.index] = (0, runtime_1.emptyAssistantBlock)(chunk.blockType);
            break;
        case 'text-delta': {
            const previous = blocks[chunk.index];
            blocks[chunk.index] = {
                kind: 'text',
                text: (previous?.kind === 'text' ? previous.text : '') + chunk.text,
            };
            break;
        }
        case 'reasoning-delta': {
            const previous = blocks[chunk.index];
            blocks[chunk.index] = {
                kind: 'reasoning',
                text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text,
            };
            break;
        }
        case 'tool-call-delta': {
            const previous = blocks[chunk.index];
            const base = previous?.kind === 'tool-call'
                ? previous
                : { kind: 'tool-call', callId: '', name: '', argsRaw: '' };
            blocks[chunk.index] = {
                kind: 'tool-call',
                callId: base.callId || String(chunk.id),
                name: chunk.name ?? base.name,
                argsRaw: base.argsRaw + chunk.argumentsDelta,
            };
            break;
        }
        case 'block-end':
            blocks[chunk.index] = (0, runtime_1.toAssistantBlock)(chunk.block);
            break;
        default:
            return { ...state, sawChunk: true };
    }
    const visible = hasVisibleContent(compactBlocks(blocks));
    return {
        ...state,
        sawChunk: true,
        blocks,
        ...(visible && state.firstVisibleSeq === undefined
            ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
            : {}),
        ...((0, runtime_1.isTokenDelta)(chunk) && state.firstTokenTime === undefined
            ? { firstTokenTime: match.event.time }
            : {}),
    };
}
function closedBoundary(context) {
    const stepEnd = context.state?.stepEnd?.event;
    if ((0, wire_event_codec_1.isTrajectoryEvent)(stepEnd, 'step/end'))
        return stepEnd;
    const location = context.start?.location
        ?? context.matches.at(-1)?.location;
    if (location?.kind === 'step' && location.step.status === 'closed')
        return location.step.end;
    if ((location?.kind === 'step' || location?.kind === 'turn')
        && location.turn.status === 'closed')
        return location.turn.end;
    return undefined;
}
function fallbackState(context) {
    let state;
    for (const match of context.matches) {
        const r = (0, reception_metrics_1.receptionReading)(match.event);
        if (r !== null) {
            state ?? (state = initialState(r.turn, r.step, match.event.seq, r.startMs, false));
            state = { ...state, reception: r };
            continue;
        }
        const event = match.event;
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'assistant/chunk')) {
            state ?? (state = initialState(event.data.turn, event.data.step, event.seq, event.time, false));
            state = updateChunk(state, match);
        }
        else if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'assistant/message')) {
            state ?? (state = initialState(event.data.turn, event.data.step, event.seq, event.time, false));
            state = {
                ...state,
                blocks: (0, runtime_1.toAssistantBlocks)(event.data.message.content),
                final: match,
                usage: state.usage ?? event.data.usage,
            };
        }
        else if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'step/end') && state !== undefined) {
            state = { ...state, stepEnd: match };
        }
    }
    return state;
}
function finalNode(state, context) {
    const final = state.final;
    if (final !== undefined && (0, wire_event_codec_1.isTrajectoryEvent)(final.event, 'assistant/message')) {
        const event = final.event;
        return {
            kind: 'assistant',
            seq: event.seq,
            messageId: (0, brand_1.MessageId)(event.data.message.id),
            time: event.time,
            turn: state.turn,
            step: state.step,
            blocks: (0, runtime_1.toAssistantBlocks)(event.data.message.content),
            usage: event.data.usage,
            provenance: {
                provider: event.data.message.source.provider,
                model: event.data.message.source.model,
            },
            timing: {
                stepStartTime: state.reception?.startMs ?? (state.started ? state.startTime : null),
                firstTokenTime: state.reception?.firstDeltaMs ?? state.firstTokenTime ?? null,
                completedTime: state.reception?.finished ? state.reception.startMs + state.reception.elapsedMs : event.time,
                ...(state.reception === undefined ? {} : { receptionMs: state.reception.receptionMs }),
            },
            ...(event.data.interrupted === true ? { interrupted: true } : {}),
        };
    }
    const boundary = closedBoundary(context);
    const blocks = compactBlocks(state.blocks);
    if (boundary === undefined || !hasInterruptionEvidence(blocks))
        return undefined;
    return {
        kind: 'assistant',
        seq: boundary.seq - 0.9,
        time: boundary.time,
        turn: state.turn,
        step: state.step,
        blocks,
        interrupted: true,
    };
}
function assistantRequest(state, node, boundary) {
    if (!state.started)
        return undefined;
    const status = node !== undefined && node.interrupted !== true
        ? 'complete'
        : state.retry !== undefined || boundary !== undefined ? 'error' : 'running';
    return {
        purpose: 'assistant',
        startSeq: state.startSeq,
        turn: state.turn,
        step: state.step,
        startedAt: state.startTime,
        completedAt: node?.time ?? boundary?.time ?? null,
        status,
        ...(state.retry === undefined
            ? {}
            : {
                error: state.retry.message,
                retry: state.retry.retry,
                ...(state.retry.maxRetries === undefined ? {} : { maxRetries: state.retry.maxRetries }),
                retryDelayMs: state.retry.delayMs,
            }),
        ...(node?.messageId === undefined
            ? {}
            : {
                resultSeq: node.seq,
                ...(node.provenance === undefined ? {} : { provenance: node.provenance }),
            }),
        ...(state.usage === undefined ? {} : { usage: state.usage }),
    };
}
/** Trajectory-owned Assistant streaming, settlement, and request lifecycle. */
const trajectoryAssistantDefinition = {
    kind: 'trajectory-assistant-step',
    target: 'trajectory',
    match: (event) => {
        const r = (0, reception_metrics_1.receptionReading)(event);
        if (r !== null)
            return { id: `${r.turn}:${r.step}`, role: 'update' };
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'step/start')) {
            return { id: `${event.data.turn}:${event.data.step}`, role: 'start' };
        }
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'assistant/chunk')
            || (0, wire_event_codec_1.isTrajectoryEvent)(event, 'assistant/message')
            || (0, wire_event_codec_1.isTrajectoryEvent)(event, 'llm/retry')
            || (0, wire_event_codec_1.isTrajectoryEvent)(event, 'step/end')) {
            return { id: `${event.data.turn}:${event.data.step}`, role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'step/start')) {
            throw new Error('trajectory-assistant-step start requires step/start');
        }
        return initialState(match.event.data.turn, match.event.data.step, match.event.seq, match.event.time, true);
    },
    update: (context, match) => {
        const r = (0, reception_metrics_1.receptionReading)(match.event);
        if (r !== null)
            return { ...context.state, reception: r };
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'assistant/chunk'))
            return updateChunk(context.state, match);
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'assistant/message')) {
            return {
                ...context.state,
                blocks: (0, runtime_1.toAssistantBlocks)(match.event.data.message.content),
                final: match,
                usage: context.state.usage ?? match.event.data.usage,
            };
        }
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'step/end'))
            return { ...context.state, stepEnd: match };
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'llm/retry'))
            return context.state;
        const data = match.event.data;
        return {
            ...initialState(context.state.turn, context.state.step, context.state.startSeq, context.state.startTime, true),
            firstTokenTime: context.state.firstTokenTime,
            usage: context.state.usage,
            retry: {
                message: (0, runtime_1.displayFailureMessage)(data.failure),
                retry: data.retry,
                ...(data.mode === 'normal' ? { maxRetries: data.maxRetries } : {}),
                delayMs: data.delayMs,
            },
        };
    },
    publication: (match) => {
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'step/start'))
            return 'none';
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'assistant/chunk'))
            return 'immediate';
        const type = match.event.data.chunk.type;
        return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame';
    },
    buildViewNode: (context) => {
        const state = context.state ?? fallbackState(context);
        if (state === undefined)
            return null;
        const node = finalNode(state, context);
        const boundary = closedBoundary(context);
        const partial = node === undefined && boundary === undefined && state.sawChunk
            ? { turn: state.turn, step: state.step, blocks: compactBlocks(state.blocks) }
            : null;
        const request = assistantRequest(state, node, boundary);
        if (node === undefined && partial === null && request === undefined)
            return null;
        return (0, trajectory_definition_common_1.trajectoryNode)(context, state.startSeq, {
            kind: 'assistant',
            ...(node === undefined ? {} : { node }),
            partial,
            ...(request === undefined ? {} : { request }),
        });
    },
};
const trajectoryTurnEndDefinition = {
    kind: 'trajectory-turn-end',
    target: 'trajectory',
    match: event => (0, wire_event_codec_1.isTrajectoryEvent)(event, 'turn/end')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'turn/end')) {
            throw new Error('trajectory-turn-end start requires turn/end');
        }
        const reason = match.event.data.reason;
        const failure = reason.kind === 'error'
            ? reason.error ?? ('failure' in reason ? reason.failure : undefined)
            : undefined;
        return {
            turn: match.event.data.turn,
            seq: match.event.seq,
            time: match.event.time,
            ...(failure === undefined || failure === null ? {} : { error: (0, runtime_1.displayFailureMessage)(failure) }),
        };
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : (0, trajectory_definition_common_1.trajectoryNode)(context, context.state.seq, {
            kind: 'turn-end',
            turn: context.state.turn,
            time: context.state.time,
            ...(context.state.error === undefined ? {} : { error: context.state.error }),
        }),
};
/* jscpd:ignore-end */
/**
 * Register the Trajectory Assistant lifecycle.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
function registerTrajectoryAssistantDefinition(ctx) {
    ctx.conversationEvents.register(trajectoryAssistantDefinition);
    ctx.conversationEvents.register(trajectoryTurnEndDefinition);
}

},
"src/modules/shared/reception-metrics.js": function(module, exports, require) {
// source: src/modules/shared/reception-metrics.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.throughput = throughput;
exports.totalOutputTokens = totalOutputTokens;
exports.messageProvenance = messageProvenance;
exports.receptionReading = receptionReading;
const runtime_types_1 = require("./runtime-types");
/** Pure metric arithmetic shared by Chat and Performance. Never reads UI time. */
function throughput(tokens, milliseconds) {
    return Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(milliseconds) && milliseconds > 0
        ? tokens / (milliseconds / 1000) : null;
}
function totalOutputTokens(usage) {
    if (!(0, runtime_types_1.isObjectRecord)(usage))
        return null;
    const output = usage.outputTokens;
    const reasoning = usage.reasoningTokens ?? 0;
    return typeof output === 'number' && Number.isFinite(output) && output >= 0
        && typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0 ? output + reasoning : null;
}
function messageProvenance(message) {
    if (!(0, runtime_types_1.isObjectRecord)(message) || !(0, runtime_types_1.isObjectRecord)(message.source))
        return undefined;
    const { provider, model } = message.source;
    return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}
function receptionReading(event) {
    if (event?.type !== 'model/reception' || !(0, runtime_types_1.isObjectRecord)(event.data))
        return null;
    const data = event.data, r = data.reception;
    if (!(0, runtime_types_1.isObjectRecord)(r))
        return null;
    const { turn, step } = data;
    const { attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished } = r;
    const finite = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!finite(turn) || !finite(step) || !finite(attempt) || !finite(startMs) || !finite(elapsedMs)
        || !finite(receptionMs) || receptionMs < 1 || typeof finished !== 'boolean'
        || !(firstDeltaMs === null || finite(firstDeltaMs) && firstDeltaMs >= startMs))
        return null;
    return { turn, step, attempt, startMs, firstDeltaMs, elapsedMs, receptionMs, finished };
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
"src/modules/client-connection/contracts/llm/llm/brand.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/llm/llm/brand.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageId = MessageId;
exports.CallId = CallId;
exports.ProviderRequestId = ProviderRequestId;
exports.ReasoningEffortId = ReasoningEffortId;
const zod_1 = require("zod");
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function MessageId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function CallId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function ProviderRequestId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
function ReasoningEffortId(id) {
    return zod_1.z.string().brand().parse(id);
}

},
"src/modules/trajectory/wire-event-codec.js": function(module, exports, require) {
// source: src/modules/trajectory/wire-event-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptSchema = exports.requestConfigSchema = void 0;
exports.isTrajectoryEvent = isTrajectoryEvent;
const zod_1 = require("zod");
const compaction_outcome_1 = require("../shared/compaction-outcome");
const session_terminal_1 = require("../shared/generated/session-terminal");
const s = zod_1.z.string(), n = zod_1.z.number(), content = zod_1.z.array(zod_1.z.unknown());
const coords = { turn: n, step: n };
const usage = zod_1.z.looseObject({ inputTokens: n, outputTokens: n, cacheReadTokens: n.optional(), cacheWriteTokens: n.optional(), reasoningTokens: n.optional() });
const chunk = zod_1.z.union([
    zod_1.z.looseObject({ type: zod_1.z.literal('block-start'), index: n, blockType: s }),
    zod_1.z.looseObject({ type: zod_1.z.enum(['text-delta', 'reasoning-delta']), index: n, text: s }),
    zod_1.z.looseObject({ type: zod_1.z.literal('tool-call-delta'), index: n, id: s, name: s.optional(), argumentsDelta: s }),
    zod_1.z.looseObject({ type: zod_1.z.literal('block-end'), index: n, block: zod_1.z.unknown() }),
    zod_1.z.looseObject({ type: zod_1.z.literal('usage'), usage }),
    zod_1.z.looseObject({ type: zod_1.z.literal('finish') }),
]);
const dispatch = { rootCallId: s, parentCallId: s, subCallId: s, name: s, arguments: zod_1.z.unknown() };
exports.requestConfigSchema = zod_1.z.looseObject({ provider: s, model: s, purpose: s.optional(), thinking: s.optional(), reasoningEffort: s.optional(), temperature: n.optional(), maxTokens: n.optional(), stop: zod_1.z.array(s).optional() });
exports.promptSchema = zod_1.z.looseObject({ config: exports.requestConfigSchema, system: s, tools: zod_1.z.array(zod_1.z.looseObject({ name: s, description: s, parameters: zod_1.z.record(s, zod_1.z.unknown()) })) });
const schemas = {
    'step/start': zod_1.z.looseObject(coords),
    'step/end': zod_1.z.looseObject(coords),
    'assistant/chunk': zod_1.z.looseObject({ ...coords, chunk }),
    'assistant/message': zod_1.z.looseObject({ ...coords, message: zod_1.z.looseObject({ id: s, content, source: zod_1.z.looseObject({ provider: s, model: s }) }), usage: usage.optional(), interrupted: zod_1.z.boolean().optional() }),
    'user/message': zod_1.z.looseObject({ id: s, content, source: zod_1.z.looseObject({ kind: s }) }),
    'tool/call': zod_1.z.looseObject({ ...coords, callId: s, name: s, arguments: s }),
    'tool/result': zod_1.z.looseObject({ message: zod_1.z.looseObject({ source: zod_1.z.looseObject({ callId: s }), content: zod_1.z.tuple([zod_1.z.looseObject({ type: zod_1.z.literal('tool-result'), content, isError: zod_1.z.boolean().optional() })]).rest(zod_1.z.unknown()) }), error: zod_1.z.looseObject({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional() }),
    'tool/code-dispatch-start': zod_1.z.looseObject(dispatch),
    'tool/code-dispatch': zod_1.z.looseObject({ ...dispatch, content: content.optional(), isError: zod_1.z.boolean().optional() }),
    'compaction/start': zod_1.z.looseObject({ compactionId: s, turn: n.nullable() }),
    'compaction/summary': zod_1.z.looseObject({ compactionId: s, provider: s, model: s, summary: content, rawOutput: content.optional(), maxTokens: n.optional(), usage: zod_1.z.unknown().optional() }),
    'compaction/end': zod_1.z.looseObject({ compactionId: s, error: s.optional(), outcome: compaction_outcome_1.CompactionEndOutcomeSchema.optional() }).refine(compaction_outcome_1.validCompactionTerminalData),
    'agent/inbox/spliced': zod_1.z.looseObject({ target: s, start: n, removedCount: n.optional(), inserted: zod_1.z.array(zod_1.z.looseObject({ id: s })), outcome: zod_1.z.literal('canceled').optional() }),
    'llm/retry': zod_1.z.union([zod_1.z.looseObject({ ...coords, mode: zod_1.z.literal('normal'), retry: n, maxRetries: n, delayMs: n, failure: zod_1.z.unknown() }), zod_1.z.looseObject({ ...coords, mode: zod_1.z.literal('always'), retry: n, delayMs: n, failure: zod_1.z.unknown() })]),
    'turn/end': session_terminal_1.TurnEndDataInputSchema,
    'request/header': zod_1.z.looseObject({ header: zod_1.z.looseObject({ config: exports.requestConfigSchema, system: s.nullable().optional(), tools: exports.promptSchema.shape.tools.optional() }), reason: s }),
};
/** Validate only fields this target consumes. No coercion, cloning, defaults or
 * carrier replacement: opaque blocks and foreign payload fields retain identity. */
function isTrajectoryEvent(event, kind) {
    return event !== undefined && event.type === kind && schemas[kind].safeParse(event.data).success;
}

},
"src/modules/shared/compaction-outcome.js": function(module, exports, require) {
// source: src/modules/shared/compaction-outcome.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionEndOutcomeSchema = void 0;
exports.isCompactionEndOutcome = isCompactionEndOutcome;
exports.compactionTerminalPhase = compactionTerminalPhase;
exports.validCompactionTerminalData = validCompactionTerminalData;
const zod_1 = require("zod");
/** Additive durable terminal outcome. Absence retains legacy error semantics. */
exports.CompactionEndOutcomeSchema = zod_1.z.enum(['applied', 'no_benefit', 'no_eligible_source', 'interrupted', 'failed']);
function isCompactionEndOutcome(value) {
    return exports.CompactionEndOutcomeSchema.safeParse(value).success;
}
function compactionTerminalPhase(outcome, error) {
    switch (outcome) {
        case 'applied': return 'succeeded';
        case 'no_benefit':
        case 'no_eligible_source': return 'skipped';
        case 'interrupted': return 'cancelled';
        case 'failed': return 'failed';
        case undefined: return error == null ? 'succeeded' : 'failed';
    }
}
/** Validate explicit outcome/error consistency; legacy payloads remain accepted. */
function validCompactionTerminalData(value) {
    switch (value.outcome) {
        case 'applied':
        case 'no_benefit':
        case 'no_eligible_source': return value.error == null;
        case 'interrupted':
        case 'failed': return typeof value.error === 'string' && value.error.trim() !== '';
        case undefined: return true;
    }
}

},
"src/modules/shared/generated/session-terminal.js": function(module, exports, require) {
// source: src/modules/shared/generated/session-terminal.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnFailureSchema = exports.TurnEndReasonWireSchema = exports.TurnEndReasonInputSchema = exports.TurnEndDataInputSchema = exports.TurnEndDataSchema = exports.LegacyTurnFailureSchema = exports.LegacyTurnEndReasonSchema = exports.SESSION_TERMINAL_SCHEMA_SHA256 = exports.SESSION_TERMINAL_CONTRACT = void 0;
// GENERATED from crates/xharness-projection/src/wire.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-session-terminal-contract.mjs.
const zod_1 = require("zod");
exports.SESSION_TERMINAL_CONTRACT = "xharness-session-terminal-v1";
exports.SESSION_TERMINAL_SCHEMA_SHA256 = "746b83b5db83d153180eb2c7b3dcc476302b2efc1346b496cb47edc1692cc2c9";
exports.LegacyTurnEndReasonSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("aborted") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("stop") }), zod_1.z.looseObject({ "error": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "failure": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "kind": zod_1.z.literal("error") })]));
exports.LegacyTurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "details": zod_1.z.union([zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()), zod_1.z.null()]).optional(), "message": zod_1.z.string() }));
exports.TurnEndDataSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonWireSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndDataInputSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonInputSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndReasonInputSchema = zod_1.z.lazy(() => zod_1.z.union([exports.TurnEndReasonWireSchema, exports.LegacyTurnEndReasonSchema]));
exports.TurnEndReasonWireSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("completed") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-tokens") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("cancelled") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-steps") }), zod_1.z.looseObject({ "error": exports.TurnFailureSchema, "kind": zod_1.z.literal("error") })]));
exports.TurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "message": zod_1.z.string() }));

},
"src/modules/trajectory/trajectory-definition-common.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-definition-common.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trajectoryNode = trajectoryNode;
/**
 * Wrap one contribution in the Engine-owned target envelope.
 *
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param data - Trajectory-specific contribution payload.
 * @returns The contribution wrapped as a Trajectory view node.
 */
function trajectoryNode(context, anchorSeq, data) {
    return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: 'trajectory',
        anchorSeq,
        location: context.start?.location ?? { kind: 'unresolved' },
        data,
    };
}

},
"src/modules/trajectory/trajectory-compaction-definition.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-compaction-definition.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryCompactionDefinitions = registerTrajectoryCompactionDefinitions;
const compaction_outcome_1 = require("../shared/compaction-outcome");
const wire_event_codec_1 = require("./wire-event-codec");
const trajectory_definition_common_1 = require("./trajectory-definition-common");
function checkpointId(event) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(event, 'user/message'))
        return undefined;
    const source = event.data.source;
    return source.kind === 'plugin' && source.plugin === 'compact'
        && typeof source.compactionId === 'string' && source.compactionId !== ''
        ? source.compactionId
        : undefined;
}
function eventCompactionId(event) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(event, 'compaction/start')
        && !(0, wire_event_codec_1.isTrajectoryEvent)(event, 'compaction/summary')
        && !(0, wire_event_codec_1.isTrajectoryEvent)(event, 'compaction/end'))
        return undefined;
    const value = event.data.compactionId;
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function terminalStatus(outcome, error) {
    const phase = (0, compaction_outcome_1.compactionTerminalPhase)(outcome, error);
    return phase === 'succeeded' ? 'complete' : phase === 'failed' ? 'error' : phase;
}
function requestFromState(state) {
    const start = state.start.event;
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(start, 'compaction/start'))
        return undefined;
    const summary = state.summary?.event;
    const end = state.end?.event;
    const checkpoint = state.checkpoint?.event;
    return {
        purpose: 'compaction',
        startSeq: start.seq,
        turn: start.data.turn,
        step: 0,
        startedAt: start.time,
        completedAt: (0, wire_event_codec_1.isTrajectoryEvent)(end, 'compaction/end') ? end.time : null,
        status: !(0, wire_event_codec_1.isTrajectoryEvent)(end, 'compaction/end')
            ? 'running'
            : terminalStatus(end.data.outcome, end.data.error),
        ...((0, wire_event_codec_1.isTrajectoryEvent)(end, 'compaction/end') && end.data.outcome !== undefined ? { outcome: end.data.outcome } : {}),
        ...((0, wire_event_codec_1.isTrajectoryEvent)(end, 'compaction/end') && end.data.error !== undefined
            ? { error: end.data.error }
            : {}),
        ...(!(0, wire_event_codec_1.isTrajectoryEvent)(summary, 'compaction/summary')
            ? {}
            : {
                resultSeq: summary.seq,
                summary: summary.data.summary,
                ...(summary.data.rawOutput === undefined ? {} : { rawOutput: summary.data.rawOutput }),
                provenance: { provider: summary.data.provider, model: summary.data.model },
                requestConfig: {
                    provider: summary.data.provider,
                    model: summary.data.model,
                    purpose: 'compaction',
                    ...(summary.data.maxTokens === undefined ? {} : { maxTokens: summary.data.maxTokens }),
                },
                ...(summary.data.usage === undefined ? {} : { usage: summary.data.usage }),
            }),
        ...((0, wire_event_codec_1.isTrajectoryEvent)(checkpoint, 'user/message') ? { replacementSeq: checkpoint.seq } : {}),
    };
}
const trajectoryCompactionDefinition = {
    kind: 'trajectory-compaction',
    target: 'trajectory',
    match: (event) => {
        const compactId = eventCompactionId(event);
        if (compactId !== undefined) {
            return { id: compactId, role: (0, wire_event_codec_1.isTrajectoryEvent)(event, 'compaction/start') ? 'start' : 'update' };
        }
        const checkpoint = checkpointId(event);
        return checkpoint === undefined ? null : { id: checkpoint, role: 'update' };
    },
    start: (_context, match) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'compaction/start')) {
            throw new Error('trajectory-compaction start requires compaction/start');
        }
        return { start: match };
    },
    update: (context, match) => {
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'compaction/summary'))
            return { ...context.state, summary: match };
        if ((0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'compaction/end'))
            return { ...context.state, end: match };
        return checkpointId(match.event) === undefined
            ? context.state
            : { ...context.state, checkpoint: match };
    },
    buildViewNode: (context) => {
        if (context.state === undefined)
            return null;
        const request = requestFromState(context.state);
        return request === undefined
            ? null
            : (0, trajectory_definition_common_1.trajectoryNode)(context, request.startSeq, { kind: 'compaction', request });
    },
};
const trajectorySessionEndDefinition = {
    kind: 'trajectory-session-end',
    target: 'trajectory',
    match: event => event.type === 'session/end-seed'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : (0, trajectory_definition_common_1.trajectoryNode)(context, context.state.seq, {
            kind: 'session-end',
            seq: context.state.seq,
            time: context.state.time,
        }),
};
/**
 * Register Trajectory compaction requests and session boundaries.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
function registerTrajectoryCompactionDefinitions(ctx) {
    ctx.conversationEvents.register(trajectoryCompactionDefinition);
    ctx.conversationEvents.register(trajectorySessionEndDefinition);
}

},
"src/modules/trajectory/trajectory-message-definitions.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-message-definitions.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryMessageDefinitions = registerTrajectoryMessageDefinitions;
const runtime_types_1 = require("../shared/runtime-types");
const brand_1 = require("../client-connection/contracts/llm/llm/brand");
const wire_event_codec_1 = require("./wire-event-codec");
const runtime_1 = require("./runtime");
const trajectory_definition_common_1 = require("./trajectory-definition-common");
function isInboxIdentity(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.id === 'string';
}
function isInboxState(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && Array.isArray(value.pending) && value.pending.every(isInboxIdentity)
        && value.claimed instanceof Set && Array.from(value.claimed).every(id => typeof id === 'string');
}
function inboxState(value) {
    return isInboxState(value) ? value : undefined;
}
function applySplice(previous, splice) {
    const pending = [...(previous?.pending ?? [])];
    const claimed = new Set(previous?.claimed ?? []);
    const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted);
    for (const identity of splice.inserted)
        claimed.delete(identity.id);
    if (splice.outcome !== 'canceled') {
        for (const identity of removed)
            claimed.add(identity.id);
    }
    return { pending, claimed };
}
const trajectoryInboxDefinition = {
    kind: 'trajectory-inbox-next-step',
    match: event => (0, wire_event_codec_1.isTrajectoryEvent)(event, 'agent/inbox/spliced')
        && event.data.target === 'next-step'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'agent/inbox/spliced')) {
            throw new Error('trajectory-inbox-next-step start requires agent/inbox/spliced');
        }
        return applySplice(inboxState(reader.previous('trajectory-inbox-next-step')?.state), match.event.data);
    },
    update: context => context.state,
    publication: () => 'none',
};
const trajectoryMessageDefinition = {
    kind: 'trajectory-input-message',
    target: 'trajectory',
    match: event => (0, wire_event_codec_1.isTrajectoryEvent)(event, 'user/message')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'user/message')) {
            throw new Error('trajectory-input-message start requires user/message');
        }
        const event = match.event;
        if (event.data.source.kind !== 'user') {
            return {
                kind: 'context',
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
                provenance: (0, runtime_1.contextProvenance)(event.data.source),
                form: (0, runtime_1.contextForm)(event.data.source),
            };
        }
        const claimed = inboxState(reader.previous('trajectory-inbox-next-step')?.state)
            ?.claimed.has(String(event.data.id)) === true;
        return claimed
            ? {
                kind: 'steering',
                messageId: (0, brand_1.MessageId)(event.data.id),
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
            }
            : {
                kind: 'user',
                seq: event.seq,
                time: event.time,
                content: event.data.content,
                source: event.data.source,
            };
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : (0, trajectory_definition_common_1.trajectoryNode)(context, context.state.seq, { kind: 'node', node: context.state }),
};
/* jscpd:ignore-end */
/**
 * Register Trajectory-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
function registerTrajectoryMessageDefinitions(ctx) {
    ctx.conversationEvents.register(trajectoryInboxDefinition);
    ctx.conversationEvents.register(trajectoryMessageDefinition);
}

},
"src/modules/trajectory/trajectory-request-header-definition.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-request-header-definition.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryRequestHeaderDefinition = registerTrajectoryRequestHeaderDefinition;
const wire_event_codec_1 = require("./wire-event-codec");
const runtime_types_1 = require("../shared/runtime-types");
const trajectory_definition_common_1 = require("./trajectory-definition-common");
function isRequestConfig(value) {
    return wire_event_codec_1.requestConfigSchema.safeParse(value).success && (0, runtime_types_1.isObjectRecord)(value)
        && ['purpose', 'thinking', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'].every(key => !(key in value) || value[key] !== undefined);
}
function isPromptSnapshot(value) {
    return wire_event_codec_1.promptSchema.safeParse(value).success && (0, runtime_types_1.isObjectRecord)(value) && isRequestConfig(value.config);
}
function requestPrompt(match) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'request/header')) {
        throw new Error('trajectory-request-header start requires request/header');
    }
    const header = match.event.data.header;
    const config = header.config;
    if (!isRequestConfig(config))
        throw new TypeError('trajectory: invalid request configuration');
    return {
        config,
        system: header.system ?? '',
        tools: header.tools ?? [],
    };
}
function promptChange(previous, prompt, match) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'request/header'))
        return undefined;
    if (previous === undefined && match.event.data.reason !== 'initial')
        return undefined;
    const systemChanged = previous !== undefined && previous.system !== prompt.system;
    const toolsChanged = previous !== undefined
        && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools);
    if (previous !== undefined && !systemChanged && !toolsChanged)
        return undefined;
    return {
        seq: match.event.seq,
        time: match.event.time,
        kind: previous === undefined
            ? 'initial'
            : systemChanged && toolsChanged
                ? 'system-and-tools'
                : systemChanged ? 'system' : 'tools',
        ...(previous === undefined ? {} : { previous }),
    };
}
const trajectoryRequestHeaderDefinition = {
    kind: 'trajectory-request-header',
    target: 'trajectory',
    match: event => (0, wire_event_codec_1.isTrajectoryEvent)(event, 'request/header')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
        const prompt = requestPrompt(match);
        const previousState = reader.previous('trajectory-request-header')?.state;
        const previousPrompt = (0, runtime_types_1.isObjectRecord)(previousState) ? previousState.prompt : undefined;
        const previous = isPromptSnapshot(previousPrompt) ? previousPrompt : undefined;
        const change = promptChange(previous, prompt, match);
        return {
            seq: match.event.seq,
            time: match.event.time,
            prompt,
            location: match.location,
            ...(change === undefined ? {} : { change }),
        };
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : (0, trajectory_definition_common_1.trajectoryNode)(context, context.state.seq, {
            kind: 'request-header',
            header: context.state,
        }),
};
/**
 * Register Trajectory request-header facts.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
function registerTrajectoryRequestHeaderDefinition(ctx) {
    ctx.conversationEvents.register(trajectoryRequestHeaderDefinition);
}

},
"src/modules/trajectory/trajectory-snapshot-builder.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-snapshot-builder.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trajectoryViewDefinition = exports.TrajectorySnapshotBuilder = exports.EMPTY_TRAJECTORY_SNAPSHOT = void 0;
exports.registerTrajectoryConversationView = registerTrajectoryConversationView;
const snapshot_codec_1 = require("./snapshot-codec");
const EMPTY_LIST = [];
/** Stable empty target used until a Session has assembled Trajectory records. */
exports.EMPTY_TRAJECTORY_SNAPSHOT = {
    eventNodes: EMPTY_LIST,
    eventLocations: new Map(),
    requests: EMPTY_LIST,
    callSchemas: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
};
function stepKey(turn, step) {
    return `${turn}\u0000${step}`;
}
function headerStepKey(header) {
    const location = header.location;
    return location.kind === 'step'
        ? stepKey(location.turn.turn, location.step.step)
        : undefined;
}
function headerFor(request, headersByStep, previous) {
    return headersByStep.get(stepKey(request.turn, request.step))
        ?? (previous !== undefined && previous.seq < request.startSeq ? previous : undefined);
}
function applyHeader(request, header, includeChange) {
    return header === undefined
        ? request
        : {
            ...request,
            prompt: header.prompt,
            requestConfig: header.prompt.config,
            ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
        };
}
function withRequestConfig(node, prompt) {
    return prompt === undefined ? node : { ...node, requestConfig: prompt.config };
}
function captureSchemas(block, toolsByName, output) {
    const name = 'kind' in block ? block.call?.name : block.name;
    const schema = name === undefined ? undefined : toolsByName.get(name);
    if (schema !== undefined)
        output.set(block.callId, schema);
    for (const child of block.subCalls)
        captureSchemas(child, toolsByName, output);
}
function indexTools(tools) {
    return new Map(tools.map(tool => [tool.name, tool]));
}
function interruptCompactions(requests, boundaries) {
    let nextRequest = 0;
    const runningCompactions = [];
    for (const boundary of boundaries) {
        while (nextRequest < requests.length) {
            const request = requests[nextRequest];
            if (request === undefined || request.startSeq >= boundary.seq)
                break;
            if (request.purpose === 'compaction' && request.status === 'running') {
                runningCompactions.push(nextRequest);
            }
            nextRequest++;
        }
        let index = runningCompactions.pop();
        while (index !== undefined && requests[index]?.status !== 'running') {
            index = runningCompactions.pop();
        }
        if (index === undefined)
            continue;
        const request = requests[index];
        if (request?.purpose !== 'compaction')
            continue;
        requests[index] = {
            ...request,
            completedAt: boundary.time,
            status: 'error',
            error: 'Compaction was interrupted before completion.',
        };
    }
}
function applyTurnErrors(requests, endings) {
    const lastAssistantByTurn = new Map();
    for (const [index, request] of requests.entries()) {
        if (request.purpose === 'assistant')
            lastAssistantByTurn.set(request.turn, index);
    }
    for (const ending of endings) {
        if (ending.error === undefined)
            continue;
        const index = lastAssistantByTurn.get(ending.turn);
        if (index === undefined)
            continue;
        const request = requests[index];
        if (request?.purpose !== 'assistant')
            continue;
        requests[index] = {
            ...request,
            completedAt: request.completedAt ?? ending.time,
            status: 'error',
            error: ending.error,
        };
    }
}
/** Simple keyed adapter retaining the old Trajectory snapshot and stage layout. */
class TrajectorySnapshotBuilder {
    constructor() {
        this.nodes = new Map();
        this.positions = new Map();
        this.contributions = [];
        this.empty = exports.EMPTY_TRAJECTORY_SNAPSHOT;
    }
    replace(input) {
        this.nodes.clear();
        for (const node of input.nodes)
            this.nodes.set(node.key, node);
        this.rebuildContributions();
        return this.snapshot();
    }
    apply(input) {
        let structural = false;
        for (const node of input.upserts) {
            const previous = this.nodes.get(node.key);
            this.nodes.set(node.key, node);
            if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {
                structural = true;
                continue;
            }
            const position = this.positions.get(node.key);
            if (position === undefined)
                structural = true;
            else
                this.contributions[position] = node;
        }
        if (structural)
            this.rebuildContributions();
        return this.snapshot();
    }
    snapshot() {
        const headersByStep = new Map();
        for (const contribution of this.contributions) {
            if (contribution.data.kind !== 'request-header')
                continue;
            const key = headerStepKey(contribution.data.header);
            if (key !== undefined)
                headersByStep.set(key, contribution.data.header);
        }
        const finalized = [];
        const eventLocations = new Map();
        const requests = [];
        const boundaries = [];
        const turnEndings = [];
        const callSchemas = new Map();
        const consumedPromptChanges = new Set();
        let previousHeader;
        let previousTools = new Map();
        let partial = null;
        const runningCalls = [];
        for (const contribution of this.contributions) {
            const data = contribution.data;
            if (data.kind === 'request-header') {
                previousHeader = data.header;
                previousTools = indexTools(data.header.prompt.tools);
                continue;
            }
            if (data.kind === 'node') {
                finalized.push(data.node);
                eventLocations.set(data.node.seq, contribution.location);
                continue;
            }
            if (data.kind === 'assistant') {
                const header = data.request === undefined
                    ? undefined
                    : headerFor(data.request, headersByStep, previousHeader);
                if (data.node !== undefined)
                    finalized.push(withRequestConfig(data.node, header?.prompt));
                if (data.partial !== null)
                    partial = data.partial;
                if (data.request !== undefined) {
                    const includeChange = header?.change !== undefined
                        && !consumedPromptChanges.has(header.seq);
                    requests.push(applyHeader(data.request, header, includeChange));
                    if (includeChange)
                        consumedPromptChanges.add(header.seq);
                }
                continue;
            }
            if (data.kind === 'tool') {
                if ('kind' in data.root)
                    finalized.push(data.root);
                else
                    runningCalls.push(data.root);
                if (previousHeader !== undefined && previousHeader.seq < contribution.anchorSeq) {
                    captureSchemas(data.root, previousTools, callSchemas);
                }
                continue;
            }
            if (data.kind === 'compaction') {
                requests.push(data.request);
                continue;
            }
            if (data.kind === 'session-end') {
                boundaries.push({ seq: data.seq, time: data.time });
                continue;
            }
            turnEndings.push({
                turn: data.turn,
                time: data.time,
                ...(data.error === undefined ? {} : { error: data.error }),
            });
        }
        requests.sort((left, right) => left.startSeq - right.startSeq);
        interruptCompactions(requests, boundaries);
        applyTurnErrors(requests, turnEndings);
        finalized.sort((left, right) => left.seq - right.seq);
        const eventNodes = finalized;
        return (0, snapshot_codec_1.producedTrajectorySnapshot)({
            eventNodes,
            eventLocations,
            requests,
            callSchemas,
            partial,
            runningCalls,
        });
    }
    rebuildContributions() {
        this.contributions = [...this.nodes.values()]
            .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key));
        this.positions.clear();
        for (const [index, contribution] of this.contributions.entries()) {
            this.positions.set(contribution.key, index);
        }
    }
}
exports.TrajectorySnapshotBuilder = TrajectorySnapshotBuilder;
/** Trajectory target factory preserving the existing stage-oriented view model. */
exports.trajectoryViewDefinition = {
    target: 'trajectory',
    create: () => new TrajectorySnapshotBuilder(),
};
/**
 * Register the stage-oriented Trajectory target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
function registerTrajectoryConversationView(ctx) {
    ctx.conversationViews.register(exports.trajectoryViewDefinition);
}

},
"src/modules/trajectory/snapshot-codec.js": function(module, exports, require) {
// source: src/modules/trajectory/snapshot-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.producedTrajectorySnapshot = producedTrajectorySnapshot;
exports.isTrajectorySnapshot = isTrajectorySnapshot;
const zod_1 = require("zod");
const compaction_outcome_1 = require("../shared/compaction-outcome");
const runtime_types_1 = require("../shared/runtime-types");
const sessions_schema_1 = require("../client-connection/contracts/host/apiproxy/api/sessions.schema");
const wire_event_codec_1 = require("./wire-event-codec");
const s = zod_1.z.string(), n = zod_1.z.number(), content = zod_1.z.array(zod_1.z.unknown()), nullable = s.nullable();
const base = { seq: n, time: n };
const provenance = zod_1.z.looseObject({ provider: s, model: s });
const callView = zod_1.z.looseObject({ card: s }).nullable();
const blocks = zod_1.z.array(zod_1.z.union([
    zod_1.z.looseObject({ kind: zod_1.z.enum(['text', 'reasoning']), text: s }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('tool-call'), callId: s, name: s, argsRaw: s }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('image'), attachment: sessions_schema_1.imageAttachmentRefSchema }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('other'), block: zod_1.z.unknown() }),
]));
/** Optional properties in native JSON are absent, not own undefined fields.
 * Keep valid original records; this check does not normalize or strip them. */
function exactOptionals(value, keys) {
    return keys.every(key => !Object.hasOwn(value, key) || value[key] !== undefined);
}
const config = wire_event_codec_1.requestConfigSchema.refine(value => exactOptionals(value, ['purpose', 'thinking', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']));
const assistant = zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('assistant'), turn: n, step: n, blocks,
    messageId: s.optional(), usage: zod_1.z.unknown().optional(), provenance: provenance.optional(), requestConfig: config.optional(),
    timing: zod_1.z.looseObject({ stepStartTime: n.nullable(), firstTokenTime: n.nullable(), completedTime: n, receptionMs: n.optional() }).optional(), interrupted: zod_1.z.literal(true).optional(),
}).refine(value => exactOptionals(value, ['messageId', 'provenance', 'requestConfig', 'timing', 'interrupted']));
const tool = zod_1.z.lazy(() => zod_1.z.union([
    zod_1.z.looseObject({ callId: s, name: s, argsRaw: s, turn: n, step: n, time: n, callView, subCalls: zod_1.z.array(tool) }).refine(value => !('kind' in value)),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('tool-result'), callId: s, call: zod_1.z.looseObject({ name: s, argsRaw: s }).nullable(), callTime: n.nullable(), content, isError: zod_1.z.boolean(), error: zod_1.z.looseObject({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional(), callView, resultView: callView, subCalls: zod_1.z.array(tool) }).refine(value => exactOptionals(value, ['error'])),
]));
const retryFacts = { ...base, kind: zod_1.z.literal('model-retry'), retryId: s, turn: n, step: n, provider: s, policyKey: s, retry: n, delayMs: n, failure: zod_1.z.looseObject({ message: s, code: s }), retryState: zod_1.z.enum(['scheduled', 'started', 'cancelled']) };
const node = zod_1.z.union([
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('user'), content, source: zod_1.z.unknown() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('steering'), messageId: s, content, source: zod_1.z.unknown() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('context'), content, source: zod_1.z.unknown(), provenance: zod_1.z.looseObject({ role: zod_1.z.enum(['inject', 'recall']), label: nullable }), form: zod_1.z.enum(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']).nullable() }),
    assistant,
    // A finalized root is the tool-result arm, never a running call masquerading as a node.
    tool.refine(value => (0, runtime_types_1.isObjectRecord)(value) && value.kind === 'tool-result'),
    zod_1.z.looseObject({ ...retryFacts, mode: zod_1.z.literal('normal'), maxRetries: n }),
    zod_1.z.looseObject({ ...retryFacts, mode: zod_1.z.literal('always') }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-error'), turn: n, step: n, message: s, code: s.optional() }).refine(value => exactOptionals(value, ['code'])),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-max-tokens'), turn: n, step: n }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('compaction'), summary: nullable, summaryEventSeq: n.nullable(), shadowedItemCount: n.nullable(), shadowedTokenCount: n.nullable() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('command'), commandId: s, name: nullable, args: nullable, outcome: zod_1.z.looseObject({ kind: zod_1.z.enum(['success', 'error']), text: s.optional(), sourceEventSeq: n.optional() }).refine(value => exactOptionals(value, ['text', 'sourceEventSeq'])).nullable() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('unknown'), type: s, data: zod_1.z.unknown() }),
]);
const change = zod_1.z.looseObject({ seq: n, time: n, kind: zod_1.z.enum(['initial', 'system', 'tools', 'system-and-tools']), previous: wire_event_codec_1.promptSchema.optional() }).refine(value => exactOptionals(value, ['previous']));
const requestFacts = { startSeq: n, startedAt: n, completedAt: n.nullable(), status: zod_1.z.enum(['running', 'complete', 'error']), error: s.optional(), provenance: provenance.optional(), requestConfig: config.optional(), usage: zod_1.z.unknown().optional(), resultSeq: n.optional() };
const request = zod_1.z.union([
    zod_1.z.looseObject({ ...requestFacts, purpose: zod_1.z.literal('assistant'), turn: n, step: n, prompt: wire_event_codec_1.promptSchema.optional(), promptChange: change.optional(), retry: n.optional(), maxRetries: n.optional(), retryDelayMs: n.optional() }),
    zod_1.z.looseObject({ ...requestFacts, purpose: zod_1.z.literal('compaction'), status: zod_1.z.enum(['running', 'complete', 'error', 'skipped', 'cancelled']), outcome: compaction_outcome_1.CompactionEndOutcomeSchema.optional(), turn: n.nullable(), step: zod_1.z.literal(0), replacementSeq: n.optional(), summary: content.optional(), rawOutput: content.optional() }),
]).refine(value => exactOptionals(value, ['error', 'provenance', 'requestConfig', 'resultSeq', 'prompt', 'promptChange', 'retry', 'maxRetries', 'retryDelayMs', 'replacementSeq', 'summary', 'rawOutput', 'outcome']));
const location = zod_1.z.union([
    zod_1.z.looseObject({ kind: zod_1.z.enum(['session', 'unresolved']) }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('turn'), turn: zod_1.z.looseObject({ turn: n }) }),
    zod_1.z.looseObject({ kind: zod_1.z.literal('step'), turn: zod_1.z.looseObject({ turn: n }), step: zod_1.z.looseObject({ step: n }) }),
]);
function isMap(value, key, item) {
    if (!(value instanceof Map))
        return false;
    const entries = value;
    for (const [k, v] of entries)
        if (!key(k) || !item(v))
            return false;
    return true;
}
const snapshot = zod_1.z.looseObject({ eventNodes: zod_1.z.array(node), eventLocations: zod_1.z.unknown(), requests: zod_1.z.array(request), callSchemas: zod_1.z.unknown(), partial: zod_1.z.looseObject({ turn: n, step: n, blocks }).nullable(), runningCalls: zod_1.z.array(tool.refine(value => (0, runtime_types_1.isObjectRecord)(value) && !('kind' in value))) });
const produced = new WeakMap();
/** Typed producer witness is an ownership proof, not a wire-shape assertion. */
function producedTrajectorySnapshot(value) {
    produced.set(value, value);
    return value;
}
/** This target's complete read currency is owner-decoded, not a generic Map<T>
 * assertion. Typed owner snapshots use a witness; raw legacy snapshots are validated on every read. */
function isTrajectorySnapshot(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value))
        return false;
    if (produced.has(value))
        return true;
    if (!snapshot.safeParse(value).success
        || !isMap(value.eventLocations, key => typeof key === 'number', item => location.safeParse(item).success)
        || !isMap(value.callSchemas, key => typeof key === 'string', item => wire_event_codec_1.promptSchema.shape.tools.element.safeParse(item).success))
        return false;
    return true;
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.ts

"use strict";
/**
 * sessions domain zod schemas (names derived from map keys: sessionListRequestSchema /
 * sessionListValueSchema). SessionEvent passthrough = strict envelope (type/seq/time) + wide
 * data: the merge-extensible event API keeps an unknown-type branch at the union level,
 * with no field-level passthrough. SessionId brand cast point: sessionIdSchema, and only there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionImportRequestSchema = exports.sessionDeleteValueSchema = exports.sessionDeleteRequestSchema = exports.sessionCancelValueSchema = exports.sessionCancelRequestSchema = exports.sessionUpdateQueueValueSchema = exports.sessionUpdateQueueRequestSchema = exports.sessionAttachmentValueSchema = exports.sessionAttachmentRequestSchema = exports.imageAttachmentRefSchema = exports.attachmentIdSchema = exports.sessionPromptValueSchema = exports.sessionPromptRequestSchema = exports.promptContentPartSchema = exports.imageMediaTypeSchema = exports.contentBlockSchema = exports.sessionSelectModelValueSchema = exports.sessionSelectModelRequestSchema = exports.sessionModelsValueSchema = exports.sessionModelsRequestSchema = exports.sessionHistoryValueSchema = exports.imageLimitsProjectionSchema = exports.sessionListMetadataProjectionSchema = exports.sessionProjectionsBlockSchema = exports.historyEntrySchema = exports.toolEventViewSchema = exports.modelCatalogFailureSchema = exports.modelProviderGroupSchema = exports.modelCatalogModelSchema = exports.modelReasoningSchema = exports.modelReasoningEffortSchema = exports.modelSelectionSchema = exports.sessionHistoryRequestSchema = exports.sessionForkValueSchema = exports.sessionForkRequestSchema = exports.sessionRenameValueSchema = exports.sessionRenameRequestSchema = exports.sessionCreateValueSchema = exports.sessionCreateRequestSchema = exports.sessionSearchValueSchema = exports.sessionSearchItemSchema = exports.sessionSearchRequestSchema = exports.sessionListValueSchema = exports.sessionListRequestSchema = exports.sessionSummarySchema = exports.sessionOriginSchema = exports.sessionEventSchema = exports.workspaceIdSchema = exports.messageIdSchema = exports.sessionIdSchema = void 0;
exports.sessionImportValueSchema = void 0;
const zod_1 = require("zod");
const session_search_1 = require("./session-search");
/** SessionId: one brand cast after schema validation (the only cast point in this domain). */
exports.sessionIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** MessageId: one brand cast after non-empty string validation. */
exports.messageIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/**
 * WorkspaceId: the workspace domain's one brand cast. Hosted here rather
 * than in workspace.schema because session.create references it while
 * workspace.schema references sessionIdSchema — schema modules must stay a
 * DAG (both casts used at module top level; a cycle is a load-time TDZ).
 */
exports.workspaceIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** SessionEvent passthrough: strict envelope, wide data (the client fold handles unknown types via its documented default). */
exports.sessionEventSchema = zod_1.z.object({
    type: zod_1.z.string(),
    seq: zod_1.z.number().int().nonnegative(),
    time: zod_1.z.number(),
    data: zod_1.z.unknown(),
    sourceEventSeqs: zod_1.z.array(zod_1.z.number()).optional(),
    surfaceOp: zod_1.z.unknown().optional(),
    ignorable: zod_1.z.literal(true).optional(),
});
/** SessionSummary row of session.list (`projections` reuses the history block's shape and schema). */
exports.sessionOriginSchema = zod_1.z.enum(['subagent', 'fork', 'automation']);
exports.sessionSummarySchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    updatedAt: zod_1.z.number(),
    running: zod_1.z.boolean(),
    blank: zod_1.z.boolean(),
    parentSessionId: exports.sessionIdSchema.optional(),
    origin: exports.sessionOriginSchema.optional(),
    cwd: zod_1.z.string().optional(),
    agentPreset: zod_1.z.string().optional(),
    projections: zod_1.z.lazy(() => exports.sessionProjectionsBlockSchema).optional(),
});
/** session.list request payload (cursor is a reserved seat, unimplemented in v1). */
exports.sessionListRequestSchema = zod_1.z.object({
    cursor: zod_1.z.string().optional(),
});
/** session.list response value. */
exports.sessionListValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSummarySchema),
});
/** Fixed wire bound for one interactive sidebar query. */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500;
/** session.search request payload. */
exports.sessionSearchRequestSchema = zod_1.z.object({
    query: zod_1.z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS)
        .refine(query => !query.includes('\0'), { message: 'search query must not contain NUL' }),
});
/** One session.search result. */
exports.sessionSearchItemSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    snippet: zod_1.z.string().refine(snippet => (0, session_search_1.truncateUnicodeCodePoints)(snippet, session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS) === snippet, { message: `search snippet must contain at most ${session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS} Unicode code points` }),
});
/** session.search response value. */
exports.sessionSearchValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSearchItemSchema).max(session_search_1.SESSION_SEARCH_RESULT_LIMIT),
    hasMore: zod_1.z.boolean(),
});
/** session.create request payload (at most one of workspaceId / cwd). */
exports.sessionCreateRequestSchema = zod_1.z.object({
    workspaceId: exports.workspaceIdSchema.optional(),
    cwd: zod_1.z.string().optional(),
    sessionId: exports.sessionIdSchema.optional(),
    agentPreset: zod_1.z.string().optional(),
}).refine(payload => payload.workspaceId === undefined || payload.cwd === undefined, { message: 'session.create accepts workspaceId or cwd, not both' });
/** session.create response value. */
exports.sessionCreateValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    agentPreset: zod_1.z.string().optional(),
});
/** session.rename request payload (raw title; host-side normalization decides acceptance). */
exports.sessionRenameRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    title: zod_1.z.string(),
});
/** session.rename response value (the normalized accepted title and its event seq). */
exports.sessionRenameValueSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    seq: zod_1.z.number().int().nonnegative(),
});
/** session.fork request payload (atSeq anchors the completed-turn cut). */
exports.sessionForkRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    atSeq: zod_1.z.number().int().nonnegative().optional(),
    beforeUserSeq: zod_1.z.number().int().nonnegative().optional(),
});
/** session.fork response value (the child session id). */
exports.sessionForkValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.history request payload (beforeSeq/maxMessages page backwards from the window tail). */
exports.sessionHistoryRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    beforeSeq: zod_1.z.number().int().nonnegative().optional(),
    maxMessages: zod_1.z.number().int().positive().optional(),
});
/** Complete provider/model selection. */
// Production model capacity metadata is preserved rather than stripped.
exports.modelSelectionSchema = zod_1.z.object({
    contextWindowTokens: zod_1.z.number().int().positive().optional(),
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** One adapter-owned reasoning effort. */
exports.modelReasoningEffortSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
});
/** Exact-model reasoning metadata. */
exports.modelReasoningSchema = zod_1.z.object({
    efforts: zod_1.z.array(exports.modelReasoningEffortSchema).min(1),
    defaultEffort: zod_1.z.string().min(1).optional(),
});
/** One advisory model entry inside a provider group. */
exports.modelCatalogModelSchema = zod_1.z.object({
    reasoningCapability: zod_1.z.unknown().optional(),
    contextWindow: zod_1.z.number().int().positive().optional(),
    contextWindowSource: zod_1.z.string().optional(),
    contextWindowCapability: zod_1.z.unknown().optional(),
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    reasoning: exports.modelReasoningSchema.optional(),
});
/** One successfully loaded provider group. */
exports.modelProviderGroupSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    models: zod_1.z.array(exports.modelCatalogModelSchema),
});
/** One provider-local catalog failure. */
exports.modelCatalogFailureSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    message: zod_1.z.string(),
});
/**
 * ToolEventView passthrough: lock only the `for` discriminant and the presence
 * of a card-tagged `view` object. The view interior is a host-computed product
 * the client reads without echoing back; deep-validating it would hand-copy
 * the dsh-tools vocabulary into this schema and drift with it.
 */
exports.toolEventViewSchema = zod_1.z.discriminatedUnion('for', [
    zod_1.z.object({ for: zod_1.z.literal('call'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('result'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('compaction'), view: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()) }),
]);
/** One session.history item: the session event plus its optional host-computed tool view. */
exports.historyEntrySchema = zod_1.z.object({
    event: exports.sessionEventSchema,
    view: exports.toolEventViewSchema.optional(),
});
/**
 * Projection baseline passthrough: `values` stays a wide record — each value
 * was already parsed by its provider's own schema on the host side, and
 * deep-validating here would import every domain's schema into the carrier.
 */
exports.sessionProjectionsBlockSchema = zod_1.z.object({
    // -1 = empty log (the lastSeq convention of session/subscribed).
    asOfSeq: zod_1.z.number().int().min(-1),
    values: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
});
/** Host-side validation for the persisted Session-list projection. */
exports.sessionListMetadataProjectionSchema = zod_1.z.object({
    blank: zod_1.z.boolean(),
    lastPromptAt: zod_1.z.number().nullable(),
});
/**
 * imageLimits projection unit schema (host-side view validation). zod widens
 * `readonly ImageMediaType[]` to `string[]`; on the JSON wire the two
 * serialize identically, so the cast records exactly that widening.
 */
exports.imageLimitsProjectionSchema = zod_1.z.object({
    maxImageBytes: zod_1.z.number().int().positive(),
    maxImagesPerMessage: zod_1.z.number().int().positive(),
    maxMessageImageBytes: zod_1.z.number().int().positive(),
    maxImagePixels: zod_1.z.number().int().positive(),
    maxImageDimension: zod_1.z.number().int().positive(),
    mediaTypes: zod_1.z.array(zod_1.z.string()),
});
/** session.history response value (projections rides the tail page only). */
exports.sessionHistoryValueSchema = zod_1.z.object({
    events: zod_1.z.array(exports.historyEntrySchema),
    hasMore: zod_1.z.boolean(),
    projections: exports.sessionProjectionsBlockSchema.optional(),
});
/** session.models request payload. */
exports.sessionModelsRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.models response value. */
exports.sessionModelsValueSchema = zod_1.z.object({
    current: exports.modelSelectionSchema,
    routable: zod_1.z.boolean(),
    groups: zod_1.z.array(exports.modelProviderGroupSchema),
    failures: zod_1.z.array(exports.modelCatalogFailureSchema),
});
/** session.selectModel request payload. */
exports.sessionSelectModelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** session.selectModel response value. */
exports.sessionSelectModelValueSchema = zod_1.z.object({
    selected: exports.modelSelectionSchema,
});
/** ContentBlock passthrough: core is merge-extensible — the type discriminant envelope is strict, the rest stays wide. */
exports.contentBlockSchema = zod_1.z.looseObject({ type: zod_1.z.string() });
/** Raster image media types accepted by the version-one browser wire. */
exports.imageMediaTypeSchema = zod_1.z.union([
    zod_1.z.literal('image/png'),
    zod_1.z.literal('image/jpeg'),
    zod_1.z.literal('image/webp'),
    zod_1.z.literal('image/gif'),
]);
/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
// Production xharness-edit-reference-wire/v1 and durable attachments boundary.
exports.promptContentPartSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('image_ref'), attachmentId: zod_1.z.string().min(1) }),
    zod_1.z.object({ type: zod_1.z.literal('file_ref'), attachmentId: zod_1.z.string().min(1), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('text'), text: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('image'), mediaType: exports.imageMediaTypeSchema, data: zod_1.z.string(), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('file'), mediaType: zod_1.z.string(), data: zod_1.z.string(), name: zod_1.z.string().optional() }),
]);
/** session.prompt request payload, including optional browser-local request provenance. */
exports.sessionPromptRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    mode: zod_1.z.union([zod_1.z.literal('queue'), zod_1.z.literal('steer')]),
    content: zod_1.z.array(exports.promptContentPartSchema),
    requireIdle: zod_1.z.boolean().optional(),
    clientTimeZone: zod_1.z.string().optional(),
});
/** session.prompt response value (the command slot appears only when the prompt dispatched a slash command). */
exports.sessionPromptValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
    command: zod_1.z.object({
        kind: zod_1.z.literal('success'),
        text: zod_1.z.string().optional(),
    }).optional(),
});
/** Opaque attachment id after string-shape validation. */
exports.attachmentIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** Durable image reference returned from the authenticated session lookup. */
exports.imageAttachmentRefSchema = zod_1.z.object({
    attachmentId: exports.attachmentIdSchema,
    mediaType: zod_1.z.string(),
    bytes: zod_1.z.number().int().nonnegative(),
    width: zod_1.z.number().int().positive().nullish(),
    height: zod_1.z.number().int().positive().nullish(),
    name: zod_1.z.string().optional(),
});
/** session.attachment request payload. */
exports.sessionAttachmentRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    attachmentId: exports.attachmentIdSchema,
});
/** session.attachment response value. */
exports.sessionAttachmentValueSchema = zod_1.z.object({
    attachment: exports.imageAttachmentRefSchema,
    data: zod_1.z.string(),
});
/** session.updateQueue request payload. */
exports.sessionUpdateQueueRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    itemId: exports.messageIdSchema,
    action: zod_1.z.discriminatedUnion('kind', [
        zod_1.z.object({ kind: zod_1.z.literal('edit'), content: zod_1.z.array(exports.contentBlockSchema) }),
        zod_1.z.object({ kind: zod_1.z.literal('remove') }),
        zod_1.z.object({ kind: zod_1.z.literal('steer') }),
    ]),
});
/** session.updateQueue response value. */
exports.sessionUpdateQueueValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
/** session.cancel request payload. */
exports.sessionCancelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.cancel response value. */
exports.sessionCancelValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
exports.sessionDeleteRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
exports.sessionDeleteValueSchema = zod_1.z.object({
    deleted: zod_1.z.boolean(),
    deletedSessionIds: zod_1.z.array(exports.sessionIdSchema).optional(),
});
/** External tools are history text only; this request never submits a prompt. */
exports.sessionImportRequestSchema = zod_1.z.object({
    source: zod_1.z.enum(['claude-code', 'codex']), jsonl: zod_1.z.string().max(8 * 1024 * 1024),
    preview: zod_1.z.boolean(), cwd: zod_1.z.string().optional(), workspaceId: exports.workspaceIdSchema.optional(),
}).strict().refine(p => p.cwd === undefined || p.workspaceId === undefined);
exports.sessionImportValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema.optional(), title: zod_1.z.string(), messages: zod_1.z.number().int().nonnegative(),
    tools: zod_1.z.number().int().nonnegative(), warnings: zod_1.z.array(zod_1.z.string()),
    preview: zod_1.z.array(zod_1.z.object({ role: zod_1.z.string(), content: zod_1.z.string() })),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/session-search.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = exports.SESSION_SEARCH_RESULT_LIMIT = void 0;
exports.truncateUnicodeCodePoints = truncateUnicodeCodePoints;
/** Maximum number of sessions returned by one sidebar search. */
exports.SESSION_SEARCH_RESULT_LIMIT = 20;
/** Maximum snippet length in Unicode code points. */
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - text to bound.
 * @param maximum - non-negative code-point limit.
 * @returns `value` unchanged when it fits, otherwise a code-point-safe prefix.
 */
function truncateUnicodeCodePoints(value, maximum) {
    let count = 0;
    let end = 0;
    for (const codePoint of value) {
        if (count === maximum)
            return value.slice(0, end);
        count++;
        end += codePoint.length;
    }
    return value;
}

},
"src/modules/trajectory/trajectory-tool-definition.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-tool-definition.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrajectoryToolDefinition = registerTrajectoryToolDefinition;
const wire_event_codec_1 = require("./wire-event-codec");
const trajectory_definition_common_1 = require("./trajectory-definition-common");
/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
const MAX_DEPTH = 256;
function rootCall(match) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'tool/call')) {
        throw new Error('trajectory-tool-call start requires tool/call');
    }
    return {
        callId: String(match.event.data.callId),
        name: match.event.data.name,
        argsRaw: match.event.data.arguments,
        turn: match.event.data.turn,
        step: match.event.data.step,
        time: match.event.time,
        callView: match.view?.for === 'call' ? match.view.view : null,
        subCalls: [],
    };
}
function rootResult(match, previous) {
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'tool/result'))
        return undefined;
    const result = match.event.data.message.content[0];
    return {
        kind: 'tool-result',
        seq: match.event.seq,
        time: match.event.time,
        callId: String(match.event.data.message.source.callId),
        call: previous === undefined ? null : { name: previous.name, argsRaw: previous.argsRaw },
        callTime: previous?.time ?? null,
        content: result.content,
        isError: result.isError === true,
        ...(match.event.data.error === undefined ? {} : { error: match.event.data.error }),
        meta: match.event.data.meta,
        callView: previous?.callView ?? null,
        resultView: match.view?.for === 'result' ? match.view.view : null,
        subCalls: [],
    };
}
function locationTurn(match) {
    return match.location.kind === 'step' || match.location.kind === 'turn'
        ? match.location.turn.turn
        : 0;
}
function locationStep(match) {
    return match.location.kind === 'step' ? match.location.step.step : 0;
}
function childCall(match, data) {
    return {
        callId: data.subCallId,
        name: data.name,
        argsRaw: JSON.stringify(data.arguments),
        turn: locationTurn(match),
        step: locationStep(match),
        time: match.event.time,
        callView: null,
        subCalls: [],
    };
}
function childResult(match, data, previous) {
    return {
        kind: 'tool-result',
        seq: match.event.seq,
        time: match.event.time,
        callId: data.subCallId,
        call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
        callTime: previous === undefined || 'kind' in previous ? null : previous.time,
        content: data.content ?? [],
        isError: data.isError === true,
        callView: null,
        resultView: null,
        subCalls: [],
    };
}
function acceptsEdge(state, parent, child) {
    if (parent === child || state.parents.has(child))
        return false;
    let cursor = parent;
    let parentDepth = 0;
    const ancestors = new Set();
    while (cursor !== undefined) {
        if (cursor === child || ancestors.has(cursor))
            return false;
        ancestors.add(cursor);
        parentDepth++;
        cursor = state.parents.get(cursor);
    }
    const pending = [{ callId: child, depth: 1 }];
    const descendants = new Set();
    let subtreeDepth = 0;
    for (const candidate of pending) {
        if (descendants.has(candidate.callId))
            return false;
        descendants.add(candidate.callId);
        subtreeDepth = Math.max(subtreeDepth, candidate.depth);
        for (const nested of state.children.get(candidate.callId) ?? []) {
            pending.push({ callId: nested, depth: candidate.depth + 1 });
        }
    }
    return parentDepth + subtreeDepth <= MAX_DEPTH;
}
function updateDispatch(state, match) {
    const event = match.event;
    if (!(0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch-start') && !(0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch'))
        return state;
    const data = event.data;
    const parentId = String(data.parentCallId);
    const childId = String(data.subCallId);
    const siblings = state.children.get(parentId) ?? [];
    const index = siblings.indexOf(childId);
    if (index < 0 && !acceptsEdge(state, parentId, childId))
        return state;
    if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch-start') && index >= 0)
        return state;
    const calls = new Map(state.calls);
    calls.set(childId, (0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch-start')
        ? childCall(match, data)
        : childResult(match, data, calls.get(childId)));
    if (index >= 0)
        return { ...state, calls };
    const children = new Map(state.children);
    children.set(parentId, [...siblings, childId]);
    const parents = new Map(state.parents);
    parents.set(childId, parentId);
    return { ...state, calls, children, parents };
}
function interruption(context) {
    const location = context.start?.location;
    if (location?.kind === 'step' && location.step.status === 'closed')
        return location.step.end;
    if ((location?.kind === 'step' || location?.kind === 'turn')
        && location.turn.status === 'closed')
        return location.turn.end;
    return undefined;
}
function projectCall(state, callId, interruptedAt, visited = new Set(), depth = 1) {
    const block = state.calls.get(callId);
    if (block === undefined)
        return undefined;
    if (visited.has(callId) || depth > MAX_DEPTH)
        return { ...block, subCalls: [] };
    const nextVisited = new Set(visited);
    nextVisited.add(callId);
    const subCalls = (state.children.get(callId) ?? [])
        .flatMap((childId) => {
        const child = projectCall(state, childId, interruptedAt, nextVisited, depth + 1);
        return child === undefined ? [] : [child];
    });
    if ('kind' in block || interruptedAt === undefined)
        return { ...block, subCalls };
    return {
        kind: 'tool-result',
        seq: interruptedAt.seq - 0.8,
        time: interruptedAt.time,
        callId: block.callId,
        call: { name: block.name, argsRaw: block.argsRaw },
        callTime: block.time,
        content: [],
        isError: true,
        error: { name: 'Interrupted', code: 'interrupted' },
        callView: block.callView,
        resultView: null,
        subCalls,
    };
}
function fallbackState(context) {
    const resultMatch = context.matches.find(match => (0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'tool/result'));
    const root = resultMatch === undefined ? undefined : rootResult(resultMatch);
    if (root === undefined)
        return undefined;
    let state = {
        rootId: root.callId,
        calls: new Map([[root.callId, root]]),
        children: new Map(),
        parents: new Map(),
    };
    for (const match of context.matches)
        state = updateDispatch(state, match);
    return state;
}
/** Trajectory-owned root Tool lifecycle with nested Code Dispatch calls. */
const trajectoryToolDefinition = {
    kind: 'trajectory-tool-call',
    target: 'trajectory',
    match: (event) => {
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/call'))
            return { id: String(event.data.callId), role: 'start' };
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/result')) {
            return { id: String(event.data.message.source.callId), role: 'update' };
        }
        if ((0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch-start') || (0, wire_event_codec_1.isTrajectoryEvent)(event, 'tool/code-dispatch')) {
            const rootCallId = event.data.rootCallId;
            return typeof rootCallId === 'string' && rootCallId !== ''
                ? { id: rootCallId, role: 'update' }
                : null;
        }
        return null;
    },
    start: (_context, match) => {
        const root = rootCall(match);
        return {
            rootId: root.callId,
            calls: new Map([[root.callId, root]]),
            children: new Map(),
            parents: new Map(),
        };
    },
    update: (context, match) => {
        if (!(0, wire_event_codec_1.isTrajectoryEvent)(match.event, 'tool/result'))
            return updateDispatch(context.state, match);
        const previous = context.state.calls.get(context.state.rootId);
        const running = previous !== undefined && !('kind' in previous) ? previous : undefined;
        const result = rootResult(match, running);
        if (result === undefined)
            return context.state;
        const calls = new Map(context.state.calls);
        calls.set(context.state.rootId, result);
        return { ...context.state, calls };
    },
    buildViewNode: (context) => {
        const state = context.state ?? fallbackState(context);
        if (state === undefined)
            return null;
        const root = projectCall(state, state.rootId, interruption(context));
        if (root === undefined)
            return null;
        const anchorSeq = context.start?.event.seq
            ?? ('kind' in root ? root.seq : context.matches[0]?.event.seq ?? 0);
        return (0, trajectory_definition_common_1.trajectoryNode)(context, anchorSeq, { kind: 'tool', root });
    },
};
/* jscpd:ignore-end */
/**
 * Register the Trajectory Tool lifecycle.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
function registerTrajectoryToolDefinition(ctx) {
    ctx.conversationEvents.register(trajectoryToolDefinition);
}

},
"src/modules/trajectory/TrajectoryView.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryView = TrajectoryView;
const jsx_runtime_1 = require("react/jsx-runtime");
const snapshot_codec_1 = require("./snapshot-codec");
const usage_value_1 = require("./usage-value");
/** Trajectory view: compact summary over a turn-aware event ledger. */
const react_1 = require("react");
const TrajectoryTable_1 = require("./TrajectoryTable");
const TrajectoryToolbar_1 = require("./TrajectoryToolbar");
const TrajectoryTimeline_1 = require("./TrajectoryTimeline");
const layout_1 = require("./layout");
const timeline_1 = require("./timeline");
const trajectory_record_1 = require("./trajectory-record");
const trajectory_search_index_1 = require("./trajectory-search-index");
const trajectory_snapshot_builder_1 = require("./trajectory-snapshot-builder");
const views_styles_1 = __importDefault(require("./views.styles"));
const EMPTY_TURN_IDS = new Set();
const EMPTY_RECORD_IDS = new Set();
const SEARCH_INDEX_THROTTLE_MS = 3000;
function lastCellIndex(turns) {
    let last = 0;
    for (const turn of turns) {
        for (const group of turn.groups) {
            for (const cell of group.cells)
                last = Math.max(last, cell.index);
        }
    }
    return last;
}
function timelineBlock(block) {
    switch (block.kind) {
        case 'text': return { kind: 'text', text: '' };
        case 'reasoning': return { kind: 'reasoning', text: '' };
        case 'image': return block;
        case 'tool-call': return {
            kind: 'tool-call',
            callId: block.callId,
            name: block.name,
            argsRaw: '',
        };
        case 'other': return { kind: 'other', block: null };
    }
}
function partialStructureSignature(partial) {
    if (partial === null)
        return '';
    return partial.blocks.map(block => block.kind === 'tool-call'
        ? `${block.kind}:${block.callId}:${block.name}`
        : block.kind).join('\u0000');
}
function requestUsage(value) {
    const usage = (0, usage_value_1.usageValue)(value);
    if (usage === undefined)
        return undefined;
    return {
        ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
        ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
        ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
        ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    };
}
function addUsage(total, usage) {
    if (usage === undefined)
        return total;
    return {
        ...(total?.input === undefined && usage.input === undefined
            ? {}
            : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
        ...(total?.cacheRead === undefined && usage.cacheRead === undefined
            ? {}
            : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
        ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
            ? {}
            : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
        ...(total?.output === undefined && usage.output === undefined
            ? {}
            : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
        ...(total?.reasoning === undefined && usage.reasoning === undefined
            ? {}
            : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
    };
}
function TrajectoryView({ useSession, useDuration, loadOlder, setActualDuration, inspect, onInspectDone, t, }) {
    const [collapsedTurns, setCollapsedTurns] = (0, react_1.useState)(EMPTY_TURN_IDS);
    const [collapsedAssistants, setCollapsedAssistants] = (0, react_1.useState)(EMPTY_RECORD_IDS);
    const [timelineSelection, setTimelineSelection] = (0, react_1.useState)(null);
    const actualDuration = useDuration(value => value);
    const [actualTime, setActualTime] = (0, react_1.useState)(false);
    const [searchQuery, setSearchQuery] = (0, react_1.useState)('');
    const [searchIndex] = (0, react_1.useState)(() => new trajectory_search_index_1.TrajectorySearchIndex());
    const [searchIndexRevision, setSearchIndexRevision] = (0, react_1.useState)(0);
    const searchIndexTimer = (0, react_1.useRef)(null);
    const searchIndexInitialized = (0, react_1.useRef)(false);
    const [selectedTimelineIndex, setSelectedTimelineIndex] = (0, react_1.useState)(null);
    const [timelineRecordSelection, setTimelineRecordSelection] = (0, react_1.useState)(null);
    const [timelineRecordFocus, setTimelineRecordFocus] = (0, react_1.useState)(null);
    const inspection = useSession(snapshot => {
        const value = snapshot.views.get('trajectory');
        if (value == null)
            return trajectory_snapshot_builder_1.EMPTY_TRAJECTORY_SNAPSHOT;
        if (!(0, snapshot_codec_1.isTrajectorySnapshot)(value))
            throw new TypeError('Invalid trajectory view snapshot');
        return value;
    });
    const historyLoading = useSession(snapshot => snapshot.openState === 'loading');
    const olderHistoryLoading = useSession(snapshot => snapshot.loadingOlder);
    const hasOlderHistory = useSession(snapshot => snapshot.hasMore);
    const nodes = inspection.eventNodes;
    const eventLocations = inspection.eventLocations;
    const historyBaseSeq = nodes[0]?.seq ?? 0;
    const partial = inspection.partial;
    const runningCalls = inspection.runningCalls;
    const requests = inspection.requests;
    const callSchemas = inspection.callSchemas;
    const requestNumbers = (0, react_1.useMemo)(() => {
        const assistantsByStep = new Map();
        for (const node of nodes) {
            if (node.kind !== 'assistant' || node.step <= 0)
                continue;
            assistantsByStep.set(`${node.turn}\u0000${node.step}`, node);
        }
        const requestsByStep = new Map(requests
            .filter(request => request.purpose === 'assistant')
            .map(request => [
            `${request.turn}\u0000${request.step}`,
            request,
        ]));
        const orderedRequests = [
            ...requests.map(request => ({
                seq: request.startSeq,
                request,
                node: request.purpose === 'assistant'
                    ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
                    : undefined,
            })),
            ...[...assistantsByStep.entries()].flatMap(([key, node]) => requestsByStep.has(key)
                ? []
                : [{
                        seq: node.seq,
                        request: undefined,
                        node,
                    }]),
        ].sort((left, right) => left.seq - right.seq);
        const numbered = [];
        let cumulativeUsage;
        for (const [index, entry] of orderedRequests.entries()) {
            const usage = requestUsage(entry.request?.usage ?? entry.node?.usage);
            cumulativeUsage = addUsage(cumulativeUsage, usage);
            if (entry.request?.purpose !== 'compaction') {
                const request = entry.request;
                const node = entry.node;
                const turn = request?.turn ?? node?.turn;
                const step = request?.step ?? node?.step;
                if (turn === undefined || step === undefined)
                    continue;
                const provider = request?.provenance?.provider ?? node?.provenance?.provider;
                const model = request?.provenance?.model ?? node?.provenance?.model;
                const requestConfig = request?.requestConfig ?? node?.requestConfig;
                numbered.push({
                    seq: entry.seq,
                    turn,
                    step,
                    group: `Step ${step}`,
                    number: index + 1,
                    ...(request?.status === undefined ? {} : { status: request.status }),
                    ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
                    ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
                    ...(request?.error === undefined ? {} : { error: request.error }),
                    ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
                    ...(request?.retry === undefined ? {} : { retry: request.retry }),
                    ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
                    ...(request?.retryDelayMs === undefined
                        ? {}
                        : { retryDelayMs: request.retryDelayMs }),
                    ...(provider === undefined ? {} : { provider }),
                    ...(model === undefined ? {} : { model }),
                    ...(requestConfig === undefined ? {} : { requestConfig }),
                    ...(usage === undefined ? {} : { usage }),
                    ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
                });
                continue;
            }
            const request = entry.request;
            numbered.push({
                seq: request.startSeq,
                turn: request.turn,
                step: 0,
                group: `Compaction ${request.startSeq}`,
                number: index + 1,
                purpose: 'compaction',
                status: request.status,
                startedAt: request.startedAt,
                completedAt: request.completedAt,
                ...(request.error === undefined ? {} : { error: request.error }),
                resultSeq: request.startSeq,
                ...(request.provenance?.provider === undefined
                    ? {}
                    : { provider: request.provenance.provider }),
                ...(request.provenance?.model === undefined
                    ? {}
                    : { model: request.provenance.model }),
                ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
                ...(usage === undefined ? {} : { usage }),
                ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
            });
        }
        return numbered;
    }, [
        nodes, requests,
    ]);
    const partialTurn = partial?.turn ?? null;
    const partialStep = partial?.step ?? null;
    const finalized = (0, react_1.useMemo)(() => {
        const turns = (0, layout_1.deriveTrajectoryLayout)({
            nodes,
            eventLocations,
            partial: partialTurn === null || partialStep === null
                ? null
                : { turn: partialTurn, step: partialStep, blocks: [] },
            runningCalls,
            requests,
            callSchemas,
        });
        return { turns, lastIndex: lastCellIndex(turns) };
    }, [
        nodes, eventLocations, partialTurn, partialStep,
        runningCalls, requests, callSchemas,
    ]);
    const timelinePartialSignature = partialStructureSignature(partial);
    const timelinePartial = (0, react_1.useMemo)(() => partial === null
        ? null
        : {
            turn: partial.turn,
            step: partial.step,
            blocks: partial.blocks.map(block => timelineBlock(block)),
        }, [partialStep, partialTurn, timelinePartialSignature]);
    const timelineTurns = (0, react_1.useMemo)(() => (0, layout_1.appendTrajectoryPartialLayout)(finalized.turns, timelinePartial, finalized.lastIndex), [finalized, timelinePartial]);
    const timelineMode = actualDuration
        ? actualTime ? 'actual' : 'duration'
        : actualTime ? 'time' : 'sequence';
    const partialSearchTurns = (0, react_1.useMemo)(() => (0, layout_1.appendTrajectoryPartialLayout)([], partial, finalized.lastIndex), [finalized.lastIndex, partial]);
    const searchLayouts = (0, react_1.useMemo)(() => [finalized.turns, partialSearchTurns], [finalized, partialSearchTurns]);
    const latestSearchLayouts = (0, react_1.useRef)(searchLayouts);
    latestSearchLayouts.current = searchLayouts;
    (0, react_1.useEffect)(() => {
        if (!searchIndexInitialized.current) {
            searchIndexInitialized.current = true;
            if (searchIndex.update(searchLayouts)) {
                setSearchIndexRevision(revision => revision + 1);
            }
            return;
        }
        if (searchIndexTimer.current !== null)
            return;
        searchIndexTimer.current = setTimeout(() => {
            searchIndexTimer.current = null;
            if (searchIndex.update(latestSearchLayouts.current)) {
                setSearchIndexRevision(revision => revision + 1);
            }
        }, SEARCH_INDEX_THROTTLE_MS);
    }, [searchIndex, searchLayouts]);
    (0, react_1.useEffect)(() => () => {
        if (searchIndexTimer.current !== null)
            clearTimeout(searchIndexTimer.current);
    }, []);
    const streamingCells = (0, react_1.useMemo)(() => partialSearchTurns.flatMap(turn => turn.groups.flatMap(group => group.cells)), [partialSearchTurns]);
    const searchMatchRecordIds = (0, react_1.useMemo)(() => searchIndex.search(searchQuery), [searchIndex, searchIndexRevision, searchQuery]);
    const searchMatchIndexes = (0, react_1.useMemo)(() => {
        if (searchMatchRecordIds === null)
            return null;
        const indexes = new Set();
        for (const turns of searchLayouts) {
            for (const turn of turns) {
                for (const group of turn.groups) {
                    for (const cell of group.cells) {
                        if (searchMatchRecordIds.has((0, trajectory_record_1.trajectoryRecordId)(cell)))
                            indexes.add(cell.index);
                    }
                }
            }
        }
        return indexes;
    }, [searchLayouts, searchMatchRecordIds]);
    const timelineRange = timelineSelection;
    const timelineFocusIndexes = (0, react_1.useMemo)(() => timelineRange === null
        ? null
        : (0, timeline_1.trajectoryTimelineFocusIndexes)(timelineTurns, timelineRange, timelineMode), [timelineMode, timelineRange, timelineTurns]);
    const handleRecordSelect = (0, react_1.useCallback)((index) => {
        if (timelineFocusIndexes !== null
            && !timelineFocusIndexes.has(index)) {
            setTimelineSelection(null);
        }
    }, [timelineFocusIndexes]);
    const handleTimelineRangeChange = (0, react_1.useCallback)((range) => {
        setTimelineSelection(range);
    }, []);
    const handleTimelineRecordSelect = (0, react_1.useCallback)((index) => {
        setTimelineSelection(null);
        setTimelineRecordSelection({ index });
        setSelectedTimelineIndex(index);
    }, []);
    const handleTimelineRecordFocus = (0, react_1.useCallback)((index) => {
        setTimelineRecordFocus({ index });
    }, []);
    const collapsibleTurnIds = (0, react_1.useMemo)(() => timelineTurns
        .filter(turn => turn.turn !== null
        &&
            turn.groups.reduce((count, group) => count + group.cells.filter(cell => cell.requestOnly !== true && cell.kind !== 'system').length, 0) > 1)
        .flatMap(turn => turn.turn === null ? [] : [turn.turn]), [timelineTurns]);
    const allTurnsCollapsed = collapsibleTurnIds.length > 0
        && collapsibleTurnIds.every(turn => collapsedTurns.has(turn));
    const collapsibleAssistantIds = (0, react_1.useMemo)(() => {
        const ids = [];
        for (const turn of timelineTurns) {
            const cells = turn.groups.flatMap(group => group.cells);
            for (let i = 0; i < cells.length; i++) {
                const cell = cells[i];
                if (cell?.kind !== 'message')
                    continue;
                const next = cells[i + 1];
                if (next?.kind === 'tool' || next?.kind === 'subtool') {
                    ids.push((0, trajectory_record_1.trajectoryRecordId)(cell));
                }
            }
        }
        return ids;
    }, [timelineTurns]);
    const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
        && collapsibleAssistantIds.every(index => collapsedAssistants.has(index));
    const toggleTurn = (turn) => {
        setCollapsedTurns((current) => {
            const collapsed = new Set(current);
            if (collapsed.has(turn))
                collapsed.delete(turn);
            else
                collapsed.add(turn);
            return collapsed;
        });
    };
    const toggleAllTurns = () => {
        setCollapsedTurns((current) => {
            const collapsed = new Set(current);
            if (allTurnsCollapsed) {
                for (const turn of collapsibleTurnIds)
                    collapsed.delete(turn);
            }
            else {
                for (const turn of collapsibleTurnIds)
                    collapsed.add(turn);
            }
            return collapsed;
        });
    };
    const toggleAssistant = (id) => {
        setCollapsedAssistants((current) => {
            const collapsed = new Set(current);
            if (collapsed.has(id))
                collapsed.delete(id);
            else
                collapsed.add(id);
            return collapsed;
        });
    };
    const toggleAllAssistants = () => {
        setCollapsedAssistants((current) => {
            const collapsed = new Set(current);
            if (allAssistantsCollapsed) {
                for (const index of collapsibleAssistantIds)
                    collapsed.delete(index);
            }
            else {
                for (const index of collapsibleAssistantIds)
                    collapsed.add(index);
            }
            return collapsed;
        });
    };
    const loadEarlierHistory = (0, react_1.useCallback)(() => {
        return loadOlder();
    }, [loadOlder]);
    return ((0, jsx_runtime_1.jsxs)("div", { className: views_styles_1.default.root, "data-conversation-composer-overlay": "", children: [(0, jsx_runtime_1.jsx)(TrajectoryToolbar_1.TrajectoryToolbar, { actualDuration: actualDuration, onActualDurationChange: (nextActualDuration) => {
                    setActualDuration(nextActualDuration);
                    setTimelineSelection(null);
                }, actualTime: actualTime, onActualTimeChange: (nextActualTime) => {
                    setActualTime(nextActualTime);
                    setTimelineSelection(null);
                }, allTurnsCollapsed: allTurnsCollapsed, onToggleAllTurns: toggleAllTurns, allAssistantsCollapsed: allAssistantsCollapsed, onToggleAllAssistants: toggleAllAssistants, searchQuery: searchQuery, onSearchQueryChange: setSearchQuery, t: t }), (0, jsx_runtime_1.jsx)(TrajectoryTimeline_1.TrajectoryTimeline, { turns: timelineTurns, mode: timelineMode, range: timelineRange, hasEarlierRecords: hasOlderHistory, onLoadEarlier: loadEarlierHistory, selectedIndex: selectedTimelineIndex, searchMatchIndexes: searchMatchIndexes, onRangeChange: handleTimelineRangeChange, onRecordSelect: handleTimelineRecordSelect, onRecordFocus: handleTimelineRecordFocus }), (0, jsx_runtime_1.jsx)("div", { className: views_styles_1.default.ledger, children: (0, jsx_runtime_1.jsx)(TrajectoryTable_1.TrajectoryTable, { requestNumbers: requestNumbers, turns: timelineTurns, streamingCells: streamingCells, timelineFocusIndexes: timelineFocusIndexes, searchMatchIndexes: searchMatchIndexes, onSelectedIndexChange: setSelectedTimelineIndex, onRecordSelect: handleRecordSelect, recordSelection: timelineRecordSelection, recordFocus: timelineRecordFocus, historyLoading: historyLoading, olderHistoryLoading: olderHistoryLoading, historyStartSeq: historyBaseSeq, hasOlderRecords: hasOlderHistory, onLoadOlder: loadEarlierHistory, onClearSelection: () => { setTimelineSelection(null); }, collapsedTurns: collapsedTurns, onToggleTurn: toggleTurn, collapsedAssistants: collapsedAssistants, onToggleAssistant: toggleAssistant, inspectCallId: inspect?.callId ?? null, onInspectApplied: onInspectDone }) })] }));
}

},
"src/modules/trajectory/usage-value.js": function(module, exports, require) {
// source: src/modules/trajectory/usage-value.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usageValue = usageValue;
const runtime_types_1 = require("../shared/runtime-types");
function usageValue(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value))
        return undefined;
    return {
        ...(typeof value.inputTokens !== 'number' ? {} : { inputTokens: value.inputTokens }),
        ...(typeof value.outputTokens !== 'number' ? {} : { outputTokens: value.outputTokens }),
        ...(typeof value.cacheReadTokens !== 'number' ? {} : { cacheReadTokens: value.cacheReadTokens }),
        ...(typeof value.cacheWriteTokens !== 'number' ? {} : { cacheWriteTokens: value.cacheWriteTokens }),
        ...(typeof value.reasoningTokens !== 'number' ? {} : { reasoningTokens: value.reasoningTokens }),
    };
}

},
"src/modules/trajectory/TrajectoryTable.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTable.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryTable = TrajectoryTable;
const jsx_runtime_1 = require("react/jsx-runtime");
const runtime_types_1 = require("../shared/runtime-types");
/** Turn-aware trajectory event ledger with a local record inspector. */
const react_1 = require("react");
const index_1 = require("./vendor/react-virtual/src/index");
const primitives_1 = require("./primitives");
const create_1 = require("./vendor/diff/src/patch/create");
const trajectory_record_1 = require("./trajectory-record");
const trajectory_virtual_rows_1 = require("./trajectory-virtual-rows");
const trajectory_preview_1 = require("./trajectory-preview");
const TrajectoryTable_styles_1 = __importDefault(require("./TrajectoryTable.styles"));
const BOTTOM_FOLLOW_THRESHOLD_PX = 2;
const OLDER_LOAD_THRESHOLD_PX = 48;
const HISTORY_LOAD_ROW_HEIGHT_PX = 30;
const VIRTUALIZATION_THRESHOLD = 100;
const VIRTUAL_OVERSCAN_ROWS = 12;
const VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600;
const KIND_LABEL = {
    system: 'SYSTEM',
    user: 'USER',
    context: 'CONTEXT',
    compacted: 'COMPACTED',
    message: 'ASSISTANT',
    tool: 'TOOL',
    subtool: 'SUBTOOL',
};
function ToolWrenchIcon() {
    return ((0, jsx_runtime_1.jsx)("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "data-role-icon": "wrench", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" }) }));
}
function InformationIcon() {
    return ((0, jsx_runtime_1.jsxs)("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", "data-role-icon": "information", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { cx: "8", cy: "8", r: "6.7" }), (0, jsx_runtime_1.jsx)("circle", { cx: "8", cy: "5.5", r: ".85", fill: "currentColor", stroke: "none" }), (0, jsx_runtime_1.jsx)("path", { d: "M8 7.75v3.4", strokeWidth: "1.8" })] }));
}
function CompactedIcon() {
    return ((0, jsx_runtime_1.jsxs)("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "data-role-icon": "compacted", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("path", { d: "m2.5 2.5 3.75 3.75M3 6.25h3.25V3" }), (0, jsx_runtime_1.jsx)("path", { d: "m13.5 2.5-3.75 3.75M13 6.25H9.75V3" }), (0, jsx_runtime_1.jsx)("path", { d: "m2.5 13.5 3.75-3.75M3 9.75h3.25V13" }), (0, jsx_runtime_1.jsx)("path", { d: "m13.5 13.5-3.75-3.75M13 9.75H9.75V13" })] }));
}
const KIND_ICON = {
    system: (0, jsx_runtime_1.jsx)(primitives_1.IconSettingsOutline16, { size: 13 }),
    user: (0, jsx_runtime_1.jsx)(primitives_1.IconUserOutline16, { size: 13 }),
    context: (0, jsx_runtime_1.jsx)(InformationIcon, {}),
    compacted: (0, jsx_runtime_1.jsx)(CompactedIcon, {}),
    message: (0, jsx_runtime_1.jsx)(primitives_1.IconSparkle16, { size: 13 }),
    tool: (0, jsx_runtime_1.jsx)(ToolWrenchIcon, {}),
    subtool: (0, jsx_runtime_1.jsx)(ToolWrenchIcon, {}),
};
function useStableVirtualRowStructure(rows) {
    const cache = (0, react_1.useRef)({ rows: [], structure: [] });
    if (cache.current.rows === rows)
        return cache.current.structure;
    const structure = cache.current.structure.length === rows.length
        && rows.every((row, index) => {
            const previous = cache.current.structure[index];
            return previous?.key === row.key && previous.height === row.height;
        })
        ? cache.current.structure
        : rows.map(row => ({ key: row.key, height: row.height }));
    cache.current = { rows, structure };
    return structure;
}
const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;
const TABLE_MIN_WIDTH = 280;
const DETAILS_RESIZE_STEP = 16;
const TOOL_REQUEST_SHARE = 0.58;
const TOOL_REQUEST_MIN_WIDTH = 180;
const TOOL_REQUEST_MAX_WIDTH = 480;
const DEFAULT_TOOL_REQUEST_SHARE = 0.36;
const DEFAULT_TOOL_REQUEST_OFFSET = 56;
const SYSTEM_PROMPT_TABS = [
    { id: 'system-prompt', label: 'System Prompt' },
    { id: 'tools', label: 'Tools' },
];
const SYSTEM_UPDATE_TABS = [
    { id: 'diff', label: 'Diff' },
    ...SYSTEM_PROMPT_TABS,
];
const REQUEST_TABS = [
    { id: 'overview', label: 'Summary' },
    { id: 'options', label: 'Options' },
    { id: 'usage', label: 'Usage' },
    { id: 'timing', label: 'Timing' },
];
function virtualSpacerStyle(style) { return style; }
function clampDetailsWidth(width, splitWidth) {
    const maxWidth = Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH));
    return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth));
}
function defaultToolRequestWidth(splitWidth) {
    return Math.min(Math.max(splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET, TOOL_REQUEST_MIN_WIDTH), TOOL_REQUEST_MAX_WIDTH);
}
function formatDurationMs(milliseconds) {
    if (milliseconds < 1000)
        return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} s`;
}
function formatStartedAt(timestamp) {
    if (timestamp === null || !Number.isFinite(timestamp))
        return 'Not available';
    const date = new Date(timestamp);
    const two = (value) => String(value).padStart(2, '0');
    const three = (value) => String(value).padStart(3, '0');
    const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
    const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    return `${day} ${time}`;
}
/** Whether a click lands on an active text selection and should keep it. */
function clickSelectsText(target) {
    const selection = window.getSelection();
    return selection !== null
        && !selection.isCollapsed
        && selection.rangeCount > 0
        && selection.getRangeAt(0).intersectsNode(target);
}
function StartedAtValue({ timestamp }) {
    const [showUnix, setShowUnix] = (0, react_1.useState)(false);
    if (timestamp === null || !Number.isFinite(timestamp))
        return (0, jsx_runtime_1.jsx)("dd", { children: "Not available" });
    return ((0, jsx_runtime_1.jsx)("dd", { children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: TrajectoryTable_styles_1.default.timestampToggle, title: showUnix ? 'Show local time' : 'Show Unix timestamp', onClick: (event) => {
                if (clickSelectsText(event.currentTarget))
                    return;
                setShowUnix(current => !current);
            }, children: showUnix ? (timestamp / 1000).toFixed(3) : formatStartedAt(timestamp) }) }));
}
function totalTime(metrics) {
    if (!metrics.timingRecorded)
        return 'Not recorded';
    if (metrics.stepStartTime === null)
        return 'Step start unavailable';
    if (metrics.completedTime === null)
        return 'Pending';
    return formatDurationMs(Math.max(0, metrics.completedTime - metrics.stepStartTime));
}
function ttft(metrics) {
    if (!metrics.timingRecorded)
        return 'Not recorded';
    if (metrics.stepStartTime === null)
        return 'Step start unavailable';
    if (metrics.firstTokenTime === null)
        return 'First token unavailable';
    return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime));
}
function generationTime(metrics) {
    if (!metrics.timingRecorded || metrics.firstTokenTime === null)
        return 'First token unavailable';
    if (metrics.completedTime === null)
        return 'Pending';
    return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime));
}
function throughput(metrics) {
    if (!metrics.usageProvided)
        return 'Usage unavailable';
    if (metrics.outputTokens === null)
        return 'Output tokens unavailable';
    if (!metrics.timingRecorded || metrics.firstTokenTime === null)
        return 'First token unavailable';
    if (metrics.completedTime === null)
        return 'Pending';
    const generationSeconds = (metrics.completedTime - metrics.firstTokenTime) / 1000;
    if (generationSeconds <= 0)
        return 'Duration too short';
    return `${(metrics.outputTokens / generationSeconds).toFixed(1)} tok/s`;
}
function AssistantTimingPanel({ metrics }) {
    return ((0, jsx_runtime_1.jsxs)("dl", { className: TrajectoryTable_styles_1.default.overview, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Started" }), (0, jsx_runtime_1.jsx)(StartedAtValue, { timestamp: metrics.stepStartTime })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Total duration" }), (0, jsx_runtime_1.jsx)("dd", { children: totalTime(metrics) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "TTFT" }), (0, jsx_runtime_1.jsx)("dd", { children: ttft(metrics) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Generation" }), (0, jsx_runtime_1.jsx)("dd", { children: generationTime(metrics) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Throughput" }), (0, jsx_runtime_1.jsx)("dd", { children: throughput(metrics) })] })] }));
}
function flattenRecords(turns) {
    return turns.flatMap((turn, section) => {
        let firstInSection = true;
        const records = turn.groups.flatMap((group) => {
            return group.cells.map((cell, index) => {
                const turnStart = firstInSection
                    && cell.requestOnly !== true
                    && cell.kind !== 'system'
                    && (cell.kind !== 'compacted' || turn.turn === null);
                if (turnStart)
                    firstInSection = false;
                return {
                    turn: turn.turn,
                    section,
                    group: group.title,
                    groupStart: index === 0,
                    turnStart,
                    cell,
                    turnEnd: false,
                };
            });
        });
        const last = records.at(-1);
        if (last !== undefined)
            last.turnEnd = true;
        return records;
    });
}
function filterRecords(records, matches) {
    const filtered = records
        .filter(record => record.cell.requestOnly !== true && matches.has(record.cell.index))
        .map(record => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }));
    const startedSections = new Set();
    for (const [index, record] of filtered.entries()) {
        const previous = filtered[index - 1];
        const next = filtered[index + 1];
        record.groupStart = previous === undefined
            || previous.section !== record.section
            || previous.group !== record.group;
        record.turnStart = !startedSections.has(record.section)
            && record.cell.kind !== 'system'
            && (record.cell.kind !== 'compacted' || record.turn === null);
        if (record.turnStart)
            startedSections.add(record.section);
        record.turnEnd = next === undefined || next.section !== record.section;
    }
    return filtered;
}
function requestStep(group) {
    if (!group.startsWith('Step '))
        return undefined;
    const value = Number(group.slice('Step '.length));
    return Number.isInteger(value) && value > 0 ? value : undefined;
}
function requestKey(turn, group) {
    return `${turn}\u0000${group}`;
}
function indexRequestBoundaries(records) {
    const boundaries = new Map();
    for (const record of records) {
        const key = requestKey(record.turn, record.group);
        if (boundaries.has(key))
            continue;
        if (requestStep(record.group) === undefined) {
            if (record.groupStart)
                boundaries.set(key, record.cell.index);
            continue;
        }
        if (record.cell.kind === 'user' || record.cell.kind === 'context')
            continue;
        boundaries.set(key, record.cell.index);
    }
    return boundaries;
}
function sectionLabel(turn) {
    return turn === null ? 'Between turns' : `Turn ${turn}`;
}
function indexRequestNumbers(records, sessionNumbers, boundaries) {
    const numbers = new Map();
    for (const request of sessionNumbers ?? []) {
        numbers.set(requestKey(request.turn, request.group), request.number);
    }
    let next = Math.max(0, ...numbers.values()) + 1;
    const boundaryRecords = records
        .filter(record => boundaries.get(requestKey(record.turn, record.group)) === record.cell.index
        && requestStep(record.group) !== undefined)
        .sort((left, right) => left.cell.index - right.cell.index);
    for (const record of boundaryRecords) {
        const key = requestKey(record.turn, record.group);
        if (!numbers.has(key))
            numbers.set(key, next++);
    }
    return numbers;
}
function indexRequestBoundaryRuns(records) {
    const indexes = new Map();
    let runLength = 0;
    for (const record of records) {
        if (record.cell.requestOnly === true) {
            indexes.set(record.cell.index, runLength++);
            continue;
        }
        if (runLength > 0 && record.groupStart && requestStep(record.group) !== undefined) {
            indexes.set(record.cell.index, runLength);
        }
        runLength = 0;
    }
    return indexes;
}
function summarizeTurn(records) {
    const steps = new Set(records
        .map(record => record.group)
        .filter(group => group.startsWith('Step '))).size;
    const toolCalls = records.filter(record => record.cell.kind === 'tool' || record.cell.kind === 'subtool').length;
    return [
        `${steps} ${steps === 1 ? 'step' : 'steps'}`,
        `${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`,
    ].join(' · ');
}
function collapseTurnRecords(records, collapsedTurns) {
    const recordsByTurn = new Map();
    for (const record of records) {
        if (record.turn === null)
            continue;
        const turnRecords = recordsByTurn.get(record.turn) ?? [];
        turnRecords.push(record);
        recordsByTurn.set(record.turn, turnRecords);
    }
    return records.flatMap((record) => {
        if (record.turn === null || !collapsedTurns.has(record.turn))
            return [record];
        const turnRecords = recordsByTurn.get(record.turn) ?? [record];
        if (record.cell.requestOnly === true || record.cell.kind === 'system')
            return [record];
        const contentRecords = turnRecords.filter(candidate => candidate.cell.requestOnly !== true && candidate.cell.kind !== 'system');
        if (contentRecords.length <= 1)
            return [record];
        if (record.cell.index !== contentRecords[0]?.cell.index)
            return [];
        return [
            { ...record, turnEnd: false },
            {
                ...record,
                groupStart: false,
                turnStart: false,
                turnEnd: true,
                collapsedSummary: summarizeTurn(contentRecords.slice(1)),
                collapsedSummaryKind: 'turn',
            },
        ];
    });
}
function assistantToolCalls(records, assistantIndex) {
    const at = records.findIndex(record => record.cell.index === assistantIndex);
    if (at === -1 || records[at]?.cell.kind !== 'message')
        return [];
    const calls = [];
    for (let i = at + 1; i < records.length; i++) {
        const record = records[i];
        if (record === undefined)
            break;
        if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool')
            break;
        calls.push(record);
    }
    return calls;
}
function summarizeAssistantTools(records) {
    const names = [...new Set(records.map((record) => {
            const separator = record.cell.text.indexOf(' · ');
            return separator === -1 ? record.cell.text : record.cell.text.slice(0, separator);
        }).filter(name => name !== ''))];
    const count = records.length;
    const summary = `${count} tool ${count === 1 ? 'call' : 'calls'}`;
    return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary;
}
function collapseAssistantRecords(records, collapsedAssistants) {
    const out = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (record === undefined)
            continue;
        out.push(record);
        if (record.cell.kind !== 'message'
            || !collapsedAssistants.has((0, trajectory_record_1.trajectoryRecordId)(record.cell)))
            continue;
        const calls = [];
        for (let j = i + 1; j < records.length; j++) {
            const candidate = records[j];
            if (candidate === undefined
                || candidate.collapsedSummary !== undefined
                || (candidate.cell.kind !== 'tool' && candidate.cell.kind !== 'subtool'))
                break;
            calls.push(candidate);
        }
        if (calls.length === 0)
            continue;
        const last = calls.at(-1);
        out[out.length - 1] = { ...record, turnEnd: false };
        out.push({
            ...record,
            groupStart: false,
            turnStart: false,
            turnEnd: last?.turnEnd ?? false,
            collapsedSummary: summarizeAssistantTools(calls),
            collapsedSummaryKind: 'assistant',
        });
        i += calls.length;
    }
    return out;
}
function stateOf(record) {
    if (record.cell.compactionTerminalState !== undefined)
        return record.cell.compactionTerminalState;
    if (record.cell.isError)
        return 'error';
    if (record.cell.kind === 'compacted' && record.cell.timeSeconds === null)
        return 'running';
    if ((record.cell.kind === 'tool' || record.cell.kind === 'subtool')
        && record.cell.outputDetail === undefined)
        return 'running';
    return 'complete';
}
function statusLabel(state) {
    if (state === 'error')
        return 'Failed';
    if (state === 'running')
        return 'Pending';
    if (state === 'skipped')
        return 'Skipped';
    if (state === 'cancelled')
        return 'Interrupted';
    return 'Completed';
}
function TokenRows({ cell }) {
    const content = cell.output !== undefined && cell.think !== undefined
        ? Math.max(0, cell.output - cell.think)
        : undefined;
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Tokens" }), (0, jsx_runtime_1.jsx)("dd", { children: cell.output === undefined ? '—' : `${cell.output} tok` })] }), cell.think !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Reasoning" }), (0, jsx_runtime_1.jsxs)("dd", { children: [cell.think, " tok"] })] })), content !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Content" }), (0, jsx_runtime_1.jsxs)("dd", { children: [content, " tok"] })] }))] }));
}
function inputTotal(usage) {
    if (usage.input === undefined
        && usage.cacheRead === undefined
        && usage.cacheWrite === undefined)
        return undefined;
    return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}
function UsageRows({ usage }) {
    if (usage === undefined)
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "Usage not reported" });
    const totalInput = inputTotal(usage);
    const otherOutput = usage.output !== undefined && usage.reasoning !== undefined
        ? usage.output - usage.reasoning
        : undefined;
    return ((0, jsx_runtime_1.jsxs)("dl", { className: TrajectoryTable_styles_1.default.overview, children: [totalInput !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Input" }), (0, jsx_runtime_1.jsxs)("dd", { children: [totalInput, " tok"] })] })), usage.cacheRead !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Cached" }), (0, jsx_runtime_1.jsxs)("dd", { children: [usage.cacheRead, " tok"] })] })), usage.cacheWrite !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Cache created" }), (0, jsx_runtime_1.jsxs)("dd", { children: [usage.cacheWrite, " tok"] })] })), usage.input !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Other" }), (0, jsx_runtime_1.jsxs)("dd", { children: [usage.input, " tok"] })] })), usage.output !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Output" }), (0, jsx_runtime_1.jsxs)("dd", { children: [usage.output, " tok"] })] })), usage.reasoning !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Reasoning" }), (0, jsx_runtime_1.jsxs)("dd", { children: [usage.reasoning, " tok"] })] })), otherOutput !== undefined && ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.requestTokenDetail, children: [(0, jsx_runtime_1.jsx)("dt", { children: "Content" }), (0, jsx_runtime_1.jsxs)("dd", { children: [otherOutput, " tok"] })] }))] }));
}
function RequestUsagePanel({ usage, cumulative, }) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.usagePanel, children: [(0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.usageGroup, children: [(0, jsx_runtime_1.jsx)("h4", { className: TrajectoryTable_styles_1.default.usageHeading, children: "This request" }), (0, jsx_runtime_1.jsx)(UsageRows, { usage: usage })] }), (0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.usageGroup, children: [(0, jsx_runtime_1.jsx)("h4", { className: TrajectoryTable_styles_1.default.usageHeading, children: "Session cumulative" }), (0, jsx_runtime_1.jsx)(UsageRows, { usage: cumulative })] })] }));
}
function RequestOptions({ options, preview = false, }) {
    if (options === undefined) {
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "Options not recorded" });
    }
    return ((0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: options, label: "Request options JSON", className: preview ? TrajectoryTable_styles_1.default.jsonPreview : TrajectoryTable_styles_1.default.jsonPayload }));
}
function messageSourceLabel(source) {
    if (!(0, runtime_types_1.isObjectRecord)(source)) {
        return 'Unknown';
    }
    const properties = source;
    const kind = properties.kind;
    if (kind === 'user')
        return 'User';
    if (kind === 'plugin') {
        const plugin = properties.plugin;
        return typeof plugin === 'string' && plugin !== ''
            ? `Plugin · ${plugin}`
            : 'Plugin';
    }
    if (kind === 'goal') {
        const round = properties.round;
        return typeof round === 'number' && round > 0
            ? `Goal · Round ${round}`
            : 'Goal';
    }
    if (typeof kind !== 'string' || kind === '')
        return 'Unknown';
    return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
}
function MessageSource({ record }) {
    const source = record.cell.messageSource;
    if (source === undefined)
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "Source not recorded" });
    const data = typeof source === 'object' && source !== null
        ? source
        : { value: source };
    return ((0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: data, label: "Message source JSON", className: TrajectoryTable_styles_1.default.jsonPayload }));
}
function isMarkdownRecord(record) {
    return record.cell.kind === 'user'
        || record.cell.kind === 'context'
        || record.cell.kind === 'message';
}
function parentRecords(records, record) {
    if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool')
        return {};
    const at = records.findIndex(candidate => candidate.cell.index === record.cell.index);
    if (at === -1)
        return {};
    let tool;
    if (record.cell.kind === 'subtool') {
        for (let i = at - 1; i >= 0; i--) {
            const candidate = records[i];
            if (candidate === undefined
                || candidate.turn !== record.turn
                || candidate.group !== record.group)
                break;
            if (candidate.cell.kind === 'tool') {
                tool = candidate;
                break;
            }
        }
    }
    const parentCallId = tool?.cell.callId ?? record.cell.callId;
    let message;
    if (parentCallId !== undefined) {
        message = records.find(candidate => candidate.turn === record.turn
            && candidate.cell.kind === 'message'
            && candidate.cell.sourceBlocks?.some(block => block.callId === parentCallId) === true);
    }
    return { ...(message === undefined ? {} : { message }), ...(tool === undefined ? {} : { tool }) };
}
function markdownSource(record) {
    if (record.cell.kind === 'user' || record.cell.kind === 'context') {
        return record.cell.inputDetail;
    }
    if (record.cell.kind === 'message' || record.cell.kind === 'compacted') {
        return record.cell.outputDetail;
    }
    return undefined;
}
function detailTabs(record) {
    if (record.cell.kind === 'system') {
        return record.cell.previousPromptDetail === undefined
            ? SYSTEM_PROMPT_TABS
            : SYSTEM_UPDATE_TABS;
    }
    if (record.cell.kind === 'compacted') {
        return [
            { id: 'overview', label: 'Summary' },
            { id: 'raw', label: 'Raw Output' },
        ];
    }
    if (isMarkdownRecord(record)) {
        return [
            { id: 'overview', label: 'Summary' },
            { id: 'rendered', label: 'Preview' },
            { id: 'raw', label: 'Raw' },
            ...(record.cell.messageSource === undefined
                ? []
                : [{ id: 'source', label: 'Source' }]),
        ];
    }
    return [
        { id: 'overview', label: 'Summary' },
        ...(record.cell.inputDetail ? [{ id: 'input', label: 'Payload' }] : []),
        ...(record.cell.outputDetail ? [{ id: 'output', label: 'Result' }] : []),
        { id: 'schema', label: 'Schema' },
        { id: 'timing', label: 'Timing' },
    ];
}
function recordDisplayText(cell) {
    if (isToolCallOnly(cell))
        return '';
    if (cell.previewMarkdown !== undefined) {
        const preview = (0, trajectory_preview_1.trajectoryPreviewText)(cell.previewMarkdown);
        if (cell.text === '')
            return preview;
        return preview === '' ? cell.text : `${cell.text} · ${preview}`;
    }
    if (cell.text !== '')
        return cell.text;
    const markdown = cell.kind === 'user' || cell.kind === 'context'
        ? cell.inputDetail
        : cell.kind === 'message'
            ? cell.outputDetail ?? cell.thinkingDetail
            : undefined;
    return markdown === undefined ? '' : (0, trajectory_preview_1.trajectoryPreviewText)(markdown);
}
function recordResultText(cell) {
    return cell.resultPreviewMarkdown === undefined
        ? cell.result
        : (0, trajectory_preview_1.trajectoryPreviewText)(cell.resultPreviewMarkdown);
}
function toolCallTextParts(kind, text) {
    if (kind !== 'tool' && kind !== 'subtool')
        return undefined;
    const separator = text.indexOf(' · ');
    if (separator === -1)
        return { name: text };
    return {
        name: text.slice(0, separator),
        args: text.slice(separator + 3),
    };
}
function isToolCallOnly(cell) {
    return cell.kind === 'message'
        && !cell.outputDetail
        && !cell.thinkingDetail
        && cell.text === 'Tool call only';
}
function RecordPresentation({ cell, children, }) {
    const displayText = (0, react_1.useMemo)(() => recordDisplayText(cell), [
        cell.kind, cell.text, cell.previewMarkdown,
        cell.inputDetail, cell.outputDetail, cell.thinkingDetail,
    ]);
    const resultText = (0, react_1.useMemo)(() => recordResultText(cell), [cell.result, cell.resultPreviewMarkdown]);
    const toolCallOnly = isToolCallOnly(cell);
    const toolCallText = toolCallTextParts(cell.kind, displayText);
    const listDisplayText = toolCallOnly
        ? '(tool call only)'
        : toolCallText === undefined
            ? displayText
            : [toolCallText.name, toolCallText.args].filter(Boolean).join(' ');
    return children({
        displayText,
        listDisplayText,
        resultText,
        toolCallOnly,
        toolCallText,
    });
}
function RecordListText({ displayText, toolCallOnly, toolCallText, }) {
    if (toolCallOnly) {
        return (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.toolCallOnly, children: "(tool call only)" });
    }
    if (toolCallText === undefined)
        return displayText || '—';
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.toolCallNameTypeface, children: toolCallText.name || '—' }), toolCallText.args !== undefined && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.toolCallPayload, children: toolCallText.args }))] }));
}
function MarkdownFragment({ text, rendered, preview, }) {
    if (rendered) {
        return ((0, jsx_runtime_1.jsx)("div", { className: preview ? TrajectoryTable_styles_1.default.markdownPreview : TrajectoryTable_styles_1.default.markdownPayload, children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: text }) }));
    }
    return ((0, jsx_runtime_1.jsx)("pre", { className: `${TrajectoryTable_styles_1.default.payload} ${preview ? TrajectoryTable_styles_1.default.payloadPreview : ''}`, children: text }));
}
function SourceBlocks({ blocks, onOpenCall, }) {
    return ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.sourceBlocks, children: blocks.map((block, index) => ((0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.sourceBlock, children: [block.callId !== undefined
                    ? ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.sourceBlockJumpTarget, "aria-label": `Open Block #${index + 1} tool call summary`, title: "Open tool call summary", onClick: () => {
                            if (block.callId !== undefined)
                                onOpenCall(block.callId);
                        }, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.sourceBlockLabel, children: `Block #${index + 1} ${block.type}` }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.sourceBlockJumpIcon, size: 12 })] }))
                    : ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.sourceBlockHeader, children: (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.sourceBlockLabel, children: `Block #${index + 1} ${block.type}` }) })), block.imageSrc !== undefined
                    ? (0, jsx_runtime_1.jsx)(PanelImage, { block: block })
                    : (0, jsx_runtime_1.jsx)("pre", { className: TrajectoryTable_styles_1.default.sourceBlockContent, children: block.content })] }, index))) }));
}
function PanelImage({ block, preview = false, }) {
    if (block.imageSrc === undefined)
        return null;
    return ((0, jsx_runtime_1.jsx)("a", { className: preview ? `${TrajectoryTable_styles_1.default.panelImageLink} ${TrajectoryTable_styles_1.default.panelImageLinkPreview}` : TrajectoryTable_styles_1.default.panelImageLink, href: block.imageSrc, target: "_blank", rel: "noopener noreferrer", title: "Open image", children: (0, jsx_runtime_1.jsx)("img", { className: TrajectoryTable_styles_1.default.panelImage, src: block.imageSrc, alt: block.imageAlt ?? '' }) }));
}
function MessageImages({ blocks, preview, }) {
    const images = blocks?.filter(block => block.imageSrc !== undefined) ?? [];
    if (images.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { className: preview ? `${TrajectoryTable_styles_1.default.messageImages} ${TrajectoryTable_styles_1.default.messageImagesPreview}` : TrajectoryTable_styles_1.default.messageImages, children: images.map((block, index) => (0, jsx_runtime_1.jsx)(PanelImage, { block: block, preview: preview }, index)) }));
}
function AssistantToolCalls({ blocks, preview, onOpenCall, }) {
    const calls = blocks?.filter(block => block.type === 'tool-call') ?? [];
    if (calls.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsx)("ul", { className: preview
            ? `${TrajectoryTable_styles_1.default.assistantToolCalls} ${TrajectoryTable_styles_1.default.assistantToolCallsPreview}`
            : TrajectoryTable_styles_1.default.assistantToolCalls, children: calls.map((call, index) => ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.assistantToolCallButton, title: "Open tool call summary", onClick: () => {
                    if (call.callId !== undefined)
                        onOpenCall(call.callId);
                }, children: [(0, jsx_runtime_1.jsx)("svg", { className: TrajectoryTable_styles_1.default.assistantToolCallIcon, width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }) }), (0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default.assistantToolCallText, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.assistantToolCallName, children: call.toolName ?? 'tool-call' }), call.content !== '' && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.assistantToolCallArgs, children: call.content }))] })] }) }, call.callId ?? index))) }));
}
function ToolGlyph() {
    return ((0, jsx_runtime_1.jsx)("svg", { className: TrajectoryTable_styles_1.default.toolCatalogIcon, width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
function ToolCatalog({ tools }) {
    if (tools.length === 0)
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "No tools in this request" });
    return ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.toolCatalog, children: tools.map((tool, index) => ((0, jsx_runtime_1.jsxs)("details", { className: TrajectoryTable_styles_1.default.toolCatalogItem, children: [(0, jsx_runtime_1.jsxs)("summary", { className: TrajectoryTable_styles_1.default.toolCatalogSummary, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.toolCatalogChevron, size: 12 }), (0, jsx_runtime_1.jsx)(ToolGlyph, {}), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.toolCatalogName, children: tool.name }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.toolCatalogDescription, children: tool.description })] }), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.toolCatalogDefinition, children: [tool.description !== '' && ((0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.toolCatalogFullDescription, children: tool.description })), (0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: tool.parameters, label: `${tool.name} parameters JSON`, className: TrajectoryTable_styles_1.default.toolCatalogTree })] })] }, `${tool.name}:${index}`))) }));
}
function promptDiffLines(before, after) {
    const patch = (0, create_1.structuredPatch)('', '', before, after, undefined, undefined, { context: 3 });
    return patch.hunks.flatMap((hunk, hunkIndex) => [
        ...(hunkIndex === 0 ? [] : [{ kind: 'meta', text: '' }]),
        {
            kind: 'meta',
            text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        },
        ...hunk.lines.flatMap((line) => {
            if (line.startsWith('\\'))
                return [];
            if (line.startsWith('+'))
                return [{ kind: 'added', text: line }];
            if (line.startsWith('-'))
                return [{ kind: 'removed', text: line }];
            return [{ kind: 'context', text: line }];
        }),
    ]);
}
function PromptDiffSection({ title, before, after, }) {
    const lines = promptDiffLines(before, after);
    if (lines.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.promptDiffSection, children: [(0, jsx_runtime_1.jsx)("h3", { className: TrajectoryTable_styles_1.default.promptDiffTitle, children: title }), (0, jsx_runtime_1.jsx)("pre", { className: TrajectoryTable_styles_1.default.promptDiff, children: lines.map((line, index) => ((0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default[`promptDiffLine${line.kind}`], children: [line.text || ' ', '\n'] }, index))) })] }));
}
function SystemPromptDiff({ before, after, }) {
    const toolsBefore = JSON.stringify(before.tools, null, 2);
    const toolsAfter = JSON.stringify(after.tools, null, 2);
    return ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.promptDiffSections, children: [before.system !== after.system && ((0, jsx_runtime_1.jsx)(PromptDiffSection, { title: "System Prompt", before: before.system, after: after.system })), toolsBefore !== toolsAfter && ((0, jsx_runtime_1.jsx)(PromptDiffSection, { title: "Tools", before: toolsBefore, after: toolsAfter }))] }));
}
function ToolOutputBlocks({ blocks, error, preview, }) {
    return ((0, jsx_runtime_1.jsx)("div", { className: [
            TrajectoryTable_styles_1.default.resultBlocks,
            preview ? TrajectoryTable_styles_1.default.resultBlocksPreview : undefined,
            error ? TrajectoryTable_styles_1.default.errorPayload : undefined,
        ].filter((value) => value !== undefined).join(' '), children: blocks.map((block, index) => (block.imageSrc !== undefined
            ? (0, jsx_runtime_1.jsx)(PanelImage, { block: block, preview: preview }, index)
            : block.content !== ''
                ? (0, jsx_runtime_1.jsx)("pre", { className: TrajectoryTable_styles_1.default.resultBlockText, children: block.content }, index)
                : null)) }));
}
function MarkdownRecordContent({ record, rendered, preview = false, thinkingExpanded, onThinkingExpandedChange, onOpenCall, }) {
    if (!rendered && record.cell.sourceBlocks && record.cell.sourceBlocks.length > 0) {
        return (0, jsx_runtime_1.jsx)(SourceBlocks, { blocks: record.cell.sourceBlocks, onOpenCall: onOpenCall });
    }
    if (record.cell.thinkingDetail) {
        if (!rendered) {
            const source = [
                record.cell.thinkingDetail,
                record.cell.outputDetail,
            ].filter((value) => value !== undefined && value !== '').join('\n\n');
            return (0, jsx_runtime_1.jsx)(MarkdownFragment, { text: source, rendered: false, preview: preview });
        }
        return ((0, jsx_runtime_1.jsxs)("div", { className: `${TrajectoryTable_styles_1.default.assistantContent} ${TrajectoryTable_styles_1.default.assistantContentRendered}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: preview && !record.cell.outputDetail
                        ? `${TrajectoryTable_styles_1.default.thinkingQuote} ${TrajectoryTable_styles_1.default.thinkingQuoteOnlyPreview}`
                        : TrajectoryTable_styles_1.default.thinkingQuote, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.thinkingToggle, "aria-expanded": thinkingExpanded, onClick: () => { onThinkingExpandedChange(!thinkingExpanded); }, children: ["Thinking", (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.thinkingChevron, size: 12 })] }), thinkingExpanded && ((0, jsx_runtime_1.jsx)(MarkdownFragment, { text: record.cell.thinkingDetail, rendered: rendered, preview: preview }))] }), record.cell.outputDetail && ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.assistantOutput, children: (0, jsx_runtime_1.jsx)(MarkdownFragment, { text: record.cell.outputDetail, rendered: rendered, preview: preview }) })), (0, jsx_runtime_1.jsx)(AssistantToolCalls, { blocks: record.cell.sourceBlocks, preview: preview, onOpenCall: onOpenCall }), (0, jsx_runtime_1.jsx)(MessageImages, { blocks: record.cell.sourceBlocks, preview: preview })] }));
    }
    const source = markdownSource(record);
    const hasImages = record.cell.sourceBlocks?.some(block => block.imageSrc !== undefined) === true;
    const hasToolCalls = record.cell.kind === 'message'
        && record.cell.sourceBlocks?.some(block => block.type === 'tool-call') === true;
    if (!source && !hasImages && !hasToolCalls) {
        const emptyLabel = isToolCallOnly(record.cell)
            ? 'Tool call only'
            : record.cell.text || 'No content';
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: emptyLabel });
    }
    if (!rendered || (!hasImages && !hasToolCalls)) {
        return (0, jsx_runtime_1.jsx)(MarkdownFragment, { text: source ?? '', rendered: rendered, preview: preview });
    }
    return ((0, jsx_runtime_1.jsxs)("div", { children: [source && (0, jsx_runtime_1.jsx)(MarkdownFragment, { text: source, rendered: true, preview: preview }), record.cell.kind === 'message' && ((0, jsx_runtime_1.jsx)(AssistantToolCalls, { blocks: record.cell.sourceBlocks, preview: preview, onOpenCall: onOpenCall })), (0, jsx_runtime_1.jsx)(MessageImages, { blocks: record.cell.sourceBlocks, preview: preview })] }));
}
function RecordTiming({ record }) {
    return record.cell.kind === 'message' && record.cell.assistantMetrics !== undefined
        ? (0, jsx_runtime_1.jsx)(AssistantTimingPanel, { metrics: record.cell.assistantMetrics })
        : ((0, jsx_runtime_1.jsxs)("dl", { className: TrajectoryTable_styles_1.default.overview, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Started" }), (0, jsx_runtime_1.jsx)(StartedAtValue, { timestamp: record.cell.startedAt ?? null })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Duration" }), (0, jsx_runtime_1.jsx)("dd", { children: (0, trajectory_record_1.formatElapsedSeconds)(record.cell.timeSeconds) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Timing source" }), (0, jsx_runtime_1.jsx)("dd", { children: record.cell.timeSeconds === null ? 'Not available' : 'Session timestamps' })] })] }));
}
function RequestTiming({ assistant, anchor, request, }) {
    if (assistant !== undefined)
        return (0, jsx_runtime_1.jsx)(RecordTiming, { record: assistant });
    if (request?.startedAt !== undefined) {
        const duration = request.completedAt === null || request.completedAt === undefined
            ? null
            : Math.max(0, (request.completedAt - request.startedAt) / 1000);
        return ((0, jsx_runtime_1.jsxs)("dl", { className: TrajectoryTable_styles_1.default.overview, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Started" }), (0, jsx_runtime_1.jsx)(StartedAtValue, { timestamp: request.startedAt })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Duration" }), (0, jsx_runtime_1.jsx)("dd", { children: (0, trajectory_record_1.formatElapsedSeconds)(duration) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Timing source" }), (0, jsx_runtime_1.jsx)("dd", { children: duration === null ? 'Session timestamps (running)' : 'Session timestamps' })] })] }));
    }
    return ((0, jsx_runtime_1.jsxs)("dl", { className: TrajectoryTable_styles_1.default.overview, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Started" }), (0, jsx_runtime_1.jsx)(StartedAtValue, { timestamp: anchor?.cell.startedAt ?? null })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Duration" }), (0, jsx_runtime_1.jsx)("dd", { children: (0, trajectory_record_1.formatElapsedSeconds)(null) })] })] }));
}
function RecordPayload({ record, direction, preview = false, }) {
    const value = direction === 'input' ? record.cell.inputDetail : record.cell.outputDetail;
    const missing = direction === 'input'
        ? 'No payload captured'
        : 'No result captured';
    if (!value)
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: missing });
    const error = direction === 'output' && record.cell.isError === true;
    const payloadClass = preview ? TrajectoryTable_styles_1.default.jsonPreview : TrajectoryTable_styles_1.default.jsonPayload;
    const payloadClassName = error ? `${payloadClass} ${TrajectoryTable_styles_1.default.errorPayload}` : payloadClass;
    const json = parseJsonContainer(value);
    const singleTextResult = direction === 'output'
        && record.cell.outputBlocks?.length === 1
        && record.cell.outputBlocks[0]?.type === 'text';
    if (singleTextResult && json !== undefined) {
        return ((0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: json, label: "Result JSON", className: payloadClassName }));
    }
    if (direction === 'output'
        && record.cell.outputBlocks?.some(block => block.imageSrc !== undefined || block.content !== '') === true) {
        return ((0, jsx_runtime_1.jsx)(ToolOutputBlocks, { blocks: record.cell.outputBlocks, error: error, preview: preview }));
    }
    const markdown = (direction === 'input'
        && (record.cell.kind === 'user' || record.cell.kind === 'context')) || (direction === 'output' && record.cell.kind === 'message');
    if (markdown) {
        return ((0, jsx_runtime_1.jsx)("div", { className: [
                preview ? TrajectoryTable_styles_1.default.markdownPreview : TrajectoryTable_styles_1.default.markdownPayload,
                error ? TrajectoryTable_styles_1.default.errorPayload : undefined,
            ].filter((className) => className !== undefined).join(' '), children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: value }) }));
    }
    if (json !== undefined) {
        return ((0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: json, label: `${direction === 'input' ? 'Payload' : 'Result'} JSON`, className: payloadClassName }));
    }
    return ((0, jsx_runtime_1.jsx)("pre", { className: [
            TrajectoryTable_styles_1.default.payload,
            preview ? TrajectoryTable_styles_1.default.payloadPreview : undefined,
            error ? TrajectoryTable_styles_1.default.errorPayload : undefined,
            value === 'No output' ? TrajectoryTable_styles_1.default.noOutputText : undefined,
        ].filter((value) => value !== undefined).join(' '), children: value }));
}
function RecordSchema({ record, preview = false, }) {
    if (!record.cell.schemaDetail) {
        return (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "Schema unavailable" });
    }
    const schema = parseToolSchema(record.cell.schemaDetail);
    if (schema !== undefined) {
        return ((0, jsx_runtime_1.jsxs)("div", { className: preview ? `${TrajectoryTable_styles_1.default.schema} ${TrajectoryTable_styles_1.default.schemaPreview}` : TrajectoryTable_styles_1.default.schema, children: [(0, jsx_runtime_1.jsxs)("header", { className: TrajectoryTable_styles_1.default.schemaIntro, children: [(0, jsx_runtime_1.jsx)("h3", { className: TrajectoryTable_styles_1.default.schemaName, children: schema.name }), (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.schemaDescription, children: schema.description })] }), (0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.schemaParameters, children: [(0, jsx_runtime_1.jsx)("h4", { className: TrajectoryTable_styles_1.default.schemaParametersTitle, children: "Parameters" }), (0, jsx_runtime_1.jsx)(primitives_1.JsonTree, { data: schema.parameters, label: `${schema.name} parameters JSON`, className: TrajectoryTable_styles_1.default.schemaTree })] })] }));
    }
    return ((0, jsx_runtime_1.jsx)("pre", { className: `${TrajectoryTable_styles_1.default.payload} ${preview ? TrajectoryTable_styles_1.default.payloadPreview : ''}`, children: record.cell.schemaDetail }));
}
function parseToolSchema(value) {
    try {
        const parsed = JSON.parse(value);
        if (!(0, runtime_types_1.isObjectRecord)(parsed))
            return undefined;
        const schema = parsed;
        if (typeof schema.name !== 'string'
            || typeof schema.description !== 'string'
            || typeof schema.parameters !== 'object'
            || schema.parameters === null
            || Array.isArray(schema.parameters))
            return undefined;
        return {
            name: schema.name,
            description: schema.description,
            parameters: schema.parameters,
        };
    }
    catch {
        return undefined;
    }
}
function parseJsonContainer(value) {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function OverviewSection({ label, onOpen, children, }) {
    return ((0, jsx_runtime_1.jsxs)("section", { className: TrajectoryTable_styles_1.default.overviewSection, children: [(0, jsx_runtime_1.jsx)("h3", { className: TrajectoryTable_styles_1.default.overviewHeading, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewTitle, onClick: onOpen, children: [(0, jsx_runtime_1.jsx)("span", { children: label }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewTitleIcon, size: 12 })] }) }), (0, jsx_runtime_1.jsx)("div", { className: `${TrajectoryTable_styles_1.default.overviewPreview} ${TrajectoryTable_styles_1.default.summaryScrollRegion}`, "data-summary-scroll-region": "", children: children })] }));
}
/**
 * Render trajectory events as a dense ledger with turn and step separators.
 * Clicking ledger whitespace clears the active record or request selection.
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
function TrajectoryTable({ requestNumbers: sessionRequestNumbers, turns, streamingCells = [], timelineFocusIndexes = null, searchMatchIndexes = null, onSelectedIndexChange, onRecordSelect, recordSelection = null, recordFocus = null, historyLoading = false, olderHistoryLoading = false, historyStartSeq, hasOlderRecords = false, onLoadOlder, onClearSelection, collapsedTurns, onToggleTurn, collapsedAssistants, onToggleAssistant, inspectCallId = null, onInspectApplied, }) {
    const [selectedRecordId, setSelectedRecordId] = (0, react_1.useState)(null);
    const [selectedRequest, setSelectedRequest] = (0, react_1.useState)(null);
    const [activeTab, setActiveTab] = (0, react_1.useState)('overview');
    const [thinkingExpanded, setThinkingExpanded] = (0, react_1.useState)(false);
    const [detailsWidth, setDetailsWidth] = (0, react_1.useState)(null);
    const [toolRequestOffset, setToolRequestOffset] = (0, react_1.useState)(null);
    const detailsResizeDrag = (0, react_1.useRef)(null);
    const appliedRecordSelection = (0, react_1.useRef)(null);
    const appliedRecordFocus = (0, react_1.useRef)(null);
    const tabHistory = (0, react_1.useRef)(new Set(['overview']));
    const rootRef = (0, react_1.useRef)(null);
    const tablePaneRef = (0, react_1.useRef)(null);
    const followsTableTail = (0, react_1.useRef)(false);
    const tableScrollInitialized = (0, react_1.useRef)(false);
    const [tableScrollReady, setTableScrollReady] = (0, react_1.useState)(false);
    const pendingScrollRecordId = (0, react_1.useRef)(null);
    const loadingOlder = (0, react_1.useRef)(false);
    const [olderLoading, setOlderLoading] = (0, react_1.useState)(false);
    const olderLoadAnchor = (0, react_1.useRef)(null);
    const allRecords = (0, react_1.useMemo)(() => flattenRecords(turns), [turns]);
    const streamingCellsByIndex = (0, react_1.useMemo)(() => new Map(streamingCells.map(cell => [cell.index, cell])), [streamingCells]);
    const currentRecord = (0, react_1.useCallback)((record) => {
        const cell = streamingCellsByIndex.get(record.cell.index);
        return cell === undefined ? record : { ...record, cell };
    }, [streamingCellsByIndex]);
    const selectedTemplate = (0, react_1.useMemo)(() => selectedRecordId === null
        ? undefined
        : allRecords.find(record => (0, trajectory_record_1.trajectoryRecordId)(record.cell) === selectedRecordId), [allRecords, selectedRecordId]);
    const selected = selectedTemplate === undefined
        ? undefined
        : currentRecord(selectedTemplate);
    const selectedIndex = selected?.cell.index ?? null;
    (0, react_1.useEffect)(() => {
        onSelectedIndexChange?.(selectedIndex);
    }, [onSelectedIndexChange, selectedIndex]);
    const requestBoundaries = (0, react_1.useMemo)(() => indexRequestBoundaries(allRecords), [allRecords]);
    const requestNumbers = (0, react_1.useMemo)(() => indexRequestNumbers(allRecords, sessionRequestNumbers, requestBoundaries), [allRecords, requestBoundaries, sessionRequestNumbers]);
    const records = (0, react_1.useMemo)(() => {
        if (searchMatchIndexes !== null)
            return filterRecords(allRecords, searchMatchIndexes);
        const turnRecords = collapsedTurns.size === 0
            ? allRecords
            : collapseTurnRecords(allRecords, collapsedTurns);
        return collapsedAssistants.size === 0
            ? turnRecords
            : collapseAssistantRecords(turnRecords, collapsedAssistants);
    }, [allRecords, collapsedAssistants, collapsedTurns, searchMatchIndexes]);
    const projectedVirtualRows = (0, react_1.useMemo)(() => (0, trajectory_virtual_rows_1.groupTrajectoryVirtualRows)(records), [records]);
    const virtualRowStructure = useStableVirtualRowStructure(projectedVirtualRows);
    const virtualizationEnabled = hasOlderRecords
        || records.length > VIRTUALIZATION_THRESHOLD;
    const virtualScrollMargin = hasOlderRecords ? HISTORY_LOAD_ROW_HEIGHT_PX : 0;
    const estimateVirtualRowSize = (0, react_1.useCallback)((index) => virtualRowStructure[index]?.height ?? 30, [virtualRowStructure]);
    const getVirtualRowKey = (0, react_1.useCallback)((index) => virtualRowStructure[index]?.key ?? index, [virtualRowStructure]);
    const getTableScrollElement = (0, react_1.useCallback)(() => tablePaneRef.current, []);
    const rowVirtualizer = (0, index_1.useVirtualizer)({
        count: virtualizationEnabled ? virtualRowStructure.length : 0,
        enabled: virtualizationEnabled,
        estimateSize: estimateVirtualRowSize,
        getItemKey: getVirtualRowKey,
        getScrollElement: getTableScrollElement,
        initialRect: { width: 0, height: VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX },
        anchorTo: 'end',
        overscan: VIRTUAL_OVERSCAN_ROWS,
        scrollMargin: virtualScrollMargin,
        scrollEndThreshold: BOTTOM_FOLLOW_THRESHOLD_PX,
    });
    const virtualIndexByRecordId = (0, react_1.useMemo)(() => {
        const indexes = new Map();
        for (const [virtualIndex, row] of projectedVirtualRows.entries()) {
            for (const entry of row.entries) {
                if (entry.record.collapsedSummary === undefined) {
                    indexes.set((0, trajectory_record_1.trajectoryRecordId)(entry.record.cell), virtualIndex);
                }
            }
        }
        return indexes;
    }, [projectedVirtualRows]);
    const virtualItems = virtualizationEnabled ? rowVirtualizer.getVirtualItems() : [];
    const virtualTop = Math.max(0, (virtualItems[0]?.start ?? 0) - virtualScrollMargin);
    const virtualBottom = virtualItems.length === 0
        ? 0
        : Math.max(0, rowVirtualizer.getTotalSize()
            + virtualScrollMargin
            - (virtualItems.at(-1)?.end ?? 0));
    const renderedRecords = virtualizationEnabled
        ? virtualItems.flatMap((item) => {
            const row = projectedVirtualRows[item.index];
            if (row === undefined)
                return [];
            return row.entries.map((entry, entryIndex) => ({
                record: currentRecord(entry.record),
                position: entry.logicalIndex,
                terminalRequestBoundary: entry.record.cell.requestOnly === true
                    && row.entries.at(-1)?.record.cell.requestOnly === true
                    && entryIndex === row.entries.length - 1,
            }));
        })
        : records.map((record, position) => ({
            record: currentRecord(record),
            position,
            terminalRequestBoundary: record.cell.requestOnly === true && position === records.length - 1,
        }));
    const requestBoundaryRuns = (0, react_1.useMemo)(() => indexRequestBoundaryRuns(records), [records]);
    const selectedPrompt = selected?.cell.kind === 'system'
        ? selected.cell.promptDetail
        : undefined;
    const selectedPreviousPrompt = selected?.cell.kind === 'system'
        ? selected.cell.previousPromptDetail
        : undefined;
    const promptSelected = selectedPrompt !== undefined;
    const selectedState = selected === undefined ? undefined : stateOf(selected);
    const selectedRequestRecordTemplates = (0, react_1.useMemo)(() => selectedRequest === null
        ? []
        : allRecords.filter(record => record.turn === selectedRequest.turn
            && record.group === selectedRequest.group), [allRecords, selectedRequest]);
    const selectedRequestRecords = selectedRequestRecordTemplates.map(currentRecord);
    const selectedRequestAssistant = selectedRequestRecords.find(record => record.cell.kind === 'message');
    const selectedRequestAnchor = selectedRequestAssistant ?? selectedRequestRecords[0];
    const selectedRequestNumber = selectedRequest === null
        ? undefined
        : requestNumbers.get(requestKey(selectedRequest.turn, selectedRequest.group));
    const selectedRequestInfo = selectedRequest === null
        ? undefined
        : sessionRequestNumbers?.find(request => selectedRequest.seq === undefined
            ? request.turn === selectedRequest.turn && request.group === selectedRequest.group
            : request.seq === selectedRequest.seq);
    const selectedRequestState = selectedRequest === null
        ? undefined
        : selectedRequestInfo?.status
            ?? (selectedRequestAssistant?.cell.assistantMetrics?.completedTime === null
                ? 'running'
                : selectedRequestAssistant === undefined
                    && selectedRequestRecords.some(record => stateOf(record) === 'running')
                    ? 'running'
                    : 'complete');
    const selectedRequestToolCalls = selectedRequestRecords.filter(record => record.cell.kind === 'tool').length;
    const selectedRequestSubtoolCalls = selectedRequestRecords.filter(record => record.cell.kind === 'subtool').length;
    const selectedRequestResultTemplate = selectedRequestInfo?.resultSeq === undefined
        ? selectedRequestAssistant
        : allRecords.find(record => record.cell.sourceSeq === selectedRequestInfo.resultSeq);
    const selectedRequestResult = selectedRequestResultTemplate === undefined
        ? undefined
        : currentRecord(selectedRequestResultTemplate);
    const selectedRequestUsage = selectedRequestInfo?.usage ?? (selectedRequestAssistant === undefined
        ? undefined
        : {
            ...(selectedRequestAssistant.cell.input === undefined
                ? {}
                : { input: selectedRequestAssistant.cell.input }),
            ...(selectedRequestAssistant.cell.cacheRead === undefined
                ? {}
                : { cacheRead: selectedRequestAssistant.cell.cacheRead }),
            ...(selectedRequestAssistant.cell.cacheWrite === undefined
                ? {}
                : { cacheWrite: selectedRequestAssistant.cell.cacheWrite }),
            ...(selectedRequestAssistant.cell.output === undefined
                ? {}
                : { output: selectedRequestAssistant.cell.output }),
            ...(selectedRequestAssistant.cell.think === undefined
                ? {}
                : { reasoning: selectedRequestAssistant.cell.think }),
        });
    const selectedRequestCumulativeUsage = selectedRequestInfo?.cumulativeUsage ?? selectedRequestUsage;
    const selectedRequestOptions = selectedRequestInfo?.requestConfig;
    const activeTurn = selectedRequest === null ? selected?.turn : selectedRequest.turn;
    const activeSection = selectedRequest === null
        ? selected?.section
        : selectedRequestRecords[0]?.section;
    const selectedTabs = selectedRequest !== null
        ? REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)
        : selected === undefined ? [] : detailTabs(selected);
    const selectedParents = selected === undefined
        ? {}
        : parentRecords(allRecords, selected);
    const selectedParentMessage = selectedParents.message;
    const selectedParentTool = selectedParents.tool;
    const selectedAssistantRequest = selected?.cell.kind === 'message'
        ? requestNumbers.get(requestKey(selected.turn, selected.group))
        : undefined;
    const selectedAssistantRequestInfo = selectedAssistantRequest === undefined
        ? undefined
        : sessionRequestNumbers?.find(request => request.number === selectedAssistantRequest);
    const selectedAssistantRequestTarget = selected !== undefined && selectedAssistantRequest !== undefined
        ? {
            turn: selected.turn,
            group: selected.group,
            ...(selectedAssistantRequestInfo?.seq === undefined
                ? {}
                : { seq: selectedAssistantRequestInfo.seq }),
        }
        : undefined;
    const hasSelectedHierarchy = selectedAssistantRequestTarget !== undefined
        || selectedParents.message !== undefined
        || selectedParents.tool !== undefined;
    const splitStyle = toolRequestOffset === null
        ? undefined
        : {
            '--trajectory-tool-request-width': `calc(58cqw - ${toolRequestOffset}px)`,
        };
    const activateTab = (tab) => {
        tabHistory.current.delete(tab);
        tabHistory.current.add(tab);
        setActiveTab(tab);
    };
    const clearInspectorSelection = () => {
        setSelectedRecordId(null);
        setSelectedRequest(null);
    };
    const clearAllSelections = () => {
        clearInspectorSelection();
        onClearSelection?.();
    };
    const selectRecord = (0, react_1.useCallback)((index) => {
        const record = allRecords.find(candidate => candidate.cell.index === index);
        onRecordSelect?.(index);
        setSelectedRequest(null);
        setSelectedRecordId(record === undefined ? null : (0, trajectory_record_1.trajectoryRecordId)(record.cell));
        if (record === undefined)
            return;
        const tabs = detailTabs(record);
        const available = new Set(tabs.map(tab => tab.id));
        const recent = [...tabHistory.current].reverse().find(tab => available.has(tab));
        setActiveTab(recent ?? tabs[0]?.id ?? 'overview');
    }, [allRecords, onRecordSelect]);
    (0, react_1.useEffect)(() => {
        if (recordSelection === null
            || appliedRecordSelection.current === recordSelection)
            return;
        appliedRecordSelection.current = recordSelection;
        selectRecord(recordSelection.index);
        const record = allRecords.find(candidate => candidate.cell.index === recordSelection.index);
        pendingScrollRecordId.current = record === undefined
            ? null
            : (0, trajectory_record_1.trajectoryRecordId)(record.cell);
    }, [allRecords, recordSelection, selectRecord]);
    (0, react_1.useEffect)(() => {
        if (recordFocus === null || appliedRecordFocus.current === recordFocus)
            return;
        appliedRecordFocus.current = recordFocus;
        const record = allRecords.find(candidate => candidate.cell.index === recordFocus.index);
        pendingScrollRecordId.current = record === undefined
            ? null
            : (0, trajectory_record_1.trajectoryRecordId)(record.cell);
    }, [allRecords, recordFocus]);
    const selectRequest = (request, tab = 'overview') => {
        setSelectedRecordId(null);
        setSelectedRequest(request);
        activateTab(tab);
    };
    const openRecordSummary = (target) => {
        const targetAt = allRecords.findIndex(record => record.cell.index === target.cell.index);
        if (target.turn !== null && collapsedTurns.has(target.turn))
            onToggleTurn(target.turn);
        if (target.cell.kind === 'tool' || target.cell.kind === 'subtool') {
            for (let i = targetAt - 1; i >= 0; i--) {
                const candidate = allRecords[i];
                if (candidate === undefined || candidate.turn !== target.turn)
                    break;
                if (candidate.cell.kind !== 'message')
                    continue;
                const assistantId = (0, trajectory_record_1.trajectoryRecordId)(candidate.cell);
                if (collapsedAssistants.has(assistantId))
                    onToggleAssistant(assistantId);
                break;
            }
        }
        setSelectedRequest(null);
        setSelectedRecordId((0, trajectory_record_1.trajectoryRecordId)(target.cell));
        activateTab('overview');
    };
    const openCallSummary = (callId) => {
        const target = allRecords.find(record => record.cell.callId === callId);
        if (target !== undefined)
            openRecordSummary(target);
    };
    // Cross-view inspect handoff: resolve the requested call to its record,
    // open its summary, and remember the row to scroll once the un-collapsed
    // ledger has rendered. Not-found leaves the request pending (`turns` in the
    // deps retries as history pages in); the ack clears the store field.
    const openRecordSummaryRef = (0, react_1.useRef)(openRecordSummary);
    openRecordSummaryRef.current = openRecordSummary;
    (0, react_1.useEffect)(() => {
        if (inspectCallId === null)
            return;
        const target = flattenRecords(turns).find(record => record.cell.callId === inspectCallId);
        if (target === undefined)
            return;
        openRecordSummaryRef.current(target);
        pendingScrollRecordId.current = (0, trajectory_record_1.trajectoryRecordId)(target.cell);
        onInspectApplied?.();
    }, [inspectCallId, turns, onInspectApplied]);
    (0, react_1.useEffect)(() => {
        const id = pendingScrollRecordId.current;
        if (id === null)
            return;
        const position = records.findIndex(record => (0, trajectory_record_1.trajectoryRecordId)(record.cell) === id && record.collapsedSummary === undefined);
        if (position === -1)
            return;
        if (virtualizationEnabled) {
            const virtualIndex = virtualIndexByRecordId.get(id);
            if (virtualIndex === undefined)
                return;
            pendingScrollRecordId.current = null;
            followsTableTail.current = false;
            rowVirtualizer.scrollToIndex(virtualIndex, { behavior: 'smooth', align: 'center' });
            return;
        }
        pendingScrollRecordId.current = null;
        followsTableTail.current = false;
        const recordIndex = records[position]?.cell.index;
        const row = recordIndex === undefined
            ? null
            : rootRef.current?.querySelector(`tr[data-record-index="${recordIndex}"]`);
        /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
        if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [records, rowVirtualizer, virtualIndexByRecordId, virtualizationEnabled]);
    (0, react_1.useEffect)(() => {
        if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0)
            return;
        const focusedPositions = records.flatMap((record, position) => record.collapsedSummary === undefined
            && record.cell.requestOnly !== true
            && timelineFocusIndexes.has(record.cell.index)
            ? [position]
            : []);
        const first = focusedPositions.at(0);
        const last = focusedPositions.at(-1);
        if (first === undefined || last === undefined)
            return;
        if (!virtualizationEnabled) {
            const ledger = rootRef.current;
            if (ledger === null)
                return;
            const focusedRows = [
                ...ledger.querySelectorAll('tr[data-timeline-focus="inside"]'),
            ];
            const firstRow = focusedRows.at(0);
            const lastRow = focusedRows.at(-1);
            if (firstRow === undefined || lastRow === undefined)
                return;
            const focusHeight = lastRow.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top;
            const target = focusHeight > ledger.clientHeight
                ? firstRow
                : focusedRows[Math.floor((focusedRows.length - 1) / 2)];
            /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
            if (target !== undefined && typeof target.scrollIntoView === 'function') {
                followsTableTail.current = false;
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: focusHeight > ledger.clientHeight ? 'start' : 'center',
                });
            }
            return;
        }
        const focusedVirtualIndexes = [...new Set(focusedPositions.flatMap((position) => {
                const record = records[position];
                if (record === undefined)
                    return [];
                const virtualIndex = virtualIndexByRecordId.get((0, trajectory_record_1.trajectoryRecordId)(record.cell));
                return virtualIndex === undefined ? [] : [virtualIndex];
            }))].sort((left, right) => left - right);
        const firstVirtual = focusedVirtualIndexes.at(0);
        const lastVirtual = focusedVirtualIndexes.at(-1);
        if (firstVirtual === undefined || lastVirtual === undefined)
            return;
        const paneHeight = tablePaneRef.current?.clientHeight ?? 0;
        const focusHeight = projectedVirtualRows
            .slice(firstVirtual, lastVirtual + 1)
            .reduce((height, row) => height + row.height, 0);
        followsTableTail.current = false;
        rowVirtualizer.scrollToIndex(focusHeight > paneHeight
            ? firstVirtual
            : focusedVirtualIndexes[Math.floor((focusedVirtualIndexes.length - 1) / 2)]
                ?? firstVirtual, {
            behavior: 'smooth',
            align: focusHeight > paneHeight ? 'start' : 'center',
        });
    }, [
        projectedVirtualRows,
        records,
        rowVirtualizer,
        timelineFocusIndexes,
        virtualIndexByRecordId,
        virtualizationEnabled,
    ]);
    const requestOlder = (0, react_1.useCallback)((pane, requireTop) => {
        if (!hasOlderRecords
            || onLoadOlder === undefined
            || loadingOlder.current
            || olderHistoryLoading
            || (requireTop && pane.scrollTop > OLDER_LOAD_THRESHOLD_PX))
            return;
        loadingOlder.current = true;
        setOlderLoading(true);
        olderLoadAnchor.current = {
            historyStartSeq,
            scrollHeight: pane.scrollHeight,
            scrollTop: pane.scrollTop,
        };
        void onLoadOlder().then((advanced) => {
            if (!advanced)
                olderLoadAnchor.current = null;
        }).finally(() => {
            loadingOlder.current = false;
            setOlderLoading(false);
        });
    }, [hasOlderRecords, historyStartSeq, olderHistoryLoading, onLoadOlder]);
    (0, react_1.useLayoutEffect)(() => {
        const pane = tablePaneRef.current;
        if (pane === null)
            return;
        const anchor = olderLoadAnchor.current;
        if (anchor !== null && anchor.historyStartSeq !== historyStartSeq) {
            if (!virtualizationEnabled) {
                pane.scrollTop = anchor.scrollTop + pane.scrollHeight - anchor.scrollHeight;
            }
            olderLoadAnchor.current = null;
            followsTableTail.current = false;
            return;
        }
        if (!tableScrollInitialized.current) {
            if (historyLoading)
                return;
            tableScrollInitialized.current = true;
            followsTableTail.current = true;
            if (virtualizationEnabled)
                rowVirtualizer.scrollToEnd({ behavior: 'auto' });
            else
                pane.scrollTop = pane.scrollHeight;
            setTableScrollReady(true);
            return;
        }
        if (!followsTableTail.current)
            return;
        if (virtualizationEnabled)
            rowVirtualizer.scrollToEnd({ behavior: 'auto' });
        else
            pane.scrollTop = pane.scrollHeight;
    }, [
        historyLoading,
        historyStartSeq,
        rowVirtualizer,
        virtualRowStructure,
        virtualizationEnabled,
    ]);
    const olderBusy = olderHistoryLoading || olderLoading;
    const showInitialLoading = historyLoading || !tableScrollReady;
    const historyRowOffset = hasOlderRecords ? 1 : 0;
    return ((0, jsx_runtime_1.jsxs)("div", { ref: rootRef, className: TrajectoryTable_styles_1.default.split, style: splitStyle, children: [(0, jsx_runtime_1.jsxs)("div", { ref: tablePaneRef, className: TrajectoryTable_styles_1.default.tablePane, "data-trajectory-scroll": "", onScroll: (event) => {
                    const pane = event.currentTarget;
                    followsTableTail.current =
                        pane.scrollHeight - pane.clientHeight - pane.scrollTop
                            <= BOTTOM_FOLLOW_THRESHOLD_PX;
                    requestOlder(pane, true);
                }, onClick: (event) => {
                    if (event.target === event.currentTarget)
                        clearAllSelections();
                }, children: [showInitialLoading && ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.historyLoading, role: "status", "aria-live": "polite", children: (0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default.historyLoadingBar, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.historyLoadingSpinner, "aria-hidden": "true" }), "Loading trajectory\u2026"] }) })), (0, jsx_runtime_1.jsxs)("table", { className: TrajectoryTable_styles_1.default.table, "data-scroll-ready": tableScrollReady || undefined, "aria-rowcount": records.length + historyRowOffset, children: [(0, jsx_runtime_1.jsxs)("colgroup", { children: [(0, jsx_runtime_1.jsx)("col", { className: TrajectoryTable_styles_1.default.eventColumn }), (0, jsx_runtime_1.jsx)("col", { className: TrajectoryTable_styles_1.default.contentColumn })] }), (0, jsx_runtime_1.jsxs)("tbody", { children: [hasOlderRecords && ((0, jsx_runtime_1.jsx)("tr", { className: TrajectoryTable_styles_1.default.historyLoadRow, "data-history-load": "", "aria-rowindex": 1, children: (0, jsx_runtime_1.jsx)("td", { colSpan: 2, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.historyLoadButton, disabled: olderBusy || onLoadOlder === undefined, "aria-label": olderBusy
                                                    ? 'Loading earlier history…'
                                                    : 'Load earlier history', onClick: () => {
                                                    const pane = tablePaneRef.current;
                                                    if (pane !== null)
                                                        requestOlder(pane, false);
                                                }, children: [olderBusy && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.historyLoadingSpinner, "aria-hidden": "true" })), (0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", children: olderBusy ? 'Loading earlier history…' : 'Load earlier history' }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.visuallyHidden, role: "status", "aria-live": "polite", children: olderBusy ? 'Loading earlier history…' : '' })] }) }) })), virtualTop > 0 && ((0, jsx_runtime_1.jsx)("tr", { className: TrajectoryTable_styles_1.default.virtualSpacer, "data-virtual-spacer": "top", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("td", { colSpan: 2, style: virtualSpacerStyle({
                                                '--trajectory-virtual-spacer-height': `${virtualTop}px`,
                                            }) }) })), renderedRecords.map(({ record, position, terminalRequestBoundary }) => ((0, jsx_runtime_1.jsx)(RecordPresentation, { cell: record.cell, children: ({ displayText, listDisplayText, resultText, toolCallOnly, toolCallText }) => {
                                            const isCollapsedSummary = record.collapsedSummary !== undefined;
                                            const isRequestOnly = record.cell.requestOnly === true;
                                            const isInitialSystem = record.cell.kind === 'system'
                                                && record.cell.index === allRecords[0]?.cell.index;
                                            const key = requestKey(record.turn, record.group);
                                            const request = requestBoundaries.get(key) === record.cell.index
                                                && !isCollapsedSummary
                                                && (record.turn === null || !collapsedTurns.has(record.turn))
                                                ? requestNumbers.get(key)
                                                : undefined;
                                            const requestInfo = request === undefined
                                                ? undefined
                                                : sessionRequestNumbers?.find(candidate => candidate.number === request);
                                            const requestStatus = requestInfo?.status
                                                ?? (record.cell.isError === true ? 'error' : undefined);
                                            const requestRunIndex = requestBoundaryRuns.get(record.cell.index) ?? 0;
                                            const requestBoundaryStyle = {
                                                '--request-boundary-offset': `${requestRunIndex * 8}px`,
                                            };
                                            const requestLabel = request === undefined
                                                ? undefined
                                                : `Request #${request}${requestInfo?.purpose === 'compaction' ? ' · Compaction' : ''}`;
                                            const requestSelected = request !== undefined
                                                && selectedRequest?.turn === record.turn
                                                && selectedRequest.group === record.group;
                                            const sectionActive = record.turn === null
                                                ? activeSection === record.section
                                                : activeTurn === record.turn;
                                            return ((0, jsx_runtime_1.jsxs)("tr", { tabIndex: isRequestOnly ? -1 : 0, "aria-rowindex": position + 1 + historyRowOffset, "aria-label": isCollapsedSummary
                                                    ? `Collapsed ${record.collapsedSummaryKind} summary, ${record.collapsedSummary}`
                                                    : isRequestOnly
                                                        ? `Request ${request ?? ''}, compaction`
                                                        : `${request === undefined ? '' : `Request ${request}, `}${KIND_LABEL[record.cell.kind]}, ${listDisplayText || 'no content'}`, "aria-selected": !isCollapsedSummary && !isRequestOnly && selectedIndex === record.cell.index, "data-kind": record.cell.kind, "data-trajectory-row-key": (0, trajectory_virtual_rows_1.trajectoryVirtualRecordKey)(record), "data-virtual-position": virtualizationEnabled ? position : undefined, "data-record-index": !isCollapsedSummary && !isRequestOnly
                                                    ? record.cell.index
                                                    : undefined, "data-request-only": isRequestOnly || undefined, "data-terminal-request-boundary": terminalRequestBoundary || undefined, "data-group-start": record.groupStart || undefined, "data-turn-start": record.turnStart || undefined, "data-error": record.cell.isError || undefined, "data-running": stateOf(record) === 'running' || undefined, "data-turn-end": record.turnEnd || undefined, "data-collapsed-summary": record.collapsedSummaryKind, "data-selected": !isCollapsedSummary && selectedIndex === record.cell.index || undefined, "data-timeline-focus": isCollapsedSummary || timelineFocusIndexes === null
                                                    ? undefined
                                                    : timelineFocusIndexes.has(record.cell.index) ? 'inside' : 'outside', onClick: isRequestOnly
                                                    ? undefined
                                                    : isCollapsedSummary
                                                        ? () => {
                                                            if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                                                                onToggleTurn(record.turn);
                                                            }
                                                            else
                                                                onToggleAssistant((0, trajectory_record_1.trajectoryRecordId)(record.cell));
                                                        }
                                                        : () => { selectRecord(record.cell.index); }, onDoubleClick: (event) => {
                                                    if (isCollapsedSummary || isRequestOnly)
                                                        return;
                                                    if (record.turn !== null && collapsedTurns.has(record.turn)) {
                                                        event.preventDefault();
                                                        onToggleTurn(record.turn);
                                                        return;
                                                    }
                                                    if (record.cell.kind === 'message'
                                                        && assistantToolCalls(allRecords, record.cell.index).length > 0) {
                                                        event.preventDefault();
                                                        onToggleAssistant((0, trajectory_record_1.trajectoryRecordId)(record.cell));
                                                        return;
                                                    }
                                                    if (!record.turnStart)
                                                        return;
                                                    if (record.turn === null)
                                                        return;
                                                    if (allRecords.filter(candidate => candidate.turn === record.turn
                                                        && candidate.cell.requestOnly !== true
                                                        && candidate.cell.kind !== 'system').length <= 1)
                                                        return;
                                                    event.preventDefault();
                                                    onToggleTurn(record.turn);
                                                }, onKeyDown: (event) => {
                                                    if (isRequestOnly)
                                                        return;
                                                    if (event.key !== 'Enter' && event.key !== ' ')
                                                        return;
                                                    event.preventDefault();
                                                    if (isCollapsedSummary) {
                                                        if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                                                            onToggleTurn(record.turn);
                                                        }
                                                        else
                                                            onToggleAssistant((0, trajectory_record_1.trajectoryRecordId)(record.cell));
                                                        return;
                                                    }
                                                    selectRecord(record.cell.index);
                                                }, children: [(0, jsx_runtime_1.jsxs)("td", { className: TrajectoryTable_styles_1.default.event, children: [request !== undefined && ((0, jsx_runtime_1.jsx)("button", { type: "button", className: requestSelected
                                                                    ? `${TrajectoryTable_styles_1.default.requestBoundaryControl} ${TrajectoryTable_styles_1.default.requestBoundaryControlActive}`
                                                                    : TrajectoryTable_styles_1.default.requestBoundaryControl, "aria-label": requestLabel, "aria-pressed": requestSelected, "data-label": requestLabel, "data-request-run-index": requestRunIndex, "data-request-status": requestStatus, style: requestBoundaryStyle, onClick: (event) => {
                                                                    event.stopPropagation();
                                                                    selectRequest({
                                                                        turn: record.turn,
                                                                        group: record.group,
                                                                        ...(requestInfo?.seq === undefined ? {} : { seq: requestInfo.seq }),
                                                                    });
                                                                }, onDoubleClick: (event) => { event.stopPropagation(); } })), record.turn !== null
                                                                && activeTurn === record.turn
                                                                && !isInitialSystem && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.turnRail, "aria-hidden": "true" })), !isCollapsedSummary && selectedIndex === record.cell.index && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.selectionRail, "aria-hidden": "true" })), !isCollapsedSummary
                                                                && !isRequestOnly
                                                                && record.turnStart && ((0, jsx_runtime_1.jsx)("span", { className: sectionActive
                                                                    ? `${TrajectoryTable_styles_1.default.turnLabel} ${TrajectoryTable_styles_1.default.turnLabelActive}`
                                                                    : TrajectoryTable_styles_1.default.turnLabel, "aria-label": sectionLabel(record.turn), children: record.turn === null
                                                                    ? sectionLabel(record.turn)
                                                                    : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.turnLabelFull, "aria-hidden": "true", children: sectionLabel(record.turn) }), (0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default.turnLabelCompact, "aria-hidden": "true", children: ["#", record.turn] })] })) })), (0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.eventInner, children: !isCollapsedSummary && !isRequestOnly && ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.kindSlot, children: (0, jsx_runtime_1.jsxs)("span", { className: `${TrajectoryTable_styles_1.default.kindTag} ${record.cell.kind === 'system'
                                                                            ? TrajectoryTable_styles_1.default.systemNeutral
                                                                            : record.cell.kind === 'context'
                                                                                ? TrajectoryTable_styles_1.default.contextGreen
                                                                                : record.cell.kind === 'compacted'
                                                                                    ? TrajectoryTable_styles_1.default.compacted
                                                                                    : record.cell.kind === 'tool'
                                                                                        ? TrajectoryTable_styles_1.default.toolAmber
                                                                                        : record.cell.kind === 'message'
                                                                                            ? TrajectoryTable_styles_1.default.assistantVioletBright
                                                                                            : record.cell.kind === 'subtool'
                                                                                                ? TrajectoryTable_styles_1.default.subtoolAmber
                                                                                                : TrajectoryTable_styles_1.default[record.cell.kind]}`, "data-role-kind": record.cell.kind, children: [(0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: KIND_LABEL[record.cell.kind], side: "right", children: (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.kindTagIcon, "aria-hidden": "true", children: KIND_ICON[record.cell.kind] }) }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.kindTagLabel, children: KIND_LABEL[record.cell.kind] })] }) })) })] }), (0, jsx_runtime_1.jsx)("td", { className: TrajectoryTable_styles_1.default.content, children: isRequestOnly
                                                            ? null
                                                            : record.collapsedSummary !== undefined
                                                                ? ((0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default.collapsedTurnContent, title: record.collapsedSummary, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.collapsedTurnEllipsis, children: "\u2026" }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.collapsedTurnText, children: record.collapsedSummary })] }))
                                                                : ((0, jsx_runtime_1.jsxs)("span", { className: resultText === undefined ? TrajectoryTable_styles_1.default.contentText : TrajectoryTable_styles_1.default.resultPreview, title: resultText === undefined
                                                                        ? listDisplayText
                                                                        : `${listDisplayText} → ${resultText}`, children: [(0, jsx_runtime_1.jsx)("span", { className: resultText === undefined ? undefined : TrajectoryTable_styles_1.default.resultRequest, children: (0, jsx_runtime_1.jsx)(RecordListText, { displayText: displayText, toolCallOnly: toolCallOnly, toolCallText: toolCallText }) }), resultText !== undefined && ((0, jsx_runtime_1.jsxs)("span", { className: record.cell.isError ? `${TrajectoryTable_styles_1.default.inlineResult} ${TrajectoryTable_styles_1.default.error}` : TrajectoryTable_styles_1.default.inlineResult, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.arrow, children: "\u2192" }), (0, jsx_runtime_1.jsx)("span", { className: resultText === 'No output'
                                                                                        ? `${TrajectoryTable_styles_1.default.inlineResultText} ${TrajectoryTable_styles_1.default.noOutputText}`
                                                                                        : TrajectoryTable_styles_1.default.inlineResultText, children: resultText })] }))] })) })] }));
                                        } }, (0, trajectory_virtual_rows_1.trajectoryVirtualRecordKey)(record)))), virtualBottom > 0 && ((0, jsx_runtime_1.jsx)("tr", { className: TrajectoryTable_styles_1.default.virtualSpacer, "data-virtual-spacer": "bottom", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("td", { colSpan: 2, style: virtualSpacerStyle({
                                                '--trajectory-virtual-spacer-height': `${virtualBottom}px`,
                                            }) }) }))] })] })] }), (selectedRequest !== null
                || promptSelected
                || (selected !== undefined && selectedState !== undefined)) && ((0, jsx_runtime_1.jsxs)("aside", { className: TrajectoryTable_styles_1.default.details, "aria-label": "Event details", style: detailsWidth === null ? undefined : { width: detailsWidth }, children: [(0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.detailsResizeHandle, role: "separator", "aria-label": "Resize event details", "aria-controls": "trajectory-detail-panel", "aria-orientation": "vertical", tabIndex: 0, title: "Drag to resize. Double-click to reset.", onDoubleClick: () => {
                            setDetailsWidth(null);
                            setToolRequestOffset(null);
                        }, onPointerDown: (event) => {
                            if (event.button !== 0)
                                return;
                            const details = event.currentTarget.parentElement;
                            if (details === null)
                                return;
                            const split = details.parentElement;
                            if (split === null)
                                return;
                            const splitWidth = split.getBoundingClientRect().width;
                            detailsResizeDrag.current = {
                                pointerId: event.pointerId,
                                startX: event.clientX,
                                startWidth: details.getBoundingClientRect().width,
                                splitWidth,
                                startToolRequestOffset: toolRequestOffset ?? (splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)),
                            };
                            event.currentTarget.setPointerCapture(event.pointerId);
                            event.preventDefault();
                        }, onPointerMove: (event) => {
                            const drag = detailsResizeDrag.current;
                            if (drag === null || drag.pointerId !== event.pointerId)
                                return;
                            const nextDetailsWidth = clampDetailsWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth);
                            setDetailsWidth(nextDetailsWidth);
                            setToolRequestOffset(drag.startToolRequestOffset
                                + (nextDetailsWidth - drag.startWidth) * TOOL_REQUEST_SHARE);
                        }, onPointerUp: (event) => {
                            if (detailsResizeDrag.current?.pointerId !== event.pointerId)
                                return;
                            detailsResizeDrag.current = null;
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }, onPointerCancel: () => {
                            detailsResizeDrag.current = null;
                        }, onKeyDown: (event) => {
                            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                                return;
                            const details = event.currentTarget.parentElement;
                            if (details === null)
                                return;
                            const split = details.parentElement;
                            if (split === null)
                                return;
                            const direction = event.key === 'ArrowLeft' ? 1 : -1;
                            const currentDetailsWidth = details.getBoundingClientRect().width;
                            const splitWidth = split.getBoundingClientRect().width;
                            const nextDetailsWidth = clampDetailsWidth(currentDetailsWidth + direction * DETAILS_RESIZE_STEP, splitWidth);
                            const currentToolRequestOffset = toolRequestOffset ?? (splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth));
                            setDetailsWidth(nextDetailsWidth);
                            setToolRequestOffset(currentToolRequestOffset
                                + (nextDetailsWidth - currentDetailsWidth) * TOOL_REQUEST_SHARE);
                            event.preventDefault();
                        } }), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.detailsHeader, children: [(0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.detailsTitle, children: selectedRequest !== null
                                    ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.requestDetailsDot, "aria-hidden": "true" }), (0, jsx_runtime_1.jsxs)("span", { className: TrajectoryTable_styles_1.default.requestDetailsName, children: ["Request #", selectedRequestNumber ?? '—'] }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.detailsLocation, children: selectedRequestInfo?.purpose === 'compaction'
                                                    ? `Compaction · ${sectionLabel(selectedRequest.turn)}`
                                                    : sectionLabel(selectedRequest.turn) })] }))
                                    : promptSelected
                                        ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: `${TrajectoryTable_styles_1.default.kindTag} ${TrajectoryTable_styles_1.default.systemNeutral}`, children: "SYSTEM" }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.detailsLocation, children: selected?.cell.text })] }))
                                        : selected !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: `${TrajectoryTable_styles_1.default.kindTag} ${selected.cell.kind === 'context'
                                                        ? TrajectoryTable_styles_1.default.contextGreen
                                                        : selected.cell.kind === 'compacted'
                                                            ? TrajectoryTable_styles_1.default.compacted
                                                            : selected.cell.kind === 'tool'
                                                                ? TrajectoryTable_styles_1.default.toolAmber
                                                                : selected.cell.kind === 'message'
                                                                    ? TrajectoryTable_styles_1.default.assistantVioletBright
                                                                    : selected.cell.kind === 'subtool'
                                                                        ? TrajectoryTable_styles_1.default.subtoolAmber
                                                                        : TrajectoryTable_styles_1.default[selected.cell.kind]}`, children: KIND_LABEL[selected.cell.kind] }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryTable_styles_1.default.detailsLocation, children: selected.cell.kind === 'compacted'
                                                        ? sectionLabel(selected.turn)
                                                        : `${sectionLabel(selected.turn)} · ${selected.group}` })] })) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: TrajectoryTable_styles_1.default.close, "aria-label": "Close details", onClick: clearInspectorSelection, children: (0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", children: "\u00D7" }) })] }), (0, jsx_runtime_1.jsx)("div", { className: TrajectoryTable_styles_1.default.detailTabs, role: "tablist", "aria-label": "Event details", children: selectedTabs.map(tab => ((0, jsx_runtime_1.jsx)("button", { id: `trajectory-detail-${tab.id}`, type: "button", role: "tab", "aria-controls": "trajectory-detail-panel", "aria-selected": activeTab === tab.id, className: activeTab === tab.id ? `${TrajectoryTable_styles_1.default.detailTab} ${TrajectoryTable_styles_1.default.detailTabActive}` : TrajectoryTable_styles_1.default.detailTab, onClick: () => { activateTab(tab.id); }, children: tab.label }, tab.id))) }), (0, jsx_runtime_1.jsxs)("div", { id: "trajectory-detail-panel", className: activeTab === 'overview'
                            ? `${TrajectoryTable_styles_1.default.detailBody} ${TrajectoryTable_styles_1.default.detailBodySummary}`
                            : TrajectoryTable_styles_1.default.detailBody, role: "tabpanel", "aria-labelledby": `trajectory-detail-${activeTab}`, children: [selectedRequest !== null
                                && selectedRequestState !== undefined
                                && activeTab === 'overview' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("dl", { className: `${TrajectoryTable_styles_1.default.overview} ${TrajectoryTable_styles_1.default.summaryScrollRegion}`, "data-summary-scroll-region": "", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Status" }), (0, jsx_runtime_1.jsx)("dd", { className: selectedRequestState === 'error' ? TrajectoryTable_styles_1.default.error : undefined, children: statusLabel(selectedRequestState) })] }), selectedRequestInfo?.purpose === 'compaction' && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Purpose" }), (0, jsx_runtime_1.jsx)("dd", { children: "Compaction" })] })), (selectedRequestInfo?.provider
                                                ?? selectedRequestInfo?.requestConfig?.provider) !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Provider" }), (0, jsx_runtime_1.jsx)("dd", { children: selectedRequestInfo?.provider
                                                            ?? selectedRequestInfo?.requestConfig?.provider })] })), (selectedRequestInfo?.model
                                                ?? selectedRequestInfo?.requestConfig?.model) !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Model" }), (0, jsx_runtime_1.jsx)("dd", { children: selectedRequestInfo?.model
                                                            ?? selectedRequestInfo?.requestConfig?.model })] })), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Tool calls" }), (0, jsx_runtime_1.jsx)("dd", { children: selectedRequestToolCalls })] }), selectedRequestSubtoolCalls > 0 && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Subtool calls" }), (0, jsx_runtime_1.jsx)("dd", { children: selectedRequestSubtoolCalls })] })), selectedRequestInfo?.error !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Error" }), (0, jsx_runtime_1.jsx)("dd", { className: TrajectoryTable_styles_1.default.error, children: selectedRequestInfo.error })] })), selectedRequestInfo?.retry !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Retry" }), (0, jsx_runtime_1.jsxs)("dd", { children: ["Scheduled ", selectedRequestInfo.retry, selectedRequestInfo.maxRetries === undefined
                                                                ? ''
                                                                : ` of ${selectedRequestInfo.maxRetries}`] })] })), selectedRequestInfo?.retryDelayMs !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Retry delay" }), (0, jsx_runtime_1.jsx)("dd", { children: formatDurationMs(selectedRequestInfo.retryDelayMs) })] })), selectedRequestResult !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Result" }), (0, jsx_runtime_1.jsx)("dd", { className: TrajectoryTable_styles_1.default.overviewParentLinks, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewHierarchyNavLink, onClick: () => {
                                                                openRecordSummary(selectedRequestResult);
                                                            }, children: [(0, jsx_runtime_1.jsx)("span", { children: selectedRequestInfo?.purpose === 'compaction'
                                                                        ? 'Compacted'
                                                                        : 'Assistant Message' }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewHierarchyJumpIconTight, size: 11 })] }) })] }))] }), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.overviewSections, children: [selectedRequestOptions !== undefined && ((0, jsx_runtime_1.jsx)(OverviewSection, { label: "Options", onOpen: () => { activateTab('options'); }, children: (0, jsx_runtime_1.jsx)(RequestOptions, { options: selectedRequestOptions, preview: true }) })), (0, jsx_runtime_1.jsx)(OverviewSection, { label: "Usage", onOpen: () => { activateTab('usage'); }, children: (0, jsx_runtime_1.jsx)(UsageRows, { usage: selectedRequestUsage }) }), (0, jsx_runtime_1.jsx)(OverviewSection, { label: "Timing", onOpen: () => { activateTab('timing'); }, children: (0, jsx_runtime_1.jsx)(RequestTiming, { assistant: selectedRequestAssistant, anchor: selectedRequestAnchor, request: selectedRequestInfo }) })] })] })), selectedRequest !== null && activeTab === 'options' && ((0, jsx_runtime_1.jsx)(RequestOptions, { options: selectedRequestOptions })), selectedRequest !== null && activeTab === 'usage' && ((0, jsx_runtime_1.jsx)(RequestUsagePanel, { usage: selectedRequestUsage, cumulative: selectedRequestCumulativeUsage })), selectedRequest !== null && activeTab === 'timing' && ((0, jsx_runtime_1.jsx)(RequestTiming, { assistant: selectedRequestAssistant, anchor: selectedRequestAnchor, request: selectedRequestInfo })), promptSelected
                                && selectedPreviousPrompt !== undefined
                                && activeTab === 'diff' && ((0, jsx_runtime_1.jsx)(SystemPromptDiff, { before: selectedPreviousPrompt, after: selectedPrompt })), promptSelected && activeTab === 'system-prompt' && (selectedPrompt.system === ''
                                ? (0, jsx_runtime_1.jsx)("p", { className: TrajectoryTable_styles_1.default.noPayload, children: "No system prompt in this request" })
                                : ((0, jsx_runtime_1.jsx)("div", { className: `${TrajectoryTable_styles_1.default.markdownPayload} ${TrajectoryTable_styles_1.default.systemPrompt}`, children: (0, jsx_runtime_1.jsx)(primitives_1.MarkdownText, { text: selectedPrompt.system }) }))), promptSelected && activeTab === 'tools' && ((0, jsx_runtime_1.jsx)(ToolCatalog, { tools: selectedPrompt.tools })), !promptSelected
                                && selected?.cell.kind === 'compacted'
                                && selectedState !== undefined
                                && activeTab === 'overview' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("dl", { className: `${TrajectoryTable_styles_1.default.overview} ${TrajectoryTable_styles_1.default.summaryScrollRegion}`, "data-summary-scroll-region": "", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Status" }), (0, jsx_runtime_1.jsx)("dd", { className: selectedState === 'error' ? TrajectoryTable_styles_1.default.error : undefined, children: statusLabel(selectedState) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Duration" }), (0, jsx_runtime_1.jsx)("dd", { children: (0, trajectory_record_1.formatElapsedSeconds)(selected.cell.timeSeconds) })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Tokens" }), (0, jsx_runtime_1.jsx)("dd", { children: "\u2014" })] })] }), selected.cell.outputDetail !== undefined && ((0, jsx_runtime_1.jsx)("div", { className: `${TrajectoryTable_styles_1.default.compactedSummary} ${TrajectoryTable_styles_1.default.summaryScrollRegion}`, "data-summary-scroll-region": "", children: (0, jsx_runtime_1.jsx)(MarkdownRecordContent, { record: selected, rendered: true, thinkingExpanded: thinkingExpanded, onThinkingExpandedChange: setThinkingExpanded, onOpenCall: openCallSummary }) }))] })), !promptSelected
                                && selected !== undefined
                                && selected.cell.kind !== 'compacted'
                                && selectedState !== undefined
                                && activeTab === 'overview' && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("dl", { className: `${TrajectoryTable_styles_1.default.overview} ${TrajectoryTable_styles_1.default.summaryScrollRegion}`, "data-summary-scroll-region": "", children: [selected.cell.messageSource !== undefined && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Source" }), (0, jsx_runtime_1.jsx)("dd", { className: TrajectoryTable_styles_1.default.overviewParentLinks, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewHierarchyNavLink, onClick: () => { activateTab('source'); }, children: [(0, jsx_runtime_1.jsx)("span", { children: messageSourceLabel(selected.cell.messageSource) }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewHierarchyJumpIconTight, size: 11 })] }) })] })), hasSelectedHierarchy && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: selectedAssistantRequestTarget !== undefined
                                                            ? 'Source'
                                                            : 'Hierarchy' }), (0, jsx_runtime_1.jsxs)("dd", { className: TrajectoryTable_styles_1.default.overviewParentLinks, children: [selectedAssistantRequestTarget !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewHierarchyNavLink, onClick: () => {
                                                                    selectRequest(selectedAssistantRequestTarget);
                                                                }, children: [(0, jsx_runtime_1.jsxs)("span", { children: ["Request #", selectedAssistantRequest ?? '—'] }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewHierarchyJumpIconTight, size: 11 })] })), selectedParentMessage !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewHierarchyNavLink, onClick: () => { openRecordSummary(selectedParentMessage); }, children: [(0, jsx_runtime_1.jsx)("span", { children: "Assistant Message" }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewHierarchyJumpIconTight, size: 11 })] })), selectedParentTool !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryTable_styles_1.default.overviewHierarchyNavLink, onClick: () => { openRecordSummary(selectedParentTool); }, children: [(0, jsx_runtime_1.jsx)("span", { children: "Tool Call" }), (0, jsx_runtime_1.jsx)(primitives_1.IconChevronRightOutline14, { className: TrajectoryTable_styles_1.default.overviewHierarchyJumpIconTight, size: 11 })] }))] })] })), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Status" }), (0, jsx_runtime_1.jsx)("dd", { className: selectedState === 'error' ? TrajectoryTable_styles_1.default.error : undefined, children: statusLabel(selectedState) })] }), selected.cell.kind === 'message' && ((0, jsx_runtime_1.jsx)(TokenRows, { cell: selected.cell })), (selected.cell.kind === 'user' || selected.cell.kind === 'context') && ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Duration" }), (0, jsx_runtime_1.jsx)("dd", { children: (0, trajectory_record_1.formatElapsedSeconds)(selected.cell.timeSeconds) })] }))] }), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTable_styles_1.default.overviewSections, children: [isMarkdownRecord(selected)
                                                ? ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: (0, jsx_runtime_1.jsx)(OverviewSection, { label: "Preview", onOpen: () => { activateTab('rendered'); }, children: (0, jsx_runtime_1.jsx)(MarkdownRecordContent, { record: selected, rendered: true, preview: true, thinkingExpanded: thinkingExpanded, onThinkingExpandedChange: setThinkingExpanded, onOpenCall: openCallSummary }) }) }))
                                                : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [selected.cell.inputDetail && ((0, jsx_runtime_1.jsx)(OverviewSection, { label: "Payload", onOpen: () => { activateTab('input'); }, children: (0, jsx_runtime_1.jsx)(RecordPayload, { record: selected, direction: "input", preview: true }) })), selected.cell.outputDetail && ((0, jsx_runtime_1.jsx)(OverviewSection, { label: "Result", onOpen: () => { activateTab('output'); }, children: (0, jsx_runtime_1.jsx)(RecordPayload, { record: selected, direction: "output", preview: true }) })), (0, jsx_runtime_1.jsx)(OverviewSection, { label: "Schema", onOpen: () => { activateTab('schema'); }, children: (0, jsx_runtime_1.jsx)(RecordSchema, { record: selected, preview: true }) })] })), selectedAssistantRequestTarget !== undefined && ((0, jsx_runtime_1.jsx)(OverviewSection, { label: "Request Timing", onOpen: () => {
                                                    selectRequest(selectedAssistantRequestTarget, 'timing');
                                                }, children: (0, jsx_runtime_1.jsx)(RecordTiming, { record: selected }) })), (selected.cell.kind === 'tool' || selected.cell.kind === 'subtool') && ((0, jsx_runtime_1.jsx)(OverviewSection, { label: "Timing", onOpen: () => { activateTab('timing'); }, children: (0, jsx_runtime_1.jsx)(RecordTiming, { record: selected }) }))] })] })), !promptSelected && selected !== undefined && activeTab === 'rendered' && ((0, jsx_runtime_1.jsx)(MarkdownRecordContent, { record: selected, rendered: true, thinkingExpanded: thinkingExpanded, onThinkingExpandedChange: setThinkingExpanded, onOpenCall: openCallSummary })), !promptSelected && selected !== undefined && activeTab === 'raw' && ((0, jsx_runtime_1.jsx)(MarkdownRecordContent, { record: selected, rendered: false, thinkingExpanded: thinkingExpanded, onThinkingExpandedChange: setThinkingExpanded, onOpenCall: openCallSummary })), !promptSelected && selected !== undefined && activeTab === 'source' && ((0, jsx_runtime_1.jsx)(MessageSource, { record: selected })), !promptSelected && selected !== undefined && activeTab === 'input' && ((0, jsx_runtime_1.jsx)(RecordPayload, { record: selected, direction: "input" })), !promptSelected && selected !== undefined && activeTab === 'output' && ((0, jsx_runtime_1.jsx)(RecordPayload, { record: selected, direction: "output" })), !promptSelected && selected !== undefined && activeTab === 'schema' && ((0, jsx_runtime_1.jsx)(RecordSchema, { record: selected })), !promptSelected && selected !== undefined && activeTab === 'timing' && ((0, jsx_runtime_1.jsx)(RecordTiming, { record: selected }))] })] }))] }));
}

},
"src/modules/trajectory/vendor/react-virtual/src/index.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/react-virtual/src/index.tsx
const process = {"env":{"NODE_ENV":"production"}};
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useVirtualizer = useVirtualizer;
exports.useWindowVirtualizer = useWindowVirtualizer;
const React = __importStar(require("react"));
const react_dom_1 = require("react-dom");
const index_1 = require("../../virtual-core/src/index");
__exportStar(require("../../virtual-core/src/index"), exports);
const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? React.useLayoutEffect : React.useEffect;
function useVirtualizerBase({ useFlushSync = true, directDomUpdates = false, directDomUpdatesMode = 'transform', ...options }) {
    const rerender = React.useReducer((x) => x + 1, 0)[1];
    // Mutable across renders so the onChange closure captured by setOptions
    // always reads the latest values without us having to re-create it.
    const directRef = React.useRef({
        enabled: directDomUpdates,
        mode: directDomUpdatesMode,
        container: null,
        lastSize: null,
        // Keyed by the element itself so a remounted node (same key, new DOM
        // node — e.g. when `enabled` is toggled off then on) is treated as fresh
        // and gets its style written.
        lastPositions: new WeakMap(),
        prevRange: null,
    });
    directRef.current.enabled = directDomUpdates;
    directRef.current.mode = directDomUpdatesMode;
    // Writes the size container's total extent to the DOM. Idempotent — guarded
    // by lastSize. Split out from applyDirectStyles so it can run *before* the
    // scroll-position sync in the _willUpdate effect: an end-anchored prepend
    // grows the total and bumps scrollOffset in the same pass, and if scrollTop
    // is written before the container has grown the browser clamps it to the
    // stale (shorter) scrollHeight, leaving a gap at the top until the next
    // scroll (visible only in directDomUpdates mode — React-rendered sizers get
    // their height during render).
    const applyContainerSize = (instance) => {
        const state = directRef.current;
        if (!state.enabled || !state.container)
            return;
        const totalSize = instance.getTotalSize();
        if (totalSize !== state.lastSize) {
            state.lastSize = totalSize;
            const sizeAxis = instance.options.horizontal ? 'width' : 'height';
            state.container.style[sizeAxis] = `${totalSize}px`;
        }
    };
    // Writes container size + item positions to the DOM. Idempotent — guarded
    // by lastSize / lastPositions. Called from onChange (covers scroll-driven
    // updates) and from a layout effect (covers post-render commits when refs
    // have just registered new items in elementsCache).
    const applyDirectStyles = (instance) => {
        const state = directRef.current;
        if (!state.enabled || !state.container)
            return;
        applyContainerSize(instance);
        const horizontal = !!instance.options.horizontal;
        const useTransform = state.mode === 'transform';
        const posAxis = horizontal ? 'left' : 'top';
        const scrollMargin = instance.options.scrollMargin;
        const items = instance.getVirtualItems();
        for (const item of items) {
            const next = item.start - scrollMargin;
            const el = instance.elementsCache.get(item.key);
            if (!el)
                continue;
            if (state.lastPositions.get(el) === next)
                continue;
            state.lastPositions.set(el, next);
            if (useTransform) {
                el.style.transform = horizontal
                    ? `translate3d(${next}px, 0, 0)`
                    : `translate3d(0, ${next}px, 0)`;
            }
            else {
                el.style[posAxis] = `${next}px`;
            }
        }
    };
    const resolvedOptions = {
        ...options,
        onChange: (instance, sync) => {
            const state = directRef.current;
            let shouldRerender = true;
            if (state.enabled) {
                applyDirectStyles(instance);
                // Only re-render on range / isScrolling changes
                const range = instance.range;
                const prev = state.prevRange;
                shouldRerender =
                    !prev ||
                        prev.isScrolling !== instance.isScrolling ||
                        prev.startIndex !== range?.startIndex ||
                        prev.endIndex !== range?.endIndex;
                if (shouldRerender) {
                    state.prevRange = range
                        ? {
                            startIndex: range.startIndex,
                            endIndex: range.endIndex,
                            isScrolling: instance.isScrolling,
                        }
                        : null;
                }
            }
            if (shouldRerender) {
                if (useFlushSync && sync) {
                    (0, react_dom_1.flushSync)(rerender);
                }
                else {
                    rerender();
                }
            }
            options.onChange?.(instance, sync);
        },
    };
    const [instance] = React.useState(() => {
        const v = new index_1.Virtualizer(resolvedOptions);
        return Object.assign(v, {
            containerRef: (node) => {
                const state = directRef.current;
                state.container = node;
                state.lastSize = null;
                if (node && state.enabled) {
                    const total = v.getTotalSize();
                    state.lastSize = total;
                    const axis = v.options.horizontal ? 'width' : 'height';
                    node.style[axis] = `${total}px`;
                }
            },
        });
    });
    instance.setOptions(resolvedOptions);
    useIsomorphicLayoutEffect(() => {
        return instance._didMount();
    }, []);
    useIsomorphicLayoutEffect(() => {
        // Grow the size container to the new total BEFORE _willUpdate syncs the
        // scroll position. On an end-anchored prepend the scroll target lands at
        // the new bottom; if the container is still at its old (shorter) height the
        // browser clamps the scrollTop write and the list is left with a gap at the
        // top until the next scroll. Positions are written afterwards by the
        // applyDirectStyles effect below.
        applyContainerSize(instance);
        return instance._willUpdate();
    });
    // After every render commit, newly mounted item refs have registered in
    // elementsCache; write their positions to the DOM so the user doesn't see
    // them at (0, 0) until the next onChange.
    useIsomorphicLayoutEffect(() => {
        applyDirectStyles(instance);
    });
    return instance;
}
function useVirtualizer(options) {
    return useVirtualizerBase({
        observeElementRect: index_1.observeElementRect,
        observeElementOffset: index_1.observeElementOffset,
        scrollToFn: index_1.elementScroll,
        ...options,
    });
}
function useWindowVirtualizer(options) {
    return useVirtualizerBase({
        getScrollElement: () => (typeof document !== 'undefined' ? window : null),
        observeElementRect: index_1.observeWindowRect,
        observeElementOffset: index_1.observeWindowOffset,
        scrollToFn: index_1.windowScroll,
        initialOffset: () => (typeof document !== 'undefined' ? window.scrollY : 0),
        ...options,
    });
}

},
"src/modules/trajectory/vendor/virtual-core/src/index.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/virtual-core/src/index.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Virtualizer = exports.elementScroll = exports.windowScroll = exports.measureElement = exports.observeWindowOffset = exports.observeElementOffset = exports.observeWindowRect = exports.observeElementRect = exports.defaultRangeExtractor = exports.defaultKeyExtractor = exports.notUndefined = exports.memo = exports.debounce = exports.approxEqual = exports._resetIOSDetectionForTests = void 0;
const lazy_measurements_1 = require("./lazy-measurements");
const utils_1 = require("./utils");
// Browser-aware iOS detection. Programmatic `scrollTo`/`scrollTop` writes
// during a momentum-scroll cancel the momentum on iOS WebKit, so we defer
// scroll-position adjustments triggered by mid-scroll resizes until the
// scroll settles. SSR-safe (returns false when navigator is unavailable).
let _isIOSResult;
const isIOSWebKit = () => {
    if (_isIOSResult !== undefined)
        return _isIOSResult;
    if (typeof navigator === 'undefined')
        return (_isIOSResult = false);
    if (/iP(hone|od|ad)/.test(navigator.userAgent))
        return (_isIOSResult = true);
    // iPadOS 13+ reports as MacIntel; touch-points distinguishes it from desktop.
    const mtp = navigator
        .maxTouchPoints;
    return (_isIOSResult =
        navigator.platform === 'MacIntel' && mtp !== undefined && mtp > 0);
};
// Test hook: reset the iOS detection cache. Not exported.
const _resetIOSDetectionForTests = () => {
    _isIOSResult = undefined;
};
exports._resetIOSDetectionForTests = _resetIOSDetectionForTests;
var utils_2 = require("./utils");
Object.defineProperty(exports, "approxEqual", { enumerable: true, get: function () { return utils_2.approxEqual; } });
Object.defineProperty(exports, "debounce", { enumerable: true, get: function () { return utils_2.debounce; } });
Object.defineProperty(exports, "memo", { enumerable: true, get: function () { return utils_2.memo; } });
Object.defineProperty(exports, "notUndefined", { enumerable: true, get: function () { return utils_2.notUndefined; } });
//
const getRect = (element) => {
    const { offsetWidth, offsetHeight } = element;
    return { width: offsetWidth, height: offsetHeight };
};
const defaultKeyExtractor = (index) => index;
exports.defaultKeyExtractor = defaultKeyExtractor;
const defaultRangeExtractor = (range) => {
    const start = Math.max(range.startIndex - range.overscan, 0);
    const end = Math.min(range.endIndex + range.overscan, range.count - 1);
    const len = end - start + 1;
    const arr = new Array(len);
    for (let i = 0; i < len; i++) {
        arr[i] = start + i;
    }
    return arr;
};
exports.defaultRangeExtractor = defaultRangeExtractor;
const observeElementRect = (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) {
        return;
    }
    const targetWindow = instance.targetWindow;
    if (!targetWindow) {
        return;
    }
    const handler = (rect) => {
        const { width, height } = rect;
        cb({ width: Math.round(width), height: Math.round(height) });
    };
    handler(getRect(element));
    if (!targetWindow.ResizeObserver) {
        return () => { };
    }
    const observer = new targetWindow.ResizeObserver((entries) => {
        const run = () => {
            const entry = entries[0];
            if (entry?.borderBoxSize) {
                const box = entry.borderBoxSize[0];
                if (box) {
                    handler({ width: box.inlineSize, height: box.blockSize });
                    return;
                }
            }
            handler(getRect(element));
        };
        instance.options.useAnimationFrameWithResizeObserver
            ? requestAnimationFrame(run)
            : run();
    });
    observer.observe(element, { box: 'border-box' });
    return () => {
        observer.unobserve(element);
    };
};
exports.observeElementRect = observeElementRect;
const addEventListenerOptions = {
    passive: true,
};
const observeWindowRect = (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) {
        return;
    }
    const handler = () => {
        cb({ width: element.innerWidth, height: element.innerHeight });
    };
    handler();
    element.addEventListener('resize', handler, addEventListenerOptions);
    return () => {
        element.removeEventListener('resize', handler);
    };
};
exports.observeWindowRect = observeWindowRect;
const supportsScrollend = typeof window == 'undefined' ? true : 'onscrollend' in window;
// Shared core: both element and window variants attach scroll/scrollend
// listeners with the same lifecycle; they only differ in how to read the
// current offset from the scroll target.
const observeOffset = (instance, cb, readOffset) => {
    const element = instance.scrollElement;
    if (!element) {
        return;
    }
    const targetWindow = instance.targetWindow;
    if (!targetWindow) {
        return;
    }
    const registerScrollendEvent = instance.options.useScrollendEvent && supportsScrollend;
    let offset = 0;
    const fallback = registerScrollendEvent
        ? null
        : (0, utils_1.debounce)(targetWindow, () => cb(offset, false), instance.options.isScrollingResetDelay);
    const createHandler = (isScrolling) => () => {
        offset = readOffset(element);
        fallback?.();
        cb(offset, isScrolling);
    };
    const handler = createHandler(true);
    const endHandler = createHandler(false);
    element.addEventListener('scroll', handler, addEventListenerOptions);
    if (registerScrollendEvent) {
        element.addEventListener('scrollend', endHandler, addEventListenerOptions);
    }
    return () => {
        element.removeEventListener('scroll', handler);
        if (registerScrollendEvent) {
            element.removeEventListener('scrollend', endHandler);
        }
    };
};
const observeElementOffset = (instance, cb) => observeOffset(instance, cb, (el) => {
    const { horizontal, isRtl } = instance.options;
    return horizontal ? el.scrollLeft * ((isRtl && -1) || 1) : el.scrollTop;
});
exports.observeElementOffset = observeElementOffset;
const observeWindowOffset = (instance, cb) => observeOffset(instance, cb, (win) => instance.options.horizontal ? win.scrollX : win.scrollY);
exports.observeWindowOffset = observeWindowOffset;
const measureElement = (element, entry, instance) => {
    // When useCachedMeasurements is enabled, return the cached size
    // (or estimateSize as fallback) instead of measuring the DOM.
    if (instance.options.useCachedMeasurements) {
        const index = instance.indexFromElement(element);
        const key = instance.options.getItemKey(index);
        return (instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index));
    }
    if (entry?.borderBoxSize) {
        const box = entry.borderBoxSize[0];
        if (box) {
            const size = Math.round(box[instance.options.horizontal ? 'inlineSize' : 'blockSize']);
            return size;
        }
    }
    // When called without a ResizeObserverEntry (sync measurement path),
    // return the previously measured size if available. This avoids a
    // synchronous layout read (offsetWidth/offsetHeight) on re-renders.
    // The ResizeObserver is already observing the element and will deliver
    // the accurate size asynchronously if it changed.
    // Users who need synchronous DOM reads can provide a custom measureElement.
    if (!entry) {
        const index = instance.indexFromElement(element);
        const key = instance.options.getItemKey(index);
        const cachedSize = instance.itemSizeCache.get(key);
        if (cachedSize !== undefined) {
            return cachedSize;
        }
    }
    return element[instance.options.horizontal ? 'offsetWidth' : 'offsetHeight'];
};
exports.measureElement = measureElement;
const scrollWithAdjustments = (offset, { adjustments = 0, behavior, }, instance) => {
    instance.scrollElement?.scrollTo?.({
        [instance.options.horizontal ? 'left' : 'top']: offset + adjustments,
        behavior,
    });
};
exports.windowScroll = scrollWithAdjustments;
exports.elementScroll = scrollWithAdjustments;
class Virtualizer {
    constructor(opts) {
        this.unsubs = [];
        this.scrollElement = null;
        this.targetWindow = null;
        this.isScrolling = false;
        this.scrollState = null;
        this.measurementsCache = [];
        // Flat backing store for the lanes===1 fast path: [start_0, size_0, start_1, size_1, ...].
        // null until the first single-lane build; reused (and grown) across rebuilds.
        this._flatMeasurements = null;
        this.itemSizeCache = new Map();
        this.itemSizeCacheVersion = 0;
        this.laneAssignments = new Map(); // index → lane cache
        // Earliest index dirtied since last getMeasurements() rebuild, or null.
        this.pendingMin = null;
        this.prevLanes = undefined;
        this.lanesChangedFlag = false;
        this.lanesSettling = false;
        this.pendingScrollAnchor = null;
        this.scrollRect = null;
        this.scrollOffset = null;
        this.scrollDirection = null;
        this.scrollAdjustments = 0;
        // Sum of size-change deltas above-viewport that were skipped during
        // iOS momentum scroll (writing scrollTop mid-momentum cancels it).
        // Flushed in a single scrollTo when iOS is fully settled.
        this._iosDeferredAdjustment = 0;
        // Touch state. iOS WebKit cancels momentum when scrollTop is written, so
        // we defer adjustments not only during `isScrolling` but also through the
        // touchstart→touchend window (active drag) and a short tail after
        // touchend (early-momentum window — iOS only fires touch events once at
        // the start of momentum, so we use a timer rather than another event).
        this._iosTouching = false;
        this._iosJustTouchEnded = false;
        this._iosTouchEndTimerId = null;
        // Subpixel reconciliation. Safari (and Chrome/Firefox under certain DPRs)
        // round scrollTop/scrollLeft writes to integer pixels. If we wrote 12345.5
        // but the browser reports back 12346, the next reconcileScroll sees a
        // "target changed" and re-fires scrollTo — a feedback loop that the
        // approxEqual(<1.01) tolerance otherwise absorbs as a workaround.
        // By remembering the intended value of our most-recent self-driven
        // scrollTo, we can match the browser's rounded read back to the intended
        // value when the diff is < 1.5 px, distinguishing it from a real user
        // scroll. The +0.5 over Math.abs lets us also absorb the +1 / -1 cases.
        this._intendedScrollOffset = null;
        this.elementsCache = new Map();
        this.now = () => this.targetWindow?.performance?.now?.() ?? Date.now();
        this.observer = (() => {
            let _ro = null;
            const get = () => {
                if (_ro) {
                    return _ro;
                }
                if (!this.targetWindow || !this.targetWindow.ResizeObserver) {
                    return null;
                }
                return (_ro = new this.targetWindow.ResizeObserver((entries) => {
                    entries.forEach((entry) => {
                        const run = () => {
                            const node = entry.target;
                            const index = this.indexFromElement(node);
                            if (!node.isConnected) {
                                this.observer.unobserve(node);
                                // Find the cache entry pointing to this exact node and remove
                                // it. We can't call getItemKey(index) here because items may
                                // have been removed since this node was rendered — the index
                                // could be stale and out-of-bounds in the user's data array
                                // (regression test in e2e/.../stale-index.spec.ts, fix #1148).
                                // The === comparison naturally handles the React-replaced-
                                // a-node-for-the-same-key case: that entry now points to a
                                // different node, so this loop won't match.
                                for (const [cacheKey, cachedNode] of this.elementsCache) {
                                    if (cachedNode === node) {
                                        this.elementsCache.delete(cacheKey);
                                        break;
                                    }
                                }
                                return;
                            }
                            if (this.shouldMeasureDuringScroll(index)) {
                                this.resizeItem(index, this.options.measureElement(node, entry, this));
                            }
                        };
                        this.options.useAnimationFrameWithResizeObserver
                            ? requestAnimationFrame(run)
                            : run();
                    });
                }));
            };
            return {
                disconnect: () => {
                    get()?.disconnect();
                    _ro = null;
                },
                observe: (target) => get()?.observe(target, { box: 'border-box' }),
                unobserve: (target) => get()?.unobserve(target),
            };
        })();
        this.range = null;
        this.setOptions = (opts) => {
            // Skip `{...defaults, ...opts}` because explicit `undefined` values in
            // opts would override defaults with `undefined`.
            const merged = {
                debug: false,
                initialOffset: 0,
                overscan: 1,
                paddingStart: 0,
                paddingEnd: 0,
                scrollPaddingStart: 0,
                scrollPaddingEnd: 0,
                horizontal: false,
                getItemKey: exports.defaultKeyExtractor,
                rangeExtractor: exports.defaultRangeExtractor,
                onChange: () => { },
                measureElement: exports.measureElement,
                initialRect: { width: 0, height: 0 },
                scrollMargin: 0,
                gap: 0,
                indexAttribute: 'data-index',
                initialMeasurementsCache: [],
                lanes: 1,
                anchorTo: 'start',
                followOnAppend: false,
                scrollEndThreshold: 1,
                isScrollingResetDelay: 150,
                enabled: true,
                isRtl: false,
                useScrollendEvent: false,
                useAnimationFrameWithResizeObserver: false,
                laneAssignmentMode: 'estimate',
                useCachedMeasurements: false,
            };
            for (const key in opts) {
                const v = opts[key];
                if (v !== undefined)
                    merged[key] = v;
            }
            const prevOptions = this.options;
            let anchor = null;
            let followOnAppend = null;
            let edgeKeysChanged = false;
            if (prevOptions !== undefined &&
                prevOptions.enabled &&
                merged.enabled &&
                merged.anchorTo === 'end' &&
                this.scrollElement !== null) {
                const prevCount = prevOptions.count;
                const nextCount = merged.count;
                const measurements = this.getMeasurements();
                const prevFirstKey = prevCount > 0
                    ? (measurements[0]?.key ?? prevOptions.getItemKey(0))
                    : null;
                const prevLastKey = prevCount > 0
                    ? (measurements[prevCount - 1]?.key ??
                        prevOptions.getItemKey(prevCount - 1))
                    : null;
                const didCountChange = nextCount !== prevCount;
                const didEdgeKeysChange = didCountChange ||
                    (prevCount > 0 &&
                        nextCount > 0 &&
                        (merged.getItemKey(0) !== prevFirstKey ||
                            merged.getItemKey(nextCount - 1) !== prevLastKey));
                if (didEdgeKeysChange) {
                    edgeKeysChanged = true;
                    const item = prevCount > 0
                        ? (this.getVirtualItemForOffset(this.getScrollOffset()) ??
                            measurements[0])
                        : null;
                    if (item) {
                        anchor = [item.key, this.getScrollOffset() - item.start];
                    }
                    const behavior = merged.followOnAppend === true
                        ? 'auto'
                        : merged.followOnAppend || null;
                    if (behavior &&
                        nextCount > prevCount &&
                        this.isAtEnd(prevOptions.scrollEndThreshold) &&
                        (prevCount === 0 || merged.getItemKey(nextCount - 1) !== prevLastKey)) {
                        followOnAppend = behavior;
                    }
                }
            }
            this.options = merged;
            // When edge keys changed (prepend, trim, reorder, etc.) the key→index
            // mapping has shifted. Force a full measurement rebuild so the anchor
            // resolution below reads positions from the new layout, not the stale
            // memoised cache. Without this, a stable `getItemKey` reference +
            // unchanged `count` would let getMeasurements() return the old layout.
            if (edgeKeysChanged) {
                this.pendingMin = 0;
                this.itemSizeCacheVersion++;
            }
            // Eagerly adjust scrollOffset so the virtualizer computes the correct
            // visible range during the current render pass — before _willUpdate
            // syncs the DOM scroll position in a layout effect. Without this,
            // the virtualizer would render the wrong items for one frame (the
            // estimate-based positions are stale) and then correct in the next
            // frame, producing a visible "jump" on prepend with dynamic sizes.
            let anchorResolved = false;
            let anchorDelta = 0;
            if (anchor && this.scrollOffset !== null) {
                const [anchorKey, anchorOffset] = anchor;
                const newMeasurements = this.getMeasurements();
                const { count, getItemKey } = this.options;
                let idx = 0;
                while (idx < count && getItemKey(idx) !== anchorKey) {
                    idx++;
                }
                if (idx < count) {
                    const anchorItem = newMeasurements[idx];
                    if (anchorItem) {
                        // Clamp to the reachable range's lower bound — anchorOffset may
                        // have been derived from a transiently negative scrollOffset
                        // (rubber-band), and a negative tracked offset never self-heals
                        // when the element cannot scroll (#1229).
                        const newOffset = Math.max(0, anchorItem.start + anchorOffset);
                        if (newOffset !== this.scrollOffset) {
                            anchorDelta = newOffset - this.scrollOffset;
                            this.scrollOffset = newOffset;
                            anchorResolved = true;
                        }
                    }
                }
            }
            if (anchorResolved || followOnAppend) {
                this.pendingScrollAnchor = [
                    anchorResolved ? anchor[0] : null,
                    anchorResolved ? anchor[1] : 0,
                    followOnAppend,
                    anchorDelta,
                ];
            }
        };
        this.notify = (sync) => {
            this.options.onChange?.(this, sync);
        };
        this.maybeNotify = (0, utils_1.memo)(() => {
            this.calculateRange();
            return [
                this.isScrolling,
                this.range ? this.range.startIndex : null,
                this.range ? this.range.endIndex : null,
            ];
        }, (isScrolling) => {
            this.notify(isScrolling);
        }, {
            key: process.env.NODE_ENV !== 'production' && 'maybeNotify',
            debug: () => this.options.debug,
            initialDeps: [
                this.isScrolling,
                this.range ? this.range.startIndex : null,
                this.range ? this.range.endIndex : null,
            ],
        });
        this.cleanup = () => {
            this.unsubs.filter(Boolean).forEach((d) => d());
            this.unsubs = [];
            this.observer.disconnect();
            if (this.rafId != null && this.targetWindow) {
                this.targetWindow.cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
            this.scrollState = null;
            // The iOS gesture/deferral state is scoped to the current scroll
            // element: the touch listeners that maintain it were just removed, and
            // an in-flight touch keeps targeting the old element (implicit touch
            // capture), so the new element never reports it. Carrying the state
            // over would replay a stale deferred delta on the new element's first
            // flush, and a cleanup that lands mid-touch or inside the post-touchend
            // grace window would strand _iosTouching / _iosJustTouchEnded as true
            // (the listener unsub clears the grace timer, and with it the only
            // pending reset of the flag), deferring every adjustment on the new
            // element until its next touch cycle.
            this._iosDeferredAdjustment = 0;
            this._iosTouching = false;
            this._iosJustTouchEnded = false;
            this.scrollElement = null;
            this.targetWindow = null;
        };
        this._didMount = () => {
            return () => {
                this.cleanup();
            };
        };
        this._willUpdate = () => {
            const scrollElement = this.options.enabled
                ? this.options.getScrollElement()
                : null;
            if (this.scrollElement !== scrollElement) {
                this.cleanup();
                if (!scrollElement) {
                    this.maybeNotify();
                    return;
                }
                this.scrollElement = scrollElement;
                if (this.scrollElement && 'ownerDocument' in this.scrollElement) {
                    this.targetWindow = this.scrollElement.ownerDocument.defaultView;
                }
                else {
                    this.targetWindow = this.scrollElement?.window ?? null;
                }
                this.elementsCache.forEach((cached) => {
                    this.observer.observe(cached);
                });
                this.unsubs.push(this.options.observeElementRect(this, (rect) => {
                    this.scrollRect = rect;
                    this.maybeNotify();
                }));
                this.unsubs.push(this.options.observeElementOffset(this, (offset, isScrolling) => {
                    // A scroll event that reports movement but lands on the offset we
                    // already hold — and isn't a self-write read-back — is a spurious
                    // no-op re-emit that Safari/Firefox fire after a re-render's layout
                    // (Chrome doesn't). Treating it as scrolling re-arms `isScrolling`,
                    // which forces a render that triggers another such event: an
                    // infinite re-render loop. Ignore it. (Self-writes are handled by
                    // the `_intendedScrollOffset` reconciliation just below.)
                    if (isScrolling &&
                        this._intendedScrollOffset === null &&
                        offset === this.scrollOffset) {
                        return;
                    }
                    // If this scroll event looks like the browser's read-back of a
                    // value we just wrote, prefer our intended (sub-pixel-accurate)
                    // value over the browser's rounded one. The 1.5 px tolerance is
                    // tight enough to avoid mistaking a real user scroll for a
                    // self-write — by the time the user has moved 1.5 px, the
                    // intended value will already have been consumed by a prior
                    // scroll event and cleared.
                    if (this._intendedScrollOffset !== null &&
                        Math.abs(offset - this._intendedScrollOffset) < 1.5) {
                        offset = this._intendedScrollOffset;
                    }
                    this._intendedScrollOffset = null;
                    this.scrollAdjustments = 0;
                    // If the offset hasn't moved, this is the echo of our own
                    // adjustment write — `applyScrollAdjustment` already folded it
                    // into `scrollOffset`. There's no direction to infer, so leave
                    // it alone; a real gesture always moves the offset.
                    const prevOffset = this.getScrollOffset();
                    this.scrollDirection = isScrolling
                        ? prevOffset === offset
                            ? this.scrollDirection
                            : prevOffset < offset
                                ? 'forward'
                                : 'backward'
                        : null;
                    this.scrollOffset = offset;
                    this.isScrolling = isScrolling;
                    // Flush deferred iOS adjustments if we're now fully settled.
                    // "Fully settled" means: not actively scrolling, no finger on
                    // screen, and the post-touchend grace window has expired.
                    this._flushIosDeferredIfReady();
                    if (this.scrollState) {
                        this.scheduleScrollReconcile();
                    }
                    this.maybeNotify();
                }));
                // Touch event listeners (iOS-aware deferral). We attach unconditionally
                // — the listeners are passive and cheap; on non-touch devices they
                // simply never fire. The gating by isIOSWebKit() lives in resizeItem
                // and _flushIosDeferredIfReady so we only burn the path on iOS.
                if ('addEventListener' in this.scrollElement) {
                    const scrollEl = this.scrollElement;
                    const onTouchStart = () => {
                        this._iosTouching = true;
                        this._iosJustTouchEnded = false;
                        if (this._iosTouchEndTimerId !== null && this.targetWindow != null) {
                            this.targetWindow.clearTimeout(this._iosTouchEndTimerId);
                            this._iosTouchEndTimerId = null;
                        }
                    };
                    const onTouchEnd = () => {
                        this._iosTouching = false;
                        if (!isIOSWebKit() || this.targetWindow == null) {
                            // Non-iOS: nothing more to track. Just clear the touching flag.
                            return;
                        }
                        this._iosJustTouchEnded = true;
                        // After ~150 ms with no scroll/touch events, momentum is done.
                        this._iosTouchEndTimerId = this.targetWindow.setTimeout(() => {
                            this._iosJustTouchEnded = false;
                            this._iosTouchEndTimerId = null;
                            // After the grace window, attempt to flush. The scroll event
                            // for momentum decay may have already fired before our timer.
                            this._flushIosDeferredIfReady();
                        }, 150);
                    };
                    scrollEl.addEventListener('touchstart', onTouchStart, addEventListenerOptions);
                    scrollEl.addEventListener('touchend', onTouchEnd, addEventListenerOptions);
                    this.unsubs.push(() => {
                        scrollEl.removeEventListener('touchstart', onTouchStart);
                        scrollEl.removeEventListener('touchend', onTouchEnd);
                        if (this._iosTouchEndTimerId !== null && this.targetWindow != null) {
                            this.targetWindow.clearTimeout(this._iosTouchEndTimerId);
                            this._iosTouchEndTimerId = null;
                        }
                    });
                }
                this._scrollToOffset(this.getScrollOffset(), {
                    adjustments: undefined,
                    behavior: undefined,
                });
            }
            const anchor = this.pendingScrollAnchor;
            this.pendingScrollAnchor = null;
            if (anchor && this.scrollElement && this.options.enabled) {
                const [key, _offset, followOnAppend, anchorDelta] = anchor;
                if (key !== null && !followOnAppend) {
                    // scrollOffset was eagerly adjusted in setOptions so the
                    // virtualizer already computed the correct range during render.
                    // Now sync the browser's actual scroll position to match.
                    // Skip when followOnAppend is set — scrollToEnd will handle it.
                    //
                    // On iOS WebKit, writing scrollTop during touch/momentum cancels
                    // the in-flight scroll. Defer the DOM sync the same way
                    // applyScrollAdjustment does — accumulate the delta and let
                    // _flushIosDeferredIfReady handle it once the scroll settles.
                    if (isIOSWebKit() &&
                        (this.isScrolling || this._iosTouching || this._iosJustTouchEnded)) {
                        if (anchorDelta !== 0) {
                            this._iosDeferredAdjustment += anchorDelta;
                        }
                    }
                    else {
                        this._scrollToOffset(this.getScrollOffset(), {
                            adjustments: undefined,
                            behavior: undefined,
                        });
                    }
                }
                if (followOnAppend) {
                    this.scrollToEnd({ behavior: followOnAppend });
                }
            }
        };
        // Apply any accumulated iOS-deferred scroll adjustment, but only when we're
        // truly settled — not actively scrolling, not under an active touch, and
        // past the post-touchend grace window. Called from the scroll callback
        // and the touchend grace-timer.
        this._flushIosDeferredIfReady = () => {
            if (this._iosDeferredAdjustment === 0)
                return;
            if (this.isScrolling)
                return;
            if (this._iosTouching)
                return;
            if (this._iosJustTouchEnded)
                return;
            // Phase 2b: Safari elastic-overscroll (rubber-band) lets scrollTop go
            // negative or beyond scrollHeight - clientHeight. Writing scrollTop
            // while in that zone snaps the page back to the clamped value at the
            // end of the bounce, often discarding the user's intent. Skip the
            // flush; the next in-bounds scroll event will retry.
            const cur = this.getScrollOffset();
            const max = this.getMaxScrollOffset();
            if (cur < 0 || cur > max)
                return;
            // At the end clamp the browser already absorbed a shrink above the
            // viewport (it clamped scrollTop onto the new bottom), so replaying our
            // deferred negative delta would lift the view off the bottom — drop it.
            // Positive deltas still replay: growth above doesn't clamp. (#1233)
            if (this._iosDeferredAdjustment < 0 && cur >= max - 1) {
                this._iosDeferredAdjustment = 0;
                return;
            }
            const delta = this._iosDeferredAdjustment;
            this._iosDeferredAdjustment = 0;
            // Roll the deferred delta into the running accumulator so any resize
            // landing between now and the resulting scroll event computes from the
            // post-flush offset rather than the stale one.
            this._scrollToOffset(cur, {
                adjustments: (this.scrollAdjustments += delta),
                behavior: undefined,
            });
        };
        this.rafId = null;
        this.getSize = () => {
            if (!this.options.enabled) {
                this.scrollRect = null;
                return 0;
            }
            this.scrollRect = this.scrollRect ?? this.options.initialRect;
            return this.scrollRect[this.options.horizontal ? 'width' : 'height'];
        };
        this.getScrollOffset = () => {
            if (!this.options.enabled) {
                this.scrollOffset = null;
                return 0;
            }
            this.scrollOffset =
                this.scrollOffset ??
                    (typeof this.options.initialOffset === 'function'
                        ? this.options.initialOffset()
                        : this.options.initialOffset);
            return this.scrollOffset;
        };
        this.getMeasurementOptions = (0, utils_1.memo)(() => [
            this.options.count,
            this.options.paddingStart,
            this.options.scrollMargin,
            this.options.getItemKey,
            this.options.enabled,
            this.options.lanes,
            this.options.laneAssignmentMode,
            this.options.gap,
        ], (count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode, gap) => {
            const lanesChanged = this.prevLanes !== undefined && this.prevLanes !== lanes;
            if (lanesChanged) {
                // Set flag for getMeasurements to handle
                this.lanesChangedFlag = true;
            }
            this.prevLanes = lanes;
            this.pendingMin = null;
            return {
                count,
                paddingStart,
                scrollMargin,
                getItemKey,
                enabled,
                lanes,
                laneAssignmentMode,
                gap,
            };
        }, {
            key: false,
        });
        this.getMeasurements = (0, utils_1.memo)(() => [this.getMeasurementOptions(), this.itemSizeCacheVersion], ({ count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode, gap, }, _itemSizeCacheVersion) => {
            const itemSizeCache = this.itemSizeCache;
            if (!enabled) {
                this.measurementsCache = [];
                this.itemSizeCache.clear();
                this.laneAssignments.clear();
                return [];
            }
            // Clean up stale lane cache entries when count decreases
            if (this.laneAssignments.size > count) {
                for (const index of this.laneAssignments.keys()) {
                    if (index >= count) {
                        this.laneAssignments.delete(index);
                    }
                }
            }
            // ✅ Force complete recalculation when lanes change
            if (this.lanesChangedFlag) {
                this.lanesChangedFlag = false; // Reset immediately
                this.lanesSettling = true; // Start settling period
                this.measurementsCache = [];
                this.itemSizeCache.clear();
                this.laneAssignments.clear(); // Clear lane cache for new lane count
                // Force min = 0 on the rebuild
                this.pendingMin = null;
            }
            // Don't restore from initialMeasurementsCache during lane changes
            // as it contains stale lane assignments from the previous lane count
            if (this.measurementsCache.length === 0 && !this.lanesSettling) {
                this.measurementsCache = this.options.initialMeasurementsCache;
                this.measurementsCache.forEach((item) => {
                    this.itemSizeCache.set(item.key, item.size);
                });
            }
            // During lanes settling, ignore pendingMin to prevent repositioning
            const min = this.lanesSettling ? 0 : (this.pendingMin ?? 0);
            this.pendingMin = null;
            // ✅ End settling period when cache is fully built
            if (this.lanesSettling && this.measurementsCache.length === count) {
                this.lanesSettling = false;
            }
            // ─── Fast path: single-lane lazy materialization ────────────────────
            // For lanes === 1 (the default and most common case), skip the
            // per-item VirtualItem object allocation. We write start/size pairs
            // into a Float64Array and return a Proxy that builds VirtualItem
            // objects on demand (only the indices a consumer actually reads).
            //
            // At n=100k this drops cold-mount cost from ~2.5ms (eager object
            // allocation) to roughly the cost of a single typed-array fill.
            if (lanes === 1) {
                // Reuse flat backing if large enough; else grow (preserving data
                // before `min` to mirror the slice-and-rebuild contract).
                const need = count * 2;
                let flat = this._flatMeasurements;
                if (!flat || flat.length < need) {
                    const next = new Float64Array(need);
                    if (flat && min > 0)
                        next.set(flat.subarray(0, min * 2));
                    flat = next;
                    this._flatMeasurements = flat;
                }
                let runningStart;
                if (min === 0) {
                    runningStart = paddingStart + scrollMargin;
                }
                else {
                    // Continue from where we left off
                    const prevIdx = min - 1;
                    runningStart = flat[prevIdx * 2] + flat[prevIdx * 2 + 1] + gap;
                }
                for (let i = min; i < count; i++) {
                    const key = getItemKey(i);
                    const measuredSize = itemSizeCache.get(key);
                    const size = typeof measuredSize === 'number'
                        ? measuredSize
                        : this.options.estimateSize(i);
                    flat[i * 2] = runningStart;
                    flat[i * 2 + 1] = size;
                    runningStart += size + gap;
                }
                const view = (0, lazy_measurements_1.createLazyMeasurementsView)(count, flat, getItemKey);
                this.measurementsCache = view;
                return view;
            }
            const measurements = this.measurementsCache.slice(0, min);
            // ✅ Performance: Track last item index per lane for O(1) lookup
            const laneLastIndex = new Array(lanes).fill(undefined);
            // Running end position of each lane's last item, so the shortest lane
            // can be found with an O(lanes) argmin instead of the old backward walk
            // through `measurements` (getFurthestMeasurement). `filledLanes` tracks
            // how many lanes have at least one item, mirroring the previous
            // "all lanes seen → shortest lane, else i % lanes" branch.
            const laneEnds = new Float64Array(lanes);
            let filledLanes = 0;
            // Initialize from existing measurements (before min)
            for (let m = 0; m < min; m++) {
                const item = measurements[m];
                if (item) {
                    if (laneLastIndex[item.lane] === undefined)
                        filledLanes++;
                    laneLastIndex[item.lane] = m;
                    laneEnds[item.lane] = item.end;
                }
            }
            for (let i = min; i < count; i++) {
                const key = getItemKey(i);
                // Check for cached lane assignment
                const cachedLane = this.laneAssignments.get(i);
                let lane;
                let start;
                const shouldCacheLane = laneAssignmentMode === 'estimate' || itemSizeCache.has(key);
                if (cachedLane !== undefined && this.options.lanes > 1) {
                    // Use cached lane - O(1) lookup for previous item in same lane
                    lane = cachedLane;
                    const prevIndex = laneLastIndex[lane];
                    const prevInLane = prevIndex !== undefined ? measurements[prevIndex] : undefined;
                    start = prevInLane
                        ? prevInLane.end + gap
                        : paddingStart + scrollMargin;
                }
                else if (filledLanes === lanes) {
                    // No cache, every lane seeded: place in the shortest lane.
                    // Read the running per-lane ends (O(lanes) argmin) instead of the
                    // old backward scan. Tie-break on the lane's last-item index to
                    // preserve the previous sort-by-(end, index) placement exactly.
                    let bestLane = 0;
                    let bestEnd = laneEnds[0];
                    let bestIdx = laneLastIndex[0];
                    for (let l = 1; l < lanes; l++) {
                        const e = laneEnds[l];
                        if (e < bestEnd || (e === bestEnd && laneLastIndex[l] < bestIdx)) {
                            bestLane = l;
                            bestEnd = e;
                            bestIdx = laneLastIndex[l];
                        }
                    }
                    lane = bestLane;
                    start = bestEnd + gap;
                    if (shouldCacheLane) {
                        this.laneAssignments.set(i, lane);
                    }
                }
                else {
                    // No cache and not every lane seeded yet — seed lanes in order,
                    // matching the previous `i % lanes` fallback for the first row.
                    lane = i % this.options.lanes;
                    start = paddingStart + scrollMargin;
                    if (shouldCacheLane) {
                        this.laneAssignments.set(i, lane);
                    }
                }
                const measuredSize = itemSizeCache.get(key);
                const size = typeof measuredSize === 'number'
                    ? measuredSize
                    : this.options.estimateSize(i);
                const end = start + size;
                measurements[i] = {
                    index: i,
                    start,
                    size,
                    end,
                    key,
                    lane,
                };
                // ✅ Performance: Update lane's last item index + running end
                if (laneLastIndex[lane] === undefined)
                    filledLanes++;
                laneLastIndex[lane] = i;
                laneEnds[lane] = end;
            }
            this.measurementsCache = measurements;
            return measurements;
        }, {
            key: process.env.NODE_ENV !== 'production' && 'getMeasurements',
            debug: () => this.options.debug,
        });
        this.calculateRange = (0, utils_1.memo)(() => [
            this.getMeasurements(),
            this.getSize(),
            this.getScrollOffset(),
            this.options.lanes,
        ], (measurements, outerSize, scrollOffset, lanes) => {
            if (measurements.length === 0 || outerSize === 0) {
                this.range = null;
                return null;
            }
            this.range = calculateRangeImpl(measurements, outerSize, scrollOffset, lanes,
            // Pass the typed array so binary search + forward-walk can read
            // start/end directly from Float64Array, skipping the Proxy traps.
            lanes === 1 && this._flatMeasurements != null
                ? this._flatMeasurements
                : null);
            return this.range;
        }, {
            key: process.env.NODE_ENV !== 'production' && 'calculateRange',
            debug: () => this.options.debug,
        });
        this.getVirtualIndexes = (0, utils_1.memo)(() => {
            let startIndex = null;
            let endIndex = null;
            const range = this.calculateRange();
            if (range) {
                startIndex = range.startIndex;
                endIndex = range.endIndex;
            }
            this.maybeNotify.updateDeps([this.isScrolling, startIndex, endIndex]);
            return [
                this.options.rangeExtractor,
                this.options.overscan,
                this.options.count,
                startIndex,
                endIndex,
            ];
        }, (rangeExtractor, overscan, count, startIndex, endIndex) => {
            return startIndex === null || endIndex === null
                ? []
                : rangeExtractor({
                    startIndex,
                    endIndex,
                    overscan,
                    count,
                });
        }, {
            key: process.env.NODE_ENV !== 'production' && 'getVirtualIndexes',
            debug: () => this.options.debug,
        });
        this.indexFromElement = (node) => {
            const attributeName = this.options.indexAttribute;
            const indexStr = node.getAttribute(attributeName);
            if (!indexStr) {
                console.warn(`Missing attribute name '${attributeName}={index}' on measured element.`);
                return -1;
            }
            return parseInt(indexStr, 10);
        };
        /**
         * Determines if an item at the given index should be measured during smooth scroll.
         * During smooth scroll, only items within a buffer range around the target are measured
         * to prevent items far from the target from pushing it away.
         */
        this.shouldMeasureDuringScroll = (index) => {
            // No scroll state or not smooth scroll - always allow measurements
            if (!this.scrollState || this.scrollState.behavior !== 'smooth') {
                return true;
            }
            const scrollIndex = this.scrollState.index ??
                this.getVirtualItemForOffset(this.scrollState.lastTargetOffset)?.index;
            if (scrollIndex !== undefined && this.range) {
                // Allow measurements within a buffer range around the scroll target
                const bufferSize = Math.max(this.options.overscan, Math.ceil((this.range.endIndex - this.range.startIndex) / 2));
                const minIndex = Math.max(0, scrollIndex - bufferSize);
                const maxIndex = Math.min(this.options.count - 1, scrollIndex + bufferSize);
                return index >= minIndex && index <= maxIndex;
            }
            return true;
        };
        this.measureElement = (node) => {
            if (!node) {
                this.elementsCache.forEach((cached, key) => {
                    if (!cached.isConnected) {
                        this.observer.unobserve(cached);
                        this.elementsCache.delete(key);
                    }
                });
                return;
            }
            const index = this.indexFromElement(node);
            const key = this.options.getItemKey(index);
            const prevNode = this.elementsCache.get(key);
            if (prevNode !== node) {
                if (prevNode) {
                    this.observer.unobserve(prevNode);
                }
                this.observer.observe(node);
                this.elementsCache.set(key, node);
            }
            // Sync-measure when idle (initial render) or during programmatic scrolling
            // (scrollToIndex/scrollToOffset) where reconcileScroll needs sizes in the same frame.
            // During normal user scrolling, skip sync measurement — the RO callback handles it async.
            if ((!this.isScrolling || this.scrollState) &&
                this.shouldMeasureDuringScroll(index)) {
                this.resizeItem(index, this.options.measureElement(node, undefined, this));
            }
        };
        this.resizeItem = (index, size) => {
            if (index < 0 || index >= this.options.count)
                return;
            // Fast field reads. For lanes===1 we read raw start/size from the flat
            // typed array, avoiding a Proxy.get + VirtualItem allocation per call.
            // For lanes>1 we fall back to the cached VirtualItem array.
            let cachedSize;
            let itemStart;
            let key;
            const flat = this._flatMeasurements;
            if (this.options.lanes === 1 && flat !== null) {
                key = this.options.getItemKey(index);
                itemStart = flat[index * 2];
                cachedSize = flat[index * 2 + 1];
            }
            else {
                const item = this.measurementsCache[index];
                if (!item)
                    return;
                key = item.key;
                itemStart = item.start;
                cachedSize = item.size;
            }
            const itemSize = this.itemSizeCache.get(key) ?? cachedSize;
            const delta = size - itemSize;
            if (delta !== 0) {
                const wasAtEnd = this.options.anchorTo === 'end' &&
                    this.scrollState?.behavior !== 'smooth' &&
                    this.getVirtualDistanceFromEnd() <= this.options.scrollEndThreshold;
                const prevTotalSize = wasAtEnd ? this.getTotalSize() : 0;
                // Default anchoring predicate (used unless the consumer supplies a
                // custom shouldAdjustScrollPositionOnItemSizeChange).
                const scrollOffsetWithAdj = this.getScrollOffset() + this.scrollAdjustments;
                const isFirstMeasure = !this.itemSizeCache.has(key);
                const defaultShouldAdjust = isFirstMeasure
                    ? // First measurement: compensate any item whose top sits above the
                        // fold — the estimate→actual delta must be corrected regardless of
                        // scroll direction, since the whole estimated block was above it.
                        itemStart < scrollOffsetWithAdj
                    : // Re-measurement: only compensate an item that is ENTIRELY above the
                        // fold. An item that merely *spans* the fold (top above, bottom
                        // below — e.g. a streaming chat message growing at its bottom)
                        // changes size *below* the anchor point, so shifting scrollTop by the
                        // delta would drag the viewport downward on every growth (#1218).
                        // Also skip during backward scroll to avoid the "items jump while
                        // scrolling up" cascade.
                        itemStart + itemSize <= scrollOffsetWithAdj &&
                            this.scrollDirection !== 'backward';
                const shouldAdjustScroll = this.scrollState?.behavior !== 'smooth' &&
                    (this.shouldAdjustScrollPositionOnItemSizeChange !== undefined
                        ? this.shouldAdjustScrollPositionOnItemSizeChange(
                        // The callback expects a VirtualItem; build one lazily only
                        // when the consumer actually supplied a custom predicate.
                        this.measurementsCache[index] ?? {
                            index,
                            key,
                            start: itemStart,
                            size: cachedSize,
                            end: itemStart + cachedSize,
                            lane: 0,
                        }, delta, this)
                        : defaultShouldAdjust);
                if (this.pendingMin === null || index < this.pendingMin) {
                    this.pendingMin = index;
                }
                this.itemSizeCache.set(key, size);
                this.itemSizeCacheVersion++;
                let adjustedSync = false;
                if (wasAtEnd) {
                    adjustedSync = this.applyScrollAdjustment(this.getTotalSize() - prevTotalSize);
                }
                else if (shouldAdjustScroll) {
                    adjustedSync = this.applyScrollAdjustment(delta);
                }
                // When we just moved `scrollTop` to compensate for an above-viewport
                // resize, the grown item transforms must commit in the SAME frame as
                // that write. `applyScrollAdjustment` writes `scrollTop` synchronously
                // inside this ResizeObserver callback, but an async `notify` schedules
                // the transform render for a later commit — so the browser can paint
                // one frame with the new `scrollTop` and the old positions, and the
                // viewport visibly jumps by `delta` before snapping back (#1227). A
                // synchronous notify flushes the render in this same callback, so both
                // land in one paint. When nothing moved (or the write was deferred on
                // iOS), keep the cheaper async notify.
                this.notify(adjustedSync);
            }
        };
        this.getVirtualItems = (0, utils_1.memo)(() => [this.getVirtualIndexes(), this.getMeasurements()], (indexes, measurements) => {
            const virtualItems = [];
            for (let k = 0, len = indexes.length; k < len; k++) {
                const i = indexes[k];
                const measurement = measurements[i];
                virtualItems.push(measurement);
            }
            return virtualItems;
        }, {
            key: process.env.NODE_ENV !== 'production' && 'getVirtualItems',
            debug: () => this.options.debug,
        });
        this.getVirtualItemForOffset = (offset) => {
            const measurements = this.getMeasurements();
            if (measurements.length === 0) {
                return undefined;
            }
            // Same fast-path as calculateRange: read start values directly from the
            // typed array during binary search to skip the Proxy.get materialization
            // per probe.
            const flat = this._flatMeasurements;
            const useFlat = this.options.lanes === 1 && flat != null;
            const idx = findNearestBinarySearch(0, measurements.length - 1, useFlat
                ? (i) => flat[i * 2]
                : (i) => (0, utils_1.notUndefined)(measurements[i]).start, offset);
            return (0, utils_1.notUndefined)(measurements[idx]);
        };
        this.getMaxScrollOffset = () => {
            if (!this.scrollElement)
                return 0;
            if ('scrollHeight' in this.scrollElement) {
                // Element
                return this.options.horizontal
                    ? this.scrollElement.scrollWidth - this.scrollElement.clientWidth
                    : this.scrollElement.scrollHeight - this.scrollElement.clientHeight;
            }
            else {
                // Window
                const doc = this.scrollElement.document.documentElement;
                return this.options.horizontal
                    ? doc.scrollWidth - this.scrollElement.innerWidth
                    : doc.scrollHeight - this.scrollElement.innerHeight;
            }
        };
        this.getVirtualDistanceFromEnd = () => {
            return Math.max(this.getTotalSize() - this.getSize() - this.getScrollOffset(), 0);
        };
        this.getDistanceFromEnd = () => {
            return Math.max(this.getMaxScrollOffset() - this.getScrollOffset(), 0);
        };
        this.isAtEnd = (threshold = this.options.scrollEndThreshold) => {
            return this.getDistanceFromEnd() <= threshold;
        };
        this.getOffsetForAlignment = (toOffset, align, itemSize = 0) => {
            if (!this.scrollElement)
                return 0;
            const size = this.getSize();
            const scrollOffset = this.getScrollOffset();
            if (align === 'auto') {
                align = toOffset >= scrollOffset + size ? 'end' : 'start';
            }
            if (align === 'center') {
                // When aligning to a particular item (e.g. with scrollToIndex),
                // adjust offset by the size of the item to center on the item
                toOffset += (itemSize - size) / 2;
            }
            else if (align === 'end') {
                toOffset -= size;
            }
            const maxOffset = this.getMaxScrollOffset();
            return Math.max(Math.min(maxOffset, toOffset), 0);
        };
        this.getOffsetForIndex = (index, align = 'auto') => {
            index = Math.max(0, Math.min(index, this.options.count - 1));
            const size = this.getSize();
            const scrollOffset = this.getScrollOffset();
            const item = this.measurementsCache[index];
            if (!item)
                return;
            if (align === 'auto') {
                if (item.end >= scrollOffset + size - this.options.scrollPaddingEnd) {
                    align = 'end';
                }
                else if (item.start <= scrollOffset + this.options.scrollPaddingStart) {
                    align = 'start';
                }
                else {
                    return [scrollOffset, align];
                }
            }
            // For the last item with 'end' alignment, use browser's actual max scroll
            // to account for borders/padding that aren't in our measurements
            if (align === 'end' && index === this.options.count - 1) {
                return [this.getMaxScrollOffset(), align];
            }
            const toOffset = align === 'end'
                ? item.end + this.options.scrollPaddingEnd
                : item.start - this.options.scrollPaddingStart;
            return [
                this.getOffsetForAlignment(toOffset, align, item.size),
                align,
            ];
        };
        this.scrollToOffset = (toOffset, { align = 'start', behavior = 'auto' } = {}) => {
            // An absolute scroll command derives its target from current
            // measurements, so any iOS-deferred compensation still pending is stale by
            // definition — the command already accounts for the measurements the delta
            // was compensating for. Drop it so _flushIosDeferredIfReady doesn't replay
            // it onto the just-established position (relative commands like scrollBy
            // intentionally keep the deferral, since they build on the current offset).
            this._iosDeferredAdjustment = 0;
            const offset = this.getOffsetForAlignment(toOffset, align);
            const now = this.now();
            this.scrollState = {
                index: null,
                align,
                behavior,
                startedAt: now,
                lastTargetOffset: offset,
                stableFrames: 0,
            };
            this._scrollToOffset(offset, { adjustments: undefined, behavior });
            this.scheduleScrollReconcile();
        };
        this.scrollToIndex = (index, { align: initialAlign = 'auto', behavior = 'auto', } = {}) => {
            // See scrollToOffset: an absolute target invalidates any pending
            // iOS-deferred compensation.
            this._iosDeferredAdjustment = 0;
            index = Math.max(0, Math.min(index, this.options.count - 1));
            const offsetInfo = this.getOffsetForIndex(index, initialAlign);
            if (!offsetInfo) {
                return;
            }
            const [offset, align] = offsetInfo;
            const now = this.now();
            this.scrollState = {
                index,
                align,
                behavior,
                startedAt: now,
                lastTargetOffset: offset,
                stableFrames: 0,
            };
            this._scrollToOffset(offset, { adjustments: undefined, behavior });
            this.scheduleScrollReconcile();
        };
        this.scrollBy = (delta, { behavior = 'auto' } = {}) => {
            const offset = this.getScrollOffset() + delta;
            const now = this.now();
            this.scrollState = {
                index: null,
                align: 'start',
                behavior,
                startedAt: now,
                lastTargetOffset: offset,
                stableFrames: 0,
            };
            this._scrollToOffset(offset, { adjustments: undefined, behavior });
            this.scheduleScrollReconcile();
        };
        this.scrollToEnd = ({ behavior = 'auto' } = {}) => {
            if (this.options.count > 0) {
                this.scrollToIndex(this.options.count - 1, {
                    align: 'end',
                    behavior,
                });
                return;
            }
            this.scrollToOffset(Math.max(this.getTotalSize() - this.getSize(), 0), {
                behavior,
            });
        };
        this.getTotalSize = () => {
            const measurements = this.getMeasurements();
            let end;
            // If there are no measurements, set the end to paddingStart
            // If there is only one lane, use the last measurement's end
            // Otherwise find the maximum end value among all measurements
            if (measurements.length === 0) {
                end = this.options.paddingStart;
            }
            else if (this.options.lanes === 1) {
                // Fast path: read last item's end directly from the flat typed array
                // when available; avoids a Proxy.get + VirtualItem materialization
                // just to call getTotalSize (which React renders trigger every commit).
                const lastIdx = measurements.length - 1;
                const flat = this._flatMeasurements;
                if (flat != null) {
                    end = flat[lastIdx * 2] + flat[lastIdx * 2 + 1];
                }
                else {
                    end = measurements[lastIdx]?.end ?? 0;
                }
            }
            else {
                const endByLane = Array(this.options.lanes).fill(null);
                let endIndex = measurements.length - 1;
                while (endIndex >= 0 && endByLane.some((val) => val === null)) {
                    const item = measurements[endIndex];
                    if (endByLane[item.lane] === null) {
                        endByLane[item.lane] = item.end;
                    }
                    endIndex--;
                }
                end = Math.max(...endByLane.filter((val) => val !== null));
            }
            return Math.max(end - this.options.scrollMargin + this.options.paddingEnd, 0);
        };
        /**
         * Returns a snapshot of currently-measured items suitable for round-
         * tripping through state storage (sessionStorage, history, etc.) and
         * passing back as `initialMeasurementsCache` on remount. Pair with the
         * current `scrollOffset` to restore exact scroll position after navigation.
         *
         * Only items the consumer has actually rendered (and thus measured) appear
         * in the snapshot; unmeasured items will fall back to `estimateSize` on
         * restore. Returns an empty array if no items have been measured.
         */
        this.takeSnapshot = () => {
            const snapshot = [];
            if (this.itemSizeCache.size === 0)
                return snapshot;
            // Iterate measurementsCache only for indices whose key is in itemSizeCache
            // (i.e., have been measured). We build VirtualItem objects with the
            // current start/size/end so they can be persisted as plain data.
            const m = this.getMeasurements();
            for (const item of m) {
                if (item && this.itemSizeCache.has(item.key)) {
                    // Force materialization (lazy path) and copy plain fields.
                    snapshot.push({
                        index: item.index,
                        key: item.key,
                        start: item.start,
                        size: item.size,
                        end: item.end,
                        lane: item.lane,
                    });
                }
            }
            return snapshot;
        };
        this._scrollToOffset = (offset, { adjustments, behavior, }) => {
            // Record the intended logical scroll target so the next scroll event
            // can reconcile against subpixel rounding by the browser.
            this._intendedScrollOffset = offset + (adjustments ?? 0);
            this.options.scrollToFn(offset, { behavior, adjustments }, this);
        };
        this.measure = () => {
            // Reset pendingMin so the next getMeasurements rebuilds from index 0.
            // Without this, a prior resizeItem() that left pendingMin > 0 would
            // cause the rebuild to preserve stale items before that index.
            this.pendingMin = null;
            this.itemSizeCache.clear();
            this.laneAssignments.clear(); // Clear lane cache for full re-layout
            this.itemSizeCacheVersion++;
            this.notify(false);
        };
        this.setOptions(opts);
    }
    // Returns `true` when it performed a synchronous `scrollTop` write this
    // tick, `false` when the delta was zero or the write was deferred (iOS).
    // `resizeItem` uses that to decide whether the follow-up `notify` must be
    // synchronous so the grown transforms commit in the same paint (#1227).
    applyScrollAdjustment(delta, behavior) {
        if (delta === 0)
            return false;
        if (process.env.NODE_ENV !== 'production' && this.options.debug) {
            console.info('correction', delta);
        }
        if (isIOSWebKit() &&
            (this.isScrolling || this._iosTouching || this._iosJustTouchEnded)) {
            this._iosDeferredAdjustment += delta;
            return false;
        }
        else {
            this._scrollToOffset(this.getScrollOffset(), {
                adjustments: (this.scrollAdjustments += delta),
                behavior,
            });
            // Eagerly carry the intended target in `scrollOffset` so callers that
            // read it before the next scroll event — notably the next `resizeItem`
            // tick's `getVirtualDistanceFromEnd()` / `wasAtEnd` check — see the
            // post-adjustment position even when the DOM `scrollTop` write was
            // clamped because the consumer hasn't grown the sizer yet (`notify()`
            // runs after this in `resizeItem`). Same idea as the eager
            // `scrollOffset` adjustment for prepend in `setOptions` (#1176). The
            // adjustment is now baked into `scrollOffset`, so zero
            // `scrollAdjustments` to keep their sum invariant.
            if (this.scrollOffset !== null) {
                this.scrollOffset += this.scrollAdjustments;
                // Clamp only the lower bound: a negative offset is unreachable, and
                // on an unscrollable element (content fits the viewport) no scroll
                // event ever fires to correct it, permanently skewing
                // getDistanceFromEnd() and wedging _flushIosDeferredIfReady (#1229).
                // Upper-bound overflow stays untouched — it is transiently
                // legitimate mid-prepend while the consumer's sizer catches up.
                if (this.scrollOffset < 0)
                    this.scrollOffset = 0;
                this.scrollAdjustments = 0;
            }
            return true;
        }
    }
    scheduleScrollReconcile() {
        if (!this.targetWindow) {
            this.scrollState = null;
            return;
        }
        if (this.rafId != null)
            return;
        this.rafId = this.targetWindow.requestAnimationFrame(() => {
            this.rafId = null;
            this.reconcileScroll();
        });
    }
    reconcileScroll() {
        if (!this.scrollState)
            return;
        const el = this.scrollElement;
        if (!el)
            return;
        // Safety valve: bail out if reconciliation has been running too long
        const MAX_RECONCILE_MS = 5000;
        if (this.now() - this.scrollState.startedAt > MAX_RECONCILE_MS) {
            this.scrollState = null;
            return;
        }
        const offsetInfo = this.scrollState.index != null
            ? this.getOffsetForIndex(this.scrollState.index, this.scrollState.align)
            : undefined;
        const targetOffset = offsetInfo
            ? offsetInfo[0]
            : this.scrollState.lastTargetOffset;
        // Require one stable frame where target matches scroll offset.
        // approxEqual() already tolerates minor fluctuations, so one frame is sufficient
        // to confirm scroll has reached its target without premature cleanup.
        const STABLE_FRAMES = 1;
        const targetChanged = targetOffset !== this.scrollState.lastTargetOffset;
        if (!targetChanged && (0, utils_1.approxEqual)(targetOffset, this.getScrollOffset())) {
            this.scrollState.stableFrames++;
            if (this.scrollState.stableFrames >= STABLE_FRAMES) {
                // Final-pass exact landing. The reconcile-stable check uses a 1.01px
                // tolerance (approxEqual) so we don't fight subpixel browser rounding
                // during the converging phase. Once we're definitively settled,
                // commit the exact target so consumers calling scrollToIndex(N)
                // end up at the EXACT computed position of item N — matching
                // virtuoso's 0px landing accuracy rather than our prior 0.5-1px.
                if (this.getScrollOffset() !== targetOffset) {
                    this._scrollToOffset(targetOffset, {
                        adjustments: undefined,
                        behavior: 'auto',
                    });
                }
                this.scrollState = null;
                return;
            }
        }
        else {
            this.scrollState.stableFrames = 0;
            if (targetChanged) {
                // When the target moves during smooth scroll (because items came into
                // view and got measured, shifting positions), the original logic was
                // to immediately snap to 'auto' — visibly jarring on long
                // scroll-to-index calls. Now: keep smooth while we're still far
                // (more than a viewport) from the new target. Only fall back to
                // 'auto' for the final approach, so the user sees one continuous
                // motion that smoothly adjusts its endpoint as measurements arrive.
                const viewport = this.getSize() || 600;
                const distance = Math.abs(targetOffset - this.getScrollOffset());
                const keepSmooth = this.scrollState.behavior === 'smooth' && distance > viewport;
                this.scrollState.lastTargetOffset = targetOffset;
                if (!keepSmooth) {
                    this.scrollState.behavior = 'auto';
                }
                this._scrollToOffset(targetOffset, {
                    adjustments: undefined,
                    behavior: keepSmooth ? 'smooth' : 'auto',
                });
            }
        }
        // Always reschedule while scrollState is active to guarantee
        // the safety valve timeout runs even if no scroll events fire
        // (e.g. no-op scrollToFn, detached element)
        this.scheduleScrollReconcile();
    }
}
exports.Virtualizer = Virtualizer;
const findNearestBinarySearch = (low, high, getCurrentValue, value) => {
    while (low <= high) {
        const middle = ((low + high) / 2) | 0;
        const currentValue = getCurrentValue(middle);
        if (currentValue < value) {
            low = middle + 1;
        }
        else if (currentValue > value) {
            high = middle - 1;
        }
        else {
            return middle;
        }
    }
    if (low > 0) {
        return low - 1;
    }
    else {
        return 0;
    }
};
// Monomorphic Float64Array variant — reads start values directly at stride
// 2 instead of through a getter closure. JITs the inner load to a typed-
// array bounds-check + load with no indirect call.
function findNearestBinarySearchFlat(flat, high, value) {
    let low = 0;
    while (low <= high) {
        const middle = ((low + high) / 2) | 0;
        const currentValue = flat[middle * 2];
        if (currentValue < value) {
            low = middle + 1;
        }
        else if (currentValue > value) {
            high = middle - 1;
        }
        else {
            return middle;
        }
    }
    return low > 0 ? low - 1 : 0;
}
function calculateRangeImpl(measurements, outerSize, scrollOffset, lanes, flat) {
    const lastIndex = measurements.length - 1;
    // handle case when item count is less than or equal to lanes
    if (measurements.length <= lanes) {
        return { startIndex: 0, endIndex: lastIndex };
    }
    if (lanes === 1 && flat !== null) {
        // Hot single-lane path: typed-array reads, no closures, no Proxy traps.
        const startIndex = findNearestBinarySearchFlat(flat, lastIndex, scrollOffset);
        let endIndex = startIndex;
        const limit = scrollOffset + outerSize;
        while (endIndex < lastIndex &&
            flat[endIndex * 2] + flat[endIndex * 2 + 1] < limit) {
            endIndex++;
        }
        return { startIndex, endIndex };
    }
    // Fallback (lanes > 1 or no flat array): closure-based reads.
    const getStart = (index) => measurements[index].start;
    let startIndex = findNearestBinarySearch(0, lastIndex, getStart, scrollOffset);
    let endIndex = startIndex;
    if (lanes === 1) {
        while (endIndex < lastIndex &&
            measurements[endIndex].end < scrollOffset + outerSize) {
            endIndex++;
        }
    }
    else if (lanes > 1) {
        // Expand forward until we include the visible items from all lanes
        // which are closer to the end of the virtualizer window
        const endPerLane = Array(lanes).fill(0);
        while (endIndex < lastIndex &&
            endPerLane.some((pos) => pos < scrollOffset + outerSize)) {
            const item = measurements[endIndex];
            endPerLane[item.lane] = item.end;
            endIndex++;
        }
        // Expand backward until we include all lanes' visible items
        // closer to the top
        const startPerLane = Array(lanes).fill(scrollOffset + outerSize);
        while (startIndex >= 0 && startPerLane.some((pos) => pos >= scrollOffset)) {
            const item = measurements[startIndex];
            startPerLane[item.lane] = item.start;
            startIndex--;
        }
        // Align startIndex to the beginning of its lane
        startIndex = Math.max(0, startIndex - (startIndex % lanes));
        // Align endIndex to the end of its lane
        endIndex = Math.min(lastIndex, endIndex + (lanes - 1 - (endIndex % lanes)));
    }
    return { startIndex, endIndex };
}

},
"src/modules/trajectory/vendor/virtual-core/src/lazy-measurements.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/virtual-core/src/lazy-measurements.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
// Lazy materialization for the lanes===1 fast path. Backed by a
// Float64Array (stride 2: start, size, …); VirtualItems are constructed on
// first indexed read and cached. Saves the per-item object allocation at
// large list counts where most items are never visible.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLazyMeasurementsView = createLazyMeasurementsView;
function createLazyMeasurementsView(count, flat, getItemKey) {
    const cache = new Array(count);
    return new Proxy(cache, {
        get(target, prop, receiver) {
            if (typeof prop === 'string') {
                // Cheap digit-prefix sniff before number coerce.
                const c = prop.charCodeAt(0);
                if (c >= 48 && c <= 57) {
                    const i = +prop;
                    if (Number.isInteger(i) && i >= 0 && i < count) {
                        let v = target[i];
                        if (!v) {
                            const s = flat[i * 2];
                            v = target[i] = {
                                index: i,
                                key: getItemKey(i),
                                start: s,
                                size: flat[i * 2 + 1],
                                end: s + flat[i * 2 + 1],
                                lane: 0,
                            };
                        }
                        return v;
                    }
                }
                if (prop === 'length')
                    return count;
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

},
"src/modules/trajectory/vendor/virtual-core/src/utils.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/virtual-core/src/utils.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debounce = exports.approxEqual = void 0;
exports.memo = memo;
exports.notUndefined = notUndefined;
function memo(getDeps, fn, opts) {
    let deps = opts.initialDeps ?? [];
    let result;
    let isInitial = true;
    function memoizedFunction() {
        // Debug-only timing. In production builds, `process.env.NODE_ENV !==
        // 'production'` is constant-folded to `false` by downstream minifiers
        // (Terser/esbuild/swc with `define`), which DCEs the entire block.
        const debugEnabled = process.env.NODE_ENV !== 'production' && !!opts.key && !!opts.debug?.();
        let depTime = 0;
        if (debugEnabled)
            depTime = Date.now();
        const newDeps = getDeps();
        const depsChanged = newDeps.length !== deps.length ||
            newDeps.some((dep, index) => deps[index] !== dep);
        if (!depsChanged) {
            return result;
        }
        deps = newDeps;
        let resultTime = 0;
        if (debugEnabled)
            resultTime = Date.now();
        result = fn(...newDeps);
        if (debugEnabled) {
            const depEndTime = Math.round((Date.now() - depTime) * 100) / 100;
            const resultEndTime = Math.round((Date.now() - resultTime) * 100) / 100;
            const resultFpsPercentage = resultEndTime / 16;
            const pad = (str, num) => {
                str = String(str);
                while (str.length < num) {
                    str = ' ' + str;
                }
                return str;
            };
            console.info(`%c⏱ ${pad(resultEndTime, 5)} /${pad(depEndTime, 5)} ms`, `
            font-size: .6rem;
            font-weight: bold;
            color: hsl(${Math.max(0, Math.min(120 - 120 * resultFpsPercentage, 120))}deg 100% 31%);`, opts?.key);
        }
        if (opts?.onChange && !(isInitial && opts.skipInitialOnChange)) {
            opts.onChange(result);
        }
        isInitial = false;
        return result;
    }
    // Attach updateDeps to the function itself
    memoizedFunction.updateDeps = (newDeps) => {
        deps = newDeps;
    };
    return memoizedFunction;
}
function notUndefined(value, msg) {
    if (value === undefined) {
        throw new Error(`Unexpected undefined${msg ? `: ${msg}` : ''}`);
    }
    else {
        return value;
    }
}
const approxEqual = (a, b) => Math.abs(a - b) < 1.01;
exports.approxEqual = approxEqual;
const debounce = (targetWindow, fn, ms) => {
    let timeoutId;
    return function (...args) {
        targetWindow.clearTimeout(timeoutId);
        timeoutId = targetWindow.setTimeout(() => fn.apply(this, args), ms);
    };
};
exports.debounce = debounce;

},
"src/modules/trajectory/primitives.js": function(module, exports, require) {
// source: src/modules/trajectory/primitives.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractMarkdownPlainText = exports.Tooltip = exports.MarkdownText = exports.JsonTree = exports.IconSearchOutline16 = exports.IconUserOutline16 = exports.IconSparkle16 = exports.IconSettingsOutline16 = exports.IconChevronRightOutline14 = void 0;
/** Exact primitives; no module-owned shadow ABI. */
var dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
Object.defineProperty(exports, "IconChevronRightOutline14", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconChevronRightOutline14; } });
Object.defineProperty(exports, "IconSettingsOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSettingsOutline16; } });
Object.defineProperty(exports, "IconSparkle16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSparkle16; } });
Object.defineProperty(exports, "IconUserOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconUserOutline16; } });
Object.defineProperty(exports, "IconSearchOutline16", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.IconSearchOutline16; } });
Object.defineProperty(exports, "JsonTree", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.JsonTree; } });
Object.defineProperty(exports, "MarkdownText", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.MarkdownText; } });
Object.defineProperty(exports, "Tooltip", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.Tooltip; } });
Object.defineProperty(exports, "extractMarkdownPlainText", { enumerable: true, get: function () { return dsh_client_ui_primitives_1.extractMarkdownPlainText; } });

},
"src/modules/trajectory/vendor/diff/src/patch/create.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/diff/src/patch/create.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OMIT_HEADERS = exports.FILE_HEADERS_ONLY = exports.INCLUDE_HEADERS = void 0;
exports.structuredPatch = structuredPatch;
exports.formatPatch = formatPatch;
exports.createTwoFilesPatch = createTwoFilesPatch;
exports.createPatch = createPatch;
const line_1 = require("../diff/line");
/**
 * Returns true if the filename contains characters that require C-style
 * quoting (as used by Git and GNU diffutils in diff output).
 */
function needsQuoting(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] < '\x20' || s[i] > '\x7e' || s[i] === '"' || s[i] === '\\') {
            return true;
        }
    }
    return false;
}
/**
 * C-style quotes a filename, encoding special characters as escape sequences
 * and non-ASCII bytes as octal escapes. This is the inverse of
 * `parseQuotedFileName` in parse.ts.
 *
 * Non-ASCII bytes are encoded as UTF-8 before being emitted as octal escapes.
 * This matches the behaviour of both Git and GNU diffutils, which always emit
 * UTF-8 octal escapes regardless of the underlying filesystem encoding (e.g.
 * Git for Windows converts from NTFS's UTF-16 to UTF-8 internally).
 *
 * If the filename doesn't need quoting, returns it as-is.
 */
function quoteFileNameIfNeeded(s) {
    if (!needsQuoting(s)) {
        return s;
    }
    let result = '"';
    const bytes = new TextEncoder().encode(s);
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        // See https://en.wikipedia.org/wiki/Escape_sequences_in_C#Escape_sequences
        if (b === 0x07) {
            result += '\\a';
        }
        else if (b === 0x08) {
            result += '\\b';
        }
        else if (b === 0x09) {
            result += '\\t';
        }
        else if (b === 0x0a) {
            result += '\\n';
        }
        else if (b === 0x0b) {
            result += '\\v';
        }
        else if (b === 0x0c) {
            result += '\\f';
        }
        else if (b === 0x0d) {
            result += '\\r';
        }
        else if (b === 0x22) {
            result += '\\"';
        }
        else if (b === 0x5c) {
            result += '\\\\';
        }
        else if (b >= 0x20 && b <= 0x7e) {
            // Just a printable ASCII character that is neither a double quote nor a
            // backslash; no need to escape it.
            result += String.fromCharCode(b);
        }
        else {
            // Either part of a non-ASCII character or a control character without a
            // special escape sequence; needs escaping as a 3-digit octal escape
            result += '\\' + b.toString(8).padStart(3, '0');
        }
        i++;
    }
    result += '"';
    return result;
}
exports.INCLUDE_HEADERS = {
    includeIndex: true,
    includeUnderline: true,
    includeFileHeaders: true
};
exports.FILE_HEADERS_ONLY = {
    includeIndex: false,
    includeUnderline: false,
    includeFileHeaders: true
};
exports.OMIT_HEADERS = {
    includeIndex: false,
    includeUnderline: false,
    includeFileHeaders: false
};
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
    let optionsObj;
    if (!options) {
        optionsObj = {};
    }
    else if (typeof options === 'function') {
        optionsObj = { callback: options };
    }
    else {
        optionsObj = options;
    }
    if (typeof optionsObj.context === 'undefined') {
        optionsObj.context = 4;
    }
    // We copy this into its own variable to placate TypeScript, which thinks
    // optionsObj.context might be undefined in the callbacks below.
    const context = optionsObj.context;
    // Upstream rejects untyped caller options; this erased boundary type preserves that runtime guard.
    if (optionsObj.newlineIsToken) {
        throw new Error('newlineIsToken may not be used with patch-generation functions, only with diffing functions');
    }
    if (!optionsObj.callback) {
        return diffLinesResultToPatch((0, line_1.diffLines)(oldStr, newStr, optionsObj));
    }
    else {
        const { callback } = optionsObj;
        (0, line_1.diffLines)(oldStr, newStr, {
            ...optionsObj,
            callback: (diff) => {
                const patch = diffLinesResultToPatch(diff);
                // TypeScript is unhappy without the cast because it does not understand that `patch` may
                // be undefined here only if `callback` is StructuredPatchCallbackAbortable:
                callback(patch);
            }
        });
    }
    function diffLinesResultToPatch(diff) {
        // STEP 1: Build up the patch with no "\ No newline at end of file" lines and with the arrays
        //         of lines containing trailing newline characters. We'll tidy up later...
        if (!diff) {
            return;
        }
        diff.push({ value: '', lines: [] }); // Append an empty value to make cleanup easier
        function contextLines(lines) {
            return lines.map(function (entry) { return ' ' + entry; });
        }
        const hunks = [];
        let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
        for (let i = 0; i < diff.length; i++) {
            const current = diff[i], lines = current.lines || splitLines(current.value);
            current.lines = lines;
            if (current.added || current.removed) {
                // If we have previous context, start with that
                if (!oldRangeStart) {
                    const prev = diff[i - 1];
                    oldRangeStart = oldLine;
                    newRangeStart = newLine;
                    if (prev) {
                        curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
                        oldRangeStart -= curRange.length;
                        newRangeStart -= curRange.length;
                    }
                }
                // Output our changes
                for (const line of lines) {
                    curRange.push((current.added ? '+' : '-') + line);
                }
                // Track the updated file position
                if (current.added) {
                    newLine += lines.length;
                }
                else {
                    oldLine += lines.length;
                }
            }
            else {
                // Identical context lines. Track line changes
                if (oldRangeStart) {
                    // Close out any changes that have been output (or join overlapping)
                    if (lines.length <= context * 2 && i < diff.length - 2) {
                        // Overlapping
                        for (const line of contextLines(lines)) {
                            curRange.push(line);
                        }
                    }
                    else {
                        // end the range and output
                        const contextSize = Math.min(lines.length, context);
                        for (const line of contextLines(lines.slice(0, contextSize))) {
                            curRange.push(line);
                        }
                        const hunk = {
                            oldStart: oldRangeStart,
                            oldLines: (oldLine - oldRangeStart + contextSize),
                            newStart: newRangeStart,
                            newLines: (newLine - newRangeStart + contextSize),
                            lines: curRange
                        };
                        hunks.push(hunk);
                        oldRangeStart = 0;
                        newRangeStart = 0;
                        curRange = [];
                    }
                }
                oldLine += lines.length;
                newLine += lines.length;
            }
        }
        // Step 2: eliminate the trailing `\n` from each line of each hunk, and, where needed, add
        //         "\ No newline at end of file".
        for (const hunk of hunks) {
            for (let i = 0; i < hunk.lines.length; i++) {
                if (hunk.lines[i].endsWith('\n')) {
                    hunk.lines[i] = hunk.lines[i].slice(0, -1);
                }
                else {
                    hunk.lines.splice(i + 1, 0, '\\ No newline at end of file');
                    i++; // Skip the line we just added, then continue iterating
                }
            }
        }
        return {
            oldFileName: oldFileName, newFileName: newFileName,
            oldHeader: oldHeader, newHeader: newHeader,
            hunks: hunks
        };
    }
}
/**
 * creates a unified diff patch.
 *
 * @param patch either a single structured patch object (as returned by `structuredPatch`) or an
 *   array of them (as returned by `parsePatch`).
 * @param headerOptions behaves the same as the `headerOptions` option of `createTwoFilesPatch`.
 *   Ignored for patches where `isGit` is `true`.
 *
 * When a patch has `isGit: true`, `formatPatch` output is changed to more closely match Git's
 * output: it emits a `diff --git` header, emits Git extended headers as appropriate based on
 * properties like `isRename`, `isCreate`, `newMode`, etc, and will omit `---`/`+++` file
 * headers for patches with no hunks (e.g. renames without content changes).
 */
function formatPatch(patch, headerOptions) {
    if (!headerOptions) {
        headerOptions = exports.INCLUDE_HEADERS;
    }
    if (Array.isArray(patch)) {
        if (patch.length > 1 && !headerOptions.includeFileHeaders && !patch.every(p => p.isGit)) {
            throw new Error('Cannot omit file headers on a multi-file patch. '
                + '(The result would be unparseable; how would a tool trying to apply '
                + 'the patch know which changes are to which file?)');
        }
        return patch.map(p => formatPatch(p, headerOptions)).join('\n');
    }
    const ret = [];
    // Git patches have a fixed header format (diff --git, extended headers,
    // and ---/+++ when hunks are present), so headerOptions is ignored.
    if (patch.isGit) {
        headerOptions = exports.INCLUDE_HEADERS;
        // Emit Git-style diff --git header and extended headers.
        // Git never puts /dev/null in the "diff --git" line; for file
        // creations/deletions it uses the real filename on both sides.
        if (!patch.oldFileName) {
            throw new Error('oldFileName must be specified for Git patches');
        }
        if (!patch.newFileName) {
            throw new Error('newFileName must be specified for Git patches');
        }
        let gitOldName = patch.oldFileName;
        let gitNewName = patch.newFileName;
        if (patch.isCreate && gitOldName === '/dev/null') {
            gitOldName = gitNewName.replace(/^b\//, 'a/');
        }
        else if (patch.isDelete && gitNewName === '/dev/null') {
            gitNewName = gitOldName.replace(/^a\//, 'b/');
        }
        ret.push('diff --git ' + quoteFileNameIfNeeded(gitOldName) + ' ' + quoteFileNameIfNeeded(gitNewName));
        if (patch.isDelete) {
            ret.push('deleted file mode ' + (patch.oldMode ?? '100644'));
        }
        if (patch.isCreate) {
            ret.push('new file mode ' + (patch.newMode ?? '100644'));
        }
        if (patch.oldMode && patch.newMode && !patch.isDelete && !patch.isCreate) {
            ret.push('old mode ' + patch.oldMode);
            ret.push('new mode ' + patch.newMode);
        }
        if (patch.isRename) {
            ret.push('rename from ' + quoteFileNameIfNeeded((patch.oldFileName ?? '').replace(/^a\//, '')));
            ret.push('rename to ' + quoteFileNameIfNeeded((patch.newFileName ?? '').replace(/^b\//, '')));
        }
        if (patch.isCopy) {
            ret.push('copy from ' + quoteFileNameIfNeeded((patch.oldFileName ?? '').replace(/^a\//, '')));
            ret.push('copy to ' + quoteFileNameIfNeeded((patch.newFileName ?? '').replace(/^b\//, '')));
        }
    }
    else {
        if (headerOptions.includeIndex && patch.oldFileName == patch.newFileName && patch.oldFileName !== undefined) {
            ret.push('Index: ' + patch.oldFileName);
        }
        if (headerOptions.includeUnderline) {
            ret.push('===================================================================');
        }
    }
    // Emit --- / +++ file headers. For Git patches with no hunks (e.g.
    // pure renames, mode-only changes), Git omits these, so we do too.
    const hasHunks = patch.hunks.length > 0;
    if (headerOptions.includeFileHeaders && patch.oldFileName !== undefined && patch.newFileName !== undefined
        && (!patch.isGit || hasHunks)) {
        ret.push('--- ' + quoteFileNameIfNeeded(patch.oldFileName) + (patch.oldHeader ? '\t' + patch.oldHeader : ''));
        ret.push('+++ ' + quoteFileNameIfNeeded(patch.newFileName) + (patch.newHeader ? '\t' + patch.newHeader : ''));
    }
    for (let i = 0; i < patch.hunks.length; i++) {
        const hunk = patch.hunks[i];
        // Unified Diff Format quirk: If the chunk size is 0,
        // the first number is one lower than one would expect.
        // https://www.artima.com/weblogs/viewpost.jsp?thread=164293
        const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
        const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
        ret.push('@@ -' + oldStart + ',' + hunk.oldLines
            + ' +' + newStart + ',' + hunk.newLines
            + ' @@');
        for (const line of hunk.lines) {
            ret.push(line);
        }
    }
    return ret.join('\n') + '\n';
}
function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
    if (typeof options === 'function') {
        options = { callback: options };
    }
    if (!options?.callback) {
        const patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
        if (!patchObj) {
            return;
        }
        return formatPatch(patchObj, options?.headerOptions);
    }
    else {
        const { callback } = options;
        structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, {
            ...options,
            callback: patchObj => {
                if (!patchObj) {
                    callback(undefined);
                }
                else {
                    callback(formatPatch(patchObj, options.headerOptions));
                }
            }
        });
    }
}
function createPatch(fileName, oldStr, newStr, oldHeader, newHeader, options) {
    return createTwoFilesPatch(fileName, fileName, oldStr, newStr, oldHeader, newHeader, options);
}
/**
 * Split `text` into an array of lines, including the trailing newline character (where present)
 */
function splitLines(text) {
    const hasTrailingNl = text.endsWith('\n');
    const result = text.split('\n').map(line => line + '\n');
    if (hasTrailingNl) {
        result.pop();
    }
    else {
        result.push(result.pop().slice(0, -1));
    }
    return result;
}

},
"src/modules/trajectory/vendor/diff/src/diff/line.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/diff/src/diff/line.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lineDiff = void 0;
exports.diffLines = diffLines;
exports.diffTrimmedLines = diffTrimmedLines;
exports.tokenize = tokenize;
const base_1 = __importDefault(require("./base"));
const params_1 = require("../util/params");
class LineDiff extends base_1.default {
    constructor() {
        super(...arguments);
        this.tokenize = tokenize;
    }
    equals(left, right, options) {
        // If we're ignoring whitespace, we need to normalise lines by stripping
        // whitespace before checking equality. (This has an annoying interaction
        // with newlineIsToken that requires special handling: if newlines get their
        // own token, then we DON'T want to trim the *newline* tokens down to empty
        // strings, since this would cause us to treat whitespace-only line content
        // as equal to a separator between lines, which would be weird and
        // inconsistent with the documented behavior of the options.)
        if (options.ignoreWhitespace) {
            if (!options.newlineIsToken || !left.includes('\n')) {
                left = left.trim();
            }
            if (!options.newlineIsToken || !right.includes('\n')) {
                right = right.trim();
            }
        }
        else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
            if (left.endsWith('\n')) {
                left = left.slice(0, -1);
            }
            if (right.endsWith('\n')) {
                right = right.slice(0, -1);
            }
        }
        return super.equals(left, right, options);
    }
}
exports.lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
    return exports.lineDiff.diff(oldStr, newStr, options);
}
function diffTrimmedLines(oldStr, newStr, options) {
    options = (0, params_1.generateOptions)(options, { ignoreWhitespace: true });
    return exports.lineDiff.diff(oldStr, newStr, options);
}
// Exported standalone so it can be used from jsonDiff too.
function tokenize(value, options) {
    if (options.stripTrailingCr) {
        // remove one \r before \n to match GNU diff's --strip-trailing-cr behavior
        value = value.replace(/\r\n/g, '\n');
    }
    const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
    // Ignore the final empty token that occurs if the string ends with a new line
    if (!linesAndNewlines[linesAndNewlines.length - 1]) {
        linesAndNewlines.pop();
    }
    // Merge the content and line separators into single tokens
    for (let i = 0; i < linesAndNewlines.length; i++) {
        const line = linesAndNewlines[i];
        if (i % 2 && !options.newlineIsToken) {
            retLines[retLines.length - 1] += line;
        }
        else {
            retLines.push(line);
        }
    }
    return retLines;
}

},
"src/modules/trajectory/vendor/diff/src/diff/base.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/diff/src/diff/base.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Diff {
    diff(oldStr, newStr,
    // Type below is not accurate/complete - see above for full possibilities - but it compiles
    options = {}) {
        let callback;
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        else if ('callback' in options) {
            callback = options.callback;
        }
        // Allow subclasses to massage the input prior to running
        const oldString = this.castInput(oldStr, options);
        const newString = this.castInput(newStr, options);
        const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
        const newTokens = this.removeEmpty(this.tokenize(newString, options));
        return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
    }
    diffWithOptionsObj(oldTokens, newTokens, options, callback) {
        const done = (value) => {
            value = this.postProcess(value, options);
            if (callback) {
                setTimeout(function () { callback(value); }, 0);
                return undefined;
            }
            else {
                return value;
            }
        };
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let editLength = 1;
        let maxEditLength = newLen + oldLen;
        if (options.maxEditLength != null) {
            maxEditLength = Math.min(maxEditLength, options.maxEditLength);
        }
        const maxExecutionTime = options.timeout ?? Infinity;
        const abortAfterTimestamp = Date.now() + maxExecutionTime;
        const bestPath = [{ oldPos: -1, lastComponent: undefined }];
        // Seed editLength = 0, i.e. the content starts with the same values
        let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
        if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
            // Identity per the equality and tokenizer
            return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
        }
        // Once we hit the right edge of the edit graph on some diagonal k, we can
        // definitely reach the end of the edit graph in no more than k edits, so
        // there's no point in considering any moves to diagonal k+1 any more (from
        // which we're guaranteed to need at least k+1 more edits).
        // Similarly, once we've reached the bottom of the edit graph, there's no
        // point considering moves to lower diagonals.
        // We record this fact by setting minDiagonalToConsider and
        // maxDiagonalToConsider to some finite value once we've hit the edge of
        // the edit graph.
        // This optimization is not faithful to the original algorithm presented in
        // Myers's paper, which instead pointlessly extends D-paths off the end of
        // the edit graph - see page 7 of Myers's paper which notes this point
        // explicitly and illustrates it with a diagram. This has major performance
        // implications for some common scenarios. For instance, to compute a diff
        // where the new text simply appends d characters on the end of the
        // original text of length n, the true Myers algorithm will take O(n+d^2)
        // time while this optimization needs only O(n+d) time.
        let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
        // Main worker method. checks all permutations of a given edit length for acceptance.
        const execEditLength = () => {
            for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
                let basePath;
                const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
                if (removePath) {
                    // No one else is going to attempt to use this value, clear it
                    // Pruned paths are explicit empty entries; upstream runtime assignment is unchanged.
                    bestPath[diagonalPath - 1] = undefined;
                }
                let canAdd = false;
                if (addPath) {
                    // what newPos will be after we do an insertion:
                    const addPathNewPos = addPath.oldPos - diagonalPath;
                    canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
                }
                const canRemove = removePath && removePath.oldPos + 1 < oldLen;
                if (!canAdd && !canRemove) {
                    // If this path is a terminal then prune
                    // Pruned paths are explicit empty entries; upstream runtime assignment is unchanged.
                    bestPath[diagonalPath] = undefined;
                    continue;
                }
                // Select the diagonal that we want to branch from. We select the prior
                // path whose position in the old string is the farthest from the origin
                // and does not pass the bounds of the diff graph
                if (!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)) {
                    basePath = this.addToPath(addPath, true, false, 0, options);
                }
                else {
                    basePath = this.addToPath(removePath, false, true, 1, options);
                }
                newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
                if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
                    // If we have hit the end of both strings, then we are done
                    return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
                }
                else {
                    bestPath[diagonalPath] = basePath;
                    if (basePath.oldPos + 1 >= oldLen) {
                        maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
                    }
                    if (newPos + 1 >= newLen) {
                        minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
                    }
                }
            }
            editLength++;
        };
        // Performs the length of edit iteration. Is a bit fugly as this has to support the
        // sync and async mode which is never fun. Loops over execEditLength until a value
        // is produced, or until the edit length exceeds options.maxEditLength (if given),
        // in which case it will return undefined.
        if (callback) {
            (function exec() {
                setTimeout(function () {
                    if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
                        return callback(undefined);
                    }
                    if (!execEditLength()) {
                        exec();
                    }
                }, 0);
            }());
        }
        else {
            while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
                const ret = execEditLength();
                if (ret) {
                    return ret;
                }
            }
        }
    }
    addToPath(path, added, removed, oldPosInc, options) {
        const last = path.lastComponent;
        if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
            return {
                oldPos: path.oldPos + oldPosInc,
                lastComponent: { count: last.count + 1, added: added, removed: removed, previousComponent: last.previousComponent }
            };
        }
        else {
            return {
                oldPos: path.oldPos + oldPosInc,
                lastComponent: { count: 1, added: added, removed: removed, previousComponent: last }
            };
        }
    }
    extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
        while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
            newPos++;
            oldPos++;
            commonCount++;
            if (options.oneChangePerToken) {
                basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
            }
        }
        if (commonCount && !options.oneChangePerToken) {
            basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
        }
        basePath.oldPos = oldPos;
        return newPos;
    }
    equals(left, right, options) {
        if (options.comparator) {
            return options.comparator(left, right);
        }
        else {
            return left === right
                || (!!options.ignoreCase && left.toLowerCase() === right.toLowerCase());
        }
    }
    removeEmpty(array) {
        const ret = [];
        for (let i = 0; i < array.length; i++) {
            if (array[i]) {
                ret.push(array[i]);
            }
        }
        return ret;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    castInput(value, options) {
        return value;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenize(value, options) {
        return Array.from(value);
    }
    join(chars) {
        // Assumes ValueT is string, which is the case for most subclasses.
        // When it's false, e.g. in diffArrays, this method needs to be overridden (e.g. with a no-op)
        // Yes, the casts are verbose and ugly, because this pattern - of having the base class SORT OF
        // assume tokens and values are strings, but not completely - is weird and janky.
        return chars.join('');
    }
    postProcess(changeObjects,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options) {
        return changeObjects;
    }
    get useLongestToken() {
        return false;
    }
    buildValues(lastComponent, newTokens, oldTokens) {
        // First we convert our linked list of components in reverse order to an
        // array in the right order:
        const components = [];
        let nextComponent;
        while (lastComponent) {
            components.push(lastComponent);
            nextComponent = lastComponent.previousComponent;
            delete lastComponent.previousComponent;
            lastComponent = nextComponent;
        }
        components.reverse();
        const componentLen = components.length;
        let componentPos = 0, newPos = 0, oldPos = 0;
        for (; componentPos < componentLen; componentPos++) {
            const component = components[componentPos];
            if (!component.removed) {
                if (!component.added && this.useLongestToken) {
                    let value = newTokens.slice(newPos, newPos + component.count);
                    value = value.map(function (value, i) {
                        const oldValue = oldTokens[oldPos + i];
                        return oldValue.length > value.length ? oldValue : value;
                    });
                    component.value = this.join(value);
                }
                else {
                    component.value = this.join(newTokens.slice(newPos, newPos + component.count));
                }
                newPos += component.count;
                // Common case
                if (!component.added) {
                    oldPos += component.count;
                }
            }
            else {
                component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
                oldPos += component.count;
            }
        }
        return components;
    }
}
exports.default = Diff;

},
"src/modules/trajectory/vendor/diff/src/util/params.js": function(module, exports, require) {
// source: src/modules/trajectory/vendor/diff/src/util/params.ts
const process = {"env":{"NODE_ENV":"production"}};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOptions = generateOptions;
function generateOptions(options, defaults) {
    if (typeof options === 'function') {
        defaults.callback = options;
    }
    else if (options) {
        for (const name in options) {
            /* istanbul ignore else */
            if (Object.prototype.hasOwnProperty.call(options, name)) {
                defaults[name] = options[name];
            }
        }
    }
    return defaults;
}

},
"src/modules/trajectory/trajectory-record.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-record.ts

"use strict";
/** Shared trajectory record data and formatting contracts. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trajectoryRecordId = trajectoryRecordId;
exports.formatDurationMillis = formatDurationMillis;
exports.formatElapsedSeconds = formatElapsedSeconds;
/**
 * Resolve the identity that survives prepending older projected records.
 * @param cell - Projected trajectory record.
 * @returns Stable identity from the owning event or tool call, with a fixture fallback.
 */
function trajectoryRecordId(cell) {
    if (cell.recordId !== undefined)
        return cell.recordId;
    if (cell.callId !== undefined)
        return `${cell.kind}\u0000call\u0000${cell.callId}`;
    if (cell.sourceSeq !== undefined)
        return `${cell.kind}\u0000seq\u0000${cell.sourceSeq}`;
    return `${cell.kind}\u0000index\u0000${cell.index}`;
}
/**
 * Format a duration in milliseconds with thousands separators.
 * @param milliseconds - Duration in milliseconds, or `null` when absent.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
function formatDurationMillis(milliseconds) {
    if (milliseconds === null || !Number.isFinite(milliseconds))
        return '—';
    const integer = String(Math.round(milliseconds));
    return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ms`;
}
/**
 * Format an elapsed duration given in seconds as a millisecond label.
 * @param seconds - Duration seconds, or `null` when absent.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
function formatElapsedSeconds(seconds) {
    return formatDurationMillis(seconds === null ? null : seconds * 1000);
}

},
"src/modules/trajectory/trajectory-virtual-rows.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-virtual-rows.ts

"use strict";
/** Pure projection from trajectory records to measurable virtual ledger rows. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trajectoryVirtualRecordKey = trajectoryVirtualRecordKey;
exports.groupTrajectoryVirtualRows = groupTrajectoryVirtualRows;
const trajectory_record_1 = require("./trajectory-record");
const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;
/**
 * Derive the DOM-safe row identity shared by React, the virtualizer, and
 * browser scroll contracts.
 * @param record - Display record whose identity is required.
 * @returns Stable record identity with a suffix for synthetic fold summaries.
 */
function trajectoryVirtualRecordKey(record) {
    const identity = encodeURIComponent((0, trajectory_record_1.trajectoryRecordId)(record.cell));
    return record.collapsedSummaryKind === undefined
        ? identity
        : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`;
}
/**
 * Attach separator-only records to the next content row so the virtualizer
 * never owns a zero-height item. A terminal separator retains its CSS-owned
 * lower-marker clearance as a standalone item.
 * @param records - Final search/fold projection in ledger order.
 * @returns Measurable virtual rows with original logical positions retained.
 */
function groupTrajectoryVirtualRows(records) {
    const rows = [];
    let pending = [];
    for (const [logicalIndex, record] of records.entries()) {
        const entry = { logicalIndex, record };
        if (record.cell.requestOnly === true) {
            pending.push(entry);
            continue;
        }
        const entries = [...pending, entry];
        pending = [];
        rows.push({
            entries,
            height: record.collapsedSummaryKind === undefined
                ? CONTENT_ROW_HEIGHT
                : COLLAPSED_SUMMARY_HEIGHT,
            key: trajectoryVirtualRecordKey(record),
        });
    }
    if (pending.length > 0) {
        rows.push({
            entries: pending,
            height: TERMINAL_BOUNDARY_HEIGHT,
            key: pending.map(candidate => trajectoryVirtualRecordKey(candidate.record)).join('|'),
        });
    }
    return rows;
}

},
"src/modules/trajectory/trajectory-preview.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-preview.ts

"use strict";
/** Bounded Markdown-to-text projection shared by trajectory consumers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trajectoryPreviewText = trajectoryPreviewText;
const primitives_1 = require("./primitives");
const PREVIEW_SOURCE_CHARACTERS = 2048;
const PREVIEW_OUTPUT_CHARACTERS = 512;
/**
 * Build a bounded one-line preview without parsing the complete Markdown document.
 * @param text - Untrusted message, reasoning, payload, or result text.
 * @returns A compact preview capped independently from the retained source.
 */
function trajectoryPreviewText(text) {
    const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
    const compact = (0, primitives_1.extractMarkdownPlainText)(source).replace(/\s+/g, ' ').trim();
    const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
    return source.length < text.length || preview.length < compact.length
        ? `${preview}…`
        : preview;
}

},
"src/modules/trajectory/TrajectoryTable.styles.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTable.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const TrajectoryTable_css_1 = __importDefault(require("./TrajectoryTable.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-trajectory/TrajectoryTable.module.css", '@xharness/dsh-client-ui-trajectory', TrajectoryTable_css_1.default);
const classes = {
    "arrow": "_8DyahG_arrow",
    "assistantContent": "_8DyahG_assistantContent",
    "assistantContentRendered": "_8DyahG_assistantContentRendered",
    "assistantOutput": "_8DyahG_assistantOutput",
    "assistantToolCallArgs": "_8DyahG_assistantToolCallArgs",
    "assistantToolCallButton": "_8DyahG_assistantToolCallButton",
    "assistantToolCallIcon": "_8DyahG_assistantToolCallIcon",
    "assistantToolCallName": "_8DyahG_assistantToolCallName",
    "assistantToolCallText": "_8DyahG_assistantToolCallText",
    "assistantToolCalls": "_8DyahG_assistantToolCalls",
    "assistantToolCallsPreview": "_8DyahG_assistantToolCallsPreview",
    "assistantVioletBright": "_8DyahG_assistantVioletBright",
    "close": "_8DyahG_close",
    "collapsedTurnContent": "_8DyahG_collapsedTurnContent",
    "collapsedTurnEllipsis": "_8DyahG_collapsedTurnEllipsis",
    "collapsedTurnText": "_8DyahG_collapsedTurnText",
    "compacted": "_8DyahG_compacted",
    "compactedSummary": "_8DyahG_compactedSummary",
    "content": "_8DyahG_content",
    "contentColumn": "_8DyahG_contentColumn",
    "contentText": "_8DyahG_contentText",
    "contextGreen": "_8DyahG_contextGreen",
    "detailBody": "_8DyahG_detailBody",
    "detailBodySummary": "_8DyahG_detailBodySummary",
    "detailTab": "_8DyahG_detailTab",
    "detailTabActive": "_8DyahG_detailTabActive",
    "detailTabs": "_8DyahG_detailTabs",
    "details": "_8DyahG_details",
    "detailsHeader": "_8DyahG_detailsHeader",
    "detailsLocation": "_8DyahG_detailsLocation",
    "detailsResizeHandle": "_8DyahG_detailsResizeHandle",
    "detailsTitle": "_8DyahG_detailsTitle",
    "error": "_8DyahG_error",
    "errorPayload": "_8DyahG_errorPayload",
    "event": "_8DyahG_event",
    "eventColumn": "_8DyahG_eventColumn",
    "eventHeader": "_8DyahG_eventHeader",
    "eventInner": "_8DyahG_eventInner",
    "history-loading-spin": "_8DyahG_history-loading-spin",
    "historyLoadButton": "_8DyahG_historyLoadButton",
    "historyLoadRow": "_8DyahG_historyLoadRow",
    "historyLoading": "_8DyahG_historyLoading",
    "historyLoadingBar": "_8DyahG_historyLoadingBar",
    "historyLoadingSpinner": "_8DyahG_historyLoadingSpinner",
    "inlineResult": "_8DyahG_inlineResult",
    "inlineResultText": "_8DyahG_inlineResultText",
    "jsonPayload": "_8DyahG_jsonPayload",
    "jsonPreview": "_8DyahG_jsonPreview",
    "kindSlot": "_8DyahG_kindSlot",
    "kindTag": "_8DyahG_kindTag",
    "kindTagIcon": "_8DyahG_kindTagIcon",
    "kindTagLabel": "_8DyahG_kindTagLabel",
    "markdownPayload": "_8DyahG_markdownPayload",
    "markdownPreview": "_8DyahG_markdownPreview",
    "message": "_8DyahG_message",
    "messageImages": "_8DyahG_messageImages",
    "messageImagesPreview": "_8DyahG_messageImagesPreview",
    "noOutputText": "_8DyahG_noOutputText",
    "noPayload": "_8DyahG_noPayload",
    "overview": "_8DyahG_overview",
    "overviewHeading": "_8DyahG_overviewHeading",
    "overviewHierarchyJumpIconTight": "_8DyahG_overviewHierarchyJumpIconTight",
    "overviewHierarchyNavLink": "_8DyahG_overviewHierarchyNavLink",
    "overviewParentLinks": "_8DyahG_overviewParentLinks",
    "overviewPreview": "_8DyahG_overviewPreview",
    "overviewSection": "_8DyahG_overviewSection",
    "overviewSections": "_8DyahG_overviewSections",
    "overviewTitle": "_8DyahG_overviewTitle",
    "overviewTitleIcon": "_8DyahG_overviewTitleIcon",
    "panelImage": "_8DyahG_panelImage",
    "panelImageLink": "_8DyahG_panelImageLink",
    "panelImageLinkPreview": "_8DyahG_panelImageLinkPreview",
    "payload": "_8DyahG_payload",
    "payloadPreview": "_8DyahG_payloadPreview",
    "promptDiff": "_8DyahG_promptDiff",
    "promptDiffLineadded": "_8DyahG_promptDiffLineadded",
    "promptDiffLinecontext": "_8DyahG_promptDiffLinecontext",
    "promptDiffLinemeta": "_8DyahG_promptDiffLinemeta",
    "promptDiffLineremoved": "_8DyahG_promptDiffLineremoved",
    "promptDiffSection": "_8DyahG_promptDiffSection",
    "promptDiffSections": "_8DyahG_promptDiffSections",
    "promptDiffTitle": "_8DyahG_promptDiffTitle",
    "requestBoundaryControl": "_8DyahG_requestBoundaryControl",
    "requestBoundaryControlActive": "_8DyahG_requestBoundaryControlActive",
    "requestDetailsDot": "_8DyahG_requestDetailsDot",
    "requestDetailsName": "_8DyahG_requestDetailsName",
    "requestTokenDetail": "_8DyahG_requestTokenDetail",
    "resultBlockText": "_8DyahG_resultBlockText",
    "resultBlocks": "_8DyahG_resultBlocks",
    "resultBlocksPreview": "_8DyahG_resultBlocksPreview",
    "resultPreview": "_8DyahG_resultPreview",
    "resultRequest": "_8DyahG_resultRequest",
    "schema": "_8DyahG_schema",
    "schemaDescription": "_8DyahG_schemaDescription",
    "schemaIntro": "_8DyahG_schemaIntro",
    "schemaName": "_8DyahG_schemaName",
    "schemaParameters": "_8DyahG_schemaParameters",
    "schemaParametersTitle": "_8DyahG_schemaParametersTitle",
    "schemaPreview": "_8DyahG_schemaPreview",
    "schemaTree": "_8DyahG_schemaTree",
    "selectionRail": "_8DyahG_selectionRail",
    "sourceBlock": "_8DyahG_sourceBlock",
    "sourceBlockContent": "_8DyahG_sourceBlockContent",
    "sourceBlockHeader": "_8DyahG_sourceBlockHeader",
    "sourceBlockJumpIcon": "_8DyahG_sourceBlockJumpIcon",
    "sourceBlockJumpTarget": "_8DyahG_sourceBlockJumpTarget",
    "sourceBlockLabel": "_8DyahG_sourceBlockLabel",
    "sourceBlocks": "_8DyahG_sourceBlocks",
    "split": "_8DyahG_split",
    "subtoolAmber": "_8DyahG_subtoolAmber",
    "summaryScrollRegion": "_8DyahG_summaryScrollRegion",
    "systemNeutral": "_8DyahG_systemNeutral",
    "systemPrompt": "_8DyahG_systemPrompt",
    "table": "_8DyahG_table",
    "tablePane": "_8DyahG_tablePane",
    "thinkingChevron": "_8DyahG_thinkingChevron",
    "thinkingQuote": "_8DyahG_thinkingQuote",
    "thinkingQuoteOnlyPreview": "_8DyahG_thinkingQuoteOnlyPreview",
    "thinkingToggle": "_8DyahG_thinkingToggle",
    "timestampToggle": "_8DyahG_timestampToggle",
    "toolAmber": "_8DyahG_toolAmber",
    "toolCallNameTypeface": "_8DyahG_toolCallNameTypeface",
    "toolCallOnly": "_8DyahG_toolCallOnly",
    "toolCallPayload": "_8DyahG_toolCallPayload",
    "toolCatalog": "_8DyahG_toolCatalog",
    "toolCatalogChevron": "_8DyahG_toolCatalogChevron",
    "toolCatalogDefinition": "_8DyahG_toolCatalogDefinition",
    "toolCatalogDescription": "_8DyahG_toolCatalogDescription",
    "toolCatalogFullDescription": "_8DyahG_toolCatalogFullDescription",
    "toolCatalogIcon": "_8DyahG_toolCatalogIcon",
    "toolCatalogItem": "_8DyahG_toolCatalogItem",
    "toolCatalogName": "_8DyahG_toolCatalogName",
    "toolCatalogSummary": "_8DyahG_toolCatalogSummary",
    "toolCatalogTree": "_8DyahG_toolCatalogTree",
    "trajectory-table": "_8DyahG_trajectory-table",
    "turnLabel": "_8DyahG_turnLabel",
    "turnLabelActive": "_8DyahG_turnLabelActive",
    "turnLabelCompact": "_8DyahG_turnLabelCompact",
    "turnLabelFull": "_8DyahG_turnLabelFull",
    "turnRail": "_8DyahG_turnRail",
    "usageGroup": "_8DyahG_usageGroup",
    "usageHeading": "_8DyahG_usageHeading",
    "usagePanel": "_8DyahG_usagePanel",
    "user": "_8DyahG_user",
    "virtualSpacer": "_8DyahG_virtualSpacer",
    "visuallyHidden": "_8DyahG_visuallyHidden"
};
const styles = classes;
exports.default = styles;

},
"src/modules/trajectory/TrajectoryTable.css": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTable.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "._8DyahG_split{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);background:var(--dsw-alias-bg-layer-1);flex:1;width:100%;min-height:0;display:flex;position:relative;overflow:hidden;container-type:inline-size}._8DyahG_tablePane{min-width:0;padding-bottom:var(--dsh-trajectory-bottom-clearance,0px);flex:1;position:relative;overflow:hidden auto;container:_8DyahG_trajectory-table/inline-size}._8DyahG_historyLoading{z-index:5;pointer-events:none;height:0;position:sticky;top:0;overflow:visible}._8DyahG_historyLoadingBar{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:30px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);justify-content:center;align-items:center;gap:6px;display:flex}._8DyahG_historyLoadingSpinner{box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;width:10px;height:10px;animation:.7s linear infinite _8DyahG_history-loading-spin}._8DyahG_table tbody ._8DyahG_historyLoadRow td{height:30px;padding:0}._8DyahG_table tbody ._8DyahG_historyLoadRow+tr[data-turn-start=true] td:before{content:none}._8DyahG_historyLoadButton{background:var(--dsw-alias-bg-layer-1);width:100%;height:29px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);border:0;justify-content:center;align-items:center;gap:6px;display:flex}._8DyahG_historyLoadButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}._8DyahG_historyLoadButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}._8DyahG_historyLoadButton:disabled{cursor:default}._8DyahG_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}._8DyahG_table:not([data-scroll-ready=true]){visibility:hidden}@keyframes _8DyahG_history-loading-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){._8DyahG_historyLoadingSpinner{animation:none}}._8DyahG_table{--trajectory-turn-accent:color-mix(in srgb, var(--dsw-static-blue-500) 22%, var(--dsw-alias-bg-layer-1));border-spacing:0;table-layout:fixed;width:100%;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12)}._8DyahG_eventColumn{width:122px}._8DyahG_contentColumn{width:auto}._8DyahG_table th{z-index:3;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);height:30px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-specific-sidebar-fill);font:var(--dsw-font-xxs-12);text-align:left;text-overflow:ellipsis;user-select:none;white-space:nowrap;padding:0 8px;font-weight:500;position:sticky;top:0;overflow:hidden}._8DyahG_eventHeader{text-align:right!important;padding-right:4px!important}._8DyahG_table td{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);text-overflow:ellipsis;white-space:nowrap;height:30px;padding:0 8px;overflow:hidden}._8DyahG_table tbody ._8DyahG_virtualSpacer{pointer-events:none}._8DyahG_table tbody ._8DyahG_virtualSpacer td{height:var(--trajectory-virtual-spacer-height);border:0;padding:0}._8DyahG_table tbody tr:not([data-collapsed-summary]):not([data-virtual-spacer]):not([data-history-load]){cursor:default;transition:background-color .12s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out);outline:none}._8DyahG_table tbody tr[data-timeline-focus=outside]{opacity:.24}._8DyahG_table tbody tr:not([data-collapsed-summary]):not([data-virtual-spacer]):not([data-history-load]):not([data-selected=true]):hover{background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_table tbody tr[data-request-only=true]:hover{background:0 0}._8DyahG_table tbody tr[data-request-only=true] td{border-bottom:0;height:0;padding-top:0;padding-bottom:0}._8DyahG_table tbody tr[data-terminal-request-boundary=true] td{height:9px}._8DyahG_table tbody tr[data-request-only=true] ._8DyahG_turnRail{top:-15px;bottom:0}._8DyahG_table tbody tr:not([data-collapsed-summary]):focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}._8DyahG_table tbody tr[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}._8DyahG_requestBoundaryControl{--request-boundary-base-left:12px;z-index:6;top:-8px;left:calc(var(--request-boundary-base-left) + var(--request-boundary-offset,0px));cursor:pointer;background:0 0;border:0;width:16px;height:16px;padding:0;position:absolute}._8DyahG_requestBoundaryControl:before{background:var(--dsw-alias-label-caption);width:5px;height:5px;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1), 0 0 0 3px transparent;content:\"\";transition:background .12s var(--ds-ease-in-out), box-shadow .12s var(--ds-ease-in-out);border-radius:50%;position:absolute;top:5.5px;left:5.5px}._8DyahG_requestBoundaryControl:after{border:1px solid var(--dsw-alias-border-l1);width:max-content;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);content:attr(data-label);font:9px/12px var(--ds-font-family-code);opacity:0;pointer-events:none;transition:opacity .12s var(--ds-ease-in-out), transform .12s var(--ds-ease-in-out);user-select:none;white-space:nowrap;border-radius:2px;padding:0 4px;position:absolute;top:2px;left:17px;transform:translate(-2px);box-shadow:0 2px 6px #0000001f}._8DyahG_requestBoundaryControl:hover:before,._8DyahG_requestBoundaryControl:focus-visible:before{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}._8DyahG_requestBoundaryControlActive:before,._8DyahG_requestBoundaryControlActive:hover:before,._8DyahG_requestBoundaryControlActive:focus-visible:before{background:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 18%, var(--dsw-alias-bg-layer-1));box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary-new-colorprimary-new-color)}._8DyahG_requestBoundaryControl[data-request-status=error]:before,._8DyahG_requestBoundaryControl[data-request-status=error]:hover:before,._8DyahG_requestBoundaryControl[data-request-status=error]:focus-visible:before{background:var(--dsw-alias-state-error-primary)}._8DyahG_requestBoundaryControl:hover:after,._8DyahG_requestBoundaryControl:focus-visible:after{opacity:1;transform:translate(0)}._8DyahG_requestBoundaryControl:focus-visible{outline:none}._8DyahG_table tbody tr:has(._8DyahG_requestBoundaryControl:hover):not([data-selected=true]){background:0 0}._8DyahG_event{position:relative}._8DyahG_turnRail,._8DyahG_selectionRail{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);pointer-events:none;position:absolute;left:0}._8DyahG_turnRail{z-index:4;background:var(--trajectory-turn-accent);width:2px;top:-1px;bottom:-1px}._8DyahG_table tbody tr[data-turn-end=true] ._8DyahG_turnRail{bottom:0}._8DyahG_selectionRail{z-index:5;width:3px;top:0;bottom:0}._8DyahG_table tbody tr[data-error=true] ._8DyahG_turnRail{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, var(--dsw-alias-bg-layer-1))}._8DyahG_table tbody tr[data-error=true] ._8DyahG_selectionRail{background:var(--dsw-alias-state-error-primary)}._8DyahG_table tbody tr[data-turn-start=true] td{position:relative;overflow:visible}._8DyahG_table tbody tr[data-turn-start=true]:not(:first-child) td:before{z-index:1;background:var(--dsw-alias-border-l1);content:\"\";pointer-events:none;height:2px;position:absolute;top:0;left:0;right:0;transform:translateY(-50%)}._8DyahG_event{padding-left:36px!important;padding-right:4px!important;overflow:visible!important}._8DyahG_turnLabel{z-index:3;box-sizing:border-box;width:max-content;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);font:8px/10px var(--ds-font-family-code);font-variant-numeric:tabular-nums;user-select:none;white-space:nowrap;border-radius:0 0 2px;flex:none;align-items:center;padding:1px 5px;display:inline-grid;position:absolute;top:0;left:0}._8DyahG_turnLabelFull,._8DyahG_turnLabelCompact{opacity:1;white-space:nowrap;grid-area:1/1;max-width:64px;overflow:hidden}._8DyahG_turnLabelCompact{opacity:0;max-width:0}._8DyahG_turnLabelActive{color:color-mix(in srgb, var(--dsw-static-blue-500) 55%, var(--dsw-alias-label-tertiary));background:var(--trajectory-turn-accent)}._8DyahG_eventInner{justify-content:flex-start;align-items:center;min-width:0;height:100%;display:flex}._8DyahG_kindSlot{flex:none;justify-content:flex-end;align-items:flex-end;width:76px;display:flex}._8DyahG_kindSlot [role=tooltip]{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary)}._8DyahG_content{color:var(--dsw-alias-label-primary);padding-left:4px!important}._8DyahG_kindTag{box-sizing:border-box;letter-spacing:.035em;user-select:none;border:1px solid #0000;border-radius:4px;flex:none;align-items:center;height:19px;padding:0 5px;font-size:10px;font-weight:650;line-height:16px;display:inline-flex}._8DyahG_kindTagIcon{opacity:0;flex:none;justify-content:center;align-items:center;width:0;height:13px;display:inline-flex;overflow:hidden;transform:scale(.8)}._8DyahG_kindTagLabel{opacity:1;white-space:nowrap;max-width:72px;display:inline-block;overflow:hidden}._8DyahG_table ._8DyahG_kindSlot ._8DyahG_message{justify-content:center;width:100%}@container _8DyahG_trajectory-table (width<=620px){._8DyahG_eventColumn{width:50px}._8DyahG_event{padding-left:28px!important;padding-right:3px!important}._8DyahG_requestBoundaryControl{--request-boundary-base-left:6px}._8DyahG_kindSlot{width:19px}._8DyahG_kindTag,._8DyahG_table ._8DyahG_kindSlot ._8DyahG_message{justify-content:center;width:19px;padding-left:0;padding-right:0}._8DyahG_kindTagIcon{opacity:1;width:13px;transform:scale(1)}._8DyahG_kindTagLabel,._8DyahG_turnLabelFull{opacity:0;max-width:0}._8DyahG_turnLabelCompact{opacity:1;max-width:64px}}@media (prefers-reduced-motion:no-preference){._8DyahG_eventColumn,._8DyahG_event,._8DyahG_requestBoundaryControl,._8DyahG_kindSlot,._8DyahG_kindTag,._8DyahG_kindTagIcon,._8DyahG_kindTagLabel,._8DyahG_turnLabelFull,._8DyahG_turnLabelCompact{transition-duration:.18s;transition-timing-function:var(--ds-ease-in-out)}._8DyahG_eventColumn,._8DyahG_kindSlot{transition-property:width}._8DyahG_event{transition-property:padding-right,padding-left}._8DyahG_requestBoundaryControl{transition-property:left}._8DyahG_kindTag{transition-property:padding-right,padding-left}._8DyahG_kindTagIcon{transition-property:width,opacity,transform}._8DyahG_kindTagLabel,._8DyahG_turnLabelFull,._8DyahG_turnLabelCompact{transition-property:max-width,opacity}}._8DyahG_user{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}._8DyahG_systemNeutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}._8DyahG_contextGreen{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-success-tertiary)}._8DyahG_compacted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}._8DyahG_compactedSummary{font:var(--dsw-font-xs-13);margin-top:12px;padding:0 0 14px}._8DyahG_promptDiffSections{flex-direction:column;gap:14px;max-height:100%;padding:10px 14px 14px;display:flex;overflow:auto}._8DyahG_promptDiffSection{min-width:0}._8DyahG_promptDiffTitle{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-strong-13);user-select:none;margin:0 0 6px}._8DyahG_promptDiff{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:11px/17px var(--ds-font-family-code);white-space:pre;margin:0;overflow:auto}._8DyahG_promptDiff span{min-width:max-content;padding:0 6px;display:block}._8DyahG_promptDiffLinemeta{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-module-platform);user-select:none}._8DyahG_promptDiffLinecontext{color:var(--dsw-alias-label-secondary)}._8DyahG_promptDiffLineadded{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary));background:var(--dsw-alias-state-success-tertiary)}._8DyahG_promptDiffLineremoved{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1))}._8DyahG_assistantVioletBright{color:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%, var(--dsw-alias-state-error-secondary));background:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%, var(--dsw-alias-state-error-secondary)) 15%, var(--dsw-alias-bg-layer-1))}._8DyahG_toolAmber{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}._8DyahG_subtoolAmber{color:color-mix(in srgb, var(--dsw-alias-state-warn-label) 62%, var(--dsw-alias-label-tertiary));background:color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 58%, var(--dsw-alias-bg-layer-1))}._8DyahG_contentText{text-overflow:ellipsis;white-space:nowrap;min-width:0;display:block;overflow:hidden}._8DyahG_toolCallOnly{color:var(--dsw-alias-label-tertiary)}._8DyahG_table tbody tr[data-collapsed-summary=turn] td,._8DyahG_table tbody tr[data-collapsed-summary=assistant] td{height:20px}._8DyahG_table tbody tr[data-collapsed-summary]{cursor:pointer;transition:background-color .12s var(--ds-ease-in-out);outline:none}._8DyahG_table tbody tr[data-collapsed-summary]:hover{background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_table tbody tr[data-collapsed-summary]:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}._8DyahG_collapsedTurnContent{min-width:0;color:var(--dsw-alias-label-secondary);align-items:center;font-size:12px;line-height:16px;display:flex}._8DyahG_collapsedTurnEllipsis{color:var(--dsw-alias-label-tertiary);user-select:none;flex:none;margin-right:6px;font-weight:600}._8DyahG_collapsedTurnText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}._8DyahG_resultPreview{grid-template-columns:clamp(180px, var(--trajectory-tool-request-width,calc(36cqw - 56px)), 480px) minmax(0, 1fr);align-items:center;gap:8px;min-width:0;display:grid}._8DyahG_resultRequest,._8DyahG_inlineResultText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}._8DyahG_toolCallNameTypeface{color:var(--dsw-alias-label-primary);font:400 12px/18px Menlo,Consolas,Liberation Mono,PingFang SC,Microsoft YaHei}._8DyahG_toolCallPayload{color:var(--dsw-alias-label-secondary);font:400 12px/18px var(--ds-font-family-code);margin-left:7px}._8DyahG_table tbody tr[data-kind=tool] ._8DyahG_contentText,._8DyahG_table tbody tr[data-kind=subtool] ._8DyahG_contentText,._8DyahG_table tbody tr[data-kind=tool] ._8DyahG_resultPreview,._8DyahG_table tbody tr[data-kind=subtool] ._8DyahG_resultPreview{font-family:var(--ds-font-family-code);font-size:12px}._8DyahG_table tbody tr[data-kind=subtool] ._8DyahG_content{padding-left:26px}._8DyahG_inlineResult{min-width:0;color:var(--dsw-alias-label-secondary);align-items:center;display:flex}._8DyahG_noOutputText{color:var(--dsw-alias-label-caption)}._8DyahG_arrow{color:var(--dsw-alias-label-caption);flex:none;margin-right:8px}._8DyahG_error,._8DyahG_overview dd._8DyahG_error,._8DyahG_details ._8DyahG_errorPayload{color:var(--dsw-alias-state-error-primary)}._8DyahG_details ._8DyahG_errorPayload ._8DyahG_resultBlockText{color:inherit}._8DyahG_details ._8DyahG_jsonPayload._8DyahG_errorPayload,._8DyahG_details ._8DyahG_jsonPreview._8DyahG_errorPayload{--json-tree-property:var(--dsw-alias-state-error-primary);--json-tree-string:var(--dsw-alias-state-error-primary);--json-tree-number:var(--dsw-alias-state-error-primary);--json-tree-keyword:var(--dsw-alias-state-error-primary);--json-tree-punctuation:var(--dsw-alias-state-error-primary);--json-tree-icon:var(--dsw-alias-state-error-primary)}._8DyahG_details{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-direction:column;flex:none;width:clamp(320px,38%,440px);min-width:0;max-width:calc(100% - 280px);min-height:0;display:flex;position:relative}._8DyahG_detailsResizeHandle{z-index:6;cursor:col-resize;touch-action:none;user-select:none;background:0 0;border:0;width:8px;padding:0;position:absolute;top:0;bottom:0;left:-4px}._8DyahG_detailsResizeHandle:focus-visible{outline:none}._8DyahG_detailsHeader{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;height:42px;padding:0 8px 0 12px;display:flex}._8DyahG_detailsTitle{min-width:0;color:var(--dsw-alias-label-primary);align-items:center;gap:8px;display:flex}._8DyahG_requestDetailsDot{background:var(--dsw-alias-label-secondary);border-radius:50%;flex:none;width:5px;height:5px}._8DyahG_requestDetailsName{font:500 12px/16px var(--ds-font-family-code);flex:none}._8DyahG_detailsLocation{min-width:0;color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._8DyahG_close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;flex:none;justify-content:center;align-items:center;padding:0;font-size:18px;line-height:18px;display:inline-flex}._8DyahG_close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_detailTabs{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);overscroll-behavior-x:contain;scrollbar-width:none;white-space:nowrap;flex:none;gap:1px;width:100%;min-width:0;max-width:100%;height:34px;padding:0 8px;display:flex;overflow:auto hidden}._8DyahG_detailTabs::-webkit-scrollbar{display:none}._8DyahG_detailTab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;flex:none;padding:0 9px;position:relative}._8DyahG_detailTab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_detailTabActive{color:var(--dsw-alias-state-business-primary)}._8DyahG_detailTabActive:after{background:var(--dsw-alias-state-business-primary);content:\"\";border-radius:1px 1px 0 0;height:2px;position:absolute;bottom:0;left:9px;right:9px}._8DyahG_close:focus-visible,._8DyahG_detailTab:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}._8DyahG_detailBody{min-height:0;padding-bottom:var(--dsh-trajectory-bottom-clearance,0px);scrollbar-gutter:stable;flex:1;overflow:hidden auto}._8DyahG_detailBodySummary{box-sizing:border-box;padding-bottom:calc(12px + var(--dsh-trajectory-bottom-clearance,0px));flex-direction:column;display:flex;overflow:hidden}._8DyahG_detailBodySummary>._8DyahG_overview{overscroll-behavior:contain;flex:0 auto;min-height:0;overflow:auto}._8DyahG_detailBodySummary>._8DyahG_compactedSummary{flex:1;min-height:0;overflow:auto}._8DyahG_summaryScrollRegion{--dsh-scrollbar-thumb:transparent;--dsh-scrollbar-thumb-hover:transparent}._8DyahG_summaryScrollRegion:hover,._8DyahG_summaryScrollRegion:focus-within{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}._8DyahG_compactedSummary ._8DyahG_markdownPayload{padding-right:18px}._8DyahG_overview{font:var(--dsw-font-xs-13);margin:0;padding:8px 0}._8DyahG_overviewParentLinks{gap:14px;display:flex}._8DyahG_overviewHierarchyNavLink{all:unset;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;opacity:1;align-items:center;gap:1px;display:inline-flex}._8DyahG_overviewHierarchyNavLink:hover{color:var(--dsw-alias-label-primary)}._8DyahG_overviewHierarchyJumpIconTight{color:var(--dsw-alias-label-caption);flex:none}._8DyahG_overviewHierarchyNavLink:hover ._8DyahG_overviewHierarchyJumpIconTight,._8DyahG_overviewHierarchyNavLink:focus-visible ._8DyahG_overviewHierarchyJumpIconTight{color:var(--dsw-alias-label-primary)}._8DyahG_overviewHierarchyNavLink:focus-visible{color:var(--dsw-alias-label-primary);outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:2px}._8DyahG_overview>div{grid-template-columns:94px minmax(0,1fr);align-items:center;min-height:22px;padding:0 14px;display:grid}._8DyahG_overview>._8DyahG_requestTokenDetail dt{padding-left:12px}._8DyahG_usagePanel{padding:4px 0 10px}._8DyahG_usageGroup+._8DyahG_usageGroup{margin-top:8px}._8DyahG_usageHeading{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-strong-13);user-select:none;margin:0;padding:4px 14px 1px}._8DyahG_usageGroup ._8DyahG_overview{padding:0}._8DyahG_overview dt{color:var(--dsw-alias-label-tertiary)}._8DyahG_overview dd{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;margin:0;overflow:hidden}._8DyahG_timestampToggle{all:unset;color:inherit;cursor:pointer;font:inherit;user-select:text}._8DyahG_timestampToggle:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:2px}._8DyahG_overviewSections{border-top:0;flex-direction:column;flex:1;min-height:min-content;display:flex;overflow:hidden}._8DyahG_overviewSection{flex-direction:column;flex:1 1 0;min-height:28px;max-height:max-content;display:flex;overflow:hidden}._8DyahG_overviewSection+._8DyahG_overviewSection{padding-top:8px}._8DyahG_overviewHeading{box-sizing:border-box;width:100%;height:28px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xs-strong-13);user-select:none;flex:none;align-items:flex-end;margin:0;padding:0 0 3px 14px;display:flex}._8DyahG_overviewTitle{width:max-content;height:auto;color:inherit;cursor:pointer;font:inherit;user-select:none;background:0 0;border:0;flex:none;align-items:center;gap:3px;padding:0;line-height:1;display:inline-flex}._8DyahG_overviewTitleIcon{color:var(--dsw-alias-label-caption);flex:none}._8DyahG_overviewTitle:hover ._8DyahG_overviewTitleIcon{color:var(--dsw-alias-label-primary)}._8DyahG_overviewTitle:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:2px}._8DyahG_overviewTitle:focus-visible ._8DyahG_overviewTitleIcon{color:var(--dsw-alias-state-business-primary)}._8DyahG_overviewPreview{overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-1);flex:1;min-height:0;overflow:auto}._8DyahG_overviewPreview>:last-child{margin-bottom:0;padding-bottom:0}._8DyahG_overviewPreview ._8DyahG_jsonPreview>:first-child,._8DyahG_overviewPreview ._8DyahG_schemaTree>:first-child{padding-bottom:0}._8DyahG_overviewPreview ._8DyahG_schemaTree{margin-bottom:0}._8DyahG_overviewPreview ._8DyahG_overview{padding:2px 0 0}._8DyahG_overviewPreview ._8DyahG_overview>div{min-height:22px}._8DyahG_markdownPreview,._8DyahG_markdownPayload{color:var(--dsw-alias-label-primary)}._8DyahG_markdownPreview>div,._8DyahG_markdownPayload>div{font:var(--dsw-font-xs-13);gap:8px}._8DyahG_markdownPreview>div h1,._8DyahG_markdownPayload>div h1{font:600 16px/22px var(--dsw-font-family)}._8DyahG_markdownPreview>div h2,._8DyahG_markdownPayload>div h2{font:600 15px/22px var(--dsw-font-family)}._8DyahG_markdownPreview>div :where(h3,h4,h5,h6),._8DyahG_markdownPayload>div :where(h3,h4,h5,h6){font:600 14px/20px var(--dsw-font-family)}._8DyahG_markdownPreview>div :not(pre)>code,._8DyahG_markdownPayload>div :not(pre)>code{font:12px/18px var(--ds-font-family-code)}._8DyahG_markdownPreview>div table,._8DyahG_markdownPayload>div table{font:var(--dsw-font-xs-13)}._8DyahG_markdownPreview>div>:first-child{margin-top:0}._8DyahG_markdownPreview>div>:last-child{margin-bottom:0}._8DyahG_markdownPreview>div :where(h1,h2,h3){margin:12px 0 6px}._8DyahG_markdownPreview>div :where(h4,h5,h6){margin:10px 0 5px}._8DyahG_markdownPreview>div :where(p,ul,ol){margin:8px 0}._8DyahG_markdownPreview>div li:not(:first-child){margin-top:3px}._8DyahG_markdownPreview>div blockquote{margin-top:8px}._8DyahG_markdownPreview>div hr{margin:14px 0}._8DyahG_markdownPreview>div>.md-code-block{margin:10px 0}._8DyahG_assistantContent ._8DyahG_markdownPayload,._8DyahG_assistantContent ._8DyahG_payload{min-height:0}._8DyahG_thinkingQuote{border-left:2px solid var(--dsw-alias-markdown-citation);color:var(--dsw-alias-label-secondary);background:0 0;margin:6px 14px 0 12px;padding-left:6px}._8DyahG_thinkingQuoteOnlyPreview{margin-bottom:8px}._8DyahG_detailBody>._8DyahG_assistantContentRendered ._8DyahG_thinkingQuote{margin-top:14px}._8DyahG_thinkingToggle{width:max-content;height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:600 12px/18px var(--dsw-font-family);user-select:none;background:0 0;border:0;align-items:center;gap:2px;padding:0;display:flex}._8DyahG_thinkingChevron{transition:transform .12s var(--ds-ease-in-out);flex:none}._8DyahG_thinkingToggle[aria-expanded=true] ._8DyahG_thinkingChevron{transform:rotate(90deg)}._8DyahG_thinkingToggle:hover{color:var(--dsw-alias-label-secondary)}._8DyahG_thinkingToggle:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:2px}._8DyahG_thinkingQuote ._8DyahG_markdownPreview,._8DyahG_thinkingQuote ._8DyahG_markdownPayload,._8DyahG_thinkingQuote ._8DyahG_payload{min-height:0;color:var(--dsw-alias-label-secondary);background:0 0;padding:2px 0}._8DyahG_assistantOutput{background:var(--dsw-alias-bg-layer-1)}._8DyahG_markdownPreview{padding:6px 14px 8px}._8DyahG_markdownPayload{min-height:100%;padding:14px}._8DyahG_jsonPayload{min-height:100%}._8DyahG_jsonPreview{min-height:0}._8DyahG_schema{background:var(--dsw-alias-bg-layer-1);min-height:100%}._8DyahG_schemaPreview{min-height:0}._8DyahG_schemaIntro{padding:12px 14px 6px}._8DyahG_schemaPreview ._8DyahG_schemaIntro{padding-top:6px}._8DyahG_schemaName{color:var(--dsw-alias-label-primary);font:600 12px/18px var(--ds-font-family-code);margin:0}._8DyahG_schemaDescription{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:pre-wrap;margin:2px 0 0}._8DyahG_schemaParameters{min-width:0}._8DyahG_schemaParametersTitle{color:var(--dsw-alias-label-tertiary);font:600 11px/16px var(--dsw-font-family);user-select:none;margin:0;padding:4px 14px 2px}._8DyahG_schemaTree{margin:0 6px 8px 0}._8DyahG_payload{box-sizing:border-box;overflow-wrap:anywhere;min-height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);font:12px/19px var(--ds-font-family-code);tab-size:2;white-space:pre-wrap;margin:0;padding:14px}._8DyahG_payloadPreview{min-height:0;padding:6px 14px 8px}._8DyahG_sourceBlocks{box-sizing:border-box;min-height:100%;padding:12px 14px}._8DyahG_sourceBlock+._8DyahG_sourceBlock{margin-top:14px}._8DyahG_sourceBlockHeader,._8DyahG_sourceBlockJumpTarget{user-select:none;align-items:center;gap:3px;width:max-content;margin-bottom:3px;display:flex}._8DyahG_sourceBlockJumpTarget{all:unset;cursor:pointer;user-select:none;align-items:center;gap:3px;width:max-content;margin-bottom:3px;display:flex}._8DyahG_sourceBlockLabel{color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code)}._8DyahG_sourceBlockJumpIcon{color:var(--dsw-alias-label-caption);flex:none}._8DyahG_sourceBlockJumpTarget:hover ._8DyahG_sourceBlockJumpIcon{color:var(--dsw-alias-label-primary)}._8DyahG_sourceBlockJumpTarget:focus-visible{outline:none}._8DyahG_sourceBlockJumpTarget:focus-visible ._8DyahG_sourceBlockJumpIcon{color:var(--dsw-alias-state-business-primary)}._8DyahG_sourceBlockContent{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font:12px/19px var(--ds-font-family-code);tab-size:2;white-space:pre-wrap;background:0 0;margin:0}._8DyahG_panelImageLink{cursor:zoom-in;border-radius:4px;width:auto;max-width:100%;display:block;overflow:hidden}._8DyahG_panelImageLinkPreview{max-height:140px}._8DyahG_panelImage{border-radius:inherit;background:var(--dsw-alias-bg-base);object-fit:contain;width:auto;max-width:100%;height:auto;max-height:320px;margin:0;display:block}._8DyahG_panelImageLinkPreview ._8DyahG_panelImage{max-height:140px}._8DyahG_messageImages{flex-direction:column;gap:8px;margin:8px 14px 14px;display:flex}._8DyahG_messageImagesPreview{gap:6px;margin:6px 14px 8px}._8DyahG_assistantToolCalls{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-secondary);font:11px/17px var(--ds-font-family-code);margin:2px 14px 12px;padding:0;list-style:none}._8DyahG_assistantToolCallsPreview{margin-top:2px;margin-bottom:8px}._8DyahG_assistantToolCalls li{min-width:0}._8DyahG_assistantToolCallButton{all:unset;box-sizing:border-box;cursor:pointer;border-radius:3px;align-items:center;width:calc(100% + 4px);min-width:0;height:19px;margin-left:-4px;padding:0 4px;display:flex}._8DyahG_assistantToolCallButton:hover{background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_assistantToolCallButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}._8DyahG_assistantToolCallIcon{color:var(--dsw-alias-label-caption);flex:none;margin-right:5px}._8DyahG_assistantToolCallButton:hover ._8DyahG_assistantToolCallIcon,._8DyahG_assistantToolCallButton:focus-visible ._8DyahG_assistantToolCallIcon{color:var(--dsw-alias-label-secondary)}._8DyahG_assistantToolCallText{white-space:nowrap;flex:1;min-width:0;display:flex;overflow:hidden}._8DyahG_assistantToolCallName{color:var(--dsw-alias-label-secondary);flex:none;margin-right:5px;font-weight:500}._8DyahG_assistantToolCallArgs{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._8DyahG_systemPrompt{box-sizing:border-box}._8DyahG_toolCatalog{min-height:100%;padding:8px 0 16px}._8DyahG_toolCatalogItem{border-bottom:1px solid var(--dsw-alias-border-l1)}._8DyahG_toolCatalogSummary{box-sizing:border-box;cursor:pointer;user-select:none;grid-template-columns:12px 12px max-content minmax(0,1fr);align-items:center;gap:5px;min-height:30px;padding:4px 12px;list-style:none;display:grid}._8DyahG_toolCatalogSummary::-webkit-details-marker{display:none}._8DyahG_toolCatalogSummary:hover{background:var(--dsw-alias-interactive-bg-hover)}._8DyahG_toolCatalogSummary:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}._8DyahG_toolCatalogChevron,._8DyahG_toolCatalogIcon{color:var(--dsw-alias-label-caption)}._8DyahG_toolCatalogChevron{transition:transform .1s var(--ds-ease-in-out)}._8DyahG_toolCatalogItem[open] ._8DyahG_toolCatalogChevron{transform:rotate(90deg)}._8DyahG_toolCatalogName{color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}._8DyahG_toolCatalogDescription{min-width:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._8DyahG_toolCatalogDefinition{background:var(--dsw-alias-bg-base);padding:0 0 8px 29px}._8DyahG_toolCatalogFullDescription{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:pre-wrap;margin:0;padding:7px 14px 4px 0}._8DyahG_toolCatalogTree{margin-left:-14px;margin-right:6px}._8DyahG_resultBlocks{box-sizing:border-box;flex-direction:column;gap:10px;min-height:100%;padding:14px;display:flex}._8DyahG_resultBlocksPreview{gap:6px;min-height:0;padding:6px 14px 8px}._8DyahG_resultBlockText{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font:12px/19px var(--ds-font-family-code);tab-size:2;white-space:pre-wrap;background:0 0;margin:0}._8DyahG_overviewPreview ._8DyahG_noPayload{padding:6px 14px 8px}._8DyahG_noPayload{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);margin:0;padding:18px 14px}@media (width<=760px){._8DyahG_details{z-index:5;border-left-color:var(--dsw-alias-border-l3);width:min(92%,420px);max-width:92%;position:absolute;top:0;bottom:0;right:0;box-shadow:-12px 0 32px #00000024}}";

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
"src/modules/trajectory/TrajectoryToolbar.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryToolbar.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryToolbar = TrajectoryToolbar;
const jsx_runtime_1 = require("react/jsx-runtime");
const primitives_1 = require("./primitives");
const TrajectoryToolbar_styles_1 = __importDefault(require("./TrajectoryToolbar.styles"));
/**
 * Render the sticky trajectory toolbar.
 * @param props - rendered counts and whole-list fold state.
 * @returns the toolbar element.
 */
function TrajectoryToolbar({ actualDuration, onActualDurationChange, actualTime, onActualTimeChange, allTurnsCollapsed, onToggleAllTurns, allAssistantsCollapsed, onToggleAllAssistants, searchQuery, onSearchQueryChange, t, }) {
    return ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryToolbar_styles_1.default.root, role: "toolbar", "aria-label": t('toolbar.aria'), children: (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryToolbar_styles_1.default.inner, children: [(0, jsx_runtime_1.jsxs)("div", { className: TrajectoryToolbar_styles_1.default.actions, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryToolbar_styles_1.default.toggle, "aria-label": t('toolbar.useActualDuration'), "aria-pressed": actualDuration, title: actualDuration ? t('toolbar.useEqualWidth') : t('toolbar.useActualDuration'), onClick: () => { onActualDurationChange(!actualDuration); }, children: [(0, jsx_runtime_1.jsxs)("svg", { className: TrajectoryToolbar_styles_1.default.toggleIcon, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { cx: "8", cy: "8", r: "5.25" }), (0, jsx_runtime_1.jsx)("path", { d: "M8 4.75V8l2.25 1.5" })] }), t('toolbar.duration')] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryToolbar_styles_1.default.control, role: "switch", "aria-checked": actualTime, hidden: true, onClick: () => { onActualTimeChange(!actualTime); }, children: [(0, jsx_runtime_1.jsx)("span", { children: t('toolbar.actualTime') }), (0, jsx_runtime_1.jsx)("span", { className: TrajectoryToolbar_styles_1.default.controlTrack, "data-on": actualTime || undefined, "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("span", { className: TrajectoryToolbar_styles_1.default.controlThumb }) })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryToolbar_styles_1.default.action, "aria-label": allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns'), "aria-pressed": allTurnsCollapsed, title: allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns'), onClick: onToggleAllTurns, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryToolbar_styles_1.default.actionIcon, "aria-hidden": "true", children: allTurnsCollapsed ? '⊞' : '⊟' }), t('toolbar.turns')] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: TrajectoryToolbar_styles_1.default.action, "aria-label": allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls'), "aria-pressed": allAssistantsCollapsed, title: allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls'), onClick: onToggleAllAssistants, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryToolbar_styles_1.default.actionIcon, "aria-hidden": "true", children: allAssistantsCollapsed ? '⊞' : '⊟' }), t('toolbar.calls')] })] }), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryToolbar_styles_1.default.search, children: [(0, jsx_runtime_1.jsx)(primitives_1.IconSearchOutline16, { size: 11, className: TrajectoryToolbar_styles_1.default.searchIcon }), (0, jsx_runtime_1.jsx)("input", { type: "search", className: TrajectoryToolbar_styles_1.default.searchInput, "aria-label": t('toolbar.search'), placeholder: t('toolbar.searchPlaceholder'), value: searchQuery, onChange: (event) => { onSearchQueryChange(event.currentTarget.value); } })] })] }) }));
}

},
"src/modules/trajectory/TrajectoryToolbar.styles.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryToolbar.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const TrajectoryToolbar_css_1 = __importDefault(require("./TrajectoryToolbar.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-trajectory/TrajectoryToolbar.module.css", '@xharness/dsh-client-ui-trajectory', TrajectoryToolbar_css_1.default);
const classes = {
    "action": "D65Vfa_action",
    "actionIcon": "D65Vfa_actionIcon",
    "actions": "D65Vfa_actions",
    "control": "D65Vfa_control",
    "controlThumb": "D65Vfa_controlThumb",
    "controlTrack": "D65Vfa_controlTrack",
    "inner": "D65Vfa_inner",
    "root": "D65Vfa_root",
    "search": "D65Vfa_search",
    "searchIcon": "D65Vfa_searchIcon",
    "searchInput": "D65Vfa_searchInput",
    "toggle": "D65Vfa_toggle",
    "toggleIcon": "D65Vfa_toggleIcon"
};
const styles = classes;
exports.default = styles;

},
"src/modules/trajectory/TrajectoryToolbar.css": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryToolbar.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".D65Vfa_root{z-index:4;box-sizing:border-box;width:100%;height:var(--dsh-trajectory-toolbar-height);border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);position:sticky;top:0}.D65Vfa_inner{box-sizing:border-box;align-items:center;gap:8px;width:100%;height:100%;padding:0 6px;display:flex}.D65Vfa_actions{flex:none;align-items:center;gap:2px;display:flex}.D65Vfa_toggle{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 7px;display:inline-flex}.D65Vfa_toggle:hover,.D65Vfa_toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.D65Vfa_toggle:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.D65Vfa_toggleIcon{stroke:currentColor;stroke-width:1.25px;stroke-linecap:round;stroke-linejoin:round;flex:none;width:12px;height:12px}.D65Vfa_control{box-sizing:border-box;width:88px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:0;flex:none;justify-content:center;align-items:center;gap:4px;padding:0 5px;display:inline-flex}.D65Vfa_control[hidden]{display:none}.D65Vfa_control:hover:not(:disabled),.D65Vfa_control[aria-checked=true],.D65Vfa_control[aria-pressed=true]{color:var(--dsw-alias-label-primary)}.D65Vfa_control:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.D65Vfa_control:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}.D65Vfa_controlTrack{background:var(--dsw-alias-border-l2);width:20px;height:10px;transition:background-color .12s var(--ds-ease-in-out);border-radius:5px;flex:none;display:inline-block;position:relative}.D65Vfa_controlThumb{background:var(--dsw-alias-bg-layer-1);width:6px;height:6px;transition:transform .12s var(--ds-ease-in-out);border-radius:50%;position:absolute;top:2px;left:2px}.D65Vfa_controlTrack[data-on=true]{background:var(--dsw-alias-state-business-primary)}.D65Vfa_controlTrack[data-on=true] .D65Vfa_controlThumb{transform:translate(10px)}.D65Vfa_action{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 5px;display:inline-flex}.D65Vfa_action:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.D65Vfa_action:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.D65Vfa_actionIcon{color:var(--dsw-alias-label-tertiary);font:14px/14px var(--ds-font-family-code)}.D65Vfa_search{border:1px solid var(--dsw-alias-border-l2);min-width:84px;height:22px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-2);border-radius:4px;flex:0 164px;align-items:center;gap:4px;margin-left:auto;padding:0 6px;display:flex}.D65Vfa_search:hover{border-color:var(--dsw-alias-label-caption)}.D65Vfa_search:focus-within{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}.D65Vfa_searchIcon{flex:none}.D65Vfa_searchInput{width:100%;min-width:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);background:0 0;border:0;outline:0;padding:0}.D65Vfa_searchInput::placeholder{color:var(--dsw-alias-label-caption)}.D65Vfa_searchInput::-webkit-search-cancel-button{cursor:pointer;width:12px;height:12px}";

},
"src/modules/trajectory/TrajectoryTimeline.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTimeline.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryTimeline = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Chrome-Network-style overview timeline for focusing the trajectory ledger. */
const react_1 = require("react");
const primitives_1 = require("./primitives");
const timeline_1 = require("./timeline");
const TrajectoryTimeline_styles_1 = __importDefault(require("./TrajectoryTimeline.styles"));
const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TIMELINE_TOOLTIP_DELAY_MS = 500;
function timelineStyle(style) { return style; }
function assistantTimingDetail(metrics) {
    const start = metrics?.stepStartTime;
    const first = metrics?.firstTokenTime;
    const completed = metrics?.completedTime;
    if (metrics?.timingRecorded !== true
        || typeof start !== 'number'
        || typeof first !== 'number'
        || typeof completed !== 'number'
        || !Number.isFinite(start)
        || !Number.isFinite(first)
        || !Number.isFinite(completed)
        || first < start
        || completed < first)
        return {};
    return { ttftMs: first - start, decodingMs: completed - first };
}
function timelineRecordDetail(cell) {
    const durationMs = cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
        ? undefined
        : Math.max(0, cell.timeSeconds * 1000);
    const startedAt = cell.startedAt === null || !Number.isFinite(cell.startedAt)
        ? undefined
        : cell.startedAt;
    return {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...assistantTimingDetail(cell.assistantMetrics),
    };
}
function timelineKindLabel(kind) {
    switch (kind) {
        case 'system': return 'SYSTEM';
        case 'user': return 'USER';
        case 'context': return 'CONTEXT';
        case 'compacted': return 'COMPACTED';
        case 'message': return 'ASSISTANT';
        case 'tool': return 'TOOL';
        case 'subtool': return 'SUBTOOL';
    }
}
function formatRecordedTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
    });
}
function timelineTooltipLabel(kind, detail) {
    const heading = timelineKindLabel(kind);
    if (detail === undefined)
        return heading;
    const duration = detail.durationMs === undefined
        ? null
        : `Total ${(0, timeline_1.formatTimelineOffset)(detail.durationMs)}`;
    const range = detail.startedAt === undefined
        ? null
        : detail.durationMs === undefined
            ? `Started ${formatRecordedTime(detail.startedAt)}`
            : `${formatRecordedTime(detail.startedAt)} → ${formatRecordedTime(detail.startedAt + detail.durationMs)}`;
    const segments = detail.ttftMs === undefined || detail.decodingMs === undefined
        ? null
        : `TTFT ${(0, timeline_1.formatTimelineOffset)(detail.ttftMs)} · Decoding ${(0, timeline_1.formatTimelineOffset)(detail.decodingMs)}`;
    const timing = [duration, segments].filter(value => value !== null).join(' · ');
    return [heading, range, timing].filter(value => value !== null && value !== '').join('\n');
}
function orderedRange(left, right) {
    return left <= right ? { start: left, end: right } : { start: right, end: left };
}
function clampFraction(value) {
    return Math.min(1, Math.max(0, value));
}
function centeredRange(center, width, minimum, maximum) {
    const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
    const start = Math.min(Math.max(center - clampedWidth / 2, minimum), maximum - clampedWidth);
    return { start, end: start + clampedWidth };
}
function rangeFraction(range, start, duration, minimum, maximum) {
    const bounded = orderedRange(Math.min(maximum, Math.max(minimum, range.start)), Math.min(maximum, Math.max(minimum, range.end)));
    return {
        start: (bounded.start - start) / duration,
        end: (bounded.end - start) / duration,
    };
}
function LaneLabels() {
    return ((0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTimeline_styles_1.default.labels, "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("span", { children: "Input" }), (0, jsx_runtime_1.jsx)("span", { children: "Model" }), (0, jsx_runtime_1.jsx)("span", { children: "Tools" })] }));
}
function EarlierHistoryBoundary({ loading, onHover, onLoad, }) {
    return ((0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: loading ? 'Loading earlier history…' : 'Click to load earlier history', side: "right", delayMs: TIMELINE_TOOLTIP_DELAY_MS, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: TrajectoryTimeline_styles_1.default.earlierHistory, "data-earlier-history": true, "data-loading": loading || undefined, "aria-label": loading ? 'Loading earlier history' : 'Load earlier history', "aria-disabled": loading || onLoad === undefined, onClick: onLoad, onPointerEnter: (event) => {
                event.stopPropagation();
                onHover();
            }, onPointerMove: (event) => { event.stopPropagation(); }, onPointerDown: (event) => { event.stopPropagation(); }, children: "\u2026" }) }));
}
/** Overview renderer with drag ranges, click-sized focus, and Escape reset. */
exports.TrajectoryTimeline = (0, react_1.memo)(function TrajectoryTimeline({ turns, mode, range, hasEarlierRecords = false, onLoadEarlier, selectedIndex = null, searchMatchIndexes = null, onRangeChange, onRecordSelect, onRecordFocus, }) {
    const model = (0, react_1.useMemo)(() => (0, timeline_1.deriveTrajectoryTimeline)(turns, mode), [mode, turns]);
    const detailByIndex = (0, react_1.useMemo)(() => new Map(turns.flatMap(turn => turn.groups.flatMap(group => group.cells.map(cell => [cell.index, timelineRecordDetail(cell)])))), [turns]);
    const dragRef = (0, react_1.useRef)(null);
    const panRef = (0, react_1.useRef)(null);
    const rootRef = (0, react_1.useRef)(null);
    const trackRef = (0, react_1.useRef)(null);
    const [draft, setDraft] = (0, react_1.useState)(null);
    const [hover, setHover] = (0, react_1.useState)(null);
    const [loadingEarlier, setLoadingEarlier] = (0, react_1.useState)(false);
    const [panning, setPanning] = (0, react_1.useState)(false);
    const [viewport, setViewport] = (0, react_1.useState)(null);
    const [animateViewport, setAnimateViewport] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        if (model !== null
            && range !== null
            && (range.end < model.start || range.start > model.end)) {
            onRangeChange(null);
        }
    }, [model, onRangeChange, range]);
    (0, react_1.useEffect)(() => {
        if (model === null)
            return;
        setAnimateViewport(false);
        setViewport(current => current !== null && (current.end < model.start || current.start > model.end)
            ? null
            : current);
    }, [model]);
    (0, react_1.useEffect)(() => {
        if (model === null || selectedIndex === null)
            return;
        const selectedSpan = model.spans.find(span => span.index === selectedIndex);
        if (selectedSpan === undefined)
            return;
        setAnimateViewport(true);
        setViewport((current) => {
            if (current === null)
                return current;
            if (selectedSpan.end > current.start
                && selectedSpan.start < current.end)
                return current;
            const duration = Math.max(1, current.end - current.start);
            const desiredStart = selectedSpan.end <= current.start
                ? selectedSpan.start
                : selectedSpan.end - duration;
            const nextStart = Math.min(Math.max(desiredStart, model.start), Math.max(model.start, model.end - duration));
            if (nextStart === current.start)
                return current;
            return { start: nextStart, end: nextStart + duration };
        });
    }, [model, selectedIndex]);
    const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
    const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
    const viewportStart = model === null || viewport === null
        ? model?.start ?? 0
        : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
    const domainDuration = viewport === null ? fullDuration : viewportDuration;
    const domainStart = viewport === null ? model?.start ?? 0 : viewportStart;
    const showsEarlierBoundary = hasEarlierRecords
        && model !== null
        && domainStart === model.start;
    const loadEarlier = onLoadEarlier === undefined || loadingEarlier
        ? undefined
        : () => {
            setLoadingEarlier(true);
            void onLoadEarlier().finally(() => { setLoadingEarlier(false); });
        };
    const projectedDomainStyle = model === null
        ? undefined
        : {
            '--trajectory-domain-left': `${-(domainStart - model.start) / domainDuration * 100}%`,
            '--trajectory-domain-width': `${fullDuration / domainDuration * 100}%`,
        };
    const committed = model === null || range === null
        ? null
        : rangeFraction(range, domainStart, domainDuration, model.start, model.end);
    const draftFraction = model === null || draft === null
        ? null
        : rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
    const visibleRange = draftFraction ?? committed;
    const activeRange = draft ?? range;
    (0, react_1.useEffect)(() => {
        const root = rootRef.current;
        if (root === null)
            return;
        const onWheel = (event) => {
            event.preventDefault();
            const track = trackRef.current;
            if (track === null || model === null)
                return;
            setAnimateViewport(false);
            const rect = track.getBoundingClientRect();
            const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
            const nextDuration = Math.min(fullDuration, Math.max(Math.min(mode === 'sequence' ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration), domainDuration * Math.exp(event.deltaY * 0.0015)));
            if (nextDuration >= fullDuration * 0.999) {
                setViewport(null);
                return;
            }
            const anchorTime = domainStart + anchorFraction * domainDuration;
            const nextStart = Math.min(Math.max(anchorTime - anchorFraction * nextDuration, model.start), model.end - nextDuration);
            setViewport({ start: nextStart, end: nextStart + nextDuration });
        };
        root.addEventListener('wheel', onWheel, { passive: false });
        return () => { root.removeEventListener('wheel', onWheel); };
    }, [domainDuration, domainStart, fullDuration, mode, model]);
    if (model === null) {
        return ((0, jsx_runtime_1.jsx)("section", { ref: rootRef, className: TrajectoryTimeline_styles_1.default.root, "aria-label": "Trajectory timeline", children: (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTimeline_styles_1.default.plot, children: [(0, jsx_runtime_1.jsx)(LaneLabels, {}), (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTimeline_styles_1.default.track, children: [(0, jsx_runtime_1.jsx)("span", { className: TrajectoryTimeline_styles_1.default.empty, children: "No timing data" }), hasEarlierRecords && ((0, jsx_runtime_1.jsx)(EarlierHistoryBoundary, { loading: loadingEarlier, onHover: () => { setHover(null); }, onLoad: loadEarlier }))] })] }) }));
    }
    const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);
    const fractionAt = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
    };
    const recordIndexAt = (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const value = target?.closest('[data-timeline-record-index]')
            ?.dataset.timelineRecordIndex;
        if (value === undefined)
            return null;
        const index = Number(value);
        return Number.isFinite(index) ? index : null;
    };
    const commit = (nextRange) => {
        onRangeChange(nextRange);
    };
    const onPointerDown = (event) => {
        if (event.button === 2) {
            panRef.current = {
                anchorClientX: event.clientX,
                anchorStart: domainStart,
                moved: false,
                pannable: viewport !== null,
                pointerId: event.pointerId,
            };
            if (viewport !== null)
                setAnimateViewport(false);
            setPanning(true);
            if (typeof event.currentTarget.setPointerCapture === 'function') {
                event.currentTarget.setPointerCapture(event.pointerId);
            }
            return;
        }
        if (event.button !== 0)
            return;
        const anchor = fractionAt(event);
        const anchorTime = domainStart + anchor * domainDuration;
        const recordIndex = recordIndexAt(event);
        setHover({ fraction: anchor, recordIndex });
        dragRef.current = {
            pointerId: event.pointerId,
            anchorTime,
            anchorClientX: event.clientX,
            recordIndex,
        };
        if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        setDraft({ start: anchorTime, end: anchorTime });
    };
    const onPointerMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = fractionAt(event);
        setHover({ fraction, recordIndex: recordIndexAt(event) });
        const pan = panRef.current;
        if (pan !== null && pan.pointerId === event.pointerId) {
            if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) {
                pan.moved = true;
            }
            if (!pan.pannable)
                return;
            const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
            const nextStart = Math.min(Math.max(pan.anchorStart - delta * domainDuration, model.start), model.end - domainDuration);
            setViewport({ start: nextStart, end: nextStart + domainDuration });
            return;
        }
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId)
            return;
        let nextDomainStart = domainStart;
        if (viewport !== null) {
            const localX = event.clientX - rect.left;
            const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
            const direction = localX < edgeWidth
                ? -1
                : localX > rect.width - edgeWidth ? 1 : 0;
            if (direction !== 0) {
                const edgeDistance = direction < 0
                    ? edgeWidth - localX
                    : localX - (rect.width - edgeWidth);
                const strength = clampFraction(edgeDistance / edgeWidth);
                const desiredStart = domainStart
                    + direction * domainDuration * EDGE_PAN_STEP_FRACTION
                        * Math.max(0.2, strength);
                nextDomainStart = Math.min(Math.max(desiredStart, model.start), model.end - domainDuration);
                if (nextDomainStart !== domainStart) {
                    setAnimateViewport(false);
                    setViewport({
                        start: nextDomainStart,
                        end: nextDomainStart + domainDuration,
                    });
                }
            }
        }
        const pointTime = nextDomainStart + fraction * domainDuration;
        setDraft(orderedRange(drag.anchorTime, pointTime));
    };
    const onPointerEnd = (event) => {
        const pan = panRef.current;
        if (pan !== null && pan.pointerId === event.pointerId) {
            const moved = pan.moved
                || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
            panRef.current = null;
            setPanning(false);
            if (!moved)
                onRangeChange(null);
            return;
        }
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId)
            return;
        const pointFraction = fractionAt(event);
        const pointTime = domainStart + pointFraction * domainDuration;
        const selected = orderedRange(drag.anchorTime, pointTime);
        setHover({ fraction: pointFraction, recordIndex: recordIndexAt(event) });
        dragRef.current = null;
        setDraft(null);
        const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
        const clickedSpan = click && drag.recordIndex !== null
            ? model.spans.find(span => span.index === drag.recordIndex)
            : undefined;
        if (clickedSpan !== undefined) {
            onRangeChange(null);
            onRecordSelect?.(clickedSpan.index);
            return;
        }
        const committedRange = selected.end - selected.start < minimumSelectionDuration
            ? centeredRange(click ? selected.start : (selected.start + selected.end) / 2, minimumSelectionDuration, model.start, model.end)
            : selected;
        commit(committedRange);
        if (click) {
            const timelinePoint = selected.start;
            const nearest = model.spans.reduce((candidate, span) => {
                const candidateDistance = timelinePoint < candidate.start
                    ? candidate.start - timelinePoint
                    : timelinePoint > candidate.end ? timelinePoint - candidate.end : 0;
                const spanDistance = timelinePoint < span.start
                    ? span.start - timelinePoint
                    : timelinePoint > span.end ? timelinePoint - span.end : 0;
                return spanDistance < candidateDistance ? span : candidate;
            });
            onRecordFocus?.(nearest.index);
        }
    };
    const onKeyDown = (event) => {
        if (event.key !== 'Escape' || range === null)
            return;
        event.preventDefault();
        onRangeChange(null);
    };
    const onPointerCancel = () => {
        dragRef.current = null;
        panRef.current = null;
        setDraft(null);
        setHover(null);
        setPanning(false);
    };
    return ((0, jsx_runtime_1.jsx)("section", { ref: rootRef, className: TrajectoryTimeline_styles_1.default.root, "aria-label": "Trajectory timeline", children: (0, jsx_runtime_1.jsxs)("div", { className: TrajectoryTimeline_styles_1.default.plot, children: [(0, jsx_runtime_1.jsx)(LaneLabels, {}), (0, jsx_runtime_1.jsxs)("div", { ref: trackRef, className: TrajectoryTimeline_styles_1.default.track, "data-panning": panning || undefined, "aria-label": "Timeline overview; drag horizontally to focus events", tabIndex: 0, onKeyDown: onKeyDown, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerCancel, onPointerLeave: () => {
                        if (dragRef.current === null && panRef.current === null)
                            setHover(null);
                    }, onDoubleClick: (event) => {
                        event.preventDefault();
                        onRangeChange(null);
                    }, onContextMenu: (event) => {
                        event.preventDefault();
                    }, children: [showsEarlierBoundary && ((0, jsx_runtime_1.jsx)(EarlierHistoryBoundary, { loading: loadingEarlier, onHover: () => { setHover(null); }, onLoad: loadEarlier })), hover !== null && hover.recordIndex === null && draft === null && ((0, jsx_runtime_1.jsx)("div", { className: TrajectoryTimeline_styles_1.default.hoverLine, "data-timeline-hover-line": true, "aria-hidden": "true", style: timelineStyle({
                                '--trajectory-hover-left': `${hover.fraction * 100}%`,
                            }) })), visibleRange !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: TrajectoryTimeline_styles_1.default.selection, "data-dragging": draft === null ? undefined : 'true', "aria-hidden": "true", style: timelineStyle({
                                        '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                                        '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
                                    }) }), (0, jsx_runtime_1.jsx)("div", { className: TrajectoryTimeline_styles_1.default.selectionEdges, "data-dragging": draft === null ? undefined : 'true', "aria-hidden": "true", style: timelineStyle({
                                        '--trajectory-selection-left': `${visibleRange.start * 100}%`,
                                        '--trajectory-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
                                    }) })] })), (0, jsx_runtime_1.jsx)("div", { className: TrajectoryTimeline_styles_1.default.turnBoundaries, "data-animate-viewport": animateViewport || undefined, "aria-hidden": "true", style: projectedDomainStyle, children: model.turnBoundaries
                                .filter(boundary => boundary.time > model.start
                                && boundary.time >= domainStart
                                && boundary.time <= domainStart + domainDuration)
                                .map(boundary => ((0, jsx_runtime_1.jsx)("span", { className: TrajectoryTimeline_styles_1.default.turnBoundary, "data-turn": boundary.turn, style: timelineStyle({
                                    '--trajectory-turn-left': `${(boundary.time - model.start) / fullDuration * 100}%`,
                                }) }, boundary.turn))) }), (0, jsx_runtime_1.jsx)("div", { className: TrajectoryTimeline_styles_1.default.lanes, "data-animate-viewport": animateViewport || undefined, "data-timeline-domain": true, style: projectedDomainStyle, children: model.spans
                                .filter(span => span.index === selectedIndex
                                || (span.end >= domainStart && span.start <= domainStart + domainDuration))
                                .map((span) => {
                                const left = (span.start - model.start) / fullDuration;
                                const width = (span.end - span.start) / fullDuration;
                                const widthPercent = width * 100;
                                const detail = detailByIndex.get(span.index);
                                const ttftMs = detail?.ttftMs;
                                const decodingMs = detail?.decodingMs;
                                const ttftFraction = ttftMs === undefined
                                    || decodingMs === undefined
                                    || ttftMs + decodingMs <= 0
                                    ? null
                                    : ttftMs / (ttftMs + decodingMs);
                                return ((0, jsx_runtime_1.jsx)(primitives_1.Tooltip, { label: () => timelineTooltipLabel(span.kind, detail), side: "bottom", delayMs: TIMELINE_TOOLTIP_DELAY_MS, children: (0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", className: TrajectoryTimeline_styles_1.default.span, "data-timeline-span": span.kind, "data-timeline-record-index": span.index, "data-assistant-timing": ttftFraction === null ? undefined : 'true', "data-error": span.isError || undefined, "data-equal-duration": mode === 'time' || undefined, "data-current": span.index === selectedIndex || undefined, "data-hovered": hover?.recordIndex === span.index || undefined, "data-search-match": searchMatchIndexes === null
                                            ? undefined
                                            : searchMatchIndexes.has(span.index) ? 'true' : 'false', "data-selected": activeRange === null
                                            ? undefined
                                            : span.start <= activeRange.end && span.end >= activeRange.start
                                                ? 'true'
                                                : 'false', style: timelineStyle({
                                            '--trajectory-span-left': `${left * 100}%`,
                                            '--trajectory-span-width': `${widthPercent}%`,
                                            '--trajectory-span-gap': `min(${widthPercent * 0.08}%, 1px)`,
                                            '--trajectory-span-lane': span.lane,
                                            ...(ttftFraction === null
                                                ? {}
                                                : { '--trajectory-assistant-ttft': `${ttftFraction * 100}%` }),
                                        }) }) }, span.index));
                            }) })] })] }) }));
});

},
"src/modules/trajectory/timeline.js": function(module, exports, require) {
// source: src/modules/trajectory/timeline.ts

"use strict";
/** Operation-sequence and recorded-time projections for the trajectory overview. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatTimelineOffset = formatTimelineOffset;
exports.deriveTrajectoryTimeline = deriveTrajectoryTimeline;
exports.trajectoryTimelineFocusIndexes = trajectoryTimelineFocusIndexes;
const trajectory_record_1 = require("./trajectory-record");
/**
 * Format a timeline duration as an integer-millisecond label.
 * @param milliseconds - Non-negative duration in milliseconds.
 * @returns Millisecond label with thousands separators.
 */
function formatTimelineOffset(milliseconds) {
    return (0, trajectory_record_1.formatDurationMillis)(milliseconds);
}
function laneFor(kind) {
    if (kind === 'tool' || kind === 'subtool')
        return 2;
    if (kind === 'message' || kind === 'compacted')
        return 1;
    return 0;
}
function finite(value) {
    return value !== null && value !== undefined && Number.isFinite(value);
}
function cellRange(cell) {
    if (!finite(cell.startedAt))
        return null;
    const durationMs = finite(cell.timeSeconds)
        ? Math.max(0, cell.timeSeconds * 1000)
        : 0;
    return { start: cell.startedAt, end: cell.startedAt + durationMs };
}
/**
 * Project every visible record into a stable three-lane timeline.
 * @param turns - Unfiltered trajectory layout.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Timeline model, or `null` when no record is visible.
 */
function deriveTrajectoryTimeline(turns, mode = 'sequence') {
    if (mode !== 'sequence') {
        return deriveTimedTimeline(turns, mode === 'duration' || mode === 'actual', mode === 'duration');
    }
    const spans = [];
    const turnBoundaries = [];
    for (const turn of turns) {
        const cells = turn.groups.flatMap(group => group.cells.filter(cell => cell.requestOnly !== true));
        if (cells.length === 0)
            continue;
        if (turn.turn !== null) {
            turnBoundaries.push({
                turn: turn.turn,
                time: spans.length,
            });
        }
        spans.push(...cells.map((cell, offset) => ({
            start: spans.length + offset,
            end: spans.length + offset + 1,
            index: cell.index,
            isError: cell.isError === true,
            kind: cell.kind,
            label: cell.text,
            lane: laneFor(cell.kind),
        })));
    }
    if (spans.length === 0)
        return null;
    return {
        start: 0,
        end: spans.length,
        spans,
        turnBoundaries,
    };
}
function deriveTimedTimeline(turns, actualDuration, compressIdle) {
    const timedTurns = turns.flatMap((turn) => {
        const rawSpans = turn.groups.flatMap(group => group.cells.flatMap((cell) => {
            if (cell.requestOnly === true)
                return [];
            const range = cellRange(cell);
            return range === null
                ? []
                : [{
                        ...range,
                        index: cell.index,
                        isError: cell.isError === true,
                        kind: cell.kind,
                        label: cell.text,
                        lane: laneFor(cell.kind),
                    }];
        }));
        return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
    });
    const rawSpans = timedTurns.flatMap(turn => turn.rawSpans);
    if (rawSpans.length === 0)
        return null;
    const removedIdleBySpan = new Map();
    let removedIdle = 0;
    let coveredUntil = null;
    for (const span of [...rawSpans].sort((left, right) => left.start - right.start || left.end - right.end)) {
        if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
            removedIdle += span.start - coveredUntil;
        }
        removedIdleBySpan.set(span, removedIdle);
        coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
    }
    const spans = [];
    const turnBoundaries = [];
    for (const turn of timedTurns) {
        const projected = turn.rawSpans.map((span) => {
            const offset = removedIdleBySpan.get(span) ?? 0;
            return {
                ...span,
                start: span.start - offset,
                end: (actualDuration ? span.end : span.start) - offset,
            };
        });
        spans.push(...projected);
        if (turn.turn !== null) {
            turnBoundaries.push({
                turn: turn.turn,
                time: Math.min(...projected.map(span => span.start)),
            });
        }
    }
    return {
        start: Math.min(...spans.map(span => span.start)),
        end: Math.max(...spans.map(span => span.end)),
        spans,
        turnBoundaries,
    };
}
/**
 * Identify records active at any point inside an inclusive selected interval.
 * @param turns - Unfiltered trajectory layout.
 * @param range - Selected interval in the active projection.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Record indexes inside the focus interval.
 */
function trajectoryTimelineFocusIndexes(turns, range, mode = 'sequence') {
    const model = deriveTrajectoryTimeline(turns, mode);
    return new Set(model?.spans
        .filter(span => span.start <= range.end && span.end >= range.start)
        .map(span => span.index));
}

},
"src/modules/trajectory/TrajectoryTimeline.styles.js": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTimeline.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const TrajectoryTimeline_css_1 = __importDefault(require("./TrajectoryTimeline.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-trajectory/TrajectoryTimeline.module.css", '@xharness/dsh-client-ui-trajectory', TrajectoryTimeline_css_1.default);
const classes = {
    "earlierHistory": "YDLR1G_earlierHistory",
    "empty": "YDLR1G_empty",
    "hoverLine": "YDLR1G_hoverLine",
    "labels": "YDLR1G_labels",
    "lanes": "YDLR1G_lanes",
    "plot": "YDLR1G_plot",
    "root": "YDLR1G_root",
    "selection": "YDLR1G_selection",
    "selectionEdges": "YDLR1G_selectionEdges",
    "span": "YDLR1G_span",
    "track": "YDLR1G_track",
    "turnBoundaries": "YDLR1G_turnBoundaries",
    "turnBoundary": "YDLR1G_turnBoundary"
};
const styles = classes;
exports.default = styles;

},
"src/modules/trajectory/TrajectoryTimeline.css": function(module, exports, require) {
// source: src/modules/trajectory/TrajectoryTimeline.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".YDLR1G_root{z-index:1;isolation:isolate;border-bottom:1px solid var(--dsw-alias-border-l2);user-select:none;flex:none;position:relative}.YDLR1G_root [role=tooltip]{font:var(--dsw-font-xxxs-11)}.YDLR1G_plot{background:var(--dsw-alias-bg-layer-2);grid-template-columns:44px minmax(0,1fr);height:50px;display:grid;overflow:hidden}.YDLR1G_labels{border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font:var(--dsw-font-xs-13);font-size:10px;line-height:1;position:relative}.YDLR1G_labels span{text-align:right;justify-content:flex-end;align-items:center;height:8px;display:flex;position:absolute;right:3px}.YDLR1G_labels span:first-child{top:7px}.YDLR1G_labels span:nth-child(2){top:21px}.YDLR1G_labels span:nth-child(3){top:35px}.YDLR1G_track{cursor:crosshair;touch-action:none;position:relative;overflow:hidden}.YDLR1G_track[data-panning=true]{cursor:grabbing}.YDLR1G_earlierHistory{z-index:5;appearance:none;box-sizing:border-box;background:linear-gradient(to right, var(--dsw-alias-bg-layer-2) 0, var(--dsw-alias-bg-layer-2) 38%, transparent 100%);width:28px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);opacity:.72;cursor:pointer;border:0;outline:none;justify-content:flex-start;align-items:center;padding-left:3px;line-height:1;display:flex;position:absolute;top:0;bottom:0;left:0}.YDLR1G_earlierHistory:hover{opacity:1}.YDLR1G_earlierHistory[aria-disabled=true]{cursor:default}.YDLR1G_earlierHistory:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}.YDLR1G_empty{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xs-13);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}.YDLR1G_track:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}.YDLR1G_lanes{z-index:2;top:7px;bottom:7px;left:var(--trajectory-domain-left);width:var(--trajectory-domain-width);position:absolute}.YDLR1G_turnBoundaries{z-index:3;top:0;bottom:0;left:var(--trajectory-domain-left);width:var(--trajectory-domain-width);pointer-events:none;position:absolute}@media (prefers-reduced-motion:no-preference){.YDLR1G_lanes[data-animate-viewport=true],.YDLR1G_turnBoundaries[data-animate-viewport=true]{transition:left .18s ease-out}}.YDLR1G_turnBoundary{top:0;bottom:0;left:var(--trajectory-turn-left);background:var(--dsw-alias-border-l2);width:1px;position:absolute}.YDLR1G_span{top:calc(var(--trajectory-span-lane) * 14px);left:calc(var(--trajectory-span-left) + var(--trajectory-span-gap));width:max(2px, calc(var(--trajectory-span-width) - var(--trajectory-span-gap) - var(--trajectory-span-gap)));background:var(--dsw-alias-label-secondary);opacity:.78;border-radius:1px;min-width:2px;height:8px;position:absolute}.YDLR1G_span[data-timeline-span=user]{background:var(--dsw-alias-state-business-primary)}.YDLR1G_span[data-timeline-span=context]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-secondary))}.YDLR1G_span[data-timeline-span=message]{--trajectory-assistant-decoding-color:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%, var(--dsw-alias-state-error-secondary));--trajectory-assistant-ttft-color:color-mix(in srgb, var(--trajectory-assistant-decoding-color) 54%, var(--dsw-alias-bg-layer-2));background:var(--trajectory-assistant-decoding-color);opacity:1}.YDLR1G_span[data-timeline-span=message][data-assistant-timing=true]{background:linear-gradient(to right, var(--trajectory-assistant-ttft-color) 0, var(--trajectory-assistant-ttft-color) var(--trajectory-assistant-ttft), var(--trajectory-assistant-decoding-color) var(--trajectory-assistant-ttft), var(--trajectory-assistant-decoding-color) 100%)}.YDLR1G_span[data-timeline-span=tool],.YDLR1G_span[data-timeline-span=subtool]{background:var(--dsw-alias-state-warn-label);opacity:1}.YDLR1G_span[data-error=true]{background:var(--dsw-alias-state-error-primary)}.YDLR1G_span[data-equal-duration=true]{width:8px;min-width:8px}.YDLR1G_span[data-selected=false]{opacity:.2}.YDLR1G_span[data-hovered=true]:not([data-current=true]){z-index:1;opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2), 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 80%, transparent)}.YDLR1G_span[data-current=true]{z-index:1;opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2), 0 0 0 2px var(--dsw-alias-state-business-primary)}.YDLR1G_span[data-search-match=false]{opacity:.14}.YDLR1G_selection{z-index:1;top:0;bottom:0;left:var(--trajectory-selection-left);width:var(--trajectory-selection-width);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);min-width:1px;box-shadow:-100vw 0 0 100vw color-mix(in srgb, var(--dsw-alias-bg-layer-1) 58%, transparent), 100vw 0 0 100vw color-mix(in srgb, var(--dsw-alias-bg-layer-1) 58%, transparent);pointer-events:none;position:absolute}.YDLR1G_selectionEdges{z-index:4;top:0;bottom:0;left:var(--trajectory-selection-left);width:var(--trajectory-selection-width);pointer-events:none;min-width:1px;position:absolute}.YDLR1G_hoverLine{z-index:4;top:0;bottom:0;left:clamp(0px, calc(var(--trajectory-hover-left) - 1px), calc(100% - 2px));background:var(--dsw-alias-state-business-primary);pointer-events:none;width:2px;position:absolute}.YDLR1G_selectionEdges:before,.YDLR1G_selectionEdges:after{background:var(--dsw-alias-state-business-primary);content:\"\";width:3px;position:absolute;top:0;bottom:0}.YDLR1G_selectionEdges:before{left:0}.YDLR1G_selectionEdges:after{right:0}.YDLR1G_selectionEdges[data-dragging=true]:before,.YDLR1G_selectionEdges[data-dragging=true]:after{width:2px}.YDLR1G_selection[data-dragging=true]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}";

},
"src/modules/trajectory/layout.js": function(module, exports, require) {
// source: src/modules/trajectory/layout.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveTrajectoryLayout = deriveTrajectoryLayout;
exports.appendTrajectoryPartialLayout = appendTrajectoryPartialLayout;
const runtime_types_1 = require("../shared/runtime-types");
const usage_value_1 = require("./usage-value");
const trajectory_record_1 = require("./trajectory-record");
function layoutEntryOrder(entry) {
    return entry.kind === 'system' && entry.change.kind === 'initial'
        ? Number.NEGATIVE_INFINITY
        : entry.seq;
}
function inputCellDetail(node) {
    const previewMarkdown = previewContent(node.content);
    return {
        text: '',
        ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
        sourceSeq: node.seq,
        messageSource: node.source,
        inputDetail: detailContent(node.content),
        sourceBlocks: node.content.map(block => sourceBlock(block)),
        timeSeconds: 0,
        startedAt: finiteTime(node.time),
    };
}
/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @returns turns ordered by first appearance.
 */
function deriveTrajectoryLayout(input) {
    const { nodes, eventLocations, partial, runningCalls, requests = [], callSchemas, } = input;
    const resultByCall = indexResults(nodes);
    const callById = new Map(resultByCall);
    for (const call of runningCalls)
        callById.set(call.callId, call);
    const emittedCallIds = indexAssistantCallIds(nodes);
    const followingAssistants = indexFollowingAssistants(nodes);
    const callStartById = new Map();
    for (const result of resultByCall.values()) {
        const startedAt = finiteTime(result.callTime);
        if (startedAt !== null)
            callStartById.set(result.callId, startedAt);
    }
    for (const call of runningCalls) {
        const startedAt = finiteTime(call.time);
        if (startedAt !== null)
            callStartById.set(call.callId, startedAt);
    }
    const turns = new Map();
    const standaloneCompactions = [];
    let index = 0;
    let prevAbsTime = null;
    let lastAssistantTurn = null;
    const bucket = (turn) => {
        let entry = turns.get(turn);
        if (entry === undefined) {
            entry = { groups: [] };
            turns.set(turn, entry);
        }
        return entry;
    };
    const pushMessage = (turn, laid) => {
        const groups = bucket(turn).groups;
        const last = groups.at(-1);
        if (last?.title === 'Message') {
            last.laid.push(laid);
            return;
        }
        groups.push({ title: 'Message', laid: [laid] });
    };
    const pushStep = (turn, step, laid) => {
        if (laid.length === 0)
            return;
        const groups = bucket(turn).groups;
        const title = `Step ${step}`;
        const existing = groups.find(group => group.title === title);
        if (existing !== undefined) {
            existing.laid.push(...laid);
            return;
        }
        groups.push({ title, laid: [...laid] });
    };
    const pushStepInput = (turn, step, laid) => {
        if (laid.length === 0)
            return;
        const groups = bucket(turn).groups;
        const title = `Step ${step}`;
        const existing = groups.find(group => group.title === title);
        if (existing === undefined) {
            groups.push({ title, laid: [...laid] });
            return;
        }
        const request = existing.laid.findIndex(entry => entry.cell.requestOnly === true);
        if (request === -1)
            existing.laid.push(...laid);
        else
            existing.laid.splice(request, 0, ...laid);
    };
    const representedRequests = new Set();
    for (const node of nodes) {
        if (node.kind === 'assistant' && node.step > 0) {
            representedRequests.add(`${node.turn}\u0000${node.step}`);
        }
    }
    if (partial !== null && partial.step > 0) {
        representedRequests.add(`${partial.turn}\u0000${partial.step}`);
    }
    for (const call of runningCalls) {
        if (call.step > 0)
            representedRequests.add(`${call.turn}\u0000${call.step}`);
    }
    const entries = [
        ...nodes.map((node, nodeIndex) => ({
            kind: 'node',
            seq: node.seq,
            node,
            nodeIndex,
        })),
        ...requests
            .filter((request) => request.purpose === 'compaction')
            .map(request => ({
            kind: 'compaction',
            seq: request.startSeq,
            request,
        })),
        ...requests.flatMap(request => request.purpose !== 'assistant'
            || request.promptChange === undefined
            || request.prompt === undefined
            ? []
            : [{
                    kind: 'system',
                    seq: request.promptChange.seq,
                    request,
                    change: request.promptChange,
                }]),
        ...requests
            .filter((request) => request.purpose === 'assistant')
            .filter(request => !representedRequests.has(`${request.turn}\u0000${request.step}`))
            .map(request => ({
            kind: 'request',
            seq: request.startSeq,
            request,
        })),
    ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right));
    for (const entry of entries) {
        if (entry.kind === 'request') {
            const { request } = entry;
            pushStep(request.turn, request.step, [{
                    absTime: finiteTime(request.startedAt),
                    cell: {
                        index: ++index,
                        kind: 'message',
                        text: '',
                        sourceSeq: request.startSeq,
                        requestOnly: true,
                        timeSeconds: request.completedAt === null
                            ? null
                            : durationSeconds(request.completedAt, request.startedAt),
                        startedAt: finiteTime(request.startedAt),
                        ...(request.status === 'error' ? { isError: true } : {}),
                    },
                }]);
            prevAbsTime = finiteTime(request.completedAt)
                ?? finiteTime(request.startedAt)
                ?? prevAbsTime;
            continue;
        }
        if (entry.kind === 'system') {
            const { change, request } = entry;
            const turn = change.kind === 'initial'
                ? firstVisibleTurn(nodes, partial)
                : enclosingPromptTurn(nodes, change.seq, partial);
            pushMessage(turn, {
                absTime: finiteTime(change.time),
                cell: {
                    index: ++index,
                    kind: 'system',
                    text: promptChangeLabel(change),
                    sourceSeq: change.seq,
                    ...(request.prompt === undefined ? {} : { promptDetail: request.prompt }),
                    ...(change.previous === undefined
                        ? {}
                        : { previousPromptDetail: change.previous }),
                    timeSeconds: 0,
                    startedAt: finiteTime(change.time),
                },
            });
            prevAbsTime = finiteTime(change.time) ?? prevAbsTime;
            continue;
        }
        if (entry.kind === 'compaction') {
            const request = entry.request;
            const rawOutput = request.rawOutput ?? request.summary;
            const thinkingDetail = rawOutput === undefined
                ? ''
                : detailReasoning(rawOutput);
            const cell = {
                index: ++index,
                kind: 'compacted',
                ...(request.status === 'skipped' || request.status === 'cancelled' ? { compactionTerminalState: request.status } : {}),
                text: request.status === 'running'
                    ? 'Compacting context…'
                    : request.status === 'skipped'
                        ? 'Compaction skipped · Original history unchanged'
                        : request.status === 'cancelled'
                            ? 'Compaction interrupted · Original history unchanged'
                            : request.status === 'error'
                                ? request.error ?? 'Compaction failed'
                                : request.summary === undefined
                                    ? 'Context compacted'
                                    : '',
                ...(request.status === 'complete' && request.summary !== undefined
                    ? previewContentProperty(request.summary)
                    : {}),
                sourceSeq: request.startSeq,
                ...(request.summary === undefined
                    ? {}
                    : {
                        outputDetail: detailContent(request.summary),
                        outputBlocks: request.summary.map(block => sourceBlock(block)),
                    }),
                ...(thinkingDetail === '' ? {} : { thinkingDetail }),
                ...(rawOutput === undefined
                    ? {}
                    : { sourceBlocks: rawOutput.map(block => sourceBlock(block)) }),
                ...(request.status === 'error' ? { isError: true } : {}),
                timeSeconds: request.completedAt === null
                    ? null
                    : durationSeconds(request.completedAt, request.startedAt),
                startedAt: finiteTime(request.startedAt),
            };
            attachUsage(cell, (0, usage_value_1.usageValue)(request.usage));
            const compaction = {
                groups: [{
                        title: `Compaction ${request.startSeq}`,
                        laid: [{
                                absTime: finiteTime(request.startedAt),
                                cell,
                            }],
                    }],
            };
            if (request.turn === null)
                standaloneCompactions.push(compaction);
            else
                bucket(request.turn).groups.push(...compaction.groups);
            prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime;
            continue;
        }
        const { node, nodeIndex: i } = entry;
        if (node.kind === 'user') {
            // user/message has no turn on the wire; enclose it in the next assistant
            // (or partial) turn, else open the turn after the last assistant.
            const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn);
            pushMessage(turn, {
                absTime: finiteTime(node.time),
                cell: {
                    index: ++index,
                    kind: 'user',
                    ...inputCellDetail(node),
                    opensTurn: true,
                },
            });
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
            continue;
        }
        if (node.kind === 'steering') {
            const placement = steeringPlacement(followingAssistants[i], partial, lastAssistantTurn, eventLocations?.get(node.seq));
            const laid = {
                absTime: finiteTime(node.time),
                cell: {
                    index: ++index,
                    kind: 'user',
                    ...inputCellDetail(node),
                },
            };
            if (placement.step === undefined)
                pushMessage(placement.turn, laid);
            else
                pushStepInput(placement.turn, placement.step, [laid]);
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
            continue;
        }
        if (node.kind === 'assistant') {
            const laidList = withSubCalls(expandAssistant(node, index + 1, prevAbsTime, resultByCall, callStartById, callById));
            if (node.step > 0)
                pushStep(node.turn, node.step, laidList);
            else
                for (const laid of laidList)
                    pushMessage(node.turn, laid);
            const last = laidList[laidList.length - 1];
            if (last !== undefined)
                index = last.cell.index;
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
            lastAssistantTurn = node.turn;
            continue;
        }
        if (node.kind === 'context') {
            const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn);
            pushMessage(turn, {
                absTime: finiteTime(node.time),
                cell: {
                    index: ++index,
                    kind: 'context',
                    ...inputCellDetail(node),
                },
            });
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
            continue;
        }
        if (node.kind === 'compaction') {
            // Chat owns the human-facing compaction marker. It contributes no
            // duplicate trajectory cell, but still advances the duration cursor.
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
            continue;
        }
        if (node.kind === 'tool-result') {
            if (!emittedCallIds.has(node.callId)) {
                const toolName = node.call?.name;
                const resultPreview = summarizeResult(node);
                const laidList = [{
                        absTime: finiteTime(node.callTime ?? node.time),
                        ...(toolName !== undefined ? { toolName } : {}),
                        callId: node.callId,
                        subCalls: node.subCalls,
                        cell: {
                            index: ++index,
                            kind: 'tool',
                            sourceSeq: node.seq,
                            ...(node.call !== null
                                ? summarizeCall(node.call.name, node.call.argsRaw)
                                : resultAsText(resultPreview)),
                            ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
                            outputDetail: detailResult(node),
                            outputBlocks: node.content.map(block => sourceBlock(block)),
                            ...resultPreview,
                            callId: node.callId,
                            isError: node.isError,
                            timeSeconds: durationSeconds(node.time, node.callTime),
                            startedAt: finiteTime(node.callTime),
                        },
                    }];
                for (const laid of expandSubCalls(node.subCalls, index)) {
                    laidList.push(laid);
                    index = laid.cell.index;
                }
                pushStep(0, 1, laidList);
            }
            prevAbsTime = finiteTime(node.time) ?? prevAbsTime;
        }
    }
    if (partial !== null) {
        const fake = {
            kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
            turn: partial.turn, step: partial.step, blocks: partial.blocks,
        };
        const laidList = withSubCalls(expandAssistant(fake, index + 1, prevAbsTime, resultByCall, callStartById, callById, { streaming: true }));
        if (partial.step > 0)
            pushStep(partial.turn, partial.step, laidList);
        else
            for (const laid of laidList)
                pushMessage(partial.turn, laid);
        const last = laidList[laidList.length - 1];
        if (last !== undefined)
            index = last.cell.index;
    }
    const seenCalls = collectCallIds(turns);
    for (const call of runningCalls) {
        if (seenCalls.has(call.callId))
            continue;
        const laidList = [{
                absTime: null,
                toolName: call.name,
                callId: call.callId,
                subCalls: call.subCalls,
                cell: {
                    index: ++index,
                    kind: 'tool',
                    ...summarizeCall(call.name, call.argsRaw),
                    inputDetail: call.argsRaw,
                    callId: call.callId,
                    timeSeconds: null,
                    startedAt: finiteTime(call.time),
                },
            }];
        for (const laid of expandSubCalls(call.subCalls, index)) {
            laidList.push(laid);
            index = laid.cell.index;
        }
        if (call.step > 0)
            pushStep(call.turn, call.step, laidList);
        else
            for (const laid of laidList)
                pushMessage(call.turn, laid);
    }
    // Orphan turn-0 cells (orphaned tools) fold into Turn 1.
    const prologue = turns.get(0);
    if (prologue !== undefined) {
        turns.delete(0);
        const emptyTurn = () => ({ groups: [] });
        const first = turns.get(1) ?? emptyTurn();
        first.groups = [...prologue.groups, ...first.groups];
        turns.set(1, first);
    }
    for (const entry of [...turns.values(), ...standaloneCompactions]) {
        for (const group of entry.groups) {
            for (const laid of group.laid)
                attachToolSchema(laid, callSchemas);
        }
    }
    return [
        ...[...turns.entries()].map(([turn, entry]) => toTurnModel(turn, entry)),
        ...standaloneCompactions.map(entry => toTurnModel(null, entry)),
    ].sort((left, right) => firstCellIndex(left) - firstCellIndex(right));
}
/**
 * Append the changing in-flight assistant cells to a stable finalized layout.
 * @param turns - Finalized layout derived with an empty-block partial anchor.
 * @param partial - Current in-flight assistant projection.
 * @param lastIndex - Highest cell index in the finalized layout.
 * @returns The original layout without a partial, otherwise a layout sharing every unaffected turn.
 */
function appendTrajectoryPartialLayout(turns, partial, lastIndex) {
    if (partial === null)
        return turns;
    const partialTurn = deriveTrajectoryLayout({
        nodes: [],
        partial,
        runningCalls: [],
    }).at(0);
    if (partialTurn === undefined)
        return turns;
    const streamed = {
        ...partialTurn,
        groups: partialTurn.groups.map(group => ({
            ...group,
            cells: group.cells.map(cell => ({ ...cell, index: cell.index + lastIndex })),
        })),
    };
    const turnIndex = turns.findIndex(turn => turn.turn === streamed.turn);
    if (turnIndex === -1)
        return [...turns, streamed];
    const current = turns[turnIndex];
    /* v8 ignore next -- findIndex proved the dense array position exists. */
    if (current === undefined)
        return turns;
    const groups = [...current.groups];
    for (const streamedGroup of streamed.groups) {
        const groupIndex = groups.findIndex(group => group.title === streamedGroup.title);
        if (groupIndex === -1) {
            groups.push(streamedGroup);
            continue;
        }
        const group = groups[groupIndex];
        /* v8 ignore next -- findIndex proved the dense array position exists. */
        if (group === undefined)
            continue;
        const streamedCallIds = new Set(streamedGroup.cells.flatMap(cell => cell.callId === undefined ? [] : [cell.callId]));
        groups[groupIndex] = {
            ...streamedGroup,
            cells: [
                ...group.cells.filter(cell => cell.requestOnly !== true
                    && (cell.callId === undefined || !streamedCallIds.has(cell.callId))),
                ...streamedGroup.cells,
            ],
        };
    }
    const updated = [...turns];
    updated[turnIndex] = { ...current, groups };
    return updated;
}
function attachToolSchema(laid, callSchemas) {
    if (laid.callId === undefined || callSchemas === undefined)
        return;
    const schema = callSchemas.get(laid.callId);
    if (schema === undefined)
        return;
    laid.cell.schemaDetail = JSON.stringify(schema, null, 2);
}
function toTurnModel(turn, entry) {
    const groups = entry.groups.map(({ title, laid }) => {
        const description = groupDescription(laid);
        return {
            title,
            ...(description !== undefined ? { description } : {}),
            cells: laid.map(l => l.cell),
        };
    });
    return { turn, groups };
}
/** Chronological section position from the fold's monotonically assigned cell indexes. */
function firstCellIndex(turn) {
    return Math.min(...turn.groups.flatMap(group => group.cells.map(cell => cell.index)), Number.POSITIVE_INFINITY);
}
/** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */
function groupDescription(laid) {
    const parts = [];
    // Tool rows contribute start (absTime) and end (start + own duration) so a
    // single Tool cell still spans call→result for the group wall clock.
    const times = [];
    for (const l of laid) {
        if (l.absTime === null || !Number.isFinite(l.absTime))
            continue;
        times.push(l.absTime);
        if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
            times.push(l.absTime + l.cell.timeSeconds * 1000);
        }
    }
    if (times.length >= 2) {
        const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000);
        if (span !== undefined)
            parts.push(span);
    }
    else if (times.length === 1) {
        const own = laid.find(l => l.absTime === times[0])?.cell.timeSeconds;
        const span = own !== null && own !== undefined ? formatGroupDuration(own) : undefined;
        if (span !== undefined)
            parts.push(span);
    }
    const tools = new Map();
    for (const l of laid) {
        if (l.toolName === undefined || l.cell.kind !== 'tool')
            continue;
        tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1);
    }
    for (const [name, count] of tools) {
        parts.push(count > 1 ? `${name}×${count}` : name);
    }
    return parts.length === 0 ? undefined : parts.join(' ');
}
function formatGroupDuration(seconds) {
    if (!Number.isFinite(seconds))
        return undefined;
    return (0, trajectory_record_1.formatElapsedSeconds)(seconds);
}
/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later, earlier) {
    if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier))
        return null;
    return Math.max(0, (later - earlier) / 1000);
}
/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time) {
    return typeof time === 'number' && Number.isFinite(time) ? time : null;
}
function expandAssistant(node, startIndex, prevAbsTime, results, callStarts, calls, opts) {
    if (opts?.streaming === true && node.blocks.length === 0)
        return [];
    const out = [];
    let index = startIndex - 1;
    const usage = (0, usage_value_1.usageValue)(node.usage);
    const streaming = opts?.streaming === true;
    const recordedStart = finiteTime(node.timing?.stepStartTime);
    const messageDuration = streaming
        ? null
        : durationSeconds(node.time, recordedStart ?? prevAbsTime);
    const nodeAbs = streaming ? null : finiteTime(node.time);
    const messageText = node.blocks
        .filter(block => block.kind === 'text' && (!streaming || block.text !== ''))
        .map(block => block.kind === 'text' ? block.text : '')
        .join('\n\n');
    const thinkingText = node.blocks
        .filter(block => block.kind === 'reasoning' && (!streaming || block.text !== ''))
        .map(block => block.kind === 'reasoning' ? block.text : '')
        .join('\n\n');
    const message = {
        index: ++index,
        recordId: `assistant\u0000${node.turn}\u0000${node.step}`,
        kind: 'message',
        sourceSeq: node.seq,
        text: messageText !== '' || thinkingText !== ''
            ? ''
            : summarizeAssistantActivity(node.blocks),
        ...(messageText !== ''
            ? { previewMarkdown: messageText }
            : thinkingText !== ''
                ? { previewMarkdown: thinkingText }
                : {}),
        ...(messageText !== '' ? { outputDetail: messageText } : {}),
        ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
        sourceBlocks: node.blocks.map(block => assistantSourceBlock(block)),
        timeSeconds: messageDuration,
        startedAt: recordedStart,
    };
    attachUsage(message, usage);
    message.assistantMetrics = {
        timingRecorded: node.timing !== undefined,
        stepStartTime: node.timing?.stepStartTime ?? null,
        firstTokenTime: node.timing?.firstTokenTime ?? null,
        completedTime: streaming ? null : finiteTime(node.time),
        usageProvided: usage !== undefined,
        outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? null : null,
    };
    out.push({ absTime: nodeAbs, cell: message });
    for (const block of node.blocks) {
        // Text and reasoning belong to the one Assistant record emitted above.
        if (block.kind !== 'tool-call')
            continue;
        const result = results.get(block.callId);
        const toolDuration = streaming || result === undefined
            ? null
            : durationSeconds(result.time, result.callTime);
        const callAbs = finiteTime(callStarts.get(block.callId));
        const call = calls.get(block.callId);
        const resultPreview = result === undefined ? undefined : summarizeResult(result);
        out.push({
            absTime: callAbs,
            toolName: block.name,
            callId: block.callId,
            ...(call === undefined ? {} : { subCalls: call.subCalls }),
            cell: {
                index: ++index, kind: 'tool',
                ...summarizeCall(block.name, block.argsRaw),
                inputDetail: block.argsRaw,
                callId: block.callId,
                ...(result !== undefined
                    ? {
                        outputDetail: detailResult(result),
                        outputBlocks: result.content.map(block => sourceBlock(block)),
                        ...resultPreview,
                        isError: result.isError,
                    }
                    : {}),
                timeSeconds: toolDuration,
                startedAt: callAbs,
            },
        });
    }
    return out;
}
function summarizeAssistantActivity(blocks) {
    const tools = new Map();
    for (const block of blocks) {
        if (block.kind !== 'tool-call')
            continue;
        tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
    }
    if (tools.size > 0) {
        return 'Tool call only';
    }
    return '';
}
function promptChangeLabel(change) {
    if (change.kind === 'initial')
        return 'Initial System Prompt';
    if (change.kind === 'system')
        return 'System Prompt Updated';
    if (change.kind === 'tools')
        return 'Tools Updated';
    return 'System Prompt and Tools Updated';
}
function assistantSourceBlock(block) {
    switch (block.kind) {
        case 'text': return { type: 'text', content: block.text };
        case 'reasoning': return { type: 'thinking', content: block.text };
        case 'tool-call': return {
            type: 'tool-call',
            content: block.argsRaw,
            callId: block.callId,
            toolName: block.name,
        };
        // Attachment refs carry no fetchable bytes, so the record shows the
        // durable metadata instead of an inline preview.
        case 'image': return {
            type: 'image',
            content: stringifySourceValue(block.attachment),
        };
        case 'other': return sourceBlock(block.block);
    }
}
function sourceBlock(value) {
    if (typeof value !== 'object' || value === null) {
        return { type: 'unknown', content: stringifySourceValue(value) };
    }
    const block = (0, runtime_types_1.objectValue)(value);
    const type = typeof block.type === 'string' ? block.type : 'unknown';
    if (typeof block.text === 'string') {
        return { type: type === 'reasoning' ? 'thinking' : type, content: block.text };
    }
    const imageSrc = sourceImage(block);
    const imageAlt = typeof block.alt === 'string' ? block.alt : undefined;
    return {
        type,
        content: imageSrc === undefined ? stringifySourceValue(value) : '',
        ...(imageSrc !== undefined ? { imageSrc } : {}),
        ...(imageAlt !== undefined ? { imageAlt } : {}),
    };
}
function sourceImage(block) {
    if (typeof block.type !== 'string' || !block.type.toLowerCase().includes('image'))
        return undefined;
    for (const candidate of [block.url, block.image_url]) {
        if (typeof candidate === 'string')
            return safeImageSource(candidate);
    }
    if (typeof block.data === 'string') {
        const mediaType = [block.mimeType, block.mediaType, block.media_type]
            .find((candidate) => typeof candidate === 'string')
            ?? 'image/png';
        return safeImageSource(block.data.startsWith('data:')
            ? block.data
            : `data:${mediaType};base64,${block.data}`);
    }
    if (typeof block.source !== 'object' || block.source === null)
        return undefined;
    const source = (0, runtime_types_1.objectValue)(block.source);
    if (typeof source.url === 'string')
        return safeImageSource(source.url);
    if (typeof source.data !== 'string')
        return undefined;
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return safeImageSource(`data:${mediaType};base64,${source.data}`);
}
function safeImageSource(value) {
    if (value.startsWith('data:image/') || value.startsWith('blob:'))
        return value;
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function stringifySourceValue(value) {
    const json = JSON.stringify(value, null, 2);
    return json || String(value);
}
/**
 * Turn that encloses a user/message: next assistant turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(followingAssistant, partial, lastAssistantTurn) {
    if (followingAssistant !== undefined)
        return followingAssistant.turn;
    if (partial !== null)
        return partial.turn;
    if (lastAssistantTurn !== null)
        return lastAssistantTurn + 1;
    return 1;
}
function steeringPlacement(followingAssistant, partial, lastAssistantTurn, location) {
    if (location?.kind === 'step') {
        return { turn: location.turn.turn, step: location.step.step };
    }
    const locatedTurn = location?.kind === 'turn' ? location.turn.turn : undefined;
    if (followingAssistant !== undefined
        && (locatedTurn === undefined || followingAssistant.turn === locatedTurn)) {
        return {
            turn: followingAssistant.turn,
            ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
        };
    }
    if (partial !== null && (locatedTurn === undefined || partial.turn === locatedTurn)) {
        return { turn: partial.turn, ...(partial.step > 0 ? { step: partial.step } : {}) };
    }
    if (locatedTurn !== undefined)
        return { turn: locatedTurn };
    return { turn: lastAssistantTurn ?? 1 };
}
function indexFollowingAssistants(nodes) {
    const following = new Array(nodes.length);
    let assistant;
    for (let index = nodes.length - 1; index >= 0; index--) {
        following[index] = assistant;
        const node = nodes[index];
        if (node?.kind === 'assistant')
            assistant = node;
    }
    return following;
}
function enclosingPromptTurn(nodes, seq, partial) {
    const next = nodes.find(node => node.seq > seq && node.kind === 'assistant' && node.step > 0);
    if (next?.kind === 'assistant')
        return next.turn;
    return partial?.turn ?? 1;
}
/** Earliest raw turn represented by the selected trajectory branch. */
function firstVisibleTurn(nodes, partial) {
    const turns = nodes.flatMap(node => node.kind === 'assistant' && node.turn > 0
        ? [node.turn]
        : []);
    if (partial !== null && partial.turn > 0)
        turns.push(partial.turn);
    return turns.length === 0 ? 1 : Math.min(...turns);
}
/** Copy provider usage onto a Message cell when present. */
function attachUsage(cell, usage) {
    if (usage === undefined)
        return;
    if (usage.inputTokens !== undefined)
        cell.input = usage.inputTokens;
    if (usage.cacheReadTokens !== undefined)
        cell.cacheRead = usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined)
        cell.cacheWrite = usage.cacheWriteTokens;
    if (usage.outputTokens !== undefined)
        cell.output = usage.outputTokens;
    if (usage.reasoningTokens !== undefined)
        cell.think = usage.reasoningTokens;
}
function indexResults(nodes) {
    const map = new Map();
    for (const node of nodes) {
        if (node.kind === 'tool-result')
            map.set(node.callId, node);
    }
    return map;
}
function indexAssistantCallIds(nodes) {
    const ids = new Set();
    for (const node of nodes) {
        if (node.kind !== 'assistant')
            continue;
        for (const block of node.blocks) {
            if (block.kind === 'tool-call')
                ids.add(block.callId);
        }
    }
    return ids;
}
function collectCallIds(turns) {
    const ids = new Set();
    for (const entry of turns.values()) {
        for (const group of entry.groups) {
            for (const laid of group.laid) {
                if (laid.callId !== undefined)
                    ids.add(laid.callId);
            }
        }
    }
    return ids;
}
/** Interleave each tool cell's nested child calls right after it, reindexing followers. */
function withSubCalls(laidList) {
    if (!laidList.some(laid => laid.subCalls !== undefined && laid.subCalls.length > 0))
        return laidList;
    const out = [];
    let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0;
    for (const laid of laidList) {
        out.push({ ...laid, cell: { ...laid.cell, index: ++index } });
        for (const sub of expandSubCalls(laid.subCalls, index)) {
            out.push(sub);
            index = sub.cell.index;
        }
    }
    return out;
}
/** Sub-dispatch cells for one run_code parent, in start order (running = null duration). */
function expandSubCalls(subs, startIndex) {
    if (subs === undefined || subs.length === 0)
        return [];
    const out = [];
    let index = startIndex;
    for (const sub of subs) {
        const settled = 'kind' in sub;
        const resultPreview = settled ? summarizeResult(sub) : undefined;
        const laid = {
            absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
            toolName: settled ? sub.call?.name ?? sub.callId : sub.name,
            callId: sub.callId,
            cell: {
                index: ++index,
                kind: 'subtool',
                callId: sub.callId,
                ...(settled
                    ? (sub.call !== null
                        ? summarizeCall(sub.call.name, sub.call.argsRaw)
                        : resultAsText(resultPreview))
                    : summarizeCall(sub.name, sub.argsRaw)),
                ...(settled
                    ? (sub.call !== null ? { inputDetail: sub.call.argsRaw } : {})
                    : { inputDetail: sub.argsRaw }),
                ...(settled
                    ? {
                        outputDetail: detailResult(sub),
                        outputBlocks: sub.content.map(block => sourceBlock(block)),
                        ...resultPreview,
                        isError: sub.isError,
                    }
                    : {}),
                // The code-dispatch start/settle pair carries per-sub-call wall time;
                // a running (unsettled) or pre-pair log entry shows the em dash.
                timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
                startedAt: settled
                    ? finiteTime(sub.callTime)
                    : finiteTime(sub.time),
            },
        };
        out.push(laid);
        for (const child of expandSubCalls(sub.subCalls, index)) {
            out.push(child);
            index = child.cell.index;
        }
    }
    return out;
}
function summarizeCall(name, argsRaw) {
    return {
        text: name,
        ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }),
    };
}
function summarizeResult(node) {
    if (node.isError) {
        return { result: node.error?.code ?? 'error' };
    }
    for (const block of node.content) {
        if ((0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            return { result: '', resultPreviewMarkdown: block.text };
        }
    }
    return { result: 'No output' };
}
function resultAsText(result) {
    return {
        text: result?.result ?? '',
        ...(result?.resultPreviewMarkdown === undefined
            ? {}
            : { previewMarkdown: result.resultPreviewMarkdown }),
    };
}
function detailResult(node) {
    if (node.isError) {
        return node.error === undefined
            ? 'error'
            : `${node.error.name}: ${node.error.code}`;
    }
    const text = node.content
        .flatMap(block => (0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
        .join('\n');
    if (text !== '')
        return text;
    if (node.content.length === 0
        || node.content.every(block => (0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && (typeof block.text !== 'string' || block.text === '')))
        return 'No output';
    return JSON.stringify(node.content, null, 2);
}
function detailContent(content) {
    return content
        .flatMap(block => (0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
        .join('\n');
}
function detailReasoning(content) {
    return content
        .flatMap(block => (0, runtime_types_1.isObjectRecord)(block) && block.type === 'reasoning' && typeof block.text === 'string' ? [block.text] : [])
        .join('\n');
}
function previewContent(content) {
    for (const block of content) {
        if ((0, runtime_types_1.isObjectRecord)(block) && block.type === 'text' && typeof block.text === 'string')
            return block.text;
    }
    return undefined;
}
function previewContentProperty(content) {
    const previewMarkdown = previewContent(content);
    return previewMarkdown === undefined ? {} : { previewMarkdown };
}

},
"src/modules/trajectory/trajectory-search-index.js": function(module, exports, require) {
// source: src/modules/trajectory/trajectory-search-index.ts

"use strict";
/** Incremental full-text index for the trajectory ledger. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectorySearchIndex = void 0;
const trajectory_record_1 = require("./trajectory-record");
const trajectory_preview_1 = require("./trajectory-preview");
function searchableJson(value) {
    if (value === undefined)
        return '';
    try {
        return JSON.stringify(value);
    }
    catch {
        return '';
    }
}
function sameSources(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function markdownPreview(cell) {
    if (cell.previewMarkdown === undefined)
        return '';
    const preview = (0, trajectory_preview_1.trajectoryPreviewText)(cell.previewMarkdown);
    if (cell.text === '')
        return preview;
    return preview === '' ? cell.text : `${cell.text} · ${preview}`;
}
function resultPreview(cell) {
    return cell.resultPreviewMarkdown === undefined
        ? cell.result ?? ''
        : (0, trajectory_preview_1.trajectoryPreviewText)(cell.resultPreviewMarkdown);
}
function recordSources(turn, group, cell) {
    const blocks = [
        ...(cell.sourceBlocks ?? []),
        ...(cell.outputBlocks ?? []),
    ];
    return [
        turn === null ? 'between turns' : `turn ${turn}`,
        group,
        cell.kind,
        cell.kind === 'message' ? 'assistant' : '',
        cell.text,
        cell.previewMarkdown ?? '',
        cell.inputDetail ?? '',
        cell.outputDetail ?? '',
        cell.thinkingDetail ?? '',
        cell.schemaDetail ?? '',
        cell.result ?? '',
        cell.resultPreviewMarkdown ?? '',
        cell.callId ?? '',
        ...blocks.flatMap(block => [
            block.type,
            block.content,
            block.callId ?? '',
            block.toolName ?? '',
            block.imageAlt ?? '',
        ]),
        searchableJson(cell.messageSource),
        searchableJson(cell.promptDetail),
        searchableJson(cell.previousPromptDetail),
    ];
}
/** Session-view-local index that reparses Markdown only when one record's source changes. */
class TrajectorySearchIndex {
    constructor() {
        this.entries = new Map();
    }
    /**
     * Incrementally synchronize one or more current trajectory layout slices.
     * @param layouts - Finalized and optional streaming layouts from the same view.
     * @returns Whether the indexed layout version changed.
     */
    update(layouts) {
        if (this.layouts === layouts)
            return false;
        this.layouts = layouts;
        const seen = new Set();
        for (const turns of layouts) {
            for (const turn of turns) {
                for (const group of turn.groups) {
                    for (const cell of group.cells) {
                        if (cell.requestOnly === true)
                            continue;
                        const id = (0, trajectory_record_1.trajectoryRecordId)(cell);
                        const sources = recordSources(turn.turn, group.title, cell);
                        const previous = this.entries.get(id);
                        const entry = previous !== undefined && sameSources(previous.sources, sources)
                            ? previous
                            : {
                                sources,
                                text: [
                                    ...sources,
                                    markdownPreview(cell),
                                    resultPreview(cell),
                                ].join('\n').toLocaleLowerCase(),
                            };
                        this.entries.set(id, entry);
                        seen.add(id);
                    }
                }
            }
        }
        for (const id of this.entries.keys()) {
            if (!seen.has(id))
                this.entries.delete(id);
        }
        return true;
    }
    /**
     * Match a query against the latest committed index version.
     * @param query - Space-separated case-insensitive search terms.
     * @returns Matching stable record identities, or `null` without a query.
     */
    search(query) {
        const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0)
            return null;
        const matches = new Set();
        for (const [id, entry] of this.entries) {
            if (terms.every(term => entry.text.includes(term)))
                matches.add(id);
        }
        return matches;
    }
}
exports.TrajectorySearchIndex = TrajectorySearchIndex;

},
"src/modules/trajectory/views.styles.js": function(module, exports, require) {
// source: src/modules/trajectory/views.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const views_css_1 = __importDefault(require("./views.css"));
const foundation_styles_1 = require("../shared/foundation-styles");
(0, foundation_styles_1.installStyles)("@xharness/dsh-client-ui-trajectory/views.module.css", '@xharness/dsh-client-ui-trajectory', views_css_1.default);
const classes = {
    "ledger": "mCzLya_ledger",
    "root": "mCzLya_root"
};
const styles = classes;
exports.default = styles;

},
"src/modules/trajectory/views.css": function(module, exports, require) {
// source: src/modules/trajectory/views.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".mCzLya_root{--dsh-trajectory-toolbar-height:32px;box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;display:flex;overflow:hidden}.mCzLya_ledger{z-index:0;isolation:isolate;--dsh-trajectory-bottom-clearance:calc(var(--dsh-composer-height,152px) + 16px);flex:1;min-width:0;min-height:0;display:flex;position:relative;overflow:hidden}";

}
};
const __dependencies = {"src/modules/trajectory/index.js":{"./duration-store":"src/modules/trajectory/duration-store.js","./locales":"src/modules/trajectory/locales.js","./trajectory-assistant-definition":"src/modules/trajectory/trajectory-assistant-definition.js","./trajectory-compaction-definition":"src/modules/trajectory/trajectory-compaction-definition.js","./trajectory-message-definitions":"src/modules/trajectory/trajectory-message-definitions.js","./trajectory-request-header-definition":"src/modules/trajectory/trajectory-request-header-definition.js","./trajectory-snapshot-builder":"src/modules/trajectory/trajectory-snapshot-builder.js","./trajectory-tool-definition":"src/modules/trajectory/trajectory-tool-definition.js","./TrajectoryView":"src/modules/trajectory/TrajectoryView.js"},"src/modules/trajectory/duration-store.js":{"./runtime":"src/modules/trajectory/runtime.js"},"src/modules/trajectory/runtime.js":{},"src/modules/trajectory/locales.js":{},"src/modules/trajectory/trajectory-assistant-definition.js":{"../shared/reception-metrics":"src/modules/shared/reception-metrics.js","../client-connection/contracts/llm/llm/brand":"src/modules/client-connection/contracts/llm/llm/brand.js","./wire-event-codec":"src/modules/trajectory/wire-event-codec.js","./runtime":"src/modules/trajectory/runtime.js","./trajectory-definition-common":"src/modules/trajectory/trajectory-definition-common.js"},"src/modules/shared/reception-metrics.js":{"./runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{},"src/modules/client-connection/contracts/llm/llm/brand.js":{},"src/modules/trajectory/wire-event-codec.js":{"../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","../shared/generated/session-terminal":"src/modules/shared/generated/session-terminal.js"},"src/modules/shared/compaction-outcome.js":{},"src/modules/shared/generated/session-terminal.js":{},"src/modules/trajectory/trajectory-definition-common.js":{},"src/modules/trajectory/trajectory-compaction-definition.js":{"../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","./wire-event-codec":"src/modules/trajectory/wire-event-codec.js","./trajectory-definition-common":"src/modules/trajectory/trajectory-definition-common.js"},"src/modules/trajectory/trajectory-message-definitions.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","../client-connection/contracts/llm/llm/brand":"src/modules/client-connection/contracts/llm/llm/brand.js","./wire-event-codec":"src/modules/trajectory/wire-event-codec.js","./runtime":"src/modules/trajectory/runtime.js","./trajectory-definition-common":"src/modules/trajectory/trajectory-definition-common.js"},"src/modules/trajectory/trajectory-request-header-definition.js":{"./wire-event-codec":"src/modules/trajectory/wire-event-codec.js","../shared/runtime-types":"src/modules/shared/runtime-types.js","./trajectory-definition-common":"src/modules/trajectory/trajectory-definition-common.js"},"src/modules/trajectory/trajectory-snapshot-builder.js":{"./snapshot-codec":"src/modules/trajectory/snapshot-codec.js"},"src/modules/trajectory/snapshot-codec.js":{"../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","../shared/runtime-types":"src/modules/shared/runtime-types.js","../client-connection/contracts/host/apiproxy/api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","./wire-event-codec":"src/modules/trajectory/wire-event-codec.js"},"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js":{"./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js":{},"src/modules/trajectory/trajectory-tool-definition.js":{"./wire-event-codec":"src/modules/trajectory/wire-event-codec.js","./trajectory-definition-common":"src/modules/trajectory/trajectory-definition-common.js"},"src/modules/trajectory/TrajectoryView.js":{"./snapshot-codec":"src/modules/trajectory/snapshot-codec.js","./usage-value":"src/modules/trajectory/usage-value.js","./TrajectoryTable":"src/modules/trajectory/TrajectoryTable.js","./TrajectoryToolbar":"src/modules/trajectory/TrajectoryToolbar.js","./TrajectoryTimeline":"src/modules/trajectory/TrajectoryTimeline.js","./layout":"src/modules/trajectory/layout.js","./timeline":"src/modules/trajectory/timeline.js","./trajectory-record":"src/modules/trajectory/trajectory-record.js","./trajectory-search-index":"src/modules/trajectory/trajectory-search-index.js","./trajectory-snapshot-builder":"src/modules/trajectory/trajectory-snapshot-builder.js","./views.styles":"src/modules/trajectory/views.styles.js"},"src/modules/trajectory/usage-value.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/trajectory/TrajectoryTable.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./vendor/react-virtual/src/index":"src/modules/trajectory/vendor/react-virtual/src/index.js","./primitives":"src/modules/trajectory/primitives.js","./vendor/diff/src/patch/create":"src/modules/trajectory/vendor/diff/src/patch/create.js","./trajectory-record":"src/modules/trajectory/trajectory-record.js","./trajectory-virtual-rows":"src/modules/trajectory/trajectory-virtual-rows.js","./trajectory-preview":"src/modules/trajectory/trajectory-preview.js","./TrajectoryTable.styles":"src/modules/trajectory/TrajectoryTable.styles.js"},"src/modules/trajectory/vendor/react-virtual/src/index.js":{"../../virtual-core/src/index":"src/modules/trajectory/vendor/virtual-core/src/index.js"},"src/modules/trajectory/vendor/virtual-core/src/index.js":{"./lazy-measurements":"src/modules/trajectory/vendor/virtual-core/src/lazy-measurements.js","./utils":"src/modules/trajectory/vendor/virtual-core/src/utils.js"},"src/modules/trajectory/vendor/virtual-core/src/lazy-measurements.js":{},"src/modules/trajectory/vendor/virtual-core/src/utils.js":{},"src/modules/trajectory/primitives.js":{},"src/modules/trajectory/vendor/diff/src/patch/create.js":{"../diff/line":"src/modules/trajectory/vendor/diff/src/diff/line.js"},"src/modules/trajectory/vendor/diff/src/diff/line.js":{"./base":"src/modules/trajectory/vendor/diff/src/diff/base.js","../util/params":"src/modules/trajectory/vendor/diff/src/util/params.js"},"src/modules/trajectory/vendor/diff/src/diff/base.js":{},"src/modules/trajectory/vendor/diff/src/util/params.js":{},"src/modules/trajectory/trajectory-record.js":{},"src/modules/trajectory/trajectory-virtual-rows.js":{"./trajectory-record":"src/modules/trajectory/trajectory-record.js"},"src/modules/trajectory/trajectory-preview.js":{"./primitives":"src/modules/trajectory/primitives.js"},"src/modules/trajectory/TrajectoryTable.styles.js":{"./TrajectoryTable.css":"src/modules/trajectory/TrajectoryTable.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/trajectory/TrajectoryTable.css":{},"src/modules/shared/foundation-styles.js":{},"src/modules/trajectory/TrajectoryToolbar.js":{"./primitives":"src/modules/trajectory/primitives.js","./TrajectoryToolbar.styles":"src/modules/trajectory/TrajectoryToolbar.styles.js"},"src/modules/trajectory/TrajectoryToolbar.styles.js":{"./TrajectoryToolbar.css":"src/modules/trajectory/TrajectoryToolbar.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/trajectory/TrajectoryToolbar.css":{},"src/modules/trajectory/TrajectoryTimeline.js":{"./primitives":"src/modules/trajectory/primitives.js","./timeline":"src/modules/trajectory/timeline.js","./TrajectoryTimeline.styles":"src/modules/trajectory/TrajectoryTimeline.styles.js"},"src/modules/trajectory/timeline.js":{"./trajectory-record":"src/modules/trajectory/trajectory-record.js"},"src/modules/trajectory/TrajectoryTimeline.styles.js":{"./TrajectoryTimeline.css":"src/modules/trajectory/TrajectoryTimeline.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/trajectory/TrajectoryTimeline.css":{},"src/modules/trajectory/layout.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./usage-value":"src/modules/trajectory/usage-value.js","./trajectory-record":"src/modules/trajectory/trajectory-record.js"},"src/modules/trajectory/trajectory-search-index.js":{"./trajectory-record":"src/modules/trajectory/trajectory-record.js","./trajectory-preview":"src/modules/trajectory/trajectory-preview.js"},"src/modules/trajectory/views.styles.js":{"./views.css":"src/modules/trajectory/views.css","../shared/foundation-styles":"src/modules/shared/foundation-styles.js"},"src/modules/trajectory/views.css":{}};
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
return __load("src/modules/trajectory/index.js");
}
});
