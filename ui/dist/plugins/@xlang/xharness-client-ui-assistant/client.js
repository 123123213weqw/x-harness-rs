// Generated from src/modules/assistant/index.tsx; do not edit.
window.__ModuleLoader__.load({
id: "@xlang/xharness-client-ui-assistant",
factory: (__externalRequire) => {
const __units = {
"src/modules/assistant/index.js": function(module, exports, require) {
// source: src/modules/assistant/index.tsx

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.AssistantCenter = AssistantCenter;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
const shell_route_1 = require("../shared/shell-route");
/// <reference path="../shared/assets.d.ts" />
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@xharness/dsh-client-ui-primitives");
const service_1 = require("./service");
const contracts_1 = require("./contracts");
const Assistant_css_1 = __importDefault(require("./Assistant.css"));
const OrbitIcon_1 = require("./OrbitIcon");
const zh = navigator.language.startsWith('zh');
const label = (en, cn) => zh ? cn : en;
function AssistantNavigation({ wide }) {
    const [active, setActive] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => (0, shell_route_1.observeShellPage)('assistant', setActive), []);
    return (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: label('Little X', '小 X'), side: "right", disabled: wide, children: (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-xharness-assistant-nav": true, className: "xhassistant-nav", "aria-label": label('Little X', '小 X'), "aria-current": active ? 'page' : undefined, onClick: () => (0, contracts_1.openAssistant)(), children: [(0, jsx_runtime_1.jsx)(OrbitIcon_1.OrbitIcon, { size: wide ? 16 : 18 }), wide && (0, jsx_runtime_1.jsx)("span", { children: "X" })] }) });
}
function AssistantCenter({ service, showConversation }) {
    const state = (0, react_1.useSyncExternalStore)(service.state.subscribe, service.state.getSnapshot);
    const [workspace, setWorkspace] = (0, react_1.useState)(''), [tasks, setTasks] = (0, react_1.useState)(false);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    (0, react_1.useEffect)(() => { showConversation(state.exists && state.active); return () => showConversation(false); }, [state.exists, state.active, showConversation]);
    const runCount = state.tasks.filter(t => t.status === 'running').length, waiting = state.tasks.filter(t => ['approval', 'question', 'plan-review'].includes(t.status)).length;
    return (0, jsx_runtime_1.jsxs)("section", { className: "xhassistant", "aria-label": label('Little X', '小 X'), children: [(0, jsx_runtime_1.jsxs)("header", { children: [(0, jsx_runtime_1.jsxs)("div", { className: "xhassistant-title", children: [(0, jsx_runtime_1.jsx)(OrbitIcon_1.OrbitIcon, { size: 20 }), (0, jsx_runtime_1.jsx)("strong", { children: label('Little X', '小 X') })] }), (0, jsx_runtime_1.jsxs)("div", { className: "xhassistant-controls", children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", "aria-expanded": tasks, onClick: () => setTasks(!tasks), children: [label('Tasks', '任务'), state.ready ? ` · ${runCount} ${label('running', '运行中')}${waiting ? ` / ${waiting} ${label('waiting', '等待你')}` : ''}` : ''] }), state.exists && state.active && (0, jsx_runtime_1.jsx)("button", { type: "button", disabled: !state.ready, onClick: () => service.shareTasks(), children: label('Share overview', '引用任务概览') })] })] }), state.error && (0, jsx_runtime_1.jsx)("p", { role: "alert", children: state.error }), tasks && (0, jsx_runtime_1.jsxs)("div", { className: "xhassistant-task-list", "aria-label": label('Task overview', '任务概览'), children: [!state.ready ? (0, jsx_runtime_1.jsx)("p", { role: "status", children: label('Loading Host tasks…', '正在加载 Host 任务…') }) : state.tasks.length ? state.tasks.map(task => (0, jsx_runtime_1.jsxs)("button", { type: "button", onClick: () => service.openTask(task.id), children: [(0, jsx_runtime_1.jsx)("span", { children: task.title }), (0, jsx_runtime_1.jsx)("small", { children: task.status === 'approval' ? label('Waiting for approval', '等待审批') : task.status === 'question' ? label('Waiting for reply', '等待回答') : task.status === 'plan-review' ? label('Waiting for plan review', '等待计划确认') : task.status === 'running' ? label('Running', '运行中') : task.status === 'completed' ? label('Turn finished', '轮次结束') : label('Idle', '空闲') })] }, task.id)) : (0, jsx_runtime_1.jsx)("p", { children: label('No other listed tasks', '暂无其他已列出的任务') }), state.hasMore && (0, jsx_runtime_1.jsx)("p", { children: label('Showing the first 200 listed tasks.', '显示前 200 个已列出的任务。') })] }), state.pending > 0 && (0, jsx_runtime_1.jsxs)("div", { className: "xhassistant-references", children: [(0, jsx_runtime_1.jsxs)("span", { children: [state.pending, " ", label('pending references', '条待加入的引用')] }), (0, jsx_runtime_1.jsx)("button", { disabled: !state.active, onClick: () => service.appendPending(), children: label('Add to draft', '加入草稿') }), (0, jsx_runtime_1.jsx)("button", { onClick: () => service.discardPending(), children: label('Discard', '丢弃') })] }), !state.exists && (0, jsx_runtime_1.jsxs)("div", { className: "xhassistant-setup", children: [(0, jsx_runtime_1.jsx)(OrbitIcon_1.OrbitIcon, { size: 36 }), (0, jsx_runtime_1.jsx)("h2", { children: label('One place to coordinate your work', '在这里统筹你的工作') }), (0, jsx_runtime_1.jsx)("p", { children: label('Choose Little X’s working directory. Existing tasks keep their own conversations.', '选择小 X 的工作目录，已有任务仍保留独立对话。') }), (0, jsx_runtime_1.jsxs)("label", { children: [label('Workspace', '工作区'), (0, jsx_runtime_1.jsxs)("select", { "aria-label": label('Little X workspace', '小 X 工作区'), value: workspace, disabled: !state.ready || state.creating, onChange: e => setWorkspace(e.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: label('Choose workspace', '选择工作区') }), state.workspaces.map(w => (0, jsx_runtime_1.jsxs)("option", { value: w.id, children: [w.title, " \u00B7 ", w.path] }, w.id))] })] }), (0, jsx_runtime_1.jsx)("button", { disabled: !workspace || !state.ready || state.creating, onClick: () => void service.create(workspace).then(() => { if (alive.current && service.state.getSnapshot().exists)
                            service.open(); }), children: state.creating ? label('Preparing…', '正在准备…') : label('Start Little X', '开始使用小 X') }), !state.ready && (0, jsx_runtime_1.jsx)("p", { role: "status", children: label('Loading Host…', '正在连接 Host…') })] }), state.exists && !state.active && (0, jsx_runtime_1.jsx)("button", { type: "button", onClick: () => service.open(), children: label('Open Little X', '打开小 X 对话') })] });
}
exports.inject = ['slots', 'sessions', 'workspaces', 'conversation'];
function apply(ctx) {
    const service = new service_1.GlobalAssistant(ctx.get('sessions'), ctx.get('workspaces'), ctx.get('conversation'));
    ctx.effect(() => { const listener = (event) => { const value = event instanceof CustomEvent ? event.detail : undefined; const ref = (0, contracts_1.assistantReference)(value); if (value != null && !ref)
        return; service.request(ref ?? undefined); }; window.addEventListener(contracts_1.ASSISTANT_OPEN, listener); return () => { window.removeEventListener(contracts_1.ASSISTANT_OPEN, listener); service.dispose(); }; }, 'assistant: explicit navigation and lifecycle');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.xharnessAssistant = ''; style.textContent = Assistant_css_1.default; document.head.append(style); return () => style.remove(); }, 'assistant: scoped styles');
    ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({ name: 'sidebar.primary.action', id: 'global-assistant', inject: () => ({}) }, AssistantNavigation));
    ctx.slots.inject('assistant.center', () => ctx.slots.register({ name: 'assistant.center', id: 'global-assistant', inject: () => ({ service }) }, AssistantCenter));
}

},
"src/modules/shared/shell-route.js": function(module, exports, require) {
// source: src/modules/shared/shell-route.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHELL_ROUTE_REQUESTED = exports.SHELL_ROUTE_CHANGED = void 0;
exports.observeShellPage = observeShellPage;
/** A display projection, never an instruction to re-run a page's action. */
exports.SHELL_ROUTE_CHANGED = 'xharness:shell-route-changed';
exports.SHELL_ROUTE_REQUESTED = 'xharness:shell-route-requested';
function observeShellPage(page, setActive) {
    const changed = (event) => {
        if (!(event instanceof CustomEvent))
            return;
        const detail = event.detail;
        if (typeof detail === 'object' && detail !== null && 'page' in detail && typeof detail.page === 'string') {
            setActive(detail.page === page);
        }
    };
    window.addEventListener(exports.SHELL_ROUTE_CHANGED, changed);
    // A compact/wide sidebar remount must hydrate its active marker without
    // replaying a feature's ':open' operation or waiting for another visit.
    window.dispatchEvent(new Event(exports.SHELL_ROUTE_REQUESTED));
    return () => window.removeEventListener(exports.SHELL_ROUTE_CHANGED, changed);
}

},
"src/modules/assistant/service.js": function(module, exports, require) {
// source: src/modules/assistant/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlobalAssistant = exports.ASSISTANT_SESSION = void 0;
const types_1 = require("../client-connection/contracts/core/session/types");
const store_1 = require("../client-runtime/contract/store");
exports.ASSISTANT_SESSION = (0, types_1.SessionId)('xharness-global-assistant-v1');
const initial = { ready: false, exists: false, active: false, creating: false, error: '', workspace: '', pending: 0, tasks: [], hasMore: false, workspaces: [] };
class GlobalAssistant {
    constructor(sessions, workspaces, conversation) {
        this.sessions = sessions;
        this.workspaces = workspaces;
        this.conversation = conversation;
        this.state = (0, store_1.createSnapshotStore)(initial, { flush: 'sync' });
        this.pending = new Map();
        this.creating = null;
        this.disposed = false;
        this.off = [sessions.list.subscribe(() => this.project()), workspaces.list.subscribe(() => this.project())];
        this.project();
    }
    row() {
        const row = this.sessions.list.getSnapshot().byId[exports.ASSISTANT_SESSION];
        if (row?.parentId || row?.origin)
            throw new Error('Assistant identity belongs to another conversation type');
        return row;
    }
    project() {
        if (this.disposed)
            return;
        const list = this.sessions.list.getSnapshot(), spaces = this.workspaces.list.getSnapshot();
        const rows = list.ids.flatMap(id => {
            const row = list.byId[id];
            if (!row || id === exports.ASSISTANT_SESSION)
                return [];
            const status = row.pendingInteraction ?? (row.running ? 'running' : row.completed ? 'completed' : 'idle');
            return [{ id: row.id, title: row.displayTitle, cwd: row.cwd ?? '', status }];
        });
        const own = list.byId[exports.ASSISTANT_SESSION], eligible = !!own && !own.parentId && !own.origin;
        this.state.set({ ...this.state.getSnapshot(), ready: list.phase === 'ready' && spaces.phase === 'ready', exists: eligible,
            active: eligible && list.current === exports.ASSISTANT_SESSION, workspace: eligible ? own.cwd ?? '' : '', pending: this.pending.size,
            tasks: rows.slice(0, 200), hasMore: rows.length > 200,
            workspaces: spaces.items.map(w => ({ id: w.workspaceId, title: w.title, path: w.path })) });
    }
    request(reference) {
        if (this.disposed)
            return;
        this.state.set({ ...this.state.getSnapshot(), error: '' });
        if (reference) {
            if (!this.pending.has(reference.key) && this.pending.size >= 16) {
                this.fail(new Error('Too many pending references; add or discard them first'));
                return;
            }
            this.pending.set(reference.key, reference);
        }
        try {
            if (this.row())
                this.sessions.open(exports.ASSISTANT_SESSION);
        }
        catch (error) {
            this.fail(error);
        }
        this.project();
        // Deliberately stage references; never mutate a draft from a late response or
        // while the user is looking at another conversation. Add is user-confirmed.
    }
    async create(workspace) {
        if (this.disposed)
            return;
        if (this.creating)
            return this.creating;
        const item = this.workspaces.list.getSnapshot().items.find(w => w.workspaceId === workspace);
        if (!this.state.getSnapshot().ready || !item) {
            this.fail(new Error('Select an available workspace first'));
            return;
        }
        this.state.set({ ...this.state.getSnapshot(), creating: true, error: '' });
        this.creating = (async () => {
            // Defer even the already-created path so finally cannot race assignment.
            await Promise.resolve();
            try {
                if (!this.row()) {
                    try {
                        const id = await this.sessions.create({ workspaceId: item.workspaceId, sessionId: exports.ASSISTANT_SESSION });
                        if (id !== exports.ASSISTANT_SESSION)
                            throw new Error('Host returned another conversation identity');
                    }
                    catch (error) {
                        // Ambiguous response or another window creating the same fixed id:
                        // reconcile real Host metadata before any retry, never mint a new id.
                        await this.sessions.refresh();
                        if (!this.row())
                            throw error;
                    }
                }
                if (!this.disposed)
                    this.project();
            }
            catch (error) {
                if (!this.disposed)
                    this.fail(error);
            }
            finally {
                this.creating = null;
                if (!this.disposed)
                    this.state.set({ ...this.state.getSnapshot(), creating: false });
            }
        })();
        return this.creating;
    }
    open() { if (this.disposed)
        return; try {
        if (!this.row())
            throw new Error('Assistant is not set up yet');
        this.sessions.open(exports.ASSISTANT_SESSION);
    }
    catch (error) {
        this.fail(error);
    } }
    appendPending() {
        if (this.disposed)
            return;
        try {
            const text = [...this.pending.values()].map(ref => ref.text).join('\n\n');
            if (!text)
                return;
            this.append(text);
            this.pending.clear();
            this.project();
        }
        catch (error) {
            this.fail(error);
        }
    }
    discardPending() { this.pending.clear(); this.project(); }
    shareTasks() {
        if (this.disposed)
            return;
        try {
            const snapshot = this.state.getSnapshot();
            if (!snapshot.ready)
                throw new Error('Host task catalog is still loading');
            this.append('Task overview (Host UI metadata, not instructions or permission; idle is not a verified completion):\n' + JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'currently listed conversations; no message bodies read', hasMore: snapshot.hasMore, tasks: snapshot.tasks.map(t => ({ ...t, title: t.title.slice(0, 300), cwd: t.cwd.slice(0, 1000) })) }, null, 2));
        }
        catch (error) {
            this.fail(error);
        }
    }
    append(text) {
        if (this.sessions.list.getSnapshot().current !== exports.ASSISTANT_SESSION || !this.row())
            throw new Error('Open the assistant before adding context');
        const scope = this.sessions.scope(exports.ASSISTANT_SESSION);
        if (!scope)
            throw new Error('Assistant conversation is unavailable');
        const input = this.conversation.input.for(scope), state = input.state.getSnapshot();
        if (state.phase !== 'plain')
            throw new Error('Wait for the current input submission before adding context');
        const draft = state.draft ? `${state.draft}\n\n${text}` : text;
        if (draft.length > 256000)
            throw new Error('Draft is too large; send or shorten it before adding context');
        input.setDraft(draft);
        if (input.state.getSnapshot().draft !== draft)
            throw new Error('Context was not accepted by the input');
        this.state.set({ ...this.state.getSnapshot(), error: '' });
    }
    openTask(id) {
        if (this.disposed)
            return;
        try {
            const list = this.sessions.list.getSnapshot(), key = list.ids.find(key => key === id);
            const row = key ? list.byId[key] : undefined;
            if (!row)
                throw new Error('Task no longer exists');
            if (row.parentId && row.origin !== 'fork') {
                const address = this.sessions.subagentAddress(row.id);
                if (!address)
                    throw new Error('Open this child from its parent to resolve its address');
                this.sessions.openSubagent(address);
            }
            else
                this.sessions.open(row.id);
            window.dispatchEvent(new Event('xharness:assistant:close'));
        }
        catch (error) {
            this.fail(error);
        }
    }
    fail(error) { this.state.set({ ...this.state.getSnapshot(), error: error instanceof Error ? error.message : 'Assistant unavailable' }); }
    dispose() { this.disposed = true; this.off.forEach(off => off()); this.pending.clear(); }
}
exports.GlobalAssistant = GlobalAssistant;

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
"src/modules/client-runtime/contract/store.js": function(module, exports, require) {
// source: src/modules/client-runtime/contract/store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shallowEqual = shallowEqual;
exports.createSnapshotStore = createSnapshotStore;
exports.defineStore = defineStore;
/**
 * Snapshot store engine (zustand vanilla + immer + subscribeWithSelector +
 * rafFlush middleware + opt-in persist + dev freeze) plus the declarative
 * shell over it: {@link defineStore} bakes an init/persist/actions literal
 * into a {@link StoreHandle}, the registration-side store seat of slot
 * terminals. Lives in the React-free runtime (the data layer owns its
 * engine; ui-renderer is shell-only React
 * glue): engine products are bare observables — subscribe/getSnapshot/
 * update/set, NO selector hook. Hook synthesis is ui-renderer's (the one
 * uSES bridge, cached per source at the binding site).
 */
const state_engine_1 = require("./state-engine");
const immer_1 = require("immer");
const value_guards_1 = require("../value-guards");
/**
 * Shallow equality for selector slices (zustand/shallow semantics; travels
 * with the engine so hook consumers need no zustand dependency).
 * @param a - left value.
 * @param b - right value.
 * @returns whether the values are shallowly equal.
 */
function shallowEqual(a, b) {
    return (0, state_engine_1.shallow)(a, b);
}
/** Batches subscriber notification into one flush per animation frame. */
function rafBatch(notify) {
    // Fall back to microtask batching where rAF is absent (node unit tests);
    // both preserve the N-changes=1-notification contract within a tick.
    const schedule = typeof requestAnimationFrame === 'function'
        ? (fn) => { requestAnimationFrame(() => { fn(); }); }
        : (fn) => { queueMicrotask(fn); };
    let scheduled = false;
    return () => {
        if (scheduled)
            return;
        scheduled = true;
        schedule(() => {
            scheduled = false;
            notify();
        });
    };
}
function createSnapshotStore(init, opts) {
    // Immer enters through produce() in update() below (identical semantics to
    // the immer middleware without its setState-signature mutator generics).
    const api = (0, state_engine_1.createStateEngine)(init);
    if (opts?.persist)
        attachPersistence(api, opts.persist.name, opts.persist.decode);
    let subscribe = (fn) => api.subscribe(fn);
    if (opts?.flush === 'raf') {
        const listeners = new Set();
        const flush = rafBatch(() => { for (const fn of [...listeners])
            fn(); });
        api.subscribe(flush);
        subscribe = (fn) => {
            listeners.add(fn);
            return () => { listeners.delete(fn); };
        };
    }
    return {
        getSnapshot: () => api.getState(),
        subscribe: (fn) => subscribe(fn),
        update: (mutator) => {
            // Immer's produce (not setState's partial-merge path) so scalar and
            // array roots replace correctly; produce also freezes in dev.
            api.setState((0, immer_1.produce)(api.getState(), (draft) => { mutator(draft); }), true);
        },
        set: (next) => {
            api.setState(devFreeze(next), true);
        },
    };
}
/**
 * Whole-value JSON persistence to localStorage. Hand-rolled instead of the
 * zustand persist middleware: its write path spreads state into an object
 * (`partialize({ ...get() })`), exploding primitive state (a persisted string
 * draft becomes {0:'h',1:'e',...}) — not fixable via merge/deserialize options
 * because the corruption happens before serialization. Storage failures
 * (quota, private mode) only disable persistence, never break the store.
 */
function attachPersistence(api, name, decode) {
    // Non-browser runs (node e2e booting the client tree) have no localStorage:
    // persistence silently disables — same contract as a storage failure, minus
    // the per-store console noise a ReferenceError would produce.
    if (typeof localStorage === 'undefined')
        return;
    try {
        const raw = localStorage.getItem(name);
        if (raw !== null) {
            const value = JSON.parse(raw);
            api.setState(devFreeze(decode === undefined ? value : decode(value)), true);
        }
    }
    catch (error) {
        console.error(`snapshot store '${name}' rehydration failed:`, error);
    }
    api.subscribe((state) => {
        try {
            localStorage.setItem(name, JSON.stringify(state));
        }
        catch (error) {
            console.error(`snapshot store '${name}' persistence failed:`, error);
        }
    });
}
/** Deep-freeze wholesale-set state outside production: set() bypasses immer's freeze. */
function devFreeze(value) {
    // The frozen shipped module is a production build: wholesale set is not
    // auto-frozen. update still uses upstream Immer's default auto-freeze.
    return value;
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value))
        return;
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
        const child = Reflect.get(value, key);
        deepFreeze(child);
    }
}
function defineStore(decl) {
    return {
        spec: decl,
        create(scopeKey) {
            const persistKey = decl.persist === undefined ? undefined
                : scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}`;
            const store = createSnapshotStore(decl.init(), persistKey === undefined ? undefined
                : { persist: { name: persistKey, ...(decl.decode === undefined ? {} : { decode: decl.decode }) } });
            const bind = (mutate) => {
                if (typeof mutate !== 'function')
                    throw new Error('store action must be a function');
                return (...params) => {
                    store.update(draft => { Reflect.apply(mutate, undefined, [draft, ...params]); });
                };
            };
            let actions;
            if (decl.bake !== undefined) {
                const baked = Reflect.apply(decl.bake, undefined, [bind, decl.actions]);
                if (!isErasedActions(baked))
                    throw new Error('store bake must return callable actions');
                actions = baked;
            }
            else {
                actions = {};
                for (const [key, mutate] of Object.entries(decl.actions))
                    actions[key] = bind(mutate);
            }
            return {
                actions,
                getSnapshot: () => store.getSnapshot(),
                subscribe: (fn) => store.subscribe(fn),
                store,
                clearPersisted: () => {
                    if (persistKey === undefined || typeof localStorage === 'undefined')
                        return;
                    try {
                        localStorage.removeItem(persistKey);
                    }
                    catch { /* Same non-fatal storage ABI. */ }
                },
            };
        },
    };
}
/** Erasure claims no argument or result domain: concrete tuples come only from typed bake. */
function isErasedActions(value) {
    return (0, value_guards_1.isRecord)(value) && Object.values(value).every(action => typeof action === 'function');
}

},
"src/modules/client-runtime/contract/state-engine.js": function(module, exports, require) {
// source: src/modules/client-runtime/contract/state-engine.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStateEngine = createStateEngine;
exports.shallow = shallow;
const value_guards_1 = require("../value-guards");
function createStateEngine(initial) {
    let state = initial;
    const listeners = new Set();
    return {
        getState: () => state,
        setState(next, _replace) {
            // Zustand evaluates a function-valued replacement as an updater, even
            // when replace=true; retaining that edge preserves the vanilla ABI.
            const replacement = isStateUpdater(next)
                ? next(state)
                : next;
            if (Object.is(replacement, state))
                return;
            const previous = state;
            state = replacement;
            listeners.forEach(listener => listener(state, previous));
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
/** Same shallow semantics as the consumed zustand/shallow 4.4.7 ABI.
 * Map values use Object.is, Set values use has(), enumerable object keys only. */
function shallow(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null)
        return false;
    if ((0, value_guards_1.isUnknownMap)(a) && (0, value_guards_1.isUnknownMap)(b)) {
        if (a.size !== b.size)
            return false;
        for (const [key, value] of a)
            if (!Object.is(value, b.get(key)))
                return false;
        return true;
    }
    if ((0, value_guards_1.isUnknownSet)(a) && (0, value_guards_1.isUnknownSet)(b)) {
        if (a.size !== b.size)
            return false;
        for (const value of a)
            if (!b.has(value))
                return false;
        return true;
    }
    if (!(0, value_guards_1.isRecord)(a) || !(0, value_guards_1.isRecord)(b))
        return false;
    const left = a, right = b;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length)
        return false;
    for (const key of keys)
        if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key]))
            return false;
    return true;
}
function isStateUpdater(value) {
    return typeof value === 'function';
}

},
"src/modules/client-runtime/value-guards.js": function(module, exports, require) {
// source: src/modules/client-runtime/value-guards.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRecord = isRecord;
exports.isUnknownArray = isUnknownArray;
exports.isUnknownMap = isUnknownMap;
exports.isUnknownSet = isUnknownSet;
/** Open JSON/event boundaries stay unknown until their consumed shape is checked. */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isUnknownArray(value) { return Array.isArray(value); }
function isUnknownMap(value) { return value instanceof Map; }
function isUnknownSet(value) { return value instanceof Set; }

},
"vendor/immer.js": function(module, exports, require) {
// source: vendor:immer@10.2.0

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/modules/client-runtime/vendor/immer/src/immer.ts
var immer_exports = {};
__export(immer_exports, {
  Immer: () => Immer2,
  applyPatches: () => applyPatches,
  castDraft: () => castDraft,
  castImmutable: () => castImmutable,
  createDraft: () => createDraft,
  current: () => current,
  enableMapSet: () => enableMapSet,
  enablePatches: () => enablePatches,
  finishDraft: () => finishDraft,
  freeze: () => freeze,
  immerable: () => DRAFTABLE,
  isDraft: () => isDraft,
  isDraftable: () => isDraftable,
  nothing: () => NOTHING,
  original: () => original,
  produce: () => produce,
  produceWithPatches: () => produceWithPatches,
  setAutoFreeze: () => setAutoFreeze,
  setUseStrictIteration: () => setUseStrictIteration,
  setUseStrictShallowCopy: () => setUseStrictShallowCopy
});
module.exports = __toCommonJS(immer_exports);

// src/modules/client-runtime/vendor/immer/src/utils/env.ts
var NOTHING = /* @__PURE__ */ Symbol.for("immer-nothing");
var DRAFTABLE = /* @__PURE__ */ Symbol.for("immer-draftable");
var DRAFT_STATE = /* @__PURE__ */ Symbol.for("immer-state");

// src/modules/client-runtime/vendor/immer/src/utils/errors.ts
function die(error, ...args) {
  if (false) {
    const e = errors[error];
    const msg = typeof e === "function" ? e.apply(null, args) : e;
    throw new Error(`[Immer] ${msg}`);
  }
  throw new Error(
    `[Immer] minified error nr: ${error}. Full error at: https://bit.ly/3cXEKWf`
  );
}

