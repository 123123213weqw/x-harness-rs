// Generated from src/modules/jobs/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-jobs",
factory: (__externalRequire) => {
const __units = {
"src/modules/jobs/index.js": function(module, exports, require) {
// source: src/modules/jobs/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const JobListAction_1 = require("./JobListAction");
const locales_1 = require("./locales");
/** Required services for locale registration and header-slot contribution. */
exports.inject = ['sessions', 'slots', 'locale'];
/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-job: dictionaries');
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'job-list',
        // After the subagent catalog: session lineage reads before process work.
        order: 20,
        locale: locales_1.NS,
    }, JobListAction_1.JobListAction));
}

},
"src/modules/jobs/JobListAction.js": function(module, exports, require) {
// source: src/modules/jobs/JobListAction.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobListAction = JobListAction;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const JobListAction_styles_1 = __importDefault(require("./JobListAction.styles"));
/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_TASKS = [];
/** A job the registry still holds open, and whose duration therefore ticks. */
function isLive(job) {
    return job.status === 'running' || job.status === 'stopping';
}
/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value) {
    throw new Error(`unhandled job status: ${JSON.stringify(value)}`);
}
/**
 * Status marker semantics. `stopping` and `killed` share the attention color:
 * both mean the work ended (or is ending) on request rather than on its own.
 */
function dotState(status) {
    switch (status) {
        case 'running': return 'ongoing';
        case 'stopping': return 'warning';
        case 'completed': return 'done';
        case 'killed': return 'warning';
        case 'failed': return 'error';
        /* v8 ignore next -- closed wire status union */
        default: return assertNever(status);
    }
}
/** Human status word for the row and its accessible name. */
function statusLabel(status, t) {
    switch (status) {
        case 'running': return t('status.running');
        case 'stopping': return t('status.stopping');
        case 'completed': return t('status.completed');
        case 'killed': return t('status.killed');
        case 'failed': return t('status.failed');
        /* v8 ignore next -- closed wire status union */
        default: return assertNever(status);
    }
}
/**
 * Elapsed time in at most two adjacent units. A background job that outlives
 * an hour is already exceptional, so hours is the widest unit — beyond that the
 * figure stays in hours rather than growing a day/month vocabulary no producer
 * currently reaches.
 */
function formatDuration(elapsedMs, t) {
    const total = Math.max(0, Math.floor(elapsedMs / 1000));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    if (hours > 0)
        return t('duration.hours', { hours, minutes });
    if (minutes > 0)
        return t('duration.minutes', { minutes, seconds });
    return t('duration.seconds', { seconds });
}
/**
 * Live rows first in start order, then settled rows newest-first. Two jobs
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the host's map iteration.
 */
