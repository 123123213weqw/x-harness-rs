// Generated from src/modules/goal/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-goal",
factory: (__externalRequire) => {
const __units = {
"src/modules/goal/index.js": function(module, exports, require) {
// source: src/modules/goal/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.GoalDock = exports.GoalBar = void 0;
exports.apply = apply;
const GoalBar_1 = require("./GoalBar");
const GoalCommandInputView_1 = require("./GoalCommandInputView");
const goal_command_input_1 = require("./goal-command-input");
const locales_1 = require("./locales");
var GoalBar_2 = require("./GoalBar");
Object.defineProperty(exports, "GoalBar", { enumerable: true, get: function () { return GoalBar_2.GoalBar; } });
Object.defineProperty(exports, "GoalDock", { enumerable: true, get: function () { return GoalBar_2.GoalDock; } });
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
            onBudget: async (maxGoalRounds) => {
                const ref = refOf(sessionId);
                if (ref === undefined)
                    return noCurrentGoal;
                return await ctx.remote.goals.edit(sessionId, ref, { maxGoalRounds });
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
/** Goal dock, with XHarness execution status and inline budget/completion controls. */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const GoalBar_styles_1 = __importDefault(require("./GoalBar.styles"));
const PHASE_LABELS = { active: 'phase.active', paused: 'phase.paused', blocked: 'phase.blocked', complete: 'phase.complete' };
const STATES = {
    disabled: '未启用自动推进', running: '正在执行', queued: '已排队', waiting: '等待依赖或用户输入',
    awaiting_approval: '等待工具审批', awaiting_answer: '等待回答', awaiting_confirmation: '等待你确认完成',
    network_backoff: '网络异常，等待自动重试', paused: '已暂停', blocked: '需要帮助', complete: '已完成',
};
const REASONS = {
    round_budget: '轮数预算已到', cancelled: '用户停止', execution_error: '执行失败', step_limit: '步骤上限',
    output_limit: '输出上限', outcome_unknown: '上轮结果未知，未自动重放', report_protocol_stalled: '连续缺少进展报告',
};
function goalStatus(goal, projection, t) {
    const execution = projection?.execution;
    const label = execution ? STATES[execution.state] ?? execution.state : goal.phase === 'complete' ? '已完成' : t(PHASE_LABELS[goal.phase]);
    return `${label} · ${execution?.roundsStarted ?? goal.roundsStarted ?? 0}/${execution?.maxGoalRounds ?? goal.maxGoalRounds} 轮`;
}
function goalTitle(goal, projection) {
    const execution = projection?.execution;
    const report = execution?.report;
    return [goal.objective, execution?.pauseReason && (REASONS[execution.pauseReason] ?? execution.pauseReason), execution?.pauseDetail,
        goal.blockedReason?.message, report?.summary, ...(report?.remaining ?? []),
        ...(report?.evidence ?? []).map(e => `${e.kind}: ${e.reference ?? e.execution_id}`),
    ].filter(Boolean).join('\n');
}
function GoalControls({ projection, onComplete, onResume, onBudget, runAction, pending }) {
    const [editing, setEditing] = (0, react_1.useState)(false);
    const [budget, setBudget] = (0, react_1.useState)('');
    const id = projection?.goal.id;
    const identity = (0, react_1.useRef)(id);
    (0, react_1.useEffect)(() => { identity.current = id; setEditing(false); setBudget(''); return () => { identity.current = undefined; }; }, [id]);
    if (!projection?.goal)
        return null;
    const execution = projection.execution;
    const glyph = { '启用自动推进': '▶', '确认完成': '✓', '继续': '▶', '预算': '⋯', '取消预算修改': '×' };
    const button = (label, action) => (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, "aria-label": label, title: label, onClick: action, style: { flexShrink: 0, whiteSpace: 'nowrap' }, children: glyph[label] ?? label });
    return (0, jsx_runtime_1.jsxs)("span", { "data-goal-runtime": true, style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, children: [execution?.state === 'disabled' && button('启用自动推进', () => { void runAction(onResume); }), execution?.state === 'awaiting_confirmation' && button('确认完成', () => { void runAction(onComplete); }), execution?.state === 'awaiting_confirmation' && button('继续', () => { void runAction(onResume); }), projection.goal.phase !== 'complete' && (editing ? (0, jsx_runtime_1.jsxs)("form", { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, onSubmit: async (event) => {
                    event.preventDefault();
                    const value = Number(budget);
                    if (!Number.isSafeInteger(value) || value < 1)
                        return;
                    const started = id;
                    const result = await runAction(() => onBudget(value));
                    if (result?.ok && identity.current === started)
                        setEditing(false);
                }, children: [(0, jsx_runtime_1.jsx)("input", { type: "number", min: 1, step: 1, value: budget, disabled: pending, "aria-label": "\u8F6E\u6570\u9884\u7B97", title: "\u4FDD\u5B58\u540E\u6682\u505C\u81EA\u52A8\u63A8\u8FDB", onChange: event => { setBudget(event.target.value); }, onKeyDown: event => { if (event.key === 'Escape')
                            setEditing(false); }, style: { width: 64, minWidth: 0 } }), (0, jsx_runtime_1.jsx)("button", { type: "submit", className: GoalBar_styles_1.default.iconBtn, disabled: pending || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1, "aria-label": "\u4FDD\u5B58\u8F6E\u6570\u9884\u7B97", title: "\u4FDD\u5B58\u9884\u7B97\u5E76\u6682\u505C\u81EA\u52A8\u63A8\u8FDB", children: "\u4FDD\u5B58" }), button('取消预算修改', () => { setEditing(false); })] }) : button('预算', () => { setBudget(String(execution?.maxGoalRounds ?? projection.goal.maxGoalRounds)); setEditing(true); }))] });
}
function GoalBar({ goal, projection, onComplete, onBudget, onEdit, onPause, onResume, onClear, t }) {
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
    const handleClear = (0, react_1.useCallback)(async (clearedId) => {
        if ((await runAction(onClear))?.ok)
            setClearedGoalId(clearedId);
    }, [onClear, runAction]);
    if (goal === undefined || goal === null || goal.id === clearedGoalId)
        return null;
    if (editing)
        return (0, jsx_runtime_1.jsx)("div", { className: GoalBar_styles_1.default.dock, "data-goal-bar": true, children: (0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.bar, children: [(0, jsx_runtime_1.jsx)("input", { className: GoalBar_styles_1.default.objectiveInput, type: "text", "aria-label": t('objective.aria'), value: draft, autoFocus: true, onChange: event => { setDraft(event.target.value); }, onKeyDown: event => {
                            if (event.key === 'Enter')
                                void handleEdit();
                            if (event.key === 'Escape')
                                setEditing(false);
                        } }), actionError !== null && (0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.error, role: "alert", children: actionError }), (0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.actions, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.save'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, onClick: () => { void handleEdit(); }, disabled: pending || draft.trim() === '', "aria-label": t('action.save'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCheckOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.cancel'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, onClick: () => { setEditing(false); }, disabled: pending, "aria-label": t('action.cancel'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 14 }) }) })] })] }) });
    return (0, jsx_runtime_1.jsx)("div", { className: GoalBar_styles_1.default.dock, "data-goal-bar": true, children: (0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.bar, title: goalTitle(goal, projection), style: { minHeight: 36, height: 'auto', flexWrap: 'wrap' }, children: [(0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.goalGlyph, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconGoalOutline16, { size: 14 }) }), (0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.label, children: goalStatus(goal, projection, t) }), (0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.objective, children: goal.objective }), actionError !== null && (0, jsx_runtime_1.jsx)("span", { className: GoalBar_styles_1.default.error, role: "alert", children: actionError }), (0, jsx_runtime_1.jsxs)("div", { className: GoalBar_styles_1.default.actions, children: [goal.phase === 'active' && projection?.execution?.state !== 'disabled' && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.pause'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, onClick: () => { void runAction(onPause); }, "aria-label": t('action.pause'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPauseOutline16, { size: 14 }) }) }), (goal.phase === 'paused' || goal.phase === 'blocked') && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.resume'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, onClick: () => { void runAction(onResume); }, "aria-label": t('action.resume'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.edit'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, onClick: () => { setDraft(goal.objective); setEditing(true); }, "aria-label": t('action.edit'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t('action.clear'), side: "bottom", delayMs: 500, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: GoalBar_styles_1.default.iconBtn, disabled: pending, onClick: () => { void handleClear(goal.id); }, "aria-label": t('action.clear'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconTrashOutline16, { size: 14 }) }) }), (0, jsx_runtime_1.jsx)(GoalControls, { projection: projection, onComplete: onComplete, onBudget: onBudget, onResume: onResume, runAction: runAction, pending: pending })] })] }) });
}
function GoalDock({ useProjection, onEdit, onPause, onResume, onClear, onComplete, onBudget, t }) {
    const projection = useProjection('goal');
    return (0, jsx_runtime_1.jsx)(GoalBar, { goal: projection === undefined ? undefined : projection === null ? null : projection.goal, projection: projection, onEdit: onEdit, onPause: onPause, onResume: onResume, onClear: onClear, onComplete: onComplete, onBudget: onBudget, t: t });
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
    "actions": "bgzwgq_actions",
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
exports.default = ".bgzwgq_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto}.bgzwgq_bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);border-radius:12px;align-items:center;gap:10px;height:36px;margin:0 auto;padding:4px 5px 4px 12px;display:flex}.bgzwgq_goalGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}.bgzwgq_label{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}.bgzwgq_objective{min-width:0;color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;line-height:20px;overflow:hidden}.bgzwgq_error{min-width:0;color:var(--dsw-alias-state-error-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:20px;overflow:hidden}.bgzwgq_objectiveInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);min-width:0;height:26px;color:var(--dsw-alias-label-primary);border-radius:6px;outline:none;flex:1;padding:0 8px;font-size:13px;line-height:20px}.bgzwgq_objectiveInput:focus{border-color:var(--dsw-alias-state-business-primary)}.bgzwgq_objectiveInput::placeholder{color:var(--dsw-alias-label-caption)}.bgzwgq_actions{flex:none;align-items:center;gap:10px;display:flex}.bgzwgq_iconBtn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}.bgzwgq_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.bgzwgq_iconBtn:disabled{opacity:.4;cursor:default}";

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
const __dependencies = {"src/modules/goal/index.js":{"./GoalBar":"src/modules/goal/GoalBar.js","./GoalCommandInputView":"src/modules/goal/GoalCommandInputView.js","./goal-command-input":"src/modules/goal/goal-command-input.js","./locales":"src/modules/goal/locales.js"},"src/modules/goal/GoalBar.js":{"./GoalBar.styles":"src/modules/goal/GoalBar.styles.js"},"src/modules/goal/GoalBar.styles.js":{"./GoalBar.css":"src/modules/goal/GoalBar.css","../views-types":"src/modules/views-types.js"},"src/modules/goal/GoalBar.css":{},"src/modules/views-types.js":{},"src/modules/goal/GoalCommandInputView.js":{"./GoalCommandInputView.styles":"src/modules/goal/GoalCommandInputView.styles.js"},"src/modules/goal/GoalCommandInputView.styles.js":{"./GoalCommandInputView.css":"src/modules/goal/GoalCommandInputView.css","../views-types":"src/modules/views-types.js"},"src/modules/goal/GoalCommandInputView.css":{},"src/modules/goal/goal-command-input.js":{},"src/modules/goal/locales.js":{}};
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