// src/modules/client-runtime/vendor/immer/src/utils/common.ts
var getPrototypeOf = Object.getPrototypeOf;
function isDraft(value) {
  return !!value && !!value[DRAFT_STATE];
}
function isDraftable(value) {
  if (!value) return false;
  return isPlainObject(value) || Array.isArray(value) || !!value[DRAFTABLE] || !!value.constructor?.[DRAFTABLE] || isMap(value) || isSet(value);
}
var objectCtorString = Object.prototype.constructor.toString();
var cachedCtorStrings = /* @__PURE__ */ new WeakMap();
function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const Ctor = Object.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  if (Ctor === Object) return true;
  if (typeof Ctor !== "function") return false;
  let ctorString = cachedCtorStrings.get(Ctor);
  if (ctorString === void 0) {
    ctorString = Function.toString.call(Ctor);
    cachedCtorStrings.set(Ctor, ctorString);
  }
  return ctorString === objectCtorString;
}
function original(value) {
  if (!isDraft(value)) die(15, value);
  return value[DRAFT_STATE].base_;
}
function each(obj, iter, strict = true) {
  if (getArchtype(obj) === 0 /* Object */) {
    const keys = strict ? Reflect.ownKeys(obj) : Object.keys(obj);
    keys.forEach((key) => {
      iter(key, obj[key], obj);
    });
  } else {
    obj.forEach((entry, index) => iter(index, entry, obj));
  }
}
function getArchtype(thing) {
  const state = thing[DRAFT_STATE];
  return state ? state.type_ : Array.isArray(thing) ? 1 /* Array */ : isMap(thing) ? 2 /* Map */ : isSet(thing) ? 3 /* Set */ : 0 /* Object */;
}
function has(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.has(prop) : Object.prototype.hasOwnProperty.call(thing, prop);
}
function get(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.get(prop) : thing[prop];
}
function set(thing, propOrOldValue, value) {
  const t = getArchtype(thing);
  if (t === 2 /* Map */) thing.set(propOrOldValue, value);
  else if (t === 3 /* Set */) {
    thing.add(value);
  } else thing[propOrOldValue] = value;
}
function is(x, y) {
  if (x === y) {
    return x !== 0 || 1 / x === 1 / y;
  } else {
    return x !== x && y !== y;
  }
}
function isMap(target) {
  return target instanceof Map;
}
function isSet(target) {
  return target instanceof Set;
}
function latest(state) {
  return state.copy_ || state.base_;
}
function shallowCopy(base, strict) {
  if (isMap(base)) {
    return new Map(base);
  }
  if (isSet(base)) {
    return new Set(base);
  }
  if (Array.isArray(base)) return Array.prototype.slice.call(base);
  const isPlain = isPlainObject(base);
  if (strict === true || strict === "class_only" && !isPlain) {
    const descriptors = Object.getOwnPropertyDescriptors(base);
    delete descriptors[DRAFT_STATE];
    let keys = Reflect.ownKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const desc = descriptors[key];
      if (desc.writable === false) {
        desc.writable = true;
        desc.configurable = true;
      }
      if (desc.get || desc.set)
        descriptors[key] = {
          configurable: true,
          writable: true,
          // could live with !!desc.set as well here...
          enumerable: desc.enumerable,
          value: base[key]
        };
    }
    return Object.create(getPrototypeOf(base), descriptors);
  } else {
    const proto = getPrototypeOf(base);
    if (proto !== null && isPlain) {
      return { ...base };
    }
    const obj = Object.create(proto);
    return Object.assign(obj, base);
  }
}
function freeze(obj, deep = false) {
  if (isFrozen(obj) || isDraft(obj) || !isDraftable(obj)) return obj;
  if (getArchtype(obj) > 1) {
    Object.defineProperties(obj, {
      set: dontMutateMethodOverride,
      add: dontMutateMethodOverride,
      clear: dontMutateMethodOverride,
      delete: dontMutateMethodOverride
    });
  }
  Object.freeze(obj);
  if (deep)
    Object.values(obj).forEach((value) => freeze(value, true));
  return obj;
}
function dontMutateFrozenCollections() {
  die(2);
}
var dontMutateMethodOverride = {
  value: dontMutateFrozenCollections
};
function isFrozen(obj) {
  if (obj === null || typeof obj !== "object") return true;
  return Object.isFrozen(obj);
}

