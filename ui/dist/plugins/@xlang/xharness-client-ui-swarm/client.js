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
const openSwarm = () => { window.dispatchEvent(new Event('xharness:swarm:open')); };
exports.openSwarm = openSwarm;
const labels = { running: 'Running', queued: 'Queued', idle: 'Waiting', dispatch_paused: 'Stopped', unavailable: 'Unavailable', needs_reconciliation: 'Needs reconciliation', awaiting_approval: 'Needs approval', awaiting_answer: 'Waiting for an answer' };
const errorMessage = (error) => error instanceof Error ? error.message : 'Swarm request failed';
function SwarmCenter({ client, sessions, showConversation }) {
    const catalog = (0, react_1.useSyncExternalStore)(sessions.list.subscribe, sessions.list.getSnapshot);
    const owner = catalog.current, record = owner ? catalog.byId[owner] : undefined;
    const eligible = !!record && !record.parentId && record.origin !== 'subagent';
    const [railOpen, setRailOpen] = (0, react_1.useState)(false);
    const [teams, setTeams] = (0, react_1.useState)([]), [inspection, setInspection] = (0, react_1.useState)(null), [busy, setBusy] = (0, react_1.useState)(false), [loading, setLoading] = (0, react_1.useState)(false), [error, setError] = (0, react_1.useState)(''), [objective, setObjective] = (0, react_1.useState)(''), [creating, setCreating] = (0, react_1.useState)(false), [child, setChild] = (0, react_1.useState)('');
    const scope = (0, react_1.useRef)(0), read = (0, react_1.useRef)(0), selected = (0, react_1.useRef)(''), controller = (0, react_1.useRef)(null);
    const team = inspection && inspection.swarm.ownerSessionId === owner ? inspection.swarm : null;
    const refresh = (0, react_1.useCallback)(async (preferred) => {
        if (!owner || !eligible)
            return;
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
    (0, react_1.useEffect)(() => { scope.current++; selected.current = ''; setInspection(null); setTeams([]); setCreating(false); setBusy(false); setLoading(false); setError(''); setChild(''); void refresh(); return () => { scope.current++; controller.current?.abort(); }; }, [refresh]);
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
    // No hidden polling, provider probes, prompt submission or autonomous team loop.
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
    const members = team ? Object.values(team.members) : [], observations = inspection && inspection.swarm.id === team?.id ? inspection.workers : [];
    const available = owner ? catalog.subagentsByParent[owner]?.entries.filter(e => e.kind === 'child' && !members.some(m => m.sessionId === e.id)) ?? [] : [];
    function openWorker(id) {
        const address = sessions.subagentAddress((0, types_1.SessionId)(id));
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
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("header", { className: "xhswarm-header", children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-heading", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconAgentPresetOutline16, { size: 28 }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("h1", { children: team?.objective.split('\n')[0] ?? 'Swarm' }), (0, jsx_runtime_1.jsx)("span", { children: team ? 'Persistent team' : 'A workspace for your team' })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-actions", children: [team && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: "xhswarm-status", children: team.status === 'closed' ? 'Closed' : team.status === 'paused' ? 'Paused' : record?.running || observations.some(w => w.activity === 'running') ? 'Running' : 'Waiting' }), (0, jsx_runtime_1.jsxs)("button", { type: "button", disabled: busy || loading || !!error || team.status === 'closed', title: "Changes team membership availability only. Running chats are not stopped.", onClick: () => void mutate(() => client.status(team, team.status === 'active' ? 'paused' : 'active')), children: [team.status === 'paused' ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlayOutline16, {}) : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPauseOutline16, {}), team.status === 'paused' ? 'Resume membership' : 'Pause membership'] })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "xhswarm-team-toggle", "aria-controls": "xhswarm-team", "aria-expanded": railOpen, onClick: () => setRailOpen(!railOpen), children: "Team" }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": "Refresh team", disabled: busy || loading, onClick: () => void refresh(), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconRefreshOutline16, {}) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-label": "Back to chat", onClick: () => window.dispatchEvent(new Event('xharness:swarm:close')), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, {}) })] })] }), error && (0, jsx_runtime_1.jsx)("div", { className: "xhswarm-notice", role: "alert", children: error }), (!team || creating) && (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-setup", "aria-label": "Swarm setup", children: [(0, jsx_runtime_1.jsx)("h2", { children: creating ? 'New team' : 'Keep your team together' }), !eligible ? (0, jsx_runtime_1.jsx)("p", { children: "Select a root conversation in the sidebar, then open /swarm." }) : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("p", { children: "Create a persistent team record for this conversation. Existing chats and their execution stay unchanged." }), (0, jsx_runtime_1.jsxs)("form", { onSubmit: event => {
                                    event.preventDefault();
                                    if (owner && objective.trim())
                                        void mutate(() => client.create(owner, objective.trim()));
                                }, children: [(0, jsx_runtime_1.jsxs)("label", { children: ["Objective", (0, jsx_runtime_1.jsx)("textarea", { value: objective, onChange: event => setObjective(event.target.value), maxLength: 32768, required: true, placeholder: "What should this team work on?" })] }), (0, jsx_runtime_1.jsx)("button", { disabled: busy || loading || !!error || !objective.trim(), type: "submit", children: busy ? 'Saving…' : 'Create team' }), creating && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setCreating(false), children: "Cancel" })] })] }), loading && (0, jsx_runtime_1.jsx)("p", { role: "status", children: "Loading teams\u2026" })] }), (0, jsx_runtime_1.jsxs)("aside", { id: "xhswarm-team", className: "xhswarm-rail", "data-open": railOpen, "aria-label": "Team", onKeyDown: event => {
                    if (event.key === 'Escape')
                        setRailOpen(false);
                }, children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-rail-heading", children: [(0, jsx_runtime_1.jsx)("h2", { children: "Team" }), eligible && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => setCreating(true), disabled: busy, children: "New" })] }), teams.length > 1 && (0, jsx_runtime_1.jsxs)("label", { className: "xhswarm-team-picker", children: ["Saved teams", (0, jsx_runtime_1.jsx)("select", { "aria-label": "Saved teams", value: team?.id ?? '', disabled: busy || loading, onChange: event => { setCreating(false); void refresh(event.target.value); }, children: teams.map(t => (0, jsx_runtime_1.jsx)("option", { value: t.id, children: t.objective }, t.id)) })] }), team && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhswarm-person", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconUserOutline16, { size: 22 }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("strong", { children: "Coordinator" }), (0, jsx_runtime_1.jsx)("span", { children: record?.running ? 'Running' : 'Waiting' })] })] }), members.map(member => { const observed = observations.find(w => w.sessionId === member.sessionId), entry = owner ? catalog.subagentsByParent[owner]?.entries.find(e => e.id === member.sessionId) : undefined; return (0, jsx_runtime_1.jsxs)("button", { className: "xhswarm-person", type: "button", onClick: () => openWorker(member.sessionId), children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconUserOutline16, { size: 22 }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("strong", { children: entry?.kind === 'child' ? entry.label : member.sessionId.slice(0, 20) }), (0, jsx_runtime_1.jsx)("span", { children: observed ? labels[observed.activity] : 'Not refreshed' }), (0, jsx_runtime_1.jsx)("small", { title: member.assignment, children: member.assignment })] })] }, member.sessionId); }), !members.length && (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", children: "No workers linked yet." }), (0, jsx_runtime_1.jsxs)("details", { className: "xhswarm-link", children: [(0, jsx_runtime_1.jsx)("summary", { children: "Link an existing worker" }), (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => void refreshWorkers(), disabled: busy, children: "Refresh workers" }), (0, jsx_runtime_1.jsxs)("label", { children: ["Worker", (0, jsx_runtime_1.jsxs)("select", { "aria-label": "Worker to link", value: child, onChange: event => setChild(event.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: "Choose worker" }), available.map(entry => (0, jsx_runtime_1.jsx)("option", { value: entry.id, children: entry.kind === 'child' ? entry.label : entry.id }, entry.id))] })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: !child || busy || loading || !!error || team.status !== 'active', onClick: () => void mutate(() => client.attach(team, child)), children: "Link worker" })] }), (0, jsx_runtime_1.jsxs)("section", { className: "xhswarm-results", "aria-label": "Recorded results", children: [(0, jsx_runtime_1.jsx)("h2", { children: "Recorded results" }), observations.filter(w => w.lastTurnEnd).slice(0, 3).map(w => (0, jsx_runtime_1.jsxs)("button", { type: "button", onClick: () => openWorker(w.sessionId), children: [(0, jsx_runtime_1.jsx)("strong", { children: w.lastTurnEnd?.kind === 'completed' ? 'Turn finished' : w.lastTurnEnd?.kind.replaceAll('_', ' ') }), (0, jsx_runtime_1.jsx)("span", { children: "Open worker conversation" })] }, w.sessionId)), !observations.some(w => w.lastTurnEnd) && (0, jsx_runtime_1.jsx)("p", { className: "xhswarm-muted", children: "No recorded turn results." })] })] })] })] });
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
    return { id: text(v.id), ownerSessionId: text(v.ownerSessionId), workspace: text(v.workspace), objective: text(v.objective), status: status(v.status), revision, members };
}
function parseInspection(value) {
    const v = object(value), swarm = parseTeam(v.swarm);
    const workers = list(v.workers, item => { const w = object(item); return { sessionId: text(w.sessionId), activity: activity(w.activity), sessionRevision: w.sessionRevision === null ? null : number(w.sessionRevision), lastTurnEnd: w.lastTurnEnd === null ? null : { kind: text(object(w.lastTurnEnd).kind) }, unresolvedToolCalls: list(w.unresolvedToolCalls, text), pendingMessages: number(w.pendingMessages) }; });
    if (new Set(workers.map(w => w.sessionId)).size !== workers.length || workers.length !== Object.keys(swarm.members).length || workers.some(w => !Object.prototype.hasOwnProperty.call(swarm.members, w.sessionId)))
        throw Error('Swarm member/observation mismatch');
    return { swarm, workers };
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
    async create(owner, objective) { return text(object(await this.call(owner, { action: 'create', objective })).swarmId); }
    async status(team, next) { await this.call(team.ownerSessionId, { action: 'set_status', swarmId: team.id, expectedRevision: team.revision, status: next }); }
    async attach(team, child) { await this.call(team.ownerSessionId, { action: 'attach_member', swarmId: team.id, expectedRevision: team.revision, childSessionId: child }); }
}
exports.SwarmClient = SwarmClient;

},
"src/modules/swarm/Swarm.css": function(module, exports, require) {
// source: src/modules/swarm/Swarm.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhfeature-shell[data-swarm-active=true]{display:grid;grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:auto minmax(0,1fr);position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary-bluish)}\n.xhswarm-seat{display:contents}.xhswarm-seat[hidden]{display:none}\n.xhswarm-header{grid-column:1;grid-row:1;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:30px 44px 24px;min-width:0}.xhswarm-heading{display:flex;gap:16px;align-items:flex-start;min-width:0}.xhswarm-heading>svg{flex:none;margin-top:3px}.xhswarm-heading>div{min-width:0}.xhswarm-heading h1{font-size:27px;font-weight:600;line-height:1.3;margin:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}.xhswarm-heading span{display:block;margin-top:8px;font-size:14px;color:var(--dsw-alias-label-secondary)}\n.xhswarm-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.xhswarm-status{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.xhswarm-header button,.xhswarm-rail button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;display:inline-flex;gap:8px;align-items:center;border-radius:8px;padding:8px;font-size:13px}.xhswarm-header button:hover,.xhswarm-rail button:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhswarm-header button:disabled,.xhswarm-rail button:disabled,.xhswarm-setup button:disabled{opacity:.45;cursor:default}.xhswarm-header button:focus-visible,.xhswarm-rail button:focus-visible,.xhswarm-setup :focus-visible{outline:2px solid currentColor;outline-offset:3px}\n.xhfeature-shell[data-swarm-active=true]>.xhwork-conversation{grid-column:1;grid-row:2;min-width:0;min-height:0}.xhswarm-rail{grid-column:2;grid-row:1/3;border-left:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:auto;padding:34px 30px}.xhswarm-rail-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.xhswarm-rail h2{font-size:16px;line-height:1.4;font-weight:600;margin:0}.xhswarm-person{display:flex!important;align-items:flex-start!important;gap:16px!important;text-align:left;width:100%;margin:0 0 22px;padding:8px 0!important}.xhswarm-person>svg{flex:none}.xhswarm-person>div{min-width:0}.xhswarm-person strong{font-size:16px;font-weight:500;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhswarm-person span,.xhswarm-person small{font-size:13px;line-height:1.55;display:block;color:var(--dsw-alias-label-secondary);margin-top:4px;overflow-wrap:anywhere}.xhswarm-person small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.xhswarm-results{border-top:1px solid var(--dsw-alias-border-l1);margin-top:24px;padding-top:28px}.xhswarm-results button{display:block;width:100%;text-align:left;margin-top:18px;padding:0}.xhswarm-results strong,.xhswarm-results span{display:block;font-weight:400;font-size:13px;line-height:1.6}.xhswarm-results span,.xhswarm-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}.xhswarm-setup{grid-column:1;grid-row:2;padding:clamp(25px,6vw,90px) 36px;max-width:650px;overflow:auto;min-width:0}.xhswarm-setup h2{font-size:24px;font-weight:500;margin:0 0 12px}.xhswarm-setup p{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary)}.xhswarm-setup label,.xhswarm-link label,.xhswarm-team-picker{display:block;font-size:13px;line-height:1.6}.xhswarm-setup textarea{display:block;box-sizing:border-box;resize:vertical;width:100%;min-height:100px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;margin:8px 0 20px}.xhswarm-setup button{font:inherit;padding:10px 18px;border-radius:10px;background:var(--dsw-alias-label-primary-bluish);color:var(--dsw-alias-bg-base);border:0;cursor:pointer;margin-right:10px}.xhswarm-link{font-size:13px;margin:20px 0}.xhswarm-link summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.xhswarm-rail select{display:block;width:100%;min-width:0;box-sizing:border-box;margin:8px 0 14px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px}.xhswarm-notice{position:absolute;top:106px;left:30px;right:345px;z-index:2;background:var(--dsw-alias-bg-base);padding:12px;font-size:13px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-wrap:anywhere}\n@media(max-width:1100px){.xhswarm-header{flex-wrap:wrap;padding:22px}.xhswarm-heading h1{font-size:22px}.xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr) 225px}.xhswarm-rail{padding:25px 16px}.xhswarm-notice{right:240px}}\n@media(max-width:700px){.xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.xhswarm-rail{display:none}.xhswarm-header{padding:18px;gap:12px}.xhswarm-heading h1{font-size:20px}.xhswarm-setup{padding:24px}.xhswarm-notice{right:18px;left:18px}.xhswarm-actions{gap:4px}}\n\n.xhswarm-header .xhswarm-team-toggle{display:none}@media(max-width:700px){.xhswarm-header .xhswarm-team-toggle{display:inline-flex}.xhswarm-rail[data-open=true]{display:block;position:absolute;grid-column:1;grid-row:2;right:0;top:0;bottom:0;width:min(270px,85%);box-sizing:border-box;background:var(--dsw-alias-bg-base);z-index:3}}\n\n/* Respond to the center pane as well as the window: the browser/files pane may be docked. */\n[data-swarm-container=true]{container-type:inline-size;container-name:swarm-pane}\n@container swarm-pane (max-width:900px){\n .xhswarm-header{flex-wrap:wrap;padding:22px;gap:12px}\n .xhswarm-heading h1{font-size:22px}\n}\n@container swarm-pane (max-width:700px){\n .xhfeature-shell[data-swarm-active=true]{grid-template-columns:minmax(0,1fr)}\n .xhswarm-rail{display:none}\n .xhswarm-header .xhswarm-team-toggle{display:inline-flex}\n .xhswarm-rail[data-open=true]{display:block;position:absolute;grid-column:1;grid-row:2;right:0;top:0;bottom:0;width:min(270px,85%);box-sizing:border-box;background:var(--dsw-alias-bg-base);z-index:3}\n .xhswarm-notice{right:18px;left:18px}\n}\n";

}
};
const __dependencies = {"src/modules/swarm/index.js":{"../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","./client":"src/modules/swarm/client.js","./Swarm.css":"src/modules/swarm/Swarm.css"},"src/modules/client-connection/contracts/core/session/types.js":{},"src/modules/swarm/client.js":{},"src/modules/swarm/Swarm.css":{}};
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
