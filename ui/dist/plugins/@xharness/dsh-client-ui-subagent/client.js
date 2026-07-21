// Generated from src/modules/subagent/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-subagent",
factory: (__externalRequire) => {
const __units = {
"src/modules/subagent/index.js": function(module, exports, require) {
// source: src/modules/subagent/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const SubagentCatalogAction_1 = require("./SubagentCatalogAction");
const SubagentReadOnlyComposer_1 = require("./SubagentReadOnlyComposer");
const locales_1 = require("./locales");
/** Required services for conversation slots and session navigation. */
exports.inject = ['sessions', 'slots', 'locale'];
/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner) {
    const subagent = owner.session?.subagent;
    if (subagent === undefined || subagent === null)
        return null;
    if (subagent.address.mode === 'one-shot')
        return { reason: 'one-shot' };
    if (subagent.parentAvailable)
        return null;
    // A RUNNING parent-offline continuable child keeps the default composer:
    // its input is disabled there, but the same primary Stop stays available so
    // the child can be interrupted. Once it stops, this takeover returns.
    return owner.session?.running === true ? null : { reason: 'parent-unavailable' };
}
/**
 * Client plugin body: register the subagent catalog and read-only composer seats.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-subagent: dictionaries');
    const sessions = ctx.sessions;
    const catalogActions = (_parentSessionId) => ({
        openChild(address) {
            sessions.openSubagent(address);
        },
        refresh(parentSessionId) {
            void sessions.refreshSubagents(parentSessionId);
        },
        setCatalogOpen(parentSessionId, open) {
            sessions.setSubagentCatalogOpen(parentSessionId, open);
        },
    });
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'subagent-catalog',
        order: 10,
        locale: locales_1.NS,
        inject: catalogActions,
    }, SubagentCatalogAction_1.SubagentCatalogAction));
    ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -10,
        locale: locales_1.NS,
        select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer_1.SubagentReadOnlyComposer));
}

},
"src/modules/subagent/SubagentCatalogAction.js": function(module, exports, require) {
// source: src/modules/subagent/SubagentCatalogAction.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubagentCatalogAction = SubagentCatalogAction;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const client_1 = require("@xharness/dsh-client-runtime/client");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const SubagentCatalogAction_styles_1 = __importDefault(require("./SubagentCatalogAction.styles"));
function diagnosticReason(entry, t) {
    switch (entry.reason) {
        case 'corrupt': return t('diagnostic.corrupt');
        case 'unsupported': return t('diagnostic.unsupported');
        case 'unavailable': return t('diagnostic.unavailable');
    }
}
function treeItems(root) {
    return root === null
        ? []
        : Array.from(root.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])'));
}
/** Compact token count shared in shape with the conversation stats strip. */
function formatTokens(value) {
    const scaled = (next) => next >= 100
        ? String(Math.round(next))
        : String(Math.round(next * 10) / 10);
    if (value < 1000)
        return String(value);
    if (value < 1000000)
        return `${scaled(value / 1000)}K`;
    return `${scaled(value / 1000000)}M`;
}
/** Sum the four disjoint durable provider-usage buckets. */
function tokenTotal(usage) {
    return usage === undefined
        ? undefined
        : usage.uncachedInputTokens + usage.outputTokens
            + usage.cacheReadTokens + usage.cacheWriteTokens;
}
/** Exact whole-second active-turn duration for one catalog row. */
function activityDuration(summary, activity, now) {
    if (summary === undefined)
        return undefined;
    const timing = summary.projectionValues?.subagentTiming;
    if (timing === undefined)
        return undefined;
    if (timing.active === undefined)
        return timing.settledMs;
    const end = activity === 'running'
        ? now
        : timing.active.through;
    return timing.settledMs + Math.max(0, end - timing.active.since);
}
function splitDuration(ms) {
    const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    return {
        seconds: totalSeconds % 60,
        minutes: totalMinutes % 60,
        hours: totalHours % 24,
        days: Math.floor(totalHours / 24),
        totalMinutes,
        totalHours,
    };
}
/** Format a duration with decreasing visual precision at larger scales. */
function formatDuration(ms, t) {
    const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms);
    if (days >= 365) {
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        return months === 0
            ? t('duration.years', { years })
            : t('duration.yearsMonths', { years, months });
    }
    if (days >= 30) {
        const months = Math.floor(days / 30);
        const remainingDays = days % 30;
        return remainingDays === 0
            ? t('duration.months', { months })
            : t('duration.monthsDays', { months, days: remainingDays });
    }
    if (days > 0) {
        return hours === 0
            ? t('duration.days', { days })
            : t('duration.daysHours', { days, hours });
    }
    if (totalHours > 0) {
        return t('duration.hours', {
            hours: totalHours,
            minutes: String(minutes).padStart(2, '0'),
            seconds: String(seconds).padStart(2, '0'),
        });
    }
    if (totalMinutes > 0) {
        return t('duration.minutes', {
            minutes: totalMinutes,
            seconds: String(seconds).padStart(2, '0'),
        });
    }
    return t('duration.seconds', { seconds });
}
/** Preserve exact whole seconds for hover and accessible naming. */
function formatExactDuration(ms, t) {
    const { seconds, minutes, hours, days } = splitDuration(ms);
    return days === 0
        ? formatDuration(ms, t)
        : t('duration.exactDays', {
            days,
            hours: String(hours).padStart(2, '0'),
            minutes: String(minutes).padStart(2, '0'),
            seconds: String(seconds).padStart(2, '0'),
        });
}
const NO_DESCENDANTS = { count: 0, runningCount: 0 };
/** Render the known direct-child shape while its authoritative catalog hydrates. */
function CatalogLoadingRows({ parentSessionId, summaries, level, t, }) {
    const children = Object.values(summaries).filter(summary => (summary.origin === 'subagent' && summary.parentId === parentSessionId));
    if (children.length === 0)
        return (0, jsx_runtime_1.jsx)("div", { className: SubagentCatalogAction_styles_1.default.notice, children: t('loading.label') });
    return children.map(summary => ((0, jsx_runtime_1.jsx)("div", { className: SubagentCatalogAction_styles_1.default.node, children: (0, jsx_runtime_1.jsxs)("div", { role: "treeitem", "aria-disabled": "true", "aria-level": level, "aria-label": t('loading.aria'), className: `${SubagentCatalogAction_styles_1.default.row} ${SubagentCatalogAction_styles_1.default.disabled} ${SubagentCatalogAction_styles_1.default.loadingRow}`, children: [(0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.disclosureSpace }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: summary.running ? 'ongoing' : 'done' }), (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.content, children: (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.label, children: t('loading.label') }) })] }) }, summary.id)));
}
/** Render one catalog level and recurse only through explicitly expanded rows. */
function CatalogRows({ parentSessionId, catalog, catalogs, summaries, expanded, level, now, openChild, refresh, toggleBranch, closeCatalog, t, }) {
    const emptyLoading = catalog.state === 'loading' && catalog.entries.length === 0;
    const reserveDisclosure = catalog.entries.some(entry => entry.kind === 'child' && entry.hasChildren);
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [emptyLoading && ((0, jsx_runtime_1.jsx)(CatalogLoadingRows, { parentSessionId: parentSessionId, summaries: summaries, level: level, t: t })), catalog.state === 'error' && ((0, jsx_runtime_1.jsxs)("div", { className: SubagentCatalogAction_styles_1.default.error, children: [(0, jsx_runtime_1.jsx)("span", { children: catalog.error?.message ?? t('load.error') }), (0, jsx_runtime_1.jsxs)("button", { type: "button", className: SubagentCatalogAction_styles_1.default.refresh, onClick: () => { refresh(parentSessionId); }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconRefreshOutline14, {}), t('retry')] })] })), catalog.entries.map((entry) => {
                if (entry.kind === 'diagnostic') {
                    const reason = diagnosticReason(entry, t);
                    return ((0, jsx_runtime_1.jsx)("div", { className: SubagentCatalogAction_styles_1.default.node, children: (0, jsx_runtime_1.jsxs)("div", { role: "treeitem", "aria-disabled": "true", "aria-level": level, "aria-label": `${entry.id} ${reason}`, className: `${SubagentCatalogAction_styles_1.default.row} ${SubagentCatalogAction_styles_1.default.disabled}`, title: reason, children: [reserveDisclosure && (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.disclosureSpace }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "error" }), (0, jsx_runtime_1.jsxs)("span", { className: SubagentCatalogAction_styles_1.default.content, children: [(0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.label, children: entry.id }), (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.summary, children: reason })] })] }) }, entry.id));
                }
                const childCatalog = catalogs[entry.id];
                const isExpanded = expanded.has(entry.id);
                const knownLeaf = !entry.hasChildren;
                const childLoading = childCatalog === undefined
                    || (childCatalog.state === 'loading' && childCatalog.entries.length === 0);
                const summary = summaries[entry.id];
                const label = entry.label ?? entry.id;
                const mode = entry.mode === 'one-shot' ? t('mode.oneShot') : t('mode.continuable');
                const activity = entry.activity === 'running' ? t('activity.running') : t('activity.inactive');
                const secondary = [summary?.title, mode, activity]
                    .filter(value => value !== undefined)
                    .join(' · ');
                const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage);
                const durationMs = activityDuration(summary, entry.activity, now);
                const tokenMetric = totalTokens === undefined
                    ? undefined
                    : `${formatTokens(totalTokens)} tok`;
                const durationMetric = durationMs === undefined
                    ? undefined
                    : {
                        compact: formatDuration(durationMs, t),
                        exact: formatExactDuration(durationMs, t),
                    };
                const metrics = [tokenMetric, durationMetric?.exact]
                    .filter(value => value !== undefined)
                    .join(' · ');
                const open = () => {
                    openChild({ parentSessionId, childSessionId: entry.id, mode: entry.mode });
                    closeCatalog();
                };
                const handleKey = (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        open();
                    }
                    else if ((event.key === 'ArrowRight' && !knownLeaf && !isExpanded)
                        || (event.key === 'ArrowLeft' && isExpanded)) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleBranch(entry.id);
                    }
                };
                const toggle = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleBranch(entry.id);
                };
                return ((0, jsx_runtime_1.jsxs)("div", { className: SubagentCatalogAction_styles_1.default.node, children: [(0, jsx_runtime_1.jsxs)("div", { role: "treeitem", tabIndex: 0, "aria-level": level, "aria-label": [label, secondary, metrics].filter(value => value !== '').join(' '), ...knownLeaf ? {} : { 'aria-expanded': isExpanded }, className: SubagentCatalogAction_styles_1.default.row, onClick: open, onKeyDown: handleKey, children: [knownLeaf
                                    ? reserveDisclosure && (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.disclosureSpace })
                                    : ((0, jsx_runtime_1.jsx)("button", { type: "button", tabIndex: -1, className: `${SubagentCatalogAction_styles_1.default.disclosure} ${isExpanded ? SubagentCatalogAction_styles_1.default.disclosureOpen : ''}`, "aria-label": t(isExpanded ? 'branch.collapse' : 'branch.expand', { label }), onClick: toggle, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, {}) })), (0, jsx_runtime_1.jsxs)("div", { className: SubagentCatalogAction_styles_1.default.clickarea, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: entry.activity === 'running' ? 'ongoing' : 'done' }), (0, jsx_runtime_1.jsxs)("span", { className: SubagentCatalogAction_styles_1.default.content, children: [(0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.label, children: label }), (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.summary, children: secondary })] }), metrics !== '' && ((0, jsx_runtime_1.jsxs)("span", { className: SubagentCatalogAction_styles_1.default.metrics, children: [tokenMetric !== undefined && (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.metricToken, children: tokenMetric }), durationMetric !== undefined && ((0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.metricDuration, title: t('duration.exactTitle', { duration: durationMetric.exact }), children: durationMetric.compact }))] }))] })] }), isExpanded && !knownLeaf && ((0, jsx_runtime_1.jsx)("div", { role: "group", className: SubagentCatalogAction_styles_1.default.children, "aria-busy": childLoading || undefined, children: childCatalog === undefined
                                ? ((0, jsx_runtime_1.jsx)(CatalogLoadingRows, { parentSessionId: entry.id, summaries: summaries, level: level + 1, t: t }))
                                : ((0, jsx_runtime_1.jsx)(CatalogRows, { parentSessionId: entry.id, catalog: childCatalog, catalogs: catalogs, summaries: summaries, expanded: expanded, level: level + 1, now: now, openChild: openChild, refresh: refresh, toggleBranch: toggleBranch, closeCatalog: closeCatalog, t: t })) }))] }, entry.id));
            })] }));
}
/**
 * Render the current session's direct catalog and lazily expanded descendants.
 * @param props - session standard props plus catalog navigation actions.
 * @returns The action while the catalog is pending or summaries establish descendants.
 */