// src/modules/client-runtime/vendor/immer/src/utils/plugins.ts
var plugins = {};
function getPlugin(pluginKey) {
  const plugin = plugins[pluginKey];
  if (!plugin) {
    die(0, pluginKey);
  }
  return plugin;
}
function loadPlugin(pluginKey, implementation) {
  if (!plugins[pluginKey]) plugins[pluginKey] = implementation;
}

// src/modules/client-runtime/vendor/immer/src/core/scope.ts
var currentScope;
function getCurrentScope() {
  return currentScope;
}
function createScope(parent_, immer_) {
  return {
    drafts_: [],
    parent_,
    immer_,
    // Whenever the modified draft contains a draft from another scope, we
    // need to prevent auto-freezing so the unowned draft can be finalized.
    canAutoFreeze_: true,
    unfinalizedDrafts_: 0
  };
}
function usePatchesInScope(scope, patchListener) {
  if (patchListener) {
    getPlugin("Patches");
    scope.patches_ = [];
    scope.inversePatches_ = [];
    scope.patchListener_ = patchListener;
  }
}
function revokeScope(scope) {
  leaveScope(scope);
  scope.drafts_.forEach(revokeDraft);
  scope.drafts_ = null;
}
function leaveScope(scope) {
  if (scope === currentScope) {
    currentScope = scope.parent_;
  }
}
function enterScope(immer2) {
  return currentScope = createScope(currentScope, immer2);
}
function revokeDraft(draft) {
  const state = draft[DRAFT_STATE];
  if (state.type_ === 0 /* Object */ || state.type_ === 1 /* Array */)
    state.revoke_();
  else state.revoked_ = true;
}

