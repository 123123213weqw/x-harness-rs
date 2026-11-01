// Generated from src/modules/swarm/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-swarm",
factory: (__externalRequire) => {
const __units = {
"src/modules/swarm/index.js": function(module, exports, require) {
// source: src/modules/swarm/index.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.openSwarm = void 0;
exports.SwarmCenter = SwarmCenter;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/// <reference path="../shared/assets.d.ts" />
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const types_1 = require("../client-connection/contracts/core/session/types");
const client_1 = require("./client");
const Swarm_css_1 = __importDefault(require("./Swarm.css"));
const TaskBoard_1 = require("./TaskBoard");
const AgentMonitor_1 = require("./AgentMonitor");
const TeamInspector_1 = require("./TeamInspector");
const openSwarm = () => { window.dispatchEvent(new Event('xharness:swarm:open')); };
exports.openSwarm = openSwarm;
const errorMessage = (error) => error instanceof Error ? error.message : 'Swarm request failed';
function SwarmCenter({ client, sessions, showConversation }) {
    const catalog = (0, react_1.useSyncExternalStore)(sessions.list.subscribe, sessions.list.getSnapshot);
    const owner = catalog.current, record = owner ? catalog.byId[owner] : undefined;
    const eligible = !!record && !record.parentId && record.origin !== 'subagent';
    const [railOpen, setRailOpen] = (0, react_1.useState)(false);
    const [panel, setPanel] = (0, react_1.useState)('team');
    const [teams, setTeams] = (0, react_1.useState)([]), [inspection, setInspection] = (0, react_1.useState)(null), [busy, setBusy] = (0, react_1.useState)(false), [loading, setLoading] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(''), [objective, setObjective] = (0, react_1.useState)(''), [creating, setCreating] = (0, react_1.useState)(false), [child, setChild] = (0, react_1.useState)('');
    const [selectedWorker, setSelectedWorker] = (0, react_1.useState)('');
    const scope = (0, react_1.useRef)(0), read = (0, react_1.useRef)(0), selected = (0, react_1.useRef)(''), controller = (0, react_1.useRef)(null);
    const [live, setLive] = (0, react_1.useState)(null), [observedAt, setObservedAt] = (0, react_1.useState)(0), [monitorError, setMonitorError] = (0, react_1.useState)('');
    const background = (0, react_1.useRef)(null), guarded = (0, react_1.useRef)(false), foregroundBusy = (0, react_1.useRef)(false);
    foregroundBusy.current = busy || loading;
    const guardChanged = (0, react_1.useCallback)((value) => { guarded.current = value; }, []);
    const team = inspection && inspection.swarm.ownerSessionId === owner ? inspection.swarm : null;
    const refresh = (0, react_1.useCallback)(async (preferred) => {
        if (!owner || !eligible)
            return;
        background.current?.abort();
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        const epoch = scope.current, request = ++read.current;
        setLoading(true);
        try {
            const list = await client.list(owner, abort.signal), id = list.find(t => t.id === (preferred ?? selected.current))?.id ?? list[0]?.id;
            const detail = id ? await client.inspect(owner, id, abort.signal) : null;
            if (scope.current !== epoch || read.current !== request || abort.signal.aborted)
                return;
            selected.current = id ?? '';
            setTeams(list);
            setInspection(detail);
            setLive(detail);
            setObservedAt(Date.now());
            setMonitorError('');
            setError('');
        }
        catch (e) {
            if (scope.current === epoch && read.current === request && !abort.signal.aborted)
                setError(errorMessage(e));
        }
        finally {
            if (scope.current === epoch && read.current === request && !abort.signal.aborted)
                setLoading(false);
        }
    }, [client, eligible, owner]);
    (0, react_1.useEffect)(() => { scope.current++; selected.current = ''; guarded.current = false; setLive(null); setObservedAt(0); setMonitorError(''); setInspection(null); setTeams([]); setCreating(false); setBusy(false); setLoading(false); setError(''); setChild(''); void refresh(); return () => { scope.current++; controller.current?.abort(); }; }, [refresh]);
    const visible = !!team && !creating;
    (0, react_1.useEffect)(() => { showConversation(visible); return () => showConversation(false); }, [visible, showConversation]);
    (0, react_1.useEffect)(() => {
        const visible = () => {
            if (!document.hidden)
                void refresh();
        };
        document.addEventListener('visibilitychange', visible);
        window.addEventListener('focus', visible);
        return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
    }, [refresh]);
    // Foreground read-only monitoring. Never polls hidden/unmounted Swarm views,
    // probes a provider, submits prompts, or clears an uncertain-write guard.
    (0, react_1.useEffect)(() => {
        if (!owner || !eligible || !team)
            return;
        const id = team.id, epoch = scope.current;
        let disposed = false, timer;
        const poll = async () => {
            let delay = 5000;
            if (!document.hidden && !foregroundBusy.current) {
                const abort = new AbortController();
                background.current = abort;
                try {
                    const detail = await client.inspect(owner, id, abort.signal);
                    if (disposed || abort.signal.aborted || scope.current !== epoch || selected.current !== id)
                        return;
                    setLive(detail);
                    setObservedAt(Date.now());
                    setMonitorError('');
                    if (!guarded.current && !foregroundBusy.current)
                        setInspection(detail);
                    if (detail.workers.some(w => w.activity === 'running' || w.activity === 'queued') || Object.values(detail.work).some(w => w.assignment))
                        delay = 1500;
                }
                catch (e) {
                    if (!disposed && !abort.signal.aborted && scope.current === epoch)
                        setMonitorError(errorMessage(e));
                }
            }
            if (!disposed)
                timer = setTimeout(() => void poll(), delay);
        };
        timer = setTimeout(() => void poll(), 1500);
        return () => { disposed = true; if (timer !== undefined)
            clearTimeout(timer); background.current?.abort(); };
    }, [client, owner, eligible, team?.id]);
    (0, react_1.useEffect)(() => { setSelectedWorker(''); }, [owner, team?.id]);
    const memberIds = team ? Object.keys(team.members).join('\0') : '';
    (0, react_1.useEffect)(() => {
        if (!owner || !memberIds)
            return;
        let alive = true;
        void sessions.refreshSubagents(owner).catch((e) => { if (alive)
            setMonitorError(errorMessage(e)); });
        return () => { alive = false; };
    }, [owner, memberIds, sessions]);
    async function mutate(operation) {
        if (busy || loading || error)
            return;
        controller.current?.abort();
        read.current++;
        const epoch = scope.current;
        setBusy(true);
        setError('');
        try {
            const id = await operation();
            if (scope.current !== epoch)
                return;
            setCreating(false);
            setChild('');
            await refresh(typeof id === 'string' ? id : team?.id);
        }
        catch (e) {
            if (scope.current === epoch)
                setError(`${errorMessage(e)}. Refresh teams before retrying; the operation may already be saved.`);
        }
        finally {
            if (scope.current === epoch)
                setBusy(false);
        }
    }
    const current = live && live.swarm.id === team?.id && live.swarm.ownerSessionId === owner ? live : inspection;
    const members = current ? Object.values(current.swarm.members) : [], observations = current && current.swarm.id === team?.id ? current.workers : [];
    function workerName(id) { const entry = owner ? catalog.subagentsByParent[owner]?.entries.find(e => e.id === id) : undefined; return entry?.kind === 'child' ? entry.label ?? id : id; }
    const available = owner ? catalog.subagentsByParent[owner]?.entries.filter(e => e.kind === 'child' && !members.some(m => m.sessionId === e.id)) ?? [] : [];
    function workerAddress(id) {
        if (!owner)
            return;
        const entry = catalog.subagentsByParent[owner]?.entries.find(row => row.id === id);
        // A discovered child need not have been opened before; use its exact catalog address.
        if (entry?.kind === 'child')
            return { parentSessionId: owner, childSessionId: entry.id, mode: entry.mode };
        return undefined;
    }
    function openWorker(id) {
        const address = workerAddress(id);
        if (!address) {
            setError('Worker address unavailable. Refresh workers first.');
            return;
        }
        sessions.openSubagent(address);
        window.dispatchEvent(new Event('xharness:swarm:close'));
    }
    async function refreshWorkers() {
        if (!owner)
            return;
        const epoch = scope.current;
        try {
            await sessions.refreshSubagents(owner);
            if (scope.current === epoch)
                await refresh();
        }
        catch (e) {
            if (scope.current === epoch)
                setError(errorMessage(e));
        }
    }
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhswarm-header", children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-heading", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconAgentPresetOutline16, { size: 20 }), (0, jsx_runtime_1.jsx)("h1", { title: team?.objective, children: team?.objective.split('\n')[0] ?? 'Swarm' })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-actions", children: [team && (0, jsx_runtime_1.jsx)(AgentMonitor_1.AgentMonitor, { workerCount: members.length, workers: observations, showTeam: () => { setPanel('team'); setRailOpen(true); }, observedAt: observedAt, error: monitorError }), team && (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": team.status === 'paused' ? 'Resume team' : 'Pause team', disabled: busy || loading || !!error || team.status === 'closed', title: team.status === 'paused' ? 'Resume team dispatch' : 'Pause new assignments; already admitted work continues', onClick: () => void mutate(() => client.status(team, team.status === 'active' ? 'paused' : 'active')), children: team.status === 'paused' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, {}) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPauseOutline16, {}) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": "Refresh team", disabled: busy || loading, onClick: () => void refresh(), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconRefreshOutline16, {}) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": "Back to chat", onClick: () => window.dispatchEvent(new Event('xharness:swarm:close')), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, {}) })] })] }), error && (0, jsx_runtime_1.jsx)("div", { className: "xhswarm-notice", role: "alert", children: error }), (!team || creating) && (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-setup", "aria-label": "Swarm setup", children: [(0, jsx_runtime_1.jsx)("h2", { children: creating ? 'New team' : 'Keep your team together' }), !eligible ? (0, jsx_runtime_1.jsx)("p", { children: "Select a root conversation in the sidebar, then open /swarm." }) : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("p", { children: "Create a persistent team record for this conversation. Existing chats and their execution stay unchanged." }), (0, jsx_runtime_1.jsxs)("form", { onSubmit: event => {
                                    event.preventDefault();
                                    if (owner && objective.trim())
                                        void mutate(() => client.create(owner, objective.trim()));
                                }, children: [(0, jsx_runtime_1.jsxs)("label", { children: ["Objective", (0, jsx_runtime_1.jsx)("textarea", { value: objective, onChange: event => setObjective(event.target.value), maxLength: 32768, required: true, placeholder: "What should this team work on?" })] }), (0, jsx_runtime_1.jsx)("button", { disabled: busy || loading || !!error || !objective.trim(), type: "submit", children: busy ? 'Saving…' : 'Create team' }), creating && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setCreating(false), children: "Cancel" })] })] }), loading && (0, jsx_runtime_1.jsx)("p", { role: "status", children: "Loading teams\u2026" })] }), (0, jsx_runtime_1.jsxs)("aside", { id: "xhswarm-team", className: "xhswarm-rail", "data-open": railOpen, "aria-label": "Tasks and team", onKeyDown: event => {
                    if (event.key === 'Escape')
                        setRailOpen(false);
                }, children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-rail-heading", children: [(0, jsx_runtime_1.jsx)("h2", { children: "Workspace" }), eligible && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setCreating(true), disabled: busy, children: "New" })] }), teams.length > 1 && (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-team-picker", children: ["Saved teams", (0, jsx_runtime_1.jsx)("select", { "aria-label": "Saved teams", value: team?.id ?? '', disabled: busy || loading, onChange: event => { setCreating(false); void refresh(event.target.value); }, children: teams.map(t => (0, jsx_runtime_1.jsx)("option", { value: t.id, children: t.objective }, t.id)) })] }), team && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-panel-tabs", role: "group", "aria-label": "Workspace panel", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": panel === 'tasks', onClick: () => setPanel('tasks'), children: "Tasks" }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "aria-pressed": panel === 'team', onClick: () => setPanel('team'), children: ["Team ", (0, jsx_runtime_1.jsx)("span", { children: members.length })] })] }), (0, jsx_runtime_1.jsx)("div", { hidden: panel !== 'tasks', children: (0, jsx_runtime_1.jsx)(TaskBoard_1.TaskBoard, { client: client, team: team, workers: observations, workerName: workerName, onGuardChange: guardChanged, openWorker: openWorker, onChanged: () => refresh(team.id), disabled: busy || loading || !!error }, `${team.ownerSessionId}:${team.id}`) }), (0, jsx_runtime_1.jsxs)("div", { hidden: panel !== 'team', children: [current && (0, jsx_runtime_1.jsx)(TeamInspector_1.TeamInspector, { client: client, inspection: current, coordinatorName: record?.displayTitle ?? 'Coordinator', coordinatorRunning: !!record?.running, workerName: workerName, workerAddress: workerAddress, openWorker: openWorker, selected: panel === 'team' ? selectedWorker : '', select: setSelectedWorker, error: monitorError }, `${team.ownerSessionId}:${team.id}`), (0, jsx_runtime_1.jsxs)("details", { className: "xhswarm-link", children: [(0, jsx_runtime_1.jsx)("summary", { children: "Link an existing worker" }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => void refreshWorkers(), disabled: busy, children: "Refresh workers" }), (0, jsx_runtime_1.jsxs)("label", { children: ["Worker", (0, jsx_runtime_1.jsxs)("select", { "aria-label": "Worker to link", value: child, onChange: event => setChild(event.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: "Choose worker" }), available.map(entry => (0, jsx_runtime_1.jsx)("option", { value: entry.id, children: entry.kind === 'child' ? entry.label : entry.id }, entry.id))] })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: !child || busy || loading || !!error || team.status !== 'active', onClick: () => void mutate(() => client.attach(team, child)), children: "Link worker" })] })] })] })] })] });
}
exports.inject = ['slots', 'connection', 'sessions', 'commandUi'];
function apply(ctx) {
    const client = new client_1.SwarmClient(ctx.get('connection').rpc), sessions = ctx.get('sessions');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.xharnessSwarm = ''; style.textContent = Swarm_css_1.default; document.head.append(style); return () => style.remove(); }, 'swarm: scoped workspace styles');
    ctx.effect(() => ctx.get('commandUi').register({ name: 'swarm', description: 'Open a persistent team workspace', available: session => { const row = sessions.list.getSnapshot().byId[(0, types_1.SessionId)(session.sessionId)]; return !!row && !row.parentId && row.origin !== 'subagent'; }, ui: { kind: 'popupSelect', options: async () => [{ id: 'open', label: 'Open Swarm workspace' }], onSelect: () => (0, exports.openSwarm)() } }), 'swarm: explicit opt-in command');
    ctx.slots.inject('swarm.center', () => ctx.slots.register({ name: 'swarm.center', id: 'durable-swarm', inject: () => ({ client, sessions }) }, SwarmCenter));
}

},
"src/modules/client-connection/contracts/core/session/types.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/core/session/types.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_FORMAT_VERSION = void 0;
exports.SessionId = SessionId;
const zod_1 = require("zod");
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a nominal string schema).
 */
