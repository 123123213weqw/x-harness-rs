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
const AutomationToolCard_css_1 = __importDefault(require("./AutomationToolCard.css"));
const AutomationToolCard_1 = require("./AutomationToolCard");
const automation_card_client_1 = require("./automation-card-client");
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
    "card.locale": "zh-CN",
    "card.title": "自动化",
    "card.savedTask": "已保存的任务",
    "card.task": "任务",
    "card.reminder": "提醒",
    "card.newChat": "新对话运行",
    "card.currentChat": "当前对话",
    "card.once": "单次",
    "card.every": "每 {minutes} 分钟",
    "card.record": "历史记录 · 状态待同步",
    "card.working": "执行中",
    "card.failed": "操作失败",
    "card.receipt": "操作已执行",
    "card.unknownResult": "结果待检查",
    "card.empty": "该次查询没有活动自动化",
    "card.more": "还有 {count} 项，可在自动化页面查看",
    "card.details": "详情",
    "card.inspect": "检查调用",
    "card.pause": "暂停",
    "card.resume": "恢复",
    "card.delete": "删除",
    "card.cancel": "取消",
    "card.confirmDelete": "删除后不再触发？",
    "card.saving": "保存中…",
    "card.syncFailed": "当前状态暂不可用",
    "card.unavailable": "无法获取自动化状态",
    "card.state.scheduled": "等待触发",
    "card.state.overdue": "等待调度",
    "card.state.paused": "已暂停",
    "card.state.finished": "触发已结束",
    "card.state.deleted": "已删除",
    "card.state.inherited": "继承记录 · 不触发",
    "card.state.inactive": "未启用",
    "card.run.preparing": "运行准备中",
    "card.run.queued": "运行已排队",
    "card.run.running": "任务运行中",
    "card.run.completed": "运行已完成",
    "card.run.cancelled": "运行已取消",
    "card.run.failed": "运行失败",
    "card.run.interrupted": "运行中断",
    "card.run.incomplete": "运行未完成",
    "card.run.unavailable": "运行状态未知",
    "card.action.create": "创建自动化",
    "card.action.update": "更新自动化",
    "card.action.list": "自动化列表",
    "card.action.view": "查看自动化",
    "card.action.pause": "暂停自动化",
    "card.action.resume": "恢复自动化",
    "card.action.delete": "删除自动化",
    "card.action.unknown": "自动化",
    'trigger.one': '{count} 个自动化',
    'trigger.other': '{count} 个自动化',
    'list.aria': '活动提醒',
    'status.scheduled': '等待中',
    'status.paused': '已暂停',
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
    "card.locale": "en",
    "card.title": "Automation",
    "card.savedTask": "Saved task",
    "card.task": "Task",
    "card.reminder": "Reminder",
    "card.newChat": "Run in new chat",
    "card.currentChat": "Current chat",
    "card.once": "Once",
    "card.every": "Every {minutes} minutes",
    "card.record": "Historical record · syncing status",
    "card.working": "Running",
    "card.failed": "Operation failed",
    "card.receipt": "Operation recorded",
    "card.unknownResult": "Inspect result",
    "card.empty": "No active automations in this query",
    "card.more": "{count} more — see Automations",
    "card.details": "Details",
    "card.inspect": "Inspect call",
    "card.pause": "Pause",
    "card.resume": "Resume",
    "card.delete": "Delete",
    "card.cancel": "Cancel",
    "card.confirmDelete": "Delete future triggers?",
    "card.saving": "Saving…",
    "card.syncFailed": "Current status unavailable",
    "card.unavailable": "Automation status unavailable",
    "card.state.scheduled": "Scheduled",
    "card.state.overdue": "Awaiting dispatch",
    "card.state.paused": "Paused",
    "card.state.finished": "Trigger finished",
    "card.state.deleted": "Deleted",
    "card.state.inherited": "Inherited · not armed",
    "card.state.inactive": "Inactive",
    "card.run.preparing": "Preparing run",
    "card.run.queued": "Run queued",
    "card.run.running": "Run in progress",
    "card.run.completed": "Run completed",
    "card.run.cancelled": "Run cancelled",
    "card.run.failed": "Run failed",
    "card.run.interrupted": "Run interrupted",
    "card.run.incomplete": "Run incomplete",
    "card.run.unavailable": "Run state unknown",
    "card.action.create": "Create automation",
    "card.action.update": "Update automation",
    "card.action.list": "Automation list",
    "card.action.view": "View automation",
    "card.action.pause": "Pause automation",
    "card.action.resume": "Resume automation",
    "card.action.delete": "Delete automation",
    "card.action.unknown": "Automation",
    'trigger.one': '{count} automation',
    'trigger.other': '{count} automations',
    'list.aria': 'Active reminders',
    'status.scheduled': 'Scheduled',
    'status.paused': 'Paused',
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
        if ((change?.operation === 'create' || change?.operation === 'update') && (0, automation_data_1.validRecord)(change.schedule)) {
            if (change.operation === 'update' || !active.has(change.schedule.id))
                active.set(change.schedule.id, { ...change.schedule });
            continue;
        }
        const id = change.operation === 'run' ? (0, runtime_types_1.objectValue)(change.run).scheduleId : change.id;
        if ((change?.operation !== 'delete' && change?.operation !== 'dispatch' && change?.operation !== 'run')
            || typeof id !== 'string')
            continue;
        const current = active.get(id);
        if (current === undefined)
            continue;
        if ((change.operation === 'dispatch' || change.operation === 'run')
            && current.kind === 'every'
            && Number.isInteger(current.everySeconds)
            && typeof change.acceptedAt === 'string') {
            const scheduledAt = nextEveryTarget(current, change.acceptedAt);
            if (scheduledAt !== undefined)
                active.set(id, { ...current, scheduledAt });
            else
                active.delete(id);
        }
        else {
            active.delete(id);
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
            const paused = record.automation?.paused === true;
            const overdue = !paused && Date.parse(record.scheduledAt) <= now;
            return h('li', {
                className: overdue ? 'xhsch-row xhsch-row-overdue' : 'xhsch-row',
                key: record.id,
            }, [
                h('span', { className: 'xhsch-status', key: 'status' }, [
                    h('span', { className: 'xhsch-status-dot', 'aria-hidden': true, key: 'dot' }),
                    h('span', { key: 'label' }, t(paused ? 'status.paused' : overdue ? 'status.overdue' : 'status.scheduled')),
                ]),
                h('span', { className: 'xhsch-prompt', key: 'prompt' }, record.prompt),
                h('span', { className: 'xhsch-metadata', key: 'metadata' }, [
                    h('span', { key: 'frequency' }, formatScheduleFrequency(record, t)),
                    h('span', { 'aria-hidden': true, key: 'separator-1' }, '·'),
                    h('span', { key: 'time' }, formatScheduleLocalTime(record.scheduledAt, document.documentElement.lang)),
                    h('span', { 'aria-hidden': true, key: 'separator-2' }, '·'),
                    h('span', { className: overdue ? 'xhsch-relative-overdue' : undefined, key: 'relative' }, paused ? t('status.paused') : formatScheduleRelative(record.scheduledAt, now, t)),
                ]),
            ]);
        })), document.body)
        : null;
    return h('div', { ref: rootRef, className: 'xhsch-root', onKeyDown }, [trigger, menu]);
}
const inject = ['slots', 'locale', 'conversationEvents', 'conversationViews', 'workCatalog', 'connection'];
exports.inject = inject;
function apply(ctx) {
    const connection = ctx.get('connection');
    if (!connection)
        throw Error('schedule: Connection service unavailable');
    const cardClient = new automation_card_client_1.AutomationCardClient(connection.rpc);
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
    ctx.effect(() => {
        const style = document.createElement('style');
        style.id = 'xharness-automation-tool-card-style';
        style.textContent = AutomationToolCard_css_1.default;
        document.head.append(style);
        return () => style.remove();
    }, 'xharness-ui-schedule: tool card styles');
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key: 'automation', locale: NS,
    }, (props) => h(AutomationToolCard_1.AutomationToolCard, { ...props, client: cardClient })));
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
function validSettings(raw) {
    const value = (0, runtime_types_1.objectValue)(raw);
    return (value.mode === 'reminder' || value.mode === 'task')
        && (value.target === 'current_chat' || value.target === 'new_chat') && typeof value.paused === 'boolean';
}
/** Same schedule record validation used by the existing conversation projection. */
function validRecord(raw) {
    const value = (0, runtime_types_1.objectValue)(raw);
    return typeof value.id === 'string' && typeof value.prompt === 'string'
        && typeof value.scheduledAt === 'string'
        && typeof value.kind === 'string' && ['after', 'at', 'every'].includes(value.kind)
        && Number.isFinite(Date.parse(value.scheduledAt))
        && (value.automation === undefined || validSettings(value.automation));
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
            if (raw.automation !== undefined) {
                const { mode, target, paused } = raw.automation;
                record.automation = { mode, target, paused };
            }
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
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhauto-page", "aria-label": title, children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhauto-head", children: [(0, jsx_runtime_1.jsx)("h2", { children: title }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: loading, onClick: () => setRefresh(value => value + 1), "aria-label": zh ? '刷新自动化' : 'Refresh automations', children: "\u21BB" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-body", "aria-busy": pending, children: [pending && (0, jsx_runtime_1.jsx)("p", { role: "status", children: zh ? '读取中…' : 'Loading…' }), failure && (0, jsx_runtime_1.jsxs)("div", { role: "alert", children: [(0, jsx_runtime_1.jsx)("p", { children: failure }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setRefresh(value => value + 1), children: zh ? '重试' : 'Retry' })] }), !pending && !failure && catalog.entries.length === 0 && (0, jsx_runtime_1.jsx)("p", { children: catalog.incompleteSessions ? (zh ? '暂无已加载的自动化任务' : 'No loaded automations') : (zh ? '暂无自动化任务' : 'No automations yet') }), !pending && !failure && catalog.incompleteSessions > 0 && (0, jsx_runtime_1.jsx)("p", { className: "xhauto-muted", children: zh ? '部分会话的提醒尚未加载；打开原会话后刷新。' : 'Some chats have not loaded reminders yet. Open those chats, then refresh.' }), catalog.entries.map(({ sessionId, sessionTitle, record }) => (0, jsx_runtime_1.jsxs)("article", { className: "xhauto-row", children: [(0, jsx_runtime_1.jsx)("p", { children: record.prompt }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-muted", children: [record.automation !== undefined && (0, jsx_runtime_1.jsxs)("span", { children: [record.automation.mode === 'task' ? (zh ? '执行任务' : 'Task') : (zh ? '提醒' : 'Reminder'), " \u00B7 ", record.automation.target === 'new_chat' ? (zh ? '独立聊天' : 'New chat') : (zh ? '原聊天' : 'Current chat'), " \u00B7 ", record.automation.paused ? (zh ? '已暂停' : 'Paused') : (zh ? '已启用' : 'Active'), " \u00B7 "] }), new Date(record.scheduledAt).toLocaleString(document.documentElement.lang), record.kind === 'every' ? (record.everySeconds ? ` · ${zh ? '每' : 'Every '}${record.everySeconds}${zh ? '秒' : 's'}` : (zh ? ' · 重复周期未知' : ' · Repeat interval unavailable')) : ''] }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => openSession(sessionId), children: sessionTitle })] }, JSON.stringify([sessionId, record.id])))] })] });
}

},
"src/modules/schedule/AutomationNavigation.css": function(module, exports, require) {
// source: src/modules/schedule/AutomationNavigation.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhauto-page{display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary)}\n.xhauto-head{display:flex;align-items:center;gap:8px;flex:none;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}\n.xhauto-head h2{flex:1;margin:0;font:inherit;font-size:16px;font-weight:600}\n.xhauto-head button{width:30px;height:30px;padding:0;font-size:20px}\n.xhauto-page button{border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}\n.xhauto-page button:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.xhauto-page button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}\n.xhauto-body{flex:1;min-height:0;overflow:visible;padding:16px 0;font-size:13px;line-height:1.6}\n.xhauto-body p{margin:0 0 12px;overflow-wrap:anywhere}.xhauto-muted{font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.xhauto-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhauto-row button{display:block;margin-top:8px;padding:6px 8px;text-align:left;max-width:100%;overflow-wrap:anywhere}\n";

},
"src/modules/schedule/AutomationToolCard.css": function(module, exports, require) {
// source: src/modules/schedule/AutomationToolCard.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhauto-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;margin:8px 0;padding:12px 14px;max-width:100%;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-background-primary,transparent)}\n.xhauto-card header{display:flex;align-items:center;gap:8px}.xhauto-card header>span:first-of-type{font-weight:500}.xhauto-card header>span:last-child{margin-left:auto}\n.xhauto-card-task{padding-top:10px}.xhauto-card-task+.xhauto-card-task{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}\n.xhauto-card-title{line-height:1.5;font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}\n.xhauto-card-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px;font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.xhauto-card-bottom{display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:space-between;margin-top:9px;font-size:12px}.xhauto-card-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}\n.xhauto-card button{border:1px solid var(--dsw-alias-border-l1);padding:4px 9px;border-radius:7px;cursor:pointer;background:transparent;color:inherit;font:inherit}.xhauto-card button:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhauto-card button:disabled{opacity:.5;cursor:default}.xhauto-card button:focus-visible,.xhauto-card summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}\n.xhauto-card-muted,.xhauto-card details{font-size:12px;color:var(--dsw-alias-label-tertiary)}.xhauto-card-error{margin-top:8px;color:var(--dsw-alias-state-danger-primary,#ba3939);overflow-wrap:anywhere}.xhauto-card details{margin-top:10px}.xhauto-card summary{cursor:pointer;width:fit-content}.xhauto-card pre{max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}\n";

},
"src/modules/schedule/AutomationToolCard.js": function(module, exports, require) {
// source: src/modules/schedule/AutomationToolCard.tsx

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
exports.AutomationToolCard = AutomationToolCard;
const jsx_runtime_1 = require("react/jsx-runtime");
const React = __importStar(require("react"));
const automation_card_model_1 = require("./automation-card-model");
function Clock() { return (0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { cx: "12", cy: "12", r: "9" }), (0, jsx_runtime_1.jsx)("path", { d: "M12 7v5l3 2" })] }); }
function SavedAutomation({ id, initial, sessionId, client, projection, t }) {
    const [view, setView] = React.useState(), [loadError, setLoadError] = React.useState('');
    const [pending, setPending] = React.useState(false), [actionError, setActionError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const mutationPending = React.useRef(false);
    const [revision, invalidate] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => client.subscribe(sessionId, invalidate), [client, sessionId]);
    React.useEffect(() => {
        let stopped = false, inFlight = false, timer, controller;
        async function refresh() {
            if (stopped || document.hidden || inFlight)
                return;
            inFlight = true;
            controller = new AbortController();
            const timeout = setTimeout(() => controller?.abort(), 15000);
            let delay = 15000;
            try {
                const current = await client.execute(sessionId, id, 'view', controller.signal);
                if (stopped)
                    return;
                if (!current)
                    throw Error(t('card.unavailable'));
                setView(current);
                setLoadError('');
                delay = (0, automation_card_model_1.refreshDelay)(current);
            }
            catch (error) {
                if (!stopped) {
                    setLoadError(error instanceof Error ? error.message : String(error));
                    setView(undefined);
                }
            }
            finally {
                clearTimeout(timeout);
                inFlight = false;
            }
            if (!stopped && delay !== undefined)
                timer = setTimeout(refresh, delay);
        }
        const visible = () => { if (!document.hidden) {
            clearTimeout(timer);
            void refresh();
        } };
        void refresh();
        document.addEventListener('visibilitychange', visible);
        return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
    }, [client, sessionId, id, projection, revision, t]);
    const current = view ?? initial, state = view?.state;
    const run = view && (0, automation_card_model_1.latestRunState)(view);
    const manageable = state === 'scheduled' || state === 'overdue' || state === 'paused';
    async function mutate(action) {
        if (mutationPending.current)
            return;
        mutationPending.current = true;
        setPending(true);
        setActionError('');
        try {
            await client.execute(sessionId, id, action);
            if (mounted.current)
                setConfirmDelete(false);
        }
        catch (error) {
            if (mounted.current) {
                setActionError(error instanceof Error ? error.message : String(error));
                invalidate();
            }
        }
        finally {
            mutationPending.current = false;
            if (mounted.current)
                setPending(false);
        }
    }
    return (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-task", children: [(0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-title", children: current?.prompt ?? t('card.savedTask') }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-meta", children: [(0, jsx_runtime_1.jsx)("span", { children: current?.automation?.mode === 'task' ? t('card.task') : t('card.reminder') }), (0, jsx_runtime_1.jsx)("span", { children: current?.automation?.target === 'new_chat' ? t('card.newChat') : t('card.currentChat') }), current && (0, jsx_runtime_1.jsxs)("span", { children: [current.kind === 'every' ? t('card.every', { minutes: (current.everySeconds ?? 0) / 60 }) : t('card.once'), " \u00B7 ", new Date(current.scheduledAt).toLocaleString(t('card.locale'))] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-bottom", children: [(0, jsx_runtime_1.jsxs)("span", { className: "xhauto-card-state", children: [state ? t(`card.state.${state}`) : t('card.record'), run ? ` · ${t(`card.run.${run}`)}` : ''] }), manageable && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-actions", children: confirmDelete ? (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { children: t('card.confirmDelete') }), (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void mutate('delete'), children: t('card.delete') }), (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => setConfirmDelete(false), children: t('card.cancel') })] })
                            : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => void mutate(state === 'paused' ? 'resume' : 'pause'), children: pending ? t('card.saving') : t(state === 'paused' ? 'card.resume' : 'card.pause') }), (0, jsx_runtime_1.jsx)("button", { disabled: pending, onClick: () => setConfirmDelete(true), children: t('card.delete') })] }) })] }), loadError && (0, jsx_runtime_1.jsxs)("div", { className: "xhauto-card-muted", children: [t('card.syncFailed'), " \u00B7 ", loadError] }), actionError && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-error", role: "alert", children: actionError })] });
}
function AutomationToolCard({ block, sessionId, useProjection, client, inspect, t }) {
    const model = React.useMemo(() => (0, automation_card_model_1.automationCardModel)(block), [block]);
    const projection = useProjection('schedules');
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhauto-card", "aria-label": t('card.title'), children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsx)(Clock, {}), (0, jsx_runtime_1.jsx)("span", { children: t(`card.action.${model.action}`) }), (0, jsx_runtime_1.jsx)("span", { className: "xhauto-card-muted", children: !model.settled ? t('card.working') : model.error ? t('card.failed') : model.recognized ? t('card.receipt') : t('card.unknownResult') })] }), model.error ? (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-error", role: "alert", children: model.error }) : model.ids.slice(0, 20).map(id => (0, jsx_runtime_1.jsx)(SavedAutomation, { id: id, initial: model.values.find(v => v.id === id), sessionId: sessionId, client: client, projection: projection, t: t }, `${sessionId}:${id}`)), model.action === 'list' && model.settled && model.recognized && !model.error && model.ids.length === 0 && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-muted", children: t('card.empty') }), model.ids.length > 20 && (0, jsx_runtime_1.jsx)("div", { className: "xhauto-card-muted", children: t('card.more', { count: model.ids.length - 20 }) }), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: t('card.details') }), (0, jsx_runtime_1.jsxs)("pre", { children: [model.argsRaw, model.raw ? `\n\n${model.raw}` : ''] }), inspect && (0, jsx_runtime_1.jsx)("button", { onClick: inspect, children: t('card.inspect') })] })] });
}

},
"src/modules/schedule/automation-card-model.js": function(module, exports, require) {
// source: src/modules/schedule/automation-card-model.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.automationView = automationView;
exports.domainError = domainError;
exports.automationCardModel = automationCardModel;
exports.latestRunState = latestRunState;
exports.refreshDelay = refreshDelay;
const runtime_types_1 = require("../shared/runtime-types");
const automation_data_1 = require("./automation-data");
const STATES = new Set(['scheduled', 'overdue', 'paused', 'finished', 'deleted', 'inherited', 'inactive']);
const RUN_STATES = new Set(['preparing', 'queued', 'running', 'completed', 'cancelled', 'failed', 'interrupted', 'incomplete', 'unavailable']);
function automationView(raw) {
    const value = (0, runtime_types_1.objectValue)(raw);
    if (!(0, automation_data_1.validRecord)(raw) || typeof value.state !== 'string' || !STATES.has(value.state))
        return undefined;
    const rawRuns = Array.isArray(value.runs) ? value.runs : undefined;
    const runs = rawRuns?.flatMap(raw => {
        const run = (0, runtime_types_1.objectValue)(raw);
        return typeof run.state === 'string' && RUN_STATES.has(run.state)
            ? [{ state: run.state, ...(typeof run.sessionId === 'string' ? { sessionId: run.sessionId } : {}) }] : [];
    });
    return { ...raw, state: value.state, ...(runs === undefined ? {} : { runs }) };
}
function domainError(raw) {
    const value = (0, runtime_types_1.objectValue)(raw), error = (0, runtime_types_1.objectValue)(value.error);
    if (typeof value.code === 'string' && typeof value.message === 'string')
        return value.message;
    if (value.ok === false)
        return typeof error.message === 'string' ? error.message : typeof value.error === 'string' && value.error ? value.error : 'Operation failed';
    return undefined;
}
function parse(text) {
    if (text.length > 1048576)
        return undefined;
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
/** Decode only the established text-result envelope; never render model text as HTML. */
function automationCardModel(block) {
    const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '';
    const args = (0, runtime_types_1.objectValue)(parse(argsRaw));
    const action = typeof args.action === 'string' && ['create', 'update', 'list', 'view', 'pause', 'resume', 'delete'].includes(args.action) ? args.action : 'unknown';
    let output, raw = '', error;
    const settled = 'kind' in block;
    if (settled) {
        raw = block.content.map(part => { const p = (0, runtime_types_1.objectValue)(part); return p.type === 'text' && typeof p.text === 'string' ? p.text : ''; }).join('\n');
        output = parse(raw);
        const envelope = (0, runtime_types_1.objectValue)(output);
        error = domainError(output);
        if (typeof envelope.content === 'string')
            output = parse(envelope.content);
        error ?? (error = domainError(output));
        if (block.isError)
            error ?? (error = block.error?.code ?? 'Operation failed');
    }
    const rawValues = Array.isArray(output) ? output : [output];
    const values = rawValues.flatMap(value => { const view = automationView(value); return view === undefined ? [] : [view]; });
    const outputId = (0, runtime_types_1.objectValue)(output).id;
    const ids = error !== undefined ? [] : values.length ? values.map(v => v.id) : typeof outputId === 'string' ? [outputId] : settled && typeof args.id === 'string' ? [args.id] : [];
    return { action, argsRaw, raw, error, settled, values, ids, recognized: values.length > 0 || (Array.isArray(output) && values.length === output.length) || typeof outputId === 'string' || error !== undefined };
}
/** A finished timer may still have an admitted run. Keep these two truths separate. */
function latestRunState(view) { return view.runs?.[0]?.state; }
function refreshDelay(view) {
    if (view === undefined)
        return 15000;
    if (view.runs?.some(r => ['preparing', 'queued', 'running', 'unavailable'].includes(r.state)))
        return 5000;
    if (view.state === 'scheduled' || view.state === 'overdue')
        return Math.max(5000, Math.min(3600000, Date.parse(view.scheduledAt) - Date.now() + 250));
    return undefined;
}

},
"src/modules/schedule/automation-card-client.js": function(module, exports, require) {
// source: src/modules/schedule/automation-card-client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutomationCardClient = void 0;
const automation_card_model_1 = require("./automation-card-model");
/** Transport and invalidation only: all state transitions remain on the Host. */
class AutomationCardClient {
    constructor(rpc) {
        this.rpc = rpc;
        this.listeners = new Map();
    }
    subscribe(sessionId, listener) {
        let group = this.listeners.get(sessionId);
        if (!group)
            this.listeners.set(sessionId, group = new Set());
        const subscribers = group;
        subscribers.add(listener);
        return () => { subscribers.delete(listener); if (!subscribers.size)
            this.listeners.delete(sessionId); };
    }
    async execute(sessionId, id, action, signal) {
        const controller = signal === undefined ? new AbortController() : undefined;
        const timeout = controller === undefined ? undefined : setTimeout(() => controller.abort(), 15000);
        try {
            const result = await this.rpc.call('/api', 'automation/manage', { sessionId, command: { action, id } }, signal ?? controller?.signal);
            if (!result.ok)
                throw Error(result.error.message);
            const error = (0, automation_card_model_1.domainError)(result.value);
            if (error)
                throw Error(error);
            if (action !== 'view')
                for (const listener of this.listeners.get(sessionId) ?? [])
                    listener();
            return (0, automation_card_model_1.automationView)(result.value);
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
exports.AutomationCardClient = AutomationCardClient;

}
};
const __dependencies = {"src/modules/schedule/index.js":{"./Schedule.css":"src/modules/schedule/Schedule.css","../shared/runtime-types":"src/modules/shared/runtime-types.js","./automation-data":"src/modules/schedule/automation-data.js","./AutomationNavigation":"src/modules/schedule/AutomationNavigation.js","./AutomationNavigation.css":"src/modules/schedule/AutomationNavigation.css","./AutomationToolCard.css":"src/modules/schedule/AutomationToolCard.css","./AutomationToolCard":"src/modules/schedule/AutomationToolCard.js","./automation-card-client":"src/modules/schedule/automation-card-client.js"},"src/modules/schedule/Schedule.css":{},"src/modules/shared/runtime-types.js":{},"src/modules/schedule/automation-data.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/schedule/AutomationNavigation.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./automation-data":"src/modules/schedule/automation-data.js"},"src/modules/schedule/AutomationNavigation.css":{},"src/modules/schedule/AutomationToolCard.css":{},"src/modules/schedule/AutomationToolCard.js":{"./automation-card-model":"src/modules/schedule/automation-card-model.js"},"src/modules/schedule/automation-card-model.js":{"../shared/runtime-types":"src/modules/shared/runtime-types.js","./automation-data":"src/modules/schedule/automation-data.js"},"src/modules/schedule/automation-card-client.js":{"./automation-card-model":"src/modules/schedule/automation-card-model.js"}};
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