// src/modules/client-runtime/vendor/immer/src/core/finalize.ts
function processResult(result, scope) {
  scope.unfinalizedDrafts_ = scope.drafts_.length;
  const baseDraft = scope.drafts_[0];
  const isReplaced = result !== void 0 && result !== baseDraft;
  if (isReplaced) {
    if (baseDraft[DRAFT_STATE].modified_) {
      revokeScope(scope);
      die(4);
    }
    if (isDraftable(result)) {
      result = finalize(scope, result);
      if (!scope.parent_) maybeFreeze(scope, result);
    }
    if (scope.patches_) {
      getPlugin("Patches").generateReplacementPatches_(
        baseDraft[DRAFT_STATE].base_,
        result,
        scope.patches_,
        scope.inversePatches_
      );
    }
  } else {
    result = finalize(scope, baseDraft, []);
  }
  revokeScope(scope);
  if (scope.patches_) {
    scope.patchListener_(scope.patches_, scope.inversePatches_);
  }
  return result !== NOTHING ? result : void 0;
}
function finalize(rootScope, value, path) {
  if (isFrozen(value)) return value;
  const useStrictIteration = rootScope.immer_.shouldUseStrictIteration();
  const state = value[DRAFT_STATE];
  if (!state) {
    each(
      value,
      (key, childValue) => finalizeProperty(rootScope, state, value, key, childValue, path),
      useStrictIteration
    );
    return value;
  }
  if (state.scope_ !== rootScope) return value;
  if (!state.modified_) {
    maybeFreeze(rootScope, state.base_, true);
    return state.base_;
  }
  if (!state.finalized_) {
    state.finalized_ = true;
    state.scope_.unfinalizedDrafts_--;
    const result = state.copy_;
    let resultEach = result;
    let isSet2 = false;
    if (state.type_ === 3 /* Set */) {
      resultEach = new Set(result);
      result.clear();
      isSet2 = true;
    }
    each(
      resultEach,
      (key, childValue) => finalizeProperty(
        rootScope,
        state,
        result,
        key,
        childValue,
        path,
        isSet2
      ),
      useStrictIteration
    );
    maybeFreeze(rootScope, result, false);
    if (path && rootScope.patches_) {
      getPlugin("Patches").generatePatches_(
        state,
        path,
        rootScope.patches_,
        rootScope.inversePatches_
      );
    }
  }
  return state.copy_;
}
function finalizeProperty(rootScope, parentState, targetObject, prop, childValue, rootPath, targetIsSet) {
  if (childValue == null) {
    return;
  }
  if (typeof childValue !== "object" && !targetIsSet) {
    return;
  }
  const childIsFrozen = isFrozen(childValue);
  if (childIsFrozen && !targetIsSet) {
    return;
  }
  if (false)
    die(5);
  if (isDraft(childValue)) {
    const path = rootPath && parentState && parentState.type_ !== 3 /* Set */ && // Set objects are atomic since they have no keys.
    !has(parentState.assigned_, prop) ? rootPath.concat(prop) : void 0;
    const res = finalize(rootScope, childValue, path);
    set(targetObject, prop, res);
    if (isDraft(res)) {
      rootScope.canAutoFreeze_ = false;
    } else return;
  } else if (targetIsSet) {
    targetObject.add(childValue);
  }
  if (isDraftable(childValue) && !childIsFrozen) {
    if (!rootScope.immer_.autoFreeze_ && rootScope.unfinalizedDrafts_ < 1) {
      return;
    }
    if (parentState && parentState.base_ && parentState.base_[prop] === childValue && childIsFrozen) {
      return;
    }
    finalize(rootScope, childValue);
    if ((!parentState || !parentState.scope_.parent_) && typeof prop !== "symbol" && (isMap(targetObject) ? targetObject.has(prop) : Object.prototype.propertyIsEnumerable.call(targetObject, prop)))
      maybeFreeze(rootScope, childValue);
  }
}
function maybeFreeze(scope, value, deep = false) {
  if (!scope.parent_ && scope.immer_.autoFreeze_ && scope.canAutoFreeze_) {
    freeze(value, deep);
  }
}

