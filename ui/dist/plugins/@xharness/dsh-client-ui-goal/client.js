// Generated from src/modules/goal/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-goal",
factory: (__externalRequire) => {
const __units = {
"src/modules/goal/index.js": function(module, exports, require) {
// source: src/modules/goal/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.ProgressDock = exports.GoalDock = exports.GoalBar = void 0;
exports.apply = apply;
const GoalBar_1 = require("./GoalBar");
const ProgressDock_1 = require("./ProgressDock");
const GoalCommandInputView_1 = require("./GoalCommandInputView");
const goal_command_input_1 = require("./goal-command-input");
const locales_1 = require("./locales");
var GoalBar_2 = require("./GoalBar");
Object.defineProperty(exports, "GoalBar", { enumerable: true, get: function () { return GoalBar_2.GoalBar; } });
Object.defineProperty(exports, "GoalDock", { enumerable: true, get: function () { return GoalBar_2.GoalDock; } });
var ProgressDock_2 = require("./ProgressDock");
Object.defineProperty(exports, "ProgressDock", { enumerable: true, get: function () { return ProgressDock_2.ProgressDock; } });
/** Dictionary namespace owned by this plugin. */
const NS = 'goal';
/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
exports.inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents'];
/**
 * Client plugin body: the GoalBar dock entry with its mutation verbs.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.conversationEvents.register(goal_command_input_1.goalCommandInputDefinition);
    ctx.effect(() => ctx.locale.register(NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-goal: dictionaries');
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'command-input',
        locale: NS,
    }, GoalCommandInputView_1.GoalCommandInputView));
    const sessions = ctx.sessions;
    /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
    const refOf = (sessionId) => {
        const face = sessions.binding(sessionId)?.session.projections.faceOf('goal');
        const projection = face?.getSnapshot();
        if (projection == null)
            return undefined;
        return { id: projection.goal.id, revision: projection.goal.revision };
    };
    const noCurrentGoal = {
        ok: false,
        error: { code: 'no-current-goal', message: 'no current goal to mutate', details: {} },
    };
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'goal',
        order: 10,
        locale: NS,
        inject: (sessionId) => ({
            onEdit: async (objective) => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.edit(sessionId, ref, { objective });
            },
            onPause: async () => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.pause(sessionId, ref);
            },
            onResume: async () => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.resume(sessionId, ref);
            },
            onComplete: async () => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.complete(sessionId, ref);
            },
            onClear: async () => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.clear(sessionId, ref);
            },
        }),
    }, GoalBar_1.GoalDock));
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'task-progress', order: 9, locale: NS,
    }, ProgressDock_1.ProgressDock));
}

},
"src/modules/goal/GoalBar.js": function(module, exports, require) {
// source: src/modules/goal/GoalBar.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.goalStatus = goalStatus;
exports.goalTitle = goalTitle;
exports.GoalBar = GoalBar;
exports.GoalDock = GoalDock;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Compact Goal dock; user controls reuse the existing authoritative RPCs. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const GoalBar_styles_1 = __importDefault(require("./GoalBar.styles"));
const PHASE_LABELS = { active: 'phase.active', paused: 'phase.paused', blocked: 'phase.blocked', complete: 'phase.complete' };
const STATES = {
    disabled: 'state.disabled', running: 'state.running', queued: 'state.queued', waiting: 'state.waiting',
    awaiting_approval: 'state.awaitingApproval', awaiting_answer: 'state.awaitingAnswer', awaiting_confirmation: 'state.awaitingConfirmation',
    network_backoff: 'state.networkBackoff', paused: 'state.paused', blocked: 'state.blocked', complete: 'phase.complete',
};
const REASONS = {
    round_budget: '旧版本轮数限制，可手动继续', cancelled: '用户停止', execution_error: '执行失败', step_limit: '步骤上限',
    output_limit: '输出上限', outcome_unknown: '上轮结果未知，未自动重放', report_protocol_stalled: '连续缺少进展报告',
};
function stateLabel(goal, projection, t) {
    const state = projection?.execution?.state;
    if (state === undefined)
        return t(PHASE_LABELS[goal.phase]);
    const key = STATES[state];
    return key === undefined ? state : t(key);
}
function goalStatus(goal, projection, t) {
    const execution = projection?.execution;
    return `${stateLabel(goal, projection, t)} · ${execution?.roundsStarted ?? projection?.roundsStarted ?? goal.roundsStarted ?? 0} ${t('rounds.unit')}`;
}
function goalTitle(goal, projection) {
    const execution = projection?.execution;
    const report = execution?.report;
    return [goal.objective, execution?.pauseReason && (REASONS[execution.pauseReason] ?? execution.pauseReason), execution?.pauseDetail,
        goal.blockedReason?.message, report?.summary, ...(report?.remaining ?? []),
        ...(report?.evidence ?? []).map(e => `${e.kind}: ${e.reference ?? e.execution_id}`),
    ].filter(Boolean).join('\n');
}
function GoalControls({ goal, projection, onComplete, onResume, onPause, clearGoal, runAction, pending, actionError, beginEdit, t }) {
    const [menuOpen, setMenuOpen] = (0, react_1.useState)(false);
    const [clearOpen, setClearOpen] = (0, react_1.useState)(false);
    const moreRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => { setMenuOpen(false); setClearOpen(false); }, [goal.id, goal.revision]);
    const execution = projection?.execution;
    const complete = goal.phase === 'complete';
    const confirmation = !complete && execution?.state === 'awaiting_confirmation';
    const resume = complete || goal.phase === 'paused' || goal.phase === 'blocked' || execution?.state === 'disabled' || confirmation;
    const resumeLabel = complete ? t('action.reopen') : execution?.state === 'disabled' ? t('action.enable') : confirmation ? t('action.continue') : t('action.resume');
    const closeSurface = () => {
        if (pending)
            return;
        setClearOpen(false);
        moreRef.current?.focus();
    };
    const items = [
        { id: 'edit', label: t('action.edit'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, {}), disabled: pending },
        ...(!complete ? [
            { id: 'complete', label: t('action.complete'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, {}), disabled: pending },
        ] : []),
        { id: 'separator', type: 'separator' },
        { id: 'clear', label: t('action.clear'), icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTrashOutline16, {}), danger: true, disabled: pending },
    ];
    return (0, jsx_runtime_1.jsxs)("span", { className: GoalBar_styles_1.default.controls, "data-goal-runtime": true, children: [(0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.label, title: goalStatus(goal, projection, t), children: stateLabel(goal, projection, t) }), (0, jsx_runtime_1.jsxs)("span", { className: GoalBar_styles_1.default.rounds, "aria-label": t('rounds.label'), title: t('rounds.hint'), children: [execution?.roundsStarted ?? projection?.roundsStarted ?? goal.roundsStarted ?? 0, " ", t('rounds.unit')] }), confirmation && (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, "aria-label": t('action.confirm'), title: t('action.confirm'), onClick: () => { void runAction(onComplete); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 16 }) }), resume ? (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, "aria-label": resumeLabel, title: resumeLabel, onClick: () => { void runAction(onResume); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, { size: 16 }) })
                : (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, "aria-label": t('action.pause'), title: t('action.pauseHint'), onClick: () => { void runAction(onPause); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPauseOutline16, { size: 16 }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Menu, { open: menuOpen, onClose: () => { setMenuOpen(false); }, items: items, portal: true, side: "top", align: "end", compact: true, onSelect: id => {
                    if (pending)
                        return;
                    setMenuOpen(false);
                    if (id === 'edit')
                        beginEdit();
                    else if (id === 'complete') {
                        moreRef.current?.focus();
                        void runAction(onComplete);
                    }
                    else if (id === 'clear')
                        setClearOpen(true);
                }, anchor: (0, jsx_runtime_1.jsx)("button", { ref: moreRef, type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, "aria-label": t('action.more'), title: t('action.more'), "aria-haspopup": "menu", "aria-expanded": menuOpen, onClick: () => { setMenuOpen(value => !value); }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEllipsisOutline16, { size: 16 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: clearOpen, onClose: closeSurface, title: t('clear.title'), closeLabel: t('action.close'), description: t('clear.hint'), className: GoalBar_styles_1.default.dialog, footer: (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { size: "sm", disabled: pending, onClick: closeSurface, children: t('action.cancelDialog') }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { size: "sm", variant: "primary", disabled: pending, onClick: () => { void clearGoal(); }, children: t('action.clear') })] }), children: actionError !== null && (0, jsx_runtime_1.jsx)("p", { className: GoalBar_styles_1.default.error, role: "alert", children: actionError }) })] });
}
function GoalBar({ goal, projection, onComplete, onEdit, onPause, onResume, onClear, t }) {
    const [editing, setEditing] = (0, react_1.useState)(false);
    const [draft, setDraft] = (0, react_1.useState)('');
    const [pending, setPending] = (0, react_1.useState)(false);
    const [actionError, setActionError] = (0, react_1.useState)(null);
    const [clearedGoalId, setClearedGoalId] = (0, react_1.useState)(null);
    const pendingRef = (0, react_1.useRef)(false);
    const actionEpoch = (0, react_1.useRef)(0);
    const goalId = goal?.id;
    (0, react_1.useEffect)(() => {
        setEditing(false);
        setActionError(null);
        setClearedGoalId(null);
        actionEpoch.current++;
        pendingRef.current = false;
        setPending(false);
        return () => { actionEpoch.current++; pendingRef.current = false; };
    }, [goalId]);
    const runAction = (0, react_1.useCallback)(async (action) => {
        if (pendingRef.current)
            return undefined;
        pendingRef.current = true;
        const epoch = actionEpoch.current;
        setPending(true);
        setActionError(null);
        let result;
        try {
            result = await action();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = { ok: false, error: { code: 'network', message } };
        }
        if (epoch !== actionEpoch.current)
            return undefined;
        pendingRef.current = false;
        setPending(false);
        if (!result.ok)
            setActionError(`${result.error.message} (${result.error.code})`);
        return result;
    }, []);
    const handleEdit = (0, react_1.useCallback)(async () => {
        const trimmed = draft.trim();
        if (trimmed === '')
            return;
        if ((await runAction(() => onEdit(trimmed)))?.ok)
            setEditing(false);
    }, [draft, onEdit, runAction]);
    if (goal === undefined || goal === null || goal.id === clearedGoalId)
        return null;
    const beginEdit = () => { setDraft(goal.objective); setEditing(true); };
    return (0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.dock, "data-goal-bar": true, children: [(0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.bar, title: goalTitle(goal, projection), children: [(0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.goalGlyph, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconGoalOutline16, { size: 16 }) }), editing ? (0, jsx_runtime_1.jsxs)("form", { className: GoalBar_styles_1.default.editForm, onSubmit: event => { event.preventDefault(); void handleEdit(); }, children: [(0, jsx_runtime_1.jsx)("input", { className: GoalBar_styles_1.default.objectiveInput, type: "text", "aria-label": t('objective.aria'), value: draft, autoFocus: true, disabled: pending, onChange: event => { setDraft(event.target.value); }, onKeyDown: event => { if (event.key === 'Escape' && !pending)
                                    setEditing(false); } }), (0, jsx_runtime_1.jsx)("button", { type: "submit", className: GoalBar_styles_1.default.iconBtn, disabled: pending || draft.trim() === '', "aria-label": t('action.save'), title: t('action.save'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 16 }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, onClick: () => { setEditing(false); }, "aria-label": t('action.cancel'), title: t('action.cancel'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 16 }) })] }) : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.objective, title: t('action.edit'), "aria-label": `${t('action.edit')}: ${goal.objective}`, disabled: pending, onClick: beginEdit, children: goal.objective }), (0, jsx_runtime_1.jsx)(GoalControls, { goal: goal, projection: projection, onComplete: onComplete, onPause: onPause, onResume: onResume, clearGoal: async () => {
                                    if ((await runAction(onClear))?.ok)
                                        setClearedGoalId(goal.id);
                                }, runAction: runAction, beginEdit: beginEdit, pending: pending, actionError: actionError, t: t }, goal.id)] })] }), actionError !== null && (0, jsx_runtime_1.jsx)("div", { className: GoalBar_styles_1.default.error, role: "status", children: actionError })] });
}
function GoalDock({ useProjection, onEdit, onPause, onResume, onClear, onComplete, t }) {
    const projection = useProjection('goal');
    return (0, jsx_runtime_1.jsx)(GoalBar, { goal: projection === undefined ? undefined : projection === null ? null : projection.goal, projection: projection, onEdit: onEdit, onPause: onPause, onResume: onResume, onClear: onClear, onComplete: onComplete, t: t });
}

},
"src/modules/goal/GoalBar.styles.js": function(module, exports, require) {
// source: src/modules/goal/GoalBar.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const GoalBar_css_1 = __importDefault(require("./GoalBar.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-goal/GoalBar.module.css", "@xharness/dsh-client-ui-goal", GoalBar_css_1.default);
const styles = {
    "dialog": "bgzwgq_dialog",
    "editForm": "bgzwgq_editForm",
    "rounds": "bgzwgq_rounds",
    "controls": "bgzwgq_controls",
    "bar": "bgzwgq_bar",
    "dock": "bgzwgq_dock",
    "error": "bgzwgq_error",
    "goalGlyph": "bgzwgq_goalGlyph",
    "iconBtn": "bgzwgq_iconBtn",
    "label": "bgzwgq_label",
    "objective": "bgzwgq_objective",
    "objectiveInput": "bgzwgq_objectiveInput"
};
exports.default = styles;

},
"src/modules/goal/GoalBar.css": function(module, exports, require) {
// source: src/modules/goal/GoalBar.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = "/* Same composer alignment and tokens; only the current action stays exposed. */\n.bgzwgq_dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));margin:0 auto}\n.bgzwgq_bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));min-height:40px;margin:0 auto;padding:4px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.bgzwgq_goalGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}\n.bgzwgq_objective{min-width:0;flex:1 1 120px;text-align:left;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:24px;border:0;background:transparent;padding:2px 0;cursor:pointer;border-radius:4px}\n.bgzwgq_objective:hover{color:var(--dsw-alias-label-secondary)}\n.bgzwgq_controls{display:inline-flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0}\n.bgzwgq_label{color:var(--dsw-alias-label-tertiary);min-width:0;max-width:145px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-size:12px;line-height:24px}\n.bgzwgq_rounds{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:24px;font-variant-numeric:tabular-nums;white-space:nowrap;padding:2px 6px;border-radius:6px;cursor:default}\n.bgzwgq_iconBtn{width:28px;height:28px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:8px;justify-content:center;align-items:center;padding:0;display:inline-flex}\n.bgzwgq_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.bgzwgq_iconBtn:disabled,.bgzwgq_objective:disabled{opacity:.4;cursor:default}\n.bgzwgq_objective:focus-visible,.bgzwgq_rounds:focus-visible,.bgzwgq_iconBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}\n.bgzwgq_editForm{flex:1;min-width:0;display:flex;align-items:center;gap:6px}\n.bgzwgq_objectiveInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);min-width:0;color:var(--dsw-alias-label-primary);border-radius:8px;outline:none;padding:7px 10px;font:inherit;font-size:13px;line-height:20px}\n.bgzwgq_objectiveInput{flex:1;height:32px;width:100%}\n.bgzwgq_objectiveInput:focus{border-color:var(--dsw-alias-state-business-primary)}\n.bgzwgq_error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;font-size:12px;line-height:20px;margin:4px 0}\n.bgzwgq_dialog{width:min(360px,calc(100vw - 32px))}\n@media(max-width:520px){.bgzwgq_objective{flex-basis:calc(100% - 32px)}.bgzwgq_controls{flex:1;margin-left:24px}.bgzwgq_label{flex:1;max-width:none}}\n";

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
"src/modules/goal/ProgressDock.js": function(module, exports, require) {
// source: src/modules/goal/ProgressDock.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProgressPlan = readProgressPlan;
exports.ProgressDock = ProgressDock;
const jsx_runtime_1 = require("react/jsx-runtime");
require("./ProgressDock.styles");
function isUnknownArray(value) { return Array.isArray(value); }
/** Validate the generic wire projection before consuming its fields. */
function readProgressPlan(value) {
    if (typeof value !== 'object' || value === null || !('revision' in value) || !('items' in value))
        return null;
    const { revision, items } = value;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !isUnknownArray(items) || items.length > 128)
        return null;
    const parsed = [];
    const ids = new Set();
    for (const item of items) {
        // Array.isArray yields a library array; receive each element as unknown.
        const entry = item;
        if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('title' in entry) || !('status' in entry))
            return null;
        const { id, title, status } = entry;
        if (typeof id !== 'string' || id.length > 128 || !id.trim() || ids.has(id) || typeof title !== 'string' || title.length > 2048 || !title.trim())
            return null;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
            return null;
        ids.add(id);
        parsed.push({ id, title, status });
    }
    return { revision, items: parsed };
}
function ProgressDock({ useProjection, t }) {
    const plan = readProgressPlan(useProjection('taskPlan'));
    if (!plan || plan.items.length === 0)
        return null;
    const completed = plan.items.filter(item => item.status === 'completed').length;
    return (0, jsx_runtime_1.jsx)("div", { className: "xh-progress-dock", "data-task-plan-revision": plan.revision, children: (0, jsx_runtime_1.jsxs)("details", { className: "xh-progress-card", open: true, children: [(0, jsx_runtime_1.jsxs)("summary", { children: [(0, jsx_runtime_1.jsx)("span", { children: t('progress.title') }), (0, jsx_runtime_1.jsxs)("span", { className: "xh-progress-count", children: [completed, "/", plan.items.length] }), (0, jsx_runtime_1.jsx)("span", { className: "xh-progress-chevron", "aria-hidden": "true", children: "\u2303" })] }), (0, jsx_runtime_1.jsx)("ol", { "aria-label": t('progress.title'), children: plan.items.map(item => (0, jsx_runtime_1.jsxs)("li", { "data-plan-item": item.id, "data-plan-status": item.status, children: [(0, jsx_runtime_1.jsx)("span", { className: "xh-progress-icon", "aria-hidden": "true", children: item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '○' }), (0, jsx_runtime_1.jsxs)("span", { className: "xh-progress-item", children: [(0, jsx_runtime_1.jsxs)("span", { className: "xh-progress-sr", children: [t(item.status === 'completed' ? 'progress.completed' : item.status === 'in_progress' ? 'progress.running' : 'progress.pending'), ": "] }), item.title] })] }, item.id)) })] }) });
}

},
"src/modules/goal/ProgressDock.styles.js": function(module, exports, require) {
// source: src/modules/goal/ProgressDock.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ProgressDock_css_1 = __importDefault(require("./ProgressDock.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)('@xharness/dsh-client-ui-goal/ProgressDock.css', '@xharness/dsh-client-ui-goal', ProgressDock_css_1.default);

},
"src/modules/goal/ProgressDock.css": function(module, exports, require) {
// source: src/modules/goal/ProgressDock.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xh-progress-dock { width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset)); margin: 0 auto; min-width: 0; padding: 0 0 8px; box-sizing: border-box; }\n.xh-progress-card { max-width: 480px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-specific-tip); color: var(--dsw-alias-label-primary); font-size: 13px; }\n.xh-progress-card summary { display: flex; align-items: center; gap: 18px; padding: 12px 16px; cursor: pointer; list-style: none; color: var(--dsw-alias-label-tertiary); font-weight: 500; }\n.xh-progress-card summary::-webkit-details-marker { display: none; }\n.xh-progress-card summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 12px; }\n.xh-progress-count { font-variant-numeric: tabular-nums; }\n.xh-progress-chevron { margin-left: auto; }\n.xh-progress-card:not([open]) .xh-progress-chevron { transform: rotate(180deg); }\n.xh-progress-card ol { list-style: none; margin: 0; padding: 0 12px 10px; max-height: 260px; overflow-y: auto; }\n.xh-progress-card li { display: flex; align-items: baseline; gap: 10px; padding: 6px 4px; line-height: 1.5; }\n.xh-progress-icon { flex: 0 0 16px; text-align: center; }\n.xh-progress-item { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }\n.xh-progress-card [data-plan-status=\"completed\"] { color: var(--dsw-alias-label-tertiary); opacity: .65; }\n.xh-progress-card [data-plan-status=\"completed\"] .xh-progress-item { text-decoration: line-through; }\n.xh-progress-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\n\n/* Keep task progress flat, full-width and separate from the writing surface. */\n.xh-progress-dock{max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));padding:0}\n.xh-progress-card{max-width:none;border:0;border-radius:0;background:transparent}\n.xh-progress-card summary{gap:8px;padding:6px 12px;min-height:24px}\n.xh-progress-card ol{padding:0 12px 8px;max-height:168px}\n/* Anchor hidden status labels inside the list's clipping boundary, not the\n   outer composer: offscreen rows must not create phantom page overflow. */\n.xh-progress-card li{position:relative;align-items:flex-start;min-height:26px;padding:1px 0;line-height:26px}\n.xh-progress-card [data-plan-status=\"completed\"]{opacity:1}\n.xh-progress-card [data-plan-status=\"completed\"] .xh-progress-item{text-decoration-thickness:1px}\n[data-composer-card] .xh-progress-dock{width:100%;max-width:none;margin:0}\n[data-composer-card] .xh-progress-card summary{padding-left:0;padding-right:0}\n[data-composer-card] .xh-progress-card ol{padding-left:0;padding-right:0}\n";

},
"src/modules/goal/GoalCommandInputView.js": function(module, exports, require) {
// source: src/modules/goal/GoalCommandInputView.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalCommandInputView = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const GoalCommandInputView_styles_1 = __importDefault(require("./GoalCommandInputView.styles"));
/** Right-aligned `/goal` input bubble without ordinary message actions. */
exports.GoalCommandInputView = (0, react_1.memo)(function GoalCommandInputView({ node, t, }) {
    const data = node.data;
    return ((0, jsx_runtime_1.jsx)("div", { className: GoalCommandInputView_styles_1.default.row, "data-command-input": "", role: "group", "aria-label": t('commandInput.aria'), children: (0, jsx_runtime_1.jsx)("div", { className: GoalCommandInputView_styles_1.default.stack, children: (0, jsx_runtime_1.jsx)("div", { className: GoalCommandInputView_styles_1.default.bubble, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.MessageText, { text: data.text }) }) }) }));
});

},
"src/modules/goal/GoalCommandInputView.styles.js": function(module, exports, require) {
// source: src/modules/goal/GoalCommandInputView.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const GoalCommandInputView_css_1 = __importDefault(require("./GoalCommandInputView.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-goal/GoalCommandInputView.module.css", "@xharness/dsh-client-ui-goal", GoalCommandInputView_css_1.default);
const styles = {
    "bubble": "btJGaW_bubble",
    "row": "btJGaW_row",
    "stack": "btJGaW_stack"
};
exports.default = styles;

},
"src/modules/goal/GoalCommandInputView.css": function(module, exports, require) {
// source: src/modules/goal/GoalCommandInputView.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".btJGaW_row{flex-direction:column;align-items:flex-end;gap:6px;display:flex}.btJGaW_stack{flex-direction:column;align-items:flex-end;min-width:0;max-width:min(525px,82%);display:flex}.btJGaW_bubble{overflow-wrap:anywhere;background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code);white-space:pre-wrap;border-radius:22px;padding:10px 16px}";

},
"src/modules/goal/goal-command-input.js": function(module, exports, require) {
// source: src/modules/goal/goal-command-input.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.goalCommandInputDefinition = void 0;
exports.goalCommandText = goalCommandText;
/**
 * Derive the visible command line from its structured durable run.
 * @param event - `/goal` command run.
 * @returns command text with trailing parser whitespace removed.
 */
function goalCommandText(event) {
    return `/${event.data.name}${(event.data.args ?? '').trimEnd()}`;
}
/** Goal-owned command input projection; the generic command Definition retains the result row. */
exports.goalCommandInputDefinition = {
    kind: 'goal-command-input',
    target: 'chat',
    match: event => event.type === 'command/run' && event.data.name === 'goal'
        ? { id: String(event.data.commandId), role: 'start' }
        : null,
    start: (_context, match) => {
        if (match.event.type !== 'command/run') {
            throw new Error('goal-command-input start requires command/run');
        }
        return {
            commandId: match.event.data.commandId,
            seq: match.event.seq,
            time: match.event.time,
            text: goalCommandText(match.event),
        };
    },
    update: context => context.state,
    buildViewNode: (context) => {
        if (context.state === undefined)
            return null;
        return {
            key: context.key,
            kind: 'command-input',
            id: context.id,
            target: 'chat',
            anchorSeq: context.state.seq - 0.1,
            location: context.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: {
                commandId: context.state.commandId,
                text: context.state.text,
                time: context.state.time,
            },
        };
    },
};

},
"src/modules/goal/locales.js": function(module, exports, require) {
// source: src/modules/goal/locales.ts

"use strict";
/** `goal` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = void 0;
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'phase.complete': '已完成',
    'state.disabled': '未启用',
    'state.running': '运行中',
    'state.queued': '已排队',
    'state.waiting': '等待输入或依赖',
    'state.awaitingApproval': '等待工具审批',
    'state.awaitingAnswer': '等待回答',
    'state.awaitingConfirmation': '待确认完成',
    'state.networkBackoff': '网络重试中',
    'state.paused': '已暂停',
    'state.blocked': '需要帮助',
    'rounds.unit': '轮',
    'rounds.label': '累计自动轮数',
    'rounds.hint': '只统计已开始的自动轮次，不限制继续执行',
    'action.more': '更多目标操作',
    'action.complete': '标记完成',
    'action.confirm': '确认完成',
    'action.continue': '继续',
    'action.reopen': '重新开启',
    'action.enable': '启用自动推进',
    'action.pauseHint': '暂停后续自动轮次，不会取消当前工具',
    'action.close': '关闭',
    'action.cancelDialog': '取消',
    'clear.title': '清除目标？',
    'clear.hint': '聊天记录和已有文件不会删除。',
    'progress.title': '进度',
    'progress.completed': '已完成',
    'progress.running': '进行中',
    'progress.pending': '待办',
    'phase.active': '进行中的目标',
    'phase.paused': '已暂停的目标',
    'phase.blocked': '受阻的目标',
    'objective.aria': '目标内容',
    'commandInput.aria': '命令输入',
    'action.save': '保存目标',
    'action.cancel': '取消编辑',
    'action.pause': '暂停目标',
    'action.resume': '恢复目标',
    'action.edit': '编辑目标',
    'action.clear': '清除目标',
};
/** English dictionary, checked complete against the zh key set. */
exports.en = {
    'phase.complete': 'Completed',
    'state.disabled': 'Not enabled',
    'state.running': 'Running',
    'state.queued': 'Queued',
    'state.waiting': 'Waiting for input or dependencies',
    'state.awaitingApproval': 'Awaiting tool approval',
    'state.awaitingAnswer': 'Awaiting answer',
    'state.awaitingConfirmation': 'Awaiting confirmation',
    'state.networkBackoff': 'Retrying connection',
    'state.paused': 'Paused',
    'state.blocked': 'Needs help',
    'rounds.unit': 'rounds',
    'rounds.label': 'Automatic rounds started',
    'rounds.hint': 'Started automatic turns only; this count never limits execution',
    'action.more': 'More goal actions',
    'action.complete': 'Mark complete',
    'action.confirm': 'Confirm completion',
    'action.continue': 'Continue',
    'action.reopen': 'Reopen goal',
    'action.enable': 'Enable automatic progress',
    'action.pauseHint': 'Pause future automatic turns; current tools are not cancelled',
    'action.close': 'Close',
    'action.cancelDialog': 'Cancel',
    'clear.title': 'Clear goal?',
    'clear.hint': 'Chat history and existing files will be kept.',
    'progress.title': 'Progress',
    'progress.completed': 'Completed',
    'progress.running': 'In progress',
    'progress.pending': 'Pending',
    'phase.active': 'Ongoing Goal',
    'phase.paused': 'Paused Goal',
    'phase.blocked': 'Blocked Goal',
    'objective.aria': 'Goal objective',
    'commandInput.aria': 'Command input',
    'action.save': 'Save goal',
    'action.cancel': 'Cancel edit',
    'action.pause': 'Pause goal',
    'action.resume': 'Resume goal',
    'action.edit': 'Edit goal',
    'action.clear': 'Clear goal',
};

}
};
const __dependencies = {"src/modules/goal/index.js":{"./GoalBar":"src/modules/goal/GoalBar.js","./ProgressDock":"src/modules/goal/ProgressDock.js","./GoalCommandInputView":"src/modules/goal/GoalCommandInputView.js","./goal-command-input":"src/modules/goal/goal-command-input.js","./locales":"src/modules/goal/locales.js"},"src/modules/goal/GoalBar.js":{"./GoalBar.styles":"src/modules/goal/GoalBar.styles.js"},"src/modules/goal/GoalBar.styles.js":{"./GoalBar.css":"src/modules/goal/GoalBar.css","../views-types":"src/modules/views-types.js"},"src/modules/goal/GoalBar.css":{},"src/modules/views-types.js":{},"src/modules/goal/ProgressDock.js":{"./ProgressDock.styles":"src/modules/goal/ProgressDock.styles.js"},"src/modules/goal/ProgressDock.styles.js":{"./ProgressDock.css":"src/modules/goal/ProgressDock.css","../views-types":"src/modules/views-types.js"},"src/modules/goal/ProgressDock.css":{},"src/modules/goal/GoalCommandInputView.js":{"./GoalCommandInputView.styles":"src/modules/goal/GoalCommandInputView.styles.js"},"src/modules/goal/GoalCommandInputView.styles.js":{"./GoalCommandInputView.css":"src/modules/goal/GoalCommandInputView.css","../views-types":"src/modules/views-types.js"},"src/modules/goal/GoalCommandInputView.css":{},"src/modules/goal/goal-command-input.js":{},"src/modules/goal/locales.js":{}};
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
return __load("src/modules/goal/index.js");
}
});
