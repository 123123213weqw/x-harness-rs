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
const Schedule_css_1 = __importDefault(require("./Schedule.css"));
const runtime_types_1 = require("../shared/runtime-types");
const automation_data_1 = require("./automation-data");
const AutomationNavigation_1 = require("./AutomationNavigation");
const AutomationNavigation_css_1 = __importDefault(require("./AutomationNavigation.css"));
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
        if (change?.operation === 'create' && (0, automation_data_1.validRecord)(change.schedule)) {
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
    return Array.isArray(projection) ? (projection).filter(automation_data_1.validRecord) : legacyRecords;
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
const inject = ['slots', 'locale', 'conversationEvents', 'conversationViews', 'workCatalog'];
exports.inject = inject;
function apply(ctx) {
    const service = ctx.get('workCatalog');
    if (service === undefined)
        throw Error('schedule: Work catalog service unavailable');
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
    ctx.effect(() => {
        const style = document.createElement('style');
        style.id = 'xharness-automation-navigation-style';
        style.textContent = AutomationNavigation_css_1.default;
        document.head.append(style);
        return () => style.remove();
    }, 'xharness-ui-schedule: navigation styles');
    ctx.slots.inject('work.center.automations', () => ctx.slots.register({
        name: 'work.center.automations', id: 'automations', order: 20,
    }, (props) => h(AutomationNavigation_1.AutomationPage, { ...props, service })));
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

},
"src/modules/schedule/automation-data.js": function(module, exports, require) {
// source: src/modules/schedule/automation-data.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validRecord = validRecord;
exports.automationCatalog = automationCatalog;
const runtime_types_1 = require("../shared/runtime-types");
/** Same schedule record validation used by the existing conversation projection. */
function validRecord(raw) {
    const value = (0, runtime_types_1.objectValue)(raw);
    return typeof value.id === 'string' && typeof value.prompt === 'string'
        && typeof value.scheduledAt === 'string'
        && typeof value.kind === 'string' && ['after', 'at', 'every'].includes(value.kind)
        && Number.isFinite(Date.parse(value.scheduledAt));
}
/** Read only the schedules projection in listed chats; never request history bodies. */
function automationCatalog(value) {
    const items = (0, runtime_types_1.objectValue)(value).items;
    if (!Array.isArray(items))
        throw Error('Invalid session list');
    const listed = items;
    const entries = [];
    let incompleteSessions = 0;
    for (const item of listed) {
        const session = (0, runtime_types_1.objectValue)(item);
        if (typeof session.sessionId !== 'string') {
            incompleteSessions++;
            continue;
        }
        const projections = (0, runtime_types_1.objectValue)((0, runtime_types_1.objectValue)(session.projections).values);
        if (!Array.isArray(projections.schedules)) {
            incompleteSessions++;
            continue;
        }
        const records = projections.schedules;
        const title = typeof projections.title === 'string' && projections.title.trim() !== ''
            ? projections.title : session.sessionId;
        const seen = new Set();
        let incomplete = false;
        for (const raw of records) {
            if (!validRecord(raw)) {
                incomplete = true;
                continue;
            }
            if (seen.has(raw.id))
                continue;
            seen.add(raw.id);
            const record = { id: raw.id, prompt: raw.prompt, kind: raw.kind, scheduledAt: raw.scheduledAt };
            if (typeof raw.everySeconds === 'number' && Number.isFinite(raw.everySeconds) && raw.everySeconds > 0)
                record.everySeconds = raw.everySeconds;
            else if (record.kind === 'every')
                incomplete = true;
            entries.push({ sessionId: session.sessionId, sessionTitle: title, record });
        }
        if (incomplete)
            incompleteSessions++;
    }
    return { entries: entries.sort((a, b) => Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt)), incompleteSessions };
}

},
"src/modules/schedule/AutomationNavigation.js": function(module, exports, require) {
// source: src/modules/schedule/AutomationNavigation.tsx

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
exports.AutomationPage = AutomationPage;
const jsx_runtime_1 = require("react/jsx-runtime");
const React = __importStar(require("react"));
const runtime_types_1 = require("../shared/runtime-types");
const automation_data_1 = require("./automation-data");
function AutomationPage({ openSession, service }) {
    const snapshot = React.useSyncExternalStore(service.subscribe, service.getSnapshot);
    const catalog = React.useMemo(() => (0, automation_data_1.automationCatalog)({ items: snapshot.sessions }), [snapshot.sessions]);
    const zh = document.documentElement.lang.startsWith('zh');
    const title = zh ? '自动化' : 'Automations';
    const [refresh, setRefresh] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
        const controller = new AbortController();
        let current = true;
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        setLoading(true);
        setError(null);
        void service.refresh(controller.signal)
            .catch((failure) => {
            if (!current)
                return;
            // Owner errors are live runtime state: a reconnect can clear them without a manual click.
            setError(controller.signal.aborted ? (zh ? '读取超时，请重试。' : 'Request timed out. Retry.')
                : service.getSnapshot().error === null ? (0, runtime_types_1.errorText)(failure) : null);
        })
            .finally(() => { window.clearTimeout(timeout); if (current)
            setLoading(false); });
        return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
    }, [refresh, zh, service]);
    React.useEffect(() => {
        // A timed-out page wait does not cancel the owner. Its eventual successful
        // baseline must clear the reader warning rather than leave a stale alert.
        if (!snapshot.loading && snapshot.phase === 'ready' && snapshot.error === null)
            setError(null);
    }, [snapshot.loading, snapshot.phase, snapshot.error]);
    const failure = error ?? snapshot.error;
    const pending = loading || snapshot.phase === 'pending' && failure === null;
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhauto-page", "aria-label": title, children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhauto-head", children: [(0, jsx_runtime_1.jsx)("h2", { children: title }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: loading, onClick: () => setRefresh(value => value + 1), "aria-label": zh ? '刷新自动化' : 'Refresh automations', children: "\u21BB" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-body", "aria-busy": pending, children: [pending && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '读取中…' : 'Loading…' }), failure && (0, jsx_runtime_1.jsxs)("div", { role: "alert", children: [(0, jsx_runtime_1.jsx)("p", { children: failure }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setRefresh(value => value + 1), children: zh ? '重试' : 'Retry' })] }), !pending && !failure && catalog.entries.length === 0 && (0, jsx_runtime_1.jsx)("p", { children: catalog.incompleteSessions ? (zh ? '暂无已加载的自动化任务' : 'No loaded automations') : (zh ? '暂无自动化任务' : 'No automations yet') }), !pending && !failure && catalog.incompleteSessions > 0 && (0, jsx_runtime_1.jsx)("p", { className: "xhauto-muted", children: zh ? '部分会话的提醒尚未加载；打开原会话后刷新。' : 'Some chats have not loaded reminders yet. Open those chats, then refresh.' }), catalog.entries.map(({ sessionId, sessionTitle, record }) => (0, jsx_runtime_1.jsxs)("article", { className: "xhauto-row", children: [(0, jsx_runtime_1.jsx)("p", { children: record.prompt }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-muted", children: [new Date(record.scheduledAt).toLocaleString(document.documentElement.lang), record.kind === 'every' ? (record.everySeconds ? ` · ${zh ? '每' : 'Every '}${record.everySeconds}${zh ? '秒' : 's'}` : (zh ? ' · 重复周期未知' : ' · Repeat interval unavailable')) : ''] }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => openSession(sessionId), children: sessionTitle })] }, JSON.stringify([sessionId, record.id])))] })] });
}

},
"src/modules/schedule/AutomationNavigation.css": function(module, exports, require) {
// source: src/modules/schedule/AutomationNavigation.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhauto-page{display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary)}\n.xhauto-head{display:flex;align-items:center;gap:8px;flex:none;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}\n.xhauto-head h2{flex:1;margin:0;font:inherit;font-size:16px;font-weight:600}\n.xhauto-head button{width:30px;height:30px;padding:0;font-size:20px}\n.xhauto-page button{border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}\n.xhauto-page button:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.xhauto-page button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}\n.xhauto-body{flex:1;min-height:0;overflow:visible;padding:16px 0;font-size:13px;line-height:1.6}\n.xhauto-body p{margin:0 0 12px;overflow-wrap:anywhere}.xhauto-muted{font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.xhauto-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhauto-row button{display:block;margin-top:8px;padding:6px 8px;text-align:left;max-width:100%;overflow-wrap:anywhere}\n";

}
};
const __dependencies = {"src/modules/schedule/index.js":{"./Schedule.css":"src/modules/schedule/Schedule.css","../shared/runtime-types":"src/modules/shared/runtime-types.js","./automation-data":"src/modules/schedule/automation-data.js","./AutomationNavigation":"src/modules/schedule/AutomationNavigation.js","./AutomationNavigation.css":"src/modules/schedule/AutomationNavigation.css"},"src/modules/schedule/Schedule.css":{},"src/modules/shared/runtime-types.js":{},"src/modules/schedule/automation-data.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/schedule/AutomationNavigation.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./automation-data":"src/modules/schedule/automation-data.js"},"src/modules/schedule/AutomationNavigation.css":{}};
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