// src/modules/client-runtime/vendor/immer/src/core/proxy.ts
function createProxyProxy(base, parent) {
  const isArray = Array.isArray(base);
  const state = {
    type_: isArray ? 1 /* Array */ : 0 /* Object */,
    // Track which produce call this is associated with.
    scope_: parent ? parent.scope_ : getCurrentScope(),
    // True for both shallow and deep changes.
    modified_: false,
    // Used during finalization.
    finalized_: false,
    // Track which properties have been assigned (true) or deleted (false).
    assigned_: {},
    // The parent draft state.
    parent_: parent,
    // The base state.
    base_: base,
    // The base proxy.
    draft_: null,
    // set below
    // The base copy with any updated values.
    copy_: null,
    // Called by the `produce` function.
    revoke_: null,
    isManual_: false
  };
  let target = state;
  let traps = objectTraps;
  if (isArray) {
    target = [state];
    traps = arrayTraps;
  }
  const { revoke, proxy } = Proxy.revocable(target, traps);
  state.draft_ = proxy;
  state.revoke_ = revoke;
  return proxy;
}
var objectTraps = {
  get(state, prop) {
    if (prop === DRAFT_STATE) return state;
    const source = latest(state);
    if (!has(source, prop)) {
      return readPropFromProto(state, source, prop);
    }
    const value = source[prop];
    if (state.finalized_ || !isDraftable(value)) {
      return value;
    }
    if (value === peek(state.base_, prop)) {
      prepareCopy(state);
      return state.copy_[prop] = createProxy(value, state);
    }
    return value;
  },
  has(state, prop) {
    return prop in latest(state);
  },
  ownKeys(state) {
    return Reflect.ownKeys(latest(state));
  },
  set(state, prop, value) {
    const desc = getDescriptorFromProto(latest(state), prop);
    if (desc?.set) {
      desc.set.call(state.draft_, value);
      return true;
    }
    if (!state.modified_) {
      const current2 = peek(latest(state), prop);
      const currentState = current2?.[DRAFT_STATE];
      if (currentState && currentState.base_ === value) {
        state.copy_[prop] = value;
        state.assigned_[prop] = false;
        return true;
      }
      if (is(value, current2) && (value !== void 0 || has(state.base_, prop)))
        return true;
      prepareCopy(state);
      markChanged(state);
    }
    if (state.copy_[prop] === value && // special case: handle new props with value 'undefined'
    (value !== void 0 || prop in state.copy_) || // special case: NaN
    Number.isNaN(value) && Number.isNaN(state.copy_[prop]))
      return true;
    state.copy_[prop] = value;
    state.assigned_[prop] = true;
    return true;
  },
  deleteProperty(state, prop) {
    if (peek(state.base_, prop) !== void 0 || prop in state.base_) {
      state.assigned_[prop] = false;
      prepareCopy(state);
      markChanged(state);
    } else {
      delete state.assigned_[prop];
    }
    if (state.copy_) {
      delete state.copy_[prop];
    }
    return true;
  },
  // Note: We never coerce `desc.value` into an Immer draft, because we can't make
  // the same guarantee in ES5 mode.
  getOwnPropertyDescriptor(state, prop) {
    const owner = latest(state);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc) return desc;
    return {
      writable: true,
      configurable: state.type_ !== 1 /* Array */ || prop !== "length",
      enumerable: desc.enumerable,
      value: owner[prop]
    };
  },
  defineProperty() {
    die(11);
  },
  getPrototypeOf(state) {
    return getPrototypeOf(state.base_);
  },
  setPrototypeOf() {
    die(12);
  }
};
var arrayTraps = {};
each(objectTraps, (key, fn) => {
  arrayTraps[key] = function() {
    arguments[0] = arguments[0][0];
    return fn.apply(this, arguments);
  };
});
arrayTraps.deleteProperty = function(state, prop) {
  if (false)
    die(13);
  return arrayTraps.set.call(this, state, prop, void 0);
};
arrayTraps.set = function(state, prop, value) {
  if (false)
    die(14);
  return objectTraps.set.call(this, state[0], prop, value, state[0]);
};
function peek(draft, prop) {
  const state = draft[DRAFT_STATE];
  const source = state ? latest(state) : draft;
  return source[prop];
}
function readPropFromProto(state, source, prop) {
  const desc = getDescriptorFromProto(source, prop);
  return desc ? `value` in desc ? desc.value : (
    // This is a very special case, if the prop is a getter defined by the
    // prototype, we should invoke it with the draft as context!
    desc.get?.call(state.draft_)
  ) : void 0;
}
function getDescriptorFromProto(source, prop) {
  if (!(prop in source)) return void 0;
  let proto = getPrototypeOf(source);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = getPrototypeOf(proto);
  }
  return void 0;
}
function markChanged(state) {
  if (!state.modified_) {
    state.modified_ = true;
    if (state.parent_) {
      markChanged(state.parent_);
    }
  }
}
function prepareCopy(state) {
  if (!state.copy_) {
    state.copy_ = shallowCopy(
      state.base_,
      state.scope_.immer_.useStrictShallowCopy_
    );
  }
}

