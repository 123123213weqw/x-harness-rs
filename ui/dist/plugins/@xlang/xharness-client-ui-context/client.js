// Generated from src/modules/context/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-context",
factory: (__externalRequire) => {
const __units = {
"src/modules/context/index.js": function(module, exports, require) {
// source: src/modules/context/index.tsx

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
exports.inject = void 0;
exports.apply = apply;
const runtime_types_1 = require("../shared/runtime-types");
function optionValue(header, key) { return (0, runtime_types_1.objectValue)((0, runtime_types_1.objectValue)(header).options)[key]; }
const React = __importStar(require("react"));
const { useEffect, useState } = React;
const h = React.createElement;
const TARGET = 'xharness-context';
const EMPTY = { requests: [], compactions: [] };
const STYLE_ID = 'xharness-context-inspector-style';
const HARNESS_LOCALE = 'xharness.harness';
const harnessLabels = {
    zh: {
        system: '系统提示词', tools: '工具', toolCount: '个工具', search: '搜索工具', request: '选择请求', requestNumber: '请求', step: '步骤',
        noRequest: '还没有可用的请求快照。', loading: '正在读取…', retry: '重试',
        notRecorded: '未记录；此请求未开启完整诊断。', captureFailed: '未记录；此请求的诊断捕获失败。',
        unavailable: '暂时无法读取，请重试。', noSystem: '此请求没有系统提示词。', noTools: '此请求没有工具。',
        noMatch: '没有匹配的工具。', noDescription: '没有描述。', parameters: '参数',
    },
    en: {
        system: 'System prompt', tools: 'Tools', toolCount: 'tools', search: 'Search tools', request: 'Select request', requestNumber: 'Request', step: 'Step',
        noRequest: 'No request snapshot yet.', loading: 'Loading…', retry: 'Retry',
        notRecorded: 'Not recorded; full diagnostics were disabled for this request.', captureFailed: 'Not recorded; diagnostic capture failed for this request.',
        unavailable: 'Could not load. Please retry.', noSystem: 'This request has no system prompt.', noTools: 'This request has no tools.',
        noMatch: 'No matching tools.', noDescription: 'No description.', parameters: 'Parameters',
    },
};
const defaultHarnessText = key => (0, runtime_types_1.textValue)((0, runtime_types_1.objectValue)(harnessLabels.zh)[key], key);
function locationFields(location) {
    if (location?.kind === 'step' && location.turn && location.step) {
        return { turn: location.turn.turn, step: location.step.step };
    }
    if (location?.kind === 'turn' && location.turn)
        return { turn: location.turn.turn };
    return {};
}
function contextNode(context, anchorSeq, data) {
    return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: TARGET,
        anchorSeq,
        data,
    };
}
const requestDefinition = {
    kind: 'xharness-context-request',
    target: TARGET,
    match: event => event.type === 'request/header'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({
        kind: 'request',
        seq: match.event.seq,
        time: match.event.time,
        reason: asObject(match.event.data).reason,
        header: asObject(asObject(match.event.data).header),
        ...locationFields(match.location),
    }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : contextNode(context, context.state.seq, context.state),
};
const usageDefinition = {
    kind: 'xharness-context-usage', target: TARGET,
    match: event => ((event.type === 'assistant/chunk' && (asObject(asObject(event.data).chunk).kind ?? asObject(asObject(event.data).chunk).type) === 'usage') || (event.type === 'assistant/message' && asObject(event.data).usage))
        ? { id: String(event.seq), role: 'start' } : null,
    start: (_context, match) => ({ kind: 'usage', seq: match.event.seq,
        usage: asObject(match.event.data).usage ?? asObject(asObject(match.event.data).chunk).usage ?? asObject(asObject(match.event.data).chunk).data,
        ...locationFields(match.location) }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined ? null : contextNode(context, context.state.seq, context.state),
};
const compactionDefinition = {
    kind: 'xharness-context-compaction',
    target: TARGET,
    match: event => event.type === 'compaction/summary'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({
        kind: 'compaction',
        seq: match.event.seq,
        time: match.event.time,
        ...asObject(match.event.data),
        ...locationFields(match.location),
    }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : contextNode(context, context.state.seq, context.state),
};
class ContextSnapshotBuilder {
    constructor() {
        this.empty = EMPTY;
        this.nodes = new Map();
    }
    replace({ nodes }) {
        this.nodes.clear();
        for (const node of nodes)
            this.nodes.set(node.key, node);
        return this.snapshot();
    }
    apply({ upserts }) {
        for (const node of upserts)
            this.nodes.set(node.key, node);
        return this.snapshot();
    }
    snapshot() {
        const ordered = [...this.nodes.values()]
            .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key));
        const requests = [], compactions = [];
        let active;
        for (const node of ordered) {
            if (node.data.kind === 'request') {
                active = { ...node.data };
                requests.push(active);
            }
            else if (node.data.kind === 'usage' && active
                && node.data.turn === active.turn && node.data.step === active.step) {
                active.usage = node.data.usage;
            }
            else if (node.data.kind === 'compaction')
                compactions.push(node.data);
        }
        return { requests, compactions };
    }
}
const viewDefinition = {
    target: TARGET,
    create: () => new ContextSnapshotBuilder(),
};
const asObject = runtime_types_1.objectValue;
function asArray(value) {
    return isUnknownArray(value) ? value : [];
}
function normalizedRequest(request) {
    const header = asObject(request?.header);
    const options = asObject(header.options);
    const config = Object.keys(asObject(header.config)).length > 0
        ? asObject(header.config)
        : {
            provider: header.provider ?? 'unknown',
            model: header.model ?? 'unknown',
            ...(header.reasoning_effort === undefined
                ? {}
                : { reasoningEffort: header.reasoning_effort }),
        };
    const input = asArray(header.input).map(asObject);
    const system = typeof header.system === 'string' ? header.system : '';
    const hasSystem = input.some(message => message?.role === 'system');
    return {
        request,
        header,
        config,
        options,
        tools: asArray(header.tools).map(asObject),
        messages: hasSystem || system.length === 0
            ? input
            : [{ role: 'system', content: system, synthetic: true }, ...input],
    };
}
function numberOrUndefined(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
// Full request bodies live outside ordinary event replay. At most the
// selected request is retained while Harness is open.
function useRequestAudits(sessionId, snapshot, selectedSeq) {
    const [loaded, setLoaded] = useState({ key: '', headers: new Map(), error: '', loading: false });
    const [attempt, setAttempt] = useState(0);
    const requests = snapshot.requests;
    const selected = requests.find(r => r.seq === selectedSeq) ?? requests.at(-1);
    const targets = selected && optionValue(selected.header, 'snapshotOnDemand') === true ? [selected] : [];
    const key = JSON.stringify([sessionId, targets.map(r => r.seq)]);
    useEffect(() => {
        let live = true;
        const controller = new AbortController();
        setLoaded({ key, headers: new Map(), error: '', loading: targets.length > 0 });
        if (targets.length === 0)
            return () => { live = false; controller.abort(); };
        const timeout = setTimeout(() => controller.abort(), 120000);
        (async () => {
            try {
                if (!sessionId)
                    throw Error('缺少会话标识，无法读取请求快照');
                const headers = new Map();
                // Only the selected request is hydrated, never a full history/compaction pair.
                for (const target of targets) {
                    const response = await fetch('/api/session.requestSnapshot', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'audit-' + Date.now() + '-' + target.seq, method: 'session.requestSnapshot', payload: { sessionId, seq: target.seq } }) });
                    if (!response.ok)
                        throw Error('快照读取失败：HTTP ' + response.status);
                    const raw = await response.json();
                    const envelope = asObject(raw), result = asObject(envelope.result);
                    if (!result.ok)
                        throw Error(result.error == null ? '请求快照不可用' : (0, runtime_types_1.errorText)(result.error));
                    const value = asObject(result.value);
                    if (value.sessionId !== sessionId || value.seq !== target.seq)
                        throw Error('快照身份不匹配');
                    headers.set(target.seq, asObject(value.header));
                }
                if (live)
                    setLoaded({ key, headers, error: '', loading: false });
            }
            catch (error) {
                if (live)
                    setLoaded({ key, headers: new Map(), error: controller.signal.aborted ? '读取超时，请重试' : (0, runtime_types_1.errorText)(error), loading: false });
            }
            finally {
                clearTimeout(timeout);
            }
        })();
        return () => { live = false; controller.abort(); clearTimeout(timeout); };
    }, [key, attempt]);
    const current = loaded.key === key ? loaded : { headers: new Map(), loading: targets.length > 0, error: '' };
    return { loading: current.loading, error: current.error, retry: () => setAttempt(n => n + 1),
        requests: requests.map(r => current.headers.has(r.seq) ? { ...r, header: current.headers.get(r.seq) ?? r.header } : r) };
}
// Display only the payload actually captured for this request. A missing audit
// is not an empty system prompt/tool registry, and never falls back to today's config.
function systemPromptText(view) {
    if (typeof view.header.system === 'string')
        return view.header.system;
    return view.messages.filter(message => message.role === 'system')
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '', null, 2))
        .join('\n\n');
}
function HarnessView({ useSession, sessionId, t = defaultHarnessText }) {
    const snapshot = useSession(state => state.views.get(TARGET) ?? EMPTY);
    // Keep selection/search scoped to the chat even if the slot reuses its React instance.
    const [selection, setSelection] = useState({ sessionId, seq: null, query: '' });
    const current = selection.sessionId === sessionId ? selection : { sessionId, seq: null, query: '' };
    useEffect(() => {
        setSelection(previous => previous.sessionId !== sessionId ? { sessionId, seq: null, query: '' }
            : previous.seq !== null && !snapshot.requests.some(request => request.seq === previous.seq)
                ? { ...previous, seq: null } : previous);
    }, [sessionId, snapshot.requests]);
    const audits = useRequestAudits(sessionId, snapshot, current.seq);
    const requests = audits.requests;
    const selected = requests.find(request => request.seq === current.seq) ?? requests.at(-1);
    if (selected === undefined) {
        return h('div', { className: 'xhctx-root xhctx-harness-root', 'data-conversation-composer-overlay': '' }, h('p', { className: 'xhctx-harness-empty' }, t('noRequest')));
    }
    const view = normalizedRequest(selected);
    const systemPrompt = systemPromptText(view);
    const needle = current.query.trim().toLocaleLowerCase();
    const tools = needle === '' ? view.tools : view.tools.filter(tool => `${(0, runtime_types_1.textValue)(tool.name)}\n${(0, runtime_types_1.textValue)(tool.description)}`.toLocaleLowerCase().includes(needle));
    const omitted = asObject(view.options.auditSnapshot);
    const missing = audits.loading ? t('loading') : audits.error ? t('unavailable') : omitted.kind === 'omitted'
        ? t(omitted.reason === 'archive_failed' ? 'captureFailed' : 'notRecorded') : undefined;
    const reportedCount = numberOrUndefined(view.options.toolCount);
    const toolCount = missing
        ? reportedCount !== undefined && Number.isSafeInteger(reportedCount) && reportedCount >= 0 ? reportedCount : undefined
        : view.tools.length;
    return h('div', { className: 'xhctx-root xhctx-harness-root', 'data-conversation-composer-overlay': '' }, [
        h('div', { className: 'xhctx-harness-toolbar', key: 'toolbar' }, h('select', {
            className: 'xhctx-select', value: selected.seq, disabled: requests.length < 2,
            onChange: (event) => setSelection({ ...current, seq: Number(event.target.value) }),
            'aria-label': t('request'), key: 'select',
        }, requests.map((request, index) => {
            const step = numberOrUndefined(optionValue(request.header, 'step')) ?? request.step;
            return h('option', { value: request.seq, key: request.seq }, step === undefined ? `${t('requestNumber')} ${index + 1}` : `${t('step')} ${step}`);
        }))),
        audits.error ? h('div', { className: 'xhctx-harness-notice', role: 'alert', key: 'error' }, [
            t('unavailable'), h('button', { type: 'button', onClick: audits.retry, key: 'retry' }, t('retry')),
        ]) : null,
        audits.loading ? h('p', { className: 'xhctx-harness-notice', role: 'status', key: 'loading' }, t('loading')) : null,
        h('section', { className: 'xhctx-panel xhctx-prompt-panel', key: 'system' }, [
            h('h3', { key: 'title' }, t('system')),
            systemPrompt.length > 0 ? h('pre', { className: 'xhctx-system-text', key: 'content' }, systemPrompt)
                : h('p', { className: 'xhctx-harness-empty', key: 'empty' }, missing ?? t('noSystem')),
        ]),
        h('section', { className: 'xhctx-panel xhctx-tools-panel', key: 'tools' }, [
            h('div', { className: 'xhctx-tool-head', key: 'head' }, [
                h('h3', { key: 'title' }, t('tools')),
                // Do not show a fake zero while loading an on-demand snapshot.
                !audits.loading && !audits.error && toolCount !== undefined ? h('span', { className: 'xhctx-tool-count', key: 'count' }, `${toolCount} ${t('toolCount')}`) : null,
                view.tools.length > 0 ? h('input', {
                    className: 'xhctx-tool-search', value: current.query,
                    onChange: (event) => setSelection({ ...current, query: event.target.value }),
                    placeholder: t('search'), 'aria-label': t('search'), type: 'search', key: 'search',
                }) : null,
            ]),
            h('div', { className: 'xhctx-registry', key: 'registry' }, tools.length > 0
                ? tools.map((tool, index) => h('details', { className: 'xhctx-registry-tool', key: `${selected.seq}-${(0, runtime_types_1.textValue)(tool.name, String(index))}-${index}` }, [
                    h('summary', { key: 'summary' }, h('code', null, (0, runtime_types_1.textValue)(tool.name, `tool-${index + 1}`))),
                    h('p', { key: 'description' }, (0, runtime_types_1.textValue)(tool.description, t('noDescription'))),
                    h('h4', { key: 'schema-title' }, t('parameters')),
                    h('pre', { key: 'schema' }, JSON.stringify(tool.parameters ?? {}, null, 2)),
                ]))
                : h('p', { className: 'xhctx-harness-empty' }, missing ?? (needle ? t('noMatch') : t('noTools')))),
        ]),
    ]);
}
// Match upstream Trajectory: the overlay marker bounds the shared host;
// only this view scrolls. Never reset Chat scroll state on stream updates.
// Grid rows must keep their intrinsic height rather than clip their panels.
const CSS = `
.xhctx-root{flex:1;min-height:0;min-width:0;overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);padding:14px 18px calc(var(--dsh-composer-height,150px) + 24px);box-sizing:border-box}
.xhctx-select{height:34px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:8px;padding:0 10px;font:inherit}
.xhctx-root.xhctx-harness-root{display:grid;grid-auto-rows:max-content;align-content:start;gap:24px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717)}
.xhctx-harness-toolbar{display:flex;justify-content:flex-end}.xhctx-harness-root .xhctx-select{max-width:100%;min-width:0;background:var(--dsw-alias-bg-base,#fff);color:inherit;border-color:var(--dsw-alias-border-l2,#e5e5e5);font-size:12px}
.xhctx-panel{min-width:0;margin:0;border:0;border-radius:0;box-shadow:none;background:transparent}.xhctx-panel h3{margin:0 0 12px;font-size:14px;font-weight:600;color:inherit}.xhctx-system-text{max-height:320px;overflow:auto;margin:0;padding:16px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fafafa);color:inherit;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
.xhctx-tool-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}.xhctx-tool-head h3{margin:0}.xhctx-tool-count{font-size:12px;color:var(--dsw-alias-label-secondary,#737373)}.xhctx-tool-search{margin-left:auto;width:200px;max-width:100%;min-height:32px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12px}
.xhctx-registry{display:grid;grid-template-columns:minmax(0,1fr)}.xhctx-registry-tool{min-width:0;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:transparent;color:inherit}.xhctx-registry-tool>summary{display:flex;align-items:center;gap:10px;min-height:42px;padding:8px 0;cursor:pointer;list-style:none}.xhctx-registry-tool>summary::-webkit-details-marker{display:none}.xhctx-registry-tool>summary:after{content:'›';margin-left:auto;transition:transform var(--xh-duration-control,150ms) var(--xh-ease-standard,ease)}.xhctx-registry-tool[open]>summary:after{transform:rotate(90deg)}.xhctx-registry-tool>summary code{font:500 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.xhctx-registry-tool p{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#737373);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6}.xhctx-registry-tool h4{margin:0 0 8px;color:var(--dsw-alias-label-secondary,#737373);font-size:11px;font-weight:500}.xhctx-registry-tool pre{margin:0 0 16px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fafafa);color:inherit;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.xhctx-harness-empty,.xhctx-harness-notice{margin:0;color:var(--dsw-alias-label-secondary,#737373);font-size:13px;line-height:1.6}.xhctx-harness-notice{display:flex;align-items:center;gap:10px}.xhctx-harness-notice button{color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:6px;padding:4px 8px;cursor:pointer}.xhctx-harness-root :is(select,input,summary,button):focus-visible{outline:2px solid currentColor;outline-offset:3px}

@media(max-width:760px){.xhctx-root{padding:10px 10px calc(var(--dsh-composer-height,150px) + 24px)}.xhctx-tool-search{width:100%;margin:0}}
`;
const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale'];
exports.inject = inject;
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(HARNESS_LOCALE, harnessLabels), 'xharness-harness: labels');
    const t = ctx.locale.bind(HARNESS_LOCALE);
    ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID);
        if (existing !== null)
            return () => { };
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
        return () => { style.remove(); };
    }, 'xharness-context: styles');
    ctx.conversationEvents.register(requestDefinition);
    ctx.conversationEvents.register(compactionDefinition);
    ctx.conversationEvents.register(usageDefinition);
    ctx.conversationViews.register(viewDefinition);
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'harness',
        order: 30,
        label: () => 'Harness',
        inject: () => ({ t }),
    }, HarnessView));
}
function isUnknownArray(value) { return Array.isArray(value); }

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

}
};
const __dependencies = {"src/modules/context/index.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/shared/runtime-types.js":{}};
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
return __load("src/modules/context/index.js");
}
});