function SessionId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * The on-disk session format version, stamped into every newly-written {@link SessionHeader}
 * and enforced by every persistence backend on load. The single source of truth for the
 * version — write sites and the load-time check all read it.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided.
 *
 * The version is a single monotonic integer with no major/minor split. Whether
 * a bump is needed is decided by what the WRITER emits, never by what a newer
 * reader can accept: bump exactly when an older runtime could no longer handle
 * a new log with full semantic correctness ("parses without error" is not
 * correctness — silently skipping content that shapes reconstruction is a
 * wrong read). Only structural changes reach that bar: the header shape, the
 * {@link SessionEvent} envelope, core event semantics, or the surface
 * mechanism (the {@link SurfaceEventType} set and {@link SurfaceOp} variants).
 * Adding an ordinary event type does not bump — the per-event
 * {@link SessionEvent.ignorable} guard covers vocabulary growth instead. When
 * in doubt, bump: a near-identity upgrade step is almost free, a missed bump
 * makes older runtimes read new logs wrong silently. The full mechanism
 * (upgrade-step chain, in-memory view conversion, migrate-on-continue) is
 * recorded in the session-log-version-mechanism Agent Note
 * (`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`).
 */
exports.SESSION_FORMAT_VERSION = 0;

},
"src/modules/swarm/client.js": function(module, exports, require) {
// source: src/modules/swarm/client.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmClient = void 0;
exports.parseTeam = parseTeam;
exports.parseInspection = parseInspection;
exports.parseTaskPage = parseTaskPage;
exports.parseWorkerDetail = parseWorkerDetail;
function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function object(value) {
    if (!isObject(value))
        throw Error('Invalid Swarm response');
    return value;
}
function text(value) {
    if (typeof value !== 'string' || !value.trim())
        throw Error('Invalid Swarm text');
    return value;
}
function number(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw Error('Invalid Swarm revision/count');
    return value;
}
function list(value, parse) {
    if (!Array.isArray(value))
        throw Error('Invalid Swarm list');
    return value.map((item) => parse(item));
}
function status(value) {
    if (value === 'active' || value === 'paused' || value === 'closed')
        return value;
    throw Error('Invalid Swarm lifecycle');
}
function activity(value) {
    if (value === 'unavailable' || value === 'running' || value === 'awaiting_approval' || value === 'awaiting_answer' || value === 'needs_reconciliation' || value === 'dispatch_paused' || value === 'queued' || value === 'idle')
        return value;
    throw Error('Invalid worker activity');
}
function parseTeam(value) {
    const v = object(value), members = {};
    for (const [id, item] of Object.entries(object(v.members))) {
        const m = object(item), sessionId = text(m.sessionId);
        if (id !== sessionId || id === '__proto__' || id === 'constructor' || id === 'prototype')
            throw Error('Invalid member identity');
        members[id] = { sessionId, assignment: text(m.assignment) };
    }
    const revision = number(v.revision);
    if (!revision)
        throw Error('Invalid Swarm revision');
    return { id: text(v.id), ownerSessionId: text(v.ownerSessionId), workspace: text(v.workspace), objective: text(v.objective), status: status(v.status), revision, members, autoDispatch: v.autoDispatch === undefined ? false : boolean(v.autoDispatch) };
}
function parseInspection(value) {
    const v = object(value), swarm = parseTeam(v.swarm);
    const workers = list(v.workers, item => { const w = object(item); return { sessionId: text(w.sessionId), activity: activity(w.activity), sessionRevision: w.sessionRevision === null ? null : number(w.sessionRevision), lastTurnEnd: w.lastTurnEnd === null ? null : { kind: text(object(w.lastTurnEnd).kind) }, unresolvedToolCalls: list(w.unresolvedToolCalls, text), pendingMessages: number(w.pendingMessages) }; });
    if (new Set(workers.map(w => w.sessionId)).size !== workers.length || workers.length !== Object.keys(swarm.members).length || workers.some(w => !Object.prototype.hasOwnProperty.call(swarm.members, w.sessionId)))
        throw Error('Swarm member/observation mismatch');
    const work = {};
    const progress = { total: 0, pending: 0, assigned: 0, accepted: 0, failed: 0 };
    // Retain counts and one bounded result per worker, never task instructions or histories.
    const tasks = object(v.swarm).tasks;
    for (const [id, item] of Object.entries(tasks === undefined ? {} : object(tasks))) {
        const task = object(item), state = taskState(task.state);
        if (text(task.id) !== id)
            throw Error('Invalid task identity');
        progress.total++;
        if (state.status === 'pending') {
            progress.pending++;
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(swarm.members, state.workerSessionId))
            throw Error('Unknown task worker');
        const facts = work[state.workerSessionId] ?? { assignment: null, accepted: 0, failed: 0, result: null };
        if (state.status === 'assigned') {
            progress.assigned++;
            if (facts.assignment)
                throw Error('Worker has multiple unfinished tasks');
            facts.assignment = { taskId: id, title: text(task.title), delivered: state.delivered };
        }
        else {
            if (state.outcome === 'completed') {
                facts.accepted++;
                progress.accepted++;
            }
            else {
                facts.failed++;
                progress.failed++;
            }
            // Worker turn ordering is authoritative; task IDs are not completion timestamps.
            if (!facts.result || (state.turn !== null && (facts.result.turn === null || state.turn > facts.result.turn)))
                facts.result = { taskId: id, title: text(task.title), turn: state.turn, outcome: state.outcome, summary: state.summary.slice(0, 2000), truncated: state.summary.length > 2000 };
        }
        work[state.workerSessionId] = facts;
    }
    return { swarm, workers, work, progress };
}
function boolean(value) {
    if (typeof value !== 'boolean')
        throw Error('Invalid task flag');
    return value;
}
function taskState(value) {
    const state = object(value);
    if (state.status === 'pending')
        return { status: 'pending' };
    const workerSessionId = text(state.workerSessionId), messageId = text(state.messageId);
    if (state.status === 'assigned')
        return { status: 'assigned', workerSessionId, messageId, delivered: boolean(state.delivered) };
    if (state.status !== 'settled' || (state.outcome !== 'completed' && state.outcome !== 'failed'))
        throw Error('Invalid task state');
    const turn = state.turn === null ? null : number(state.turn);
    if ((turn !== null && turn > 4294967295) || (state.outcome === 'completed' && turn === null))
        throw Error('Completed task requires a turn');
    return { status: 'settled', workerSessionId, messageId, turn, outcome: state.outcome, summary: text(state.summary) };
}
function parseTaskPage(value) {
    const page = object(value);
    const tasks = list(page.tasks, item => {
        const row = object(item), task = object(row.task);
        const dependencies = list(task.dependencies, text), state = taskState(task.state), ready = boolean(row.ready);
        const eligibleWorkerSessionIds = task.eligibleWorkerSessionIds === undefined ? [] : list(task.eligibleWorkerSessionIds, text);
        if (eligibleWorkerSessionIds.length > 64 || new Set(eligibleWorkerSessionIds).size !== eligibleWorkerSessionIds.length)
            throw Error('Invalid eligible workers');
        const id = text(task.id);
        if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id) || (ready && state.status !== 'pending'))
            throw Error('Invalid task dependencies/readiness');
        return { task: { id, title: text(task.title), instructions: text(task.instructions), dependencies, eligibleWorkerSessionIds, state }, ready };
    });
    const hasMore = boolean(page.hasMore), nextCursor = page.nextCursor === null ? null : text(page.nextCursor), revision = number(page.revision);
    if (!revision || tasks.length > 200 || new Set(tasks.map(row => row.task.id)).size !== tasks.length || tasks.some((row, i) => i > 0 && (tasks[i - 1]?.task.id ?? '') >= row.task.id) || (hasMore ? !tasks.length || nextCursor !== tasks[tasks.length - 1]?.task.id : nextCursor !== null))
        throw Error('Invalid task page');
    return { swarmId: text(page.swarmId), revision, tasks, hasMore, nextCursor };
}
/** Decode only public tail activity and reported model metadata; never retain reasoning. */
function parseWorkerDetail(value) {
    const reply = object(value), detail = { model: null, activity: null, answer: null };
    if (reply.projections !== undefined) {
        const values = object(object(reply.projections).values);
        if (values.sessionStats !== undefined) {
            const throughput = object(values.sessionStats).activeThroughput;
            if (throughput !== undefined && throughput !== null) {
                const route = object(throughput);
                detail.model = { provider: text(route.provider), model: text(route.model) };
            }
        }
    }
    for (const item of list(reply.events, object)) {
        const event = object(item.event), kind = text(event.type), data = object(event.data);
        const time = number(event.time);
        if (kind === 'tool/call')
            detail.activity = { text: `Tool: ${text(data.name)}`, time };
        else if (kind === 'turn/start')
            detail.activity = { text: 'Turn started', time };
        else if (kind === 'turn/end')
            detail.activity = { text: `Turn ${text(object(data.reason).kind).replaceAll('_', ' ')}`, time };
        else if (kind === 'assistant/message') {
            let answer = '', truncated = false;
            for (const part of list(object(data.message).content, object)) {
                if (part.type !== 'text')
                    continue;
                if (typeof part.text !== 'string')
                    throw Error('Invalid public answer');
                const remaining = 2000 - answer.length;
                truncated || (truncated = part.text.length > remaining);
                answer += part.text.slice(0, remaining);
            }
            if (answer) {
                detail.answer = { text: answer, truncated };
                detail.activity = { text: 'Public response recorded', time };
            }
        }
    }
    return detail;
}
class SwarmClient {
    constructor(rpc) {
        this.rpc = rpc;
    }
    async call(ownerSessionId, command, signal) {
        const result = await this.rpc.call('/api', 'swarm/manage', { ownerSessionId, command }, signal);
        if (!result.ok)
            throw Error(result.error.message);
        return result.value;
    }
    async list(owner, signal) {
        const teams = list(object(await this.call(owner, { action: 'list' }, signal)).swarms, parseTeam);
        if (teams.some(t => t.ownerSessionId !== owner) || new Set(teams.map(t => t.id)).size !== teams.length)
            throw Error('Swarm owner/identity mismatch');
        return teams;
    }
    async inspect(owner, id, signal) {
        const result = parseInspection(await this.call(owner, { action: 'inspect', swarmId: id }, signal));
        if (result.swarm.id !== id || result.swarm.ownerSessionId !== owner)
            throw Error('Swarm target mismatch');
        return result;
    }
    async workerDetail(address, signal) {
        const response = await this.rpc.call('/api', 'subagent.history', { ...address, maxMessages: 1 }, signal);
        if (!response.ok)
            throw Error(response.error.message);
        return parseWorkerDetail(response.value);
    }
    async create(owner, objective) { return text(object(await this.call(owner, { action: 'create', objective })).swarmId); }
    async status(team, next) { await this.call(team.ownerSessionId, { action: 'set_status', swarmId: team.id, expectedRevision: team.revision, status: next }); }
    async taskCall(owner, command, signal) {
        const result = await this.rpc.call('/api', 'swarm/tasks', { ownerSessionId: owner, command }, signal);
        if (!result.ok)
            throw Error(result.error.message);
        return result.value;
    }
    async tasks(team, includeSettled, afterTaskId, signal) {
        const command = afterTaskId === null
            ? { action: 'list', swarmId: team.id, includeSettled, limit: 50 }
            : { action: 'list', swarmId: team.id, includeSettled, limit: 50, afterTaskId };
        const page = parseTaskPage(await this.taskCall(team.ownerSessionId, command, signal));
        if (page.revision < team.revision || page.swarmId !== team.id || (afterTaskId !== null && page.tasks.some(row => row.task.id <= afterTaskId)))
            throw Error('Task board target/cursor mismatch');
        if (!includeSettled && page.tasks.some(row => row.task.state.status === 'settled'))
            throw Error('Unexpected settled task');
        return page;
    }
    async dispatch(team, revision, enabled) {
        await this.call(team.ownerSessionId, { action: 'set_dispatch', swarmId: team.id, expectedRevision: revision, enabled });
    }
    async addTask(team, revision, title, instructions, dependencies, eligibleWorkerSessionIds = []) {
        await this.taskCall(team.ownerSessionId, { action: 'add', swarmId: team.id, expectedRevision: revision, title, instructions, dependencies, eligibleWorkerSessionIds });
    }
    async claimTask(team, revision, taskId, workerSessionId) {
        await this.taskCall(team.ownerSessionId, { action: 'claim', swarmId: team.id, expectedRevision: revision, taskId, workerSessionId });
    }
    async attach(team, child) { await this.call(team.ownerSessionId, { action: 'attach_member', swarmId: team.id, expectedRevision: team.revision, childSessionId: child }); }
}
exports.SwarmClient = SwarmClient;

},
"src/modules/swarm/Swarm.css": function(module, exports, require) {
// source: src/modules/swarm/Swarm.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhfeature-shell[data-swarm-active=true]{display:grid;grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:auto minmax(0,1fr);position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary-bluish)}\n.xhswarm-seat{display:contents}.xhswarm-seat[hidden]{display:none}\n.xhswarm-header{grid-column:1;grid-row:1;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:30px 44px 24px;min-width:0}.xhswarm-heading{display:flex;gap:16px;align-items:flex-start;min-width:0}.xhswarm-heading>svg{flex:none;margin-top:3px}.xhswarm-heading>div{min-width:0}.xhswarm-heading h1{font-size:27px;font-weight:600;line-height:1.3;margin:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}.xhswarm-heading span{display:block;margin-top:8px;font-size:14px;color:var(--dsw-alias-label-secondary)}\n.xhswarm-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.xhswarm-status{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.xhswarm-header button,.xhswarm-rail button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;display:inline-flex;gap:8px;align-items:center;border-radius:8px;padding:8px;font-size:13px}.xhswarm-header button:hover,.xhswarm-rail button:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhswarm-header button:disabled,.xhswarm-rail button:disabled,.xhswarm-setup button:disabled{opacity:.45;cursor:default}.xhswarm-header button:focus-visible,.xhswarm-rail button:focus-visible,.xhswarm-setup :focus-visible{outline:2px solid currentColor;outline-offset:3px}\n.xhfeature-shell[data-swarm-active=true]>.xhwork-conversation{grid-column:1;grid-row:2;min-width:0;min-height:0}.xhswarm-rail{grid-column:2;grid-row:1/3;border-left:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:auto;padding:34px 30px}.xhswarm-rail-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.xhswarm-rail h2{font-size:16px;line-height:1.4;font-weight:600;margin:0}.xhswarm-person{display:flex!important;align-items:flex-start!important;gap:16px!important;text-align:left;width:100%;margin:0 0 22px;padding:8px 0!important}.xhswarm-person>svg{flex:none}.xhswarm-person>div{min-width:0}.xhswarm-person strong{font-size:16px;font-weight:500;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhswarm-person span,.xhswarm-person small{font-size:13px;line-height:1.55;display:block;color:var(--dsw-alias-label-secondary);margin-top:4px;overflow-wrap:anywhere}.xhswarm-person small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.xhswarm-results{border-top:1px solid var(--dsw-alias-border-l1);margin-top:24px;padding-top:28px}.xhswarm-results button{display:block;width:100%;text-align:left;margin-top:18px;padding:0}.xhswarm-results strong,.xhswarm-results span{display:block;font-weight:400;font-size:13px;line-height:1.6}.xhswarm-results span,.xhswarm-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}.xhswarm-setup{grid-column:1;grid-row:2;padding:clamp(25px,6vw,90px) 36px;max-width:650px;overflow:auto;min-width:0}.xhswarm-setup h2{font-size:24px;font-weight:500;margin:0 0 12px}.xhswarm-setup p{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary)}.xhswarm-setup label,.xhswarm-link label,.xhswarm-team-picker{display:block;font-size:13px;line-height:1.6}.xhswarm-setup textarea{display:block;box-sizing:border-box;resize:vertical;width:100%;min-height:100px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;margin:8px 0 20px}.xhswarm-setup button{font:inherit;padding:10px 18px;border-radius:10px;background:var(--dsw-alias-label-primary-bluish);color:var(--dsw-alias-bg-base);border:0;cursor:pointer;margin-right:10px}.xhswarm-link{font-size:13px;margin:20px 0}.xhswarm-link summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.xhswarm-rail select{display:block;width:100%;min-width:0;box-sizing:border-box;margin:8px 0 14px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px}.xhswarm-notice{position:absolute;top:106px;left:30px;right:345px;z-index:2;background:var(--dsw-alias-bg-base);padding:12px;font-size:13px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-wrap:anywhere}\n@media(max-width:1100px){.xhswarm-header{flex-wrap:wrap;padding:22px}.xhswarm-heading h1{font-size:22px}.xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr) 225px}.xhswarm-rail{padding:25px 16px}.xhswarm-notice{right:240px}}\n@media(max-width:700px){.xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.xhswarm-rail{display:none}.xhswarm-header{padding:18px;gap:12px}.xhswarm-heading h1{font-size:20px}.xhswarm-setup{padding:24px}.xhswarm-notice{right:18px;left:18px}.xhswarm-actions{gap:4px}}\n\n.xhswarm-header .xhswarm-team-toggle{display:none}@media(max-width:700px){.xhswarm-header .xhswarm-team-toggle{display:inline-flex}.xhswarm-rail[data-open=true]{display:block;position:absolute;grid-column:1;grid-row:2;right:0;top:0;bottom:0;width:min(270px,85%);box-sizing:border-box;background:var(--dsw-alias-bg-base);z-index:3}}\n\n/* Respond to the center pane as well as the window: the browser/files pane may be docked. */\n[data-swarm-container=true]{container-type:inline-size;container-name:swarm-pane}\n@container swarm-pane (max-width:900px){\n .xhswarm-header{flex-wrap:wrap;padding:22px;gap:12px}\n .xhswarm-heading h1{font-size:22px}\n}\n@container swarm-pane (max-width:700px){\n .xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr)}\n .xhswarm-rail{display:none}\n .xhswarm-header .xhswarm-team-toggle{display:inline-flex}\n .xhswarm-rail[data-open=true]{display:block;position:absolute;grid-column:1;grid-row:2;right:0;top:0;bottom:0;width:min(270px,85%);box-sizing:border-box;background:var(--dsw-alias-bg-base);z-index:3}\n .xhswarm-notice{right:18px;left:18px}\n}\n\n/* The task board shares the selected team rail; the native chat remains mounted. */\n.xhswarm-panel-tabs{display:flex;gap:6px;margin:0 0 20px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:10px}\n.xhswarm-panel-tabs button{font-size:15px;padding:7px 10px}.xhswarm-panel-tabs button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.xhswarm-panel-tabs span{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:4px}\n.xhswarm-board-toolbar{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:16px}.xhswarm-board-filters{display:flex;gap:2px}.xhswarm-board-filters button{font-size:12px;padding:6px}.xhswarm-board-filters button[aria-pressed=true]{font-weight:600;background:var(--dsw-alias-interactive-bg-hover)}\n.xhswarm-task-list{list-style:none;margin:0;padding:0}.xhswarm-task-list>li{border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 0}.xhswarm-task-row{width:100%;align-items:flex-start!important;text-align:left;padding:12px 0!important;gap:10px!important}.xhswarm-task-row>span:last-child{min-width:0}.xhswarm-task-row strong{font-size:14px;font-weight:500;line-height:1.5;display:block;overflow-wrap:anywhere}.xhswarm-task-row small{font-size:12px;color:var(--dsw-alias-label-secondary);display:block;line-height:1.6;margin-top:4px}.xhswarm-task-mark{flex:none;width:17px;font-size:17px;line-height:21px}\n.xhswarm-task-detail{padding:0 0 14px 27px;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.xhswarm-task-instructions{white-space:pre-wrap;margin:0 0 12px;max-height:230px;overflow:auto}.xhswarm-task-detail h3{font-size:13px;margin:18px 0 8px;font-weight:600}.xhswarm-task-detail small{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}.xhswarm-task-detail>button{padding-left:0}.xhswarm-task-dependencies{color:var(--dsw-alias-label-secondary);margin:12px 0}.xhswarm-task-dependencies ul{margin:4px 0;padding-left:18px}\n.xhswarm-task-detail label,.xhswarm-task-form label{display:block;font-size:13px;margin:14px 0 6px}.xhswarm-task-form input:not([type=checkbox]),.xhswarm-task-form textarea{display:block;width:100%;box-sizing:border-box;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;margin-top:8px}.xhswarm-task-form textarea{min-height:100px;resize:vertical}.xhswarm-task-form details{font-size:13px;margin:16px 0}.xhswarm-task-form summary{cursor:pointer}.xhswarm-task-checkbox{display:flex!important;gap:8px;align-items:flex-start;overflow-wrap:anywhere}.xhswarm-task-checkbox input{flex:none;margin-top:4px}.xhswarm-form-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}\n.xhswarm-rail .xhswarm-primary{background:var(--dsw-alias-label-primary-bluish);color:var(--dsw-alias-bg-base);margin-top:10px;padding:8px 12px}.xhswarm-rail .xhswarm-primary:hover{opacity:.85}.xhswarm-add-task{margin-top:18px}.xhswarm-board-footnote{font-size:11px;color:var(--dsw-alias-label-secondary);margin:24px 0 0;line-height:1.6}.xhswarm-board-empty{margin:28px 0;font-size:14px}.xhswarm-board-empty strong{font-weight:500}.xhswarm-board-empty p{font-size:13px;color:var(--dsw-alias-label-secondary)}.xhswarm-board-error{font-size:13px;line-height:1.6;border-left:2px solid currentColor;padding-left:10px;overflow-wrap:anywhere}.xhswarm-board :focus-visible{outline:2px solid currentColor;outline-offset:3px}\n\n.xhswarm-board>.xhswarm-task-checkbox{font-size:12px;line-height:1.6;margin:0 0 16px}\n\n/* One compact header; the right-hand inspector owns worker details. */\n.xhswarm-header{flex-wrap:nowrap;align-items:center;padding:10px 16px;gap:12px;min-height:48px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhswarm-heading{flex:1;align-items:center;gap:8px;min-width:0}.xhswarm-heading>svg{margin:0}.xhswarm-heading h1{display:block;min-width:0;margin:0;font-size:15px;font-weight:500;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.xhswarm-actions{flex:none;flex-wrap:nowrap;gap:4px}.xhswarm-header button{min-height:30px;padding:6px;border-radius:7px}.xhswarm-header .xhswarm-team-summary{display:inline-flex;gap:8px;font-size:12px;white-space:nowrap;padding:6px 8px}.xhswarm-summary-status{color:var(--dsw-alias-label-secondary)}.xhswarm-summary-attention{font-size:11px;font-weight:600}.xhswarm-notice{top:52px}\n@media(max-width:700px){.xhswarm-header{padding:8px 12px;gap:6px}.xhswarm-heading{gap:6px}.xhswarm-heading h1{font-size:14px}.xhswarm-summary-status{display:none}}\n@container swarm-pane (max-width:700px){.xhswarm-header{padding:8px 12px;gap:6px}.xhswarm-heading{gap:6px}.xhswarm-heading h1{font-size:14px}.xhswarm-summary-status{display:none}}\n\n/* Read-only team inspector. Expanding a worker keeps the coordinator chat mounted. */\n.xhswarm-inspector{font-size:13px;line-height:1.55}.xhswarm-inspector h3{font-size:13px;font-weight:600;margin:0 0 10px}.xhswarm-team-overview{padding-bottom:20px;margin-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhswarm-inspector-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;margin:0 0 12px}.xhswarm-inspector dl{margin:12px 0}.xhswarm-inspector dl>div{margin:10px 0}.xhswarm-inspector dt{font-size:11px;color:var(--dsw-alias-label-secondary)}.xhswarm-inspector dd{margin:2px 0 0;overflow-wrap:anywhere}.xhswarm-progress-label{font-size:12px;display:block}.xhswarm-progress-label progress{display:block;width:100%;height:5px;margin-top:8px;accent-color:var(--dsw-alias-label-primary-bluish)}.xhswarm-inspector-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin:8px 0 0}.xhswarm-worker{border-bottom:1px solid var(--dsw-alias-border-l1)}.xhswarm-rail .xhswarm-worker-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;width:100%;text-align:left;padding:13px 8px;gap:4px 8px}.xhswarm-worker-toggle strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhswarm-worker-toggle>span{font-size:11px}.xhswarm-worker-toggle small{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhswarm-worker-toggle[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.xhswarm-worker-detail{padding:12px 8px 18px;overflow-wrap:anywhere}.xhswarm-worker-detail h4{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:16px 0 6px}.xhswarm-worker-detail h4:first-child{margin-top:0}.xhswarm-worker-detail p{margin-top:0}.xhswarm-worker-detail>strong{font-size:12px;font-weight:500}.xhswarm-worker-detail small{font-size:11px;color:var(--dsw-alias-label-secondary)}.xhswarm-detail-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.xhswarm-inspector-warning{font-size:12px;border-left:2px solid currentColor;padding-left:8px}\n";

},
"src/modules/swarm/TaskBoard.js": function(module, exports, require) {
// source: src/modules/swarm/TaskBoard.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskBoard = TaskBoard;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const message = (error) => error instanceof Error ? error.message : 'Task board request failed';
function label(row, team) {
    const state = row.task.state;
    if (state.status === 'settled')
        return state.outcome === 'completed' ? 'Completed' : 'Not accepted';
    if (state.status === 'assigned')
        return state.delivered ? 'Inbox received' : 'Delivery pending';
    return row.ready ? 'Ready' : team.status === 'closed' ? 'Closed' : team.status === 'paused' ? 'Paused' : 'Waiting on dependencies';
}
/** Presentation and explicit user actions only. No task picking or model requests on view. */
function TaskBoard({ client, team, workers, workerName, openWorker, onChanged, disabled, onGuardChange }) {
    const [rows, setRows] = (0, react_1.useState)([]), [history, setHistory] = (0, react_1.useState)(false);
    const [revision, setRevision] = (0, react_1.useState)(0), [cursor, setCursor] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(false), [busy, setBusy] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)('');
    const [selected, setSelected] = (0, react_1.useState)(''), [worker, setWorker] = (0, react_1.useState)(''), [adding, setAdding] = (0, react_1.useState)(false);
    const [title, setTitle] = (0, react_1.useState)(''), [instructions, setInstructions] = (0, react_1.useState)(''), [dependencies, setDependencies] = (0, react_1.useState)([]);
    const [eligible, setEligible] = (0, react_1.useState)([]);
    const request = (0, react_1.useRef)(0), controller = (0, react_1.useRef)(null), alive = (0, react_1.useRef)(true), lock = (0, react_1.useRef)(false);
    const read = (0, react_1.useCallback)(async (after = null) => {
        controller.current?.abort();
        const abort = new AbortController(), id = ++request.current;
        controller.current = abort;
        setLoading(true);
        try {
            const page = await client.tasks(team, history, after, abort.signal);
            if (!alive.current || abort.signal.aborted || request.current !== id)
                return;
            // A changed revision invalidates a paginated view; reload rather than mix snapshots.
            if (after !== null && page.revision !== revision) {
                setRows([]);
                setCursor(null);
                setError('The board changed. Refresh tasks to load a consistent view.');
                return;
            }
            setRows(previous => after === null ? page.tasks : [...previous, ...page.tasks]);
            setRevision(page.revision);
            setCursor(page.nextCursor);
            setError('');
            if (page.revision !== team.revision)
                await onChanged();
        }
        catch (error) {
            if (alive.current && !abort.signal.aborted && request.current === id)
                setError(message(error));
        }
        finally {
            if (alive.current && !abort.signal.aborted && request.current === id)
                setLoading(false);
        }
    }, [client, team, history, revision, onChanged]);
    // Reset the displayed scope before a new history read; component identity is the team/owner.
    const readRef = (0, react_1.useRef)(read);
    readRef.current = read;
    (0, react_1.useEffect)(() => {
        alive.current = true;
        return () => { alive.current = false; request.current++; controller.current?.abort(); };
    }, []);
    (0, react_1.useEffect)(() => {
        setRows([]);
        setCursor(null);
        setWorker('');
        void readRef.current();
        return () => { request.current++; controller.current?.abort(); };
    }, [team.revision, history]);
    async function mutate(action, added = false) {
        if (lock.current || loading || disabled || error)
            return;
        lock.current = true;
        setBusy(true);
        controller.current?.abort();
        request.current++;
        try {
            await action();
            if (!alive.current)
                return;
            if (added) {
                setAdding(false);
                setTitle('');
                setInstructions('');
                setDependencies([]);
                setEligible([]);
            }
            setWorker('');
            await readRef.current();
        }
        catch (error) {
            if (alive.current)
                setError(`${message(error)}. Refresh tasks before retrying; the change may already be saved.`);
        }
        finally {
            lock.current = false;
            if (alive.current)
                setBusy(false);
        }
    }
    (0, react_1.useEffect)(() => { onGuardChange?.(busy || loading || !!error || adding); return () => onGuardChange?.(false); }, [onGuardChange, busy, loading, error, adding]);
    const current = rows.find(row => row.task.id === selected);
    const available = workers.filter(w => w.activity === 'idle' && !rows.some(row => row.task.state.status === 'assigned' && row.task.state.workerSessionId === w.sessionId));
    const blocked = busy || loading || disabled || !!error || revision === 0;
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-board", "aria-label": "Task board", "aria-busy": loading, children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-board-toolbar", children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-board-filters", role: "group", "aria-label": "Task view", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": !history, disabled: busy, onClick: () => setHistory(false), children: "Active" }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": history, disabled: busy, onClick: () => setHistory(true), children: "All tasks" })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": "Refresh tasks", disabled: busy || loading, onClick: () => void read(), children: "Refresh" })] }), (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-task-checkbox", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: team.autoDispatch, disabled: blocked || team.status === 'closed' || (team.status !== 'active' && !team.autoDispatch), onChange: event => { const enabled = event.target.checked; void mutate(() => client.dispatch(team, revision, enabled)); } }), "Auto-dispatch"] }), error && (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-board-error", role: "alert", children: error }), loading && (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", role: "status", children: "Loading tasks\u2026" }), !loading && !error && !rows.length && (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-board-empty", children: [(0, jsx_runtime_1.jsx)("strong", { children: history ? 'No recorded tasks' : 'No active tasks' }), (0, jsx_runtime_1.jsx)("p", { children: history ? 'Completed work stays here.' : 'Add work when the team is ready.' })] }), (0, jsx_runtime_1.jsx)("ul", { className: "xhswarm-task-list", children: rows.map(row => (0, jsx_runtime_1.jsxs)("li", { children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhswarm-task-row", "aria-expanded": row.task.id === selected, onClick: () => { setSelected(selected === row.task.id ? '' : row.task.id); setWorker(''); }, children: [(0, jsx_runtime_1.jsx)("span", { className: "xhswarm-task-mark", "aria-hidden": "true", children: row.task.state.status === 'settled' ? row.task.state.outcome === 'completed' ? '✓' : '!' : row.task.state.status === 'assigned' ? '→' : '○' }), (0, jsx_runtime_1.jsxs)("span", { children: [(0, jsx_runtime_1.jsx)("strong", { children: row.task.title }), (0, jsx_runtime_1.jsxs)("small", { children: [label(row, team), row.task.state.status !== 'pending' ? ` · ${workerName(row.task.state.workerSessionId)}` : ''] })] })] }), current?.task.id === row.task.id && (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-task-detail", children: [(0, jsx_runtime_1.jsx)("p", { className: "xhswarm-task-instructions", children: row.task.instructions }), row.task.eligibleWorkerSessionIds.length > 0 && (0, jsx_runtime_1.jsxs)("small", { children: ["Eligible workers: ", row.task.eligibleWorkerSessionIds.map(workerName).join(', ')] }), row.task.dependencies.length > 0 && (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-task-dependencies", children: [(0, jsx_runtime_1.jsx)("span", { children: "Depends on" }), (0, jsx_runtime_1.jsx)("ul", { children: row.task.dependencies.map(id => (0, jsx_runtime_1.jsx)("li", { children: rows.find(item => item.task.id === id)?.task.title ?? id }, id)) })] }), row.task.state.status === 'settled' && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h3", { children: "Recorded result" }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-task-instructions", children: row.task.state.summary }), (0, jsx_runtime_1.jsx)("small", { children: row.task.state.turn === null ? 'Failed before a turn started' : `Worker turn ${row.task.state.turn}` })] }), row.task.state.status !== 'pending' && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => { if (row.task.state.status !== 'pending')
                                        openWorker(row.task.state.workerSessionId); }, children: "Open worker conversation" }), row.task.state.status === 'pending' && row.ready && team.status === 'active' && (0, jsx_runtime_1.jsxs)("form", { onSubmit: event => { event.preventDefault(); if (available.some(w => w.sessionId === worker))
                                        void mutate(() => client.claimTask(team, revision, row.task.id, worker)); }, children: [(0, jsx_runtime_1.jsxs)("label", { children: ["Assign to", (0, jsx_runtime_1.jsxs)("select", { "aria-label": `Assign ${row.task.title} to`, value: worker, disabled: blocked, onChange: event => setWorker(event.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: "Choose an idle worker" }), available.map(w => (0, jsx_runtime_1.jsx)("option", { value: w.sessionId, children: workerName(w.sessionId) }, w.sessionId))] })] }), (0, jsx_runtime_1.jsx)("small", { children: "Assignment sends this task to the worker\u2019s inbox and can start work." }), (0, jsx_runtime_1.jsx)("button", { className: "xhswarm-primary", type: "submit", disabled: blocked || !available.some(w => w.sessionId === worker), children: "Assign task" })] })] })] }, row.task.id)) }), cursor && (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy || loading || !!error, onClick: () => void read(cursor), children: "Load more tasks" }), !adding && (0, jsx_runtime_1.jsx)("button", { className: "xhswarm-add-task", type: "button", disabled: blocked || team.status !== 'active', onClick: () => setAdding(true), children: "+ Add task" }), adding && (0, jsx_runtime_1.jsxs)("form", { className: "xhswarm-task-form", onSubmit: event => { event.preventDefault(); if (title.trim() && instructions.trim())
                    void mutate(() => client.addTask(team, revision, title.trim(), instructions.trim(), dependencies, eligible), true); }, children: [(0, jsx_runtime_1.jsxs)("label", { children: ["Title", (0, jsx_runtime_1.jsx)("input", { value: title, maxLength: 160, required: true, onChange: event => setTitle(event.target.value) })] }), (0, jsx_runtime_1.jsxs)("label", { children: ["Instructions", (0, jsx_runtime_1.jsx)("textarea", { value: instructions, maxLength: 32768, required: true, onChange: event => setInstructions(event.target.value) })] }), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: "Automatic routing" }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", children: "Only these workers may pick up this task automatically. Leave empty for manual assignment." }), workers.map(worker => (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-task-checkbox", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: eligible.includes(worker.sessionId), onChange: event => setEligible(event.target.checked ? [...eligible, worker.sessionId] : eligible.filter(id => id !== worker.sessionId)) }), workerName(worker.sessionId)] }, worker.sessionId))] }), (0, jsx_runtime_1.jsxs)("details", { children: [(0, jsx_runtime_1.jsx)("summary", { children: "Dependencies" }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", children: "From loaded tasks. Use All tasks to include completed work." }), rows.map(row => (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-task-checkbox", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: dependencies.includes(row.task.id), onChange: event => setDependencies(event.target.checked ? [...dependencies, row.task.id] : dependencies.filter(id => id !== row.task.id)) }), row.task.title] }, row.task.id))] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-form-actions", children: [(0, jsx_runtime_1.jsx)("button", { className: "xhswarm-primary", type: "submit", disabled: blocked || team.status !== 'active' || !title.trim() || !instructions.trim(), children: "Save task" }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: busy, onClick: () => setAdding(false), children: "Cancel task" })] })] }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-board-footnote", children: team.autoDispatch ? 'Automatic pickup for explicitly routed tasks · results need coordinator review' : 'Manual assignment · automatic pickup is off' })] });
}

},
"src/modules/swarm/AgentMonitor.js": function(module, exports, require) {
// source: src/modules/swarm/AgentMonitor.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activityLabel = void 0;
exports.AgentMonitor = AgentMonitor;
const jsx_runtime_1 = require("react/jsx-runtime");
exports.activityLabel = { running: 'Running', queued: 'Queued', idle: 'Idle', dispatch_paused: 'Stopped', unavailable: 'Unavailable', needs_reconciliation: 'Needs reconciliation', awaiting_approval: 'Needs approval', awaiting_answer: 'Needs answer' };
/** A compact entry point only; worker details live in the right-hand inspector. */
function AgentMonitor({ workerCount, workers, showTeam, observedAt, error }) {
    const running = workers.filter(worker => worker.activity === 'running').length;
    const attention = workers.filter(worker => ['awaiting_approval', 'awaiting_answer', 'needs_reconciliation', 'unavailable'].includes(worker.activity)).length;
    const status = error ? 'Status unavailable; showing last known data' : `${running} running${attention ? ` · ${attention} need attention` : ''}`;
    return (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhswarm-team-summary", "aria-label": "Show team details", "aria-controls": "xhswarm-team", title: `${workerCount} agents · ${status}${observedAt ? ` · Updated ${new Date(observedAt).toLocaleTimeString('en-GB')}` : ''}`, onClick: showTeam, children: [(0, jsx_runtime_1.jsxs)("span", { children: [workerCount, " agents"] }), (0, jsx_runtime_1.jsx)("span", { className: "xhswarm-summary-status", children: error ? 'Unavailable' : `${running} running` }), attention > 0 && (0, jsx_runtime_1.jsx)("span", { className: "xhswarm-summary-attention", "aria-label": `${attention} need attention`, children: "!" })] });
}

},
"src/modules/swarm/TeamInspector.js": function(module, exports, require) {
// source: src/modules/swarm/TeamInspector.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamInspector = TeamInspector;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const AgentMonitor_1 = require("./AgentMonitor");
function TeamInspector({ client, inspection, coordinatorName, coordinatorRunning, workerName, workerAddress, openWorker, selected, select, error }) {
    const { swarm: team, workers, work, progress } = inspection;
    const observed = workers.find(worker => worker.sessionId === selected);
    const revision = observed?.sessionRevision;
    const isMember = Object.prototype.hasOwnProperty.call(team.members, selected);
    const [detail, setDetail] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(false), [detailError, setDetailError] = (0, react_1.useState)(''), [retry, setRetry] = (0, react_1.useState)(0);
    const address = selected ? workerAddress(selected) : undefined;
    const parent = address?.parentSessionId, child = address?.childSessionId, mode = address?.mode;
    (0, react_1.useEffect)(() => {
        const abort = new AbortController();
        setDetailError('');
        setLoading(false);
        if (!selected || !Object.prototype.hasOwnProperty.call(team.members, selected) || !parent || !child || !mode || parent !== team.ownerSessionId || child !== selected) {
            if (selected)
                setDetailError('Worker address unavailable. Refresh workers to retry.');
            return;
        }
        setLoading(true);
        void client.workerDetail({ parentSessionId: parent, childSessionId: child, mode }, abort.signal).then(value => {
            if (!abort.signal.aborted)
                setDetail({ id: selected, value });
        }).catch((e) => {
            if (!abort.signal.aborted)
                setDetailError(e instanceof Error ? e.message : 'Worker details unavailable');
        }).finally(() => { if (!abort.signal.aborted)
            setLoading(false); });
        return () => abort.abort();
    }, [client, team.ownerSessionId, selected, isMember, parent, child, mode, revision, retry]);
    const current = detail?.id === selected ? detail.value : null;
    const members = Object.values(team.members).sort((a, b) => workerName(a.sessionId).localeCompare(workerName(b.sessionId), undefined, { numeric: true }));
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-inspector", "aria-label": "Team inspector", children: [(0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-team-overview", "aria-label": "Team overview", children: [(0, jsx_runtime_1.jsx)("h3", { children: "Objective" }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-inspector-text", children: team.objective }), (0, jsx_runtime_1.jsxs)("dl", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Coordinator" }), (0, jsx_runtime_1.jsxs)("dd", { children: [coordinatorName, " \u00B7 ", coordinatorRunning ? 'Running' : 'Idle'] })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Team" }), (0, jsx_runtime_1.jsxs)("dd", { children: [team.status, " \u00B7 ", members.length, " workers"] })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Dispatch" }), (0, jsx_runtime_1.jsx)("dd", { children: team.autoDispatch ? 'Automatic' : 'Manual' })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-progress-label", children: [progress.accepted, " / ", progress.total, " tasks accepted", (0, jsx_runtime_1.jsx)("progress", { "aria-label": "Accepted tasks", value: progress.accepted, max: Math.max(1, progress.total) })] }), (0, jsx_runtime_1.jsxs)("p", { className: "xhswarm-inspector-meta", children: [progress.pending, " pending \u00B7 ", progress.assigned, " assigned \u00B7 ", progress.failed, " rejected"] }), error && (0, jsx_runtime_1.jsx)("p", { role: "status", className: "xhswarm-inspector-warning", children: "Status unavailable \u00B7 showing last known team data." })] }), (0, jsx_runtime_1.jsx)("h3", { children: "Workers" }), !members.length && (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", children: "No workers linked yet." }), members.map(member => {
                const worker = workers.find(w => w.sessionId === member.sessionId), facts = work[member.sessionId], expanded = selected === member.sessionId;
                return (0, jsx_runtime_1.jsxs)("article", { className: "xhswarm-worker", children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: "xhswarm-worker-toggle", "aria-label": `Inspect agent ${workerName(member.sessionId)}`, "aria-expanded": expanded, onClick: () => select(expanded ? '' : member.sessionId), children: [(0, jsx_runtime_1.jsx)("strong", { children: workerName(member.sessionId) }), (0, jsx_runtime_1.jsx)("span", { children: worker ? AgentMonitor_1.activityLabel[worker.activity] : 'Not observed' }), (0, jsx_runtime_1.jsx)("small", { children: facts?.assignment?.title ?? 'No active assignment' }), (0, jsx_runtime_1.jsxs)("small", { children: [facts?.accepted ?? 0, " accepted \u00B7 ", facts?.failed ?? 0, " rejected"] })] }), expanded && (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-worker-detail", "aria-label": `Agent details ${workerName(member.sessionId)}`, children: [(0, jsx_runtime_1.jsx)("h4", { children: "Role / initial assignment" }), (0, jsx_runtime_1.jsxs)("p", { className: "xhswarm-inspector-text", children: [member.assignment.slice(0, 2000), member.assignment.length > 2000 ? '…' : ''] }), (0, jsx_runtime_1.jsxs)("dl", { children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Last used model" }), (0, jsx_runtime_1.jsx)("dd", { children: current?.model ? `${current.model.provider} / ${current.model.model}` : loading ? 'Loading…' : 'Not reported' })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Inbox" }), (0, jsx_runtime_1.jsxs)("dd", { children: [worker?.pendingMessages ?? 'Unknown', " pending messages"] })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Last turn" }), (0, jsx_runtime_1.jsx)("dd", { children: worker?.lastTurnEnd?.kind.replaceAll('_', ' ') ?? 'Not recorded' })] }), facts?.assignment && (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "Assignment" }), (0, jsx_runtime_1.jsxs)("dd", { children: [facts.assignment.title, " \u00B7 ", facts.assignment.delivered ? 'Inbox received' : 'Delivery pending'] })] })] }), (0, jsx_runtime_1.jsx)("h4", { children: "Blockers" }), (0, jsx_runtime_1.jsx)("p", { children: !worker ? 'Status unavailable' : worker.unresolvedToolCalls.length ? `${worker.unresolvedToolCalls.length} unresolved tool calls` : ['awaiting_approval', 'awaiting_answer', 'needs_reconciliation', 'unavailable', 'dispatch_paused'].includes(worker.activity) ? AgentMonitor_1.activityLabel[worker.activity] : team.status !== 'active' ? 'Team is not active; new dispatch is paused.' : 'No blocker reported' }), current?.activity && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h4", { children: "Latest recorded activity" }), (0, jsx_runtime_1.jsxs)("p", { children: [current.activity.text, " \u00B7 ", new Date(current.activity.time).toLocaleTimeString('en-GB')] })] }), facts?.result && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h4", { children: facts.result.turn === null ? 'Recorded task result' : `Task result · worker turn ${facts.result.turn}` }), (0, jsx_runtime_1.jsxs)("strong", { children: [facts.result.title, " \u00B7 ", facts.result.outcome === 'completed' ? 'Accepted' : 'Rejected'] }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-inspector-text", children: facts.result.summary }), facts.result.truncated && (0, jsx_runtime_1.jsx)("small", { children: "Preview truncated. Open the conversation for context." })] }), current?.answer && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h4", { children: "Latest public response" }), (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-inspector-text", children: current.answer.text }), current.answer.truncated && (0, jsx_runtime_1.jsx)("small", { children: "Preview truncated." })] }), loading && (0, jsx_runtime_1.jsx)("p", { role: "status", children: "Loading worker details\u2026" }), detailError && (0, jsx_runtime_1.jsxs)("p", { role: "status", className: "xhswarm-inspector-warning", children: [detailError, current ? ' · Showing last known details.' : ''] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-detail-actions", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", disabled: loading, onClick: () => setRetry(value => value + 1), children: "Refresh details" }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => openWorker(member.sessionId), children: "Open worker conversation" })] })] })] }, member.sessionId);
            })] });
}

}
};
const __dependencies = {"src/modules/swarm/index.js":{"../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","./client":"src/modules/swarm/client.js","./Swarm.css":"src/modules/swarm/Swarm.css","./TaskBoard":"src/modules/swarm/TaskBoard.js","./AgentMonitor":"src/modules/swarm/AgentMonitor.js","./TeamInspector":"src/modules/swarm/TeamInspector.js"},"src/modules/client-connection/contracts/core/session/types.js":{},"src/modules/swarm/client.js":{},"src/modules/swarm/Swarm.css":{},"src/modules/swarm/TaskBoard.js":{},"src/modules/swarm/AgentMonitor.js":{},"src/modules/swarm/TeamInspector.js":{"./AgentMonitor":"src/modules/swarm/AgentMonitor.js"}};
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
return __load("src/modules/swarm/index.js");
}
});