// src/modules/client-runtime/vendor/immer/src/core/immerClass.ts
var Immer2 = class {
  constructor(config) {
    this.autoFreeze_ = true;
    this.useStrictShallowCopy_ = false;
    this.useStrictIteration_ = true;
    /**
     * The `produce` function takes a value and a "recipe function" (whose
     * return value often depends on the base state). The recipe function is
     * free to mutate its first argument however it wants. All mutations are
     * only ever applied to a __copy__ of the base state.
     *
     * Pass only a function to create a "curried producer" which relieves you
     * from passing the recipe function every time.
     *
     * Only plain objects and arrays are made mutable. All other objects are
     * considered uncopyable.
     *
     * Note: This function is __bound__ to its `Immer` instance.
     *
     * @param {any} base - the initial state
     * @param {Function} recipe - function that receives a proxy of the base state as first argument and which can be freely modified
     * @param {Function} patchListener - optional function that will be called with all the patches produced here
     * @returns {any} a new state, or the initial state if nothing was modified
     */
    this.produce = (base, recipe, patchListener) => {
      if (typeof base === "function" && typeof recipe !== "function") {
        const defaultBase = recipe;
        recipe = base;
        const self = this;
        return function curriedProduce(base2 = defaultBase, ...args) {
          return self.produce(base2, (draft) => recipe.call(this, draft, ...args));
        };
      }
      if (typeof recipe !== "function") die(6);
      if (patchListener !== void 0 && typeof patchListener !== "function")
        die(7);
      let result;
      if (isDraftable(base)) {
        const scope = enterScope(this);
        const proxy = createProxy(base, void 0);
        let hasError = true;
        try {
          result = recipe(proxy);
          hasError = false;
        } finally {
          if (hasError) revokeScope(scope);
          else leaveScope(scope);
        }
        usePatchesInScope(scope, patchListener);
        return processResult(result, scope);
      } else if (!base || typeof base !== "object") {
        result = recipe(base);
        if (result === void 0) result = base;
        if (result === NOTHING) result = void 0;
        if (this.autoFreeze_) freeze(result, true);
        if (patchListener) {
          const p = [];
          const ip = [];
          getPlugin("Patches").generateReplacementPatches_(base, result, p, ip);
          patchListener(p, ip);
        }
        return result;
      } else die(1, base);
    };
    this.produceWithPatches = (base, recipe) => {
      if (typeof base === "function") {
        return (state, ...args) => this.produceWithPatches(state, (draft) => base(draft, ...args));
      }
      let patches, inversePatches;
      const result = this.produce(base, recipe, (p, ip) => {
        patches = p;
        inversePatches = ip;
      });
      return [result, patches, inversePatches];
    };
    if (typeof config?.autoFreeze === "boolean")
      this.setAutoFreeze(config.autoFreeze);
    if (typeof config?.useStrictShallowCopy === "boolean")
      this.setUseStrictShallowCopy(config.useStrictShallowCopy);
    if (typeof config?.useStrictIteration === "boolean")
      this.setUseStrictIteration(config.useStrictIteration);
  }
  createDraft(base) {
    if (!isDraftable(base)) die(8);
    if (isDraft(base)) base = current(base);
    const scope = enterScope(this);
    const proxy = createProxy(base, void 0);
    proxy[DRAFT_STATE].isManual_ = true;
    leaveScope(scope);
    return proxy;
  }
  finishDraft(draft, patchListener) {
    const state = draft && draft[DRAFT_STATE];
    if (!state || !state.isManual_) die(9);
    const { scope_: scope } = state;
    usePatchesInScope(scope, patchListener);
    return processResult(void 0, scope);
  }
  /**
   * Pass true to automatically freeze all copies created by Immer.
   *
   * By default, auto-freezing is enabled.
   */
  setAutoFreeze(value) {
    this.autoFreeze_ = value;
  }
  /**
   * Pass true to enable strict shallow copy.
   *
   * By default, immer does not copy the object descriptors such as getter, setter and non-enumrable properties.
   */
  setUseStrictShallowCopy(value) {
    this.useStrictShallowCopy_ = value;
  }
  /**
   * Pass false to use faster iteration that skips non-enumerable properties
   * but still handles symbols for compatibility.
   *
   * By default, strict iteration is enabled (includes all own properties).
   */
  setUseStrictIteration(value) {
    this.useStrictIteration_ = value;
  }
  shouldUseStrictIteration() {
    return this.useStrictIteration_;
  }
  applyPatches(base, patches) {
    let i;
    for (i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.path.length === 0 && patch.op === "replace") {
        base = patch.value;
        break;
      }
    }
    if (i > -1) {
      patches = patches.slice(i + 1);
    }
    const applyPatchesImpl = getPlugin("Patches").applyPatches_;
    if (isDraft(base)) {
      return applyPatchesImpl(base, patches);
    }
    return this.produce(
      base,
      (draft) => applyPatchesImpl(draft, patches)
    );
  }
};
function createProxy(value, parent) {
  const draft = isMap(value) ? getPlugin("MapSet").proxyMap_(value, parent) : isSet(value) ? getPlugin("MapSet").proxySet_(value, parent) : createProxyProxy(value, parent);
  const scope = parent ? parent.scope_ : getCurrentScope();
  scope.drafts_.push(draft);
  return draft;
}

// src/modules/client-runtime/vendor/immer/src/core/current.ts
function current(value) {
  if (!isDraft(value)) die(10, value);
  return currentImpl(value);
}
function currentImpl(value) {
  if (!isDraftable(value) || isFrozen(value)) return value;
  const state = value[DRAFT_STATE];
  let copy;
  let strict = true;
  if (state) {
    if (!state.modified_) return state.base_;
    state.finalized_ = true;
    copy = shallowCopy(value, state.scope_.immer_.useStrictShallowCopy_);
    strict = state.scope_.immer_.shouldUseStrictIteration();
  } else {
    copy = shallowCopy(value, true);
  }
  each(
    copy,
    (key, childValue) => {
      set(copy, key, currentImpl(childValue));
    },
    strict
  );
  if (state) {
    state.finalized_ = false;
  }
  return copy;
}

