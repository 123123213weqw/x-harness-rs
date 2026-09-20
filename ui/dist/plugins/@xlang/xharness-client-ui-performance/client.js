// Generated from src/modules/performance/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-performance",
factory: (__externalRequire) => {
const __units = {
"src/modules/performance/index.js": function(module, exports, require) {
// source: src/modules/performance/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const PerformanceView_1 = require("./PerformanceView");
const locales_1 = require("./locales");
const styles_1 = require("./styles");
exports.inject = ['slots', 'locale'];
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { en: locales_1.en, zh: locales_1.zh }), 'performance: dictionaries');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = '@xlang/xharness-client-ui-performance'; style.textContent = styles_1.CSS; document.head.append(style); return () => style.remove(); }, 'performance: styles');
    const t = ctx.locale.bind(locales_1.NS);
    ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'performance', order: 31, label: () => t('title'), inject: () => ({ t }) }, PerformanceView_1.PerformanceView));
}

},
"src/modules/performance/PerformanceView.js": function(module, exports, require) {
// source: src/modules/performance/PerformanceView.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerformanceView = PerformanceView;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const contract_1 = require("./contract");
const chart_1 = require("./chart");
const tracks = [['textUnits', 'text'], ['reasoningUnits', 'reasoning'], ['argumentUnits', 'arguments']];
const format = (n) => n.toFixed(1);
function PerformanceView({ useProjection, t }) {
    const raw = useProjection('performanceTimeline');
    const timeline = (0, react_1.useMemo)(() => (0, contract_1.readTimeline)(raw), [raw]);
    const [selected, setSelected] = (0, react_1.useState)(null), [smooth, setSmooth] = (0, react_1.useState)(false), [hover, setHover] = (0, react_1.useState)(null), [showTable, setShowTable] = (0, react_1.useState)(false);
    const turn = timeline?.turns.find(turn => turn.turn === selected) ?? timeline?.turns.at(-1);
    (0, react_1.useEffect)(() => { setHover(null); }, [turn?.turn]);
    if (timeline === null || turn === undefined)
        return (0, jsx_runtime_1.jsxs)("section", { "data-conversation-composer-overlay": "", className: "xhperf", children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("p", { role: "status", children: t(raw === undefined ? 'unavailable' : timeline === null ? 'invalid' : 'empty') })] });
    const firstSample = turn.samples[0];
    const start = firstSample !== undefined && turn.truncated ? Math.max(turn.startMs, firstSample.timeMs) : turn.startMs;
    const end = Math.max(start + 1000, turn.endMs ?? turn.lastMs, (turn.samples.at(-1)?.timeMs ?? start) + 1000);
    const x = (time) => 46 + Math.max(0, Math.min(1, (time - start) / (end - start))) * 690;
    const max = Math.max(5, ...turn.samples.map(sample => (0, chart_1.sampleTps)(sample)));
    const y = (value) => 230 - Math.min(1, value / max) * 190;
    const sample = hover === null ? undefined : turn.samples[hover];
    const request = sample === undefined ? undefined : turn.requests.find(r => r.step === sample.step && r.attempt === sample.attempt);
    const avg = (0, chart_1.reportedTps)(turn);
    const phaseClass = (kind) => kind === 'reasoning' || kind === 'arguments' ? kind + 'Band' : kind;
    return (0, jsx_runtime_1.jsxs)("section", { "data-conversation-composer-overlay": "", className: "xhperf", "data-performance-view": "", children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)("h2", { children: t('title') }), (0, jsx_runtime_1.jsx)("select", { "aria-label": t('turn'), value: turn.turn, onChange: e => { setSelected(Number(e.target.value)); setHover(null); }, children: timeline.turns.map(item => (0, jsx_runtime_1.jsxs)("option", { value: item.turn, children: [t('turn'), " ", item.turn + 1, " \u00B7 ", t(item.endMs === null ? 'live' : 'done')] }, item.turn)) }), (0, jsx_runtime_1.jsx)("button", { "aria-pressed": !smooth, onClick: () => setSmooth(false), children: t('raw') }), (0, jsx_runtime_1.jsx)("button", { "aria-pressed": smooth, onClick: () => setSmooth(true), children: t('smooth') })] }), (0, jsx_runtime_1.jsx)("p", { children: t('estimate') }), turn.truncated && (0, jsx_runtime_1.jsx)("p", { role: "status", children: t('retention') }), turn.samples.length === 0 ? (0, jsx_runtime_1.jsx)("p", { children: t('empty') }) : (0, jsx_runtime_1.jsxs)("figure", { children: [(0, jsx_runtime_1.jsxs)("svg", { viewBox: "0 0 760 300", role: "img", "aria-label": `${t('rate')} · tok/s`, tabIndex: 0, onPointerMove: e => { const rect = e.currentTarget.getBoundingClientRect(); const found = (0, chart_1.nearest)(turn, start + Math.max(0, Math.min(1, ((e.clientX - rect.left) / rect.width * 760 - 46) / 690)) * (end - start) - 500); setHover(found === undefined ? null : turn.samples.indexOf(found)); }, onPointerLeave: () => setHover(null), onKeyDown: e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                            e.preventDefault();
                            const index = hover ?? -1;
                            const next = Math.max(0, Math.min(turn.samples.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1)));
                            if (turn.samples[next] !== undefined)
                                setHover(next);
                        } }, children: [(0, jsx_runtime_1.jsx)("title", { children: t('rate') }), [0, 0.5, 1].map(f => (0, jsx_runtime_1.jsxs)("g", { children: [(0, jsx_runtime_1.jsx)("line", { className: "grid", x1: "46", x2: "736", y1: y(f * max), y2: y(f * max) }), (0, jsx_runtime_1.jsx)("text", { className: "axis", x: "38", y: y(f * max) + 4, textAnchor: "end", children: format(f * max) })] }, f)), (0, jsx_runtime_1.jsx)("text", { className: "axis", x: "46", y: "22", children: "tok/s \u2248" }), tracks.flatMap(([track, cls]) => (0, chart_1.series)(turn, track, smooth).map((segment, i) => { const first = segment[0]; return (0, jsx_runtime_1.jsxs)("g", { className: cls, fill: "none", children: [(0, jsx_runtime_1.jsx)("polyline", { "data-tps-track": cls, points: segment.map(s => `${x(s.timeMs + 500)},${y((0, chart_1.sampleTps)(s, track))}`).join(' '), strokeWidth: "2", strokeLinejoin: "round" }), segment.length === 1 && first !== undefined && (0, jsx_runtime_1.jsx)("circle", { cx: x(first.timeMs + 500), cy: y((0, chart_1.sampleTps)(first, track)), r: "2", fill: "currentColor" })] }, `${track}-${i}`); })), turn.phases.filter(phase => (phase.endMs ?? turn.lastMs) >= start).map((phase, i) => (0, jsx_runtime_1.jsx)("rect", { className: phaseClass(phase.kind), x: x(phase.startMs), y: "250", width: Math.max(1, x(phase.endMs ?? turn.lastMs) - x(phase.startMs)), height: "10", rx: "2", children: (0, jsx_runtime_1.jsxs)("title", { children: [t(phase.kind), " \u00B7 ", format(Math.max(0, phase.startMs - turn.startMs) / 1000), t('seconds')] }) }, i)), [0, 0.5, 1].map(f => (0, jsx_runtime_1.jsxs)("text", { className: "axis", x: 46 + f * 690, y: "285", textAnchor: f === 0 ? 'start' : f === 1 ? 'end' : 'middle', children: [format((start - turn.startMs + f * (end - start)) / 1000), t('seconds')] }, f)), sample !== undefined && (0, jsx_runtime_1.jsx)("line", { x1: x(sample.timeMs + 500), x2: x(sample.timeMs + 500), y1: "35", y2: "260", stroke: "currentColor", strokeDasharray: "3 4", opacity: ".4" })] }), (0, jsx_runtime_1.jsxs)("figcaption", { className: "legend", children: [tracks.map(([, cls]) => (0, jsx_runtime_1.jsxs)("span", { className: cls, children: [(0, jsx_runtime_1.jsx)("i", {}), t(cls)] }, cls)), (0, jsx_runtime_1.jsx)("span", { children: [...new Set(turn.phases.map(phase => phase.kind))].map(kind => t(kind)).join(' · ') })] })] }), (0, jsx_runtime_1.jsx)("p", { children: t('hint') }), (0, jsx_runtime_1.jsxs)("dl", { children: [(0, jsx_runtime_1.jsx)("dt", { children: t('reported') }), (0, jsx_runtime_1.jsx)("dd", { children: avg === null ? t('missing') : `${format(avg)} tok/s` })] }), sample !== undefined && (0, jsx_runtime_1.jsxs)("dl", { "aria-label": t('details'), children: [(0, jsx_runtime_1.jsx)("dt", { children: t('time') }), (0, jsx_runtime_1.jsxs)("dd", { children: [format(Math.max(0, sample.timeMs - turn.startMs) / 1000), "\u2013", format(Math.max(0, sample.timeMs + 1000 - turn.startMs) / 1000), t('seconds')] }), (0, jsx_runtime_1.jsx)("dt", { children: t('rate') }), (0, jsx_runtime_1.jsxs)("dd", { children: ["\u2248 ", format((0, chart_1.sampleTps)(sample)), " tok/s"] }), (0, jsx_runtime_1.jsxs)("dt", { children: [t('step'), " / ", t('attempt')] }), (0, jsx_runtime_1.jsxs)("dd", { children: [sample.step, " / ", sample.attempt + 1] }), (0, jsx_runtime_1.jsx)("dt", { children: t('model') }), (0, jsx_runtime_1.jsx)("dd", { children: request?.model ?? t('missing') }), (0, jsx_runtime_1.jsx)("dt", { children: t('source') }), (0, jsx_runtime_1.jsx)("dd", { children: t('estimate') })] }), (0, jsx_runtime_1.jsxs)("details", { onToggle: event => setShowTable(event.currentTarget.open), children: [(0, jsx_runtime_1.jsx)("summary", { children: t('table') }), showTable && (0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsxs)("table", { children: [(0, jsx_runtime_1.jsx)("thead", { children: (0, jsx_runtime_1.jsx)("tr", { children: ['time', 'step', 'attempt', 'text', 'reasoning', 'arguments'].map(key => (0, jsx_runtime_1.jsx)("th", { children: t(key) }, key)) }) }), (0, jsx_runtime_1.jsx)("tbody", { children: turn.samples.map((s, i) => (0, jsx_runtime_1.jsxs)("tr", { children: [(0, jsx_runtime_1.jsxs)("td", { children: [format(Math.max(0, s.timeMs - turn.startMs) / 1000), t('seconds')] }), (0, jsx_runtime_1.jsx)("td", { children: s.step }), (0, jsx_runtime_1.jsx)("td", { children: s.attempt + 1 }), tracks.map(([track]) => (0, jsx_runtime_1.jsxs)("td", { children: ["\u2248 ", format((0, chart_1.sampleTps)(s, track))] }, track))] }, i)) })] }) })] })] });
}

},
"src/modules/performance/contract.js": function(module, exports, require) {
// source: src/modules/performance/contract.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHASES = void 0;
exports.readTimeline = readTimeline;
/** v1 is verified against the Rust-generated shared wire fixture in both suites. */
exports.PHASES = ['preparing', 'waiting_first_token', 'reasoning', 'output', 'arguments', 'tool', 'approval', 'question', 'retry', 'compaction', 'between_steps', 'unknown'];
const record = (v) => typeof v === 'object' && v !== null && !array(v);
const array = (v) => Array.isArray(v);
const integer = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullable = (v) => v === null || integer(v);
const ordered = (start, end) => integer(start) && nullable(end) && (end === null || end >= start);
/** Invalid optional telemetry disables only this panel, never Session history. */
function isTimeline(value) {
    if (!record(value) || value.schemaVersion !== 1 || value.source !== 'journal_checkpoint_estimate'
        || value.bucketMs !== 1000 || value.maxSamples !== 600 || !array(value.turns) || value.turns.length > 4)
        return false;
    let samples = 0, phases = 0, requests = 0, previousTurn = -1;
    for (const turn of value.turns) {
        if (!record(turn) || !integer(turn.turn) || turn.turn <= previousTurn || !integer(turn.startMs) || !ordered(turn.startMs, turn.endMs)
            || !integer(turn.lastMs) || turn.lastMs < turn.startMs || (turn.endMs !== null && (!integer(turn.endMs) || turn.endMs > turn.lastMs)) || typeof turn.truncated !== 'boolean'
            || !array(turn.samples) || !array(turn.phases) || !array(turn.requests))
            return false;
        previousTurn = turn.turn;
        samples += turn.samples.length;
        phases += turn.phases.length;
        requests += turn.requests.length;
        let lastTime = -1;
        for (const sample of turn.samples) {
            if (!record(sample) || !integer(sample.timeMs) || sample.timeMs % 1000 !== 0 || sample.timeMs < lastTime || sample.timeMs > turn.lastMs || sample.timeMs + 999 < turn.startMs
                || ![sample.step, sample.attempt, sample.textUnits, sample.reasoningUnits, sample.argumentUnits].every(integer))
                return false;
            lastTime = sample.timeMs;
        }
        for (const phase of turn.phases)
            if (!record(phase) || !ordered(phase.startMs, phase.endMs)
                || !nullable(phase.step) || !integer(phase.attempt) || !exports.PHASES.some(kind => kind === phase.kind))
                return false;
        for (const request of turn.requests)
            if (!record(request) || !integer(request.step) || !integer(request.attempt)
                || !ordered(request.startMs, request.endMs) || !ordered(request.startMs, request.firstDeltaMs)
                || !nullable(request.reportedOutputTokens) || !nullable(request.reportedReasoningTokens)
                || ![request.provider, request.model].every(v => v === null || (typeof v === 'string' && v.length <= 320)))
                return false;
    }
    if (samples > 600 || phases > 128 || requests > 64)
        return false;
    return true;
}
function readTimeline(value) { return isTimeline(value) ? value : null; }

},
"src/modules/performance/chart.js": function(module, exports, require) {
// source: src/modules/performance/chart.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sampleTps = sampleTps;
exports.series = series;
exports.nearest = nearest;
exports.reportedTps = reportedTps;
function sampleTps(sample, track) {
    return (track === undefined ? sample.textUnits + sample.reasoningUnits + sample.argumentUnits : sample[track]) / 4;
}
/** No interpolation across steps, retries, or missing reception seconds. */
function series(turn, track, smooth) {
    const segments = [];
    for (const sample of turn.samples) {
        let segment = segments.at(-1), last = segment?.at(-1);
        if (last === undefined || last.step !== sample.step || last.attempt !== sample.attempt || sample.timeMs - last.timeMs !== 1000) {
            segment = [];
            segments.push(segment);
        }
        if (segment !== undefined)
            segment.push(sample);
    }
    if (!smooth)
        return segments;
    return segments.map(segment => segment.map((sample, i) => ({ ...sample,
        [track]: segment.slice(Math.max(0, i - 2), i + 1).reduce((n, s) => n + s[track], 0) / Math.min(3, i + 1),
    })));
}
function nearest(turn, timeMs) {
    return turn.samples.reduce((best, s) => best === undefined || Math.abs(s.timeMs - timeMs) < Math.abs(best.timeMs - timeMs) ? s : best, undefined);
}
function reportedTps(turn) {
    let tokens = 0, milliseconds = 0;
    for (const request of turn.requests) {
        if (request.reportedOutputTokens === null || request.firstDeltaMs === null || request.endMs === null || request.endMs <= request.firstDeltaMs)
            continue;
        tokens += request.reportedOutputTokens + (request.reportedReasoningTokens ?? 0);
        milliseconds += request.endMs - request.firstDeltaMs;
    }
    return milliseconds === 0 ? null : tokens / (milliseconds / 1000);
}

},
"src/modules/performance/locales.js": function(module, exports, require) {
// source: src/modules/performance/locales.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zh = exports.en = exports.NS = void 0;
exports.NS = 'xharness.performance';
exports.en = {
    title: 'Performance', turn: 'Turn', raw: '1s buckets', smooth: '3s smoothing', empty: 'No timed stream checkpoints available. An average cannot reconstruct a curve.', unavailable: 'This Host does not provide performance telemetry yet.', invalid: 'Performance telemetry is incompatible. Chat history is unaffected.',
    estimate: 'Reception estimate · journal checkpoint timing · not server decode TPS', retention: 'Only the latest sampling window is retained. Older samples were evicted.',
    rate: 'Estimated reception', reported: 'Reported tokens / reception time', missing: 'Unknown', time: 'Time', step: 'Step', attempt: 'Attempt', model: 'Model', source: 'Source',
    text: 'Text', reasoning: 'Reasoning', arguments: 'Tool input', details: 'Sample details',
    preparing: 'Preparing', waiting_first_token: 'Waiting for first token', output: 'Text output', tool: 'Tools', approval: 'Waiting for approval', question: 'Waiting for answer', retry: 'Retry', compaction: 'Compaction', between_steps: 'Between steps', unknown: 'Unknown',
    table: 'Accessible timeline data', seconds: 's', live: 'Running', done: 'Finished', hint: 'Gaps mean no sample; tools and human waits are not zero decode speed.',
};
exports.zh = {
    title: '性能', turn: '轮次', raw: '每秒采样', smooth: '3 秒平滑', empty: '没有可用的流式时间采样。不能根据平均值补出曲线。', unavailable: '当前 Host 尚未提供性能采样。', invalid: '性能采样协议不兼容；不影响聊天历史。',
    estimate: '接收侧估算 · 日志检查点计时 · 不是服务端生成 TPS', retention: '仅保留最近采样窗口；更早的采样已淘汰。',
    rate: '估算接收速度', reported: '接口 Token / 接收耗时', missing: '未知', time: '时间', step: '步骤', attempt: '尝试', model: '模型', source: '来源',
    text: '正文', reasoning: '思考', arguments: '工具参数', details: '采样详情',
    preparing: '准备', waiting_first_token: '等待首 token', output: '正文输出', tool: '工具执行', approval: '等待审批', question: '等待回答', retry: '重试', compaction: '压缩', between_steps: '步骤间隔', unknown: '未知',
    table: '时间线数据表', seconds: '秒', live: '运行中', done: '已结束', hint: '断线表示缺少采样；工具执行和等待用户不记为零生成速度。',
};

},
"src/modules/performance/styles.js": function(module, exports, require) {
// source: src/modules/performance/styles.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSS = void 0;
exports.CSS = `
.xhperf{flex:1;min-width:0;min-height:0;overflow:auto;padding:20px 24px calc(var(--dsh-composer-height,150px) + 24px);box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.xhperf header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.xhperf h2{font-size:16px;font-weight:600;margin:0 auto 0 0}.xhperf select,.xhperf button{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 10px}.xhperf button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-label-secondary)}
.xhperf :is(button,select,summary,svg):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}.xhperf p{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.xhperf figure{margin:20px 0;padding:16px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.xhperf svg{display:block;width:100%;height:auto;min-height:200px;touch-action:pan-y}.xhperf .grid{stroke:var(--dsw-alias-border-l2);stroke-width:1}.xhperf .axis{fill:var(--dsw-alias-label-secondary);font-size:11px}.xhperf .text{color:#399e83;stroke:currentColor}.xhperf .reasoning{color:#a487dc;stroke:currentColor}.xhperf .arguments{color:#ca9348;stroke:currentColor}.xhperf .waiting_first_token,.xhperf .preparing,.xhperf .between_steps{fill:var(--dsw-alias-border-l2)}.xhperf .output{fill:#399e83}.xhperf .reasoningBand{fill:#a487dc}.xhperf .argumentsBand{fill:#ca9348}.xhperf .tool{fill:#628cbf}.xhperf .approval,.xhperf .question{fill:#b99e53}.xhperf .retry{fill:#c46f6f}.xhperf .compaction{fill:#a384b7}.xhperf .unknown{fill:var(--dsw-alias-label-tertiary)}
.xhperf .legend{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px}.xhperf .legend span{display:flex;align-items:center;gap:6px}.xhperf .legend i{width:7px;height:7px;border-radius:50%;background:currentColor}.xhperf dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;font-size:12px;margin:16px 0}.xhperf dt{color:var(--dsw-alias-label-secondary)}.xhperf dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.xhperf details{margin-top:20px;font-size:12px}.xhperf details>div{max-height:240px;overflow:auto}.xhperf table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.xhperf th,.xhperf td{text-align:left;padding:7px;border-bottom:1px solid var(--dsw-alias-border-l2)}
@media(max-width:600px){.xhperf{padding:14px 10px calc(var(--dsh-composer-height,150px) + 24px)}.xhperf figure{padding:8px 0}.xhperf header select{max-width:100%}}
`;

}
};
const __dependencies = {"src/modules/performance/index.js":{"./PerformanceView":"src/modules/performance/PerformanceView.js","./locales":"src/modules/performance/locales.js","./styles":"src/modules/performance/styles.js"},"src/modules/performance/PerformanceView.js":{"./contract":"src/modules/performance/contract.js","./chart":"src/modules/performance/chart.js"},"src/modules/performance/contract.js":{},"src/modules/performance/chart.js":{},"src/modules/performance/locales.js":{},"src/modules/performance/styles.js":{}};
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
return __load("src/modules/performance/index.js");
}
});