function ordered(jobs) {
    return [...jobs].sort((left, right) => {
        const liveLeft = isLive(left);
        if (liveLeft !== isLive(right))
            return liveLeft ? -1 : 1;
        if (liveLeft)
            return left.startedAt - right.startedAt;
        const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
        return finished !== 0 ? finished : left.startedAt - right.startedAt;
    });
}
/**
 * Session-header entry point for this session's background jobs. It renders
 * nothing at all until the session has at least one job, so an ordinary
 * conversation never grows a control for a capability it is not using.
 * @param props - runtime slot currency plus the namespace translator.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
function JobListAction({ sessionId, useSessions, t }) {
    const jobs = useSessions(state => state.jobsBySession[sessionId]) ?? NO_TASKS;
    const [open, setOpen] = (0, react_1.useState)(false);
    const [now, setNow] = (0, react_1.useState)(() => Date.now());
    const rootRef = (0, react_1.useRef)(null);
    const triggerRef = (0, react_1.useRef)(null);
    const rows = (0, react_1.useMemo)(() => ordered(jobs), [jobs]);
    const liveCount = (0, react_1.useMemo)(() => jobs.filter(isLive).length, [jobs]);
    (0, dsh_client_ui_primitives_1.useDismissOnOutsidePointer)(rootRef, open, setOpen);
    // The clock only runs while an open list is showing something that moves.
    (0, react_1.useEffect)(() => {
        if (!open || liveCount === 0)
            return;
        setNow(Date.now());
        const timer = setInterval(() => { setNow(Date.now()); }, 1000);
        return () => { clearInterval(timer); };
    }, [open, liveCount]);
    // The last job disappearing removes this control; close first so focus does
    // not vanish from an unmounting node.
    (0, react_1.useEffect)(() => {
        if (jobs.length === 0 && open)
            setOpen(false);
    }, [jobs.length, open]);
    if (jobs.length === 0)
        return null;
    const countKey = liveCount > 0
        ? (liveCount === 1 ? 'count.live.one' : 'count.live.other')
        : (jobs.length === 1 ? 'count.idle.one' : 'count.idle.other');
    const countLabel = t(countKey, { count: liveCount > 0 ? liveCount : jobs.length });
    const onKeyDown = (event) => {
        if (event.key !== 'Escape' || !open)
            return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
    };
    return ((0, jsx_runtime_1.jsxs)("div", { ref: rootRef, className: JobListAction_styles_1.default.root, onKeyDown: onKeyDown, children: [(0, jsx_runtime_1.jsxs)("button", { ref: triggerRef, type: "button", className: JobListAction_styles_1.default.trigger, "aria-expanded": open, "aria-label": countLabel, onClick: () => {
                    // Sample the clock in the same commit that opens the list: the
                    // mount-time value predates every job, so the first painted frame
                    // would otherwise clamp a long-running row to zero until the
                    // open effect corrects it a frame later.
                    setNow(Date.now());
                    setOpen(current => !current);
                }, children: [liveCount > 0 ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "ongoing", className: JobListAction_styles_1.default.triggerDot }) : null, (0, jsx_runtime_1.jsx)("span", { className: JobListAction_styles_1.default.count, children: countLabel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: open ? JobListAction_styles_1.default.triggerOpen : undefined })] }), open
                ? ((0, jsx_runtime_1.jsx)("ul", { className: JobListAction_styles_1.default.menu, "aria-label": t('list.aria'), children: rows.map((job) => {
                        const live = isLive(job);
                        const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt;
                        const duration = formatDuration(elapsed, t);
                        const status = statusLabel(job.status, t);
                        return ((0, jsx_runtime_1.jsxs)("li", { className: live ? JobListAction_styles_1.default.row : `${JobListAction_styles_1.default.row} ${JobListAction_styles_1.default.rowSettled}`, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: dotState(job.status), className: JobListAction_styles_1.default.rowDot }), (0, jsx_runtime_1.jsx)("span", { className: JobListAction_styles_1.default.kind, children: job.kind }), (0, jsx_runtime_1.jsx)("span", { className: JobListAction_styles_1.default.label, title: job.label, children: job.label }), (0, jsx_runtime_1.jsx)("span", { className: JobListAction_styles_1.default.status, title: job.detail ?? status, children: job.detail ?? status }), (0, jsx_runtime_1.jsx)("span", { className: JobListAction_styles_1.default.duration, title: t(live ? 'duration.title.live' : 'duration.title.done', { duration }), children: duration })] }, job.id));
                    }) }))
                : null] }));
}

},
"src/modules/jobs/JobListAction.styles.js": function(module, exports, require) {
// source: src/modules/jobs/JobListAction.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const JobListAction_css_1 = __importDefault(require("./JobListAction.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-jobs/JobListAction.module.css", "@xharness/dsh-client-ui-jobs", JobListAction_css_1.default);
const styles = {
    "count": "aNEHQW_count",
    "duration": "aNEHQW_duration",
    "kind": "aNEHQW_kind",
    "label": "aNEHQW_label",
    "menu": "aNEHQW_menu",
    "root": "aNEHQW_root",
    "row": "aNEHQW_row",
    "rowDot": "aNEHQW_rowDot",
    "rowSettled": "aNEHQW_rowSettled",
    "status": "aNEHQW_status",
    "trigger": "aNEHQW_trigger",
    "triggerDot": "aNEHQW_triggerDot",
    "triggerOpen": "aNEHQW_triggerOpen"
};
exports.default = styles;

},
"src/modules/jobs/JobListAction.css": function(module, exports, require) {
// source: src/modules/jobs/JobListAction.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".aNEHQW_root{position:relative}.aNEHQW_trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:3px;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex}.aNEHQW_trigger:hover,.aNEHQW_trigger:focus-visible{color:var(--dsw-alias-label-secondary)}.aNEHQW_trigger svg{transition:transform .12s}.aNEHQW_triggerOpen{transform:rotate(180deg)}.aNEHQW_triggerDot{flex:none}.aNEHQW_count{margin:0 5px}.aNEHQW_menu{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:336px;max-width:min(400px,100vw - 32px);max-height:min(420px,100vh - 140px);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;gap:1px;margin:0;padding:4px;list-style:none;display:flex;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}.aNEHQW_row{box-sizing:border-box;width:100%;min-height:32px;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:13px;line-height:18px;display:flex}.aNEHQW_rowSettled{color:var(--dsw-alias-label-tertiary)}.aNEHQW_rowDot{flex:none}.aNEHQW_kind{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);border-radius:5px;flex:none;padding:0 6px;font-size:11px;line-height:18px}.aNEHQW_label{min-width:0;font-family:var(--dsw-font-mono);white-space:nowrap;text-overflow:ellipsis;flex:1;overflow:hidden}.aNEHQW_status,.aNEHQW_duration{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;line-height:18px}.aNEHQW_status{white-space:nowrap;text-overflow:ellipsis;max-width:40%;overflow:hidden}.aNEHQW_duration{font-variant-numeric:tabular-nums}\n";

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
"src/modules/jobs/locales.js": function(module, exports, require) {
// source: src/modules/jobs/locales.ts

"use strict";
/** `job` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'job';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'count.live.one': '{count} 个后台任务运行中',
    'count.live.other': '{count} 个后台任务运行中',
    'count.idle.one': '{count} 个后台任务',
    'count.idle.other': '{count} 个后台任务',
    'list.aria': '后台任务',
    'status.running': '运行中',
    'status.stopping': '正在停止',
    'status.completed': '已完成',
    'status.killed': '已取消',
    'status.failed': '已失败',
    'duration.seconds': '{seconds}秒',
    'duration.minutes': '{minutes}分{seconds}秒',
    'duration.hours': '{hours}小时{minutes}分',
    'duration.title.live': '已运行 {duration}',
    'duration.title.done': '耗时 {duration}',
};
/** English dictionary, key-identical to the Chinese source of truth. */
exports.en = {
    'count.live.one': '{count} background job running',
    'count.live.other': '{count} background jobs running',
    'count.idle.one': '{count} background job',
    'count.idle.other': '{count} background jobs',
    'list.aria': 'Background jobs',
    'status.running': 'running',
    'status.stopping': 'stopping',
    'status.completed': 'completed',
    'status.killed': 'cancelled',
    'status.failed': 'failed',
    'duration.seconds': '{seconds}s',
    'duration.minutes': '{minutes}m {seconds}s',
    'duration.hours': '{hours}h {minutes}m',
    'duration.title.live': 'Running for {duration}',
    'duration.title.done': 'Took {duration}',
};

}
};
const __dependencies = {"src/modules/jobs/index.js":{"./JobListAction":"src/modules/jobs/JobListAction.js","./locales":"src/modules/jobs/locales.js"},"src/modules/jobs/JobListAction.js":{"./JobListAction.styles":"src/modules/jobs/JobListAction.styles.js"},"src/modules/jobs/JobListAction.styles.js":{"./JobListAction.css":"src/modules/jobs/JobListAction.css","../views-types":"src/modules/views-types.js"},"src/modules/jobs/JobListAction.css":{},"src/modules/views-types.js":{},"src/modules/jobs/locales.js":{}};
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
return __load("src/modules/jobs/index.js");
}
});