// src/modules/client-runtime/vendor/immer/src/plugins/patches.ts
function enablePatches() {
  const errorOffset = 16;
  if (false) {
    errors.push(
      'Sets cannot have "replace" patches.',
      function(op) {
        return "Unsupported patch operation: " + op;
      },
      function(path) {
        return "Cannot apply patch, path doesn't resolve: " + path;
      },
      "Patching reserved attributes like __proto__, prototype and constructor is not allowed"
    );
  }
  const REPLACE = "replace";
  const ADD = "add";
  const REMOVE = "remove";
  function generatePatches_(state, basePath, patches, inversePatches) {
    switch (state.type_) {
      case 0 /* Object */:
      case 2 /* Map */:
        return generatePatchesFromAssigned(
          state,
          basePath,
          patches,
          inversePatches
        );
      case 1 /* Array */:
        return generateArrayPatches(state, basePath, patches, inversePatches);
      case 3 /* Set */:
        return generateSetPatches(
          state,
          basePath,
          patches,
          inversePatches
        );
    }
  }
  function generateArrayPatches(state, basePath, patches, inversePatches) {
    let { base_, assigned_ } = state;
    let copy_ = state.copy_;
    if (copy_.length < base_.length) {
      ;
      [base_, copy_] = [copy_, base_];
      [patches, inversePatches] = [inversePatches, patches];
    }
    for (let i = 0; i < base_.length; i++) {
      if (assigned_[i] && copy_[i] !== base_[i]) {
        const path = basePath.concat([i]);
        patches.push({
          op: REPLACE,
          path,
          // Need to maybe clone it, as it can in fact be the original value
          // due to the base/copy inversion at the start of this function
          value: clonePatchValueIfNeeded(copy_[i])
        });
        inversePatches.push({
          op: REPLACE,
          path,
          value: clonePatchValueIfNeeded(base_[i])
        });
      }
    }
    for (let i = base_.length; i < copy_.length; i++) {
      const path = basePath.concat([i]);
      patches.push({
        op: ADD,
        path,
        // Need to maybe clone it, as it can in fact be the original value
        // due to the base/copy inversion at the start of this function
        value: clonePatchValueIfNeeded(copy_[i])
      });
    }
    for (let i = copy_.length - 1; base_.length <= i; --i) {
      const path = basePath.concat([i]);
      inversePatches.push({
        op: REMOVE,
        path
      });
    }
  }
  function generatePatchesFromAssigned(state, basePath, patches, inversePatches) {
    const { base_, copy_ } = state;
    each(state.assigned_, (key, assignedValue) => {
      const origValue = get(base_, key);
      const value = get(copy_, key);
      const op = !assignedValue ? REMOVE : has(base_, key) ? REPLACE : ADD;
      if (origValue === value && op === REPLACE) return;
      const path = basePath.concat(key);
      patches.push(op === REMOVE ? { op, path } : { op, path, value });
      inversePatches.push(
        op === ADD ? { op: REMOVE, path } : op === REMOVE ? { op: ADD, path, value: clonePatchValueIfNeeded(origValue) } : { op: REPLACE, path, value: clonePatchValueIfNeeded(origValue) }
      );
    });
  }
  function generateSetPatches(state, basePath, patches, inversePatches) {
    let { base_, copy_ } = state;
    let i = 0;
    base_.forEach((value) => {
      if (!copy_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: REMOVE,
          path,
          value
        });
        inversePatches.unshift({
          op: ADD,
          path,
          value
        });
      }
      i++;
    });
    i = 0;
    copy_.forEach((value) => {
      if (!base_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: ADD,
          path,
          value
        });
        inversePatches.unshift({
          op: REMOVE,
          path,
          value
        });
      }
      i++;
    });
  }
  function generateReplacementPatches_(baseValue, replacement, patches, inversePatches) {
    patches.push({
      op: REPLACE,
      path: [],
      value: replacement === NOTHING ? void 0 : replacement
    });
    inversePatches.push({
      op: REPLACE,
      path: [],
      value: baseValue
    });
  }
  function applyPatches_(draft, patches) {
    patches.forEach((patch) => {
      const { path, op } = patch;
      let base = draft;
      for (let i = 0; i < path.length - 1; i++) {
        const parentType = getArchtype(base);
        let p = path[i];
        if (typeof p !== "string" && typeof p !== "number") {
          p = "" + p;
        }
        if ((parentType === 0 /* Object */ || parentType === 1 /* Array */) && (p === "__proto__" || p === "constructor"))
          die(errorOffset + 3);
        if (typeof base === "function" && p === "prototype")
          die(errorOffset + 3);
        base = get(base, p);
        if (typeof base !== "object") die(errorOffset + 2, path.join("/"));
      }
      const type = getArchtype(base);
      const value = deepClonePatchValue(patch.value);
      const key = path[path.length - 1];
      switch (op) {
        case REPLACE:
          switch (type) {
            case 2 /* Map */:
              return base.set(key, value);
            /* istanbul ignore next */
            case 3 /* Set */:
              die(errorOffset);
            default:
              return base[key] = value;
          }
        case ADD:
          switch (type) {
            case 1 /* Array */:
              return key === "-" ? base.push(value) : base.splice(key, 0, value);
            case 2 /* Map */:
              return base.set(key, value);
            case 3 /* Set */:
              return base.add(value);
            default:
              return base[key] = value;
          }
        case REMOVE:
          switch (type) {
            case 1 /* Array */:
              return base.splice(key, 1);
            case 2 /* Map */:
              return base.delete(key);
            case 3 /* Set */:
              return base.delete(patch.value);
            default:
              return delete base[key];
          }
        default:
          die(errorOffset + 1, op);
      }
    });
    return draft;
  }
  function deepClonePatchValue(obj) {
    if (!isDraftable(obj)) return obj;
    if (Array.isArray(obj)) return obj.map(deepClonePatchValue);
    if (isMap(obj))
      return new Map(
        Array.from(obj.entries()).map(([k, v]) => [k, deepClonePatchValue(v)])
      );
    if (isSet(obj)) return new Set(Array.from(obj).map(deepClonePatchValue));
    const cloned = Object.create(getPrototypeOf(obj));
    for (const key in obj) cloned[key] = deepClonePatchValue(obj[key]);
    if (has(obj, DRAFTABLE)) cloned[DRAFTABLE] = obj[DRAFTABLE];
    return cloned;
  }
  function clonePatchValueIfNeeded(obj) {
    if (isDraft(obj)) {
      return deepClonePatchValue(obj);
    } else return obj;
  }
  loadPlugin("Patches", {
    applyPatches_,
    generatePatches_,
    generateReplacementPatches_
  });
}

// src/modules/client-runtime/vendor/immer/src/plugins/mapset.ts
function enableMapSet() {
  class DraftMap extends Map {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 2 /* Map */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        assigned_: void 0,
        base_: target,
        draft_: this,
        isManual_: false,
        revoked_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(key) {
      return latest(this[DRAFT_STATE]).has(key);
    }
    set(key, value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!latest(state).has(key) || latest(state).get(key) !== value) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_.set(key, true);
        state.copy_.set(key, value);
        state.assigned_.set(key, true);
      }
      return this;
    }
    delete(key) {
      if (!this.has(key)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareMapCopy(state);
      markChanged(state);
      if (state.base_.has(key)) {
        state.assigned_.set(key, false);
      } else {
        state.assigned_.delete(key);
      }
      state.copy_.delete(key);
      return true;
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_ = /* @__PURE__ */ new Map();
        each(state.base_, (key) => {
          state.assigned_.set(key, false);
        });
        state.copy_.clear();
      }
    }
    forEach(cb, thisArg) {
      const state = this[DRAFT_STATE];
      latest(state).forEach((_value, key, _map) => {
        cb.call(thisArg, this.get(key), key, this);
      });
    }
    get(key) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      const value = latest(state).get(key);
      if (state.finalized_ || !isDraftable(value)) {
        return value;
      }
      if (value !== state.base_.get(key)) {
        return value;
      }
      const draft = createProxy(value, state);
      prepareMapCopy(state);
      state.copy_.set(key, draft);
      return draft;
    }
    keys() {
      return latest(this[DRAFT_STATE]).keys();
    }
    values() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.values(),
        next: () => {
          const r = iterator.next();
          if (r.done) return r;
          const value = this.get(r.value);
          return {
            done: false,
            value
          };
        }
      };
    }
    entries() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.entries(),
        next: () => {
          const r = iterator.next();
          if (r.done) return r;
          const value = this.get(r.value);
          return {
            done: false,
            value: [r.value, value]
          };
        }
      };
    }
    [(DRAFT_STATE, Symbol.iterator)]() {
      return this.entries();
    }
  }
  function proxyMap_(target, parent) {
    return new DraftMap(target, parent);
  }
  function prepareMapCopy(state) {
    if (!state.copy_) {
      state.assigned_ = /* @__PURE__ */ new Map();
      state.copy_ = new Map(state.base_);
    }
  }
  class DraftSet extends Set {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 3 /* Set */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        base_: target,
        draft_: this,
        drafts_: /* @__PURE__ */ new Map(),
        revoked_: false,
        isManual_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!state.copy_) {
        return state.base_.has(value);
      }
      if (state.copy_.has(value)) return true;
      if (state.drafts_.has(value) && state.copy_.has(state.drafts_.get(value)))
        return true;
      return false;
    }
    add(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!this.has(value)) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.add(value);
      }
      return this;
    }
    delete(value) {
      if (!this.has(value)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      markChanged(state);
      return state.copy_.delete(value) || (state.drafts_.has(value) ? state.copy_.delete(state.drafts_.get(value)) : (
        /* istanbul ignore next */
        false
      ));
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.clear();
      }
    }
    values() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.values();
    }
    entries() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.entries();
    }
    keys() {
      return this.values();
    }
    [(DRAFT_STATE, Symbol.iterator)]() {
      return this.values();
    }
    forEach(cb, thisArg) {
      const iterator = this.values();
      let result = iterator.next();
      while (!result.done) {
        cb.call(thisArg, result.value, result.value, this);
        result = iterator.next();
      }
    }
  }
  function proxySet_(target, parent) {
    return new DraftSet(target, parent);
  }
  function prepareSetCopy(state) {
    if (!state.copy_) {
      state.copy_ = /* @__PURE__ */ new Set();
      state.base_.forEach((value) => {
        if (isDraftable(value)) {
          const draft = createProxy(value, state);
          state.drafts_.set(value, draft);
          state.copy_.add(draft);
        } else {
          state.copy_.add(value);
        }
      });
    }
  }
  function assertUnrevoked(state) {
    if (state.revoked_) die(3, JSON.stringify(latest(state)));
  }
  loadPlugin("MapSet", { proxyMap_, proxySet_ });
}

