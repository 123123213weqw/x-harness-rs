// Generated from src/modules/workflow-run/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-workflow-run",
factory: (__externalRequire) => {
const __units = {
"src/modules/workflow-run/index.js": function(module, exports, require) {
// source: src/modules/workflow-run/index.ts

"use strict";
/** Browser plugin for durable workflow-run Conversation Nodes. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const WorkflowRunPanel_1 = require("./WorkflowRunPanel");
const locales_1 = require("./locales");
const workflow_definition_1 = require("./workflow-definition");
/** Required services for Definition, keyed renderer, navigation, and copy. */
exports.inject = ['conversationEvents', 'slots', 'sessions', 'locale'];
/** Register the workflow Definition, dictionary, and keyed Chat renderer. */
function apply(ctx) {
    ctx.conversationEvents.register(workflow_definition_1.workflowRunDefinition);
    ctx.effect(() => ctx.locale.register(locales_1.NS, { zh: locales_1.zh, en: locales_1.en }), 'ui-workflow-run: dictionaries');
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'workflow-run',
        locale: locales_1.NS,
        inject: () => ({
            openSession: (id) => { ctx.sessions.open(id); },
        }),
    }, WorkflowRunPanel_1.WorkflowRunPanel));
}

},
"src/modules/workflow-run/WorkflowRunPanel.js": function(module, exports, require) {
// source: src/modules/workflow-run/WorkflowRunPanel.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkflowRunPanel = WorkflowRunPanel;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const client_1 = require("@xharness/dsh-client-runtime/client");
const WorkflowRunPanel_styles_1 = __importDefault(require("./WorkflowRunPanel.styles"));
const STATUS_KEYS = {
    running: 'status.running',
    completed: 'status.completed',
    failed: 'status.failed',
    cancelled: 'status.cancelled',
    interrupted: 'status.interrupted',
};
function dotState(status) {
    switch (status) {
        case 'running': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
        case 'cancelled':
        case 'interrupted': return 'warning';
        /* v8 ignore next -- WorkflowRunStatus is closed and every variant is handled above. */
        default: return status;
    }
}
function readablePhase(phase, t) {
    if (phase === null)
        return t('phase.unassigned');
    return phase === '' ? t('phase.empty') : phase;
}
function readableMember(label, t) {
    return label === '' ? t('member.empty') : label;
}
function statusCount(status, count, t) {
    return t(`statusCount.${status}`, { count });
}
function memberCount(count, t) {
    return t(count === 1 ? 'run.members.one' : 'run.members.other', { count });
}
function StatusDisclosure(props) {
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.DisclosureRow, { ...props, expandable: true });
}
function abnormal(status) {
    return status === 'failed' || status === 'cancelled' || status === 'interrupted';
}
function phaseDisclosureFacts(phase) {
    const mode = phase.members.some(member => abnormal(member.status))
        ? 'abnormal'
        : phase.members.some(member => member.status === 'running') ? 'running' : 'clean';
    return { mode, activityCount: phase.members.length };
}
function runDisclosureFacts(status, phases) {
    const mode = abnormal(status) || phases.some(([, facts]) => facts.mode === 'abnormal')
        ? 'abnormal'
        : status === 'running' || phases.some(([, facts]) => facts.mode === 'running')
            ? 'running'
            : 'clean';
    const activityCount = phases.reduce((count, [, facts]) => count + facts.activityCount, 0);
    return { mode, activityCount };
}
function initialDisclosureState(facts) {
    return { ...facts, open: facts.mode !== 'clean', pendingCleanCollapse: false };
}
function advanceDisclosureState(current, facts, focusWithin) {
    const sameFacts = current.mode === facts.mode && current.activityCount === facts.activityCount;
    if (sameFacts) {
        if (!current.pendingCleanCollapse || focusWithin)
            return current;
        return { ...current, open: false, pendingCleanCollapse: false };
    }
    if (facts.mode === 'clean') {
        const deferCollapse = current.open && focusWithin;
        return { ...facts, open: deferCollapse, pendingCleanCollapse: deferCollapse };
    }
    if (current.mode === 'clean' || (facts.mode === 'abnormal' && current.mode !== 'abnormal')) {
        return { ...facts, open: true, pendingCleanCollapse: false };
    }
    return { ...facts, open: current.open, pendingCleanCollapse: false };
}
function focusIsWithin(element) {
    if (element === null || element === undefined)
        return false;
    return element.contains(element.ownerDocument.activeElement);
}
function collapsePending(state) {
    if (!state.pendingCleanCollapse)
        return state;
    return { ...state, open: false, pendingCleanCollapse: false };
}
function existingPhaseState(phases, key) {
    const phase = phases.get(key);
    /* v8 ignore next -- mounted phase callbacks are created from this owner map. */
    if (phase === undefined)
        throw new Error(`Missing disclosure state for phase ${key}`);
    return phase;
}
function preventPendingHeaderFocus(event) {
    const header = event.currentTarget.querySelector('[data-disclosure-row]');
    /* v8 ignore next -- DisclosureRow always renders its header before the content. */
    if (header === null)
        throw new Error('Missing disclosure header');
    if (event.target instanceof Node && header.contains(event.target))
        event.preventDefault();
}
function phaseStatusSummary(members, t) {
    const counts = new Map();
    for (const member of members)
        counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
    const count = (status) => counts.get(status) ?? 0;
    const active = ['running', 'failed', 'cancelled', 'interrupted']
        .filter(status => count(status) > 0);
    if (active.length === 0)
        return statusCount('completed', count('completed'), t);
    const visible = active.includes('interrupted') && count('completed') > 0
        ? ['completed', ...active]
        : active;
    return visible.map(status => statusCount(status, count(status), t)).join(' · ');
}
function navigableMembers(sessions, phases, parentId) {
    const ordinary = new Set(sessions.ids);
    const result = [];
    for (const phase of phases) {
        for (const member of phase.members) {
            const summary = sessions.byId[member.childId];
            if (member.status === 'running'
                && ordinary.has(member.childId)
                && summary?.origin === 'subagent'
                && summary.parentId === parentId
                && summary.running) {
                result.push(member.childId);
            }
        }
    }
    return result;
}
function RunHeader({ children, count, name, onToggle, open, status, t }) {
    return ((0, jsx_runtime_1.jsx)(StatusDisclosure, { icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, {}), title: t('run.title', { name }), open: open, onToggle: onToggle, expandOnRowClick: true, previewChevron: false, keepContentWhenOpen: true, rowClassName: WorkflowRunPanel_styles_1.default.runHeader, leadingClassName: WorkflowRunPanel_styles_1.default.runLeading, titleClassName: WorkflowRunPanel_styles_1.default.runTitle, collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.runSummary, children: memberCount(count, t) }), (0, jsx_runtime_1.jsxs)("span", { className: WorkflowRunPanel_styles_1.default.statusTail, "data-status": status, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: dotState(status) }), (0, jsx_runtime_1.jsx)("span", { children: t(STATUS_KEYS[status]) })] })] })), children: children }));
}
function MemberRow({ member, navigable, openSession, t }) {
    const name = readableMember(member.label, t);
    const [focused, setFocused] = (0, react_1.useState)(false);
    const renderButton = navigable || focused;
    const content = ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.dotSlot, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: dotState(member.status) }) }), (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.memberLabelWrap, "data-member-label-wrap": true, children: (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.memberLabel, "data-member-label": true, children: name }) }), (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.memberStatus, "data-member-status-text": true, children: t(STATUS_KEYS[member.status]) })] }));
    if (!renderButton) {
        return (0, jsx_runtime_1.jsx)("div", { className: WorkflowRunPanel_styles_1.default.memberRow, "data-member-status": member.status, children: content });
    }
    return ((0, jsx_runtime_1.jsx)("button", { type: "button", className: navigable ? WorkflowRunPanel_styles_1.default.memberButton : WorkflowRunPanel_styles_1.default.memberRow, "data-member-status": member.status, "aria-disabled": navigable ? undefined : true, "aria-label": navigable ? t('member.open', { name }) : name, tabIndex: navigable ? undefined : -1, onFocus: () => { setFocused(true); }, onBlur: () => { setFocused(false); }, onClick: navigable ? () => { openSession(member.childId); } : undefined, children: content }));
}
function PhaseSection({ contentRef, onContentBlur, onToggle, open, pendingCleanCollapse, phase, navigable, openSession, t, }) {
    return ((0, jsx_runtime_1.jsx)("div", { className: WorkflowRunPanel_styles_1.default.phase, onMouseDownCapture: pendingCleanCollapse ? preventPendingHeaderFocus : undefined, children: (0, jsx_runtime_1.jsx)(StatusDisclosure, { icon: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronRightOutline14, {}), title: readablePhase(phase.phase, t), open: open, onToggle: onToggle, expandOnRowClick: true, previewChevron: false, keepContentWhenOpen: true, rowClassName: WorkflowRunPanel_styles_1.default.phaseHeader, leadingClassName: WorkflowRunPanel_styles_1.default.phaseLeading, titleClassName: WorkflowRunPanel_styles_1.default.phaseTitle, collapsedContent: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.separator, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.phaseCount, "data-phase-count": true, children: memberCount(phase.members.length, t) }), (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.phaseStatus, "data-phase-status-text": true, children: phaseStatusSummary(phase.members, t) })] })), children: (0, jsx_runtime_1.jsx)("div", { ref: contentRef, className: WorkflowRunPanel_styles_1.default.members, onBlur: onContentBlur, children: phase.members.map(member => ((0, jsx_runtime_1.jsx)(MemberRow, { member: member, navigable: navigable.includes(member.childId), openSession: openSession, t: t }, member.seq))) }) }) }));
}
/** Render one durable workflow run with status-driven run and phase disclosure. */
function WorkflowRunPanel({ node, sessionId, useSessions, openSession, t }) {
    const phaseFacts = (0, react_1.useMemo)(() => node.data.phases.map(phase => [phase.key, phaseDisclosureFacts(phase)]), [node.data.phases]);
    const runFacts = (0, react_1.useMemo)(() => runDisclosureFacts(node.data.status, phaseFacts), [node.data.status, phaseFacts]);
    const totalMembers = runFacts.activityCount;
    const [disclosures, setDisclosures] = (0, react_1.useState)(() => ({
        run: initialDisclosureState(runFacts),
        phases: new Map(phaseFacts.map(([key, facts]) => [key, initialDisclosureState(facts)])),
    }));
    const runContentRef = (0, react_1.useRef)(null);
    const phaseContentRefs = (0, react_1.useRef)(new Map());
    const navigable = useSessions(sessions => navigableMembers(sessions, node.data.phases, sessionId), client_1.shallowEqual);
    // Outer hiding unmounts Phase content without a dependable blur event, so this edge settles deferred closes.
    (0, react_1.useLayoutEffect)(() => {
        setDisclosures((current) => {
            const phases = new Map();
            let phasesChanged = current.phases.size !== phaseFacts.length;
            let phaseStartedCycle = false;
            for (const [key, facts] of phaseFacts) {
                const previous = current.phases.get(key);
                const next = previous === undefined
                    ? initialDisclosureState(facts)
                    : advanceDisclosureState(previous, facts, focusIsWithin(phaseContentRefs.current.get(key)));
                phases.set(key, next);
                if (next !== previous)
                    phasesChanged = true;
                if (previous?.mode === 'clean'
                    && (facts.mode !== 'clean' || facts.activityCount !== previous.activityCount)) {
                    phaseStartedCycle = true;
                }
            }
            const advancedRun = advanceDisclosureState(current.run, runFacts, focusIsWithin(runContentRef.current));
            const run = phaseStartedCycle && runFacts.mode !== 'clean' && !advancedRun.open
                ? { ...advancedRun, open: true, pendingCleanCollapse: false }
                : advancedRun;
            return run !== current.run || phasesChanged ? { run, phases } : current;
        });
    }, [disclosures.run.open, phaseFacts, runFacts]);
    const toggleRun = () => {
        setDisclosures(current => ({
            ...current,
            run: {
                ...current.run,
                open: !current.run.open,
                pendingCleanCollapse: false,
            },
        }));
    };
    const togglePhase = (key) => {
        setDisclosures((current) => {
            const phases = new Map(current.phases);
            const phase = existingPhaseState(phases, key);
            phases.set(key, {
                ...phase,
                open: !phase.open,
                pendingCleanCollapse: false,
            });
            return { ...current, phases };
        });
    };
    const settleRunBlur = (event) => {
        if (event.currentTarget.contains(event.relatedTarget))
            return;
        setDisclosures((current) => {
            const run = collapsePending(current.run);
            return run === current.run ? current : { ...current, run };
        });
    };
    const settlePhaseBlur = (key, event) => {
        if (event.currentTarget.contains(event.relatedTarget))
            return;
        setDisclosures((current) => {
            const phase = existingPhaseState(current.phases, key);
            const next = collapsePending(phase);
            if (next === phase)
                return current;
            const phases = new Map(current.phases);
            phases.set(key, next);
            return { ...current, phases };
        });
    };
    return ((0, jsx_runtime_1.jsx)("section", { className: WorkflowRunPanel_styles_1.default.root, "data-workflow-run": true, "data-run-status": node.data.status, onMouseDownCapture: disclosures.run.pendingCleanCollapse
            ? preventPendingHeaderFocus
            : undefined, children: (0, jsx_runtime_1.jsx)(RunHeader, { count: totalMembers, name: node.data.name, open: disclosures.run.open, onToggle: toggleRun, status: node.data.status, t: t, children: (0, jsx_runtime_1.jsx)("div", { ref: runContentRef, className: WorkflowRunPanel_styles_1.default.phaseList, onBlur: settleRunBlur, children: node.data.phases.length === 0
                    ? (0, jsx_runtime_1.jsx)("span", { className: WorkflowRunPanel_styles_1.default.empty, children: t('run.empty') })
                    : node.data.phases.map((phase) => {
                        const facts = phaseDisclosureFacts(phase);
                        const disclosure = disclosures.phases.get(phase.key) ?? initialDisclosureState(facts);
                        return ((0, jsx_runtime_1.jsx)(PhaseSection, { contentRef: (element) => {
                                if (element === null)
                                    phaseContentRefs.current.delete(phase.key);
                                else
                                    phaseContentRefs.current.set(phase.key, element);
                            }, onContentBlur: (event) => { settlePhaseBlur(phase.key, event); }, onToggle: () => { togglePhase(phase.key); }, open: disclosure.open, pendingCleanCollapse: disclosure.pendingCleanCollapse, phase: phase, navigable: navigable, openSession: openSession, t: t }, phase.key));
                    }) }) }) }));
}

},
"src/modules/workflow-run/WorkflowRunPanel.styles.js": function(module, exports, require) {
// source: src/modules/workflow-run/WorkflowRunPanel.styles.ts

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const WorkflowRunPanel_css_1 = __importDefault(require("./WorkflowRunPanel.css"));
const views_types_1 = require("../views-types");
(0, views_types_1.installStyles)("@xharness/dsh-client-ui-workflow-run/WorkflowRunPanel.module.css", "@xharness/dsh-client-ui-workflow-run", WorkflowRunPanel_css_1.default);
const styles = {
    "dotSlot": "FLr-5G_dotSlot",
    "empty": "FLr-5G_empty",
    "memberButton": "FLr-5G_memberButton",
    "memberLabel": "FLr-5G_memberLabel",
    "memberLabelWrap": "FLr-5G_memberLabelWrap",
    "memberRow": "FLr-5G_memberRow",
    "memberStatus": "FLr-5G_memberStatus",
    "members": "FLr-5G_members",
    "phase": "FLr-5G_phase",
    "phaseCount": "FLr-5G_phaseCount",
    "phaseHeader": "FLr-5G_phaseHeader",
    "phaseLeading": "FLr-5G_phaseLeading",
    "phaseList": "FLr-5G_phaseList",
    "phaseStatus": "FLr-5G_phaseStatus",
    "phaseTitle": "FLr-5G_phaseTitle",
    "root": "FLr-5G_root",
    "runHeader": "FLr-5G_runHeader",
    "runLeading": "FLr-5G_runLeading",
    "runSummary": "FLr-5G_runSummary",
    "runTitle": "FLr-5G_runTitle",
    "separator": "FLr-5G_separator",
    "statusTail": "FLr-5G_statusTail"
};
exports.default = styles;

},
"src/modules/workflow-run/WorkflowRunPanel.css": function(module, exports, require) {
// source: src/modules/workflow-run/WorkflowRunPanel.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".FLr-5G_root{width:100%;min-width:0}.FLr-5G_runHeader{box-sizing:border-box;background:var(--dsw-alias-bg-module-platform);border-radius:8px;align-items:center;gap:6px;width:100%;min-width:0;height:32px;padding:0 8px;display:flex}.FLr-5G_runHeader:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.FLr-5G_runLeading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:0;display:inline-flex}.FLr-5G_runTitle{max-width:42%;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:14px;font-weight:510;line-height:24px;overflow:hidden}.FLr-5G_runSummary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:18px;overflow:hidden}.FLr-5G_statusTail{height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;align-items:center;gap:4px;font-size:11px;font-weight:510;line-height:16px;display:inline-flex;overflow:hidden}.FLr-5G_phaseHeader{box-sizing:border-box;align-items:center;gap:6px;width:100%;min-width:0;height:32px;display:flex}.FLr-5G_phaseHeader:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:4px}.FLr-5G_phaseLeading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:0;display:inline-flex}.FLr-5G_phaseTitle{min-width:0;max-width:42%;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:0 auto;font-size:14px;line-height:24px;overflow:hidden}.FLr-5G_phaseCount{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;line-height:20px;overflow:hidden}.FLr-5G_phaseStatus{width:132px;color:var(--dsw-alias-label-secondary);text-align:right;text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:13px;line-height:20px;overflow:hidden}.FLr-5G_separator{background:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;width:2px;height:2px}.FLr-5G_phaseList{flex-direction:column;gap:4px;min-width:0;padding:4px 0 0 16px;display:flex}.FLr-5G_phase{min-width:0}.FLr-5G_members{flex-direction:column;gap:2px;min-width:0;padding:0 0 0 16px;display:flex}.FLr-5G_memberRow,.FLr-5G_memberButton{width:100%;min-width:0;min-height:24px;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;background:0 0;border:0;border-radius:4px;align-items:center;gap:12px;padding:0;display:flex}.FLr-5G_memberButton{cursor:pointer}.FLr-5G_memberButton .FLr-5G_memberLabel{color:var(--dsw-alias-state-business-primary);text-underline-position:from-font;text-decoration:underline}.FLr-5G_dotSlot{flex:none;justify-content:center;align-items:center;width:16px;height:24px;display:inline-flex;overflow:hidden}.FLr-5G_memberButton:focus-visible{outline:none}.FLr-5G_memberButton:focus-visible .FLr-5G_memberLabelWrap{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}.FLr-5G_memberLabelWrap{border-radius:4px;flex:1;align-items:center;min-width:0;height:24px;padding:0 2px;display:flex;overflow:hidden}.FLr-5G_memberLabel{min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:14px;line-height:24px;overflow:hidden}.FLr-5G_memberStatus{width:64px;color:var(--dsw-alias-label-secondary);text-align:right;text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:13px;line-height:20px;overflow:hidden}.FLr-5G_empty{color:var(--dsw-alias-label-tertiary);padding:0;font-size:13px;line-height:20px}@media (width<=560px){.FLr-5G_phaseList,.FLr-5G_members{padding-left:12px}}\n";

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
"src/modules/workflow-run/locales.js": function(module, exports, require) {
// source: src/modules/workflow-run/locales.ts

"use strict";
/** `workflowRun` namespace dictionaries. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** Dictionary namespace owned by this plugin. */
exports.NS = 'workflowRun';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'run.title': '{name}',
    'run.members.one': '{count} 个成员',
    'run.members.other': '{count} 个成员',
    'run.empty': '没有启动成员',
    'phase.unassigned': '未分阶段',
    'phase.empty': '空阶段名',
    'statusCount.running': '运行中 {count}',
    'statusCount.completed': '已完成 {count}',
    'statusCount.failed': '失败 {count}',
    'statusCount.cancelled': '已取消 {count}',
    'statusCount.interrupted': '已中断 {count}',
    'member.empty': '空成员名',
    'member.open': '打开 {name}',
    'status.running': '运行中',
    'status.completed': '已完成',
    'status.failed': '失败',
    'status.cancelled': '已取消',
    'status.interrupted': '已中断',
};
/** English dictionary (same key set). */
exports.en = {
    'run.title': '{name}',
    'run.members.one': '{count} member',
    'run.members.other': '{count} members',
    'run.empty': 'No members started',
    'phase.unassigned': 'Unphased',
    'phase.empty': 'Empty phase name',
    'statusCount.running': 'Running {count}',
    'statusCount.completed': 'Completed {count}',
    'statusCount.failed': 'Failed {count}',
    'statusCount.cancelled': 'Cancelled {count}',
    'statusCount.interrupted': 'Interrupted {count}',
    'member.empty': 'Empty member name',
    'member.open': 'Open {name}',
    'status.running': 'Running',
    'status.completed': 'Completed',
    'status.failed': 'Failed',
    'status.cancelled': 'Cancelled',
    'status.interrupted': 'Interrupted',
};

},
"src/modules/workflow-run/workflow-definition.js": function(module, exports, require) {
// source: src/modules/workflow-run/workflow-definition.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workflowRunDefinition = void 0;
exports.workflowPhaseKey = workflowPhaseKey;
/**
 * Build a collision-free phase key preserving absent versus empty identity.
 * @param phase - exact phase string, or null for an omitted field.
 * @returns the stable renderer key for that phase identity.
 */
function workflowPhaseKey(phase) {
    return phase === null ? 'missing' : `value:${phase.length}:${phase}`;
}
function statusFromStopReason(stopReason) {
    switch (stopReason) {
        case 'completed': return 'completed';
        case 'cancelled': return 'cancelled';
        case 'error': return 'failed';
        /* v8 ignore next -- WorkflowStopReason is closed and every variant is handled above. */
        default: return stopReason;
    }
}
function statusFromOutcome(outcome) {
    switch (outcome) {
        case 'completed': return 'completed';
        case 'cancelled': return 'cancelled';
        case 'failed': return 'failed';
        /* v8 ignore next -- WorkflowAgentOutcome is closed and every variant is handled above. */
        default: return outcome;
    }
}
function locationClosed(location) {
    if (location.kind === 'step') {
        return location.step.status === 'closed' || location.turn.status === 'closed';
    }
    return location.kind === 'turn' && location.turn.status === 'closed';
}
function projectWorkflow(context, location) {
    const state = context.state;
    if (state === undefined)
        throw new Error("workflow projection requires initialized state");
    const interrupted = state.stopReason === undefined
        && locationClosed(location);
    const phases = new Map();
    for (const member of state.members) {
        const phase = member.phase === undefined ? null : member.phase;
        const key = workflowPhaseKey(phase);
        let group = phases.get(key);
        if (group === undefined) {
            group = { phase, members: [] };
            phases.set(key, group);
        }
        group.members.push({
            seq: member.seq,
            label: member.label,
            childId: member.childId,
            status: member.outcome === undefined
                ? interrupted ? 'interrupted' : 'running'
                : statusFromOutcome(member.outcome),
        });
    }
    const projectedPhases = [...phases].map(([key, phase]) => ({
        key,
        phase: phase.phase,
        members: phase.members,
    }));
    return {
        name: state.name,
        status: state.stopReason === undefined
            ? interrupted ? 'interrupted' : 'running'
            : statusFromStopReason(state.stopReason),
        phases: projectedPhases,
    };
}
function updateAgentStart(state, data) {
    const member = {
        seq: data.seq,
        label: data.label,
        ...data.phase === undefined ? {} : { phase: data.phase },
        childId: data.childId,
    };
    return { ...state, members: [...state.members, member] };
}
function updateAgentEnd(state, data) {
    return {
        ...state,
        members: state.members.map(member => member.seq === data.seq
            ? { ...member, outcome: data.outcome }
            : member),
    };
}
/** Durable workflow event family folded into one keyed Chat node. */
exports.workflowRunDefinition = {
    kind: 'workflow-run',
    target: 'chat',
    match: (event) => {
        if (event.type === 'tool-workflow/run-start')
            return { id: String(event.data.runId), role: 'start' };
        if (event.type === 'tool-workflow/agent-start'
            || event.type === 'tool-workflow/agent-end'
            || event.type === 'tool-workflow/run-end') {
            return { id: String(event.data.runId), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'tool-workflow/run-start') {
            throw new Error('workflow-run start requires tool-workflow/run-start');
        }
        return { name: match.event.data.name, members: [] };
    },
    update: (context, match) => {
        if (match.event.type === 'tool-workflow/agent-start') {
            return updateAgentStart(context.state, match.event.data);
        }
        if (match.event.type === 'tool-workflow/agent-end') {
            return updateAgentEnd(context.state, match.event.data);
        }
        if (match.event.type === 'tool-workflow/run-end') {
            return { ...context.state, stopReason: match.event.data.stopReason };
        }
        return context.state;
    },
    buildViewNode: (context) => {
        if (context.start === undefined)
            return null;
        const data = projectWorkflow(context, context.start.location);
        return {
            key: context.key,
            kind: 'workflow-run',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data,
        };
    },
};

}
};
const __dependencies = {"src/modules/workflow-run/index.js":{"./WorkflowRunPanel":"src/modules/workflow-run/WorkflowRunPanel.js","./locales":"src/modules/workflow-run/locales.js","./workflow-definition":"src/modules/workflow-run/workflow-definition.js"},"src/modules/workflow-run/WorkflowRunPanel.js":{"./WorkflowRunPanel.styles":"src/modules/workflow-run/WorkflowRunPanel.styles.js"},"src/modules/workflow-run/WorkflowRunPanel.styles.js":{"./WorkflowRunPanel.css":"src/modules/workflow-run/WorkflowRunPanel.css","../views-types":"src/modules/views-types.js"},"src/modules/workflow-run/WorkflowRunPanel.css":{},"src/modules/views-types.js":{},"src/modules/workflow-run/locales.js":{},"src/modules/workflow-run/workflow-definition.js":{}};
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
return __load("src/modules/workflow-run/index.js");
}
});