function SubagentCatalogAction({ sessionId, useSessions, openChild, refresh, setCatalogOpen, t, }) {
    const catalogs = useSessions(state => state.subagentsByParent);
    const summaries = useSessions(state => state.byId);
    const catalog = catalogs[sessionId];
    const [open, setOpen] = (0, react_1.useState)(false);
    const [now, setNow] = (0, react_1.useState)(() => Date.now());
    const [expanded, setExpanded] = (0, react_1.useState)(() => new Set());
    const rootRef = (0, react_1.useRef)(null);
    const triggerRef = (0, react_1.useRef)(null);
    const observedCatalogs = (0, react_1.useRef)(new Set());
    const setCatalogOpenRef = (0, react_1.useRef)(setCatalogOpen);
    setCatalogOpenRef.current = setCatalogOpen;
    const healthy = catalog?.entries.filter(entry => entry.kind === 'child') ?? [];
    const descendants = (0, react_1.useMemo)(() => (0, client_1.indexSubagentDescendants)(summaries).get(sessionId) ?? NO_DESCENDANTS, [sessionId, summaries]);
    // The catalog can arrive before the session-list baseline; never undercount
    // the already-visible direct rows during that short bootstrap window.
    const descendantCount = Math.max(healthy.length, descendants.count);
    const totalCountKey = descendantCount === 1 ? 'count.total.one' : 'count.total.other';
    const runningCountKey = descendants.runningCount === 1 ? 'count.running.one' : 'count.running.other';
    // Session summaries can announce membership before the descriptor-backed catalog catches up.
    // Keep that entry point visible through disabled loading rows; only catalog rows are navigable.
    const summaryBackedLoading = descendants.count > 0
        && (catalog === undefined || (catalog.state === 'ready' && catalog.entries.length === 0));
    const presentedCatalog = summaryBackedLoading
        ? {
            entries: [],
            parentAvailable: catalog?.parentAvailable ?? false,
            state: 'loading',
            error: null,
        }
        : catalog;
    const observeCatalog = (parentSessionId, next) => {
        if (next)
            observedCatalogs.current.add(parentSessionId);
        else
            observedCatalogs.current.delete(parentSessionId);
        setCatalogOpen(parentSessionId, next);
    };
    const closeAllCatalogs = () => {
        for (const parentSessionId of observedCatalogs.current) {
            setCatalogOpen(parentSessionId, false);
        }
        observedCatalogs.current.clear();
        setExpanded(new Set());
    };
    const changeOpen = (next, restoreFocus = false) => {
        setOpen(next);
        if (next) {
            setNow(Date.now());
            observeCatalog(sessionId, true);
        }
        else
            closeAllCatalogs();
        if (restoreFocus)
            queueMicrotask(() => { triggerRef.current?.focus(); });
    };
    const closeBranch = (root) => {
        const closing = new Set();
        const visit = (parentSessionId) => {
            if (closing.has(parentSessionId) || !expanded.has(parentSessionId))
                return;
            closing.add(parentSessionId);
            const branch = catalogs[parentSessionId];
            for (const entry of branch?.entries ?? []) {
                if (entry.kind === 'child')
                    visit(entry.id);
            }
        };
        visit(root);
        for (const parentSessionId of closing)
            observeCatalog(parentSessionId, false);
        setExpanded(current => new Set([...current].filter(id => !closing.has(id))));
    };
    const toggleBranch = (childSessionId) => {
        if (expanded.has(childSessionId)) {
            closeBranch(childSessionId);
            return;
        }
        setExpanded(current => new Set(current).add(childSessionId));
        observeCatalog(childSessionId, true);
    };
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
                changeOpen(false);
            }
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => { document.removeEventListener('pointerdown', closeOutside); };
    }, [open]);
    (0, react_1.useEffect)(() => {
        if (!open || descendants.runningCount === 0)
            return;
        const timer = setInterval(() => { setNow(Date.now()); }, 1000);
        return () => { clearInterval(timer); };
    }, [open, descendants.runningCount]);
    (0, react_1.useEffect)(() => () => {
        for (const parentSessionId of observedCatalogs.current) {
            setCatalogOpenRef.current(parentSessionId, false);
        }
        observedCatalogs.current.clear();
    }, []);
    // Visibility needs evidence of children (entries, summary-known descendants,
    // or a failed load worth retrying). A bare loading catalog is not evidence:
    // selecting any session schedules a refresh whose loading snapshot would
    // otherwise flash the action in and out on childless sessions.
    const visible = presentedCatalog !== undefined
        && (presentedCatalog.state === 'error'
            || presentedCatalog.entries.length > 0
            || descendantCount > 0);
    (0, react_1.useEffect)(() => {
        if (visible || !open)
            return;
        setOpen(false);
        closeAllCatalogs();
    }, [visible, open]);
    if (!visible)
        return null;
    const focusAt = (index) => {
        const items = treeItems(rootRef.current);
        if (items.length === 0)
            return;
        items[(index + items.length) % items.length]?.focus();
    };
    const navigate = (event) => {
        const items = treeItems(rootRef.current);
        const active = document.activeElement;
        const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
        if (event.key === 'Escape') {
            event.preventDefault();
            changeOpen(false, true);
        }
        else if (event.key === 'Home') {
            event.preventDefault();
            focusAt(0);
        }
        else if (event.key === 'End') {
            event.preventDefault();
            focusAt(items.length - 1);
        }
        else if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusAt(index + 1);
        }
        else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusAt(index < 0 ? items.length - 1 : index - 1);
        }
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: SubagentCatalogAction_styles_1.default.root, ref: rootRef, onKeyDown: navigate, children: [(0, jsx_runtime_1.jsxs)("button", { ref: triggerRef, type: "button", className: SubagentCatalogAction_styles_1.default.trigger, "aria-haspopup": "tree", "aria-expanded": open, "aria-label": t(descendants.runningCount > 0 ? runningCountKey : totalCountKey, { count: descendants.runningCount > 0 ? descendants.runningCount : descendantCount }), onClick: () => { changeOpen(!open); }, onKeyDown: (event) => {
                    if (event.key !== 'ArrowDown')
                        return;
                    event.preventDefault();
                    if (!open)
                        changeOpen(true);
                    queueMicrotask(() => { focusAt(0); });
                }, children: [(0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.activitySlot, children: descendants.runningCount > 0 && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: "ongoing" }) }), (0, jsx_runtime_1.jsx)("span", { className: SubagentCatalogAction_styles_1.default.count, children: t(totalCountKey, { count: descendantCount }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { className: open ? SubagentCatalogAction_styles_1.default.triggerOpen : undefined })] }), open && ((0, jsx_runtime_1.jsx)("div", { className: SubagentCatalogAction_styles_1.default.menu, role: "tree", "aria-label": t('tree.aria'), children: (0, jsx_runtime_1.jsx)(CatalogRows, { parentSessionId: sessionId, catalog: presentedCatalog, catalogs: catalogs, summaries: summaries, expanded: expanded, level: 1, now: now, openChild: openChild, refresh: refresh, toggleBranch: toggleBranch, closeCatalog: () => { changeOpen(false); }, t: t }) }))] }));
}

},
"src/modules/subagent/SubagentCatalogAction.styles.js": function(module, exports, require) {
// source: src/modules/subagent/SubagentCatalogAction.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SubagentCatalogAction_css_1 = __importDefault(require("./SubagentCatalogAction.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-subagent/SubagentCatalogAction.module.css", "@xharness/dsh-client-ui-subagent", SubagentCatalogAction_css_1.default);
const styles = {
    "activitySlot": "W7ZgPW_activitySlot",
    "children": "W7ZgPW_children",
    "clickarea": "W7ZgPW_clickarea",
    "content": "W7ZgPW_content",
    "count": "W7ZgPW_count",
    "disabled": "W7ZgPW_disabled",
    "disclosure": "W7ZgPW_disclosure",
    "disclosureOpen": "W7ZgPW_disclosureOpen",
    "disclosureSpace": "W7ZgPW_disclosureSpace",
    "error": "W7ZgPW_error",
    "label": "W7ZgPW_label",
    "loadingRow": "W7ZgPW_loadingRow",
    "menu": "W7ZgPW_menu",
    "metricDuration": "W7ZgPW_metricDuration",
    "metricToken": "W7ZgPW_metricToken",
    "metrics": "W7ZgPW_metrics",
    "node": "W7ZgPW_node",
    "notice": "W7ZgPW_notice",
    "refresh": "W7ZgPW_refresh",
    "root": "W7ZgPW_root",
    "row": "W7ZgPW_row",
    "summary": "W7ZgPW_summary",
    "trigger": "W7ZgPW_trigger",
    "triggerOpen": "W7ZgPW_triggerOpen"
};
exports.default = styles;

},
"src/modules/subagent/SubagentCatalogAction.css": function(module, exports, require) {
// source: src/modules/subagent/SubagentCatalogAction.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".W7ZgPW_root{position:relative}.W7ZgPW_trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:3px;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex}.W7ZgPW_count{margin:0 5px}.W7ZgPW_activitySlot{flex:none;width:10px;height:10px;display:inline-flex}.W7ZgPW_trigger:hover,.W7ZgPW_trigger:focus-visible{color:var(--dsw-alias-label-secondary)}.W7ZgPW_trigger svg{transition:transform .12s}.W7ZgPW_triggerOpen{transform:rotate(180deg)}.W7ZgPW_menu{z-index:100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:336px;max-width:min(400px,100vw - 32px);max-height:min(560px,100vh - 140px);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}.W7ZgPW_node{min-width:0;position:relative}.W7ZgPW_menu>.W7ZgPW_node{margin-left:-3px}.W7ZgPW_row{box-sizing:border-box;width:100%;min-height:50px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;outline:none;align-items:flex-start;gap:8px;padding:7px 8px 7px 11px;font-size:13px;line-height:18px;display:flex;position:relative}.W7ZgPW_row:hover>.W7ZgPW_clickarea,.W7ZgPW_row:focus-visible>.W7ZgPW_clickarea{background:var(--dsw-alias-interactive-bg-hover)}.W7ZgPW_clickarea{box-sizing:border-box;border-radius:8px;flex:1;align-self:stretch;align-items:flex-start;gap:8px;min-width:0;margin:-7px -8px;padding:7px 8px;display:flex}.W7ZgPW_row>[data-state],.W7ZgPW_clickarea>[data-state]{margin-top:4px}.W7ZgPW_disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}.W7ZgPW_disabled:hover{background:0 0}.W7ZgPW_loadingRow{cursor:default}.W7ZgPW_disclosure,.W7ZgPW_disclosureSpace{flex:none;width:14px;height:18px}.W7ZgPW_disclosure{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;padding:0;transition:transform .12s;display:inline-flex}.W7ZgPW_disclosure:hover{color:var(--dsw-alias-label-primary)}.W7ZgPW_disclosureOpen{transform:rotate(90deg)}.W7ZgPW_content{flex-direction:column;flex:1;min-width:0;display:flex}.W7ZgPW_label,.W7ZgPW_summary{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.W7ZgPW_label{color:inherit;font-weight:400}.W7ZgPW_summary,.W7ZgPW_metrics{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.W7ZgPW_metrics{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;flex:none;grid-template-rows:18px 16px;display:grid}.W7ZgPW_metricToken{grid-row:1;line-height:18px}.W7ZgPW_metricDuration{grid-row:2}.W7ZgPW_children{margin-left:18px;padding-left:4px;position:relative}.W7ZgPW_children:before,.W7ZgPW_children>.W7ZgPW_node:before{content:\"\";border-left:1px solid var(--dsw-alias-border-l2);position:absolute;left:0}.W7ZgPW_children:before{height:26px;top:-26px}.W7ZgPW_children[aria-busy=true]:before{content:none}.W7ZgPW_children>.W7ZgPW_node:before{top:0;bottom:0;left:-4px}.W7ZgPW_children>.W7ZgPW_node:last-child:before{height:17px;bottom:auto}.W7ZgPW_children>.W7ZgPW_node>.W7ZgPW_row:before{content:\"\";border-top:1px solid var(--dsw-alias-border-l2);width:14px;position:absolute;top:16px;left:-4px}.W7ZgPW_notice,.W7ZgPW_error{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.W7ZgPW_error{color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:center;gap:12px;display:flex}.W7ZgPW_refresh{color:inherit;cursor:pointer;background:0 0;border:0;border-radius:6px;flex:none;align-items:center;gap:4px;padding:4px 6px;display:inline-flex}.W7ZgPW_refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}\n";

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
"src/modules/subagent/SubagentReadOnlyComposer.js": function(module, exports, require) {
// source: src/modules/subagent/SubagentReadOnlyComposer.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubagentReadOnlyComposer = SubagentReadOnlyComposer;
const jsx_runtime_1 = require("react/jsx-runtime");
const SubagentReadOnlyComposer_styles_1 = __importDefault(require("./SubagentReadOnlyComposer.styles"));
/**
 * Explain why the normal composer is unavailable for an addressed child.
 * @param props - selector-owned read-only reason plus standard slot props.
 * @returns A read-only composer replacement.
 */
function SubagentReadOnlyComposer({ matched, t, }) {
    const oneShot = matched.reason === 'one-shot';
    return ((0, jsx_runtime_1.jsxs)("div", { className: SubagentReadOnlyComposer_styles_1.default.frame, role: "status", children: [(0, jsx_runtime_1.jsx)("strong", { children: t(oneShot ? 'readonly.oneShot.title' : 'readonly.title') }), (0, jsx_runtime_1.jsx)("span", { children: t(oneShot ? 'readonly.oneShot.body' : 'readonly.body') })] }));
}

},
"src/modules/subagent/SubagentReadOnlyComposer.styles.js": function(module, exports, require) {
// source: src/modules/subagent/SubagentReadOnlyComposer.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const SubagentReadOnlyComposer_css_1 = __importDefault(require("./SubagentReadOnlyComposer.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-subagent/SubagentReadOnlyComposer.module.css", "@xharness/dsh-client-ui-subagent", SubagentReadOnlyComposer_css_1.default);
const styles = {
    "frame": "ZuKiNG_frame"
};
exports.default = styles;

},
"src/modules/subagent/SubagentReadOnlyComposer.css": function(module, exports, require) {
// source: src/modules/subagent/SubagentReadOnlyComposer.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".ZuKiNG_frame{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:54px;color:var(--dsw-alias-label-tertiary);border-radius:14px;justify-content:center;align-items:center;gap:8px;margin:0 24px 20px;padding:10px 16px;font-size:13px;line-height:20px;display:flex}.ZuKiNG_frame strong{color:var(--dsw-alias-label-primary);font-weight:510}\n";

},
"src/modules/subagent/locales.js": function(module, exports, require) {
// source: src/modules/subagent/locales.ts

"use strict";
/** `subagent` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'subagent';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'diagnostic.corrupt': '会话记录损坏',
    'diagnostic.unsupported': '子代理记录版本不受支持',
    'diagnostic.unavailable': '会话记录暂不可用',
    'duration.seconds': '{seconds}秒',
    'duration.minutes': '{minutes}分{seconds}秒',
    'duration.hours': '{hours}小时{minutes}分{seconds}秒',
    'duration.days': '{days}天',
    'duration.daysHours': '{days}天{hours}小时',
    'duration.months': '约{months}个月',
    'duration.monthsDays': '约{months}个月{days}天',
    'duration.years': '约{years}年',
    'duration.yearsMonths': '约{years}年{months}个月',
    'duration.exactDays': '{days}天{hours}小时{minutes}分{seconds}秒',
    'duration.exactTitle': '总活跃耗时：{duration}',
    'loading.label': '正在加载子代理…',
    'loading.aria': '正在加载子代理',
    'load.error': '无法加载子代理',
    'retry': '重试',
    'mode.oneShot': '一次性',
    'mode.continuable': '可继续',
    'activity.running': '正在运行',
    'activity.inactive': '当前未运行',
    'branch.collapse': '收起 {label} 的下级子代理',
    'branch.expand': '展开 {label} 的下级子代理',
    'count.total.one': '{count} 个子代理',
    'count.total.other': '{count} 个子代理',
    'count.running.one': '{count} 个子代理，正在运行',
    'count.running.other': '{count} 个子代理，正在运行',
    'tree.aria': '子代理会话',
    'readonly.oneShot.title': '一次性子代理记录',
    'readonly.title': '此子代理暂时只读',
    'readonly.oneShot.body': '一次性任务不支持后续消息，可在这里查看完整执行记录。',
    'readonly.body': '父会话当前不在线，重新打开父会话后即可继续发送消息。',
};
/** English dictionary, key-identical to the Chinese source of truth. */
exports.en = {
    'diagnostic.corrupt': 'corrupted session record',
    'diagnostic.unsupported': 'unsupported subagent record version',
    'diagnostic.unavailable': 'session record temporarily unavailable',
    'duration.seconds': '{seconds}s',
    'duration.minutes': '{minutes}m {seconds}s',
    'duration.hours': '{hours}h {minutes}m {seconds}s',
    'duration.days': '{days}d',
    'duration.daysHours': '{days}d {hours}h',
    'duration.months': '~{months}mo',
    'duration.monthsDays': '~{months}mo {days}d',
    'duration.years': '~{years}y',
    'duration.yearsMonths': '~{years}y {months}mo',
    'duration.exactDays': '{days}d {hours}h {minutes}m {seconds}s',
    'duration.exactTitle': 'Total active duration: {duration}',
    'loading.label': 'Loading subagents…',
    'loading.aria': 'Loading subagents',
    'load.error': 'Unable to load subagents',
    'retry': 'Retry',
    'mode.oneShot': 'one-shot',
    'mode.continuable': 'continuable',
    'activity.running': 'running',
    'activity.inactive': 'not running',
    'branch.collapse': 'Collapse {label} descendants',
    'branch.expand': 'Expand {label} descendants',
    'count.total.one': '{count} subagent',
    'count.total.other': '{count} subagents',
    'count.running.one': '{count} subagent running',
    'count.running.other': '{count} subagents running',
    'tree.aria': 'Subagent sessions',
    'readonly.oneShot.title': 'One-shot subagent record',
    'readonly.title': 'This subagent is read-only for now',
    'readonly.oneShot.body': 'One-shot tasks do not accept follow-ups; review the full execution record here.',
    'readonly.body': 'The parent session is offline; reopen it to continue sending messages.',
};

}
};
const __dependencies = {"src/modules/subagent/index.js":{"./SubagentCatalogAction":"src/modules/subagent/SubagentCatalogAction.js","./SubagentReadOnlyComposer":"src/modules/subagent/SubagentReadOnlyComposer.js","./locales":"src/modules/subagent/locales.js"},"src/modules/subagent/SubagentCatalogAction.js":{"./SubagentCatalogAction.styles":"src/modules/subagent/SubagentCatalogAction.styles.js"},"src/modules/subagent/SubagentCatalogAction.styles.js":{"./SubagentCatalogAction.css":"src/modules/subagent/SubagentCatalogAction.css","../views-types":"src/modules/views-types.js"},"src/modules/subagent/SubagentCatalogAction.css":{},"src/modules/views-types.js":{},"src/modules/subagent/SubagentReadOnlyComposer.js":{"./SubagentReadOnlyComposer.styles":"src/modules/subagent/SubagentReadOnlyComposer.styles.js"},"src/modules/subagent/SubagentReadOnlyComposer.styles.js":{"./SubagentReadOnlyComposer.css":"src/modules/subagent/SubagentReadOnlyComposer.css","../views-types":"src/modules/views-types.js"},"src/modules/subagent/SubagentReadOnlyComposer.css":{},"src/modules/subagent/locales.js":{}};
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
return __load("src/modules/subagent/index.js");
}
});