// src/modules/client-runtime/vendor/immer/src/immer.ts
var immer = new Immer2();
var produce = immer.produce;
var produceWithPatches = /* @__PURE__ */ immer.produceWithPatches.bind(
  immer
);
var setAutoFreeze = /* @__PURE__ */ immer.setAutoFreeze.bind(immer);
var setUseStrictShallowCopy = /* @__PURE__ */ immer.setUseStrictShallowCopy.bind(
  immer
);
var setUseStrictIteration = /* @__PURE__ */ immer.setUseStrictIteration.bind(
  immer
);
var applyPatches = /* @__PURE__ */ immer.applyPatches.bind(immer);
var createDraft = /* @__PURE__ */ immer.createDraft.bind(immer);
var finishDraft = /* @__PURE__ */ immer.finishDraft.bind(immer);
function castDraft(value) {
  return value;
}
function castImmutable(value) {
  return value;
}

},
"src/modules/assistant/contracts.js": function(module, exports, require) {
// source: src/modules/assistant/contracts.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSISTANT_OPEN = void 0;
exports.assistantReference = assistantReference;
exports.openAssistant = openAssistant;
exports.ASSISTANT_OPEN = 'xharness:assistant:open';
function assistantReference(value) {
    if (typeof value !== 'object' || value === null || !('key' in value) || !('text' in value))
        return null;
    const { key, text } = value;
    if (typeof key !== 'string' || !key || key.length > 8000 || /[\x00-\x1f]/.test(key)
        || typeof text !== 'string' || !text.trim() || text.length > 8000 || text.includes('\0'))
        return null;
    return { key, text };
}
function openAssistant(reference) {
    if (reference && !assistantReference(reference))
        throw new Error('Reference is invalid or exceeds the context limit');
    window.dispatchEvent(new CustomEvent(exports.ASSISTANT_OPEN, { detail: reference ?? null }));
}

},
"src/modules/assistant/Assistant.css": function(module, exports, require) {
// source: src/modules/assistant/Assistant.css

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = ".xhassistant-nav{box-sizing:border-box;display:flex;justify-content:flex-start;align-items:center;gap:8px;min-width:0;height:38px;margin:0;padding:7px 12px;border:0;box-shadow:none;border-radius:12px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:500;line-height:22px;cursor:pointer;width:100%;white-space:nowrap;overflow:hidden}.xhassistant-nav:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhassistant-nav svg{flex:none}.xhassistant-nav:not(:has(span)){justify-content:center;margin:0;padding:0;width:36px;height:36px;border-color:transparent;background:none}.xhassistant-nav:not(:has(span)):hover{background:var(--dsw-alias-interactive-bg-hover)}.xhassistant{flex:none;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.xhassistant>header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhassistant-title,.xhassistant-controls,.xhassistant-references{display:flex;align-items:center;gap:10px}.xhassistant-controls{flex-wrap:wrap;justify-content:flex-end}.xhassistant button,.xhassistant select{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);padding:7px 12px;cursor:pointer}.xhassistant button:disabled{opacity:.5;cursor:default}.xhassistant button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.xhassistant>p[role=alert]{margin:12px 24px;color:var(--dsw-alias-label-primary)}.xhassistant-references{padding:10px 24px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}.xhassistant-setup{display:flex;align-items:center;flex-direction:column;gap:14px;padding:clamp(28px,8vh,100px) 24px;text-align:center}.xhassistant-setup h2{margin:0;font-size:22px;font-weight:600}.xhassistant-setup p{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px}.xhassistant-setup label{display:flex;flex-direction:column;gap:8px;min-width:260px;text-align:left;font-size:13px}.xhassistant-setup select{max-width:min(480px,80vw)}.xhassistant-task-list{max-height:260px;overflow-y:auto;padding:8px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhassistant-task-list>button{display:flex;justify-content:space-between;gap:16px;width:100%;border:0;text-align:left;margin:3px 0}.xhassistant-task-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhassistant-task-list small{flex:none;color:var(--dsw-alias-label-secondary)}@media(max-width:700px){.xhassistant>header{padding:12px 16px;align-items:flex-start}.xhassistant-controls{font-size:12px}.xhassistant-references{padding:10px 16px}}\n";

},
"src/modules/assistant/OrbitIcon.js": function(module, exports, require) {
// source: src/modules/assistant/OrbitIcon.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrbitIcon = OrbitIcon;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Phosphor Icons atom (bold), unchanged path, MIT.
 * Source: https://github.com/phosphor-icons/core/blob/2b75f3ad12b420c9504ef05df8d2564a28f8500e/assets/bold/atom-bold.svg
 * Copyright (c) 2023 Phosphor Icons. License retained in PHOSPHOR-LICENSE.txt.
 * Optical framing trims empty canvas for legibility at 16px; no path changes.
 * Presentational only: the containing button supplies the accessible name.
 */
function OrbitIcon({ size }) {
    return (0, jsx_runtime_1.jsx)("svg", { "data-little-x-orbit": "", "aria-hidden": "true", focusable: "false", xmlns: "http://www.w3.org/2000/svg", viewBox: "24 24 208 208", width: size, height: size, fill: "currentColor", children: (0, jsx_runtime_1.jsx)("path", { d: "M219.23,159.2a196.66,196.66,0,0,0-18-31.2,196.66,196.66,0,0,0,18-31.2c11.84-26.31,11.69-47.48-.43-59.6s-33.29-12.27-59.6-.43a196.66,196.66,0,0,0-31.2,18,196.66,196.66,0,0,0-31.2-18c-26.31-11.84-47.48-11.69-59.6.43s-12.27,33.29-.43,59.6a196.66,196.66,0,0,0,18,31.2,196.66,196.66,0,0,0-18,31.2c-11.84,26.31-11.69,47.48.43,59.6h0C43.33,224.93,51.78,228,62,228c10,0,21.77-2.92,34.76-8.77a196.66,196.66,0,0,0,31.2-18,196.66,196.66,0,0,0,31.2,18c13,5.85,24.74,8.77,34.76,8.77,10.26,0,18.71-3.07,24.84-9.2h0C230.92,206.68,231.07,185.51,219.23,159.2Zm-17.41-105c5.25,5.26,1.79,26-16,53.78-5.61-6.66-11.65-13.25-18.07-19.67S154.7,75.83,148,70.22C175.82,52.39,196.56,48.93,201.82,54.18ZM171.24,128a288.6,288.6,0,0,1-20.51,22.73A288.6,288.6,0,0,1,128,171.24a288.6,288.6,0,0,1-22.73-20.51A288.6,288.6,0,0,1,84.76,128,298.55,298.55,0,0,1,128,84.76a286.83,286.83,0,0,1,22.73,20.51A286.83,286.83,0,0,1,171.24,128ZM54.18,54.18c1.46-1.45,4.1-2.24,7.75-2.24,9.53,0,25.94,5.39,46,18.28-6.66,5.61-13.25,11.65-19.67,18.07S75.83,101.3,70.22,108C52.39,80.18,48.93,59.44,54.18,54.18Zm0,147.64c-5.25-5.26-1.79-26,16-53.78,5.61,6.66,11.65,13.25,18.07,19.67s13,12.46,19.67,18.07C80.18,203.61,59.44,207.07,54.18,201.82Zm147.64,0c-5.26,5.25-26,1.79-53.78-16,6.66-5.61,13.25-11.65,19.67-18.07s12.46-13,18.07-19.67C203.61,175.82,207.07,196.56,201.82,201.82ZM144,128a16,16,0,1,1-16-16A16,16,0,0,1,144,128Z" }) });
}

}
};
const __dependencies = {"src/modules/assistant/index.js":{"../shared/shell-route":"src/modules/shared/shell-route.js","./service":"src/modules/assistant/service.js","./contracts":"src/modules/assistant/contracts.js","./Assistant.css":"src/modules/assistant/Assistant.css","./OrbitIcon":"src/modules/assistant/OrbitIcon.js"},"src/modules/shared/shell-route.js":{},"src/modules/assistant/service.js":{"../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","../client-runtime/contract/store":"src/modules/client-runtime/contract/store.js"},"src/modules/client-connection/contracts/core/session/types.js":{},"src/modules/client-runtime/contract/store.js":{"./state-engine":"src/modules/client-runtime/contract/state-engine.js","immer":"vendor/immer.js","../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/contract/state-engine.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/value-guards.js":{},"vendor/immer.js":{},"src/modules/assistant/contracts.js":{},"src/modules/assistant/Assistant.css":{},"src/modules/assistant/OrbitIcon.js":{}};
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
return __load("src/modules/assistant/index.js");
}
});
