// Generated from src/modules/schedule/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-schedule",
factory: (__externalRequire) => {
const __units = {
"src/modules/schedule/index.js": function(module, exports, require) {
// source: src/modules/schedule/index.tsx

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
exports.inject = void 0;
exports.apply = apply;
exports.foldScheduleChanges = foldScheduleChanges;
exports.formatScheduleFrequency = formatScheduleFrequency;
exports.formatScheduleRelative = formatScheduleRelative;
exports.orderScheduleRecords = orderScheduleRecords;
exports.scheduleRecords = scheduleRecords;
/// <reference path="../shared/assets.d.ts" />
const Schedule_css_1 = __importDefault(require("./Schedule.css"));
const runtime_types_1 = require("../shared/runtime-types");
const React = __importStar(require("react"));
const ReactDOM = __importStar(require("react-dom"));
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const { createElement: h, useEffect, useMemo, useRef, useState } = React;
const NS = 'schedule.catalog';
const TARGET = 'xharness-schedule';
const STYLE_ID = 'xharness-schedule-catalog-style';
const EMPTY_RECORDS = Object.freeze([]);
const SECOND_MS = 1000;
const UNIT_SECONDS = Object.freeze([
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 },
]);
const zh = {
    'trigger.one': '{count} 个提醒',
    'trigger.other': '{count} 个提醒',
    'list.aria': '活动提醒',
    'status.scheduled': '等待中',
    'status.overdue': '已逾期',
    'frequency.once': '单次',
    'frequency.every': '{value}{unit}一次',
    'unit.day.one': '天',
    'unit.day.other': '天',
    'unit.hour.one': '小时',
    'unit.hour.other': '小时',
    'unit.minute.one': '分钟',
    'unit.minute.other': '分钟',
    'unit.second.one': '秒',
    'unit.second.other': '秒',
    'relative.now': '现在到期',
    'relative.future': '{value}{unit}后',
    'relative.overdue': '已逾期 {value}{unit}',
};
const en = {
    'trigger.one': '{count} reminder',
    'trigger.other': '{count} reminders',
    'list.aria': 'Active reminders',
    'status.scheduled': 'Scheduled',
    'status.overdue': 'Overdue',
    'frequency.once': 'Once',
    'frequency.every': 'Every {value} {unit}',
    'unit.day.one': 'day',
    'unit.day.other': 'days',
    'unit.hour.one': 'hour',
    'unit.hour.other': 'hours',
    'unit.minute.one': 'minute',
    'unit.minute.other': 'minutes',
    'unit.second.one': 'second',
    'unit.second.other': 'seconds',
    'relative.now': 'Due now',
    'relative.future': 'in {value} {unit}',
    'relative.overdue': '{value} {unit} overdue',
};
function validRecord(raw) {
    const value = (0, runtime_types_1.objectValue)(raw);
    return value !== null
        && typeof value === 'object'
        && typeof value.id === 'string'
        && typeof value.prompt === 'string'
        && typeof value.scheduledAt === 'string'
        && typeof value.kind === 'string' && ['after', 'at', 'every'].includes(value.kind)
        && Number.isFinite(Date.parse(value.scheduledAt));
}
function nextEveryTarget(record, acceptedAt) {
    const target = Date.parse(record.scheduledAt);
    const accepted = Date.parse(acceptedAt);
    const interval = (record.everySeconds ?? 0) * SECOND_MS;
    if (!Number.isFinite(target)
        || !Number.isFinite(accepted)
        || !Number.isSafeInteger(interval)
        || interval <= 0
        || accepted < target)
        return undefined;
    const steps = Math.floor((accepted - target) / interval);
    const next = target + ((steps + 1) * interval);
    return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
}
/** Browser-local equivalent of the upstream read-only Schedule projection. */
function foldScheduleChanges(changes) {
    const active = new Map();
    for (const rawChange of changes) {
        const change = (0, runtime_types_1.objectValue)(rawChange);
        if (change?.operation === 'create' && validRecord(change.schedule)) {
            if (!active.has(change.schedule.id))
                active.set(change.schedule.id, { ...change.schedule });
            continue;
        }
        if ((change?.operation !== 'delete' && change?.operation !== 'dispatch')
            || typeof change.id !== 'string')
            continue;
        const current = active.get(change.id);
        if (current === undefined)
            continue;
        if (change.operation === 'dispatch'
            && current.kind === 'every'
            && Number.isInteger(current.everySeconds)
            && typeof change.acceptedAt === 'string') {
            const scheduledAt = nextEveryTarget(current, change.acceptedAt);
            if (scheduledAt !== undefined)
                active.set(change.id, { ...current, scheduledAt });
            else
                active.delete(change.id);
        }
        else {
            active.delete(change.id);
        }
    }
    return [...active.values()];
}
function scheduleNode(context, state) {
    return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: TARGET,
        anchorSeq: state.seq,
        data: state,
    };
}
const scheduleEventDefinition = {
    kind: 'xharness-schedule-change',
    target: TARGET,
    match: event => event.type === 'schedule/change'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({
        seq: match.event.seq,
        time: match.event.time,
        change: match.event.data,
    }),
    update: context => context.state,
    buildViewNode: context => context.state === undefined
        ? null
        : scheduleNode(context, context.state),
};
class ScheduleSnapshotBuilder {
    constructor() {
        this.empty = EMPTY_RECORDS;
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
        const changes = [...this.nodes.values()]
            .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
            .map(node => node.data.change);
        const records = foldScheduleChanges(changes);
        return records.length === 0 ? EMPTY_RECORDS : records;
    }
}
const scheduleViewDefinition = {
    target: TARGET,
    create: () => new ScheduleSnapshotBuilder(),
};
function unitLabel(unit, value, t) {
    return t(`unit.${unit}.${value === 1 ? 'one' : 'other'}`, { count: value });
}
function formatScheduleFrequency(record, t) {
    if (record.kind !== 'every')
        return t('frequency.once');
    const selected = UNIT_SECONDS.find(candidate => (record.everySeconds ?? 0) % candidate.seconds === 0)
        ?? { unit: 'second', seconds: 1 };
    const value = (record.everySeconds ?? 0) / selected.seconds;
    return t('frequency.every', { value, unit: unitLabel(selected.unit, value, t) });
}
function formatScheduleLocalTime(scheduledAt, locale) {
    return new Intl.DateTimeFormat(locale || undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(Date.parse(scheduledAt));
}
function formatScheduleRelative(scheduledAt, now, t) {
    const difference = Date.parse(scheduledAt) - now;
    if (difference === 0)
        return t('relative.now');
    const absoluteSeconds = Math.abs(difference) / SECOND_MS;
    const selected = UNIT_SECONDS.find(candidate => absoluteSeconds >= candidate.seconds)
        ?? { unit: 'second', seconds: 1 };
    const value = Math.max(1, difference > 0
        ? Math.ceil(absoluteSeconds / selected.seconds)
        : Math.floor(absoluteSeconds / selected.seconds));
    const unit = unitLabel(selected.unit, value, t);
    return t(difference > 0 ? 'relative.future' : 'relative.overdue', { value, unit });
}
function orderScheduleRecords(records, now) {
    return records.map((record, index) => ({ record, index })).sort((left, right) => {
        const leftTime = Date.parse(left.record.scheduledAt);
        const rightTime = Date.parse(right.record.scheduledAt);
        const leftOverdue = leftTime <= now;
        const rightOverdue = rightTime <= now;
        if (leftOverdue !== rightOverdue)
            return Number(rightOverdue) - Number(leftOverdue);
        return leftTime - rightTime || left.index - right.index;
    }).map(({ record }) => record);
}
// The host's whole-log projection is authoritative. Event-window folding
// remains only as a compatibility fallback for an older backend.
function scheduleRecords(projection, legacyRecords) {
    return Array.isArray(projection) ? (projection).filter(validRecord) : legacyRecords;
}
function ClockIcon() {
    return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
    }, [
        h('circle', { key: 'face', cx: 8, cy: 8.5, r: 5.25, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', { key: 'hands', d: 'M8 5.5v3.2l2.2 1.25M5.6 1.75h4.8M8 1.75v1.5', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ]);
}
function ScheduleCatalogAction({ useSession, useProjection, t }) {
    const openState = useSession(snapshot => snapshot.openState);
    const projectedRecords = useProjection('schedules');
    const legacyRecords = useSession(snapshot => snapshot.views.get(TARGET) ?? EMPTY_RECORDS);
    const records = scheduleRecords(projectedRecords, legacyRecords);
    const visible = openState === 'open' && records.length > 0;
    const [open, setOpen] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const catalogRef = useRef(null);
    const catalogPosition = (0, dsh_client_ui_primitives_1.useAnchoredPosition)({
        open,
        anchorRef: triggerRef,
        panelRef: catalogRef,
        // The actual primitive always anchors below; main passed an ignored side.
        gap: 5,
        margin: 16,
    });
    useEffect(() => {
        if (!open)
            return undefined;
        const onPointerDown = (event) => {
            if (!(event.target instanceof Node))
                return;
            if (rootRef.current?.contains(event.target) || catalogRef.current?.contains(event.target))
                return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => { document.removeEventListener('pointerdown', onPointerDown, true); };
    }, [open]);
    useEffect(() => {
        if (!open)
            return undefined;
        setNow(Date.now());
        const timer = setInterval(() => { setNow(Date.now()); }, SECOND_MS);
        return () => { clearInterval(timer); };
    }, [open]);
    useEffect(() => {
        if (visible || !open)
            return;
        setOpen(false);
    }, [visible, open]);
    const rows = useMemo(() => orderScheduleRecords(records, now), [records, now]);
    if (!visible)
        return null;
    const countLabel = t(records.length === 1 ? 'trigger.one' : 'trigger.other', { count: records.length });
    const onKeyDown = (event) => {
        if (event.key !== 'Escape' || !open)
            return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
    };
    const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'xhsch-trigger',
        'aria-expanded': open,
        'aria-label': countLabel,
        onClick: () => {
            setNow(Date.now());
            setOpen(current => !current);
        },
    }, [
        h(ClockIcon, { key: 'clock' }),
        h('span', { className: 'xhsch-count', key: 'count' }, countLabel),
        h(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: open ? 'xhsch-trigger-open' : undefined, key: 'chevron' }),
    ]);
    const menu = open
        ? ReactDOM.createPortal(h('ul', {
            ref: catalogRef,
            className: 'xhsch-menu',
            style: catalogPosition ?? { visibility: 'hidden', left: 0, top: 0 },
            'aria-label': t('list.aria'),
        }, rows.map(record => {
            const overdue = Date.parse(record.scheduledAt) <= now;
            return h('li', {
                className: overdue ? 'xhsch-row xhsch-row-overdue' : 'xhsch-row',
                key: record.id,
            }, [
                h('span', { className: 'xhsch-status', key: 'status' }, [
                    h('span', { className: 'xhsch-status-dot', 'aria-hidden': true, key: 'dot' }),
                    h('span', { key: 'label' }, t(overdue ? 'status.overdue' : 'status.scheduled')),
                ]),
                h('span', { className: 'xhsch-prompt', key: 'prompt' }, record.prompt),
                h('span', { className: 'xhsch-metadata', key: 'metadata' }, [
                    h('span', { key: 'frequency' }, formatScheduleFrequency(record, t)),
                    h('span', { 'aria-hidden': true, key: 'separator-1' }, '·'),
                    h('span', { key: 'time' }, formatScheduleLocalTime(record.scheduledAt, document.documentElement.lang)),
                    h('span', { 'aria-hidden': true, key: 'separator-2' }, '·'),
                    h('span', { className: overdue ? 'xhsch-relative-overdue' : undefined, key: 'relative' }, formatScheduleRelative(record.scheduledAt, now, t)),
                ]),
            ]);
        })), document.body)
        : null;
    return h('div', { ref: rootRef, className: 'xhsch-root', onKeyDown }, [trigger, menu]);
}
const inject = ['slots', 'locale', 'conversationEvents', 'conversationViews'];
exports.inject = inject;
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-ui-schedule: dictionaries');
    ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID);
        if (existing !== null)
            return () => { };
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = Schedule_css_1.default;
        document.head.append(style);
        return () => { style.remove(); };
    }, 'xharness-ui-schedule: styles');
    ctx.conversationEvents.register(scheduleEventDefinition);
    ctx.conversationViews.register(scheduleViewDefinition);
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'schedule-catalog',
        order: 10,
        locale: NS,
    }, ScheduleCatalogAction));
}

},
"src/modules/schedule/Schedule.css": function(module, exports, require) {
// source: src/modules/schedule/Schedule.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "\n.xhsch-root{position:relative}.xhsch-trigger{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 2px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}.xhsch-trigger:hover,.xhsch-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}.xhsch-trigger svg{flex:none}.xhsch-trigger>svg:last-child{transition:transform var(--xh-duration-fast,120ms) var(--xh-ease-standard,ease)}.xhsch-trigger-open{transform:rotate(180deg)}.xhsch-count{margin-left:2px}\n.xhsch-menu{position:fixed;z-index:100;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:336px;max-width:min(336px,calc(100vw - 32px));max-height:min(420px,calc(100vh - 140px));margin:0;padding:4px;overflow:auto;list-style:none;border:0;border-radius:20px;background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3))}\n.xhsch-row{display:flex;flex-direction:column;flex-shrink:0;gap:3px;box-sizing:border-box;width:100%;min-height:54px;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-label-primary)}.xhsch-row-overdue{background:var(--dsw-alias-state-warn-tertiary,rgba(235,151,46,.12))}.xhsch-status{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.xhsch-status-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2f7cf6)}.xhsch-row-overdue .xhsch-status{color:var(--dsw-alias-state-warn-label,#b66b00)}.xhsch-row-overdue .xhsch-status-dot{background:var(--dsw-alias-state-warn-primary,#dc8500)}.xhsch-prompt{font-size:13px;line-height:18px;overflow-wrap:anywhere;white-space:normal}.xhsch-metadata{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.xhsch-relative-overdue{color:var(--dsw-alias-state-warn-label,#b66b00)}\n";

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
const __dependencies = {"src/modules/schedule/index.js":{"./Schedule.css":"src/modules/schedule/Schedule.css","../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/schedule/Schedule.css":{},"src/modules/shared/runtime-types.js":{}};
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
return __load("src/modules/schedule/index.js");
}
});
