// Generated from src/modules/client-runtime/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-runtime",
factory: (__externalRequire) => {
const __units = {
"src/modules/client-runtime/index.js": function(module, exports, require) {
// source: src/modules/client-runtime/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.PendingWait = exports.displayFailureMessage = exports.sessionRecallLabels = exports.contextProvenance = exports.contextForm = exports.isTokenDelta = exports.emptyAssistantBlock = exports.publishChatSnapshot = exports.toAssistantBlocks = exports.toAssistantBlock = exports.EMPTY_CONVERSATION_VIEWS = exports.EMPTY_CHAT_SNAPSHOT = exports.shallowEqual = exports.defineStore = exports.createSnapshotStore = exports.resolveWorkspacePath = exports.abbreviateHomePath = exports.WorkspaceRuntime = exports.WorkspaceCreateError = exports.DirectoryBrowseError = exports.createScope = exports.SessionProvideChannel = exports.indexSubagentDescendants = exports.workspaceTitleOf = exports.scopeOf = exports.SessionRuntime = exports.SessionCreateError = exports.conversationContextKey = exports.ConversationLocationIndex = exports.ConversationNodeAssembler = exports.ConversationViewRegistry = exports.ConversationEventRegistry = exports.SlotRegistry = exports.isReplacementSurfaceEvent = exports.isAppendSurfaceEvent = void 0;
exports.apply = apply;
const slots_1 = require("./slots");
const service_1 = require("./sessions/service");
const service_2 = require("./workspaces/service");
const event_registry_1 = require("./conversation/event-registry");
const view_registry_1 = require("./conversation/view-registry");
const catalog_1 = require("./work/catalog");
var surface_1 = require("../client-connection/contracts/core/session/surface");
Object.defineProperty(exports, "isAppendSurfaceEvent", { enumerable: true, get: function () { return surface_1.isAppendSurfaceEvent; } });
Object.defineProperty(exports, "isReplacementSurfaceEvent", { enumerable: true, get: function () { return surface_1.isReplacementSurfaceEvent; } });
var slots_2 = require("./slots");
Object.defineProperty(exports, "SlotRegistry", { enumerable: true, get: function () { return slots_2.SlotRegistry; } });
var event_registry_2 = require("./conversation/event-registry");
Object.defineProperty(exports, "ConversationEventRegistry", { enumerable: true, get: function () { return event_registry_2.ConversationEventRegistry; } });
var view_registry_2 = require("./conversation/view-registry");
Object.defineProperty(exports, "ConversationViewRegistry", { enumerable: true, get: function () { return view_registry_2.ConversationViewRegistry; } });
var conversation_assembler_1 = require("./sessions/conversation-assembler");
Object.defineProperty(exports, "ConversationNodeAssembler", { enumerable: true, get: function () { return conversation_assembler_1.ConversationNodeAssembler; } });
var conversation_location_index_1 = require("./sessions/conversation-location-index");
Object.defineProperty(exports, "ConversationLocationIndex", { enumerable: true, get: function () { return conversation_location_index_1.ConversationLocationIndex; } });
var conversation_1 = require("./contract/conversation");
Object.defineProperty(exports, "conversationContextKey", { enumerable: true, get: function () { return conversation_1.conversationContextKey; } });
var service_3 = require("./sessions/service");
Object.defineProperty(exports, "SessionCreateError", { enumerable: true, get: function () { return service_3.SessionCreateError; } });
Object.defineProperty(exports, "SessionRuntime", { enumerable: true, get: function () { return service_3.SessionRuntime; } });
Object.defineProperty(exports, "scopeOf", { enumerable: true, get: function () { return service_3.scopeOf; } });
Object.defineProperty(exports, "workspaceTitleOf", { enumerable: true, get: function () { return service_3.workspaceTitleOf; } });
var subagent_lineage_1 = require("./sessions/subagent-lineage");
Object.defineProperty(exports, "indexSubagentDescendants", { enumerable: true, get: function () { return subagent_lineage_1.indexSubagentDescendants; } });
// The provide channel is shared with the client test runtime (one
// materialization/projection implementation; no test-side mirror to drift).
var provide_1 = require("./sessions/provide");
Object.defineProperty(exports, "SessionProvideChannel", { enumerable: true, get: function () { return provide_1.SessionProvideChannel; } });
var scope_1 = require("./agents/scope");
Object.defineProperty(exports, "createScope", { enumerable: true, get: function () { return scope_1.createScope; } });
var service_4 = require("./workspaces/service");
Object.defineProperty(exports, "DirectoryBrowseError", { enumerable: true, get: function () { return service_4.DirectoryBrowseError; } });
Object.defineProperty(exports, "WorkspaceCreateError", { enumerable: true, get: function () { return service_4.WorkspaceCreateError; } });
Object.defineProperty(exports, "WorkspaceRuntime", { enumerable: true, get: function () { return service_4.WorkspaceRuntime; } });
var path_1 = require("./workspaces/path");
Object.defineProperty(exports, "abbreviateHomePath", { enumerable: true, get: function () { return path_1.abbreviateHomePath; } });
Object.defineProperty(exports, "resolveWorkspacePath", { enumerable: true, get: function () { return path_1.resolveWorkspacePath; } });
// Runtime owns the snapshot store; ui-renderer only binds it to React.
var store_1 = require("./contract/store");
Object.defineProperty(exports, "createSnapshotStore", { enumerable: true, get: function () { return store_1.createSnapshotStore; } });
Object.defineProperty(exports, "defineStore", { enumerable: true, get: function () { return store_1.defineStore; } });
Object.defineProperty(exports, "shallowEqual", { enumerable: true, get: function () { return store_1.shallowEqual; } });
var conversation_2 = require("./sessions/conversation");
Object.defineProperty(exports, "EMPTY_CHAT_SNAPSHOT", { enumerable: true, get: function () { return conversation_2.EMPTY_CHAT_SNAPSHOT; } });
Object.defineProperty(exports, "EMPTY_CONVERSATION_VIEWS", { enumerable: true, get: function () { return conversation_2.EMPTY_CONVERSATION_VIEWS; } });
Object.defineProperty(exports, "toAssistantBlock", { enumerable: true, get: function () { return conversation_2.toAssistantBlock; } });
Object.defineProperty(exports, "toAssistantBlocks", { enumerable: true, get: function () { return conversation_2.toAssistantBlocks; } });
Object.defineProperty(exports, "publishChatSnapshot", { enumerable: true, get: function () { return conversation_2.publishChatSnapshot; } });
var partial_1 = require("./sessions/partial");
Object.defineProperty(exports, "emptyAssistantBlock", { enumerable: true, get: function () { return partial_1.emptyAssistantBlock; } });
var assistant_timing_1 = require("./sessions/assistant-timing");
Object.defineProperty(exports, "isTokenDelta", { enumerable: true, get: function () { return assistant_timing_1.isTokenDelta; } });
var context_provenance_1 = require("./sessions/context-provenance");
Object.defineProperty(exports, "contextForm", { enumerable: true, get: function () { return context_provenance_1.contextForm; } });
Object.defineProperty(exports, "contextProvenance", { enumerable: true, get: function () { return context_provenance_1.contextProvenance; } });
Object.defineProperty(exports, "sessionRecallLabels", { enumerable: true, get: function () { return context_provenance_1.sessionRecallLabels; } });
var failure_display_1 = require("./sessions/failure-display");
Object.defineProperty(exports, "displayFailureMessage", { enumerable: true, get: function () { return failure_display_1.displayFailureMessage; } });
var pending_1 = require("./sessions/pending");
Object.defineProperty(exports, "PendingWait", { enumerable: true, get: function () { return pending_1.PendingWait; } });
/** Required services: the wire handle and Client Typert registry. */
exports.inject = ['connection', 'typert', 'remote', 'remote.commands'];
/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
 */
function apply(ctx) {
    ctx.plugin(slots_1.SlotRegistry);
    const conversation = {
        events: new event_registry_1.ConversationEventRegistry(ctx),
        views: new view_registry_1.ConversationViewRegistry(ctx),
    };
    const connection = ctx.get('connection');
    if (connection === undefined)
        throw new Error('runtime: connection service is unavailable');
    const sessions = new service_1.SessionRuntime(ctx, connection.api, ctx.remote, conversation);
    ctx.typert.contexts.registerClient('agent', {
        identity: candidate => sessions.scopeOf(candidate),
    });
    const workspaces = new service_2.WorkspaceRuntime(ctx, connection.api, sessions);
    const workCatalog = new catalog_1.WorkCatalog(connection.api, sessions, workspaces);
    ctx.reflect.provide('workCatalog', workCatalog, undefined);
    ctx.effect(() => () => workCatalog.dispose(), 'runtime: Work catalog projection');
    ctx.effect(() => workspaces.startInitialSelection(), 'runtime: initial Workspace selection');
    const loop = connection.start({
        onMuxEnvelope: (envelope) => {
            sessions.handleMuxEnvelope(envelope);
        },
        onHostEnvelope: (envelope) => {
            sessions.handleHostEnvelope(envelope);
            workspaces.handleHostEnvelope(envelope);
            // Forwarded-event bridge: the session layer ignores registry frames (no
            // session routing). This plugin owns the frame sink, so it hands the
            // decoded frame straight to the Remote service, which fans it out to
            // `ctx.remote.$on` subscribers; no consumer reads a frame.
            const frame = envelope.payload;
            if (frame.type === 'host/remote-event')
                ctx.remote.$dispatch(frame.event, frame.args);
        },
        onConnected: () => {
            sessions.handleConnected();
            workspaces.handleConnected();
            ctx.emit('connection/reset');
        },
        onStateChange: (state) => {
            // Generation death fires before any next-generation frame can arrive
            // (reconnect replays flow from stream open, ahead of onConnected):
            // the only safe moment to drop generation-scoped interaction state.
            if (state === 'reconnecting') {
                sessions.handleDisconnected();
            }
        },
    });
    ctx.effect(() => () => { loop.stop(); }, 'runtime: connection stream loop');
}

},
"src/modules/client-runtime/slots.js": function(module, exports, require) {
// source: src/modules/client-runtime/slots.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlotRegistry = void 0;
const value_guards_1 = require("./value-guards");
/**
 * SlotRegistry: the cordis Service layer of the slot system over the pure
 * SlotCore (ui-slots owns registration semantics, the declaration ledger,
 * the load-time validations, and the unload cascade). This layer owns what
 * needs the runtime: the 'slots/changed' event bridge, register and
 * declaration injection through the caller's ctx.effect (fiber unload
 * collects both), the renderer installation contract (install()/renderSlot('root') +
 * the SlotRendererHost face), and the store INSTANCE axis — handle x scope
 * key -> create/cache, dropped with the last holding entry, session instances
 * cleared (with persisted state) on scope death.
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern: SlotMap only
 * holds this package's 'root' row in this compilation unit, but consumers
 * merge keys in; the rule fires on the narrow-map view, not on real
 * redundancy. */
const context_1 = require("./context");
const dsh_client_ui_slots_1 = require("@xharness/dsh-client-ui-slots");
/** Instance key for root-scoped store records (session records key by session id, so the literal cannot collide). */
const ROOT_INSTANCE_KEY = 'root';
/** cordis Service layer of the slot system; see the module doc for the split with SlotCore. */
class SlotRegistry extends context_1.Service {
    /**
     * @param ctx - owning root context.
     */
    constructor(ctx) {
        super(ctx, 'slots');
        this._core = new dsh_client_ui_slots_1.SlotCore();
        /** Store-instance axis: handle -> mounted scope, refcount, resolved instances. */
        this._stores = new Map();
        this._core.onMutate((key) => { ctx.emit('slots/changed', key); });
    }
    /**
     * Install an effect for each declaration lifetime of a slot. The callback
     * runs synchronously when the declaration already exists; otherwise it runs
     * inside the declaring `register()` call after the declaration is committed.
     * Collapse disposes the effect and a later declaration runs it again.
     * Callback effects are synchronous disposers; iterable effects install
     * transactionally and dispose in reverse order. The controller belongs to
     * the caller's fiber, so plugin unload cancels a pending wait and removes any
     * active contribution.
     *
     * @param key - declared SlotMap key to depend on.
     * @param callback - creates one disposer or an iterable of disposers.
     * @returns idempotent disposer for the wait and active effect.
     * @throws callback setup failures synchronously when the slot is already declared.
     */
    inject(key, callback) {
        const ctx = this.runtimeCtx;
        const disposeController = ctx.effect(() => {
            let active;
            let activeEpoch;
            let stopped = false;
            let unsubscribe = () => { };
            const stop = () => {
                if (stopped)
                    return;
                // Failure callers retire the injection permanently: a delayed setup
                // failure never retries on a later declaration.
                stopped = true;
                unsubscribe();
                const dispose = active;
                active = undefined;
                activeEpoch = undefined;
                dispose?.();
            };
            const reconcile = () => {
                if (stopped)
                    return;
                const spec = this._core.specDynamic(key);
                const epoch = this._core.declarationEpoch(key);
                if (active !== undefined && activeEpoch === epoch)
                    return;
                const dispose = active;
                active = undefined;
                activeEpoch = undefined;
                dispose?.();
                if (spec === undefined)
                    return;
                // A declaration lifetime is a nested Cordis effect. This gives
                // generator callbacks the same transactional setup, reverse teardown,
                // diagnostics tree, and idempotence as every other plugin effect.
                const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
                active = () => { void disposeEffect(); };
                activeEpoch = epoch;
            };
            const changed = () => {
                try {
                    reconcile();
                }
                catch (error) {
                    if ((0, value_guards_1.isRecord)(error) && error.code === 'INACTIVE_EFFECT') {
                        stop();
                        return;
                    }
                    stop();
                    const failure = error instanceof Error ? error : new Error(String(error));
                    queueMicrotask(() => { throw failure; });
                }
            };
            unsubscribe = this._core.subscribeDeclaration(key, changed);
            try {
                reconcile();
            }
            catch (error) {
                stop();
                throw error;
            }
            return stop;
        }, `slots.inject(${JSON.stringify(key)})`);
        return () => { void disposeController(); };
    }
    /**
     * Install the shell's renderer (ui-renderer's createSlotRenderer product).
     * Boot-once: a second install throws. Runs through the caller's ctx.effect,
     * so shell fiber unload uninstalls the renderer.
     * @param renderer - the outlet machinery implementing SlotRenderer.
     */
    install(renderer) {
        if (this._renderer !== undefined)
            throw new Error('slot renderer already installed (install() is boot-once)');
        this.runtimeCtx.effect(() => {
            this._renderer = renderer;
            return () => {
                if (this._renderer === renderer)
                    this._renderer = undefined;
            };
        }, 'slots.install()');
    }
    /**
     * Install the locale face backing the `t` standard seat (the locale
     * plugin's product; same boot-once discipline as the renderer install).
     * Runs through the caller's ctx.effect, so the installing fiber's unload
     * uninstalls the face.
     * @param face - namespace binder + revision observable.
     */
    installLocale(face) {
        if (this._locale !== undefined)
            throw new Error('locale face already installed (installLocale() is boot-once)');
        this.runtimeCtx.effect(() => {
            this._locale = face;
            return () => {
                if (this._locale === face)
                    this._locale = undefined;
            };
        }, 'slots.installLocale()');
    }
    /**
     * The single ctx-level render entry: the shell renders 'root'; every other
     * key renders inside components through the props renderSlot face. All
     * three guards are fail-loud boot-order checks, no fallback.
     * @param key - must be 'root' (runtime-enforced for dynamically composed callers).
     * @param owner - owner share for the root entry (the shell supplies {}).
     * @returns the rendered root tree.
     */
    renderSlot(key, owner) {
        // Widened: in this package's own program SlotMap holds only 'root', which
        // would fold the guard to constant-false; the check exists for plain-JS
        // and cross-program callers where K is wider.
        if (key !== 'root') {
            throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`);
        }
        if (this._renderer === undefined) {
            throw new Error("slot renderer not installed — boot must call ctx.slots.install(createSlotRenderer()) before rendering 'root'");
        }
        if (this._core.entries('root').length === 0) {
            throw new Error("'root' has no registration — a layout entry must register into 'root' before the shell renders it");
        }
        return this._renderer.renderRoot(this.hostFace(), owner);
    }
    /**
     * Drop the per-session store instances of a dead session (the sessions
     * service calls this on scope teardown; root-scoped records are untouched).
     * Persisted state goes with the session — a never-rendered dead session can
     * still own keys from an earlier page load, so the instance is materialized
     * transiently just to clear storage (no-op for unpersisted stores).
     * @param sessionId - the torn-down session.
     */
    pruneStoreScope(sessionId) {
        for (const [handle, record] of this._stores) {
            if (record.scope !== 'session')
                continue;
            const instance = record.instances.get(sessionId) ?? handle.create(sessionId);
            instance.clearPersisted();
            record.instances.delete(sessionId);
        }
    }
    /**
     * Snapshot entries for a key (render-erased view; stable reference between mutations).
     * @param key - SlotMap key.
     * @returns registered entries.
     */
    entries(key) {
        return this._core.entries(key);
    }
    /**
     * Shadowing winners per cell for a key: the first live (non-abdicated)
     * entry of each cell in priority order — what outlets render; chain keys
     * pass through unchanged (election consumes every entry). The raw
     * {@link SlotsService.entries} view stays the inspection surface. Fresh
     * array per call, not a uSES getSnapshot source.
     * @param key - SlotMap key.
     * @returns the winning entry per occupied cell.
     */
    entriesOfSlot(key) {
        return this._core.entriesOfSlot(key);
    }
    /**
     * Export the current JSON-safe Slot declaration tree for read-only inspection.
     * @param root - exact live Slot root; omitted returns all roots.
     * @returns selected Slot trees.
     */
    snapshot(root) {
        return this._core.snapshot(root);
    }
    /**
     * Observe entry boundary crashes (every render-time entry failure the
     * boundaries contain, abdicating or not) — the supervision seam for
     * plugins mirroring contribution health. Fires synchronously per report,
     * after the registry mutated for abdicating crashes. Callers own the
     * disposer (wire it through ctx.effect for fiber-lifetime cleanup, as with
     * {@link SlotsService.subscribe}).
     * @param fn - called with the slot key, the crashed entry, the crash
     * cause, and `abdicated`: whether the crash retired the entry from its cell.
     * @returns unsubscribe.
     */
    onEntryError(fn) {
        return this._core.onEntryError(fn);
    }
    /**
     * Look up a declared spec (register-declared or the built-in 'root').
     * @param key - SlotMap key.
     * @returns spec or undefined.
     */
    spec(key) {
        return this._core.spec(key);
    }
    /**
     * Subscribe to a key's registration changes (microtask-batched).
     * @param key - SlotMap key.
     * @param fn - change callback.
     * @returns unsubscribe.
     */
    subscribe(key, fn) {
        return this._core.subscribe(key, fn);
    }
    /**
     * Version counter for uSES pairing.
     * @param key - SlotMap key.
     * @returns current version.
     */
    getVersion(key) {
        return this._core.getVersion(key);
    }
    /** Delegating registration path: factory minting + registrant stamp + core write + instance-axis bookkeeping. */
    _register(options, component) {
        // Exclusive stores pass the factory itself: minted here into a per-entry
        // handle so the stored entry always carries a resolvable handle (the
        // core's shared-handle scope pinning applies to it harmlessly).
        const store = typeof options.store === 'function' ? options.store() : options.store;
        const registrant = options.registrant ?? this.runtimeCtx.fiber?.name;
        const erased = {
            ...options,
            ...(store !== undefined ? { store } : {}),
            ...(registrant !== undefined ? { registrant } : {}),
        };
        // Core write first: all load-time validation (undeclared target,
        // duplicate declaration, kind conflicts, cross-scope handle) throws
        // there before this layer commits anything.
        const returned = Reflect.apply(this._core.register, this._core, [erased, component]);
        if (typeof returned !== 'function')
            throw new Error('SlotCore.register did not return a disposer');
        const dispose = () => { returned(); };
        if (store !== undefined) {
            // Register succeeded, so the target's spec is on the ledger.
            const spec = this._core.specDynamic(options.name);
            if (spec === undefined)
                throw new Error(`registered slot ${options.name} has no declaration`);
            const scope = spec.scope;
            this._acquire(store, scope);
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            dispose();
            if (store !== undefined)
                this._release(store);
        };
    }
    /** Build once after both object-layer services mount; per-session provide bundles still resolve lazily. */
    hostFace() {
        if (this._host !== undefined)
            return this._host;
        const sessions = this.runtimeCtx.get('sessions');
        if (sessions === undefined) {
            throw new Error("renderSlot('root') before the sessions service mounted — boot order puts runtime apply first");
        }
        const workspaces = this.runtimeCtx.get('workspaces');
        if (workspaces === undefined) {
            throw new Error("renderSlot('root') before the workspaces service mounted — boot order puts runtime apply first");
        }
        // `locale` is a live getter: the face installs (and, under HMR, swaps)
        // on the locale plugin's own fiber lifetime, while this host object is
        // built once — a captured value would strand renders on a dead face. The
        // alias is required: `this` inside the getter is the host literal.
        // oxlint-disable-next-line typescript/no-this-alias
        const service = this;
        this._host = {
            subscribe: (key, fn) => this._core.subscribe(key, fn),
            getVersion: key => this._core.getVersion(key),
            entriesOf: key => this._core.entries(key),
            entriesOfSlot: key => this._core.entriesOfSlot(key),
            reportEntryError: (key, entry, error, info) => { this._core.reportEntryError(key, entry, error, info); },
            specOf: key => this._core.specDynamic(key),
            isLive: entry => this._core.isLive(entry),
            storeOf: (entry, scopeKey) => entry.store === undefined ? undefined : this.resolveStore(requireStoreHandle(entry.store), scopeKey),
            sessions: {
                list: sessions.list,
                provideInfo: sessions.currentProvideInfo,
            },
            workspaces: { list: workspaces.list },
            get locale() { return service._locale; },
        };
        return this._host;
    }
    /** Resolve (create or reuse) the store instance for a registered handle under a scope key. */
    resolveStore(handle, sessionId) {
        const record = this._stores.get(handle);
        if (record === undefined)
            throw new Error('store handle is not registered (entry unloaded, or the handle never went through register)');
        const key = record.scope === 'root' ? ROOT_INSTANCE_KEY : sessionId;
        if (key === undefined)
            throw new Error(`${record.scope} store resolution requires a session id`);
        let instance = record.instances.get(key);
        if (instance === undefined) {
            // Session instances get the scope key (the engine suffixes the persist
            // key per session); root instances stay keyless.
            instance = record.scope === 'root' ? handle.create() : handle.create(key);
            record.instances.set(key, instance);
        }
        return instance;
    }
    /** Bind (or re-reference) a handle on the axis; cross-scope conflicts already threw in the core. */
    _acquire(handle, scope) {
        const record = this._stores.get(handle);
        if (record === undefined) {
            this._stores.set(handle, { scope, refs: 1, instances: new Map() });
            return;
        }
        record.refs += 1;
    }
    /** Drop one reference; the last holder's unload drops the record (instances go with it — engine stores need no explicit dispose). */
    _release(handle) {
        const record = this._stores.get(handle);
        /* v8 ignore next -- defensive: release only runs from a disposer whose
         * register acquired the same handle, so the record must exist; kept so a
         * future call site cannot underflow the axis. */
        if (record === undefined)
            return;
        record.refs -= 1;
        if (record.refs === 0)
            this._stores.delete(handle);
    }
}
exports.SlotRegistry = SlotRegistry;
// register's implementation (prototype assignment pairs with the `declare`
// inside the class — see its JSDoc for why it must live on the prototype).
// Element access reaches the private _register legally and keeps it a
// TS-visible read.
Object.defineProperty(SlotRegistry.prototype, 'register', {
    configurable: true, writable: true,
    value: function register(rawOptions, component) {
        if (!isRegisterOptions(rawOptions))
            throw new Error('invalid slots.register options');
        return this.runtimeCtx.effect(() => this['_register'](rawOptions, component), 'slots.register()');
    },
});
function isRegisterOptions(value) {
    return (0, value_guards_1.isRecord)(value) && typeof value.name === 'string'
        && (value.children === undefined || (0, value_guards_1.isRecord)(value.children) && Object.values(value.children).every(isSlotSpec))
        && (value.store === undefined || typeof value.store === 'function' || isStoreHandle(value.store))
        && (value.inject === undefined || typeof value.inject === 'function')
        && ['key', 'id', 'locale', 'registrant'].every(key => value[key] === undefined || typeof value[key] === 'string')
        && (value.label === undefined || typeof value.label === 'string' || typeof value.label === 'function')
        && ['order', 'priority'].every(key => value[key] === undefined || typeof value[key] === 'number')
        && (value.select === undefined || typeof value.select === 'function');
}
function isSlotSpec(value) {
    return (0, value_guards_1.isRecord)(value) && (value.kind === 'single' || value.kind === 'list' || value.kind === 'keyed' || value.kind === 'chain')
        && (value.scope === 'root' || value.scope === 'session-maybe' || value.scope === 'session')
        && (value.inject === undefined || (0, value_guards_1.isRecord)(value.inject));
}
function isStoreHandle(value) {
    return (0, value_guards_1.isRecord)(value) && typeof value.create === 'function' && (0, value_guards_1.isRecord)(value.spec)
        && typeof value.spec.init === 'function' && (0, value_guards_1.isRecord)(value.spec.actions)
        && Object.values(value.spec.actions).every(action => typeof action === 'function')
        && (value.spec.persist === undefined || typeof value.spec.persist === 'string');
}
function requireStoreHandle(value) {
    if (typeof value === 'function')
        throw new Error('SlotCore entry must carry a resolved store handle');
    return value;
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
"src/modules/client-runtime/context.js": function(module, exports, require) {
// source: src/modules/client-runtime/context.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Service = exports.Context = void 0;
/// <reference path="./externals.d.ts" />
const cordis_1 = require("@xharness/cordis");
exports.Context = cordis_1.Context;
function isServiceContext(value) {
    return cordis_1.Context.is(value) && typeof value.effect === 'function' && typeof value.get === 'function';
}
class Service extends cordis_1.Service {
    constructor(ctx, name) {
        if (!cordis_1.Context.is(ctx))
            throw new Error('runtime: expected a Cordis Context');
        super(ctx, name);
    }
    get runtimeCtx() {
        const value = this.ctx;
        if (!isServiceContext(value))
            throw new Error('runtime: invalid Cordis consuming context');
        return value;
    }
}
exports.Service = Service;

},
"src/modules/client-runtime/sessions/service.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRuntime = exports.scopeOf = exports.SessionForkError = exports.SessionCreateError = void 0;
exports.workspaceTitleOf = workspaceTitleOf;
const zod_1 = require("zod");
const sessions_schema_1 = require("../../client-connection/contracts/host/apiproxy/api/sessions.schema");
const types_1 = require("../../client-connection/contracts/core/session/types");
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
const index_1 = require("../../client-connection/contracts/host/apiproxy/api/index");
const store_1 = require("../contract/store");
const scope_1 = require("../agents/scope");
const manager_1 = require("./manager");
const provide_1 = require("./provide");
/** Structured session-create failure. */
class SessionCreateError extends Error {
    /**
     * @param rpcError - Host business or folded transport error.
     * @param requestedSessionId - caller-preallocated id used for later stream/list reconciliation.
     */
    constructor(rpcError, requestedSessionId) {
        super(`session create failed: ${rpcError.code}: ${rpcError.message}`);
        this.rpcError = rpcError;
        this.requestedSessionId = requestedSessionId;
        this.name = 'SessionCreateError';
    }
}
exports.SessionCreateError = SessionCreateError;
/** Structured session-fork failure. */
class SessionForkError extends Error {
    /**
     * @param rpcError - Host business or folded transport error.
     * @param sourceSessionId - the session the fork was cut from.
     */
    constructor(rpcError, sourceSessionId) {
        super(`session fork failed: ${rpcError.code}: ${rpcError.message}`);
        this.rpcError = rpcError;
        this.sourceSessionId = sourceSessionId;
        this.name = 'SessionForkError';
    }
}
exports.SessionForkError = SessionForkError;
// Scope primitives live in ../agents/scope.ts (the client mirror of host
// dsh-scope, keyed by Agent identity); re-exported here so existing
// consumers keep their import site.
var scope_2 = require("../agents/scope");
Object.defineProperty(exports, "scopeOf", { enumerable: true, get: function () { return scope_2.scopeOf; } });
/**
 * Workspace display title of a session cwd: the path's last non-empty
 * segment (both separators accepted; trailing separators ignored), or ''
 * for separator-only paths — callers own their fallback (session id, raw
 * cwd, default-directory copy). The repo-wide single basename derivation —
 * every surface naming a workspace (picker rows, toggle labels, list titles)
 * calls this instead of re-splitting paths.
 * @param cwd - workspace directory path.
 * @returns basename title, or '' when no non-empty segment exists.
 */
function workspaceTitleOf(cwd) {
    return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
}
/**
 * Display title projection: durable title, project directory basename, then
 * the raw id.
 */
function displayTitleOf(title, cwd, id) {
    if (title !== undefined)
        return title;
    if (cwd !== undefined && cwd !== '') {
        const base = workspaceTitleOf(cwd);
        if (base !== '')
            return base;
    }
    return id;
}
/**
 * Increment a trailing fork number while preserving its half-width or
 * full-width parentheses; an unnumbered title starts with ` (1)`.
 * @param title - source session's durable title.
 * @returns the title assigned to the fork child.
 */
function increasedForkTitle(title) {
    const ascii = /^(.*?)\((\d+)\)$/u.exec(title);
    if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
        return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`;
    }
    const fullWidth = /^(.*?)（(\d+)）$/u.exec(title);
    if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
        return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`;
    }
    return `${title} (1)`;
}
/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, and breadcrumb routes. */
class SessionRuntime {
    /**
     * @param ctx - client root context (scope fibers mount under it).
     * @param api - wire client shared with every Session.
     * @param remote - generated Remote namespaces shared with every Session.
     * @param conversationRuntime - same-pass registry instances, when runtime apply owns them.
     */
    constructor(rootCtx, api, remote, conversationRuntime) {
        this.rootCtx = rootCtx;
        /**
         * The wire schema's own result bound, re-exposed for presentation plugins as
         * injected data. Not per-connection state: the `session.search` response
         * schema caps `items` at this constant, so every transport (fixture included)
         * reports the same number.
         */
        this.searchResultLimit = index_1.SESSION_SEARCH_RESULT_LIMIT;
        this.scopes = new Map();
        /** Removed-while-staged sessions whose teardown waits for the stage to move away. */
        this.deferredRemovals = new Set();
        this.selection = (0, store_1.createSnapshotStore)({}, { persist: { name: 'dsh.sessions.current', decode: decodeSessionSelection } });
        const restored = this.selection.getSnapshot();
        const conversationEvents = rootCtx.get('conversationEvents');
        const conversationViews = rootCtx.get('conversationViews');
        const conversation = conversationRuntime ?? (conversationEvents === undefined || conversationViews === undefined
            ? undefined
            : { events: conversationEvents, views: conversationViews });
        this.manager = new manager_1.SessionManager(api, remote, restored.sessionId, restored.subagentAddress, conversation);
        this.list = (0, store_1.createSnapshotStore)({
            ids: [], byId: {}, current: undefined, phase: 'pending',
            subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
        });
        // The manager owns wire truth; the store is its projection. Manager
        // notifications are already microtask-batched.
        this.manager.subscribe(() => { this.projectList(); });
        // Stage follower: every current write (open() and projection alike)
        // re-evaluates staging, so startup restore (persisted selection validated
        // by the projection) and reconnect resurfacing open their window with no
        // dedicated code path. Safe to run synchronously inside the store notify:
        // the follower writes no list state — session.open()'s synchronous prefix
        // touches only session-side state and its own microtask-batched notifier.
        // The current-provide projection follows the same current writes.
        this.list.subscribe(() => {
            this.followCurrent();
            this.provideChannel.publishCurrent();
        });
        this.provideChannel = new provide_1.SessionProvideChannel({
            rebuildBundles: () => {
                for (const record of this.scopes.values()) {
                    record.provideInfo = this.provideChannel.materializeInfo(record.binding);
                }
            },
            resolveCurrent: () => this.maybeProvideInfo(this.list.getSnapshot().current),
        });
        this.currentProvideInfo = this.provideChannel.currentProvideInfo;
        let registryRebuildQueued = false;
        const scheduleRegistryRebuild = () => {
            if (registryRebuildQueued)
                return;
            registryRebuildQueued = true;
            queueMicrotask(() => {
                registryRebuildQueued = false;
                this.manager.rebuildConversationRegistry();
            });
        };
        if (conversation !== undefined) {
            rootCtx.effect(() => {
                const disposeEvents = conversation.events.subscribe(scheduleRegistryRebuild);
                const disposeViews = conversation.views.subscribe(scheduleRegistryRebuild);
                return () => {
                    disposeEvents();
                    disposeViews();
                };
            }, 'sessions: conversation registry rebuild');
        }
        rootCtx.reflect.provide('sessions', this, undefined);
    }
    /**
     * Register a per-session standard-props provider: every session-scope slot
     * component receives the contributed members as standard props (`hooks`
     * sources become `use<Name>` selector hooks on the render side; `props`
     * spread verbatim). Contributions materialize lazily with the session's
     * scope record and die with it. Registration order is resolution order;
     * duplicate member names fail loud at materialization.
     * @param descriptor - static member roster plus per-session resolver.
     * @returns disposer removing the provider (already-materialized bundles keep their members until their scope drops).
     */
    provide(descriptor) {
        // Scopes may already exist (boot order: the list lands and resolves
        // scopes before later plugins register) — the channel rebuilds their
        // bundles through the host hooks so every provider lands by first render.
        return this.provideChannel.provide(descriptor);
    }
    /**
     * Select a listed or retained catalog-addressed session as current.
     * @param id - listed or addressed session id.
     */
    open(id) {
        this.manager.select(id);
    }
    /**
     * Open a healthy catalog child through its direct-parent address.
     * @param address - catalog-derived parent and child ids.
     */
    openSubagent(address) {
        this.manager.selectSubagent(address);
    }
    /**
     * Resolve an already discovered direct-parent address without opening it.
     * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
     * @param id - possible addressed child id.
     * @returns The retained address, when present.
     */
    subagentAddress(id) {
        return this.manager.subagentAddress(id);
    }
    /**
     * Inform the runtime whether a catalog menu is consuming membership updates.
     * @param parentSessionId - selected parent.
     * @param open - menu state.
     */
    setSubagentCatalogOpen(parentSessionId, open) {
        this.manager.setSubagentCatalogOpen(parentSessionId, open);
    }
    /**
     * Refresh one direct-child catalog.
     * @param parentSessionId - catalog owner.
     */
    refreshSubagents(parentSessionId) {
        return this.manager.refreshSubagents(parentSessionId);
    }
    noteAgentPreset(sessionId, agentPreset) {
        this.manager.noteAgentPreset(sessionId, agentPreset);
    }
    /**
     * Clear the current selection so the layout shows the no-session empty
     * state (new-session affordance and the workspace preselection flow).
     * Wipes the persisted selection too — a reload stays on empty until the
     * user opens or starts a session. The staged scope keeps its frozen view
     * per the masked-gap contract until the next open() moves the stage.
     */
    clear() {
        this.manager.clearSelection();
    }
    /** Pull status for the runtime-owned Work projection; not another list owner. */
    catalogStatus() {
        const { state, error } = this.manager.getListSnapshot();
        return { state, error };
    }
    /** Acknowledge durable deletion without depending on the event stream. */
    forgetDeletedSessions(ids) { this.manager.forgetDeletedSessions(ids); }
    /** Refresh the real Session baseline, reusing an in-flight pull. */
    refresh() {
        return this.manager.refreshList();
    }
    /**
     * Search the Host's visible message-content index. Results stay
     * request-local; the list snapshot remains the metadata authority.
     * @param query - non-blank literal phrase.
     * @param signal - cancellation for a superseded search.
     * @returns bounded results or a business/transport error.
     */
    search(query, signal) {
        return this.manager.search(query, signal);
    }
    /**
     * Route a mux stream envelope into the Session object layer.
     * @param envelope - validated mux stream envelope.
     */
    handleMuxEnvelope(envelope) {
        this.manager.handleMuxEnvelope(envelope);
    }
    /**
     * Route a Host stream envelope into the Session object layer.
     * @param envelope - validated Host stream envelope.
     */
    handleHostEnvelope(envelope) {
        this.manager.handleHostEnvelope(envelope);
    }
    /** Rebuild the Session baseline and every opened window after connection. */
    handleConnected() {
        this.manager.handleConnected();
    }
    /** Drop generation-scoped live interaction state the moment a connection generation dies. */
    handleDisconnected() {
        this.manager.handleDisconnected();
    }
    /**
     * Create a session on the host. Resolution guarantee: by the time the
     * promise resolves, the created session is in the list store and
     * {@link SessionRuntime.binding} resolves it — callers (New Session
     * draft hand-off) may address the scope synchronously, without waiting a
     * notifier flush. The synchronous projection below makes this structural
     * rather than an accident of microtask ordering.
     * @param opts - target workspace or directory and an optional preallocated id.
     * @returns the new session id.
     * @throws {SessionCreateError} with the requested id.
     */
    async create(opts = {}) {
        const result = await this.manager.create(opts);
        if (!result.ok)
            throw new SessionCreateError(result.error, opts.sessionId);
        this.projectList();
        return result.value.sessionId;
    }
    /**
     * Fork a session from a completed-turn prefix of the source (same
     * synchronous-addressability guarantee as {@link SessionRuntime.create}:
     * on resolution the child is in the list store and open() can target it).
     * @param opts - source session id, the optional event seq anchoring the
     *   cut (the boundary is the first turn/end at or after it; an in-log
     *   anchor in an open turn is unavailable rather than clipped backward),
     *   the optional user-message seq whose preceding completed-turn prefix is
     *   used for an edit fork, and whether to increment an inherited durable
     *   title before resolving. User-message cuts take precedence over atSeq.
     *   A fractional anchor floors to a real event seq: the frozen nodes of an
     *   interrupted turn carry flow-ordering seqs between two events, and the
     *   wire takes integers only.
     * @returns the child session id.
     * @throws {SessionForkError} with the source id.
     * @throws {Error} when a requested child-title rename fails after creation.
     */
    async fork(opts) {
        const sourceTitle = opts.increaseTitle
            ? this.list.getSnapshot().byId[opts.sessionId]?.title
            : undefined;
        const result = await this.manager.fork({
            sessionId: opts.sessionId,
            // Flooring lands inside the anchor's own turn (every turn opens with a
            // turn/start), so the host's first-turn/end-at-or-after cut still ends
            // on that turn — never clipped back to the previous one.
            ...(opts.atSeq === undefined ? {} : { atSeq: Math.floor(opts.atSeq) }),
            ...(opts.beforeUserSeq === undefined ? {} : { beforeUserSeq: Math.floor(opts.beforeUserSeq) }),
        });
        if (!result.ok)
            throw new SessionForkError(result.error, opts.sessionId);
        this.projectList();
        const childId = result.value.sessionId;
        if (sourceTitle !== undefined) {
            const child = this.binding(childId)?.session;
            if (child === undefined)
                throw new Error(`fork child "${childId}" is not locally addressable`);
            const renamed = await child.rename(increasedForkTitle(sourceTitle));
            if (!renamed.ok)
                throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`);
        }
        return childId;
    }
    /**
     * Resolve an Agent-scoped context view (use-and-discard).
     * @param id - session id (the agent identity — 1:1 same axis).
     * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
     */
    scope(id) {
        return this.resolve(id)?.ctx;
    }
    /**
     * Read the Agent scope tag off a context. Service-method boundary: fetch
     * bundles must reach scope resolution through ctx.sessions — a cross-bundle
     * value import of the standalone helper would inline a second module
     * instance whose private tag Symbol never matches.
     * @param ctx - any client context.
     * @returns the session id, or undefined on root contexts.
     */
    scopeOf(ctx) {
        return (0, scope_1.scopeOf)(ctx);
    }
    /**
     * Resolve the business Session behind an Agent-scoped context — the one
     * hop every scoped consumer (event listeners, per-session controllers)
     * takes from ctx-space into object-space (the client mirror of host
     * `agent.session`). Same service-method boundary as
     * {@link SessionRuntime.scopeOf}.
     * @param ctx - an Agent-scoped context.
     * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
     */
    sessionOf(ctx) {
        const id = (0, scope_1.scopeOf)(ctx);
        if (id === undefined)
            return undefined;
        return this.scopes.get(id)?.binding.session;
    }
    /**
     * Resolve the stable session binding (scope-addressed assembly feed). Pure
     * resolution — no staging, no window side effects.
     * @param id - session id.
     * @returns binding, or undefined for a session neither listed nor already scoped.
     */
    binding(id) {
        return this.resolve(id)?.binding;
    }
    /**
     * Resolve one session's render-layer standard-props bundle (ctx never
     * enters the render layer; the renderer subscribes to
     * {@link SessionRuntime.currentProvideInfo}). Pure resolution — render-safe:
     * no staging, no window side effects (StrictMode double-invokes and
     * concurrent discarded passes must stay free).
     */
    provideInfo(id) {
        return this.resolve((0, types_1.SessionId)(id))?.provideInfo;
    }
    /**
     * Resolve the current-session-optional standard kit. Unknown or absent ids
     * return the static no-session projection rather than removing hook props.
     */
    maybeProvideInfo(id) {
        return (id === undefined ? undefined : this.provideInfo(id)) ?? this.provideChannel.maybeInfo;
    }
    /**
     * Move the stage to the list's current session: sweep teardowns deferred
     * behind the previous occupant and pull the new occupant's history window.
     * Staging IS the open signal — the window opens ⟺ the session is on stage
     * — and open() is idempotent (an in-flight or completed open no-ops; a
     * failed one retries the next time current is touched).
     */
    followCurrent() {
        const snapshot = this.list.getSnapshot();
        const current = snapshot.current;
        // A masked gap (current blanked while the selection's session is
        // transiently absent) holds the stage: tearing down on the gap would
        // destroy exactly the frozen scope the mask exists to preserve.
        if (current === undefined || snapshot.byId[current] === undefined || current === this.watched)
            return;
        this.watched = current;
        this.sweepDeferred();
        const record = this.resolve(current);
        /* v8 ignore next 3 -- defensive: current is always a listed id (open()
         * validates and the projection masks absent selections), so resolve
         * cannot miss; kept so a future current writer cannot crash the notify. */
        if (record !== undefined) {
            void record.session.open();
            void this.manager.refreshSubagents(current);
        }
    }
    /**
     * Lazily mint the scope + binding for an eligible session. Eligibility and
     * prune share one predicate: listed on the host or selected
     * through a retained subagent address. Breadcrumb-only ancestors remain
     * summary data and do not keep scopes alive.
     */
    resolve(id) {
        const existing = this.scopes.get(id);
        if (existing !== undefined)
            return existing;
        if (!this.eligible(id))
            return undefined;
        const { fiber, ctx } = (0, scope_1.createScope)(this.rootCtx, id);
        const session = this.manager.get(id);
        // The Session owns its scoped dispatch point (host Agent.loopCtx mirror);
        // mint and bind are one step so a live scope record implies a bound actx.
        session.bindScope(ctx);
        const binding = { sessionId: id, session, ctx };
        const record = {
            fiber,
            ctx,
            binding,
            session,
            // Sources are bare observables; React binds selector hooks at its own boundary.
            provideInfo: this.provideChannel.materializeInfo(binding),
        };
        this.scopes.set(id, record);
        return record;
    }
    /** The one aliveness predicate shared by scope mint and prune: host-listed or currently addressed. */
    eligible(id) {
        const { ids, current } = this.list.getSnapshot();
        return current === id || ids.includes(id);
    }
    /** Project the manager's list snapshot into the store (title derivation is display-only). */
    projectList() {
        const { items, current, phase, subagentsByParent, jobsBySession, currentAddress, } = this.manager.getListSnapshot();
        const ids = [];
        const byId = {};
        for (const entry of items) {
            ids.push(entry.sessionId);
            byId[entry.sessionId] = {
                id: entry.sessionId,
                displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
                running: entry.running,
                ...(entry.completed ? { completed: true } : {}),
                blank: entry.blank,
                updatedAt: entry.updatedAt,
                ...(entry.pendingInteraction === undefined
                    ? {}
                    : { pendingInteraction: entry.pendingInteraction }),
                ...(entry.projectionValues === undefined
                    ? {}
                    : { projectionValues: entry.projectionValues }),
                ...(entry.title !== undefined ? { title: entry.title } : {}),
                ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
                ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
                ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
                ...(entry.agentPreset !== undefined ? { agentPreset: entry.agentPreset } : {}),
            };
        }
        if (current !== undefined && currentAddress !== undefined) {
            const seen = new Set();
            let address = currentAddress;
            while (address !== undefined && !seen.has(address.childSessionId)) {
                const childId = address.childSessionId;
                seen.add(childId);
                const child = subagentsByParent[address.parentSessionId]?.entries
                    .find(entry => entry.kind === 'child' && entry.id === childId);
                if (child?.kind !== 'child')
                    break;
                const displayTitle = child.label ?? childId;
                const summary = byId[childId];
                if (summary === undefined) {
                    byId[childId] = {
                        id: childId,
                        displayTitle,
                        parentId: address.parentSessionId,
                        origin: 'subagent',
                        running: child.activity === 'running',
                        blank: false,
                        updatedAt: 0,
                    };
                }
                else if (summary.displayTitle !== displayTitle) {
                    byId[childId] = { ...summary, displayTitle };
                }
                const parent = byId[address.parentSessionId];
                if (parent !== undefined && parent.origin !== 'subagent')
                    break;
                address = this.manager.navigationAddress(address.parentSessionId);
            }
        }
        const persisted = this.selection.getSnapshot().sessionId;
        // No current (cleared, or masked gap) wipes the persisted cell — a reload
        // stays on empty; the in-memory selection still resurfaces a masked id.
        if (current === undefined) {
            if (persisted !== undefined)
                this.selection.set({});
        }
        else if (byId[current] !== undefined
            && (persisted !== current
                || this.selection.getSnapshot().subagentAddress?.childSessionId !== currentAddress?.childSessionId
                || this.selection.getSnapshot().subagentAddress?.parentSessionId !== currentAddress?.parentSessionId
                || this.selection.getSnapshot().subagentAddress?.mode !== currentAddress?.mode)) {
            this.selection.set({
                sessionId: current,
                ...(currentAddress === undefined ? {} : { subagentAddress: currentAddress }),
            });
        }
        this.list.set({ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress });
        this.pruneScopes();
    }
    /** Tear down scope + instance for no-longer-eligible sessions off stage; the staged one defers until the stage moves. */
    pruneScopes() {
        for (const [id, record] of this.scopes) {
            if (this.eligible(id))
                continue;
            if (id === this.watched) {
                this.deferredRemovals.add(id);
                continue;
            }
            this.scopes.delete(id);
            this.deferredRemovals.delete(id);
            this.dropScope(id, record);
        }
    }
    /**
     * One teardown for the whole per-session axis: the scope
     * fiber (cascading every actx-registered effect: input shell, slash
     * controller, popup, plugin stores, listeners), the session-keyed slot
     * stores, and the Session instance itself — the host session log is the
     * durable truth, a reopen lazily rebuilds and backfills via open().
     */
    dropScope(id, record) {
        void record.fiber.dispose();
        // Release the Session's dispatch point with the scope it belongs to (a
        // surviving instance — the live Intent — rebinds when resolve re-mints).
        record.session.unbindScope();
        // Optional lookup: slots and sessions are sibling services with no
        // declared dependency; a slots-less boot (object-layer tests) skips.
        this.rootCtx.get('slots')?.pruneStoreScope(id);
        this.manager.drop(id);
    }
    /** Run deferred teardowns whose session is no longer staged (called when the stage moves). */
    sweepDeferred() {
        for (const id of [...this.deferredRemovals]) {
            /* v8 ignore next -- defensive: only the staged id ever defers, and every
             * stage move sweeps first, so the set cannot contain the id the stage just
             * moved to; kept as a guard against future extra sweep call sites. */
            if (id === this.watched)
                continue;
            // Eligible again? (A re-added id cancels the deferred teardown.)
            if (this.eligible(id)) {
                this.deferredRemovals.delete(id);
                continue;
            }
            const record = this.scopes.get(id);
            this.deferredRemovals.delete(id);
            /* v8 ignore next -- defensive: prune deletes a scope and its deferral
             * together, so a deferred id always still owns its record; kept so a
             * future teardown path cannot double-dispose. */
            if (record !== undefined) {
                this.scopes.delete(id);
                this.dropScope(id, record);
            }
        }
    }
}
exports.SessionRuntime = SessionRuntime;
const sessionSelectionSchema = zod_1.z.looseObject({
    sessionId: sessions_schema_1.sessionIdSchema.optional(),
    subagentAddress: zod_1.z.looseObject({
        parentSessionId: sessions_schema_1.sessionIdSchema, childSessionId: sessions_schema_1.sessionIdSchema,
        mode: zod_1.z.enum(['one-shot', 'continuable']),
    }).optional(),
});
function decodeSessionSelection(value) {
    return sessionSelectionSchema.parse(value);
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.ts

"use strict";
/**
 * sessions domain zod schemas (names derived from map keys: sessionListRequestSchema /
 * sessionListValueSchema). SessionEvent passthrough = strict envelope (type/seq/time) + wide
 * data: the merge-extensible event API keeps an unknown-type branch at the union level,
 * with no field-level passthrough. SessionId brand cast point: sessionIdSchema, and only there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionImportRequestSchema = exports.sessionDeleteValueSchema = exports.sessionDeleteRequestSchema = exports.sessionCancelValueSchema = exports.sessionCancelRequestSchema = exports.sessionUpdateQueueValueSchema = exports.sessionUpdateQueueRequestSchema = exports.sessionAttachmentValueSchema = exports.sessionAttachmentRequestSchema = exports.imageAttachmentRefSchema = exports.attachmentIdSchema = exports.sessionPromptValueSchema = exports.sessionPromptRequestSchema = exports.promptContentPartSchema = exports.imageMediaTypeSchema = exports.contentBlockSchema = exports.sessionSelectModelValueSchema = exports.sessionSelectModelRequestSchema = exports.sessionModelsValueSchema = exports.sessionModelsRequestSchema = exports.sessionHistoryValueSchema = exports.imageLimitsProjectionSchema = exports.sessionListMetadataProjectionSchema = exports.sessionProjectionsBlockSchema = exports.historyEntrySchema = exports.toolEventViewSchema = exports.modelCatalogFailureSchema = exports.modelProviderGroupSchema = exports.modelCatalogModelSchema = exports.modelReasoningSchema = exports.modelReasoningEffortSchema = exports.modelSelectionSchema = exports.sessionHistoryRequestSchema = exports.sessionForkValueSchema = exports.sessionForkRequestSchema = exports.sessionRenameValueSchema = exports.sessionRenameRequestSchema = exports.sessionCreateValueSchema = exports.sessionCreateRequestSchema = exports.sessionSearchValueSchema = exports.sessionSearchItemSchema = exports.sessionSearchRequestSchema = exports.sessionListValueSchema = exports.sessionListRequestSchema = exports.sessionSummarySchema = exports.sessionOriginSchema = exports.sessionEventSchema = exports.workspaceIdSchema = exports.messageIdSchema = exports.sessionIdSchema = void 0;
exports.sessionImportValueSchema = void 0;
const zod_1 = require("zod");
const session_search_1 = require("./session-search");
/** SessionId: one brand cast after schema validation (the only cast point in this domain). */
exports.sessionIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** MessageId: one brand cast after non-empty string validation. */
exports.messageIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/**
 * WorkspaceId: the workspace domain's one brand cast. Hosted here rather
 * than in workspace.schema because session.create references it while
 * workspace.schema references sessionIdSchema — schema modules must stay a
 * DAG (both casts used at module top level; a cycle is a load-time TDZ).
 */
exports.workspaceIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** SessionEvent passthrough: strict envelope, wide data (the client fold handles unknown types via its documented default). */
exports.sessionEventSchema = zod_1.z.object({
    type: zod_1.z.string(),
    seq: zod_1.z.number().int().nonnegative(),
    time: zod_1.z.number(),
    data: zod_1.z.unknown(),
    sourceEventSeqs: zod_1.z.array(zod_1.z.number()).optional(),
    surfaceOp: zod_1.z.unknown().optional(),
    ignorable: zod_1.z.literal(true).optional(),
});
/** SessionSummary row of session.list (`projections` reuses the history block's shape and schema). */
exports.sessionOriginSchema = zod_1.z.enum(['subagent', 'fork', 'automation']);
exports.sessionSummarySchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    updatedAt: zod_1.z.number(),
    running: zod_1.z.boolean(),
    blank: zod_1.z.boolean(),
    parentSessionId: exports.sessionIdSchema.optional(),
    origin: exports.sessionOriginSchema.optional(),
    cwd: zod_1.z.string().optional(),
    agentPreset: zod_1.z.string().optional(),
    projections: zod_1.z.lazy(() => exports.sessionProjectionsBlockSchema).optional(),
});
/** session.list request payload (cursor is a reserved seat, unimplemented in v1). */
exports.sessionListRequestSchema = zod_1.z.object({
    cursor: zod_1.z.string().optional(),
});
/** session.list response value. */
exports.sessionListValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSummarySchema),
});
/** Fixed wire bound for one interactive sidebar query. */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500;
/** session.search request payload. */
exports.sessionSearchRequestSchema = zod_1.z.object({
    query: zod_1.z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS)
        .refine(query => !query.includes('\0'), { message: 'search query must not contain NUL' }),
});
/** One session.search result. */
exports.sessionSearchItemSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    snippet: zod_1.z.string().refine(snippet => (0, session_search_1.truncateUnicodeCodePoints)(snippet, session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS) === snippet, { message: `search snippet must contain at most ${session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS} Unicode code points` }),
});
/** session.search response value. */
exports.sessionSearchValueSchema = zod_1.z.object({
    items: zod_1.z.array(exports.sessionSearchItemSchema).max(session_search_1.SESSION_SEARCH_RESULT_LIMIT),
    hasMore: zod_1.z.boolean(),
});
/** session.create request payload (at most one of workspaceId / cwd). */
exports.sessionCreateRequestSchema = zod_1.z.object({
    workspaceId: exports.workspaceIdSchema.optional(),
    cwd: zod_1.z.string().optional(),
    sessionId: exports.sessionIdSchema.optional(),
    agentPreset: zod_1.z.string().optional(),
}).refine(payload => payload.workspaceId === undefined || payload.cwd === undefined, { message: 'session.create accepts workspaceId or cwd, not both' });
/** session.create response value. */
exports.sessionCreateValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    agentPreset: zod_1.z.string().optional(),
});
/** session.rename request payload (raw title; host-side normalization decides acceptance). */
exports.sessionRenameRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    title: zod_1.z.string(),
});
/** session.rename response value (the normalized accepted title and its event seq). */
exports.sessionRenameValueSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    seq: zod_1.z.number().int().nonnegative(),
});
/** session.fork request payload (atSeq anchors the completed-turn cut). */
exports.sessionForkRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    atSeq: zod_1.z.number().int().nonnegative().optional(),
    beforeUserSeq: zod_1.z.number().int().nonnegative().optional(),
});
/** session.fork response value (the child session id). */
exports.sessionForkValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.history request payload (beforeSeq/maxMessages page backwards from the window tail). */
exports.sessionHistoryRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    beforeSeq: zod_1.z.number().int().nonnegative().optional(),
    maxMessages: zod_1.z.number().int().positive().optional(),
});
/** Complete provider/model selection. */
// Production model capacity metadata is preserved rather than stripped.
exports.modelSelectionSchema = zod_1.z.object({
    contextWindowTokens: zod_1.z.number().int().positive().optional(),
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** One adapter-owned reasoning effort. */
exports.modelReasoningEffortSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
});
/** Exact-model reasoning metadata. */
exports.modelReasoningSchema = zod_1.z.object({
    efforts: zod_1.z.array(exports.modelReasoningEffortSchema).min(1),
    defaultEffort: zod_1.z.string().min(1).optional(),
});
/** One advisory model entry inside a provider group. */
exports.modelCatalogModelSchema = zod_1.z.object({
    imageInput: zod_1.z.boolean().optional(),
    imageInputCapability: zod_1.z.unknown().optional(),
    reasoningCapability: zod_1.z.unknown().optional(),
    contextWindow: zod_1.z.number().int().positive().optional(),
    contextWindowSource: zod_1.z.string().optional(),
    contextWindowCapability: zod_1.z.unknown().optional(),
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    reasoning: exports.modelReasoningSchema.optional(),
});
/** One successfully loaded provider group. */
exports.modelProviderGroupSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    models: zod_1.z.array(exports.modelCatalogModelSchema),
});
/** One provider-local catalog failure. */
exports.modelCatalogFailureSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    message: zod_1.z.string(),
});
/**
 * ToolEventView passthrough: lock only the `for` discriminant and the presence
 * of a card-tagged `view` object. The view interior is a host-computed product
 * the client reads without echoing back; deep-validating it would hand-copy
 * the dsh-tools vocabulary into this schema and drift with it.
 */
exports.toolEventViewSchema = zod_1.z.discriminatedUnion('for', [
    zod_1.z.object({ for: zod_1.z.literal('call'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('result'), view: zod_1.z.looseObject({ card: zod_1.z.string() }) }),
    zod_1.z.object({ for: zod_1.z.literal('compaction'), view: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()) }),
]);
/** One session.history item: the session event plus its optional host-computed tool view. */
exports.historyEntrySchema = zod_1.z.object({
    event: exports.sessionEventSchema,
    view: exports.toolEventViewSchema.optional(),
});
/**
 * Projection baseline passthrough: `values` stays a wide record — each value
 * was already parsed by its provider's own schema on the host side, and
 * deep-validating here would import every domain's schema into the carrier.
 */
exports.sessionProjectionsBlockSchema = zod_1.z.object({
    // -1 = empty log (the lastSeq convention of session/subscribed).
    asOfSeq: zod_1.z.number().int().min(-1),
    values: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
});
/** Host-side validation for the persisted Session-list projection. */
exports.sessionListMetadataProjectionSchema = zod_1.z.object({
    blank: zod_1.z.boolean(),
    lastPromptAt: zod_1.z.number().nullable(),
});
/**
 * imageLimits projection unit schema (host-side view validation). zod widens
 * `readonly ImageMediaType[]` to `string[]`; on the JSON wire the two
 * serialize identically, so the cast records exactly that widening.
 */
exports.imageLimitsProjectionSchema = zod_1.z.object({
    maxImageBytes: zod_1.z.number().int().positive(),
    maxImagesPerMessage: zod_1.z.number().int().positive(),
    maxMessageImageBytes: zod_1.z.number().int().positive(),
    maxImagePixels: zod_1.z.number().int().positive(),
    maxImageDimension: zod_1.z.number().int().positive(),
    mediaTypes: zod_1.z.array(zod_1.z.string()),
});
/** session.history response value (projections rides the tail page only). */
exports.sessionHistoryValueSchema = zod_1.z.object({
    events: zod_1.z.array(exports.historyEntrySchema),
    hasMore: zod_1.z.boolean(),
    projections: exports.sessionProjectionsBlockSchema.optional(),
});
/** session.models request payload. */
exports.sessionModelsRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.models response value. */
exports.sessionModelsValueSchema = zod_1.z.object({
    current: exports.modelSelectionSchema,
    routable: zod_1.z.boolean(),
    groups: zod_1.z.array(exports.modelProviderGroupSchema),
    failures: zod_1.z.array(exports.modelCatalogFailureSchema),
});
/** session.selectModel request payload. */
exports.sessionSelectModelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    provider: zod_1.z.string().min(1),
    model: zod_1.z.string().min(1),
    reasoningEffort: zod_1.z.string().min(1).optional(),
});
/** session.selectModel response value. */
exports.sessionSelectModelValueSchema = zod_1.z.object({
    selected: exports.modelSelectionSchema,
});
/** ContentBlock passthrough: core is merge-extensible — the type discriminant envelope is strict, the rest stays wide. */
exports.contentBlockSchema = zod_1.z.looseObject({ type: zod_1.z.string() });
/** Raster image media types accepted by the version-one browser wire. */
exports.imageMediaTypeSchema = zod_1.z.union([
    zod_1.z.literal('image/png'),
    zod_1.z.literal('image/jpeg'),
    zod_1.z.literal('image/webp'),
    zod_1.z.literal('image/gif'),
]);
/** Prompt wire content is intentionally narrower than merge-extensible durable core content. */
// Production xharness-edit-reference-wire/v1 and durable attachments boundary.
exports.promptContentPartSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('image_ref'), attachmentId: zod_1.z.string().min(1) }),
    zod_1.z.object({ type: zod_1.z.literal('file_ref'), attachmentId: zod_1.z.string().min(1), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('text'), text: zod_1.z.string() }),
    zod_1.z.object({ type: zod_1.z.literal('image'), mediaType: exports.imageMediaTypeSchema, data: zod_1.z.string(), name: zod_1.z.string().optional() }),
    zod_1.z.object({ type: zod_1.z.literal('file'), mediaType: zod_1.z.string(), data: zod_1.z.string(), name: zod_1.z.string().optional() }),
]);
/** session.prompt request payload, including optional browser-local request provenance. */
exports.sessionPromptRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    mode: zod_1.z.union([zod_1.z.literal('queue'), zod_1.z.literal('steer')]),
    content: zod_1.z.array(exports.promptContentPartSchema),
    requireIdle: zod_1.z.boolean().optional(),
    clientTimeZone: zod_1.z.string().optional(),
});
/** session.prompt response value (the command slot appears only when the prompt dispatched a slash command). */
exports.sessionPromptValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
    command: zod_1.z.object({
        kind: zod_1.z.literal('success'),
        text: zod_1.z.string().optional(),
    }).optional(),
});
/** Opaque attachment id after string-shape validation. */
exports.attachmentIdSchema = zod_1.z.string().min(1).brand().transform(value => value);
/** Durable image reference returned from the authenticated session lookup. */
exports.imageAttachmentRefSchema = zod_1.z.object({
    attachmentId: exports.attachmentIdSchema,
    mediaType: zod_1.z.string(),
    bytes: zod_1.z.number().int().nonnegative(),
    width: zod_1.z.number().int().positive().nullish(),
    height: zod_1.z.number().int().positive().nullish(),
    name: zod_1.z.string().optional(),
});
/** session.attachment request payload. */
exports.sessionAttachmentRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    attachmentId: exports.attachmentIdSchema,
});
/** session.attachment response value. */
exports.sessionAttachmentValueSchema = zod_1.z.object({
    attachment: exports.imageAttachmentRefSchema,
    data: zod_1.z.string(),
});
/** session.updateQueue request payload. */
exports.sessionUpdateQueueRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
    itemId: exports.messageIdSchema,
    action: zod_1.z.discriminatedUnion('kind', [
        zod_1.z.object({ kind: zod_1.z.literal('edit'), content: zod_1.z.array(exports.contentBlockSchema) }),
        zod_1.z.object({ kind: zod_1.z.literal('remove') }),
        zod_1.z.object({ kind: zod_1.z.literal('steer') }),
    ]),
});
/** session.updateQueue response value. */
exports.sessionUpdateQueueValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
/** session.cancel request payload. */
exports.sessionCancelRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
/** session.cancel response value. */
exports.sessionCancelValueSchema = zod_1.z.object({
    accepted: zod_1.z.literal(true),
});
exports.sessionDeleteRequestSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema,
});
exports.sessionDeleteValueSchema = zod_1.z.object({
    deleted: zod_1.z.boolean(),
    deletedSessionIds: zod_1.z.array(exports.sessionIdSchema).optional(),
});
/** External tools are history text only; this request never submits a prompt. */
exports.sessionImportRequestSchema = zod_1.z.object({
    source: zod_1.z.enum(['claude-code', 'codex']), jsonl: zod_1.z.string().max(8 * 1024 * 1024),
    preview: zod_1.z.boolean(), cwd: zod_1.z.string().optional(), workspaceId: exports.workspaceIdSchema.optional(),
}).strict().refine(p => p.cwd === undefined || p.workspaceId === undefined);
exports.sessionImportValueSchema = zod_1.z.object({
    sessionId: exports.sessionIdSchema.optional(), title: zod_1.z.string(), messages: zod_1.z.number().int().nonnegative(),
    tools: zod_1.z.number().int().nonnegative(), warnings: zod_1.z.array(zod_1.z.string()),
    preview: zod_1.z.array(zod_1.z.object({ role: zod_1.z.string(), content: zod_1.z.string() })),
});

},
"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/session-search.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = exports.SESSION_SEARCH_RESULT_LIMIT = void 0;
exports.truncateUnicodeCodePoints = truncateUnicodeCodePoints;
/** Maximum number of sessions returned by one sidebar search. */
exports.SESSION_SEARCH_RESULT_LIMIT = 20;
/** Maximum snippet length in Unicode code points. */
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - text to bound.
 * @param maximum - non-negative code-point limit.
 * @returns `value` unchanged when it fits, otherwise a code-point-safe prefix.
 */
function truncateUnicodeCodePoints(value, maximum) {
    let count = 0;
    let end = 0;
    for (const codePoint of value) {
        if (count === maximum)
            return value.slice(0, end);
        count++;
        end += codePoint.length;
    }
    return value;
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
"src/modules/client-connection/contracts/host/apiproxy/api/index.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/index.ts

"use strict";
/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TS interfaces are the authoritative contract, while HTTP,
 * WebSocket, and in-process SSE are merely physical channels (four-quadrant message model).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = exports.SESSION_SEARCH_RESULT_LIMIT = exports.serverResponseSchema = exports.serverRequestSchema = exports.clientRequestSchema = exports.transportError = exports.RpcId = void 0;
// ---- Errors and ids ----
var rpc_1 = require("./rpc");
Object.defineProperty(exports, "RpcId", { enumerable: true, get: function () { return rpc_1.RpcId; } });
Object.defineProperty(exports, "transportError", { enumerable: true, get: function () { return rpc_1.transportError; } });
var rpc_schema_1 = require("./rpc.schema");
Object.defineProperty(exports, "clientRequestSchema", { enumerable: true, get: function () { return rpc_schema_1.clientRequestSchema; } });
Object.defineProperty(exports, "serverRequestSchema", { enumerable: true, get: function () { return rpc_schema_1.serverRequestSchema; } });
Object.defineProperty(exports, "serverResponseSchema", { enumerable: true, get: function () { return rpc_schema_1.serverResponseSchema; } });
// ---- Fixed session-search product bounds ----
var session_search_1 = require("./session-search");
Object.defineProperty(exports, "SESSION_SEARCH_RESULT_LIMIT", { enumerable: true, get: function () { return session_search_1.SESSION_SEARCH_RESULT_LIMIT; } });
Object.defineProperty(exports, "SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS", { enumerable: true, get: function () { return session_search_1.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS; } });

},
"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/rpc.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcId = RpcId;
exports.transportError = transportError;
const zod_1 = require("zod");
/**
 * Brands a string as RpcId (same precedent as core `SessionId()`). Minted by the initiator:
 * client-request → client mints; server-request → host mints (answerable frames get a stable
 * logical id, pure pushes mint a fresh one each time).
 * @param id - Raw id string (implementations mint UUIDs; tests may pass fixtures).
 * @returns The same string, branded (nominal string schema).
 */
function RpcId(id) {
    return zod_1.z.string().brand().parse(id);
}
/**
 * Fold a transport exception into the RpcResult error branch (unified error
 * API; 'internal' as the catch-all code). Lives with RpcResult so every
 * carrier consumer folds the same way.
 * @param error - the thrown value from the carrier.
 * @returns the error branch of an RpcResult.
 */
function transportError(error) {
    return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    };
}

},
"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.ts

"use strict";
/**
 * Message-layer zod schemas: the four wire full forms + error body +
 * carrier receipt. The payload slot is unknown in the full-form schemas — business payloads
 * get a second parse dispatched by method (two-level parse discipline).
 * Brand cast point: rpcIdSchema, and only there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rpcReceiptSchema = exports.rpcMessageSchema = exports.clientResponseSchema = exports.serverRequestSchema = exports.serverResponseSchema = exports.clientRequestSchema = exports.rpcErrorSchema = exports.rpcIdSchema = void 0;
exports.rpcResultSchema = rpcResultSchema;
const zod_1 = require("zod");
/**
 * RpcId: one brand cast after schema validation (the only cast point in this
 * file). No min-length: the id is an opaque echo token, and rejecting values
 * here would only turn a correlatable error report into a client-side parse
 * failure (the handler substitutes a sentinel when a request's id is unreadable).
 */
exports.rpcIdSchema = zod_1.z.string().brand().transform(value => value);
/** Error body: discriminated by code, per-branch details aligned to RpcErrorDetailsMap; details is required. */
exports.rpcErrorSchema = zod_1.z.discriminatedUnion('code', [
    zod_1.z.object({ code: zod_1.z.literal('bad-request'), message: zod_1.z.string(), details: zod_1.z.object({ issues: zod_1.z.array(zod_1.z.unknown()) }) }),
    zod_1.z.object({ code: zod_1.z.literal('cancelled'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('session-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('model-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ provider: zod_1.z.string(), model: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('session-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), requestedCwd: zod_1.z.string().optional(), existingCwd: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('invalid-time-zone'), message: zod_1.z.string(), details: zod_1.z.object({ value: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-attach-failed'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), workspaceId: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ workspaceId: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-invalid-path'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-name-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ name: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('workspace-move-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ workspaceId: zod_1.z.string(), sessionId: zod_1.z.string().brand().transform(value => value), beforeSessionId: zod_1.z.string().brand().transform(value => value).optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-unreadable'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-exists'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-create-failed'), message: zod_1.z.string(), details: zod_1.z.object({ path: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('directory-picker-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ capability: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-read-only'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-locked'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), agentPreset: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value), requestedPreset: zod_1.z.string(), existingPreset: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), available: zod_1.z.array(zod_1.z.string()) }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-preset-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ agentPreset: zod_1.z.string(), reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('agent-busy'), message: zod_1.z.string(), details: zod_1.z.object({ reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('attachment-error'), message: zod_1.z.string(), details: zod_1.z.object({ reason: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('queue-item-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ itemId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('steer-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ itemId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('command-error'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('unknown-command'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
    zod_1.z.object({ code: zod_1.z.literal('settings-rejected'), message: zod_1.z.string(), details: zod_1.z.object({ ns: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('settings-conflict'), message: zod_1.z.string(), details: zod_1.z.object({ ns: zod_1.z.string(), expected: zod_1.z.number(), actual: zod_1.z.number() }) }),
    zod_1.z.object({ code: zod_1.z.literal('credential-rejected'), message: zod_1.z.string(), details: zod_1.z.object({ ref: zod_1.z.string() }) }),
    zod_1.z.object({ code: zod_1.z.literal('model-discovery-failed'), message: zod_1.z.string(), details: zod_1.z.object({ settingsNs: zod_1.z.string(), baseURL: zod_1.z.string().optional() }) }),
    zod_1.z.object({ code: zod_1.z.literal('title-invalid'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('fork-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ sessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-parent-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ parentSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-not-found'), message: zod_1.z.string(), details: zod_1.z.object({ parentSessionId: zod_1.z.string().brand().transform(value => value), childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-catalog-diagnostic'), message: zod_1.z.string(), details: zod_1.z.object({
            parentSessionId: zod_1.z.string().brand().transform(value => value),
            childSessionId: zod_1.z.string().brand().transform(value => value),
            reason: zod_1.z.union([zod_1.z.literal('corrupt'), zod_1.z.literal('unsupported'), zod_1.z.literal('unavailable')]),
        }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-not-resumable'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-unauthorized'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('subagent-delivery-unavailable'), message: zod_1.z.string(), details: zod_1.z.object({ childSessionId: zod_1.z.string().brand().transform(value => value) }) }),
    zod_1.z.object({ code: zod_1.z.literal('internal'), message: zod_1.z.string(), details: zod_1.z.object({}) }),
]);
/**
 * Business success/failure result schema (generic, reusable).
 * @param value - Schema for the business value.
 * @returns Schema for RpcResult<T>.
 */
function rpcResultSchema(value) {
    return zod_1.z.union([
        zod_1.z.object({ ok: zod_1.z.literal(true), value }),
        zod_1.z.object({ ok: zod_1.z.literal(false), error: exports.rpcErrorSchema }),
    ]);
}
// ---- The four wire full-form schemas (payload/result.value slots stay wide — business layer does the second parse) ----
// The wide value slot is optional: a void business result serializes with no
// `value` field at all. Each endpoint's own second parse still requires its
// declared value, so absence never passes for a method that returns data.
/** ClientRequest full form (payload stays wide — the business layer runs the second parse). */
exports.clientRequestSchema = zod_1.z.object({
    type: zod_1.z.literal('client-request'),
    rpcId: exports.rpcIdSchema,
    method: zod_1.z.string(),
    payload: zod_1.z.unknown(),
});
/** ServerResponse full form (result.value stays wide). */
exports.serverResponseSchema = zod_1.z.object({
    type: zod_1.z.literal('server-response'),
    rpcId: exports.rpcIdSchema,
    result: rpcResultSchema(zod_1.z.unknown().optional()),
});
/** ServerRequest full form (payload stays wide). */
exports.serverRequestSchema = zod_1.z.object({
    type: zod_1.z.literal('server-request'),
    rpcId: exports.rpcIdSchema,
    method: zod_1.z.string(),
    payload: zod_1.z.unknown(),
});
/** ClientResponse full form (result.value stays wide). */
exports.clientResponseSchema = zod_1.z.object({
    type: zod_1.z.literal('client-response'),
    rpcId: exports.rpcIdSchema,
    result: rpcResultSchema(zod_1.z.unknown().optional()),
});
/** Wire full-form union (discriminated by type). */
exports.rpcMessageSchema = zod_1.z.discriminatedUnion('type', [
    exports.clientRequestSchema,
    exports.serverResponseSchema,
    exports.serverRequestSchema,
    exports.clientResponseSchema,
]);
/** Carrier receipt schema. */
exports.rpcReceiptSchema = zod_1.z.union([
    zod_1.z.object({ accepted: zod_1.z.literal(true) }),
    zod_1.z.object({ accepted: zod_1.z.literal(false), reason: zod_1.z.union([zod_1.z.literal('not-pending'), zod_1.z.literal('bad-response')]) }),
]);

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
"src/modules/client-runtime/agents/scope.js": function(module, exports, require) {
// source: src/modules/client-runtime/agents/scope.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScope = createScope;
exports.scopeOf = scopeOf;
const cordis_1 = require("@xharness/cordis");
const types_1 = require("../../client-connection/contracts/core/session/types");
/**
 * Client Agent-scope primitive: mint a Cordis context tagged with the owning
 * Agent's identity. The mechanism mirrors the host `dsh-scope` architecture
 * (no-op plugin fiber + context tag + `Context.filter` routing predicate);
 * the shape deliberately diverges: the filter lives on the actx itself
 * instead of a separate carrier object, so scoped dispatch is plain cordis —
 * `actx.bail(actx, event, payload)` / `actx.emit(actx, ...)` — with no
 * wrapper. The host needs a detached carrier because its dispatch subject is
 * the business Agent object; client scope events carry only ids, so the
 * actx is the natural subject. The second divergence stands: the scope key
 * is the branded `SessionId` (value compared), not an object identity — the
 * agent and its session share one id (1:1, same axis; no separate AgentId
 * brand), and a client scope's identity IS that wire id. Third divergence,
 * deliberate: the client scopes the Agent IDENTITY, not a live Agent object
 * — a cold session's host Agent is already disposed while its client actx
 * stays alive for history viewing.
 */
const context_1 = require("../context");
/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope');
/** Shared no-op plugin backing each Agent scope fiber. */
function agentScope() { }
/**
 * Mint an Agent scope under `ctx`: a no-op plugin fiber whose context
 * carries the agent tag and the dispatch filter — untagged listeners are
 * admitted globally, tagged listeners only for a matching agent.
 * Registrations through the returned ctx dispose with the fiber.
 * @param ctx - client root context the scope fiber mounts under.
 * @param key - owning agent identity (the routing tag; agent id === session id).
 * @returns the tagged context and its backing fiber.
 */
function createScope(ctx, key) {
    const fiber = ctx.plugin(agentScope);
    const scoped = fiber.ctx.extend({
        [kScope]: key,
        [context_1.Context.filter](listenerCtx) {
            const tag = scopeOf(listenerCtx);
            return tag === undefined || tag === key;
        },
    });
    if (!isAgentContext(scoped))
        throw new Error('agent scope is missing its Remote capability');
    return {
        fiber,
        ctx: scoped,
    };
}
/**
 * Read the nearest agent tag inherited by a context.
 * @param ctx - any client context.
 * @returns its agent identity (the session id), or undefined for root contexts.
 */
function scopeOf(ctx) {
    const value = Reflect.get(ctx, kScope);
    return typeof value === 'string' ? (0, types_1.SessionId)(value) : undefined;
}
/** The scope is minted above, while Remote's generated receiver reads the same scoped ctx. */
function isAgentContext(ctx) {
    return cordis_1.Context.is(ctx) && scopeOf(ctx) !== undefined
        && typeof ctx.remote.commands.execute === 'function';
}

},
"src/modules/client-runtime/sessions/manager.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/manager.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const types_1 = require("../../client-connection/contracts/core/session/types");
const value_guards_1 = require("../value-guards");
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
const index_1 = require("../../client-connection/contracts/host/apiproxy/api/index");
const ordered_baseline_1 = require("../ordered-baseline");
const lineage_1 = require("./lineage");
const notifier_1 = require("./notifier");
const projection_store_1 = require("./projection-store");
const session_1 = require("./session");
const history_cache_1 = require("./history-cache");
/** Stable identity of a frame retained until an uninstantiated Session can consume it. */
function bufferedRequestKey(envelope) {
    const frame = envelope.payload;
    switch (frame.type) {
        case 'approval/requested': return `a:${frame.approvalId}`;
        case 'question/requested': return `q:${envelope.rpcId}`;
        case 'session/queue': return 'queue';
        /* v8 ignore next -- pendingBuffers contains only the three frame types above. */
        default: return undefined;
    }
}
/** Match ui-user-questions's binary plan-review routing at the wire boundary. */
function questionInteractionStatus(questions) {
    if (questions.length !== 1)
        return 'question';
    const question = questions[0];
    if (question === undefined)
        return 'question';
    const intent = question.intent;
    if (intent?.kind !== 'plan-review' || question.detail === undefined)
        return 'question';
    if (question.multiSelect === true)
        return 'question';
    const options = question.options ?? [];
    if (options.length > 2)
        return 'question';
    return options.some(option => option.label === intent.approve) ? 'plan-review' : 'question';
}
/** Instance cluster + frame entry + the session list. */
class SessionManager {
    historyCache() {
        return this.xhHistoryCache ?? (this.xhHistoryCache = new history_cache_1.HistoryCache(this));
    }
    isCurrent(id) { return this.selected === id; }
    hasPendingInteractions(id) { return (this.pendingInteractions.get(id)?.size ?? 0) > 0; }
    historyCacheStats() { return this.historyCache().trim(); }
    /**
     * @param api - shared wire client.
     * @param restoredSelection - persisted real-Session selection candidate.
     */
    constructor(api, remote, restoredSelection, restoredAddress, conversation) {
        this.api = api;
        this.remote = remote;
        this.conversation = conversation;
        this.sessions = new Map();
        /** Pre-instantiation buffer for answerable requests and the queued-turn snapshot, which history
         *  cannot reconstruct on open. Live requests remain until resolution; queue and replay duplicates
         *  compact by identity. Instantiation replays and clears it, while removal drops it. */
        this.pendingBuffers = new Map();
        /** Outstanding answerable interactions per session, keyed by their stable request identity.
         *  Manager-owned rather than read off Session instances because the sidebar must light up for
         *  sessions never instantiated. Cleared per connection generation — the reopen replay re-adds
         *  still-pending requests — and on session-removed. */
        this.pendingInteractions = new Map();
        /**
         * Sessions that finished running while not selected — the sidebar's green
         * "done" reminder (manager-owned, survives connection generations; cleared
         * on select and session-removed, re-armed by the next completion).
         */
        this.completedNotifications = new Set();
        /** Last-observed running bits per session; the true→false edge here arms {@link completedNotifications}. */
        this.prevRunning = new Map();
        /** Per-session projection value stores, retained independently of instance arrival (the
         *  title-snapshot precedent, generalized): push frames land here whether or not the Session
         *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
         *  same store so history-baseline seeding and frames converge on one row set. */
        this.projectionStores = new Map();
        this.summaries = [];
        this.deletedSessionIds = new Set();
        this.listState = 'idle';
        /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
        this.listPhase = 'pending';
        this.listError = null;
        this.listInflight = null;
        this.xhCatalogRefreshRequested = false;
        this.xhCatalogRefreshRunning = false;
        /** Mutations arriving after a list request starts are replayed over its response. */
        this.listMutations = null;
        this.addresses = new Map();
        this.catalogs = new Map();
        this.catalogInflight = new Map();
        /** Catalog owners whose membership changed while a pull was in flight: one trailing refresh after it settles. */
        this.catalogStale = new Set();
        this.openCatalogs = new Set();
        this.catalogDebounce = new Map();
        /**
         * Background jobs per session, last-wins from `session/jobs`. An empty set
         * is stored as an absent key, so absence and `[]` are one representation.
         */
        this.jobsBySession = new Map();
        /** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
         *  object when every field matches — wire refreshes mint all-new summary objects, so identity
         *  must be recovered by value or every SessionListItem memo misses on every refresh. */
        this.entryCache = new Map();
        this.itemsCache = [];
        this.notifier = new notifier_1.Notifier(() => {
            this.listSnapshotCache = this.buildListSnapshot();
        });
        this.selected = restoredSelection;
        if (restoredAddress !== undefined)
            this.addresses.set(restoredAddress.childSessionId, restoredAddress);
        this.listSnapshotCache = this.buildListSnapshot();
    }
    // ---- Selection ----
    /**
     * Select a listed Session or a retained catalog-addressed child.
     * @param sessionId - listed or catalog-addressed Session id.
     */
    select(sessionId) {
        const address = this.navigationAddress(sessionId);
        if (!this.summaries.some(summary => summary.sessionId === sessionId) && address === undefined) {
            throw new Error(`sessions.select: unknown session ${sessionId}`);
        }
        if (address !== undefined)
            this.addresses.set(sessionId, address);
        this.sessions.get(sessionId)?.configureSubagent(address, address === undefined
            ? false
            : this.catalogs.get(address.parentSessionId)?.parentAvailable ?? false);
        this.selected = sessionId;
        // Looking at the session consumes its completion reminder (dot clears).
        this.completedNotifications.delete(sessionId);
        void this.refreshSubagents(sessionId);
        this.notifier.notifyNow();
        this.historyCache().touch(this.selected);
    }
    /**
     * Select a healthy child through its durable direct-parent address.
     * @param address - catalog-derived parent and child ids.
     */
    selectSubagent(address) {
        const catalog = this.catalogs.get(address.parentSessionId);
        const entry = catalog?.entries.find(candidate => candidate.id === address.childSessionId);
        if (entry === undefined || entry.kind !== 'child' || entry.mode !== address.mode) {
            throw new Error(`sessions.selectSubagent: ${address.childSessionId} is not a healthy catalog child`);
        }
        this.addresses.set(address.childSessionId, address);
        this.sessions.get(address.childSessionId)?.configureSubagent(address, catalog?.parentAvailable ?? false);
        this.selected = address.childSessionId;
        this.completedNotifications.delete(address.childSessionId);
        void this.refreshSubagents(address.childSessionId);
        this.notifier.notifyNow();
        this.historyCache().touch(this.selected);
    }
    /** Clear the selection (the layout falls to the no-session view state). */
    clearSelection() {
        this.selected = undefined;
        this.notifier.notifyNow();
        this.historyCache().touch(this.selected);
    }
    /**
     * Return the durable catalog address retained for one child.
     * @param sessionId - possible addressed child id.
     * @returns The direct-parent address, when navigation discovered one.
     */
    subagentAddress(sessionId) {
        return this.addresses.get(sessionId);
    }
    /**
     * Resolve an address for breadcrumb navigation without retaining transport authority.
     * @param sessionId - possible child id in an already-loaded catalog.
     * @returns A retained or catalog-derived direct-parent address.
     */
    navigationAddress(sessionId) {
        const retained = this.addresses.get(sessionId);
        if (retained !== undefined)
            return retained;
        for (const [parentSessionId, catalog] of this.catalogs) {
            const child = catalog.entries.find(entry => entry.kind === 'child' && entry.id === sessionId);
            if (child?.kind === 'child') {
                return { parentSessionId, childSessionId: sessionId, mode: child.mode };
            }
        }
        return undefined;
    }
    // ---- Instance management ----
    /**
     * Drop a session instance (scope-prune companion: instance
     * and scope share one lifecycle). The host session log is the durable
     * truth — a later get() lazily rebuilds and open() backfills history.
     * @param sessionId - the session to drop.
     */
    drop(sessionId) {
        this.xhHistoryCache?.forget(sessionId);
        this.sessions.delete(sessionId);
    }
    /**
     * Lazy build: return the existing instance or construct one (no auto-open —
     * open is triggered by the container's select callback).
     * @param sessionId - the session to get.
     * @returns the resident instance.
     */
    get(sessionId) {
        let session = this.sessions.get(sessionId);
        if (session === undefined) {
            session = this.createSession(sessionId);
            this.sessions.set(sessionId, session);
            // Replay approval/question/queued frames buffered before instantiation (rpcId
            // verbatim, same semantics as the subscribed baseline replay). Replay happens
            // BEFORE the running-bit sync: a not-running summary must sweep replayed queue
            // rows the same way a live status flip would (their retirement events dropped
            // while the session was uninstantiated).
            const buffered = this.pendingBuffers.get(sessionId);
            if (buffered !== undefined) {
                this.pendingBuffers.delete(sessionId);
                for (const envelope of buffered)
                    session.handleMuxEnvelope(envelope.rpcId, envelope.payload);
            }
            // Sync the running and blank bits from the list snapshot into the new
            // instance (consistency when the list precedes open).
            const summary = this.summaries.find(s => s.sessionId === sessionId);
            if (summary !== undefined) {
                session.handleBlank(summary.blank);
                session.handleRunning(summary.running);
            }
            else {
                const address = this.addresses.get(sessionId);
                const child = address === undefined ? undefined : this.catalogs.get(address.parentSessionId)?.entries
                    .find(entry => entry.kind === 'child' && entry.id === sessionId);
                if (child?.kind === 'child') {
                    // A catalogued child exists only after its delegated session has
                    // durable history, even though child rows do not carry `blank`.
                    session.handleBlank(false);
                    session.handleRunning(child.activity === 'running');
                }
            }
        }
        this.historyCache().track(session);
        return session;
    }
    createSession(sessionId) {
        const address = this.addresses.get(sessionId);
        return new session_1.Session(sessionId, this.api, this.remote, {
            cooperativeEvents: true,
            ...(address === undefined ? {} : {
                address,
                parentAvailable: this.catalogs.get(address.parentSessionId)?.parentAvailable ?? false,
            }),
            // The sender's local first-send flip mirrors into the list row so the
            // session surfaces (lists filter on blank) before any host frame lands.
            onEngaged: (engaged) => {
                this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId });
            },
            projections: this.projectionStore(sessionId),
            ...this.conversation === undefined ? {} : { conversation: this.conversation },
        });
    }
    /** Rebuild every resident Session after one coalesced registry transaction. */
    rebuildConversationRegistry() {
        for (const session of this.sessions.values())
            session.rebuildConversationRegistry();
    }
    /** Resident per-session projection store (create-on-demand; outlives instantiation). */
    projectionStore(sessionId) {
        let store = this.projectionStores.get(sessionId);
        if (store === undefined) {
            store = new projection_store_1.ProjectionValueStore();
            // List rows project off store keys (title); any-key changes re-enter
            // the manager's own batched rebuild channel.
            const observedStore = store;
            store.subscribeAny(() => { this.notifier.markDirty(); });
            store.faceOf('sessionListMetadata').subscribe(() => { this.reconcileBlank(sessionId, observedStore); });
            this.projectionStores.set(sessionId, store);
        }
        return store;
    }
    /** A replayed history's non-blank fact also governs New Session reuse. */
    reconcileBlank(sessionId, store) {
        const metadata = store.get('sessionListMetadata');
        if (!(0, value_guards_1.isRecord)(metadata) || metadata.blank !== false)
            return;
        if (this.summaries.some(summary => summary.sessionId === sessionId && summary.blank)) {
            this.recordMutation({ kind: 'engaged', sessionId });
        }
        this.sessions.get(sessionId)?.handleBlank(false);
    }
    /**
     * Refresh one direct-child catalog, reusing its in-flight request.
     * @param parentSessionId - catalog owner.
     */
    refreshSubagents(parentSessionId) {
        const existing = this.catalogInflight.get(parentSessionId);
        if (existing !== undefined)
            return existing.promise;
        const previous = this.catalogs.get(parentSessionId);
        const expandableRows = new Set();
        const activityRows = new Map();
        this.catalogs.set(parentSessionId, {
            entries: previous?.entries ?? [],
            parentAvailable: previous?.parentAvailable ?? false,
            state: 'loading',
            error: null,
        });
        this.notifier.markDirty();
        const operation = (async () => {
            try {
                const { result } = await this.api.subagents.list({ parentSessionId });
                if (result.ok) {
                    const parentAvailable = this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
                        ?? result.value.parentAvailable;
                    this.catalogs.set(parentSessionId, {
                        ...result.value,
                        entries: this.withCatalogMutations(result.value.entries, expandableRows, activityRows),
                        parentAvailable,
                        state: 'ready',
                        error: null,
                    });
                    for (const [childId, address] of this.addresses) {
                        if (address.parentSessionId !== parentSessionId)
                            continue;
                        this.sessions.get(childId)?.handleSubagentParentAvailable(parentAvailable);
                    }
                }
                else {
                    this.catalogs.set(parentSessionId, {
                        entries: this.withCatalogMutations(previous?.entries ?? [], expandableRows, activityRows),
                        parentAvailable: this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
                            ?? previous?.parentAvailable ?? false,
                        state: 'error',
                        error: result.error,
                    });
                }
            }
            catch (error) {
                const folded = (0, index_1.transportError)(error);
                this.catalogs.set(parentSessionId, {
                    entries: this.withCatalogMutations(previous?.entries ?? [], expandableRows, activityRows),
                    parentAvailable: this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
                        ?? previous?.parentAvailable ?? false,
                    state: 'error',
                    error: folded.ok ? null : folded.error,
                });
            }
            finally {
                this.catalogInflight.delete(parentSessionId);
                // Re-arm the trailing pull before the dirty notify: the response the
                // caller observed predates the stale-marking change, so the follow-up
                // refresh is the only carrier of that change.
                if (this.catalogStale.delete(parentSessionId))
                    void this.refreshSubagents(parentSessionId);
                this.notifier.markDirty();
            }
        })();
        this.catalogInflight.set(parentSessionId, {
            promise: operation,
            expandableRows,
            activityRows,
            parentAvailableOverride: undefined,
        });
        return operation;
    }
    /**
     * Mark whether a catalog menu is consuming live membership updates.
     * @param parentSessionId - catalog owner.
     * @param open - current menu state.
     */
    setSubagentCatalogOpen(parentSessionId, open) {
        if (open) {
            this.openCatalogs.add(parentSessionId);
            void this.refreshSubagents(parentSessionId);
        }
        else {
            this.openCatalogs.delete(parentSessionId);
            const timer = this.catalogDebounce.get(parentSessionId);
            if (timer !== undefined) {
                clearTimeout(timer);
                this.catalogDebounce.delete(parentSessionId);
            }
        }
    }
    // ---- List API ----
    /** Full refresh via session.list (single-flight: an in-flight call is reused). */
    refreshList() {
        if (this.listInflight !== null)
            return this.listInflight;
        this.listState = 'loading';
        this.listError = null;
        const established = this.summaries;
        const mutations = [];
        this.listMutations = mutations;
        this.notifier.markDirty();
        this.listInflight = (async () => {
            try {
                const { result } = await this.api.sessions.list({});
                if (result.ok) {
                    const baseline = this.listPhase === 'pending'
                        ? result.value.items
                        : (0, ordered_baseline_1.mergeOrderedBaseline)(established, result.value.items, summary => summary.sessionId);
                    // Seed first observations from the pull-time baseline BEFORE replaying
                    // in-flight mutations, then reconcile the reminders after EVERY
                    // replayed mutation: an edge that happens entirely between mutations
                    // (baseline idle → running → idle) must still arm, which a single
                    // sync on the folded result would collapse away.
                    for (const s of baseline) {
                        if (!this.prevRunning.has(s.sessionId))
                            this.prevRunning.set(s.sessionId, s.running);
                    }
                    let summaries = baseline.filter(row => !this.deletedSessionIds.has(row.sessionId));
                    for (const mutation of mutations) {
                        summaries = applyMutation(summaries, mutation);
                        this.summaries = summaries;
                        this.syncCompletedNotifications();
                    }
                    this.summaries = summaries;
                    this.listState = 'idle';
                    this.listPhase = 'ready';
                    // Covers the empty-mutations pull (a plain baseline carries no edge).
                    this.syncCompletedNotifications();
                    // Push running/blank bits down to instantiated Sessions (the list is the authoritative summary source).
                    for (const s of this.summaries) {
                        const session = this.sessions.get(s.sessionId);
                        if (session === undefined)
                            continue;
                        session.handleBlank(s.blank);
                        session.handleRunning(s.running);
                    }
                    // Seed each row's projection baseline into the per-session value
                    // store (cold titles surface without opening the session). Per-key
                    // apply, not seed(): the list block is a partial baseline — the
                    // cold cache serves only version-matching keys — so an absent key
                    // must not clear; higher-seq-wins still keeps a stale list block
                    // from overwriting a newer push frame or tail baseline.
                    for (const s of result.value.items) {
                        const block = s.projections;
                        const store = block === undefined
                            ? this.projectionStores.get(s.sessionId)
                            : this.projectionStore(s.sessionId);
                        if (store === undefined)
                            continue;
                        if (block !== undefined) {
                            const values = block.values;
                            if (!(0, value_guards_1.isRecord)(values))
                                throw new Error('invalid session-list projection values');
                            for (const key of Object.keys(values))
                                store.apply(key, values[key], block.asOfSeq);
                        }
                        if (s.blank)
                            this.reconcileBlank(s.sessionId, store);
                    }
                }
                else {
                    this.listState = 'error';
                    this.listError = result.error;
                }
            }
            catch (error) {
                this.listState = 'error';
                const folded = (0, index_1.transportError)(error);
                /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
                this.listError = folded.ok ? null : folded.error;
            }
            finally {
                this.listMutations = null;
                this.listInflight = null;
                this.notifier.markDirty();
            }
        })();
        return this.listInflight;
    }
    /**
     * Search visible session message content without adding transient query
     * state to the list snapshot.
     * @param query - non-blank literal phrase.
     * @param signal - cancellation for superseded UI queries.
     * @returns the Host result or a folded transport error.
     */
    async search(query, signal) {
        try {
            return (await this.api.sessions.search({ query }, signal)).result;
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /**
     * Contract session.create; on success merge into summaries immediately (no
     * wait for the next refresh). A created session is blank by definition
     * (entity birth precedes the first message).
     * @param opts - target workspace or working directory, plus an optional caller-owned id.
     * @returns the create result.
     */
    async create(opts = {}) {
        try {
            const shared = opts.sessionId === undefined ? {} : { sessionId: opts.sessionId };
            const payload = opts.workspaceId !== undefined
                ? { workspaceId: opts.workspaceId, ...shared }
                : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared };
            const { result } = await this.api.sessions.create(payload);
            if (result.ok) {
                this.recordMutation({ kind: 'upsert', summary: {
                        sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
                        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
                        ...(result.value.agentPreset !== undefined ? { agentPreset: result.value.agentPreset } : {}),
                    } });
            }
            else {
                const publishedSessionId = workspaceAttachSessionId(result.error);
                // Publication precedes attachment. The error's id is a real Session,
                // so expose it immediately as Ungrouped while the caller keeps the
                // prompt buffer and decides whether to retry attachment.
                if (publishedSessionId !== undefined) {
                    this.recordMutation({ kind: 'upsert', summary: {
                            sessionId: publishedSessionId,
                            updatedAt: Date.now(),
                            running: false,
                            blank: true,
                        } });
                }
            }
            return result;
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /**
     * Contract session.fork; on success merge the child into summaries
     * immediately (same synchronous-addressability guarantee as create). The
     * ordinary fork carries source history and is not blank. An edit-before-user
     * fork stays conservatively blank until host history/admission settles it;
     * lineage rides parentSessionId and origin so the list nests it under its
     * source without treating it as a subagent. A child published
     * before Workspace attachment fails is also reconciled into the list.
     * @param opts - source session and the optional event/user seq anchoring the cut.
     * @returns the fork result (the child session id).
     */
    async fork(opts) {
        try {
            const source = this.summaries.find(s => s.sessionId === opts.sessionId);
            const { result } = await this.api.sessions.fork({
                sessionId: opts.sessionId,
                ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
                ...opts.beforeUserSeq === undefined ? {} : { beforeUserSeq: opts.beforeUserSeq },
            });
            const childId = result.ok
                ? result.value.sessionId
                : workspaceAttachSessionId(result.error);
            if (childId !== undefined) {
                this.recordMutation({ kind: 'upsert', summary: {
                        sessionId: childId, updatedAt: Date.now(), running: false, blank: opts.beforeUserSeq !== undefined,
                        parentSessionId: opts.sessionId,
                        origin: 'fork',
                        ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
                    } });
            }
            return result;
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /**
     * Insert-or-enrich a locally synthesized summary: a new id prepends; an
     * existing entry only gains fields it lacks (the session-added frame and the
     * create() echo race — whichever lands second must fill the placeholder's
     * missing cwd/parentSessionId, never overwrite list-refresh data).
     */
    mergeSummary(summary) {
        this.recordMutation({ kind: 'upsert', summary });
    }
    /**
     * Record a host-confirmed composition switch (see ISessions.noteAgentPreset).
     * @param sessionId - the switched session.
     * @param agentPreset - the preset id the host confirmed.
     */
    noteAgentPreset(sessionId, agentPreset) {
        this.recordMutation({ kind: 'upsert', summary: {
                sessionId, updatedAt: Date.now(), running: false, blank: true, agentPreset,
            } });
    }
    /** Apply immediately and retain for replay when a list response is in flight. */
    recordMutation(mutation) {
        const id = mutation.kind === 'upsert' ? mutation.summary.sessionId : mutation.sessionId;
        if (this.deletedSessionIds.has(id) && mutation.kind !== 'remove')
            return;
        this.listMutations?.push(mutation);
        this.summaries = applyMutation(this.summaries, mutation);
        // Eager edge reconciliation — a snapshot-build-time pass would miss consecutive status frames.
        this.syncCompletedNotifications();
        this.notifier.markDirty();
    }
    /** Durable deletion is distinct from a child Activation temporarily detaching. */
    forgetDeletedSessions(ids) {
        for (const sessionId of ids) {
            this.deletedSessionIds.add(sessionId);
            this.removeSession(sessionId, true);
        }
        this.notifier.notifyNow();
    }
    removeSession(sessionId, permanent) {
        const summary = this.summaries.find(candidate => candidate.sessionId === sessionId);
        if (permanent)
            this.deletedSessionIds.add(sessionId);
        const durableSubagent = !permanent && (summary?.origin === 'subagent' || this.addresses.has(sessionId));
        this.recordMutation(durableSubagent
            ? { kind: 'status', sessionId, running: false }
            : { kind: 'remove', sessionId });
        this.updateCatalogActivity(sessionId, false);
        if (durableSubagent) {
            // An Activation detaching is not durable child deletion:
            // keep its lineage and conversation while returning it to idle.
            this.sessions.get(sessionId)?.handleRunning(false);
        }
        else {
            this.sessions.get(sessionId)?.handleRemoved();
        }
        this.pendingBuffers.delete(sessionId); // a removed session's buffered frames must not replay on a future instantiation
        this.pendingInteractions.delete(sessionId); // a removed session cannot wait on anyone
        // Owner disposal already dropped these registry-side, but that lands on
        // the mux stream while this frame rides the host stream, so the two have
        // no relative order. Clearing here makes a detached Activation's rows
        // disappear whichever arrives first.
        this.jobsBySession.delete(sessionId);
        if (!durableSubagent)
            this.projectionStores.delete(sessionId);
        // A pull already in flight was requested before this removal and can
        // carry the pre-removal parentAvailable:true, which would resurrect
        // the writable editor this invalidation just closed. Replay false over
        // that response and queue one trailing refresh so the post-removal
        // host truth converges.
        const inflightCatalog = this.catalogInflight.get(sessionId);
        if (inflightCatalog !== undefined) {
            inflightCatalog.parentAvailableOverride = false;
            this.catalogStale.add(sessionId);
        }
        // The removed session can no longer be the delivery owner of its
        // catalog: invalidate availability immediately. Removal schedules no
        // catalog refresh, and without this an addressed child keeps a
        // writable editor against a dead continuation owner until an
        // unrelated refresh (or forever, for a closed menu).
        const ownedCatalog = this.catalogs.get(sessionId);
        if (ownedCatalog !== undefined && ownedCatalog.parentAvailable) {
            this.catalogs.set(sessionId, { ...ownedCatalog, parentAvailable: false });
        }
        for (const [childId, address] of this.addresses) {
            if (address.parentSessionId !== sessionId)
                continue;
            this.sessions.get(childId)?.handleSubagentParentAvailable(false);
        }
        if (permanent) {
            this.addresses.delete(sessionId);
            for (const [parentId, catalog] of this.catalogs) {
                this.catalogs.set(parentId, { ...catalog, entries: catalog.entries.filter(entry => entry.id !== sessionId) });
            }
        }
    }
    // ---- Subscription API (for useSessionList) ----
    /**
     * uSES subscription entry for useSessionList.
     * @param listener - change callback.
     * @returns the unsubscribe function.
     */
    subscribe(listener) {
        return this.notifier.subscribe(listener);
    }
    /**
     * Cached list snapshot (rebuilt lazily when dirty with no listeners).
     * @returns the cached reference (stable until the next flush).
     */
    getListSnapshot() {
        this.notifier.ensureFresh();
        return this.listSnapshotCache;
    }
    /** Add or refresh one stable pending-interaction identity. */
    trackPending(sessionId, key, status) {
        let interactions = this.pendingInteractions.get(sessionId);
        if (interactions === undefined) {
            interactions = new Map();
            this.pendingInteractions.set(sessionId, interactions);
        }
        if (interactions.get(key) === status)
            return;
        interactions.set(key, status);
        this.notifier.markDirty();
    }
    /** Settle one pending-interaction identity without disturbing sibling waits. */
    resolvePending(sessionId, key) {
        const interactions = this.pendingInteractions.get(sessionId);
        if (interactions === undefined || !interactions.delete(key))
            return;
        if (interactions.size === 0)
            this.pendingInteractions.delete(sessionId);
        this.notifier.markDirty();
    }
    // ---- ConnectionController sinks (wired by boot) ----
    /**
     * Mux frame entry: sessionId-bearing frames go only to instantiated sessions
     * (no lazy build; non-pending frames for uninstantiated sessions drop —
     * history backfills them on open).
     * @param envelope - the frame with its wire rpcId.
     */
    handleMuxEnvelope(envelope) {
        const frame = envelope.payload;
        if (frame.type === 'stream/error')
            return; // Controller already treats this as stream failure
        if (this.deletedSessionIds.has(frame.sessionId))
            return; // Never retain late frames for durably deleted identities
        if (frame.type === 'session/event'
            && frame.event.type === 'user/message'
            && (0, value_guards_1.isRecord)(frame.event.data) && (0, value_guards_1.isRecord)(frame.event.data.source)
            && frame.event.data.source.kind === 'user') {
            // session.list supplies the cold baseline, while a direct prompt or an
            // admitted steer advances it between pulls. Max keeps replayed or
            // repaired older user messages from moving the row backwards.
            this.recordMutation({ kind: 'activity', sessionId: frame.sessionId, updatedAt: frame.event.time });
        }
        if (frame.type === 'session/projection') {
            // Finished host-computed value: land it in the resident store whether or
            // not the Session is instantiated (list rows read the 'title' key). The
            // synchronous markDirty keeps the list snapshot same-tick fresh (the
            // store's own any-key channel is microtask-batched).
            const store = this.projectionStore(frame.sessionId);
            store.apply(frame.key, frame.value, frame.seq);
            if (frame.key === 'sessionListMetadata')
                this.reconcileBlank(frame.sessionId, store);
            this.notifier.markDirty();
            return;
        }
        if (frame.type === 'session/jobs') {
            // Whole-set snapshot, so last-wins with no reconciliation. The Host omits
            // the baseline for an empty set, which is the same fact an emptying change
            // reports as `[]` — both land as an absent key.
            if (frame.jobs.length === 0)
                this.jobsBySession.delete(frame.sessionId);
            else
                this.jobsBySession.set(frame.sessionId, frame.jobs);
            this.notifier.markDirty();
            return;
        }
        if (frame.type === 'session/subscribed') {
            // Rows past the host's durable baseline rode state a restart lost; drop
            // them so last-wins cannot pin a phantom value over recomputed truth.
            this.projectionStores.get(frame.sessionId)?.truncate(frame.lastSeq);
            // Same re-baseline reasoning as the queue below: this generation sends a
            // task baseline only when the set is non-empty, so a mirror kept from the
            // previous generation would survive as a phantom list.
            this.jobsBySession.delete(frame.sessionId);
            this.notifier.markDirty();
            // New mux-generation baseline: discard the previous queue snapshot.
            // The host omits session/queue when the live queue is empty, so retaining
            // it could replay stale work when the Session is instantiated later.
            // This is the same re-baseline signal Session uses for its own mirror.
            const buffered = this.pendingBuffers.get(frame.sessionId);
            if (buffered !== undefined) {
                const kept = buffered.filter(item => item.payload.type !== 'session/queue');
                if (kept.length !== buffered.length) {
                    if (kept.length === 0)
                        this.pendingBuffers.delete(frame.sessionId);
                    else
                        this.pendingBuffers.set(frame.sessionId, kept);
                }
            }
        }
        // List-level pending-interaction status (the sidebar amber dot): tracked
        // for every session, instantiated or not; stable keys make replays idempotent.
        if (frame.type === 'approval/requested') {
            this.trackPending(frame.sessionId, `a:${frame.approvalId}`, 'approval');
        }
        else if (frame.type === 'approval/resolved') {
            this.resolvePending(frame.sessionId, `a:${frame.approvalId}`);
        }
        else if (frame.type === 'question/requested') {
            this.trackPending(frame.sessionId, `q:${envelope.rpcId}`, questionInteractionStatus(frame.questions));
        }
        else if (frame.type === 'question/resolved') {
            this.resolvePending(frame.sessionId, `q:${frame.questionRpcId}`);
        }
        const session = this.sessions.get(frame.sessionId);
        if (session === undefined) {
            // Answerable requests never hit history: retain each live identity until
            // instantiation, compacting replay duplicates and resolutions so list
            // status cannot outlive the PendingWait the user would need to answer.
            // Queue is a latest-value snapshot; everything else drops because open
            // backfills it from history.
            switch (frame.type) {
                case 'approval/requested':
                case 'question/requested':
                case 'session/queue': {
                    const buffer = this.pendingBuffers.get(frame.sessionId) ?? [];
                    const key = frame.type === 'approval/requested'
                        ? `a:${frame.approvalId}`
                        : frame.type === 'question/requested' ? `q:${envelope.rpcId}` : 'queue';
                    const prior = buffer.findIndex(item => bufferedRequestKey(item) === key);
                    if (prior === -1)
                        buffer.push(envelope);
                    else
                        buffer[prior] = envelope;
                    this.pendingBuffers.set(frame.sessionId, buffer);
                    return;
                }
                case 'approval/resolved':
                case 'question/resolved': {
                    const buffer = this.pendingBuffers.get(frame.sessionId);
                    if (buffer === undefined)
                        return;
                    const key = frame.type === 'approval/resolved'
                        ? `a:${frame.approvalId}`
                        : `q:${frame.questionRpcId}`;
                    const prior = buffer.findIndex(item => bufferedRequestKey(item) === key);
                    if (prior !== -1)
                        buffer.splice(prior, 1);
                    if (buffer.length === 0)
                        this.pendingBuffers.delete(frame.sessionId);
                    return;
                }
                default:
                    return;
            }
        }
        session.handleMuxEnvelope(envelope.rpcId, frame);
    }
    /** Coalesce discovery batches, then replay after the initial or current list baseline. */
    requestCatalogRefresh() {
        this.xhCatalogRefreshRequested = true;
        if (this.xhCatalogRefreshRunning)
            return;
        this.xhCatalogRefreshRunning = true;
        void (async () => {
            try {
                do {
                    if (this.listInflight !== null)
                        await this.listInflight;
                    this.xhCatalogRefreshRequested = false;
                    await this.refreshList();
                } while (this.xhCatalogRefreshRequested);
            }
            finally {
                this.xhCatalogRefreshRunning = false;
            }
        })();
    }
    /**
     * Host frame entry: list upkeep + per-instance running/removed/agent-error relay.
     * @param envelope - the frame with its wire rpcId.
     */
    handleHostEnvelope(envelope) {
        const frame = envelope.payload;
        if ('sessionId' in frame && this.deletedSessionIds.has(frame.sessionId))
            return;
        switch (frame.type) {
            case 'host/remote-event': {
                if (frame.event === 'xharness/catalog-updated')
                    this.requestCatalogRefresh();
                return;
            }
            case 'host/session-added': {
                this.mergeSummary({
                    sessionId: frame.sessionId, updatedAt: Date.now(), running: false, blank: frame.blank,
                    ...(frame.parentSessionId !== undefined ? { parentSessionId: frame.parentSessionId } : {}),
                    ...(frame.origin !== undefined ? { origin: frame.origin } : {}),
                    ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
                    ...(frame.agentPreset !== undefined ? { agentPreset: frame.agentPreset } : {}),
                });
                this.sessions.get(frame.sessionId)?.handleBlank(frame.blank);
                const store = this.projectionStores.get(frame.sessionId);
                if (store !== undefined)
                    this.reconcileBlank(frame.sessionId, store);
                if (frame.origin === 'subagent' && frame.parentSessionId !== undefined) {
                    this.markCatalogParentExpandable(frame.parentSessionId);
                }
                if (frame.parentSessionId !== undefined
                    && (this.selected === frame.parentSessionId || this.openCatalogs.has(frame.parentSessionId))) {
                    this.scheduleCatalogRefresh(frame.parentSessionId);
                }
                return;
            }
            case 'host/session-removed': {
                this.removeSession(frame.sessionId, frame.permanent === true);
                return;
            }
            case 'host/session-status': {
                this.recordMutation({ kind: 'status', sessionId: frame.sessionId, running: frame.running });
                this.sessions.get(frame.sessionId)?.handleRunning(frame.running);
                this.updateCatalogActivity(frame.sessionId, frame.running);
                return;
            }
            case 'host/agent-error': {
                this.sessions.get(frame.sessionId)?.handleAgentError(frame.message);
                return; // not reflected in the list
            }
            default:
                return; // stream/error ignored; unknown frames ignored (documented default)
        }
    }
    /**
     * The moment a connection generation dies (before any next-generation frame
     * can arrive — onConnected waits for the readiness handshake while replayed
     * frames flow from stream open, so clearing there would race the replay):
     * drop generation-scoped live state. Interactions resolved while disconnected
     * send no frame, so stale statuses and buffered answerable frames must not
     * survive into the next generation — mux-open replay re-adds every still-pending
     * request with its live rpcId.
    */
    handleDisconnected() {
        if (this.pendingInteractions.size > 0) {
            this.pendingInteractions.clear();
            this.notifier.markDirty();
        }
        for (const [sessionId, buffer] of [...this.pendingBuffers]) {
            const kept = buffer.filter(item => item.payload.type !== 'approval/requested' && item.payload.type !== 'question/requested');
            if (kept.length === buffer.length)
                continue;
            if (kept.length === 0)
                this.pendingBuffers.delete(sessionId);
            else
                this.pendingBuffers.set(sessionId, kept);
        }
        for (const session of this.sessions.values())
            session.invalidateConnectionGeneration();
    }
    /** After each connection generation: refresh the session baseline and rebuild opened windows. */
    handleConnected() {
        void this.refreshList();
        const selectedAddress = this.selected === undefined ? undefined : this.addresses.get(this.selected);
        if (selectedAddress !== undefined)
            void this.refreshSubagents(selectedAddress.parentSessionId);
        if (this.selected !== undefined)
            void this.refreshSubagents(this.selected);
        for (const parentSessionId of this.openCatalogs)
            void this.refreshSubagents(parentSessionId);
        for (const session of this.sessions.values())
            void session.resync();
    }
    /** Debounce membership refetches while one parent catalog is selected or open. */
    scheduleCatalogRefresh(parentSessionId) {
        if (this.catalogDebounce.has(parentSessionId))
            return;
        const timer = setTimeout(() => {
            this.catalogDebounce.delete(parentSessionId);
            // The in-flight response predates the membership frame that scheduled
            // this callback. Queue one post-settlement pull instead of treating an
            // ordinary overlapping read as evidence that catalog membership changed.
            if (this.catalogInflight.has(parentSessionId)) {
                this.catalogStale.add(parentSessionId);
                return;
            }
            void this.refreshSubagents(parentSessionId);
        }, 50);
        this.catalogDebounce.set(parentSessionId, timer);
    }
    /** Apply one Agent-driver transition to loaded and in-flight catalogs. */
    updateCatalogActivity(childSessionId, running) {
        const activity = running ? 'running' : 'inactive';
        for (const inflight of this.catalogInflight.values()) {
            inflight.activityRows.set(childSessionId, activity);
        }
        let changed = false;
        for (const [parentSessionId, catalog] of this.catalogs) {
            if (!catalog.entries.some(entry => entry.kind === 'child' && entry.id === childSessionId && entry.activity !== activity))
                continue;
            const entries = catalog.entries.map((entry) => {
                if (entry.kind !== 'child' || entry.id !== childSessionId)
                    return entry;
                return { ...entry, activity };
            });
            changed = true;
            this.catalogs.set(parentSessionId, { ...catalog, entries });
        }
        if (changed)
            this.notifier.markDirty();
    }
    /** Preserve and project a positive expandability hint after one direct subagent publishes. */
    markCatalogParentExpandable(parentSessionId) {
        this.applyCatalogParentExpandable(parentSessionId);
        for (const inflight of this.catalogInflight.values())
            inflight.expandableRows.add(parentSessionId);
    }
    /** Apply one positive expandability hint to every loaded catalog containing that unique row id. */
    applyCatalogParentExpandable(parentSessionId) {
        let changed = false;
        for (const [catalogParentId, catalog] of this.catalogs) {
            if (!catalog.entries.some(entry => entry.kind === 'child' && entry.id === parentSessionId && !entry.hasChildren))
                continue;
            const entries = catalog.entries.map((entry) => {
                if (entry.kind !== 'child' || entry.id !== parentSessionId || entry.hasChildren)
                    return entry;
                return { ...entry, hasChildren: true };
            });
            changed = true;
            this.catalogs.set(catalogParentId, { ...catalog, entries });
        }
        if (changed)
            this.notifier.markDirty();
    }
    /** Fold request-local row mutations into one catalog result before publication. */
    withCatalogMutations(entries, expandableRows, activityRows) {
        return entries.filter(entry => !this.deletedSessionIds.has(entry.id)).map((entry) => {
            if (entry.kind !== 'child')
                return entry;
            const activity = activityRows.get(entry.id);
            if (!expandableRows.has(entry.id) && activity === undefined)
                return entry;
            return {
                ...entry,
                ...expandableRows.has(entry.id) ? { hasChildren: true } : {},
                ...activity === undefined ? {} : { activity },
            };
        });
    }
    /**
     * Reconcile completion reminders against the latest summaries, eagerly after
     * every mutation and pull (a snapshot-build-time pass would collapse
     * consecutive status frames into one observation). A running→idle edge of a
     * non-selected session arms its reminder; running disarms it; removal drops
     * it. First observation only records the running bit — sessions already
     * idle at load get no reminder.
     */
    syncCompletedNotifications() {
        const seen = new Set();
        for (const s of this.summaries) {
            seen.add(s.sessionId);
            const prev = this.prevRunning.get(s.sessionId);
            if (prev === undefined) {
                this.prevRunning.set(s.sessionId, s.running);
                continue;
            }
            if (prev && !s.running) {
                if (s.sessionId !== this.selected)
                    this.completedNotifications.add(s.sessionId);
            }
            else if (s.running) {
                this.completedNotifications.delete(s.sessionId);
            }
            this.prevRunning.set(s.sessionId, s.running);
        }
        for (const id of this.prevRunning.keys()) {
            if (!seen.has(id))
                this.prevRunning.delete(id);
        }
        for (const id of this.completedNotifications) {
            if (!seen.has(id))
                this.completedNotifications.delete(id);
        }
    }
    buildListSnapshot() {
        const merged = this.summaries.map((summary) => {
            // List rows read the generic 'title' projection key (host-computed unit
            // value; there is no dedicated title frame).
            const projectionStore = this.projectionStores.get(summary.sessionId);
            const title = projectionStore?.get('title');
            const projectionValues = projectionStore?.values();
            return {
                ...summary,
                ...(typeof title === 'string' && title !== '' ? { title } : {}),
                ...(projectionValues === undefined ? {} : { projectionValues }),
            };
        });
        const pendingInteractions = new Map();
        for (const [sessionId, interactions] of this.pendingInteractions) {
            const statuses = [...interactions.values()];
            // The composer selects the first question ahead of approval. Mirror that
            // answer order so the sidebar names the interaction the user can act on.
            const status = statuses.find(candidate => candidate !== 'approval') ?? statuses[0];
            if (status !== undefined)
                pendingInteractions.set(sessionId, status);
        }
        const fresh = (0, lineage_1.flattenLineage)(merged, pendingInteractions, this.completedNotifications);
        const items = fresh.map((entry) => {
            const prev = this.entryCache.get(entry.sessionId);
            if (prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
                && prev.blank === entry.blank && prev.agentPreset === entry.agentPreset
                && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
                && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
                && prev.pendingInteraction === entry.pendingInteraction
                && prev.projectionValues === entry.projectionValues
                && prev.completed === entry.completed)
                return prev;
            this.entryCache.set(entry.sessionId, entry);
            return entry;
        });
        for (const id of this.entryCache.keys()) {
            if (!items.some(e => e.sessionId === id))
                this.entryCache.delete(id);
        }
        const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i]);
        if (!sameOrder)
            this.itemsCache = items;
        const selected = this.selected;
        const current = selected !== undefined
            && (items.some(item => item.sessionId === selected) || this.addresses.has(selected))
            ? selected
            : undefined;
        return {
            items: this.itemsCache,
            current,
            state: this.listState,
            phase: this.listPhase,
            error: this.listError,
            subagentsByParent: Object.fromEntries(this.catalogs),
            jobsBySession: Object.fromEntries(this.jobsBySession),
            currentAddress: current === undefined ? undefined : this.addresses.get(current),
        };
    }
}
exports.SessionManager = SessionManager;
/** Apply one list mutation without deriving display order. */
function applyMutation(summaries, mutation) {
    switch (mutation.kind) {
        case 'upsert': {
            const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId);
            if (existing === undefined)
                return [mutation.summary, ...summaries];
            const filled = {
                ...existing,
                // Blank only lowers: a stale true (session-added racing the local
                // first send) never re-hides an already-surfaced session.
                blank: existing.blank && mutation.summary.blank,
                ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
                ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
                    ? { parentSessionId: mutation.summary.parentSessionId } : {}),
                ...(existing.origin === undefined && mutation.summary.origin !== undefined
                    ? { origin: mutation.summary.origin } : {}),
                // Newest wins, not fill-only: a blank-session preset switch replaces
                // the creation-time value, and every producer of this field (the
                // create echo, the select echo, a list row) reports the CURRENT one.
                ...(mutation.summary.agentPreset !== undefined
                    ? { agentPreset: mutation.summary.agentPreset } : {}),
            };
            if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
                && filled.origin === existing.origin && filled.blank === existing.blank
                && filled.agentPreset === existing.agentPreset)
                return [...summaries];
            return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary);
        }
        case 'remove':
            return summaries.filter(summary => summary.sessionId !== mutation.sessionId);
        case 'status':
            // running:true doubles as the cross-client blank flip (a blank session
            // never runs, so the first running frame proves a message landed).
            return summaries.map(summary => summary.sessionId === mutation.sessionId
                && (summary.running !== mutation.running || (mutation.running && summary.blank))
                ? { ...summary, running: mutation.running, blank: summary.blank && !mutation.running }
                : summary);
        case 'activity':
            return summaries.map(summary => summary.sessionId === mutation.sessionId
                && mutation.updatedAt > summary.updatedAt
                ? { ...summary, updatedAt: mutation.updatedAt }
                : summary);
        case 'engaged':
            return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.blank
                ? { ...summary, blank: false }
                : summary);
    }
}
/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error) {
    if (error.code !== 'workspace-attach-failed' || !(0, value_guards_1.isRecord)(error.details))
        return undefined;
    const value = error.details.sessionId;
    return typeof value === 'string' ? (0, types_1.SessionId)(value) : undefined;
}

},
"src/modules/client-runtime/ordered-baseline.js": function(module, exports, require) {
// source: src/modules/client-runtime/ordered-baseline.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeOrderedBaseline = mergeOrderedBaseline;
/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
function mergeOrderedBaseline(current, baseline, keyOf) {
    const baselineByKey = new Map();
    for (const value of baseline)
        baselineByKey.set(keyOf(value), value);
    const merged = current
        .map(value => baselineByKey.get(keyOf(value)))
        .filter((value) => value !== undefined);
    const mergedKeys = new Set(merged.map(keyOf));
    for (let index = 0; index < baseline.length; index++) {
        const value = baseline[index];
        /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
        if (value === undefined || mergedKeys.has(keyOf(value)))
            continue;
        let insertion = merged.length;
        for (let following = index + 1; following < baseline.length; following++) {
            const candidate = baseline[following];
            /* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
            if (candidate === undefined)
                continue;
            const known = merged.findIndex(item => keyOf(item) === keyOf(candidate));
            if (known !== -1) {
                insertion = known;
                break;
            }
        }
        merged.splice(insertion, 0, value);
        mergedKeys.add(keyOf(value));
    }
    return merged;
}

},
"src/modules/client-runtime/sessions/lineage.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/lineage.ts

"use strict";
// flattenLineage: summaries -> flat list with lineage indentation (pure function).
// The input order is authoritative; lineage only makes each child adjacent to its parent.
// Orphaned lineage degrades to root level; cycles fail soft and emit as roots.
Object.defineProperty(exports, "__esModule", { value: true });
exports.flattenLineage = flattenLineage;
/**
 * Summaries -> flat list with lineage indentation. Root and sibling order
 * follows the established input order; this projection never re-sorts a
 * hydrated list from mutable timestamps.
 * @param summaries - the host's session.list items.
 * @param pendingInteractions - current manager-owned interaction status by session.
 * @param completed - sessions with a pending completion reminder (manager-owned live fact; absent = false).
 * @returns display rows in render order.
 */
function flattenLineage(summaries, pendingInteractions, completed) {
    const byId = new Map();
    for (const s of summaries)
        byId.set(s.sessionId, s);
    const children = new Map();
    const roots = [];
    for (const s of summaries) {
        if (s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
            const list = children.get(s.parentSessionId) ?? [];
            list.push(s);
            children.set(s.parentSessionId, list);
        }
        else {
            roots.push(s); // root, or an orphan whose parent is absent from summaries (degrade to root, never drop)
        }
    }
    const out = [];
    const visited = new Set();
    const walk = (s, depth) => {
        if (visited.has(s.sessionId)) {
            console.warn(`[web-runtime] lineage cycle at ${s.sessionId}; emitting as root`);
            return;
        }
        visited.add(s.sessionId);
        const pendingInteraction = pendingInteractions?.get(s.sessionId);
        out.push({
            ...s,
            ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
            completed: completed?.has(s.sessionId) ?? false,
            depth,
        });
        const kids = children.get(s.sessionId);
        if (kids === undefined)
            return;
        for (const kid of kids)
            walk(kid, depth + 1);
    };
    for (const root of roots)
        walk(root, 0);
    // Cycle members (unreachable from any root): emit as roots so no entry is lost.
    for (const s of summaries) {
        if (!visited.has(s.sessionId))
            walk(s, 0);
    }
    return out;
}

},
"src/modules/client-runtime/sessions/notifier.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/notifier.ts

"use strict";
// Notifier: subscription + batched notification primitive shared by Session and
// SessionManager. Semantics: N markDirty calls collapse into one microtask flush, while
// N markFrameDirty calls collapse into one animation-frame flush;
// the flush rebuilds the snapshot cache BEFORE notifying (useSyncExternalStore requires a stable
// getSnapshot reference). With no listeners the rebuild is skipped and only the dirty bit is set
// (keeps frame storms cheap); the next getSnapshot rebuilds lazily.
//
// Freshness and notification are SEPARATE bits: a pull (ensureFresh) between
// markDirty and the scheduled flush rebuilds the snapshot but must not
// swallow the notification — push subscribers (object-layer watchers) would
// otherwise starve whenever any reader pulls first.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Notifier = void 0;
/** Subscription + batched notification primitive (shared by Session and SessionManager). */
class Notifier {
    /** @param rebuild - snapshot rebuild function injected by the owner (writes the owner's snapshotCache). */
    constructor(rebuild) {
        this.rebuild = rebuild;
        this.listeners = new Set();
        this.dirty = false;
        this.notifyPending = false;
        this.scheduled = 'none';
        this.scheduleGeneration = 0;
    }
    /**
     * uSES subscription entry.
     * @param listener - change callback.
     * @returns the unsubscribe function.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** State-change entry: mark dirty and schedule the batched flush. */
    markDirty() {
        this.dirty = true;
        this.notifyPending = true;
        if (this.scheduled === 'microtask')
            return;
        this.schedule('microtask');
    }
    /** Stream-change entry: mark dirty and publish the cumulative state at most once per frame. */
    markFrameDirty() {
        this.dirty = true;
        this.notifyPending = true;
        if (this.scheduled !== 'none')
            return;
        this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask');
    }
    /**
     * Synchronous flush: controlled-input writes must notify in the same tick as
     * onChange, or React rolls the DOM back to the stale value and the caret jumps to the end.
     */
    notifyNow() {
        this.dirty = true;
        this.notifyPending = true;
        this.invalidateSchedule();
        this.flush();
    }
    /**
     * Pre-getSnapshot check: rebuild synchronously when dirty (read path
     * before first subscribe / while unobserved). Notification stays pending.
     */
    ensureFresh() {
        if (!this.dirty)
            return;
        this.dirty = false;
        this.rebuild();
    }
    schedule(kind) {
        const generation = ++this.scheduleGeneration;
        this.scheduled = kind;
        const publish = () => {
            if (generation !== this.scheduleGeneration)
                return;
            this.scheduled = 'none';
            this.flush();
        };
        if (kind === 'frame') {
            globalThis.requestAnimationFrame(publish);
        }
        else {
            queueMicrotask(publish);
        }
    }
    invalidateSchedule() {
        this.scheduleGeneration++;
        this.scheduled = 'none';
    }
    flush() {
        if (!this.notifyPending)
            return;
        if (this.listeners.size === 0)
            return; // lazy: dirty (if still set) rebuilds on next getSnapshot
        this.notifyPending = false;
        if (this.dirty) {
            this.dirty = false;
            this.rebuild();
        }
        for (const listener of this.listeners)
            listener();
    }
}
exports.Notifier = Notifier;

},
"src/modules/client-runtime/sessions/projection-store.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/projection-store.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectionValueStore = void 0;
const value_guards_1 = require("../value-guards");
const notifier_1 = require("./notifier");
/**
 * One session's projection values. Framework semantics, uniform across every
 * key: a baseline seeds rows at its cut, a push frame updates one row, and in
 * both paths a lower-or-equal seq loses — a replayed frame cannot regress a
 * value, a stale baseline cannot overwrite a newer frame. A key the store has
 * never seen reads `undefined` (capability absent). Faces are identity-stable
 * per key (create-on-demand, cached) so the React side binds each exactly
 * once; the store-level channel (`subscribeAny`) serves coarse consumers (the
 * manager's list projection reads the `title` key).
 */
class ProjectionValueStore {
    constructor() {
        this.rows = new Map();
        this.channels = new Map();
        /** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
        this.anyNotifier = new notifier_1.Notifier(() => { });
    }
    /**
     * Key-addressed bare observable face (the useProjection resolution path).
     * Always defined — absence is an `undefined` snapshot, never a missing
     * face, so a component may subscribe before the key ever carries a value.
     * @param key - projection key.
     * @returns the identity-stable face for this key.
     */
    faceOf(key) {
        return this.channel(key).face;
    }
    /**
     * Current whole value for a key (erased framework read; typed reads go
     * through `useProjection`'s map lookup).
     * @param key - projection key.
     * @returns the value, or undefined while the key is absent.
     */
    get(key) {
        return this.rows.get(key)?.value;
    }
    /**
     * Read every current projection value as one reference-stable snapshot.
     * @returns The same frozen value map until a row changes.
     */
    values() {
        if (this.valuesCache === undefined) {
            this.valuesCache = Object.freeze(Object.fromEntries([...this.rows].map(([key, row]) => [key, row.value])));
        }
        return this.valuesCache;
    }
    /**
     * Subscribe to any-key changes (microtask-batched) — the manager's list
     * rebuild channel.
     * @param listener - change callback.
     * @returns the unsubscribe function.
     */
    subscribeAny(listener) {
        return this.anyNotifier.subscribe(listener);
    }
    /**
     * Apply one finished value (the `session/projection` push-frame path).
     * @param key - projection key.
     * @param value - whole value computed by the host unit.
     * @param seq - the unit's watermark at emission.
     */
    apply(key, value, seq) {
        const row = this.rows.get(key);
        if (row !== undefined && seq <= row.seq)
            return; // higher seq wins; replays and stale frames drop
        this.rows.set(key, { value, seq });
        this.changed(key);
    }
    /**
     * Seed from a history tail page's projections block: every carried key
     * lands under the same seq rule as frames; a key the block omits is
     * capability-absent as of the cut — its row clears unless a newer frame
     * already superseded the cut (a stale baseline can neither overwrite nor
     * clear newer values).
     * @param baseline - the response's projections block.
     */
    seed(baseline) {
        // Erased walk: the framework crosses the open key space; per-key typing
        // is re-established at the consumer (useProjection's map lookup).
        const values = baseline.values;
        if (!(0, value_guards_1.isRecord)(values))
            throw new Error('invalid projection baseline values');
        for (const key of Object.keys(values))
            this.apply(key, values[key], baseline.asOfSeq);
        for (const [key, row] of this.rows) {
            if (Object.hasOwn(values, key))
                continue;
            if (row.seq > baseline.asOfSeq)
                continue;
            this.rows.delete(key);
            this.changed(key);
        }
    }
    /**
     * Drop rows past a mux-generation baseline (`session/subscribed.lastSeq`):
     * a row claiming knowledge beyond the host's own durable baseline rode
     * state a restart lost — under last-wins it would wrongly outrank the
     * host's recomputed (lower-seq) values forever. Durable replay and the next
     * baseline re-seed whatever truly survived (the title-snapshot precedent,
     * generalized).
     * @param lastSeq - the subscribed frame's durable baseline seq.
     */
    truncate(lastSeq) {
        for (const [key, row] of this.rows) {
            if (row.seq <= lastSeq)
                continue;
            this.rows.delete(key);
            this.changed(key);
        }
    }
    changed(key) {
        this.valuesCache = undefined;
        this.channels.get(key)?.notifier.markDirty();
        this.anyNotifier.markDirty();
    }
    channel(key) {
        let channel = this.channels.get(key);
        if (channel === undefined) {
            // The notifier only batches (no snapshot cache to rebuild: faces read rows directly).
            const notifier = new notifier_1.Notifier(() => { });
            channel = {
                notifier,
                face: {
                    getSnapshot: () => this.rows.get(key)?.value,
                    subscribe: listener => notifier.subscribe(listener),
                },
            };
            this.channels.set(key, channel);
        }
        return channel;
    }
}
exports.ProjectionValueStore = ProjectionValueStore;

},
"src/modules/client-runtime/sessions/session.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/session.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Session = exports.PAGE_MESSAGES = void 0;
const chat_snapshot_codec_1 = require("./chat-snapshot-codec");
const session_terminal_1 = require("../../shared/session-terminal");
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
const index_1 = require("../../client-connection/contracts/host/apiproxy/api/index");
const conversation_assembler_1 = require("./conversation-assembler");
const pending_1 = require("./pending");
const notifier_1 = require("./notifier");
const projection_store_1 = require("./projection-store");
const time_zone_1 = require("../time-zone");
const queue_mirror_1 = require("./queue-mirror");
const active_working_set_1 = require("./active-working-set");
const cooperative_delivery_1 = require("./cooperative-delivery");
/** Messages requested per history page. */
exports.PAGE_MESSAGES = 50;
/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are manager/runtime entry points.
 */
class Session {
    /**
     * @param sessionId - Host session identity (client sessions are always Host-born).
     * @param api - shared wire client.
     * @param remote - generated Remote namespaces this session calls.
     * @param options - optional manager-owned state observers.
     */
    constructor(sessionId, api, remote, options = {}) {
        this.sessionId = sessionId;
        this.api = api;
        this.remote = remote;
        this.options = options;
        this.historyGeneration = new AbortController();
        this.xhPendingOperations = 0;
        this.events = [];
        /** Wire views aligned with `events` by index (envelope-level annotations; undefined = no view).
         *  Kept parallel rather than merged so `events` stays the raw log slice (model-visible ⟺ logged). */
        this.views = [];
        this.eventWeights = [];
        this.eventBytes = 0;
        this.trimAfterEvents = active_working_set_1.ACTIVE_WINDOW.highEvents;
        this.trimAfterBytes = active_working_set_1.ACTIVE_WINDOW.highBytes;
        this.olderPagePinned = false;
        this.stopRequested = false;
        this.cancelEpoch = 0;
        this.liveBufferBytes = 0;
        this.baseSeq = 0;
        this.hasMore = false;
        this.openState = 'cold';
        this.openError = null;
        this.openPromise = null;
        /** Bumped by resync to invalidate an in-flight doOpen: a reconnect must rebuild, never adopt
         *  a pre-disconnect open whose history request is already doomed. Stale doOpen
         *  passes drop all writes once the generation moves on. */
        this.openGeneration = 0;
        this.loadingOlder = false;
        this.pending = new Map();
        this.pendingRev = 0;
        this.pendingCache = null;
        /** Authoritative stream-only inbox snapshot; pending work never hits history. */
        this.queueMirror = new queue_mirror_1.SessionQueueMirror();
        this.running = false;
        this.parentAvailable = false;
        /**
         * Sticky send marker, private input of the composerPhase derivation: set
         * synchronously before prompt()'s first await, never reset — the blank →
         * engaging edge of the phase machine (see ComposerPhase).
         */
        this.promptAttempted = false;
        /** A first accepted prompt stays in the engaging phase until its turn is observable. */
        this.firstPromptPendingTurn = false;
        /** Empty-log mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
        this.blankBit = true;
        this.removed = false;
        this.promptError = null;
        this.lastAgentError = null;
        this.agentErrorGeneration = 0;
        /** Live events buffered during open/resync and stitched by sequence once history lands. */
        this.liveBuffer = [];
        /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
        this.stitching = false;
        /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
        this.subscribedLastSeq = null;
        this.projections = options.projections ?? new projection_store_1.ProjectionValueStore();
        this.address = options.address;
        this.parentAvailable = options.parentAvailable ?? false;
        this.conversation = options.conversation === undefined
            ? new conversation_assembler_1.ConversationNodeAssembler({ entries: () => [], fallbackEntry: () => undefined }, { entries: () => [] })
            : new conversation_assembler_1.ConversationNodeAssembler(options.conversation.events, options.conversation.views);
        this.delivery = options.cooperativeEvents ? new cooperative_delivery_1.CooperativeDelivery(({ event, view }) => this.acceptLiveEvent(event, view), error => this.failLiveBacklog(error)) : undefined;
        this.notifier = new notifier_1.Notifier(() => {
            this.trimActiveWindow();
            this.conversation.flush();
            this.snapshotCache = this.buildSnapshot();
        });
        this.snapshotCache = this.buildSnapshot();
    }
    /**
     * Bind the Agent-scoped context minted by SessionRuntime (single write;
     * a second bind is a wiring error and throws). Direction stays one-way at
     * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
     * while the Session holds its own dispatch point (host Agent.loopCtx
     * mirror).
     * @param actx - the agent's scoped context.
     */
    bindScope(actx) {
        if (this.actx !== undefined)
            throw new Error(`session ${this.sessionId} already has a bound scope`);
        this.actx = actx;
    }
    /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
    unbindScope() {
        this.actx = undefined;
    }
    // ---- Operations ----
    /**
     * Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
     * @param content - text, browser uploads or durable attachment references.
     * @param mode - queue appends after the current turn; steer interrupts it.
     * @returns the prompt result (also mirrored into promptError on failure).
     */
    async doPrompt(content, mode, signal, options = {}) {
        this.promptError = null;
        this.lastAgentError = null;
        // Synchronous, before the first await: the blank → engaging edge must be
        // visible on the session area's very first frame when a caller sends
        // ahead of navigation (first-send flow).
        this.promptAttempted = true;
        if (this.blankBit)
            this.firstPromptPendingTurn = true;
        this.notifier.markDirty();
        let result;
        try {
            if (this.address === undefined) {
                result = (await this.api.sessions.prompt({
                    sessionId: this.sessionId,
                    mode,
                    content,
                    ...(options.requireIdle === true ? { requireIdle: true } : {}),
                    clientTimeZone: (0, time_zone_1.resolvedClientTimeZone)(),
                }, signal)).result;
            }
            else if (this.address.mode === 'one-shot') {
                result = {
                    ok: false,
                    error: {
                        code: 'subagent-not-resumable',
                        message: 'one-shot subagent conversations are read-only',
                        details: { childSessionId: this.address.childSessionId },
                    },
                };
            }
            else {
                if (content.some(part => part.type === 'image' || part.type === 'image_ref'
                    || part.type === 'file' || part.type === 'file_ref')) {
                    result = {
                        ok: false,
                        error: {
                            code: 'attachment-error',
                            message: 'Image input is unavailable for subagent continuations.',
                            details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' },
                        },
                    };
                }
                else {
                    const routed = (await this.api.subagents.prompt({
                        ...this.address,
                        content: content.flatMap(part => part.type === 'text'
                            ? [{ type: 'text', text: part.text }]
                            : []),
                        clientTimeZone: (0, time_zone_1.resolvedClientTimeZone)(),
                    }, signal)).result;
                    result = routed.ok ? { ok: true, value: { accepted: true } } : routed;
                }
            }
        }
        catch (error) {
            result = (0, index_1.transportError)(error);
        }
        if (!result.ok) {
            this.promptError = { op: 'send', error: result.error };
            this.notifier.markDirty();
            return result;
        }
        // Blank flips on ACCEPTANCE, not attempt: an accepted prompt starts the
        // conversation's first turn on the host (the host criterion — a logged
        // turn/start — is fact, not optimism; standalone command and projection
        // events never flip it), while a rejected first prompt must keep the
        // session blank — the client-side blank mirror only ever lowers, so
        // flipping early on a failure would surface the session forever and
        // strip its connectWorkspace reuse eligibility against the host's
        // authority.
        if (this.blankBit) {
            this.blankBit = false;
            this.options.onEngaged?.(this);
            this.notifier.markDirty();
        }
        return result;
    }
    /**
     * Resolve one image referenced by this session into browser-consumable bytes.
     * @param attachmentId - opaque id found in the folded session log.
     * @returns the authenticated reference and decoded bytes.
     */
    async readAttachment(attachmentId) {
        try {
            const result = (await this.api.sessions.attachment({
                sessionId: this.sessionId,
                attachmentId,
            })).result;
            if (!result.ok)
                return result;
            const binary = atob(result.value.data);
            const data = Uint8Array.from(binary, char => char.charCodeAt(0));
            return { ok: true, value: { attachment: result.value.attachment, data } };
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /** Apply one operation to a still-pending queue occurrence. */
    async updateQueue(itemId, action) {
        try {
            return (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId, action })).result;
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /**
     * Stop the active turn while the Host preserves pending inbox work; failures
     * land in promptError (same error-strip display slot). A continuable
     * subagent address routes through `subagent.interrupt`, whose durable
     * parent-address authority works without a live parent Agent; a one-shot
     * address stays uncancellable (the UI offers no stop action, so this arm is
     * defensive).
     * @returns the cancel result.
     */
    cancel() {
        if (this.cancelPromise !== undefined)
            return this.cancelPromise;
        if (this.stopRequested)
            return Promise.resolve({ ok: true, value: { accepted: true } });
        this.stopRequested = this.running;
        const epoch = this.cancelEpoch;
        this.notifier.markDirty();
        const pending = this.doCancel(epoch).finally(() => {
            if (this.cancelPromise === pending)
                this.cancelPromise = undefined;
        });
        this.cancelPromise = pending;
        return pending;
    }
    async doCancel(epoch) {
        const address = this.address;
        if (address !== undefined && address.mode === 'one-shot') {
            const result = {
                ok: false,
                error: {
                    code: 'subagent-delivery-unavailable',
                    message: 'subagent activation cancellation is unavailable',
                    details: { childSessionId: address.childSessionId },
                },
            };
            this.stopRequested = false;
            this.promptError = { op: 'stop', error: result.error };
            this.notifier.markDirty();
            return result;
        }
        let result;
        try {
            result = address !== undefined
                ? (await this.api.subagents.interrupt(address)).result
                : (await this.api.sessions.cancel({ sessionId: this.sessionId })).result;
        }
        catch (error) {
            result = (0, index_1.transportError)(error);
        }
        if (!result.ok && epoch === this.cancelEpoch) {
            this.stopRequested = false;
            this.promptError = { op: 'stop', error: result.error };
            this.notifier.markDirty();
        }
        return result;
    }
    /**
     * Rename: contract session.rename 1:1. On success settle the 'title'
     * projection cell from the response's `{title, seq}` under the store's
     * higher-seq-wins rule (the push frame arriving later is a no-op replay),
     * so the list row and any useProjection('title') reader update without
     * waiting for the mux frame.
     * @param title - raw title text (the host normalizes acceptance).
     * @returns the rename result (normalized accepted title + title event seq).
     */
    async rename(title) {
        try {
            const { result } = await this.api.sessions.rename({ sessionId: this.sessionId, title });
            if (result.ok)
                this.projections.apply('title', result.value.title, result.value.seq);
            return result;
        }
        catch (error) {
            return (0, index_1.transportError)(error);
        }
    }
    /**
     * Execute one slash-command line against this session's agent — pure
     * admission semantics (the host executor durably logs the lifecycle;
     * outcomes render as flow nodes, never as a response echo).
     * @param line - the full command line, leading slash included.
     * @returns the admission result, or the error branch on transport failure.
     */
    async doCommand(line) {
        const result = await this.remote.commands.execute(this.sessionId, line, []);
        if (!result.ok)
            return result;
        if (line.trim() === '/reload' && result.value !== undefined) {
            if (result.value.result.kind !== 'success')
                return (0, index_1.transportError)(new Error(result.value.result.text ?? 'Session restart was not successful'));
            try {
                await this.recoverHistory();
            }
            catch (error) {
                return (0, index_1.transportError)(error);
            }
        }
        return { ok: true, value: { matched: result.value !== undefined } };
    }
    /** Called only after an explicit successful worker-recovery receipt. */
    async recoverHistory() {
        const errorGeneration = this.agentErrorGeneration;
        await this.resync();
        if (this.openState !== 'open')
            throw new Error(this.openError?.message ?? 'Session restarted but history could not be restored');
        // A new turn/error may arrive while history is in flight. Recovery owns
        // only the prior error, even when the newer message has identical text.
        if (this.agentErrorGeneration === errorGeneration)
            this.lastAgentError = null;
        this.notifier.markDirty();
    }
    /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
    openEntry() {
        if (this.openState === 'open')
            return Promise.resolve();
        if (this.openPromise !== null)
            return this.openPromise;
        const promise = this.doOpen(this.openGeneration).finally(() => {
            // Identity-guarded: a superseded open must not null out the promise resync just started.
            if (this.openPromise === promise)
                this.openPromise = null;
        });
        this.openPromise = promise;
        return promise;
    }
    /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
    loadOlder() { return this.historyOperation(() => this.doLoadOlder(), true); }
    async doLoadOlder() {
        if (this.openState === 'error')
            return this.retryHistory();
        if (this.openState !== 'open' || !this.hasMore || this.loadingOlder || this.stitching)
            return;
        this.olderPagePinned = true;
        this.loadingOlder = true;
        const generation = this.openGeneration, beforeSeq = this.baseSeq;
        this.notifier.markDirty();
        try {
            const { result } = await this.history({ beforeSeq, maxMessages: exports.PAGE_MESSAGES });
            if (generation !== this.openGeneration || this.openState !== 'open' || this.stitching)
                return;
            const value = this.responseValue(result), older = value.events;
            if (this.baseSeq !== beforeSeq)
                throw new Error('History window changed during pagination; retry history loading');
            if (older.length && !this.xhValidHistoryPage(older, beforeSeq))
                throw new Error('History projected page is invalid; retry history loading');
            if (!older.length && value.hasMore)
                throw new Error('History page made no progress; retry history loading');
            const entries = [...older, ...this.events.map((event, index) => ({ event, view: this.views[index] }))];
            this.installWindow(entries, value.hasMore);
        }
        catch (error) {
            if (generation === this.openGeneration)
                this.failHistory(error);
        }
        finally {
            if (generation === this.openGeneration) {
                this.loadingOlder = false;
                this.notifier.markDirty();
            }
        }
    }
    /** Invalidate only history reads; model, tool, and mutation requests have separate owners. */
    advanceHistoryGeneration() {
        this.openGeneration++;
        this.historyGeneration.abort();
        this.historyGeneration = new AbortController();
    }
    /** Invalidate dead-transport work before any new-generation frame arrives. */
    invalidateConnectionGeneration() {
        this.delivery?.clear();
        this.liveBuffer = [];
        this.liveBufferBytes = 0;
        this.stopRequested = false;
        this.cancelEpoch++;
        this.cancelPromise = undefined;
        this.advanceHistoryGeneration();
        this.openPromise = null;
        this.loadingOlder = false;
        this.stitching = false;
        for (const wait of this.pending.values())
            wait.markSettled?.();
        this.pending.clear();
        this.pendingRev++;
        this.subscribedLastSeq = null;
        this.notifier.markDirty();
    }
    /** Reconnect retains committed history until a complete replacement succeeds. */
    async resync() {
        if (this.openState === 'cold')
            return;
        if (this.events.length)
            this.xhRestoreBaseSeq = this.baseSeq;
        this.advanceHistoryGeneration();
        this.loadingOlder = false;
        this.stitching = false;
        this.openPromise = null;
        this.openState = 'cold';
        this.openError = null;
        // New-generation mux baseline may precede readiness. Cleanup belongs to
        // transport death, never this readiness-triggered history replacement.
        this.notifier.markDirty();
        await this.open();
    }
    // ---- Subscription API (useSyncExternalStore direct wiring) ----
    /**
     * uSES subscription entry.
     * @param listener - change callback.
     * @returns the unsubscribe function.
     */
    subscribe(listener) {
        return this.notifier.subscribe(listener);
    }
    /**
     * Cached conversation snapshot (rebuilt lazily when dirty with no listeners).
     * @returns the cached reference (stable until the next flush).
     */
    getSnapshot() {
        this.notifier.ensureFresh();
        return this.snapshotCache;
    }
    // ---- Manager-only entry points (@internal; never called by the UI) ----
    /**
     * Mux frame arrival (the dispatch switch).
     * @param rpcId - the frame envelope id (the respond backfill key for requested frames).
     * @param frame - the routed frame.
     */
    handleMuxEnvelope(rpcId, frame) {
        if (frame.type === 'session/event' && this.delivery !== undefined) {
            this.delivery.push({ event: frame.event, view: frame.view }, (0, active_working_set_1.payloadWeight)([frame.event, frame.view]));
        }
        else
            this.dispatchMuxEnvelope(rpcId, frame);
        if (frame.type === 'session/event')
            void this.xhRecoverLiveAnswer();
        this.xhHistoryOwner?.schedule();
    }
    dispatchMuxEnvelope(rpcId, frame) {
        switch (frame.type) {
            case 'session/event': {
                this.acceptLiveEvent(frame.event, frame.view);
                return;
            }
            case 'session/queue': {
                this.queueMirror.replace(frame.items, this.events);
                this.notifier.markDirty();
                return;
            }
            case 'session/subscribed': {
                this.subscribedLastSeq = frame.lastSeq;
                // New mux-generation baseline: the host pushes this session's queue
                // snapshot AFTER the subscribed frame on the same stream, so the
                // stale mirror clears here — race-free against onConnected/resync
                // timing (clearing there could wipe a baseline that already landed).
                if (this.queueMirror.reset())
                    this.notifier.markDirty();
                return;
            }
            case 'approval/requested': {
                const { type: _type, sessionId: _sid, ...payload } = frame;
                this.mint(new pending_1.PendingWait('approval', rpcId, this.sessionId, payload, m => this.api.respond(m)));
                this.notifier.markDirty();
                return;
            }
            case 'approval/resolved': {
                for (const item of this.pending.values()) {
                    if (item.kind === 'approval' && item.payload.approvalId === frame.approvalId)
                        this.settle(item);
                }
                this.notifier.markDirty();
                return;
            }
            case 'question/requested': {
                const { type: _type, sessionId: _sid, ...payload } = frame;
                this.mint(new pending_1.PendingWait('question', rpcId, this.sessionId, payload, m => this.api.respond(m)));
                this.notifier.markDirty();
                return;
            }
            case 'question/resolved': {
                const item = this.pending.get(`q:${frame.questionRpcId}`);
                if (item !== undefined)
                    this.settle(item);
                this.notifier.markDirty();
                return;
            }
            default:
                return; // stream/error never reaches Session (Controller converges it); unknown frames ignored (documented default)
        }
    }
    /**
     * Running-bit relay from the host stream (list entry and snapshot stay consistent).
     * @param running - the new running state.
     */
    handleRunning(running) {
        this.applyRunning(running);
        if (running)
            void this.xhRecoverLiveAnswer();
        this.xhHistoryOwner?.schedule();
    }
    applyRunning(running) {
        if (!running && (this.running || this.stopRequested)) {
            this.stopRequested = false;
            this.cancelEpoch++;
            this.cancelPromise = undefined;
            this.notifier.markDirty();
        }
        // Turn-start conversion: a blank session never runs, so the first
        // running:true proves another side's first message landed.
        if (running && this.blankBit) {
            this.blankBit = false;
            this.notifier.markDirty();
        }
        if (running)
            this.firstPromptPendingTurn = false;
        if (this.running === running)
            return;
        this.running = running;
        this.notifier.markDirty();
    }
    /**
     * Install or clear the catalog-discovered transport address. A changed
     * address rebuilds an already-open window through its new history route.
     * @param address - direct parent/child address, or undefined for ordinary transport.
     * @param parentAvailable - latest exact-parent availability hint.
     */
    configureSubagent(address, parentAvailable = false) {
        const same = this.address?.parentSessionId === address?.parentSessionId
            && this.address?.childSessionId === address?.childSessionId
            && this.address?.mode === address?.mode;
        this.address = address;
        this.parentAvailable = parentAvailable;
        if (!same && this.openState !== 'cold')
            void this.resync();
        else
            this.notifier.markDirty();
    }
    /**
     * Update only the parent availability hint from a catalog refresh.
     * @param available - whether the exact direct parent is live.
     */
    handleSubagentParentAvailable(available) {
        if (this.parentAvailable === available)
            return;
        this.parentAvailable = available;
        this.notifier.markDirty();
    }
    /**
     * Blank-bit relay from the authoritative summary source (list baseline and
     * the session-added frame). Monotone: once any signal (local first send,
     * running flip, an earlier summary) cleared it, a stale true never
     * re-blanks.
     * @param blank - the summary's derived empty-log bit.
     */
    handleBlank(blank) {
        if (blank === this.blankBit)
            return;
        if (blank && (this.promptAttempted || this.running))
            return;
        this.blankBit = blank;
        this.notifier.markDirty();
    }
    /** host/session-removed relay: flag the snapshot (instance survives — resident-instance rule). */
    handleRemoved() {
        this.delivery?.clear();
        this.liveBuffer = [];
        this.liveBufferBytes = 0;
        this.stopRequested = false;
        this.cancelEpoch++;
        this.cancelPromise = undefined;
        this.removed = true;
        this.notifier.markDirty();
    }
    /**
     * host/agent-error relay: the only outlet for live failures with no turn position.
     * @param message - the stringified error.
     */
    handleAgentError(message) {
        this.agentErrorGeneration++;
        this.lastAgentError = message;
        this.notifier.markDirty();
    }
    /** No-op because session instances remain resident. */
    dispose() { }
    /** Rebuild the current window after a low-frequency Definition or view registration change. */
    rebuildConversationRegistry() {
        this.scheduleConversation(this.conversation.rebuildRegistry());
    }
    // ---- Private ----
    /** Requested-frame arrival: the wait enters the pending map under its own key. */
    mint(wait) {
        this.pending.set(wait.key, wait);
        this.pendingRev++;
    }
    /** Authoritative resolved-frame settlement: mark, then drop from the pending map. */
    settle(wait) {
        wait.markSettled();
        this.pending.delete(wait.key);
        this.pendingRev++;
        this.xhHistoryOwner?.schedule();
    }
    /** @param generation - openGeneration at launch; every await re-checks it and a stale pass
     *  drops all writes (resync superseded this open — its outcome belongs to a dead connection). */
    async doOpen(generation) {
        this.openState = 'loading';
        this.openError = null;
        this.notifier.markDirty();
        try {
            let { result } = await this.history({ maxMessages: exports.PAGE_MESSAGES });
            if (generation !== this.openGeneration)
                return;
            if (!result.ok) {
                this.openState = 'error';
                this.openError = result.error;
                return;
            }
            result = { ...result, value: await this.restoreHistoryRange(result.value, generation) };
            if (generation !== this.openGeneration)
                return;
            this.installWindow(result.value.events, result.value.hasMore, result.value.projections);
            // Gap detection: baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
            const tailSeq = this.windowTailSeq();
            if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
                result = (await this.history({ maxMessages: exports.PAGE_MESSAGES })).result;
                if (generation !== this.openGeneration)
                    return;
                if (result.ok) {
                    result.value = await this.restoreHistoryRange(result.value, generation);
                    if (generation !== this.openGeneration)
                        return;
                    this.installWindow(result.value.events, result.value.hasMore, result.value.projections);
                }
            }
            this.openState = 'open';
            this.xhRestoreBaseSeq = undefined;
        }
        catch (error) {
            if (generation !== this.openGeneration)
                return;
            this.openState = 'error';
            const folded = (0, index_1.transportError)(error);
            /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
            this.openError = folded.ok ? null : folded.error;
        }
        finally {
            if (generation === this.openGeneration)
                this.notifier.markDirty();
        }
    }
    /** Install the history window + stitch the liveBuffer (seq is the sole dedup key).
     *  Stitching MUST NOT route through acceptLiveEvent: openState is still 'loading' here
     *  (doOpen flips it after install), so recursing would push every buffered event straight
     *  back into liveBuffer where nothing ever drains it — a silent drop loop.
     *  A carried projections block seeds the value store (higher seq wins, so a stale
     *  baseline cannot overwrite a newer push frame); the window events themselves are
     *  never folded — the host is the only computation site. */
    installWindow(entries, hasMore, projections) {
        const combined = [...entries];
        let tail = combined.at(-1)?.event.seq;
        const buffered = [...this.liveBuffer].sort((a, b) => a.event.seq - b.event.seq);
        const accepted = [];
        for (const item of buffered) {
            if (tail !== undefined && item.event.seq <= tail)
                continue;
            if (tail !== undefined && item.event.seq !== tail + 1)
                throw new Error('History live-buffer gap; retry history loading');
            combined.push(item);
            accepted.push(item);
            tail = item.event.seq;
        }
        const committedTail = this.events.at(-1)?.seq;
        if (committedTail !== undefined && (tail === undefined || tail < committedTail))
            throw new Error('History window moved backwards; retry history loading');
        const prependOnly = this.events.length > 0 && accepted.length === 0 && combined.length >= this.events.length
            && this.events.every((event, index) => {
                const candidate = combined[combined.length - this.events.length + index];
                return candidate !== undefined && candidate.event === event && candidate.view === this.views[index];
            });
        const staged = this.conversation.stageReplacement(combined.map(conversationInput), hasMore, prependOnly);
        const events = combined.map(entry => entry.event), views = combined.map(entry => entry.view);
        Object.assign(this.conversation, staged);
        this.events = events;
        this.views = views;
        this.eventWeights = events.map((event, index) => (0, active_working_set_1.payloadWeight)([event, views[index]]));
        this.eventBytes = this.eventWeights.reduce((sum, bytes) => sum + bytes, 0);
        this.trimAfterEvents = active_working_set_1.ACTIVE_WINDOW.highEvents;
        this.trimAfterBytes = active_working_set_1.ACTIVE_WINDOW.highBytes;
        this.baseSeq = events[0]?.seq ?? 0;
        this.hasMore = hasMore;
        if (events.some(event => event.type === 'turn/start'))
            this.firstPromptPendingTurn = false;
        if (projections !== undefined)
            this.projections.seed(projections);
        // A queue baseline may have landed before history on open/reconnect.
        // Reconcile the complete installed window, not only newly buffered events.
        for (const event of events)
            this.queueMirror.acceptDurable(event);
        this.liveBuffer = [];
        this.liveBufferBytes = 0;
        this.notifier.markDirty();
        this.xhHistoryOwner?.changed(this);
    }
    /** Seq-guarded append shared by stitching and the open-state live path. */
    appendLive(event, view) {
        const tailSeq = this.windowTailSeq();
        if (tailSeq !== null && event.seq <= tailSeq)
            return 'none'; // replay overlap, drop
        const input = conversationInput({ event, view });
        this.events.push(event);
        this.views.push(view);
        const bytes = (0, active_working_set_1.payloadWeight)([event, view]);
        this.eventWeights.push(bytes);
        this.eventBytes += bytes;
        if (event.type === 'turn/start')
            this.firstPromptPendingTurn = false;
        const queueChanged = this.queueMirror.acceptDurable(event);
        const publication = this.conversation.append(input);
        this.xhHistoryOwner?.changed(this);
        return queueChanged ? 'immediate' : publication;
    }
    /** Land a live session/event (open/repair in flight -> buffer; overlapping seq -> drop;
     *  a seq gap -> buffer + tail-page repull instead of appending a hole (a gap is an
     *  expected reconnect-window artifact, repaired by refetch). The window stays one contiguous
     *  raw range, which lets Conversation Definitions correlate every recorded event between its
     *  ends and lets a compaction checkpoint resolve its cited summary event. */
    acceptLiveEvent(event, view) {
        if (this.openState === 'error' || this.openState === 'loading' || this.stitching) {
            this.bufferLive(event, view);
            return;
        }
        if (this.openState !== 'open')
            return; // cold/error: no window upkeep (history fully backfills on open)
        const tailSeq = this.windowTailSeq();
        if (tailSeq !== null && event.seq <= tailSeq)
            return; // an already committed seq cannot mutate or poison the view
        if (tailSeq !== null && event.seq > tailSeq + 1) {
            this.bufferLive(event, view);
            void this.repairGap();
            return;
        }
        try {
            (0, session_terminal_1.validateSessionTerminal)(event);
        }
        catch (error) {
            // A terminal protocol failure cannot close only half of the UI. Preserve
            // the last window, retain the carrier for history reconciliation, and
            // reuse the existing visible/retryable history error path.
            this.bufferLive(event, view);
            this.failHistory(error);
            return;
        }
        this.scheduleConversation(this.appendLive(event, view));
    }
    bufferLive(event, view) {
        const bytes = (0, active_working_set_1.payloadWeight)([event, view]);
        if (this.liveBuffer.length >= active_working_set_1.ACTIVE_WINDOW.highEvents || this.liveBufferBytes + bytes > active_working_set_1.ACTIVE_WINDOW.highBytes) {
            this.failLiveBacklog();
            return;
        }
        this.liveBuffer.push({ event, view });
        this.liveBufferBytes += bytes;
    }
    failLiveBacklog(error = new Error('Live history backlog exceeded the UI budget; reload history to reconcile')) {
        // The Host journal remains authoritative. Never replay a mutation to
        // recover UI evidence, or adopt a partial old-generation history read.
        this.delivery?.clear();
        this.liveBuffer = [];
        this.liveBufferBytes = 0;
        this.advanceHistoryGeneration();
        this.openPromise = null;
        this.stitching = false;
        this.loadingOlder = false;
        this.failHistory(error);
    }
    trimActiveWindow() {
        if (this.openState !== 'open' || this.loadingOlder || this.stitching || this.openPromise !== null
            || this.olderPagePinned || this.historyOpenTarget?.kind === 'anchor')
            return;
        if (this.events.length <= this.trimAfterEvents && this.eventBytes <= this.trimAfterBytes)
            return;
        // A protected huge turn/dependency chain must not trigger an O(N) policy
        // scan for every streaming chunk. Retry only after meaningful growth.
        this.trimAfterEvents = this.events.length + 256;
        this.trimAfterBytes = this.eventBytes + 512 * 1024;
        const cut = (0, active_working_set_1.activeWindowCut)(this.events, this.eventWeights, this.eventBytes);
        const first = this.events[cut];
        if (cut === 0 || first === undefined || !this.conversation.canTrimBefore(first.seq))
            return;
        const events = this.events.slice(cut), views = this.views.slice(cut);
        // Stage atomically. Current-turn evidence, in-flight tools and turn-end
        // artifacts remain intact; older complete turns reload through loadOlder.
        const staged = this.conversation.stageReplacement(events.map((event, index) => ({ event, view: views[index] })), true, true);
        Object.assign(this.conversation, staged);
        this.events = events;
        this.views = views;
        this.eventWeights = this.eventWeights.slice(cut);
        this.eventBytes = this.eventWeights.reduce((sum, bytes) => sum + bytes, 0);
        this.baseSeq = events[0]?.seq ?? 0;
        this.trimAfterEvents = active_working_set_1.ACTIVE_WINDOW.highEvents;
        this.trimAfterBytes = active_working_set_1.ACTIVE_WINDOW.highBytes;
        this.hasMore = true;
        this.xhHistoryOwner?.changed(this);
    }
    /** Route assembler cadence into the Session's existing microtask/RAF notifier. */
    scheduleConversation(publication) {
        if (publication === 'immediate')
            this.notifier.markDirty();
        else if (publication === 'animation-frame')
            this.notifier.markFrameDirty();
    }
    /** Resync-lite: repull the tail page and stitch the liveBuffer through the shared
     *  installWindow path. No openState transition — the UI keeps the current window (no loading
     *  flash); events arriving meanwhile detour to liveBuffer via the stitching flag. */
    repairGap() { return this.historyOperation(() => this.doRepairGap()); }
    async doRepairGap() {
        if (this.stitching)
            return;
        this.stitching = true;
        const generation = this.openGeneration;
        if (this.events.length)
            this.xhRestoreBaseSeq = this.baseSeq;
        try {
            const { result } = await this.history({ maxMessages: exports.PAGE_MESSAGES });
            if (generation !== this.openGeneration || this.openState !== 'open')
                return;
            const value = await this.restoreHistoryRange(this.responseValue(result), generation);
            if (generation !== this.openGeneration || this.openState !== 'open')
                return;
            this.installWindow(value.events, value.hasMore, value.projections);
            this.xhRestoreBaseSeq = undefined;
        }
        catch (error) {
            if (generation === this.openGeneration)
                this.failHistory(error);
        }
        finally {
            if (generation === this.openGeneration)
                this.stitching = false;
        }
    }
    prompt(content, mode, signal, options = {}) {
        return this.historyOperation(async () => {
            const result = await this.doPrompt(content, mode, signal, options);
            if (result.ok)
                void this.xhRecoverLiveAnswer();
            return result;
        });
    }
    command(line) {
        return this.historyOperation(() => this.doCommand(line));
    }
    open() { return this.historyOperation(() => this.openEntry()); }
    historyOperation(operation, dirty = false) {
        this.xhPendingOperations++;
        let result;
        try {
            result = operation();
        }
        catch (error) {
            this.xhPendingOperations--;
            this.xhHistoryOwner?.schedule();
            throw error;
        }
        return Promise.resolve(result).finally(() => {
            this.xhPendingOperations--;
            if (dirty)
                this.xhHistoryOwner?.changed(this);
            else
                this.xhHistoryOwner?.schedule();
        });
    }
    /** Bounded read-only recovery; never resubmits the user's prompt. */
    xhRecoverLiveAnswer() {
        if (this.openState !== 'error')
            return undefined;
        if (this.xhHistoryOwner !== undefined && !this.xhHistoryOwner.manager.isCurrent(this.sessionId))
            return undefined;
        const now = Date.now();
        if (now - (this.xhLiveRecoveryAt ?? 0) < 5000)
            return undefined;
        this.xhLiveRecoveryAt = now;
        return this.loadOlder();
    }
    failHistory(error) {
        this.openState = 'error';
        this.openError = { code: 'history-mapping', message: error instanceof Error ? error.message : String(error) };
        this.notifier.markDirty();
    }
    responseValue(result) {
        if (!result.ok)
            throw new Error(result.error.message ?? 'History request failed');
        return result.value;
    }
    async retryHistory() {
        if (this.events.length)
            this.xhRestoreBaseSeq = this.baseSeq;
        this.advanceHistoryGeneration();
        this.loadingOlder = false;
        this.stitching = false;
        this.openPromise = null;
        this.openState = 'cold';
        this.openError = null;
        this.notifier.markDirty();
        await this.open();
    }
    /** Projected pages may omit raw chunk seqs, but must remain ordered and bounded. */
    xhValidHistoryPage(entries, beforeSeq) {
        if (!Array.isArray(entries) || entries.length === 0 || !Number.isSafeInteger(beforeSeq))
            return false;
        let priorSeq = -1;
        return entries.every(entry => {
            const seq = entry?.event?.seq;
            const ordered = Number.isSafeInteger(seq) && seq >= 0 && seq > priorSeq && seq < beforeSeq;
            priorSeq = seq;
            return ordered;
        });
    }
    /** A reader hint is lightweight and remains resident when history is evicted. */
    setHistoryOpenTarget(target) {
        if (target?.kind === 'anchor' && (!Number.isSafeInteger(target.seq) || target.seq < 0)) {
            throw new Error('History reading anchor must be a non-negative safe event sequence');
        }
        if (target?.kind === 'latest' && (this.historyOpenTarget?.kind !== 'latest' || this.olderPagePinned)) {
            this.olderPagePinned = false;
            this.trimAfterEvents = active_working_set_1.ACTIVE_WINDOW.highEvents;
            this.trimAfterBytes = active_working_set_1.ACTIVE_WINDOW.highBytes;
            this.notifier.markDirty();
        }
        this.historyOpenTarget = target?.kind === 'anchor' ? { kind: 'anchor', seq: target.seq }
            : target === undefined ? undefined : { kind: 'latest' };
        // A cold reader choosing latest no longer needs the pending older page.
        // A reconnect with committed history still restores that window atomically.
        if (this.events.length === 0 && this.historyRestoreTarget() === undefined)
            this.historyRangeRead?.abort();
    }
    historyRestoreTarget() {
        // Reconnect/gap repair owns an already committed window: keep it atomic and
        // never shrink it to a tail page, regardless of a later presentation hint.
        if (this.events.length > 0)
            return this.xhRestoreBaseSeq;
        if (this.historyOpenTarget?.kind === 'latest')
            return undefined;
        return this.historyOpenTarget?.kind === 'anchor' ? this.historyOpenTarget.seq : this.xhRestoreBaseSeq;
    }
    async restoreHistoryRange(value, generation) {
        let target = this.historyRestoreTarget();
        if (target === undefined)
            return value;
        let entries = value.events, hasMore = value.hasMore;
        const pages = [entries];
        while (hasMore && entries[0] !== undefined && entries[0].event.seq > target) {
            const beforeSeq = entries[0].event.seq;
            let response;
            const read = new AbortController();
            this.historyRangeRead = read;
            try {
                response = await this.history({ beforeSeq, maxMessages: exports.PAGE_MESSAGES }, read.signal);
            }
            catch (error) {
                if (generation !== this.openGeneration || this.historyRestoreTarget() === undefined)
                    return value;
                // Latest may have been superseded by a new bookmark before abort settled.
                if (read.signal.aborted)
                    continue;
                throw error;
            }
            finally {
                if (this.historyRangeRead === read)
                    this.historyRangeRead = undefined;
            }
            if (generation !== this.openGeneration)
                return value;
            const { result } = response;
            // An explicit send/jump can supersede a cold bookmark while this RPC is
            // in flight. Discard unused pages, not the initial validated tail page.
            target = this.historyRestoreTarget();
            if (target === undefined)
                return value;
            if (!result.ok)
                throw new Error('History restore failed: ' + (result.error.message ?? 'request rejected'));
            entries = result.value.events;
            hasMore = result.value.hasMore;
            if (!this.xhValidHistoryPage(entries, beforeSeq))
                throw new Error('History restore failed: invalid projected page');
            pages.push(entries);
        }
        if (generation !== this.openGeneration)
            return value;
        if (entries[0] === undefined || entries[0].event.seq > target)
            throw new Error('History restore failed: saved reading position is no longer available');
        return { ...value, events: pages.reverse().flat(), hasMore };
    }
    historyResidencyCold() { return this.openState === 'cold'; }
    historyPayload() { return [this.events, this.views]; }
    historyResidencyProtected() {
        return this.running || this.pending.size > 0 || this.queueMirror.snapshot().length > 0
            || this.firstPromptPendingTurn || this.xhPendingOperations > 0
            || this.openPromise !== null || this.openState === 'loading' || this.loadingOlder || this.stitching;
    }
    unloadHistory() {
        if (this.xhHistoryOwner === undefined || this.xhHistoryOwner.protected(this))
            return false;
        if (this.events.length)
            this.xhRestoreBaseSeq = this.baseSeq;
        this.advanceHistoryGeneration();
        this.openPromise = null;
        this.openState = 'cold';
        this.openError = null;
        this.delivery?.clear();
        this.events = [];
        this.views = [];
        this.eventWeights = [];
        this.eventBytes = 0;
        this.liveBuffer = [];
        this.liveBufferBytes = 0;
        this.baseSeq = 0;
        this.hasMore = false;
        this.subscribedLastSeq = null;
        this.conversation.releaseWindow();
        this.notifier.notifyNow();
        this.notifier.ensureFresh();
        return true;
    }
    windowTailSeq() {
        const tail = this.events[this.events.length - 1];
        return tail === undefined ? null : tail.seq;
    }
    buildSnapshot() {
        if (this.pendingCache === null || this.pendingCache.rev !== this.pendingRev) {
            this.pendingCache = { rev: this.pendingRev, value: [...this.pending.values()] };
        }
        const chat = (0, chat_snapshot_codec_1.readChatSnapshot)(this.conversation.snapshot('chat'));
        const legacy = chat.legacy;
        return {
            sessionId: this.sessionId,
            views: this.conversation,
            chat,
            nodes: legacy.nodes,
            turnTimings: legacy.turnTimings,
            turnEnds: legacy.turnEnds,
            partial: legacy.partial,
            runningCalls: legacy.runningCalls,
            pending: this.pendingCache.value,
            queue: this.queueMirror.snapshot(),
            running: this.running,
            stopRequested: this.stopRequested,
            subagent: this.address === undefined
                ? null
                : { address: this.address, parentAvailable: this.parentAvailable },
            composerPhase: derivePhase(hasVisibleConversationContent(chat)
                || (!this.blankBit && !this.firstPromptPendingTurn)
                || this.running
                || this.pendingCache.value.length > 0, this.promptAttempted),
            removed: this.removed,
            openState: this.openState,
            openError: this.openError,
            hasMore: this.hasMore,
            loadingOlder: this.loadingOlder,
            promptError: this.promptError,
            blank: this.blankBit,
            lastAgentError: this.lastAgentError,
        };
    }
    /** Select ordinary or addressed history transport from the stored browser fact. */
    history(payload, signal) {
        const readSignal = signal === undefined ? this.historyGeneration.signal
            : AbortSignal.any([this.historyGeneration.signal, signal]);
        return this.address === undefined
            ? this.api.sessions.history({ sessionId: this.sessionId, ...payload }, readSignal)
            : this.api.subagents.history({ ...this.address, ...payload }, readSignal);
    }
}
exports.Session = Session;
/** Convert one wire history row into the assembler's transport-neutral input. */
function conversationInput(entry) {
    (0, session_terminal_1.validateSessionTerminal)(entry.event);
    return { event: entry.event, view: entry.view };
}
/** A generic command row alone remains control-plane content; every other visible Chat Node activates the conversation. */
function hasVisibleConversationContent(chat) {
    return chat.order.some(key => chat.nodes.get(key)?.kind !== 'command');
}
/**
 * The composerPhase judgment — the single site that knows the predicate
 * (consumers switch on the result, never re-derive). A failed first prompt
 * stays engaging until an authoritative accepted-turn, running, or pending
 * signal arrives (retry semantics — see ComposerPhase).
 * @param hasContent - authoritative non-blank activity beyond a pending first
 *   prompt, visible non-command Chat content, a running turn, or a pending interaction.
 * @param promptAttempted - a prompt was initiated on this session object.
 * @returns the derived phase.
 */
function derivePhase(hasContent, promptAttempted) {
    if (hasContent)
        return 'active';
    return promptAttempted ? 'engaging' : 'blank';
}

},
"src/modules/client-runtime/sessions/chat-snapshot-codec.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/chat-snapshot-codec.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readChatSnapshot = readChatSnapshot;
/** Compatibility boundary for untyped view publishers; readers validate every returned value. */
const zod_1 = require("zod");
const compaction_outcome_1 = require("../../shared/compaction-outcome");
const sessions_schema_1 = require("../../client-connection/contracts/host/apiproxy/api/sessions.schema");
const value_guards_1 = require("../value-guards");
const conversation_1 = require("./conversation");
const n = zod_1.z.number(), s = zod_1.z.string(), maybeNumber = n.optional(), maybeString = s.optional();
const dataStore = zod_1.z.custom(value => (0, value_guards_1.isRecord)(value) && typeof value.get === 'function');
const wire = { seq: n, time: n, sourceEventSeqs: zod_1.z.array(n).optional(), surfaceOp: zod_1.z.unknown().optional(), ignorable: zod_1.z.literal(true).optional() };
const turnStart = zod_1.z.looseObject({ ...wire, type: zod_1.z.literal('turn/start'), data: zod_1.z.looseObject({ turn: n }) });
const turnEnd = zod_1.z.looseObject({ ...wire, type: zod_1.z.literal('turn/end'), data: zod_1.z.looseObject({ turn: n }) });
const stepStart = zod_1.z.looseObject({ ...wire, type: zod_1.z.literal('step/start'), data: zod_1.z.looseObject({ turn: n, step: n }) });
const stepEnd = zod_1.z.looseObject({ ...wire, type: zod_1.z.literal('step/end'), data: zod_1.z.looseObject({ turn: n, step: n }) });
const status = zod_1.z.enum(['open', 'closed', 'unknown']);
const step = zod_1.z.looseObject({ turn: n, step: n, start: stepStart.optional(), end: stepEnd.optional(), status, data: dataStore }).transform(value => ({ ...value, start: value.start, end: value.end }));
const turn = zod_1.z.looseObject({ turn: n, start: turnStart.optional(), end: turnEnd.optional(), status, steps: zod_1.z.array(step), data: dataStore }).transform(value => ({ ...value, start: value.start, end: value.end }));
const timeline = zod_1.z.looseObject({ turnOrder: zod_1.z.array(n), turns: zod_1.z.map(n, turn) });
const location = zod_1.z.union([zod_1.z.object({ kind: zod_1.z.enum(['session', 'unresolved']) }), zod_1.z.object({ kind: zod_1.z.literal('turn'), turn }), zod_1.z.object({ kind: zod_1.z.literal('step'), turn, step })]);
const chatNode = zod_1.z.looseObject({ key: s, kind: s, id: s, target: zod_1.z.literal('chat'), data: zod_1.z.unknown(), anchorSeq: n, location, visibility: zod_1.z.enum(['visible', 'hidden']) });
const card = zod_1.z.looseObject({ card: s }).nullable();
const tool = zod_1.z.lazy(() => zod_1.z.union([
    zod_1.z.looseObject({ callId: s, name: s, argsRaw: s, turn: n, step: n, time: n, callView: card, subCalls: zod_1.z.array(tool) }).refine(value => !('kind' in value)),
    zod_1.z.looseObject({ kind: zod_1.z.literal('tool-result'), seq: n, time: n, callId: s, call: zod_1.z.object({ name: s, argsRaw: s }).nullable(), callTime: n.nullable(), content: zod_1.z.array(zod_1.z.unknown()), isError: zod_1.z.boolean(), error: zod_1.z.object({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional(), callView: card, resultView: card, subCalls: zod_1.z.array(tool) }),
]));
const running = zod_1.z.looseObject({ callId: s, name: s, argsRaw: s, turn: n, step: n, time: n, callView: card, subCalls: zod_1.z.array(tool) });
const block = zod_1.z.union([
    zod_1.z.object({ kind: zod_1.z.literal('text'), text: s }), zod_1.z.object({ kind: zod_1.z.literal('reasoning'), text: s }),
    zod_1.z.object({ kind: zod_1.z.literal('image'), attachment: sessions_schema_1.imageAttachmentRefSchema }),
    zod_1.z.object({ kind: zod_1.z.literal('tool-call'), callId: s, name: s, argsRaw: s }), zod_1.z.object({ kind: zod_1.z.literal('other'), block: zod_1.z.unknown() }),
]);
const blocks = zod_1.z.array(block), base = { seq: n, time: n };
const progress = zod_1.z.object({ stage: zod_1.z.enum(['preparing', 'summarizing', 'splitting', 'merging', 'retrying', 'paused', 'validating', 'committing']), calls: n, completedParts: n, splits: n, retries: n, delayMs: n.nullish(), inputTokensBefore: n.nullish(), inputTokensAfter: n.nullish() });
const retryBase = { ...base, kind: zod_1.z.literal('model-retry'), turn: n, step: n, retryId: s, retry: n, retryState: zod_1.z.enum(['scheduled', 'started', 'cancelled']) };
const failure = zod_1.z.looseObject({ message: s, code: s, status: maybeNumber, providerRetryAfterMs: maybeNumber, requestId: maybeString });
const retryFacts = { provider: s, policyKey: s, delayMs: n, failure, partial: zod_1.z.literal(true).optional() };
const legacyNode = zod_1.z.union([
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('user'), content: zod_1.z.array(zod_1.z.unknown()), source: zod_1.z.unknown() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('steering'), messageId: s, content: zod_1.z.array(zod_1.z.unknown()), source: zod_1.z.unknown() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('context'), content: zod_1.z.array(zod_1.z.unknown()), source: zod_1.z.unknown(), provenance: zod_1.z.object({ role: zod_1.z.enum(['inject', 'recall']), label: s.nullable() }), form: zod_1.z.enum(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']).nullable() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('assistant'), messageId: maybeString, turn: n, step: n, blocks, usage: zod_1.z.unknown().optional(), provenance: zod_1.z.object({ provider: s, model: s }).optional(), requestConfig: zod_1.z.looseObject({ provider: s, model: s, purpose: maybeString, thinking: maybeString, reasoningEffort: maybeString, temperature: maybeNumber, maxTokens: maybeNumber, stop: zod_1.z.array(s).optional() }).optional(), timing: zod_1.z.object({ stepStartTime: n.nullable(), firstTokenTime: n.nullable(), completedTime: n, receptionMs: n.optional() }).optional(), interrupted: zod_1.z.literal(true).optional() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('tool-result'), callId: s, call: zod_1.z.object({ name: s, argsRaw: s }).nullable(), callTime: n.nullable(), content: zod_1.z.array(zod_1.z.unknown()), isError: zod_1.z.boolean(), error: zod_1.z.object({ name: s, code: s }).optional(), meta: zod_1.z.unknown().optional(), callView: card, resultView: card, subCalls: zod_1.z.array(tool) }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('command'), commandId: s, name: s.nullable(), args: s.nullable(), outcome: zod_1.z.object({ kind: zod_1.z.enum(['success', 'error']), text: maybeString, sourceEventSeq: maybeNumber }).nullable() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-error'), turn: n, step: n, message: s, code: maybeString }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('turn-max-tokens'), turn: n, step: n }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('unknown'), type: s, data: zod_1.z.unknown() }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('compaction'), summary: s.nullable(), summaryEventSeq: n.nullable(), shadowedItemCount: n.nullable(), shadowedTokenCount: n.nullable(), progress: progress.optional(), startedAt: maybeNumber, endedAt: maybeNumber }),
    zod_1.z.looseObject({ ...base, kind: zod_1.z.literal('compaction'), status: zod_1.z.enum(['running', 'failed', 'skipped', 'cancelled']), outcome: compaction_outcome_1.CompactionEndOutcomeSchema.optional(), progress: progress.optional(), progressTime: maybeNumber, error: s.nullable(), endedAt: maybeNumber }),
    zod_1.z.looseObject({ ...retryBase, ...retryFacts, mode: zod_1.z.literal('normal'), maxRetries: n }),
    zod_1.z.looseObject({ ...retryBase, ...retryFacts, mode: zod_1.z.literal('always') }),
    zod_1.z.looseObject({ ...retryBase, partial: zod_1.z.literal(true), delayMs: zod_1.z.undefined().optional(), mode: zod_1.z.undefined().optional(), policyKey: zod_1.z.undefined().optional(), failure: zod_1.z.undefined().optional(), maxRetries: zod_1.z.undefined().optional() }),
]);
const legacy = zod_1.z.looseObject({ nodes: zod_1.z.array(legacyNode), turnTimings: zod_1.z.map(n, zod_1.z.object({ startTime: n, endTime: maybeNumber })).optional(), turnEnds: zod_1.z.map(n, n), partial: zod_1.z.object({ turn: n, step: n, blocks }).nullable(), runningCalls: zod_1.z.array(running) }).transform(value => ({ ...value, turnTimings: value.turnTimings }));
const decoded = new WeakMap();
function isTimeline(value) { return timeline.safeParse(value).success; }
function isLegacy(value) { return legacy.safeParse(value).success; }
function isChatNode(value) { return chatNode.safeParse(value).success; }
function strings(value) {
    if (!(0, value_guards_1.isUnknownArray)(value) || !value.every(item => typeof item === 'string'))
        throw new Error('chat view returned invalid key list');
    return value;
}
function invoke(receiver, name, args) {
    const fn = receiver[name];
    if (typeof fn !== 'function')
        throw new Error(`chat view reader ${name} is not callable`);
    const value = Reflect.apply(fn, receiver, args);
    return value;
}
/** Old JS targets use checked adapters; typed owned publications retain their exact identity. */
function readChatSnapshot(value) {
    if (value === undefined)
        return conversation_1.EMPTY_CHAT_SNAPSHOT;
    if ((0, conversation_1.isChatSnapshot)(value))
        return value;
    if (!(0, value_guards_1.isRecord)(value) || !(0, value_guards_1.isRecord)(value.nodes) || !(0, value_guards_1.isRecord)(value.locations) || !isLegacy(value.legacy) || !isTimeline(value.timeline))
        throw new Error('invalid chat view publication');
    const old = decoded.get(value);
    if (old !== undefined)
        return old;
    const nodes = value.nodes, locations = value.locations;
    const snapshot = {
        order: strings(value.order), legacy: value.legacy, timeline: value.timeline,
        nodes: { get(key) { const node = invoke(nodes, 'get', [key]); if (node === undefined)
                return undefined; if (!isChatNode(node))
                throw new Error('chat view returned invalid node'); return node; },
            values() { const list = invoke(nodes, 'values', []); if (!(0, value_guards_1.isUnknownArray)(list) || !list.every(isChatNode))
                throw new Error('chat view returned invalid nodes'); return list; } },
        locations: { getTurn(turn) { return strings(invoke(locations, 'getTurn', [turn])); }, getStep(turn, step) { return strings(invoke(locations, 'getStep', [turn, step])); } },
    };
    decoded.set(value, snapshot);
    return snapshot;
}

},
"src/modules/shared/compaction-outcome.js": function(module, exports, require) {
// source: src/modules/shared/compaction-outcome.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompactionEndOutcomeSchema = void 0;
exports.isCompactionEndOutcome = isCompactionEndOutcome;
exports.compactionTerminalPhase = compactionTerminalPhase;
exports.validCompactionTerminalData = validCompactionTerminalData;
const zod_1 = require("zod");
/** Additive durable terminal outcome. Absence retains legacy error semantics. */
exports.CompactionEndOutcomeSchema = zod_1.z.enum(['applied', 'no_benefit', 'no_eligible_source', 'interrupted', 'failed']);
function isCompactionEndOutcome(value) {
    return exports.CompactionEndOutcomeSchema.safeParse(value).success;
}
function compactionTerminalPhase(outcome, error) {
    switch (outcome) {
        case 'applied': return 'succeeded';
        case 'no_benefit':
        case 'no_eligible_source': return 'skipped';
        case 'interrupted': return 'cancelled';
        case 'failed': return 'failed';
        case undefined: return error == null ? 'succeeded' : 'failed';
    }
}
/** Validate explicit outcome/error consistency; legacy payloads remain accepted. */
function validCompactionTerminalData(value) {
    switch (value.outcome) {
        case 'applied':
        case 'no_benefit':
        case 'no_eligible_source': return value.error == null;
        case 'interrupted':
        case 'failed': return typeof value.error === 'string' && value.error.trim() !== '';
        case undefined: return true;
    }
}

},
"src/modules/client-runtime/sessions/conversation.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/conversation.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_CHAT_SNAPSHOT = exports.EMPTY_CONVERSATION_VIEWS = void 0;
exports.toAssistantBlocks = toAssistantBlocks;
exports.toAssistantBlock = toAssistantBlock;
exports.publishChatSnapshot = publishChatSnapshot;
exports.isChatSnapshot = isChatSnapshot;
const value_guards_1 = require("../value-guards");
const sessions_schema_1 = require("../../client-connection/contracts/host/apiproxy/api/sessions.schema");
/**
 * core ContentBlock[] -> AssistantBlock[] (classifier shared by finalized messages and partial block-end).
 * @param content - core content blocks verbatim.
 * @returns UI-classified blocks in source order.
 */
function toAssistantBlocks(content) {
    return content.map(toAssistantBlock);
}
/**
 * Classify one block (ToolCallBlock fields are id/arguments, mapped to callId/argsRaw).
 * @param block - one core content block.
 * @returns the UI classification.
 */
function toAssistantBlock(block) {
    if (!(0, value_guards_1.isRecord)(block))
        return { kind: 'other', block };
    switch (block.type) {
        case 'text':
            if (typeof block.text === 'string')
                return { kind: 'text', text: block.text };
            break;
        case 'reasoning':
            if (typeof block.text === 'string')
                return { kind: 'reasoning', text: block.text };
            break;
        case 'image': {
            const attachment = block.attachment;
            if (isImageAttachmentRef(attachment))
                return { kind: 'image', attachment };
            break;
        }
        case 'tool-call': if (typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string') {
            return { kind: 'tool-call', callId: block.id, name: block.name, argsRaw: block.arguments };
        }
    }
    return { kind: 'other', block };
}
function isImageAttachmentRef(value) {
    return sessions_schema_1.imageAttachmentRefSchema.safeParse(value).success;
}
const EMPTY_LIST = [];
const EMPTY_TIMELINE = { turnOrder: EMPTY_LIST, turns: new Map() };
/** Empty target store used by fixtures and Sessions without registered views. */
exports.EMPTY_CONVERSATION_VIEWS = {
    get: () => undefined,
};
/** Empty Chat target used before a view builder is registered. */
exports.EMPTY_CHAT_SNAPSHOT = {
    order: EMPTY_LIST,
    nodes: {
        get: () => undefined,
        values: () => EMPTY_LIST,
    },
    locations: {
        getTurn: () => EMPTY_LIST,
        getStep: () => EMPTY_LIST,
    },
    timeline: EMPTY_TIMELINE,
    legacy: {
        nodes: EMPTY_LIST,
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: EMPTY_LIST,
    },
};
/** Typed producer attestation. Registration does not clone or modify the snapshot. */
const publishedChatSnapshots = new WeakSet();
function publishChatSnapshot(snapshot) {
    publishedChatSnapshots.add(snapshot);
    return snapshot;
}
/** Only snapshots constructed by an owned typed Chat publisher cross the erased target store. */
function isChatSnapshot(value) {
    return (0, value_guards_1.isRecord)(value) && publishedChatSnapshots.has(value);
}

},
"src/modules/shared/session-terminal.js": function(module, exports, require) {
// source: src/modules/shared/session-terminal.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSessionTerminal = validateSessionTerminal;
const session_terminal_1 = require("./generated/session-terminal");
/** Validate the owned terminal boundary before any Session/timeline mutation.
 * Keep the immutable carrier and foreign extension fields; do not normalize,
 * synthesize success, or copy raw payloads into diagnostics.
 */
function validateSessionTerminal(event) {
    if (event.type !== 'turn/end')
        return;
    const decoded = session_terminal_1.TurnEndDataInputSchema.safeParse(event.data);
    if (!decoded.success) {
        const issues = decoded.error.issues.slice(0, 4).map(issue => issue.path.join('.') + ':' + issue.code).join(', ');
        throw new Error(`${session_terminal_1.SESSION_TERMINAL_CONTRACT}: invalid turn/end at seq ${event.seq} (${issues})`);
    }
}

},
"src/modules/shared/generated/session-terminal.js": function(module, exports, require) {
// source: src/modules/shared/generated/session-terminal.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnFailureSchema = exports.TurnEndReasonWireSchema = exports.TurnEndReasonInputSchema = exports.TurnEndDataInputSchema = exports.TurnEndDataSchema = exports.LegacyTurnFailureSchema = exports.LegacyTurnEndReasonSchema = exports.SESSION_TERMINAL_SCHEMA_SHA256 = exports.SESSION_TERMINAL_CONTRACT = void 0;
// GENERATED from crates/xharness-projection/src/wire.rs. Do not edit.
// Run the remote Rust exporter, then scripts/generate-session-terminal-contract.mjs.
const zod_1 = require("zod");
exports.SESSION_TERMINAL_CONTRACT = "xharness-session-terminal-v1";
exports.SESSION_TERMINAL_SCHEMA_SHA256 = "746b83b5db83d153180eb2c7b3dcc476302b2efc1346b496cb47edc1692cc2c9";
exports.LegacyTurnEndReasonSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("aborted") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("stop") }), zod_1.z.looseObject({ "error": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "failure": zod_1.z.union([exports.LegacyTurnFailureSchema, zod_1.z.null()]).optional(), "kind": zod_1.z.literal("error") })]));
exports.LegacyTurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "details": zod_1.z.union([zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()), zod_1.z.null()]).optional(), "message": zod_1.z.string() }));
exports.TurnEndDataSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonWireSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndDataInputSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "reason": exports.TurnEndReasonInputSchema, "turn": zod_1.z.number().int().min(0).max(4294967295).min(0) }));
exports.TurnEndReasonInputSchema = zod_1.z.lazy(() => zod_1.z.union([exports.TurnEndReasonWireSchema, exports.LegacyTurnEndReasonSchema]));
exports.TurnEndReasonWireSchema = zod_1.z.lazy(() => zod_1.z.union([zod_1.z.looseObject({ "kind": zod_1.z.literal("completed") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-tokens") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("cancelled") }), zod_1.z.looseObject({ "kind": zod_1.z.literal("max-steps") }), zod_1.z.looseObject({ "error": exports.TurnFailureSchema, "kind": zod_1.z.literal("error") })]));
exports.TurnFailureSchema = zod_1.z.lazy(() => zod_1.z.looseObject({ "code": zod_1.z.string(), "message": zod_1.z.string() }));

},
"src/modules/client-runtime/sessions/conversation-assembler.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/conversation-assembler.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationNodeAssembler = void 0;
const conversation_1 = require("../contract/conversation");
const value_guards_1 = require("../value-guards");
const conversation_location_index_1 = require("./conversation-location-index");
const PUBLICATION_RANK = {
    none: 0,
    'animation-frame': 1,
    immediate: 2,
};
const LOCATION_DATA_SCOPES = ['step', 'turn'];
function emptyLocationData() {
    return { step: null, turn: null };
}
function maximumPublication(left, right) {
    return PUBLICATION_RANK[left] >= PUBLICATION_RANK[right] ? left : right;
}
function startSeq(context) {
    return context.startSeq;
}
function insertionIndex(contexts, seq) {
    let low = 0;
    let high = contexts.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = contexts[middle];
        if (candidate !== undefined && candidate.startSeq !== undefined && candidate.startSeq < seq)
            low = middle + 1;
        else
            high = middle;
    }
    return low;
}
function contextSnapshot(context) {
    return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        matches: context.matches,
        start: context.start,
        state: context.state,
        current: context.current,
    };
}
function mergeMatches(key, additions, existing) {
    const merged = [];
    let added = 0;
    let current = 0;
    while (added < additions.length || current < existing.length) {
        const left = additions[added];
        const right = existing[current];
        if (left !== undefined && right !== undefined && left.event.seq === right.event.seq) {
            throw new Error(`conversation Context ${key} received duplicate Match ${left.event.seq}`);
        }
        if (right === undefined || (left !== undefined && left.event.seq < right.event.seq)) {
            if (left === undefined)
                break;
            merged.push(left);
            added++;
        }
        else {
            merged.push(right);
            current++;
        }
    }
    return merged;
}
/**
 * Session-owned incremental engine that assembles business Contexts from a
 * contiguous Event window and materializes registered view snapshots.
 */
class ConversationNodeAssembler {
    /**
     * @param eventDefinitions - live Event Definition registry.
     * @param viewDefinitions - live view builder registry.
     */
    constructor(eventDefinitions, viewDefinitions) {
        this.eventDefinitions = eventDefinitions;
        this.viewDefinitions = viewDefinitions;
        this.contexts = new Map();
        this.contextsByKind = new Map();
        this.contextsBySeq = new Map();
        this.inputs = new Map();
        this.locationIndex = new conversation_location_index_1.ConversationLocationIndex();
        this.dirty = new Set();
        this.revised = new Set();
        this.reusableLocations = new Set();
        this.dependents = new Map();
        this.views = new Map();
        this.hasMore = false;
        this.replacePending = true;
        this.timelineDirty = true;
        this.resetViewBuilders();
    }
    /**
     * Replace the complete loaded window after open, resync, or gap repair.
     * @param entries - complete contiguous window.
     * @param hasMore - whether older history remains outside the window.
     * @returns immediate publication request.
     */
    /** Stage a complete history mapping without publishing partial reducers or views. */
    stageReplacement(entries, hasMore, reuse = false) {
        const staged = new ConversationNodeAssembler(this.eventDefinitions, this.viewDefinitions);
        if (reuse && !this.replacePending && this.dirty.size === 0) {
            staged.historyReuse = { committed: this, reused: new Map(), boundaries: new WeakMap() };
        }
        try {
            staged.stageWindow(entries, hasMore);
            staged.flush();
            return staged;
        }
        finally {
            // A committed window must not retain previous transaction graphs.
            staged.historyReuse = undefined;
        }
    }
    replaceWindow(entries, hasMore) {
        Object.assign(this, this.stageReplacement(entries, hasMore));
        return 'immediate';
    }
    /** Release materialized view snapshots when an inactive window is evicted. */
    releaseWindow() {
        this.replaceWindow([], false);
        this.resetViewBuilders();
    }
    stageWindow(entries, hasMore) {
        this.contexts.clear();
        this.contextsByKind.clear();
        this.contextsBySeq.clear();
        this.inputs.clear();
        this.dirty.clear();
        this.revised.clear();
        this.dependents.clear();
        this.hasMore = hasMore;
        const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);
        for (const entry of sorted)
            this.inputs.set(entry.event.seq, entry);
        this.locationIndex.rebuild(sorted);
        this.timelineDirty = true;
        const pending = new Map();
        if (this.historyReuse === undefined) {
            for (const entry of sorted)
                this.matchInput(entry);
        }
        else {
            // Collect all evidence before replay: immediate start replay would miss
            // the old completed context and repeat each later delta reducer.
            for (const entry of sorted)
                this.collectInput(entry, pending);
            const affected = new Set();
            this.applyPendingMatches(pending, affected);
            this.replayContexts(affected);
        }
        this.replayDependencies();
        this.revised.clear();
        if (this.historyReuse !== undefined) {
            for (const context of this.contexts.values()) {
                if (context.start !== undefined)
                    continue;
                const old = this.historyReuse.committed.contexts.get(context.key);
                if (old !== undefined && this.reusable(context, old)) {
                    this.historyReuse.reused.set(context.key, { old, state: context.state });
                }
            }
        }
        for (const context of this.contexts.values())
            this.dirty.add(context);
        this.replacePending = true;
        return 'immediate';
    }
    /**
     * Add one contiguous live tail event without scanning existing Contexts.
     * @param input - appended Event and optional wire view.
     * @returns highest requested publication cadence.
     */
    append(input) {
        if (this.inputs.has(input.event.seq))
            return 'none';
        this.revised.clear();
        this.inputs.set(input.event.seq, input);
        let publication = 'none';
        if (isLocationBoundary(input.event.type)) {
            const previousTimeline = this.locationIndex.snapshot();
            const changed = this.locationIndex.appendBoundary(input.event);
            if (this.locationIndex.snapshot() !== previousTimeline) {
                this.timelineDirty = true;
                publication = 'immediate';
            }
            this.replayContexts(this.refreshMatchLocations(changed), true);
            this.reusableLocations.clear();
            if (changed.size > 0)
                publication = 'immediate';
        }
        else {
            this.locationIndex.appendNonBoundary(input.event);
        }
        publication = maximumPublication(publication, this.matchInput(input));
        if (this.replayRevisedDependents())
            publication = 'immediate';
        this.revised.clear();
        return publication;
    }
    /**
     * Add an older page while preserving existing Context and view identities.
     * @param entries - newly loaded older Events.
     * @param hasMore - whether history still precedes the expanded window.
     * @returns highest requested publication cadence.
     */
    prepend(entries, hasMore) {
        const fresh = entries.filter(entry => !this.inputs.has(entry.event.seq));
        if (fresh.length === 0 && hasMore === this.hasMore)
            return 'none';
        Object.assign(this, this.stageReplacement([...fresh, ...this.sortedInputs()], hasMore, true));
        return 'immediate';
    }
    /** A tail window must not silently discard a predecessor's business State.
     * Unknown/third-party dependency chains remain pinned rather than guessed. */
    canTrimBefore(seq) {
        for (const context of this.contexts.values()) {
            if (!context.matches.some(match => match.event.seq >= seq))
                continue;
            if ((context.matches[0]?.event.seq ?? seq) < seq)
                return false;
            for (const dependency of context.dependencies.values()) {
                const predecessor = dependency.key === undefined ? undefined : this.contexts.get(dependency.key);
                if (predecessor?.startSeq !== undefined && predecessor.startSeq < seq)
                    return false;
            }
        }
        return true;
    }
    /**
     * Rebuild against the current Registry set after a low-frequency plugin change.
     * @returns immediate publication request.
     */
    rebuildRegistry() {
        return this.replaceWindow(this.sortedInputs(), this.hasMore);
    }
    /**
     * Materialize dirty Contexts and advance every registered view builder.
     * @returns whether any view snapshot was rebuilt or incrementally applied.
     */
    flush() {
        if (!this.replacePending && this.dirty.size === 0 && !this.timelineDirty)
            return false;
        if (this.replacePending) {
            this.replaceLocationData();
            const allByTarget = new Map();
            for (const target of this.views.keys())
                allByTarget.set(target, []);
            for (const context of this.contexts.values()) {
                const target = context.definition.target;
                if (target === undefined || !this.views.has(target))
                    continue;
                const node = this.buildNode(context, target);
                context.current.set(target, node);
                if (node !== null)
                    allByTarget.get(target)?.push(node);
            }
            for (const view of this.views.values()) {
                view.snapshot = view.builder.replace({
                    nodes: allByTarget.get(view.target) ?? [],
                    timeline: this.locationIndex.snapshot(),
                });
            }
            this.replacePending = false;
            this.dirty.clear();
            this.timelineDirty = false;
            return true;
        }
        const upsertsByTarget = new Map();
        for (const target of this.views.keys())
            upsertsByTarget.set(target, []);
        if (this.applyDirtyLocationData())
            this.timelineDirty = true;
        for (const context of this.dirty) {
            const target = context.definition.target;
            if (target === undefined || !this.views.has(target))
                continue;
            const previous = context.current.get(target) ?? null;
            const node = this.buildNode(context, target);
            if (node === null && previous !== null) {
                throw new Error(`conversation Definition "${context.kind}" withdrew materialized target "${target}"; return the same key with hidden visibility instead`);
            }
            context.current.set(target, node);
            if (node !== null)
                upsertsByTarget.get(target)?.push(node);
        }
        this.dirty.clear();
        const timelineDirty = this.timelineDirty;
        this.timelineDirty = false;
        for (const view of this.views.values()) {
            const upserts = upsertsByTarget.get(view.target) ?? [];
            if (upserts.length === 0 && !timelineDirty)
                continue;
            view.snapshot = view.builder.apply({
                upserts,
                timeline: this.locationIndex.snapshot(),
            });
        }
        return true;
    }
    /**
     * Read the latest snapshot of a registered target.
     * @param target - registered view target.
     * @returns target snapshot, or undefined when no builder is registered.
     */
    snapshot(target) {
        return this.views.get(target)?.snapshot;
    }
    get(target) {
        return this.snapshot(target);
    }
    sortedInputs() {
        return [...this.inputs.values()].sort((left, right) => left.event.seq - right.event.seq);
    }
    matchInput(input) {
        return this.dispatchInput(input, (definition, id, role) => this.acceptMatch(definition, id, role, input));
    }
    collectInput(input, pending) {
        return this.dispatchInput(input, (definition, id, role) => {
            const key = (0, conversation_1.conversationContextKey)(definition.kind, id);
            const match = {
                ...input,
                role,
                location: this.locationIndex.locationOf(input.event),
            };
            const matches = pending.get(key) ?? [];
            matches.push({ definition, id, match });
            pending.set(key, matches);
            return definition.publication?.(match) ?? 'immediate';
        });
    }
    dispatchInput(input, accept) {
        const matchedTargets = new Set();
        let publication = 'none';
        for (const definition of this.eventDefinitions.entries()) {
            const result = definition.match(input.event, input.view);
            if (result === null)
                continue;
            if (definition.target !== undefined)
                matchedTargets.add(definition.target);
            publication = maximumPublication(publication, accept(definition, result.id, result.role));
        }
        const fallback = this.eventDefinitions.fallbackEntry();
        const target = fallback?.target;
        if (fallback !== undefined && target !== undefined && !matchedTargets.has(target)) {
            const result = fallback.match(input.event, input.view);
            if (result !== null) {
                publication = maximumPublication(publication, accept(fallback, result.id, result.role));
            }
        }
        return publication;
    }
    acceptMatch(definition, id, role, input) {
        const key = (0, conversation_1.conversationContextKey)(definition.kind, id);
        let context = this.contexts.get(key);
        if (role === 'start' && context?.start !== undefined) {
            throw new Error(`conversation Context ${key} received more than one start Match`);
        }
        if (context === undefined) {
            context = {
                key,
                kind: definition.kind,
                id,
                definition,
                startSeq: undefined,
                start: undefined,
                matches: [],
                state: undefined,
                revision: 0,
                current: new Map(),
                locationData: emptyLocationData(),
                dependencies: new Map(),
            };
            this.contexts.set(key, context);
        }
        const match = {
            ...input,
            role,
            location: this.locationIndex.locationOf(input.event),
        };
        const previous = context.matches.at(-1);
        if (previous !== undefined && previous.event.seq >= input.event.seq) {
            throw new Error(`conversation Context ${key} received non-appended Match ${input.event.seq}`);
        }
        if (role === 'start' && context.matches.length > 0) {
            throw new Error(`conversation Context ${key} received an update before its start Match`);
        }
        context.matches.push(match);
        if (role === 'start') {
            context.startSeq = input.event.seq;
            context.start = match;
            this.indexStartedContext(context);
        }
        const owners = this.contextsBySeq.get(input.event.seq) ?? new Set();
        owners.add(context);
        this.contextsBySeq.set(input.event.seq, owners);
        if (role === 'start') {
            this.replayContext(context);
        }
        else if (context.state !== undefined) {
            const typed = { ...contextSnapshot(context), state: context.state };
            context.state = requireState(definition, 'update', definition.update(typed, match));
            context.revision++;
            this.revised.add(context);
        }
        this.dirty.add(context);
        return definition.publication?.(match) ?? 'immediate';
    }
    applyPendingMatches(pending, affected) {
        const startsByKind = new Map();
        for (const [key, entries] of pending) {
            const first = entries[0];
            if (first === undefined)
                continue;
            let context = this.contexts.get(key);
            if (context === undefined) {
                context = {
                    key,
                    kind: first.definition.kind,
                    id: first.id,
                    definition: first.definition,
                    startSeq: undefined,
                    start: undefined,
                    matches: [],
                    state: undefined,
                    revision: 0,
                    current: new Map(),
                    locationData: emptyLocationData(),
                    dependencies: new Map(),
                };
                this.contexts.set(key, context);
            }
            let discoveredStart;
            const additions = entries
                .map((entry) => {
                if (entry.definition !== context.definition || entry.id !== context.id) {
                    throw new Error(`conversation Context ${key} received inconsistent Definition identity`);
                }
                if (entry.match.role === 'start') {
                    if (discoveredStart !== undefined || context.start !== undefined) {
                        throw new Error(`conversation Context ${key} received more than one start Match`);
                    }
                    discoveredStart = entry.match;
                }
                const owners = this.contextsBySeq.get(entry.match.event.seq) ?? new Set();
                owners.add(context);
                this.contextsBySeq.set(entry.match.event.seq, owners);
                return entry.match;
            })
                .sort((left, right) => left.event.seq - right.event.seq);
            context.matches = mergeMatches(context.key, additions, context.matches);
            if (discoveredStart !== undefined) {
                context.start = discoveredStart;
                context.startSeq = discoveredStart.event.seq;
                const starts = startsByKind.get(context.kind) ?? [];
                starts.push(context);
                startsByKind.set(context.kind, starts);
            }
            if (context.start !== undefined && context.matches[0] !== context.start) {
                throw new Error(`conversation Context ${context.key} received an update before its start Match`);
            }
            affected.add(context);
            this.dirty.add(context);
        }
        for (const [kind, contexts] of startsByKind)
            this.indexStartedContexts(kind, contexts);
    }
    replayContexts(contexts, relocated = false) {
        const ordered = [...contexts].sort((left, right) => (left.startSeq ?? Number.POSITIVE_INFINITY) - (right.startSeq ?? Number.POSITIVE_INFINITY));
        for (const context of ordered) {
            if (context.start === undefined) {
                context.state = undefined;
                this.dirty.add(context);
                continue;
            }
            if (relocated && this.reusableLocations.has(context) && context.state !== undefined) {
                // refreshMatchLocations already rebound the evidence. Boundary-only
                // changes must not re-run event reducers, but dependent readers and
                // all materializers still see a new revision and current timeline.
                context.revision++;
                this.revised.add(context);
                this.dirty.add(context);
            }
            else
                this.replayContext(context);
        }
    }
    replayContext(context) {
        const reuse = this.historyReuse;
        const old = reuse?.committed.contexts.get(context.key);
        if (reuse !== undefined && old !== undefined && this.reusable(context, old)) {
            const matches = new Map();
            for (let index = 0; index < old.matches.length; index++) {
                const next = context.matches[index], prior = old.matches[index];
                if (next !== undefined && prior !== undefined)
                    matches.set(prior, next);
            }
            // Audited local states may retain top-level Match records. Rebind those
            // readers to the fresh staged timeline, preserving all business values.
            const state = old.state;
            if ((0, value_guards_1.isRecord)(state)) {
                const changes = {};
                for (const [key, value] of Object.entries(state)) {
                    const match = matches.get(value);
                    if (match !== undefined)
                        changes[key] = match;
                }
                context.state = Object.keys(changes).length === 0 ? state : { ...state, ...changes };
            }
            else
                context.state = state;
            context.revision = old.revision;
            this.replaceDependencies(context, new Map(old.dependencies));
            reuse.reused.set(context.key, { old, state: context.state });
            this.dirty.add(context);
            return;
        }
        reuse?.reused.delete(context.key);
        const start = context.start;
        if (start === undefined) {
            context.state = undefined;
            return;
        }
        if (context.matches[0] !== start) {
            throw new Error(`conversation Context ${context.key} received an update before its start Match`);
        }
        const dependencies = new Map();
        const reader = this.readerFor(start.event.seq, dependencies);
        context.state = undefined;
        context.state = requireState(context.definition, 'start', context.definition.start(contextSnapshot(context), start, reader));
        this.replaceDependencies(context, dependencies);
        for (let index = 1; index < context.matches.length; index++) {
            const match = context.matches[index];
            if (match === undefined || match.role !== 'update')
                continue;
            const typed = { ...contextSnapshot(context), state: context.state };
            context.state = requireState(context.definition, 'update', context.definition.update(typed, match));
        }
        context.revision++;
        this.revised.add(context);
        this.dirty.add(context);
    }
    reusable(context, old) {
        const reuse = this.historyReuse;
        if (reuse === undefined || context.definition !== old.definition || context.definition.historyReuse !== 'local'
            || (0, value_guards_1.isRecord)(old.state) && old.state.hidden === true)
            return false;
        if (context.matches.length !== old.matches.length || context.matches.some((match, index) => {
            const prior = old.matches[index];
            return prior === undefined || match.event !== prior.event || match.view !== prior.view || match.role !== prior.role
                || !equalBoundary(match.location, prior.location, reuse.boundaries);
        }))
            return false;
        for (const dependency of old.dependencies.values()) {
            const current = context.startSeq === undefined ? undefined : this.previousContext(dependency.kind, context.startSeq);
            const prior = dependency.key === undefined ? undefined : reuse.committed.contexts.get(dependency.key);
            if (current?.key !== dependency.key
                || current?.state !== prior?.state && (current === undefined || reuse.reused.get(current.key)?.old !== prior)
                || (current === undefined && this.hasMore) !== dependency.windowGap)
                return false;
        }
        return true;
    }
    replaceDependencies(context, dependencies) {
        for (const dependency of context.dependencies.values()) {
            if (dependency.key === undefined)
                continue;
            const current = this.dependents.get(dependency.key);
            current?.delete(context);
            if (current?.size === 0)
                this.dependents.delete(dependency.key);
        }
        context.dependencies = dependencies;
        for (const dependency of dependencies.values()) {
            if (dependency.key === undefined)
                continue;
            const current = this.dependents.get(dependency.key) ?? new Set();
            current.add(context);
            this.dependents.set(dependency.key, current);
        }
    }
    replayRevisedDependents() {
        const pending = [...this.revised];
        const affected = new Set();
        for (let index = 0; index < pending.length; index++) {
            const dependency = pending[index];
            if (dependency === undefined)
                continue;
            for (const dependent of this.dependents.get(dependency.key) ?? []) {
                if (affected.has(dependent))
                    continue;
                affected.add(dependent);
                pending.push(dependent);
            }
        }
        this.replayContexts(affected);
        return affected.size > 0;
    }
    readerFor(beforeSeq, dependencies) {
        return {
            previous: (kind) => {
                const predecessor = this.previousContext(kind, beforeSeq);
                dependencies.set(kind, {
                    kind,
                    key: predecessor?.key,
                    revision: predecessor?.revision,
                    windowGap: predecessor === undefined && this.hasMore,
                });
                if (predecessor?.state === undefined)
                    return undefined;
                const seq = startSeq(predecessor);
                if (seq === undefined)
                    return undefined;
                return {
                    key: predecessor.key,
                    kind: predecessor.kind,
                    id: predecessor.id,
                    startSeq: seq,
                    state: predecessor.state,
                    matches: predecessor.matches,
                };
            },
        };
    }
    previousContext(kind, beforeSeq) {
        const candidates = this.contextsByKind.get(kind) ?? [];
        const indexBefore = insertionIndex(candidates, beforeSeq);
        for (let index = indexBefore - 1; index >= 0; index--) {
            const candidate = candidates[index];
            if (candidate?.state !== undefined)
                return candidate;
        }
        return undefined;
    }
    /** Insert one newly discovered start into its Definition's ordered predecessor index. */
    indexStartedContext(context) {
        const seq = context.startSeq;
        if (seq === undefined)
            return;
        const candidates = this.contextsByKind.get(context.kind) ?? [];
        const previous = candidates.at(-1);
        if (previous === undefined || previous.startSeq !== undefined && previous.startSeq < seq)
            candidates.push(context);
        else
            candidates.splice(insertionIndex(candidates, seq), 0, context);
        this.contextsByKind.set(context.kind, candidates);
    }
    indexStartedContexts(kind, additions) {
        if (additions.length === 0)
            return;
        const sorted = [...additions].sort((left, right) => requireStartSeq(left) - requireStartSeq(right));
        const existing = this.contextsByKind.get(kind) ?? [];
        const merged = [];
        let before = 0;
        let added = 0;
        while (before < existing.length || added < sorted.length) {
            const left = existing[before];
            const right = sorted[added];
            if (right === undefined || (left !== undefined && requireStartSeq(left) < requireStartSeq(right))) {
                if (left === undefined)
                    break;
                merged.push(left);
                before++;
            }
            else {
                merged.push(right);
                added++;
            }
        }
        this.contextsByKind.set(kind, merged);
    }
    replayDependencies() {
        let replayed = false;
        const ordered = [...this.contexts.values()]
            .filter(context => startSeq(context) !== undefined)
            .sort((left, right) => requireStartSeq(left) - requireStartSeq(right));
        for (const context of ordered) {
            if (context.state === undefined || context.dependencies.size === 0)
                continue;
            const before = startSeq(context);
            if (before === undefined)
                continue;
            let changed = false;
            for (const dependency of context.dependencies.values()) {
                const current = this.previousContext(dependency.kind, before);
                const windowGap = current === undefined && this.hasMore;
                if (current?.key !== dependency.key
                    || current?.revision !== dependency.revision
                    || windowGap !== dependency.windowGap) {
                    changed = true;
                    break;
                }
            }
            if (changed) {
                this.replayContext(context);
                replayed = true;
            }
        }
        return replayed;
    }
    refreshMatchLocations(changedSeqs) {
        const affected = new Set();
        this.reusableLocations.clear();
        if (changedSeqs.size === 0)
            return affected;
        for (const seq of changedSeqs) {
            for (const context of this.contextsBySeq.get(seq) ?? [])
                affected.add(context);
        }
        for (const context of affected) {
            let start = context.start;
            let coordinatesUnchanged = true;
            const matches = context.matches.map((match) => {
                if (!changedSeqs.has(match.event.seq))
                    return match;
                const refreshed = { ...match, location: this.locationIndex.locationOf(match.event) };
                const before = match.location, after = refreshed.location;
                if (before.kind !== after.kind
                    || ((before.kind === 'turn' || before.kind === 'step') && (after.kind === 'turn' || after.kind === 'step') && before.turn.turn !== after.turn.turn)
                    || (before.kind === 'step' && after.kind === 'step' && before.step.step !== after.step.step))
                    coordinatesUnchanged = false;
                if (match === start)
                    start = refreshed;
                return refreshed;
            });
            if (context.definition.locationReuse === 'events' && coordinatesUnchanged)
                this.reusableLocations.add(context);
            if (this.reusableLocations.has(context) && (0, value_guards_1.isRecord)(context.state)) {
                const rebound = new Map();
                context.matches.forEach((prior, index) => {
                    const next = matches[index];
                    if (next !== undefined && next !== prior)
                        rebound.set(prior, next);
                });
                const changes = {};
                for (const [key, value] of Object.entries(context.state)) {
                    const next = rebound.get(value);
                    if (next !== undefined)
                        changes[key] = next;
                }
                if (Object.keys(changes).length > 0)
                    context.state = { ...context.state, ...changes };
            }
            context.matches = matches;
            context.start = start;
        }
        return affected;
    }
    buildNode(context, target) {
        const cached = this.historyReuse?.reused.get(context.key);
        if (cached !== undefined && context.state === cached.state) {
            const node = cached.old.current.get(target) ?? null;
            if (node === null)
                return null;
            const location = context.start?.location ?? context.matches[0]?.location;
            if (!('location' in node) || node.location === undefined || location === undefined || location === node.location)
                return node;
            const rebound = { ...node, location };
            return rebound;
        }
        if (context.definition.target !== target || context.definition.buildViewNode === undefined)
            return null;
        const node = context.definition.buildViewNode(contextSnapshot(context));
        if (node === null)
            return null;
        if (node.key !== context.key) {
            throw new Error(`conversation Definition "${context.kind}" returned unstable key "${node.key}"; expected "${context.key}"`);
        }
        if (node.target !== target) {
            throw new Error(`conversation Definition "${context.kind}" returned target "${node.target}" while building "${target}"`);
        }
        return node;
    }
    buildLocationData(context, scope) {
        const cached = this.historyReuse?.reused.get(context.key);
        if (cached !== undefined && context.state === cached.state)
            return cached.old.locationData[scope];
        if (context.definition.buildLocationData === undefined)
            return null;
        const data = context.definition.buildLocationData(contextSnapshot(context), scope);
        if (data === null)
            return null;
        if (data.kind !== scope) {
            throw new Error(`conversation Definition "${context.kind}" published ${data.kind} data through its ${scope} scope`);
        }
        if (data.key !== context.kind) {
            throw new Error(`conversation Definition "${context.kind}" published Location data key "${data.key}"; expected its owned kind`);
        }
        if (!Number.isSafeInteger(data.turn) || data.turn < 0) {
            throw new Error(`conversation Definition "${context.kind}" published invalid turn ${data.turn}`);
        }
        if (data.kind === 'step' && (typeof data.step !== 'number' || !Number.isSafeInteger(data.step) || data.step < 0)) {
            throw new Error(`conversation Definition "${context.kind}" published invalid step ${String(data.step)}`);
        }
        return data;
    }
    replaceLocationData() {
        const entries = [];
        for (const scope of LOCATION_DATA_SCOPES) {
            for (const context of this.contexts.values()) {
                const data = this.buildLocationData(context, scope);
                context.locationData[scope] = data;
                if (data !== null)
                    entries.push({ owner: context.key, data });
            }
            // Turn publishers may read Step data from this same flush, so each phase
            // installs the cumulative replacement before the next phase builds.
            this.locationIndex.replaceData(entries);
        }
    }
    applyDirtyLocationData() {
        let changed = false;
        for (const scope of LOCATION_DATA_SCOPES) {
            const changes = [];
            for (const context of this.dirty) {
                const previous = context.locationData[scope];
                const next = this.buildLocationData(context, scope);
                context.locationData[scope] = next;
                if (previous !== next)
                    changes.push({ owner: context.key, previous, next });
            }
            changed = this.locationIndex.applyData(changes) || changed;
        }
        return changed;
    }
    resetViewBuilders() {
        this.views.clear();
        for (const definition of this.viewDefinitions.entries()) {
            const builder = definition.create();
            this.views.set(definition.target, {
                target: definition.target,
                builder,
                snapshot: builder.empty,
            });
        }
        this.replacePending = true;
    }
}
exports.ConversationNodeAssembler = ConversationNodeAssembler;
function isLocationBoundary(type) {
    return type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end';
}
function requireState(definition, phase, state) {
    if (state === undefined) {
        throw new Error(`conversation Definition "${definition.kind}" returned undefined from ${phase}()`);
    }
    return state;
}
function requireStartSeq(context) {
    if (context.startSeq === undefined)
        throw new Error(`conversation Context ${context.key} has no start seq`);
    return context.startSeq;
}
/** Immutable boundary equality is memoized once per pair, not per streaming Match. */
function equalBoundary(left, right, pairs) {
    if (left === right)
        return true;
    if (left.kind !== right.kind)
        return false;
    if (left.kind === 'session' || left.kind === 'unresolved')
        return true;
    if (right.kind === 'session' || right.kind === 'unresolved')
        return false;
    if ((left.kind === 'step' ? left.step.step : undefined) !== (right.kind === 'step' ? right.step.step : undefined))
        return false;
    const a = left.turn, b = right.turn;
    if (a === b)
        return true;
    let compared = pairs.get(a);
    if (compared === undefined) {
        compared = new WeakMap();
        pairs.set(a, compared);
    }
    const cached = compared.get(b);
    if (cached !== undefined)
        return cached;
    const equal = a.turn === b.turn && a.status === b.status && a.start === b.start && a.end === b.end
        && a.steps.length === b.steps.length && a.steps.every((step, index) => {
        const other = b.steps[index];
        return other !== undefined && step.step === other.step && step.status === other.status && step.start === other.start && step.end === other.end;
    });
    compared.set(b, equal);
    return equal;
}

},
"src/modules/client-runtime/contract/conversation.js": function(module, exports, require) {
// source: src/modules/client-runtime/contract/conversation.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversationContextKey = conversationContextKey;
/**
 * Build a stable collision-free key for one Definition-local business identity.
 * @param kind - Definition kind.
 * @param id - Definition-local business identity.
 * @returns engine-owned Context key.
 */
function conversationContextKey(kind, id) {
    return `${kind.length}:${kind}${id}`;
}

},
"src/modules/client-runtime/sessions/conversation-location-index.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/conversation-location-index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationLocationIndex = void 0;
const value_guards_1 = require("../value-guards");
class MutableLocationDataStore {
    constructor() {
        this.entries = new Map();
    }
    get(key) {
        return this.entries.get(key)?.value;
    }
    remove(owner, key) {
        const current = this.entries.get(key);
        if (current?.owner !== owner)
            return false;
        this.entries.delete(key);
        return true;
    }
    set(owner, key, value) {
        const current = this.entries.get(key);
        if (current !== undefined && current.owner !== owner) {
            throw new Error(`conversation Location data "${key}" is already owned by ${current.owner}`);
        }
        if (current?.value === value)
            return false;
        this.entries.set(key, { owner, value });
        return true;
    }
    replace(entries) {
        let changed = this.entries.size !== entries.size;
        if (!changed) {
            for (const [key, value] of entries) {
                const current = this.entries.get(key);
                if (current?.owner !== value.owner || current.value !== value.value) {
                    changed = true;
                    break;
                }
            }
        }
        if (changed)
            this.entries = new Map(entries);
        return changed;
    }
}
const SESSION_LOCATION = { kind: 'session' };
const UNRESOLVED_LOCATION = { kind: 'unresolved' };
function payloadCoordinates(event) {
    const data = event.data;
    if (!(0, value_guards_1.isRecord)(data))
        return {};
    if (data.turn === null)
        return { session: true };
    const turn = typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0
        ? data.turn : undefined;
    const step = typeof data.step === 'number' && Number.isSafeInteger(data.step) && data.step >= 0
        ? data.step : undefined;
    return { ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } };
}
function sameReferences(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameStep(left, right) {
    return left !== undefined
        && left.start === right.start && left.end === right.end && left.status === right.status
        && left.data === right.data;
}
function sameTurn(left, right) {
    return left !== undefined
        && left.start === right.start && left.end === right.end && left.status === right.status
        && left.data === right.data && sameReferences(left.steps, right.steps);
}
function sameLocation(left, right) {
    if (left === undefined || right === undefined || left.kind !== right.kind)
        return left === right;
    if (left.kind === 'session' || left.kind === 'unresolved')
        return true;
    if (right.kind === 'session' || right.kind === 'unresolved')
        return false;
    if (left.kind === 'turn' || right.kind === 'turn') {
        return left.kind === 'turn' && right.kind === 'turn' && left.turn === right.turn;
    }
    return left.turn === right.turn && left.step === right.step;
}
/** Session-owned Turn/Step timeline and event-to-Location index. */
class ConversationLocationIndex {
    constructor() {
        this.coordinates = new Map();
        this.locations = new Map();
        this.seqsByTurn = new Map();
        this.timeline = { turnOrder: [], turns: new Map() };
        this.turnDataStores = new Map();
        this.stepDataStores = new Map();
    }
    /**
     * Return the current reference-stable timeline.
     * @returns current timeline snapshot.
     */
    snapshot() {
        return this.timeline;
    }
    /**
     * Replace all Definition-owned Location values while preserving reader identities.
     * @param entries - complete current set of Definition-owned Location values.
     * @returns whether any published Location data changed.
     */
    replaceData(entries) {
        const turns = new Map();
        const steps = new Map();
        for (const { owner, data } of entries) {
            const values = data.kind === 'turn'
                ? turns.get(data.turn) ?? new Map()
                : steps.get(stepDataKey(data.turn, requireStep(data))) ?? new Map();
            const current = values.get(data.key);
            if (current !== undefined && current.owner !== owner) {
                throw new Error(`conversation Location data "${data.key}" is already owned by ${current.owner}`);
            }
            values.set(data.key, { owner, value: data.value });
            if (data.kind === 'turn')
                turns.set(data.turn, values);
            else
                steps.set(stepDataKey(data.turn, requireStep(data)), values);
        }
        let changed = false;
        for (const turn of new Set([...this.turnDataStores.keys(), ...turns.keys()])) {
            changed = this.mutableTurnData(turn).replace(turns.get(turn) ?? new Map()) || changed;
        }
        for (const step of new Set([...this.stepDataStores.keys(), ...steps.keys()])) {
            changed = this.mutableStepData(step).replace(steps.get(step) ?? new Map()) || changed;
        }
        return changed;
    }
    /**
     * Apply changed Context publications without rebuilding Turn/Step membership.
     * @param changes - incremental removals and replacements from published Contexts.
     * @returns whether any published Location data changed.
     */
    applyData(changes) {
        let changed = false;
        for (const change of changes) {
            const previous = change.previous;
            if (previous === null)
                continue;
            changed = this.storeFor(previous).remove(change.owner, previous.key) || changed;
        }
        for (const change of changes) {
            const next = change.next;
            if (next === null)
                continue;
            changed = this.storeFor(next).set(change.owner, next.key, next.value) || changed;
        }
        return changed;
    }
    /**
     * Resolve the latest Location for one event.
     * @param event - event already ingested into this index.
     * @returns current Location, falling back to session when it has no Turn/Step affinity.
     */
    locationOf(event) {
        return this.locations.get(event.seq) ?? SESSION_LOCATION;
    }
    /**
     * Rebuild timeline facts after replace/prepend or a boundary append.
     * @param entries - complete current window in ascending seq order.
     * @returns seqs whose resolved Location changed.
     */
    rebuild(entries) {
        const previousLocations = this.locations;
        const turns = new Map();
        const coordinates = new Map();
        let currentTurn;
        let currentStep;
        const turnDraft = (turn, seq) => {
            let draft = turns.get(turn);
            if (draft === undefined) {
                draft = { turn, firstSeq: seq, steps: new Map() };
                turns.set(turn, draft);
            }
            else {
                draft.firstSeq = Math.min(draft.firstSeq, seq);
            }
            return draft;
        };
        const stepDraft = (turn, step, seq) => {
            const owner = turnDraft(turn, seq);
            let draft = owner.steps.get(step);
            if (draft === undefined) {
                draft = { turn, step, firstSeq: seq };
                owner.steps.set(step, draft);
            }
            else {
                draft.firstSeq = Math.min(draft.firstSeq, seq);
            }
            return draft;
        };
        for (const { event } of entries) {
            const explicit = payloadCoordinates(event);
            if (isTurnBoundary(event, 'turn/start')) {
                currentTurn = event.data.turn;
                currentStep = undefined;
            }
            if (isStepBoundary(event, 'step/start')) {
                currentTurn = event.data.turn;
                currentStep = event.data.step;
            }
            if (explicit.session !== true && explicit.turn !== undefined) {
                if (currentTurn !== explicit.turn)
                    currentStep = undefined;
                currentTurn = explicit.turn;
                if (explicit.step !== undefined)
                    currentStep = explicit.step;
            }
            const turn = explicit.session === true ? undefined : explicit.turn ?? currentTurn;
            const step = explicit.session === true || isTurnBoundary(event, 'turn/start') || isTurnBoundary(event, 'turn/end')
                ? undefined
                : explicit.step ?? (turn === currentTurn ? currentStep : undefined);
            coordinates.set(event.seq, {
                ...turn === undefined ? {} : { turn },
                ...turn === undefined || step === undefined ? {} : { step },
            });
            if (turn !== undefined)
                turnDraft(turn, event.seq);
            if (turn !== undefined && step !== undefined)
                stepDraft(turn, step, event.seq);
            if (isTurnBoundary(event, 'turn/start')) {
                turnDraft(event.data.turn, event.seq).start = event;
            }
            else if (isTurnBoundary(event, 'turn/end')) {
                turnDraft(event.data.turn, event.seq).end = event;
            }
            else if (isStepBoundary(event, 'step/start')) {
                stepDraft(event.data.turn, event.data.step, event.seq).start = event;
            }
            else if (isStepBoundary(event, 'step/end')) {
                stepDraft(event.data.turn, event.data.step, event.seq).end = event;
            }
            if (isStepBoundary(event, 'step/end') && currentTurn === event.data.turn && currentStep === event.data.step) {
                currentStep = undefined;
            }
            if (isTurnBoundary(event, 'turn/end') && currentTurn === event.data.turn) {
                currentTurn = undefined;
                currentStep = undefined;
            }
        }
        const previousTurns = this.timeline.turns;
        const nextTurns = new Map();
        const orderedDrafts = [...turns.values()].sort((left, right) => left.firstSeq - right.firstSeq);
        for (const draft of orderedDrafts) {
            const previousTurn = previousTurns.get(draft.turn);
            const previousSteps = new Map(previousTurn?.steps.map(step => [step.step, step]) ?? []);
            const steps = [...draft.steps.values()]
                .sort((left, right) => left.firstSeq - right.firstSeq)
                .map((candidate) => {
                const value = {
                    turn: candidate.turn,
                    step: candidate.step,
                    start: candidate.start,
                    end: candidate.end,
                    status: candidate.end !== undefined
                        ? 'closed'
                        : candidate.start === undefined ? 'unknown' : 'open',
                    data: this.stepData(candidate.turn, candidate.step),
                };
                const previous = previousSteps.get(candidate.step);
                return previous !== undefined && sameStep(previous, value) ? previous : value;
            });
            const value = {
                turn: draft.turn,
                start: draft.start,
                end: draft.end,
                status: draft.end !== undefined ? 'closed' : draft.start === undefined ? 'unknown' : 'open',
                steps,
                data: this.turnData(draft.turn),
            };
            nextTurns.set(draft.turn, previousTurn !== undefined && sameTurn(previousTurn, value) ? previousTurn : value);
        }
        const nextOrder = orderedDrafts.map(draft => draft.turn);
        const turnOrder = this.timeline.turnOrder.length === nextOrder.length
            && this.timeline.turnOrder.every((turn, index) => turn === nextOrder[index])
            ? this.timeline.turnOrder
            : nextOrder;
        let sameMap = previousTurns.size === nextTurns.size;
        if (sameMap) {
            for (const [turn, value] of nextTurns) {
                if (previousTurns.get(turn) !== value) {
                    sameMap = false;
                    break;
                }
            }
        }
        this.timeline = sameMap && turnOrder === this.timeline.turnOrder
            ? this.timeline
            : { turnOrder, turns: nextTurns };
        this.coordinates = coordinates;
        this.locations = new Map();
        this.seqsByTurn = new Map();
        for (const { event } of entries) {
            const coordinates = this.coordinates.get(event.seq);
            if (coordinates?.turn !== undefined)
                this.indexTurnSeq(coordinates.turn, event.seq);
            this.locations.set(event.seq, this.resolve(event.seq));
        }
        this.currentTurn = currentTurn;
        this.currentStep = currentStep;
        const changed = new Set();
        for (const { event } of entries) {
            if (!sameLocation(previousLocations.get(event.seq), this.locations.get(event.seq))) {
                changed.add(event.seq);
            }
        }
        return changed;
    }
    /**
     * Append one Turn/Step boundary while revisiting only the owning Turn.
     * @param event - contiguous tail boundary event.
     * @returns seqs whose immutable Location reference changed.
     */
    appendBoundary(event) {
        if (event.type !== 'turn/start' && event.type !== 'turn/end'
            && event.type !== 'step/start' && event.type !== 'step/end') {
            throw new Error(`conversation Location boundary expected, received ${event.type}`);
        }
        if (!isTurnBoundary(event, 'turn/start') && !isTurnBoundary(event, 'turn/end')
            && !isStepBoundary(event, 'step/start') && !isStepBoundary(event, 'step/end')) {
            this.appendNonBoundary(event);
            return new Set();
        }
        const explicit = payloadCoordinates(event);
        if (isTurnBoundary(event, 'turn/start')) {
            this.currentTurn = event.data.turn;
            this.currentStep = undefined;
        }
        else if (isStepBoundary(event, 'step/start')) {
            this.currentTurn = event.data.turn;
            this.currentStep = event.data.step;
        }
        if (explicit.turn !== undefined) {
            if (this.currentTurn !== explicit.turn)
                this.currentStep = undefined;
            this.currentTurn = explicit.turn;
            if (explicit.step !== undefined)
                this.currentStep = explicit.step;
        }
        const turnNumber = explicit.turn ?? this.currentTurn;
        if (turnNumber === undefined)
            throw new Error(`conversation boundary ${event.type} has no turn`);
        const stepNumber = isTurnBoundary(event, 'turn/start') || isTurnBoundary(event, 'turn/end')
            ? undefined
            : explicit.step ?? (turnNumber === this.currentTurn ? this.currentStep : undefined);
        this.coordinates.set(event.seq, {
            turn: turnNumber,
            ...stepNumber === undefined ? {} : { step: stepNumber },
        });
        this.indexTurnSeq(turnNumber, event.seq);
        const previousTurn = this.timeline.turns.get(turnNumber);
        let steps = previousTurn?.steps ?? [];
        if (isStepBoundary(event, 'step/start') || isStepBoundary(event, 'step/end')) {
            const number = event.data.step;
            const previousStep = steps.find(candidate => candidate.step === number);
            const candidate = {
                turn: turnNumber,
                step: number,
                start: isStepBoundary(event, 'step/start') ? event : previousStep?.start,
                end: isStepBoundary(event, 'step/end') ? event : previousStep?.end,
                status: isStepBoundary(event, 'step/end') || previousStep?.end !== undefined ? 'closed' : 'open',
                data: this.stepData(turnNumber, number),
            };
            const nextStep = previousStep !== undefined && sameStep(previousStep, candidate) ? previousStep : candidate;
            const index = steps.findIndex(step => step.step === number);
            steps = index < 0
                ? [...steps, nextStep]
                : steps.map((step, at) => at === index ? nextStep : step);
        }
        const candidate = {
            turn: turnNumber,
            start: isTurnBoundary(event, 'turn/start') ? event : previousTurn?.start,
            end: isTurnBoundary(event, 'turn/end') ? event : previousTurn?.end,
            status: isTurnBoundary(event, 'turn/end') || previousTurn?.end !== undefined
                ? 'closed'
                : isTurnBoundary(event, 'turn/start') || previousTurn?.start !== undefined ? 'open' : 'unknown',
            steps,
            data: this.turnData(turnNumber),
        };
        const turn = previousTurn !== undefined && sameTurn(previousTurn, candidate) ? previousTurn : candidate;
        const turns = new Map(this.timeline.turns);
        turns.set(turnNumber, turn);
        const turnOrder = previousTurn === undefined
            ? [...this.timeline.turnOrder, turnNumber]
            : this.timeline.turnOrder;
        this.timeline = { turnOrder, turns };
        const changed = new Set();
        for (const seq of this.seqsByTurn.get(turnNumber) ?? []) {
            const previous = this.locations.get(seq);
            const next = this.resolve(seq);
            this.locations.set(seq, next);
            if (!sameLocation(previous, next))
                changed.add(seq);
        }
        if (isStepBoundary(event, 'step/end') && this.currentTurn === event.data.turn && this.currentStep === event.data.step) {
            this.currentStep = undefined;
        }
        if (isTurnBoundary(event, 'turn/end') && this.currentTurn === event.data.turn) {
            this.currentTurn = undefined;
            this.currentStep = undefined;
        }
        return changed;
    }
    /**
     * Index one non-boundary tail event without rescanning the window.
     * @param event - contiguous appended event.
     */
    appendNonBoundary(event) {
        const explicit = payloadCoordinates(event);
        if (explicit.session === true) {
            this.coordinates.set(event.seq, {});
            this.locations.set(event.seq, SESSION_LOCATION);
            return;
        }
        if (explicit.turn !== undefined) {
            if (this.currentTurn !== explicit.turn)
                this.currentStep = undefined;
            this.currentTurn = explicit.turn;
            if (explicit.step !== undefined)
                this.currentStep = explicit.step;
        }
        const turn = explicit.turn ?? this.currentTurn;
        const step = explicit.step ?? (turn === this.currentTurn ? this.currentStep : undefined);
        this.coordinates.set(event.seq, {
            ...turn === undefined ? {} : { turn },
            ...turn === undefined || step === undefined ? {} : { step },
        });
        if (turn !== undefined)
            this.indexTurnSeq(turn, event.seq);
        this.locations.set(event.seq, this.resolve(event.seq));
    }
    indexTurnSeq(turn, seq) {
        const current = this.seqsByTurn.get(turn) ?? new Set();
        current.add(seq);
        this.seqsByTurn.set(turn, current);
    }
    turnData(turn) {
        return this.mutableTurnData(turn);
    }
    stepData(turn, step) {
        return this.mutableStepData(stepDataKey(turn, step));
    }
    mutableTurnData(turn) {
        const current = this.turnDataStores.get(turn) ?? new MutableLocationDataStore();
        this.turnDataStores.set(turn, current);
        return current;
    }
    mutableStepData(key) {
        const current = this.stepDataStores.get(key) ?? new MutableLocationDataStore();
        this.stepDataStores.set(key, current);
        return current;
    }
    storeFor(data) {
        return data.kind === 'turn'
            ? this.mutableTurnData(data.turn)
            : this.mutableStepData(stepDataKey(data.turn, requireStep(data)));
    }
    resolve(seq) {
        const coordinates = this.coordinates.get(seq);
        if (coordinates?.turn === undefined)
            return SESSION_LOCATION;
        const turn = this.timeline.turns.get(coordinates.turn);
        if (turn === undefined)
            return UNRESOLVED_LOCATION;
        if (coordinates.step === undefined)
            return { kind: 'turn', turn };
        const step = turn.steps.find(candidate => candidate.step === coordinates.step);
        return step === undefined ? { kind: 'turn', turn } : { kind: 'step', turn, step };
    }
}
exports.ConversationLocationIndex = ConversationLocationIndex;
function stepDataKey(turn, step) {
    return `${turn}:${step}`;
}
function requireStep(data) {
    if (data.kind === 'step' && data.step !== undefined)
        return data.step;
    throw new Error(`conversation Step data "${data.key}" requires a step`);
}
function isTurnBoundary(event, type) {
    return event.type === type && (0, value_guards_1.isRecord)(event.data) && typeof event.data.turn === 'number'
        && Number.isSafeInteger(event.data.turn) && event.data.turn >= 0;
}
function isStepBoundary(event, type) {
    return event.type === type && (0, value_guards_1.isRecord)(event.data) && typeof event.data.turn === 'number'
        && Number.isSafeInteger(event.data.turn) && event.data.turn >= 0
        && typeof event.data.step === 'number' && Number.isSafeInteger(event.data.step) && event.data.step >= 0;
}

},
"src/modules/client-runtime/sessions/pending.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/pending.ts

"use strict";
// PendingWait: the carrier-protocol half of a pending host interaction. The runtime owns only
// envelope knowledge (rpcId backfill into a client-response); domain result encoding belongs to
// the interaction's consumer package.
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PendingWait_settled, _PendingWait_rpcId, _PendingWait_respond;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingWait = void 0;
/** Key prefixes, one per kind (the key doubles as the Session pending-map key). */
const KEY_PREFIX = { approval: 'a', question: 'q' };
/**
 * One pending host-owned interaction wait: an immutable render face
 * (kind/key/sessionId/payload) plus the response carrier. respond() backfills
 * the requested frame's rpcId into a client-response envelope — no consumer
 * ever sees the raw rpcId. Settlement is expressed only by pending-list
 * membership (the settled flag is a fail-loud guard, not a render input).
 */
class PendingWait {
    /**
     * Minted by Session on a requested frame (public construction is the test-fixture path).
     * @param kind - interaction kind.
     * @param rpcId - the requested frame's stable envelope id (kept private; respond echoes it).
     * @param sessionId - owning session.
     * @param payload - the requested frame's domain fields.
     * @param respond - the client-response carrier (api.respond).
     */
    constructor(kind, rpcId, sessionId, payload, respond) {
        _PendingWait_settled.set(this, false);
        _PendingWait_rpcId.set(this, void 0);
        _PendingWait_respond.set(this, void 0);
        this.kind = kind;
        this.key = `${KEY_PREFIX[kind]}:${rpcId}`;
        this.sessionId = sessionId;
        this.payload = payload;
        __classPrivateFieldSet(this, _PendingWait_rpcId, rpcId, "f");
        __classPrivateFieldSet(this, _PendingWait_respond, respond, "f");
    }
    /**
     * Send a result for this wait: wraps it into the client-response envelope
     * with the rpcId backfilled. Throws synchronously once settled.
     * @param result - the result shell (ok value / error envelope), domain-encoded by the caller.
     * @returns the carrier receipt.
     */
    respond(result) {
        if (__classPrivateFieldGet(this, _PendingWait_settled, "f"))
            throw new Error(`pending wait ${this.key} is already settled`);
        return __classPrivateFieldGet(this, _PendingWait_respond, "f").call(this, { type: 'client-response', rpcId: __classPrivateFieldGet(this, _PendingWait_rpcId, "f"), result });
    }
    /** Session-only settlement mark (the authoritative resolved frame arrived); respond() throws afterwards. */
    markSettled() {
        __classPrivateFieldSet(this, _PendingWait_settled, true, "f");
    }
}
exports.PendingWait = PendingWait;
_PendingWait_settled = new WeakMap(), _PendingWait_rpcId = new WeakMap(), _PendingWait_respond = new WeakMap();

},
"src/modules/client-runtime/time-zone.js": function(module, exports, require) {
// source: src/modules/client-runtime/time-zone.ts

"use strict";
/** Browser-owned time-zone sampling for prompt RPC provenance. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvedClientTimeZone = resolvedClientTimeZone;
/**
 * Resolve the current browser IANA zone for one outbound operation.
 * @returns The browser-provided canonical zone.
 * @throws when the runtime cannot provide a non-empty zone.
 */
function resolvedClientTimeZone() {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timeZone !== 'string' || timeZone.length === 0) {
        throw new Error('browser time zone is unavailable');
    }
    return timeZone;
}

},
"src/modules/client-runtime/sessions/queue-mirror.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/queue-mirror.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionQueueMirror = void 0;
const value_guards_1 = require("../value-guards");
const QUEUE_PREVIEW_CHARS = 200;
function previewOf(content) {
    const flat = content
        .map(block => (block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : `[${block.type}]`))
        .join(' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat;
}
function textOf(content) {
    if (!content.every(block => block.type === 'text'))
        return null;
    return content.map(block => 'text' in block && typeof block.text === 'string' ? block.text : '').join('');
}
/** Authoritative transient queue projection and durable steering handoff. */
class SessionQueueMirror {
    constructor() {
        this.current = [];
    }
    /**
     * Return the current immutable queue projection.
     * @returns current queue rows.
     */
    snapshot() {
        return this.current;
    }
    /**
     * Drop the stale generation before its replacement queue baseline arrives.
     * @returns whether any projected queue row was removed.
     */
    reset() {
        if (this.current.length === 0)
            return false;
        this.current = [];
        return true;
    }
    /**
     * Replace from one authoritative stream queue frame.
     * @param items - complete host queue snapshot.
     * @param events - current durable history window, including already consumed inputs.
     */
    replace(items, events = []) {
        // A durable event can arrive before a queue snapshot (or before reconnect
        // history). Consult retained history instead of keeping unbounded tombstones.
        const consumed = new Set();
        const candidates = new Set(items.filter(item => item.placement === 'steering').map(item => item.message.id));
        if (candidates.size > 0) {
            for (const event of events) {
                if (event.type === 'user/message' && (0, value_guards_1.isRecord)(event.data)
                    && typeof event.data.id === 'string' && candidates.has(event.data.id)) {
                    consumed.add(event.data.id);
                }
            }
        }
        this.current = items.filter(item => item.placement !== 'steering' || !consumed.has(item.message.id)).map(item => ({
            id: item.id,
            messageId: item.message.id,
            placement: item.placement,
            content: item.message.content,
            preview: previewOf(item.message.content),
            text: textOf(item.message.content),
        }));
    }
    /**
     * Retire a transient steering row once its durable message enters the log.
     * @param event - newly contiguous durable Session event.
     * @returns whether the projection changed.
     */
    acceptDurable(event) {
        if (event.type !== 'user/message' || !(0, value_guards_1.isRecord)(event.data) || typeof event.data.id !== 'string')
            return false;
        const messageId = event.data.id;
        const index = this.current.findIndex(item => item.placement === 'steering' && item.messageId === messageId);
        if (index < 0)
            return false;
        this.current = this.current.filter((_item, candidate) => candidate !== index);
        return true;
    }
}
exports.SessionQueueMirror = SessionQueueMirror;

},
"src/modules/client-runtime/sessions/active-working-set.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/active-working-set.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVE_WINDOW = void 0;
exports.payloadWeight = payloadWeight;
exports.activeWindowCut = activeWindowCut;
const value_guards_1 = require("../value-guards");
/** UI-only residency policy. Durable history and model context are untouched. */
exports.ACTIVE_WINDOW = Object.freeze({
    highEvents: 4096, lowEvents: 2048,
    highBytes: 8 * 1024 * 1024, lowBytes: 4 * 1024 * 1024,
});
/** Conservative retained-payload weight, computed once per accepted entry. */
function payloadWeight(value) {
    let bytes = 0;
    const stack = [value], seen = new WeakSet();
    while (stack.length && bytes <= exports.ACTIVE_WINDOW.highBytes) {
        const item = stack.pop();
        if (typeof item === 'string')
            bytes += 24 + item.length * 2;
        else if ((0, value_guards_1.isRecord)(item)) {
            if (seen.has(item))
                continue;
            seen.add(item);
            bytes += 64;
            for (const key of Object.keys(item)) {
                bytes += 16 + key.length * 2;
                stack.push(item[key]);
            }
        }
        else
            bytes += 8;
    }
    return bytes;
}
/** Drop only complete prefixes at a recorded turn start; never cut a live turn.
 * A giant current turn or an explicit reader pin is intentionally a soft limit. */
function activeWindowCut(events, weights, bytes) {
    if (events.length <= exports.ACTIVE_WINDOW.highEvents && bytes <= exports.ACTIVE_WINDOW.highBytes)
        return 0;
    let removed = 0, cut = 0, closedAt = 0;
    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        if (index > 0 && event?.type === 'turn/start' && closedAt > 0) {
            cut = closedAt;
            if (events.length - index <= exports.ACTIVE_WINDOW.lowEvents && bytes - removed <= exports.ACTIVE_WINDOW.lowBytes)
                return cut;
        }
        if (event?.type === 'turn/start')
            closedAt = 0;
        if (event?.type === 'turn/end')
            closedAt = index + 1;
        removed += weights[index] ?? 0;
    }
    return cut;
}

},
"src/modules/client-runtime/sessions/cooperative-delivery.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/cooperative-delivery.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CooperativeDelivery = void 0;
/** Yield event reduction to input/paint tasks without reordering durable events.
 * Control frames and mutation RPCs never wait behind this FIFO. */
class CooperativeDelivery {
    constructor(deliver, failure, now = () => globalThis.performance?.now() ?? Date.now()) {
        this.deliver = deliver;
        this.failure = failure;
        this.now = now;
        this.pending = [];
        this.bytes = 0;
        this.epoch = 0;
        this.spent = 0;
    }
    push(value, bytes) {
        const now = this.now();
        // Reset only after a real task boundary, not merely after wall-clock
        // time: a stream of microtasks (including snapshot flushes) can otherwise
        // starve input forever while repeatedly appearing to be an idle producer.
        if (this.reset === undefined) {
            this.epoch = now;
            this.spent = 0;
            this.reset = setTimeout(() => { this.reset = undefined; }, 0);
        }
        if (this.timer === undefined && this.spent < 4 && now - this.epoch < 4) {
            const started = this.now();
            this.deliverSafely(value);
            this.spent += this.now() - started;
            return;
        }
        if (this.pending.length >= 512 || this.bytes + bytes > 8 * 1024 * 1024) {
            this.clear();
            this.failure();
            return;
        }
        this.pending.push({ value, bytes });
        this.bytes += bytes;
        if (this.timer === undefined)
            this.timer = setTimeout(() => this.drain(), 0);
    }
    clear() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        if (this.reset !== undefined)
            clearTimeout(this.reset);
        this.reset = undefined;
        this.timer = undefined;
        this.pending = [];
        this.bytes = 0;
        this.spent = 0;
    }
    deliverSafely(value) {
        try {
            this.deliver(value);
            return true;
        }
        catch (error) {
            // Deferred callbacks no longer have the transport reader's catch scope.
            // Never leave a dead timer/FIFO that silently blocks future deliveries.
            this.clear();
            this.failure(error);
            return false;
        }
    }
    drain() {
        const started = this.now();
        do {
            const item = this.pending[0];
            if (item === undefined)
                break;
            // Release references as they drain, not only when the producer goes idle.
            this.pending.shift();
            this.bytes -= item.bytes;
            if (!this.deliverSafely(item.value))
                return;
        } while (this.pending.length > 0 && this.now() - started < 4);
        if (this.pending.length > 0)
            this.timer = setTimeout(() => this.drain(), 0);
        else {
            this.clear();
            this.epoch = this.now();
        }
    }
}
exports.CooperativeDelivery = CooperativeDelivery;

},
"src/modules/client-runtime/sessions/history-cache.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/history-cache.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryCache = void 0;
const value_guards_1 = require("../value-guards");
const defaults = Object.freeze({ maxInactiveSessions: 6, maxInactiveBytes: 64 * 1024 * 1024 });
/** Iterative conservative payload weight; cycles and deeply nested data are safe. */
function weight(value) {
    let bytes = 0;
    const stack = [value], seen = new WeakSet();
    while (stack.length && bytes <= defaults.maxInactiveBytes) {
        const item = stack.pop();
        if (typeof item === 'string')
            bytes += 24 + item.length * 2;
        else if ((0, value_guards_1.isRecord)(item)) {
            if (seen.has(item))
                continue;
            seen.add(item);
            bytes += 64;
            for (const key of Object.keys(item)) {
                bytes += 16 + key.length * 2;
                stack.push(item[key]);
            }
        }
        else
            bytes += 8;
    }
    return bytes;
}
/** LRU owner for idle, inactive Session windows; streaming paths only mark dirty. */
class HistoryCache {
    constructor(manager) {
        this.manager = manager;
        this.limits = { ...defaults };
        this.entries = new Map();
        this.clock = 0;
        this.scheduled = false;
        this.evictions = 0;
        this.lastStats = { inactiveSessions: 0, estimatedInactiveBytes: 0, protectedSessions: 0 };
    }
    track(session) {
        if (this.entries.has(session.sessionId))
            return;
        this.entries.set(session.sessionId, { session, lastAccess: ++this.clock, bytes: 0, dirty: true });
        session.xhHistoryOwner = this;
        this.schedule();
    }
    touch(id) {
        const entry = id === undefined ? undefined : this.entries.get(id);
        if (entry)
            entry.lastAccess = ++this.clock;
        this.schedule();
    }
    changed(session) {
        const entry = this.entries.get(session.sessionId);
        if (entry)
            entry.dirty = true;
        this.schedule();
    }
    forget(id) {
        const entry = this.entries.get(id);
        if (!entry)
            return;
        entry.session.xhHistoryOwner = undefined;
        this.entries.delete(id);
    }
    protected(session) {
        return this.manager.isCurrent(session.sessionId)
            || this.manager.hasPendingInteractions(session.sessionId)
            || session.historyResidencyProtected();
    }
    schedule() {
        if (this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; this.trim(); });
    }
    trim() {
        const candidates = [];
        let bytes = 0, protectedSessions = 0;
        for (const entry of this.entries.values()) {
            const session = entry.session;
            if (session.historyResidencyCold())
                continue;
            if (this.protected(session)) {
                protectedSessions++;
                continue;
            }
            if (entry.dirty) {
                entry.bytes = weight(session.historyPayload());
                entry.dirty = false;
            }
            bytes += entry.bytes;
            candidates.push(entry);
        }
        candidates.sort((a, b) => a.lastAccess - b.lastAccess);
        let count = candidates.length;
        for (const entry of candidates) {
            if (count <= this.limits.maxInactiveSessions && bytes <= this.limits.maxInactiveBytes)
                break;
            if (this.protected(entry.session) || !entry.session.unloadHistory())
                continue;
            bytes -= entry.bytes;
            entry.bytes = 0;
            entry.dirty = true;
            count--;
            this.evictions++;
        }
        this.lastStats = { inactiveSessions: count, estimatedInactiveBytes: bytes, protectedSessions, evictions: this.evictions };
        return this.lastStats;
    }
}
exports.HistoryCache = HistoryCache;

},
"src/modules/client-runtime/sessions/provide.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/provide.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionProvideChannel = void 0;
/**
 * Provider roster + materialization + current projection. The channel owns
 * every rule a provider contribution must satisfy; owners keep only their
 * per-session bundle storage and the definition of "current".
 */
class SessionProvideChannel {
    /**
     * @param host - owner-side bundle storage and current-selection resolution.
     */
    constructor(host) {
        this.host = host;
        this.providers = [];
        /** Projection subscribers (plain cell: bundles hold live session sources, so no store freeze may touch them). */
        this.listeners = new Set();
        // The runtime's own contribution comes first: useSession rides the same
        // provide channel every plugin uses (no renderer special case).
        this.providers.push({
            hooks: ['session'],
            resolve: binding => ({ hooks: { session: binding.session } }),
        });
        this.maybeInfoCache = this.materializeMaybeInfo();
        this.currentSnapshot = this.maybeInfoCache;
        this.currentProvideInfo = {
            getSnapshot: () => this.currentSnapshot,
            subscribe: (fn) => {
                this.listeners.add(fn);
                return () => { this.listeners.delete(fn); };
            },
        };
    }
    /** The static no-session projection under the current roster (declared names present, values undefined). */
    get maybeInfo() {
        return this.maybeInfoCache;
    }
    /**
     * Register a per-session standard-props provider (see
     * SessionRuntime.provide for the product contract). Live bundles rebuild
     * immediately; misdeclared providers fail loud here, at the registration
     * edge, and the registration rolls back — the channel never stays on a
     * roster it cannot materialize.
     * @param descriptor - static member roster plus per-session resolver.
     * @returns disposer removing the provider.
     */
    provide(descriptor) {
        this.providers.push(descriptor);
        try {
            this.applyRosterChange();
        }
        catch (error) {
            this.providers.splice(this.providers.indexOf(descriptor), 1);
            // Restore the previous (valid) roster's bundles; cannot rethrow — the
            // pre-push roster materialized successfully before.
            this.applyRosterChange();
            throw error;
        }
        return () => {
            const at = this.providers.indexOf(descriptor);
            if (at >= 0)
                this.providers.splice(at, 1);
            this.applyRosterChange();
        };
    }
    /**
     * Re-derive the current selection's bundle and publish it when it changed.
     * Bundles are identity-stable per (scope, roster) materialization, so an
     * identity compare is exact; synchronous notify — call sites (the owner's
     * list subscription, provide()) already sit behind their own batching or
     * registration edges.
     */
    publishCurrent() {
        const next = this.host.resolveCurrent();
        if (next === this.currentSnapshot)
            return;
        this.currentSnapshot = next;
        for (const fn of [...this.listeners]) {
            try {
                fn();
            }
            catch (error) {
                // Contain subscriber failures: this notify runs inside the list
                // notification, where a throwing render-side subscriber would starve
                // later listeners and abort the projection pass that scheduled it.
                console.error('sessions.currentProvideInfo subscriber failed:', error);
            }
        }
    }
    /**
     * Materialize the standard-props bundle for one session (fails loud on
     * undeclared, missing, and duplicate member names).
     * @param binding - session assembly handle fed to every resolver.
     * @returns the materialized bundle (identity-stable until the next materialization).
     */
    materializeInfo(binding) {
        const hooks = {};
        const props = {};
        for (const descriptor of this.providers) {
            const contribution = descriptor.resolve(binding);
            const contributedHooks = contribution.hooks ?? {};
            const contributedProps = contribution.props ?? {};
            for (const name of Object.keys(contributedHooks)) {
                if (!(descriptor.hooks ?? []).includes(name)) {
                    throw new Error(`sessions.provide: undeclared hook "${name}"`);
                }
            }
            for (const name of Object.keys(contributedProps)) {
                if (!(descriptor.props ?? []).includes(name)) {
                    throw new Error(`sessions.provide: undeclared prop "${name}"`);
                }
            }
            for (const name of descriptor.hooks ?? []) {
                const source = contributedHooks[name];
                if (source === undefined)
                    throw new Error(`sessions.provide: missing hook "${name}"`);
                if (Object.hasOwn(hooks, name))
                    throw new Error(`sessions.provide: duplicate hook "${name}"`);
                hooks[name] = source;
            }
            for (const name of descriptor.props ?? []) {
                if (!Object.hasOwn(contributedProps, name))
                    throw new Error(`sessions.provide: missing prop "${name}"`);
                if (Object.hasOwn(props, name))
                    throw new Error(`sessions.provide: duplicate prop "${name}"`);
                props[name] = contributedProps[name];
            }
        }
        return {
            sessionId: binding.sessionId,
            hooks,
            props,
            // The useProjection seat: key-addressed bare value faces off the
            // session's projection store (open key space — never a static roster member).
            projections: { faceOf: key => binding.session.projections.faceOf(key) },
        };
    }
    /** Rebuild the static projection and the owner's live bundles, then republish the current one. */
    applyRosterChange() {
        this.maybeInfoCache = this.materializeMaybeInfo();
        this.host.rebuildBundles();
        this.publishCurrent();
    }
    /** Build the static no-session kit and reject duplicate declared names. */
    materializeMaybeInfo() {
        const hooks = {};
        const props = {};
        for (const descriptor of this.providers) {
            for (const name of descriptor.hooks ?? []) {
                if (Object.hasOwn(hooks, name))
                    throw new Error(`sessions.provide: duplicate hook "${name}"`);
                hooks[name] = undefined;
            }
            for (const name of descriptor.props ?? []) {
                if (Object.hasOwn(props, name))
                    throw new Error(`sessions.provide: duplicate prop "${name}"`);
                props[name] = undefined;
            }
        }
        return { sessionId: undefined, hooks, props }; // no projections face: every key reads absent without a session
    }
}
exports.SessionProvideChannel = SessionProvideChannel;

},
"src/modules/client-runtime/workspaces/service.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/service.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceRuntime = exports.DirectoryBrowseError = exports.WorkspaceCreateError = void 0;
const epoch_1 = require("./epoch");
const store_1 = require("../contract/store");
const manager_1 = require("./manager");
/** Structured create failure for UI flows that distinguish Host business errors. */
class WorkspaceCreateError extends Error {
    constructor(rpcError) {
        super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`);
        this.rpcError = rpcError;
        this.name = 'WorkspaceCreateError';
    }
}
exports.WorkspaceCreateError = WorkspaceCreateError;
/** Structured browse failure so the directory browser can branch on Host business codes. */
class DirectoryBrowseError extends Error {
    constructor(rpcError) {
        super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`);
        this.rpcError = rpcError;
        this.name = 'DirectoryBrowseError';
    }
}
exports.DirectoryBrowseError = DirectoryBrowseError;
/** Real Workspace object layer and Host actions. */
class WorkspaceRuntime {
    /**
     * @param ctx - client root context.
     * @param api - shared wire client.
     * @param sessions - cross-domain sessions face used for recency and blank-session reuse.
     */
    constructor(ctx, api, sessions) {
        this.api = api;
        this.sessions = sessions;
        /** In-flight blank-session creates keyed by workspace (connectWorkspace coalescing). */
        this.connecting = new Map();
        /** Guards the runtime-owned one-shot initial-selection subscription. */
        this.initialSelectionStarted = false;
        this.manager = new manager_1.WorkspaceManager(api);
        this.list = (0, store_1.createSnapshotStore)({
            items: [], archivedSessionIds: [], state: 'idle', phase: 'pending', error: null,
            baselinesReady: false, recentWorkspaceId: undefined,
        });
        this.manager.subscribe(() => { this.project(); });
        this.sessions.list.subscribe(() => { this.project(); });
        ctx.reflect.provide('workspaces', this, undefined);
    }
    /**
     * Resolve the session a New Session flow lands in once this Workspace is
     * chosen: reuse the workspace's existing blank session when one is in the
     * list mirror, else create a fresh one on the host (`session.create` births
     * the full Session+Agent — the client holds no intermediate state). The
     * caller owns navigation: take the returned id to `sessions.open`.
     * Resolution guarantee (both arms): the returned id is already in the list
     * store and `sessions.binding(id)` resolves synchronously — draft hand-off
     * may write the new scope's machine before opening.
     * @param workspaceId - chosen Workspace (must be in the workspace list).
     * @returns the reused or newly created session id.
     */
    async connectWorkspace(workspaceId) {
        const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId);
        if (workspace === undefined)
            throw new Error(`workspaces.connectWorkspace: unknown workspace ${workspaceId}`);
        // Coalesce concurrent connects: a create's summary lands without cwd
        // until the host frame arrives, so a second call inside that window
        // would miss the reuse scan and mint another hidden blank session.
        const inflight = this.connecting.get(workspaceId);
        if (inflight !== undefined)
            return inflight;
        // Reuse requires workspace membership (id in sessionIds AND same
        // canonical cwd — the host's own membership rule), never cwd alone:
        // a cwd match can belong to no account (sessions the CLI/TUI birthed at
        // the host cwd, or a deleted/recreated registration) and reusing it
        // would open a session no grouping surface shows under this workspace.
        // An archived blank is never reused either: reuse would open a session
        // no grouping surface can show, so New Session mints a fresh one instead.
        const archived = this.list.getSnapshot().archivedSessionIds;
        const sessions = this.sessions.list.getSnapshot();
        for (const id of sessions.ids) {
            const summary = sessions.byId[id];
            if (summary !== undefined && summary.blank && summary.cwd === workspace.path
                && workspace.sessionIds.includes(summary.id)
                && !archived.includes(summary.id))
                return summary.id;
        }
        const attempt = this.sessions.create({ workspaceId })
            .finally(() => { this.connecting.delete(workspaceId); });
        this.connecting.set(workspaceId, attempt);
        return attempt;
    }
    /**
     * Follow the first complete Workspace/Session baseline and select a default
     * session exactly once. A restored current session wins; otherwise the most
     * recent Workspace is connected (reusing or creating its blank session).
     * Later explicit clears stay cleared instead of retriggering this startup
     * policy. A failed connect may retry on the next baseline projection.
     * @returns disposer for the baseline subscription; late work cannot navigate after disposal.
     */
    startInitialSelection() {
        if (this.initialSelectionStarted) {
            throw new Error('workspaces.startInitialSelection: already started');
        }
        this.initialSelectionStarted = true;
        let state = 'waiting';
        let disposed = false;
        const reconcile = () => {
            if (disposed || state !== 'waiting')
                return;
            const workspace = this.list.getSnapshot();
            if (!workspace.baselinesReady)
                return;
            const current = this.sessions.list.getSnapshot().current;
            const target = workspace.recentWorkspaceId;
            if (current !== undefined || target === undefined) {
                state = 'done';
                return;
            }
            state = 'connecting';
            void this.connectWorkspace(target).then((sessionId) => {
                if (disposed)
                    return;
                if (this.sessions.list.getSnapshot().current === undefined) {
                    this.sessions.open(sessionId);
                }
                state = 'done';
            }, (reason) => {
                if (disposed)
                    return;
                state = 'waiting';
                console.warn('initial workspace selection failed:', reason);
            });
        };
        const unsubscribe = this.list.subscribe(reconcile);
        reconcile();
        return () => {
            disposed = true;
            unsubscribe();
        };
    }
    /**
     * The shared New Session action behind the shell entry points (sidebar
     * button, workspace browser): resolve the target Workspace — explicit wins,
     * then the current Session's Workspace, then the recent-Workspace
     * projection — connect its blank session and navigate there; with no
     * Workspace at all, clear the selection into the New Session view state.
     * Connect failures are non-fatal (console diagnostics; the current view
     * stays usable).
     * @param workspaceId - explicit target Workspace for scoped actions.
     */
    startSession(workspaceId) {
        const workspace = this.list.getSnapshot();
        const current = this.sessions.list.getSnapshot().current;
        const currentWorkspaceId = current === undefined
            ? undefined
            : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId;
        const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId;
        if (target === undefined) {
            this.sessions.clear();
            return;
        }
        void this.connectWorkspace(target).then((sessionId) => { this.sessions.open(sessionId); }, (reason) => { console.warn('new session failed:', reason); });
    }
    /**
     * Register an existing path as a Workspace.
     * @param input - the Host create payload.
     * @returns the created or idempotently resolved Workspace.
     */
    async create(input) {
        const result = await this.manager.create(input);
        if (!result.ok)
            throw new WorkspaceCreateError(result.error);
        return result.value.workspace;
    }
    /**
     * Open the Host's native directory picker (the `native` capability).
     * @returns the selected path, or null when the user cancelled.
     */
    async pickDirectory() {
        const response = await this.api.host.pickDirectory({});
        if (!response.result.ok) {
            throw new Error(`directory picker failed: ${response.result.error.message}`);
        }
        return response.result.value.path;
    }
    /**
     * List one directory level through the Host's `browse` capability.
     * @param path - absolute directory to list; absent lists the Host home directory.
     * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
     * @returns the level's listing with breadcrumb ancestry.
     */
    async listDirectory(path, signal) {
        const response = await this.api.host.listDirectory(path === undefined ? {} : { path }, signal);
        if (!response.result.ok)
            throw new DirectoryBrowseError(response.result.error);
        return response.result.value;
    }
    /**
     * Create one child directory through the Host's `browse` capability.
     * @param path - absolute existing parent directory.
     * @param name - single non-blank path segment.
     * @returns the created directory's absolute path.
     */
    async createDirectory(path, name) {
        const response = await this.api.host.createDirectory({ path, name });
        if (!response.result.ok)
            throw new DirectoryBrowseError(response.result.error);
        return response.result.value.path;
    }
    /**
     * Open a filesystem path with the Host operating system's default application.
     * @param path - absolute or host-resolvable path.
     */
    async openPath(path) {
        const response = await this.api.host.openPath({ path });
        if (!response.result.ok) {
            throw new Error(`path open failed: ${response.result.error.message}`);
        }
    }
    /**
     * Rename a Workspace.
     * @param workspaceId - target workspace.
     * @param title - new display title (trimmed non-empty by the Host).
     * @returns the renamed Workspace view.
     */
    async rename(workspaceId, title) {
        const result = await this.manager.rename(workspaceId, title);
        if (!result.ok)
            throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`);
        return result.value.workspace;
    }
    /**
     * Delete one Workspace registration. Sessions, session logs, and the
     * directory remain Host-owned outside this operation.
     * @param workspaceId - target workspace.
     */
    async delete(workspaceId) {
        const result = await this.manager.delete(workspaceId);
        if (!result.ok)
            throw new Error(`workspace delete failed: ${result.error.code}: ${result.error.message}`);
    }
    /**
     * Move a Workspace within the durable registry display order.
     * @param workspaceId - Workspace to move.
     * @param beforeWorkspaceId - Anchor workspace; omitted appends.
     */
    async insertBefore(workspaceId, beforeWorkspaceId) {
        const result = await this.manager.insertBefore(workspaceId, beforeWorkspaceId);
        if (!result.ok)
            throw new Error(`workspace reorder failed: ${result.error.code}: ${result.error.message}`);
    }
    /**
     * Archive a session into the registry-global set. Clearing an archived
     * current selection is the projection sweep's job (one rule for the local
     * echo and a remote tab's frame alike).
     * @param sessionId - session to archive.
     */
    async archiveSession(sessionId) {
        const result = await this.manager.archiveSession(sessionId);
        if (!result.ok)
            throw new Error(`session archive failed: ${result.error.code}: ${result.error.message}`);
    }
    /**
     * Move a session within its Workspace's manual order (DOM-insertBefore-like).
     * @param workspaceId - owning workspace.
     * @param sessionId - accounted session to move.
     * @param beforeSessionId - accounted anchor to insert before; omitted appends.
     * @returns the updated Workspace view.
     */
    async insertSessionBefore(workspaceId, sessionId, beforeSessionId) {
        const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
        if (!result.ok)
            throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`);
        return result.value.workspace;
    }
    /** Optional Host archive labels, filtered by authoritative archive membership. */
    forgetDeletedSessions(ids) { this.manager.forgetDeletedSessions(ids); }
    archivedSummaries() { return this.manager.archivedSummaries(); }
    /** Refresh the workspace baseline, reusing an in-flight pull. */
    refresh() {
        return this.manager.refresh();
    }
    /**
     * Route a Host stream envelope into the Workspace object layer.
     * @param envelope - validated Host stream envelope.
     */
    handleHostEnvelope(envelope) {
        this.manager.handleHostEnvelope(envelope);
    }
    /** Rebuild the Workspace baseline after connection. */
    handleConnected() {
        this.manager.handleConnected();
    }
    project() {
        const workspace = this.manager.getSnapshot();
        const sessions = this.sessions.list.getSnapshot();
        const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready';
        // An archived current selection clears into the New Session view state —
        // a hidden row must not stay open behind the list. Sweeping here covers
        // every install path with one rule: the local unary echo, another tab's
        // changed frame, and a reconnect baseline restoring a persisted
        // selection that was archived while this client was away.
        if (sessions.current !== undefined && workspace.archivedSessionIds.includes(sessions.current)) {
            this.sessions.clear();
        }
        this.list.set({
            items: workspace.items,
            archivedSessionIds: workspace.archivedSessionIds,
            state: workspace.state,
            phase: workspace.phase,
            error: workspace.error,
            baselinesReady,
            recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
        });
    }
}
exports.WorkspaceRuntime = WorkspaceRuntime;
/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(workspaces, sessions) {
    let selected;
    let selectedTime = Number.NEGATIVE_INFINITY;
    for (const workspace of workspaces) {
        let latest = Number.NEGATIVE_INFINITY;
        for (const sessionId of workspace.sessionIds) {
            const session = sessions[sessionId];
            if (session !== undefined)
                latest = Math.max(latest, session.updatedAt);
        }
        if (latest === Number.NEGATIVE_INFINITY)
            latest = (0, epoch_1.workspaceEpochMs)(workspace.createdAt);
        if (selected === undefined || latest > selectedTime) {
            selected = workspace.workspaceId;
            selectedTime = latest;
        }
    }
    return selected;
}

},
"src/modules/client-runtime/workspaces/epoch.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/epoch.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceEpochMs = workspaceEpochMs;
/** Production Host emits epoch milliseconds as decimal strings; upstream
 * fixtures use ISO dates. Preserve both timestamp shapes for recency. */
function workspaceEpochMs(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : Number.NaN;
    if (typeof value !== 'string')
        return Number.NaN;
    const text = value.trim();
    if (text === '')
        return Number.NaN;
    if (/^-?\d+$/.test(text)) {
        const numeric = Number(text);
        return Number.isSafeInteger(numeric) ? numeric : Number.NaN;
    }
    return Date.parse(text);
}

},
"src/modules/client-runtime/workspaces/manager.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/manager.ts

"use strict";
/** Workspace baseline, incremental-frame, and unary-action owner. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceManager = void 0;
const index_1 = require("../../client-connection/contracts/host/apiproxy/api/index");
const notifier_1 = require("../sessions/notifier");
const workspace_1 = require("./workspace");
/** Workspace object cluster driven by one list baseline and changed-frame upserts. */
class WorkspaceManager {
    /** @param api - shared wire client. */
    constructor(api) {
        this.api = api;
        this.items = [];
        this.itemViewsSource = null;
        this.itemViewsCache = [];
        // Full-snapshot state (list response / unary response / changed frame all
        // carry the complete set), so deltas never merge — installs replace.
        this.archivedSessions = [];
        this.archivedSessionIds = [];
        this.state = 'idle';
        this.phase = 'pending';
        this.error = null;
        this.inflight = null;
        this.refreshFrames = null;
        /**
         * True once a frame or unary echo installed the archive set while a list
         * request was in flight: that install is newer than the pending baseline,
         * so the baseline's (older) set must not roll it back — the archive
         * mirror of replaying refreshFrames over the item baseline.
         */
        this.archivedSupersedesRefresh = false;
        /** Latest local reorder request; only its unary echo may install order. */
        this.orderRequestGeneration = 0;
        /** Increments on order frames so a later remote commit outranks an older unary echo. */
        this.orderFrameGeneration = 0;
        /** Last complete order accepted from a Host baseline, frame, or current unary echo. */
        this.committedOrder = [];
        /**
         * Ids this process has seen removed, kept for the connection's lifetime so
         * a late changed frame or a stale baseline row cannot resurrect a deleted
         * row. Correctness rests on Host ids never being reused (the registry mints
         * a fresh `randomUUID` per record, including when the same directory is
         * registered again) — a path-derived id scheme would turn these entries
         * into permanent blindfolds and must clear them instead.
         */
        this.removedIds = new Set();
        this.deletedSessionIds = new Set();
        this.notifier = new notifier_1.Notifier(() => {
            this.snapshotCache = this.buildSnapshot();
        });
        this.snapshotCache = this.buildSnapshot();
    }
    /**
     * Refresh from workspace.list. The first successful response establishes
     * Host order; later responses re-establish the durable order so reconnects
     * adopt reorders committed while this client was offline. Frames arriving
     * during the RPC are replayed over its response.
     * @returns the shared in-flight refresh.
     */
    refresh() {
        if (this.inflight !== null)
            return this.inflight;
        this.state = 'loading';
        this.error = null;
        const frames = [];
        this.refreshFrames = frames;
        this.notifier.markDirty();
        this.inflight = (async () => {
            try {
                const { result } = await this.api.workspace.list({});
                if (result.ok) {
                    let items = result.value.items;
                    items = items.filter(workspace => !this.removedIds.has(workspace.workspaceId));
                    for (const delta of frames)
                        items = applyWorkspaceDelta(items, delta);
                    this.installViews(items);
                    if (!this.archivedSupersedesRefresh) {
                        this.installArchived(result.value.archivedSessionIds);
                        this.archivedSessions = result.value.archivedSessions ?? [];
                    }
                    this.state = 'idle';
                    this.phase = 'ready';
                }
                else {
                    this.state = 'error';
                    this.error = result.error;
                }
            }
            catch (error) {
                this.state = 'error';
                const folded = (0, index_1.transportError)(error);
                /* v8 ignore next -- transportError always returns the failure branch. */
                this.error = folded.ok ? null : folded.error;
            }
            finally {
                this.refreshFrames = null;
                this.archivedSupersedesRefresh = false;
                this.inflight = null;
                this.notifier.markDirty();
            }
        })();
        return this.inflight;
    }
    /**
     * Create or resolve a real Workspace, then publish its returned snapshot
     * without waiting for the changed frame.
     * @param input - the existing absolute path to adopt.
     * @returns the wire result.
     */
    async create(input) {
        const workspace = new workspace_1.Workspace(this.api, input);
        const completion = workspace.materialize();
        if (completion === undefined)
            throw new Error('a local Workspace must be materializable');
        const result = await completion;
        if (result.ok)
            this.upsert(result.value.workspace, workspace);
        return result;
    }
    /**
     * Rename a Workspace, then publish its returned snapshot without waiting
     * for the changed frame.
     * @param workspaceId - target workspace.
     * @param title - new display title.
     * @returns the wire result.
     */
    async rename(workspaceId, title) {
        const { result } = await this.api.workspace.rename({ workspaceId, title });
        if (result.ok)
            this.upsert(result.value.workspace);
        return result;
    }
    /**
     * Delete a Workspace registration and remove its local projection from the
     * unary response without waiting for the Host frame.
     * @param workspaceId - target workspace.
     * @returns the wire result.
     */
    async delete(workspaceId) {
        const { result } = await this.api.workspace.delete({ workspaceId });
        if (result.ok)
            this.remove(workspaceId, true);
        return result;
    }
    /**
     * Move a Workspace within the registry display order and install the full
     * returned order without waiting for the Host frame.
     * @param workspaceId - Workspace to move.
     * @param beforeWorkspaceId - Anchor workspace; omitted appends.
     * @returns the wire result.
     */
    async insertBefore(workspaceId, beforeWorkspaceId) {
        const requestGeneration = ++this.orderRequestGeneration;
        const frameGeneration = this.orderFrameGeneration;
        const localOrder = this.itemViews().map(workspace => workspace.workspaceId);
        this.installOrder(insertIdBefore(localOrder, workspaceId, beforeWorkspaceId));
        let result;
        try {
            ;
            ({ result } = await this.api.workspace.insertBefore({
                workspaceId,
                ...beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId },
            }));
        }
        catch (error) {
            if (requestGeneration === this.orderRequestGeneration
                && frameGeneration === this.orderFrameGeneration) {
                this.installOrder(this.committedOrder);
            }
            throw error;
        }
        if (result.ok && requestGeneration === this.orderRequestGeneration
            && frameGeneration === this.orderFrameGeneration) {
            this.installOrder(result.value.workspaceIds, true);
        }
        else if (!result.ok && requestGeneration === this.orderRequestGeneration
            && frameGeneration === this.orderFrameGeneration) {
            this.installOrder(this.committedOrder);
        }
        return result;
    }
    /**
     * Move a session within its Workspace's manual order, then publish the
     * returned snapshot without waiting for the changed frame.
     * @param workspaceId - owning workspace.
     * @param sessionId - accounted session to move.
     * @param beforeSessionId - accounted anchor to insert before; omitted appends.
     * @returns the wire result.
     */
    async insertSessionBefore(workspaceId, sessionId, beforeSessionId) {
        const { result } = await this.api.workspace.insertSessionBefore({
            workspaceId, sessionId,
            ...beforeSessionId === undefined ? {} : { beforeSessionId },
        });
        if (result.ok)
            this.upsert(result.value.workspace);
        return result;
    }
    /**
     * Archive one session in the registry-global set, then install the
     * returned full set without waiting for the changed frame.
     * @param sessionId - session to archive.
     * @returns the wire result.
     */
    async archiveSession(sessionId) {
        const { result } = await this.api.workspace.archiveSession({ sessionId });
        if (result.ok)
            this.installArchived(result.value.archivedSessionIds);
        return result;
    }
    /**
     * Host-frame entry. Non-workspace frames are ignored so the runtime can
     * fan one host stream out to both object managers.
     * @param envelope - host stream envelope.
     */
    handleHostEnvelope(envelope) {
        if (envelope.payload.type === 'host/workspace-changed')
            this.upsert(envelope.payload.workspace);
        else if (envelope.payload.type === 'host/workspace-removed')
            this.remove(envelope.payload.workspaceId);
        else if (envelope.payload.type === 'host/workspace-order-changed') {
            this.orderFrameGeneration++;
            this.installOrder(envelope.payload.workspaceIds, true);
        }
        else if (envelope.payload.type === 'host/session-removed' && envelope.payload.permanent === true) {
            this.forgetDeletedSessions([envelope.payload.sessionId]);
        }
        else if (envelope.payload.type === 'host/archived-sessions-changed') {
            this.installArchived(envelope.payload.archivedSessionIds);
        }
    }
    /** Re-pull the baseline after each connection generation. */
    handleConnected() {
        void this.refresh();
    }
    /**
     * Subscribe to workspace snapshot invalidation.
     * @param listener - snapshot invalidation callback.
     * @returns unsubscribe function.
     */
    subscribe(listener) {
        return this.notifier.subscribe(listener);
    }
    /**
     * Read the cached workspace snapshot after flushing pending notifications.
     * @returns the cached workspace snapshot.
     */
    getSnapshot() {
        this.notifier.ensureFresh();
        return this.snapshotCache;
    }
    /** Apply only a successful delete acknowledgement or a permanent-removal frame. */
    forgetDeletedSessions(ids) {
        for (const id of ids)
            this.deletedSessionIds.add(id);
        this.archivedSessions = this.archivedSessions.filter(row => !this.deletedSessionIds.has(row.sessionId));
        this.installArchived(this.archivedSessionIds);
        for (const workspace of this.items) {
            const view = workspace.getSnapshot().view;
            if (view !== undefined)
                workspace.adopt({ ...view, sessionIds: view.sessionIds.filter(id => !this.deletedSessionIds.has(id)) });
        }
        this.items = [...this.items];
        this.notifier.notifyNow();
    }
    archivedSummaries() {
        return this.archivedSessions.filter(row => this.archivedSessionIds.includes(row.sessionId));
    }
    buildSnapshot() {
        return {
            items: this.itemViews(),
            archivedSessionIds: this.archivedSessionIds,
            state: this.state,
            phase: this.phase,
            error: this.error,
        };
    }
    /**
     * Replace the archive set when membership actually changed (array identity
     * backs Object.is short-circuits). Host snapshots are append-ordered, so
     * positional comparison is exact, not merely heuristic.
     */
    installArchived(archivedSessionIds) {
        if (this.refreshFrames !== null)
            this.archivedSupersedesRefresh = true;
        archivedSessionIds = archivedSessionIds.filter(id => !this.deletedSessionIds.has(id));
        if (archivedSessionIds.length === this.archivedSessionIds.length
            && archivedSessionIds.every((id, index) => id === this.archivedSessionIds[index]))
            return;
        this.archivedSessionIds = [...archivedSessionIds];
        this.notifier.markDirty();
    }
    /** Reorder known Workspace objects, optionally recording a Host-committed sequence. */
    installOrder(workspaceIds, committed = false) {
        if (committed) {
            this.refreshFrames?.push({ type: 'order', workspaceIds });
            this.committedOrder = [...workspaceIds];
        }
        const rank = new Map(workspaceIds.map((id, index) => [id, index]));
        const items = [...this.items].sort((left, right) => {
            const leftId = left.getSnapshot().view?.workspaceId;
            const rightId = right.getSnapshot().view?.workspaceId;
            return (leftId === undefined ? Number.MAX_SAFE_INTEGER : rank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
                - (rightId === undefined ? Number.MAX_SAFE_INTEGER : rank.get(rightId) ?? Number.MAX_SAFE_INTEGER);
        });
        if (items.every((item, index) => item === this.items[index]))
            return;
        this.items = items;
        this.notifier.markDirty();
    }
    /** Upsert one Host view, optionally retaining the local object that materialized it. */
    upsert(view, identity) {
        view = { ...view, sessionIds: view.sessionIds.filter(id => !this.deletedSessionIds.has(id)) };
        if (this.removedIds.has(view.workspaceId))
            return;
        this.refreshFrames?.push({ type: 'upsert', workspace: view });
        const index = this.items.findIndex(item => item.getSnapshot().view?.workspaceId === view.workspaceId);
        // Mutation responses and changed frames race (two carriers, no ordering):
        // reject a snapshot strictly older than the installed projection so a
        // late unary response cannot roll back a newer frame.
        const installed = index === -1 ? undefined : this.items[index]?.getSnapshot().view;
        if (installed !== undefined && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt))
            return;
        if (!this.committedOrder.includes(view.workspaceId)) {
            this.committedOrder = [view.workspaceId, ...this.committedOrder];
        }
        if (identity !== undefined) {
            this.items = index === -1
                ? [identity, ...this.items]
                : this.items.map((item, position) => position === index ? identity : item);
        }
        else if (index === -1) {
            this.items = [new workspace_1.Workspace(this.api, view), ...this.items];
        }
        else {
            this.items[index]?.adopt(view);
            this.items = [...this.items];
        }
        this.notifier.markDirty();
    }
    /** Remove one id idempotently and retain a tombstone against late echoes. */
    remove(workspaceId, direct = false) {
        this.refreshFrames?.push({ type: 'remove', workspaceId });
        this.removedIds.add(workspaceId);
        this.committedOrder = this.committedOrder.filter(id => id !== workspaceId);
        const items = this.items.filter(item => item.getSnapshot().view?.workspaceId !== workspaceId);
        if (items.length === this.items.length) {
            // The Host frame may have removed the row first but left its batched
            // notification pending. A successful unary echo still flushes that
            // committed state before the user action resolves.
            if (direct)
                this.notifier.notifyNow();
            return;
        }
        this.items = items;
        if (direct)
            this.notifier.notifyNow();
        else
            this.notifier.markDirty();
    }
    installViews(views) {
        views = views.map(view => ({ ...view, sessionIds: view.sessionIds.filter(id => !this.deletedSessionIds.has(id)) }));
        const existing = new Map(this.items.flatMap((workspace) => {
            const view = workspace.getSnapshot().view;
            return view === undefined ? [] : [[view.workspaceId, workspace]];
        }));
        const installed = new Map();
        for (const view of views) {
            const duplicate = installed.get(view.workspaceId);
            if (duplicate !== undefined) {
                duplicate.adopt(view);
                continue;
            }
            const workspace = existing.get(view.workspaceId) ?? new workspace_1.Workspace(this.api, view);
            workspace.adopt(view);
            installed.set(view.workspaceId, workspace);
        }
        this.items = [...installed.values()];
        this.committedOrder = views.map(view => view.workspaceId);
    }
    itemViews() {
        if (this.itemViewsSource === this.items)
            return this.itemViewsCache;
        this.itemViewsSource = this.items;
        this.itemViewsCache = this.items.flatMap((workspace) => {
            const view = workspace.getSnapshot().view;
            return view === undefined ? [] : [view];
        });
        return this.itemViewsCache;
    }
}
exports.WorkspaceManager = WorkspaceManager;
/** Known ids retain their position; a newly created Workspace enters first. */
function upsertWorkspace(items, workspace) {
    const index = items.findIndex(item => item.workspaceId === workspace.workspaceId);
    return index === -1
        ? [workspace, ...items]
        : items.map((item, position) => position === index ? workspace : item);
}
/** Replay one ordered delta over a baseline: upsert in place, or drop the removed id. */
function applyWorkspaceDelta(items, delta) {
    if (delta.type === 'upsert')
        return upsertWorkspace(items, delta.workspace);
    if (delta.type === 'remove') {
        return items.filter(workspace => workspace.workspaceId !== delta.workspaceId);
    }
    const rank = new Map(delta.workspaceIds.map((id, index) => [id, index]));
    return [...items].sort((left, right) => (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
        - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER));
}
/** Move one known id before an optional anchor; unknown ids leave the order unchanged. */
function insertIdBefore(ids, id, beforeId) {
    if (!ids.includes(id) || (beforeId !== undefined && !ids.includes(beforeId)) || beforeId === id) {
        return [...ids];
    }
    const without = ids.filter(candidate => candidate !== id);
    const at = beforeId === undefined ? without.length : without.indexOf(beforeId);
    return [...without.slice(0, at), id, ...without.slice(at)];
}

},
"src/modules/client-runtime/workspaces/workspace.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/workspace.ts

"use strict";
/** React-free Workspace entity with a client-local materialization lifecycle. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Workspace = void 0;
const index_1 = require("../../client-connection/contracts/host/apiproxy/api/index");
const notifier_1 = require("../sessions/notifier");
/**
 * Observable Workspace object whose identity survives Host materialization.
 * Local instances retain their create input and failure state; materialized
 * instances expose the latest Host view.
 */
class Workspace {
    /**
     * @param api - shared wire client.
     * @param source - local create input or an existing Host Workspace view.
     */
    constructor(api, source) {
        this.api = api;
        this.materialization = null;
        this.notifier = new notifier_1.Notifier(() => {
            this.snapshotCache = this.buildSnapshot();
        });
        if ('workspaceId' in source) {
            this.view = source;
        }
        else {
            this.intent = {
                input: source,
                snapshot: { name: intentName(source), phase: 'ready' },
            };
        }
        this.snapshotCache = this.buildSnapshot();
    }
    /**
     * Materialize this local Workspace through the Host create API.
     * Re-entry shares the in-flight completion; a materialized instance returns undefined.
     * @returns the Host result, or undefined when this Workspace is already materialized.
     */
    materialize() {
        if (this.materialization !== null)
            return this.materialization;
        const intent = this.intent;
        if (intent === undefined)
            return undefined;
        intent.snapshot = { name: intent.snapshot.name, phase: 'creating' };
        this.notifier.notifyNow();
        const completion = this.completeMaterialization(intent).finally(() => {
            if (this.materialization === completion)
                this.materialization = null;
        });
        this.materialization = completion;
        return completion;
    }
    /**
     * Adopt a Host view without replacing this Workspace object.
     * An existing materialized identity accepts updates only for the same Workspace id.
     * @param view - latest Host projection.
     */
    adopt(view) {
        if (this.view !== undefined && this.view.workspaceId !== view.workspaceId) {
            throw new Error('cannot adopt a different Workspace id');
        }
        this.view = view;
        this.intent = undefined;
        this.notifier.markDirty();
    }
    /**
     * Subscribe to Workspace snapshot invalidation.
     * @param listener - snapshot invalidation callback.
     * @returns unsubscribe function.
     */
    subscribe(listener) {
        return this.notifier.subscribe(listener);
    }
    /**
     * Read the cached Workspace snapshot after flushing pending notifications.
     * @returns the cached Workspace snapshot.
     */
    getSnapshot() {
        this.notifier.ensureFresh();
        return this.snapshotCache;
    }
    async completeMaterialization(intent) {
        let result;
        try {
            result = (await this.api.workspace.create(intent.input)).result;
        }
        catch (error) {
            result = (0, index_1.transportError)(error);
        }
        if (this.intent !== intent)
            return result;
        if (result.ok) {
            this.adopt(result.value.workspace);
        }
        else {
            intent.snapshot = {
                name: intent.snapshot.name,
                phase: 'ready',
                error: `${result.error.code}: ${result.error.message}`,
            };
            this.notifier.markDirty();
        }
        return result;
    }
    buildSnapshot() {
        return { view: this.view, intent: this.intent?.snapshot };
    }
}
exports.Workspace = Workspace;
function intentName(input) {
    const trimmed = input.path.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() ?? input.path;
}

},
"src/modules/client-runtime/conversation/event-registry.js": function(module, exports, require) {
// source: src/modules/client-runtime/conversation/event-registry.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationEventRegistry = void 0;
const definition_registry_1 = require("./definition-registry");
/** Runtime registry of independently owned Conversation business Definitions. */
class ConversationEventRegistry extends definition_registry_1.ConversationDefinitionRegistry {
    /** @param ctx - owning Client Runtime context. */
    constructor(ctx) {
        super(ctx, 'conversationEvents');
    }
    /**
     * Register a uniquely named business Definition for the caller's lifetime.
     * @param definition - Definition contribution.
     * @returns idempotent disposer.
     */
    register(definition) {
        assertDefinitionTarget(definition);
        return this.registerDefinition(definition.kind, definition, `conversation Definition "${definition.kind}" is already registered`, `conversationEvents.register(${JSON.stringify(definition.kind)})`);
    }
    /**
     * Register the sole fallback used only when no ordinary Definition matches.
     * @param definition - fallback Definition.
     * @returns idempotent disposer.
     */
    registerFallback(definition) {
        assertDefinitionTarget(definition);
        const target = definition.target;
        if (target === undefined)
            throw new Error('conversation fallback Definition must declare a target');
        if (this.fallback !== undefined)
            throw new Error('conversation fallback Definition is already registered');
        const owner = this.runtimeCtx;
        const dispose = owner.effect(() => {
            this.fallback = definition;
            this.refresh();
            return () => {
                if (this.fallback !== definition)
                    return;
                this.fallback = undefined;
                this.refresh();
            };
        }, `conversationEvents.registerFallback(${JSON.stringify(definition.kind)})`);
        return () => { void dispose(); };
    }
    /**
     * Return the current unmatched-event fallback.
     * @returns installed fallback, when present.
     */
    fallbackEntry() {
        return this.fallback;
    }
}
exports.ConversationEventRegistry = ConversationEventRegistry;
function assertDefinitionTarget(definition) {
    if ((definition.target === undefined) !== (definition.buildViewNode === undefined)) {
        throw new Error(`conversation Definition "${definition.kind}" must declare target and buildViewNode together`);
    }
}

},
"src/modules/client-runtime/conversation/definition-registry.js": function(module, exports, require) {
// source: src/modules/client-runtime/conversation/definition-registry.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationDefinitionRegistry = void 0;
const context_1 = require("../context");
/** Shared lifecycle and stable-entry storage for one Conversation Definition registry. */
class ConversationDefinitionRegistry extends context_1.Service {
    constructor() {
        super(...arguments);
        this.definitions = new Map();
        this.listeners = new Set();
        this.cached = [];
    }
    /**
     * Return reference-stable Definitions in registration order.
     * @returns current Definitions.
     */
    entries() {
        return this.cached;
    }
    /**
     * Observe low-frequency registry changes.
     * @param listener - synchronous invalidation callback.
     * @returns unsubscribe callback.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    /**
     * Register one uniquely keyed Definition for the caller's lifetime.
     * @param key - registry-local unique key.
     * @param definition - contributed Definition.
     * @param duplicateMessage - error raised when the key is already owned.
     * @param effectName - Cordis effect diagnostic label.
     * @returns idempotent disposer.
     */
    registerDefinition(key, definition, duplicateMessage, effectName) {
        if (this.definitions.has(key))
            throw new Error(duplicateMessage);
        const owner = this.runtimeCtx;
        const dispose = owner.effect(() => {
            this.definitions.set(key, definition);
            this.refresh();
            return () => {
                if (this.definitions.get(key) !== definition)
                    return;
                this.definitions.delete(key);
                this.refresh();
            };
        }, effectName);
        return () => { void dispose(); };
    }
    /** Refresh cached entries and synchronously invalidate subscribers. */
    refresh() {
        this.cached = [...this.definitions.values()];
        for (const listener of this.listeners)
            listener();
    }
}
exports.ConversationDefinitionRegistry = ConversationDefinitionRegistry;

},
"src/modules/client-runtime/conversation/view-registry.js": function(module, exports, require) {
// source: src/modules/client-runtime/conversation/view-registry.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationViewRegistry = void 0;
const definition_registry_1 = require("./definition-registry");
/** Runtime registry of per-target Conversation snapshot builders. */
class ConversationViewRegistry extends definition_registry_1.ConversationDefinitionRegistry {
    /** @param ctx - owning Client Runtime context. */
    constructor(ctx) {
        super(ctx, 'conversationViews');
    }
    /**
     * Register a uniquely named view builder factory for the caller's lifetime.
     * @param definition - target builder contribution.
     * @returns idempotent disposer.
     */
    register(definition) {
        return this.registerDefinition(definition.target, definition, `conversation view target "${definition.target}" is already registered`, `conversationViews.register(${JSON.stringify(definition.target)})`);
    }
}
exports.ConversationViewRegistry = ConversationViewRegistry;

},
"src/modules/client-runtime/work/catalog.js": function(module, exports, require) {
// source: src/modules/client-runtime/work/catalog.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkCatalog = void 0;
const types_1 = require("../../client-connection/contracts/core/session/types");
const notifier_1 = require("../sessions/notifier");
function valueOf(result) {
    if (!result.ok)
        throw Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
}
function readerWait(job, signal) {
    if (signal === undefined)
        return job;
    if (signal.aborted)
        return Promise.reject(new DOMException('Reader cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new DOMException('Reader cancelled', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        job.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}
/** Single read projection over existing Session/Workspace owners, not another event pump. */
class WorkCatalog {
    constructor(api, sessions, workspaces) {
        this.api = api;
        this.sessions = sessions;
        this.workspaces = workspaces;
        this.disposed = false;
        this.notifier = new notifier_1.Notifier(() => { if (!this.disposed)
            this.snapshot = this.project(); });
        this.subscribe = (listener) => this.notifier.subscribe(() => { if (!this.disposed)
            listener(); });
        this.getSnapshot = () => { this.notifier.ensureFresh(); return this.snapshot; };
        this.snapshot = this.project();
        this.unsubscribers = [sessions.list.subscribe(() => this.changed()), workspaces.list.subscribe(() => this.changed())];
    }
    changed() { if (!this.disposed)
        this.notifier.markDirty(); }
    project() {
        const sessions = this.sessions.list.getSnapshot(), workspaces = this.workspaces.list.getSnapshot();
        const status = this.sessions.catalogStatus();
        return {
            sessions: sessions.ids.flatMap(id => {
                const row = sessions.byId[id];
                return row === undefined ? [] : [{ sessionId: id, blank: row.blank, running: row.running,
                        updatedAt: row.updatedAt, ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
                        projections: { values: { ...row.projectionValues, ...(row.title === undefined ? {} : { title: row.title }) } } }];
            }),
            workspaces: workspaces.items, archivedSessionIds: workspaces.archivedSessionIds,
            archivedSessions: this.workspaces.archivedSummaries(),
            phase: sessions.phase === 'ready' && workspaces.phase === 'ready' ? 'ready' : 'pending',
            loading: this.inflight !== undefined || status.state === 'loading' || workspaces.state === 'loading',
            error: status.error?.message ?? workspaces.error?.message ?? null,
        };
    }
    refresh(signal) {
        if (this.disposed)
            return Promise.reject(Error('Work catalog disposed'));
        if (signal?.aborted)
            return Promise.reject(new DOMException('Reader cancelled', 'AbortError'));
        if (this.inflight === undefined) {
            this.inflight = Promise.all([this.sessions.refresh(), this.workspaces.refresh()]).then(() => {
                if (this.disposed)
                    throw Error('Work catalog disposed');
                const error = this.sessions.catalogStatus().error ?? this.workspaces.list.getSnapshot().error;
                if (error !== null)
                    throw Error(`${error.code}: ${error.message}`);
            }).finally(() => { this.inflight = undefined; this.changed(); });
            this.changed();
        }
        return readerWait(this.inflight, signal);
    }
    activeId(id) {
        if (this.disposed)
            throw Error('Work catalog disposed');
        if (id.trim() === '')
            throw Error('Session id cannot be empty');
        return (0, types_1.SessionId)(id);
    }
    async rename(id, title) {
        valueOf((await this.api.sessions.rename({ sessionId: this.activeId(id), title })).result);
        await this.sessions.refresh();
    }
    async archive(id) { await this.workspaces.archiveSession(this.activeId(id)); await this.sessions.refresh(); }
    async unarchive(id) {
        valueOf((await this.api.workspace.unarchiveSession({ sessionId: this.activeId(id) })).result);
        await this.refresh();
    }
    async fork(id) { await this.sessions.fork({ sessionId: this.activeId(id) }); await this.refresh(); }
    async deleteArchived(id) {
        const result = valueOf((await this.api.sessions.delete({ sessionId: this.activeId(id) })).result);
        // Idempotent false means already absent, not an invitation to re-run deletion.
        if (typeof result.deleted !== 'boolean')
            throw Error('Invalid delete result');
        // Publish Host-confirmed tombstones before any baseline read. A pending
        // pre-delete refresh or a missing stream frame cannot resurrect these ids.
        if (this.disposed)
            return;
        const deletedIds = [...new Set([(0, types_1.SessionId)(id), ...(result.deletedSessionIds ?? [])])];
        this.sessions.forgetDeletedSessions(deletedIds);
        this.workspaces.forgetDeletedSessions(deletedIds);
        this.changed();
        // The mutation has committed; reconciliation errors belong to the feed,
        // not to the deletion result, and must not stall a bulk delete.
        void this.refresh().catch(() => { });
    }
    dispose() { this.disposed = true; for (const unsubscribe of this.unsubscribers)
        unsubscribe(); }
}
exports.WorkCatalog = WorkCatalog;

},
"src/modules/client-connection/contracts/core/session/surface.js": function(module, exports, require) {
// source: src/modules/client-connection/contracts/core/session/surface.ts

"use strict";
/**
 * Surface layer on top of the session event log: an ordered view of events
 * that produce LLM messages. The append-only log remains the source of truth.
 *
 * Browser-safe: web clients consume this subpath export, so it must stay free
 * of `node:` imports (they break the vite bundle).
 *
 * @module @xharness/dsh-client-connection/contracts/core/session/surface
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SurfaceManager = void 0;
exports.isSurfaceEligibleType = isSurfaceEligibleType;
exports.isSurfaceEvent = isSurfaceEvent;
exports.isAppendSurfaceEvent = isAppendSurfaceEvent;
exports.isReplacementSurfaceEvent = isReplacementSurfaceEvent;
exports.deriveEventMessage = deriveEventMessage;
exports.foldSurface = foldSurface;
/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = new Set([
    'user/message',
    'assistant/message',
    'tool/result',
]);
/**
 * Whether an event type can join the model-visible surface.
 * @param type - event type to test.
 * @returns true for one of the three message-producing event types.
 */
function isSurfaceEligibleType(type) {
    return SURFACE_EVENT_TYPES.has(type);
}
function isSurfaceEvent(event) {
    return (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
        && event.surfaceOp !== undefined;
}
function isAppendSurfaceEvent(event) {
    return isSurfaceEvent(event) && event.surfaceOp === 'append';
}
function isReplacementSurfaceEvent(event) {
    return isSurfaceEvent(event) && event.surfaceOp !== 'append';
}
function deriveEventMessage(event) {
    if (event.type === 'user/message')
        return isWireMessage(event.data) ? event.data : null;
    if ((event.type === 'assistant/message' || event.type === 'tool/result') && isRecord(event.data)) {
        const message = event.data.message;
        if (!isWireMessage(message))
            return null;
        if (event.type === 'assistant/message' && message.content.length === 0)
            return null;
        return message;
    }
    return null;
}
function isWireMessage(value) {
    return isRecord(value) && typeof value.id === 'string'
        && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
        && isRecord(value.source) && typeof value.source.kind === 'string'
        && isUnknownArray(value.content) && value.content.every(block => isRecord(block) && typeof block.type === 'string');
}
/** Create an empty surface fold state. */
function createFoldState() {
    return { nodes: [], replaceGeneration: 0 };
}
/** Whether a runtime value is a non-negative safe event sequence. */
function isEventSeq(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value) {
    return Object.keys(value).length === 3
        && Object.hasOwn(value, 'op')
        && Object.hasOwn(value, 'start')
        && Object.hasOwn(value, 'end')
        && 'op' in value && value.op === 'replace'
        && 'start' in value && isEventSeq(value.start)
        && 'end' in value && isEventSeq(value.end);
}
/** Validate event-local surface eligibility and return its operation. */
function surfaceOpOf(event) {
    const surfaceOp = 'surfaceOp' in event ? event.surfaceOp : undefined;
    const sourceEventSeqs = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined;
    if (!isSurfaceEligibleType(event.type)) {
        if (surfaceOp !== undefined) {
            throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
        }
        if (sourceEventSeqs !== undefined) {
            throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
        }
        return;
    }
    const op = surfaceOp;
    if (op === undefined) {
        throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
    }
    if (op === 'append')
        return op;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
        throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
    }
    if (!isReplaceOp(op)) {
        throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
    }
    return op;
}
/** Validate cited source-event seqs against prior log entries and the replacement range. */
function assertProvenance(event, shadowedSeqs) {
    const raw = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined;
    const sources = new Set();
    if (raw !== undefined) {
        if (!isUnknownArray(raw)) {
            throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`);
        }
        if (raw.length === 0 && event.type !== 'assistant/message') {
            throw new Error('sourceEventSeqs must not be empty except on assistant/message');
        }
        let nonEarlierSource;
        for (const source of raw) {
            if (!isEventSeq(source)) {
                throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`);
            }
            sources.add(source);
            if (nonEarlierSource === undefined && source >= event.seq)
                nonEarlierSource = source;
        }
        if (sources.size !== raw.length) {
            throw new Error('sourceEventSeqs must not contain duplicates');
        }
        if (nonEarlierSource !== undefined) {
            throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`);
        }
    }
    const missing = shadowedSeqs.filter(seq => !sources.has(seq));
    if (missing.length > 0) {
        throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
    }
}
/** Locate one replacement range without mutating the current fold state. */
function replacementRange(state, op) {
    const startIdx = state.nodes.indexOf(op.start);
    if (startIdx === -1) {
        throw new Error(`surface replace: start seq ${op.start} not found in surface`);
    }
    const endIdx = state.nodes.indexOf(op.end);
    if (endIdx === -1) {
        throw new Error(`surface replace: end seq ${op.end} not found in surface`);
    }
    if (startIdx > endIdx) {
        throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`);
    }
    return {
        startIdx,
        endIdx,
        shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
    };
}
/**
 * Deep structural equality over the session-event JSON value domain
 * (null/boolean/number/string, arrays, plain objects). Replaces
 * `node:util`'s isDeepStrictEqual to keep this module browser-safe.
 */
function isDeepEqualJson(a, b) {
    if (a === b)
        return true;
    if (isUnknownArray(a) || isUnknownArray(b)) {
        if (!isUnknownArray(a) || !isUnknownArray(b) || a.length !== b.length)
            return false;
        return a.every((item, i) => isDeepEqualJson(item, b[i]));
    }
    if (!isRecord(a) || !isRecord(b))
        return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length)
        return false;
    return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson(a[key], b[key]));
}
/** Restrict a tool-result replacement to one current result's content. */
function assertToolResultRewrite(event, shadowedSeqs, events, baseSeq) {
    if (event.type !== 'tool/result')
        return;
    if (!isRewriteData(event.data))
        throw new Error('tool/result surface replacement has invalid message data');
    if (shadowedSeqs.length !== 1) {
        throw new Error('tool/result surface replacement must rewrite exactly one current node');
    }
    for (const originalSeq of shadowedSeqs) {
        const original = events[originalSeq - baseSeq];
        if (original?.type !== 'tool/result' || !isRewriteData(original.data)) {
            throw new Error('tool/result surface replacement must target a current tool/result');
        }
        const originalRest = { ...original.data };
        const replacementRest = { ...event.data };
        const originalResult = original.data.message.content[0];
        const replacementResult = event.data.message.content[0];
        originalRest['message'] = {
            ...original.data.message,
            content: [{ ...originalResult, content: null }],
        };
        replacementRest['message'] = {
            ...event.data.message,
            content: [{ ...replacementResult, content: null }],
        };
        if (!isDeepEqualJson(originalRest, replacementRest)) {
            throw new Error('tool/result surface replacement may change only content');
        }
    }
}
/** Validate one event at its replay boundary and prepare its atomic fold transition. */
function planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {
    if (event.seq !== expectedSeq) {
        throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
    }
    const surfaceOp = surfaceOpOf(event);
    if (surfaceOp === undefined)
        return;
    if (surfaceOp === 'append') {
        assertProvenance(event, []);
        return { kind: 'append', seq: event.seq };
    }
    const range = replacementRange(state, surfaceOp);
    assertProvenance(event, range.shadowedSeqs);
    assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);
    return {
        kind: 'replace',
        seq: event.seq,
        start: surfaceOp.start,
        end: surfaceOp.end,
        ...range,
    };
}
/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(state, event, expectedSeq, events, baseSeq) {
    const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq);
    return applySurfacePlan(state, plan);
}
/** Commit one previously validated surface transition. */
function applySurfacePlan(state, plan) {
    if (plan?.kind === 'append') {
        state.nodes.push(plan.seq);
    }
    else if (plan?.kind === 'replace') {
        state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
        state.replaceGeneration += 1;
    }
    if (plan?.kind !== 'replace')
        return;
    return {
        seq: plan.seq,
        start: plan.start,
        end: plan.end,
        shadowedSeqs: plan.shadowedSeqs,
    };
}
/**
 * Replay a complete session log through the canonical surface fold.
 * @param events - session events in contiguous seq order.
 * @returns detached current sequences and replacement history.
 * @throws when an event violates surface metadata, source-event references, range, or tool-result rewrite rules.
 */
function foldSurface(events) {
    const state = createFoldState();
    const replacements = [];
    for (const [index, event] of events.entries()) {
        const replacement = applySurfaceEvent(state, event, index, events, 0);
        if (replacement !== undefined)
            replacements.push(replacement);
    }
    return { nodes: [...state.nodes], replacements };
}
/** Incremental ordered surface view and append-boundary validator. */
class SurfaceManager {
    /**
     * @param log - Contiguous complete log or loaded event window.
     * @param baseSeq - Absolute sequence of the window's first event.
     */
    constructor(log, baseSeq = 0) {
        this.log = log;
        this.baseSeq = baseSeq;
        /** Shared transition state; replacement history is not retained. */
        this._state = createFoldState();
        this._lastProcessedSeq = baseSeq - 1;
    }
    /**
     * Validate the next candidate without mutating the committed surface.
     * @param event - candidate event that has not entered the log yet.
     */
    validateNext(event) {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        const expectedSeq = this.baseSeq + this.log.length;
        this._pendingPlan = {
            event,
            expectedSeq,
            plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq),
        };
    }
    /** Monotonic count of folded positional replacements. */
    get replaceGeneration() {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        return this._state.replaceGeneration;
    }
    /** Surface event sequences in model-visible order. */
    get nodes() {
        if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1)
            this._processDelta();
        return this._state.nodes;
    }
    /** Fold events appended since the previous access. */
    _processDelta() {
        const tailSeq = this.baseSeq + this.log.length - 1;
        for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
            const index = seq - this.baseSeq;
            // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
            const event = this.log[index];
            if (event === undefined)
                throw new Error(`missing event at seq ${seq}`);
            const pending = this._pendingPlan;
            if (pending?.event === event && pending.expectedSeq === seq) {
                applySurfacePlan(this._state, pending.plan);
            }
            else {
                applySurfaceEvent(this._state, event, seq, this.log, this.baseSeq);
            }
            if (pending !== undefined && pending.expectedSeq <= seq)
                this._pendingPlan = undefined;
            this._lastProcessedSeq = seq;
        }
    }
}
exports.SurfaceManager = SurfaceManager;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isUnknownArray(value) { return Array.isArray(value); }
function isRewriteData(value) {
    return isRecord(value) && isRecord(value.message) && isUnknownArray(value.message.content)
        && isRecord(value.message.content[0]);
}

},
"src/modules/client-runtime/sessions/subagent-lineage.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/subagent-lineage.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.indexSubagentDescendants = indexSubagentDescendants;
/**
 * Index every subagent descendant under each ancestor it reaches through an
 * uninterrupted subagent-origin chain. Cycles fail soft and orphan owners
 * remain harmless map keys until their summaries arrive.
 * @param summaries - retained session summaries keyed by id.
 * @returns descendant totals and running totals keyed by possible parent id.
 */
function indexSubagentDescendants(summaries) {
    const indexed = new Map();
    for (const key in summaries) {
        const descendant = summaries[key];
        if (descendant === undefined)
            continue;
        if (descendant.origin !== 'subagent')
            continue;
        const seen = new Set();
        let current = descendant;
        while (current?.origin === 'subagent' && current.parentId !== undefined
            && !seen.has(current.id)) {
            seen.add(current.id);
            const aggregate = indexed.get(current.parentId);
            if (aggregate === undefined) {
                indexed.set(current.parentId, {
                    count: 1,
                    runningCount: descendant.running ? 1 : 0,
                });
            }
            else {
                aggregate.count += 1;
                if (descendant.running)
                    aggregate.runningCount += 1;
            }
            current = summaries[current.parentId];
        }
    }
    return indexed;
}

},
"src/modules/client-runtime/workspaces/path.js": function(module, exports, require) {
// source: src/modules/client-runtime/workspaces/path.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkspacePath = resolveWorkspacePath;
exports.abbreviateHomePath = abbreviateHomePath;
/**
 * Resolve a workspace-relative path into the Host-facing spelling used by openPath.
 * @param cwd - session workspace root, when known.
 * @param path - absolute or workspace-relative path.
 * @returns an absolute path when a workspace root is available, otherwise the original path.
 */
function resolveWorkspacePath(cwd, path) {
    if (path.startsWith('/') || isWindowsStylePath(path))
        return path;
    if (cwd === undefined || cwd === '')
        return path;
    const base = cwd.replace(/[/\\]+$/, '');
    const rel = path.replace(/^[/\\]+/, '');
    return `${base}/${rel}`;
}
/** Drive-letter or UNC path; Web display must not rewrite these as `~`. */
function isWindowsStylePath(value) {
    return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\');
}
/**
 * Display-only POSIX home abbreviation. Windows drive and UNC paths stay
 * verbatim, including when `home` itself is a Windows path. A missing, empty,
 * or filesystem-root `home` leaves `path` unchanged so `/` cannot become `~`.
 * @param path - absolute or already-short display path.
 * @param home - host account home from `host.describe`; absent skips abbreviation.
 * @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
 */
function abbreviateHomePath(path, home) {
    if (home === undefined || home === '')
        return path;
    if (isWindowsStylePath(path) || isWindowsStylePath(home))
        return path;
    const root = home.replace(/\/+$/, '');
    if (root === '' || root === '/')
        return path;
    if (path.replace(/\/+$/, '') === root)
        return '~';
    if (path.startsWith(`${root}/`))
        return `~${path.slice(root.length)}`;
    return path;
}

},
"src/modules/client-runtime/sessions/partial.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/partial.ts

"use strict";
// PartialAccumulator: assistant/chunk accumulator.
// Folds the six StreamChunk variants into AssistantBlock[] keyed by block index;
// block-level immutability (a delta only swaps that block's reference).
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartialAccumulator = void 0;
exports.isVisibleAssistantChunk = isVisibleAssistantChunk;
exports.emptyAssistantBlock = emptyAssistantBlock;
const conversation_1 = require("./conversation");
/**
 * Whether a stream chunk changes the partial assistant projection shown by the UI.
 * @param type - Stream chunk discriminant.
 * @returns Whether publishing the accumulated partial can change the visible snapshot.
 */
function isVisibleAssistantChunk(type) {
    return type === 'block-start'
        || type === 'text-delta'
        || type === 'reasoning-delta'
        || type === 'tool-call-delta'
        || type === 'block-end';
}
/** assistant/chunk accumulator: folds StreamChunks into AssistantBlock[] with block-level immutability. */
class PartialAccumulator {
    /**
     * @param turn - Owning agent turn.
     * @param step - Owning model step.
     * @param initialBlocks - Materialized prefix when accumulation begins after history replay.
     */
    constructor(turn, step, initialBlocks = []) {
        this.turn = turn;
        this.step = step;
        // Sparse on purpose: block-start may arrive out of order, leaving holes until compaction.
        this.blocks = [];
        this.changed = true;
        this.blocks = [...initialBlocks];
        this.snapshot = { turn, step, blocks: initialBlocks };
    }
    /**
     * Fold one chunk.
     * @param chunk - the stream chunk.
     * @returns whether it caused a visible change (usage/finish return false, skipping notification).
     */
    push(chunk) {
        switch (chunk.type) {
            case 'block-start': {
                this.blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
                this.changed = true;
                return true;
            }
            case 'text-delta': {
                const prev = this.blocks[chunk.index];
                this.blocks[chunk.index] = { kind: 'text', text: (prev?.kind === 'text' ? prev.text : '') + chunk.text };
                this.changed = true;
                return true;
            }
            case 'reasoning-delta': {
                const prev = this.blocks[chunk.index];
                this.blocks[chunk.index] = { kind: 'reasoning', text: (prev?.kind === 'reasoning' ? prev.text : '') + chunk.text };
                this.changed = true;
                return true;
            }
            case 'tool-call-delta': {
                const prev = this.blocks[chunk.index];
                const base = prev?.kind === 'tool-call' ? prev : { kind: 'tool-call', callId: '', name: '', argsRaw: '' };
                this.blocks[chunk.index] = {
                    kind: 'tool-call',
                    callId: base.callId || String(chunk.id),
                    name: chunk.name ?? base.name,
                    argsRaw: base.argsRaw + chunk.argumentsDelta,
                };
                this.changed = true;
                return true;
            }
            case 'block-end': {
                this.blocks[chunk.index] = (0, conversation_1.toAssistantBlock)(chunk.block);
                this.changed = true;
                return true;
            }
            default:
                // usage / finish / merge-extensible unknown variants: no visible block change
                // (finish is immediately followed by the assistant/message that supersedes the partial).
                return false;
        }
    }
    /**
     * Current partial projection.
     * @returns the cached snapshot (the blocks array reference only changes after a mutation).
     */
    toPartial() {
        if (this.changed) {
            // Compact sparse indexes (out-of-order block-start) into render order.
            this.snapshot = { turn: this.turn, step: this.step, blocks: this.blocks.filter((b) => b !== undefined) };
            this.changed = false;
        }
        return this.snapshot;
    }
}
exports.PartialAccumulator = PartialAccumulator;
/**
 * Create the empty client projection for one streamed Assistant block kind.
 * @param blockType - wire block kind.
 * @returns empty projected block ready to receive deltas.
 */
function emptyAssistantBlock(blockType) {
    switch (blockType) {
        case 'text': return { kind: 'text', text: '' };
        case 'reasoning': return { kind: 'reasoning', text: '' };
        case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' };
        default: return { kind: 'other', block: null };
    }
}

},
"src/modules/client-runtime/sessions/assistant-timing.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/assistant-timing.ts

"use strict";
// Shared assistant step-timing fold: Chat Definitions and the Trajectory
// history fold derive AssistantTiming from the same step/start -> first token
// delta -> assistant/message sequence.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTokenDelta = isWireTokenDelta;
exports.assistantStepKey = assistantStepKey;
exports.indexAssistantStepTiming = indexAssistantStepTiming;
exports.settledAssistantTiming = settledAssistantTiming;
const value_guards_1 = require("../value-guards");
/**
 * Composite map key for one assistant step.
 * @param turn - turn number from the event payload.
 * @param step - step number from the event payload.
 * @returns collision-free `turn`/`step` key (NUL separator).
 */
function assistantStepKey(turn, step) {
    return `${turn}\u0000${step}`;
}
/**
 * Fold one event into the per-step timing index: step/start opens the entry,
 * the first non-empty token delta stamps first-token time once. Other event
 * types are no-ops.
 * @param steps - the mutable per-step index, keyed by {@link assistantStepKey}.
 * @param event - the raw window event.
 */
function indexAssistantStepTiming(steps, event) {
    const data = event.data;
    if (!(0, value_guards_1.isRecord)(data) || typeof data.turn !== 'number' || typeof data.step !== 'number')
        return;
    if (event.type === 'step/start') {
        steps.set(assistantStepKey(data.turn, data.step), { stepStartTime: event.time, firstTokenTime: null });
    }
    else if (event.type === 'assistant/chunk' && isWireTokenDelta(data.chunk)) {
        const key = assistantStepKey(data.turn, data.step);
        const current = steps.get(key) ?? { stepStartTime: null, firstTokenTime: null };
        if (current.firstTokenTime === null) {
            steps.set(key, { ...current, firstTokenTime: event.time });
        }
    }
}
/**
 * Settle one finalized assistant message's timing from its step entry; a step
 * whose start or first token fell outside the window yields null boundaries.
 * @param steps - the per-step index built by {@link indexAssistantStepTiming}.
 * @param turn - the assistant/message turn number.
 * @param step - the assistant/message step number.
 * @param completedTime - the assistant/message event timestamp (epoch ms).
 * @returns the node-ready timing record.
 */
function settledAssistantTiming(steps, turn, step, completedTime) {
    return {
        ...(steps.get(assistantStepKey(turn, step)) ?? { stepStartTime: null, firstTokenTime: null }),
        completedTime,
    };
}
function isWireTokenDelta(chunk) {
    if (!(0, value_guards_1.isRecord)(chunk))
        return false;
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta': return typeof chunk.text === 'string' && chunk.text !== '';
        case 'tool-call-delta': return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || typeof chunk.name === 'string';
        default: return false;
    }
}

},
"src/modules/client-runtime/sessions/context-provenance.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/context-provenance.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionRecallLabels = sessionRecallLabels;
exports.contextProvenance = contextProvenance;
exports.contextForm = contextForm;
const value_guards_1 = require("../value-guards");
/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value) {
    return (0, value_guards_1.isRecord)(value) && !Array.isArray(value)
        ? value
        : null;
}
/** A record field read as a non-empty string, or null. */
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}
/** Distinct non-empty `field` values of an array-valued source member, in first-seen order. */
function collect(source, member, field) {
    const list = source[member];
    if (!(0, value_guards_1.isUnknownArray)(list))
        return [];
    const seen = [];
    for (const entry of list) {
        const record = asRecord(entry);
        const value = record === null ? null : readString(record, field);
        if (value !== null && !seen.includes(value))
            seen.push(value);
    }
    return seen;
}
/** A collected name list rendered as one label; null when the list is empty. */
function joined(names) {
    return names.length > 0 ? names.join(', ') : null;
}
/**
 * The referenced-session labels of one durable `session-reference` recall
 * source, in first-seen order; empty for every other source shape, including
 * a foreign or older log whose reference entries carry no readable label.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns distinct non-empty reference labels.
 */
function sessionRecallLabels(source) {
    const record = asRecord(source);
    if (record === null || readString(record, 'kind') !== 'session-reference')
        return [];
    return collect(record, 'references', 'label');
}
/**
 * Project one durable message source onto its transcript role and producer name.
 *
 * The source arrives over the wire as opaque JSON (`MessageSource` is
 * merge-extensible, so no client-side union can be exhaustive), and a durable
 * log may predate or postdate this UI; every unreadable shape therefore
 * degrades to `inject` with whatever name the record still carries.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the role and producer name to present for this context.
 */
function contextProvenance(source) {
    const record = asRecord(source);
    const kind = record === null ? null : readString(record, 'kind');
    if (record === null || kind === null)
        return { role: 'inject', label: null };
    switch (kind) {
        // Cross-session snapshots are the one durable source that carries another
        // session's material; its references name the sessions they were read from.
        case 'session-reference':
            return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind };
        // Workspace instructions name the files they were reconciled from, which
        // identifies the producer far better than the plugin id would.
        case 'agent-instructions':
            return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind };
        case 'plugin':
            return { role: 'inject', label: readString(record, 'plugin') ?? kind };
        // A user-explicit skill invocation names the skill it injected.
        case 'skill-invocation':
            return { role: 'inject', label: readString(record, 'name') ?? kind };
        // Documented default arm of the merge-extensible source map: an unknown
        // producer still identifies itself by its own durable kind.
        default:
            return { role: 'inject', label: kind };
    }
}
/**
 * Context forms this UI version renders with a dedicated presentation. The
 * durable vocabulary (`ContextForm` in `dsh-llm`) may already be wider — an
 * unrecognized or absent value degrades to the opaque presentation rather than
 * dropping the row, so a log written by a newer or foreign producer still
 * renders.
 */
const KNOWN_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'];
/**
 * Read the producer-declared form off one durable message source.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the form when this UI version presents it, otherwise null (opaque).
 */
function contextForm(source) {
    const record = asRecord(source);
    const form = record === null ? null : readString(record, 'form');
    return KNOWN_FORMS.find(known => known === form) ?? null;
}

},
"src/modules/client-runtime/sessions/failure-display.js": function(module, exports, require) {
// source: src/modules/client-runtime/sessions/failure-display.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.displayFailureMessage = displayFailureMessage;
/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 * @param failure - Failure value preserved by the session event.
 * @returns Display-safe copy for client projections.
 */
function displayFailureMessage(failure) {
    if (failure === null || typeof failure !== 'object')
        return String(failure);
    const code = 'code' in failure ? failure.code : undefined;
    const message = 'message' in failure ? failure.message : undefined;
    // Provider AUTH messages may echo a masked or partially preserved credential.
    // Keep the raw diagnostic in the session log, but never project it into UI state.
    if (code === 'AUTH')
        return 'API key is invalid';
    return typeof message === 'string' ? message : JSON.stringify(failure);
}

}
};
const __dependencies = {"src/modules/client-runtime/index.js":{"./slots":"src/modules/client-runtime/slots.js","./sessions/service":"src/modules/client-runtime/sessions/service.js","./workspaces/service":"src/modules/client-runtime/workspaces/service.js","./conversation/event-registry":"src/modules/client-runtime/conversation/event-registry.js","./conversation/view-registry":"src/modules/client-runtime/conversation/view-registry.js","./work/catalog":"src/modules/client-runtime/work/catalog.js","../client-connection/contracts/core/session/surface":"src/modules/client-connection/contracts/core/session/surface.js","./sessions/conversation-assembler":"src/modules/client-runtime/sessions/conversation-assembler.js","./sessions/conversation-location-index":"src/modules/client-runtime/sessions/conversation-location-index.js","./contract/conversation":"src/modules/client-runtime/contract/conversation.js","./sessions/subagent-lineage":"src/modules/client-runtime/sessions/subagent-lineage.js","./sessions/provide":"src/modules/client-runtime/sessions/provide.js","./agents/scope":"src/modules/client-runtime/agents/scope.js","./workspaces/path":"src/modules/client-runtime/workspaces/path.js","./contract/store":"src/modules/client-runtime/contract/store.js","./sessions/conversation":"src/modules/client-runtime/sessions/conversation.js","./sessions/partial":"src/modules/client-runtime/sessions/partial.js","./sessions/assistant-timing":"src/modules/client-runtime/sessions/assistant-timing.js","./sessions/context-provenance":"src/modules/client-runtime/sessions/context-provenance.js","./sessions/failure-display":"src/modules/client-runtime/sessions/failure-display.js","./sessions/pending":"src/modules/client-runtime/sessions/pending.js"},"src/modules/client-runtime/slots.js":{"./value-guards":"src/modules/client-runtime/value-guards.js","./context":"src/modules/client-runtime/context.js"},"src/modules/client-runtime/value-guards.js":{},"src/modules/client-runtime/context.js":{},"src/modules/client-runtime/sessions/service.js":{"../../client-connection/contracts/host/apiproxy/api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","../../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","../../client-connection/contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","../contract/store":"src/modules/client-runtime/contract/store.js","../agents/scope":"src/modules/client-runtime/agents/scope.js","./manager":"src/modules/client-runtime/sessions/manager.js","./provide":"src/modules/client-runtime/sessions/provide.js"},"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js":{"./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js":{},"src/modules/client-connection/contracts/core/session/types.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/index.js":{"./rpc":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js","./rpc.schema":"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js","./session-search":"src/modules/client-connection/contracts/host/apiproxy/api/session-search.js"},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.js":{},"src/modules/client-connection/contracts/host/apiproxy/api/rpc.schema.js":{},"src/modules/client-runtime/contract/store.js":{"./state-engine":"src/modules/client-runtime/contract/state-engine.js","immer":"vendor/immer.js","../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/contract/state-engine.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"vendor/immer.js":{},"src/modules/client-runtime/agents/scope.js":{"../../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","../context":"src/modules/client-runtime/context.js"},"src/modules/client-runtime/sessions/manager.js":{"../../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","../value-guards":"src/modules/client-runtime/value-guards.js","../../client-connection/contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","../ordered-baseline":"src/modules/client-runtime/ordered-baseline.js","./lineage":"src/modules/client-runtime/sessions/lineage.js","./notifier":"src/modules/client-runtime/sessions/notifier.js","./projection-store":"src/modules/client-runtime/sessions/projection-store.js","./session":"src/modules/client-runtime/sessions/session.js","./history-cache":"src/modules/client-runtime/sessions/history-cache.js"},"src/modules/client-runtime/ordered-baseline.js":{},"src/modules/client-runtime/sessions/lineage.js":{},"src/modules/client-runtime/sessions/notifier.js":{},"src/modules/client-runtime/sessions/projection-store.js":{"../value-guards":"src/modules/client-runtime/value-guards.js","./notifier":"src/modules/client-runtime/sessions/notifier.js"},"src/modules/client-runtime/sessions/session.js":{"./chat-snapshot-codec":"src/modules/client-runtime/sessions/chat-snapshot-codec.js","../../shared/session-terminal":"src/modules/shared/session-terminal.js","../../client-connection/contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","./conversation-assembler":"src/modules/client-runtime/sessions/conversation-assembler.js","./pending":"src/modules/client-runtime/sessions/pending.js","./notifier":"src/modules/client-runtime/sessions/notifier.js","./projection-store":"src/modules/client-runtime/sessions/projection-store.js","../time-zone":"src/modules/client-runtime/time-zone.js","./queue-mirror":"src/modules/client-runtime/sessions/queue-mirror.js","./active-working-set":"src/modules/client-runtime/sessions/active-working-set.js","./cooperative-delivery":"src/modules/client-runtime/sessions/cooperative-delivery.js"},"src/modules/client-runtime/sessions/chat-snapshot-codec.js":{"../../shared/compaction-outcome":"src/modules/shared/compaction-outcome.js","../../client-connection/contracts/host/apiproxy/api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js","../value-guards":"src/modules/client-runtime/value-guards.js","./conversation":"src/modules/client-runtime/sessions/conversation.js"},"src/modules/shared/compaction-outcome.js":{},"src/modules/client-runtime/sessions/conversation.js":{"../value-guards":"src/modules/client-runtime/value-guards.js","../../client-connection/contracts/host/apiproxy/api/sessions.schema":"src/modules/client-connection/contracts/host/apiproxy/api/sessions.schema.js"},"src/modules/shared/session-terminal.js":{"./generated/session-terminal":"src/modules/shared/generated/session-terminal.js"},"src/modules/shared/generated/session-terminal.js":{},"src/modules/client-runtime/sessions/conversation-assembler.js":{"../contract/conversation":"src/modules/client-runtime/contract/conversation.js","../value-guards":"src/modules/client-runtime/value-guards.js","./conversation-location-index":"src/modules/client-runtime/sessions/conversation-location-index.js"},"src/modules/client-runtime/contract/conversation.js":{},"src/modules/client-runtime/sessions/conversation-location-index.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/pending.js":{},"src/modules/client-runtime/time-zone.js":{},"src/modules/client-runtime/sessions/queue-mirror.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/active-working-set.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/cooperative-delivery.js":{},"src/modules/client-runtime/sessions/history-cache.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/provide.js":{},"src/modules/client-runtime/workspaces/service.js":{"./epoch":"src/modules/client-runtime/workspaces/epoch.js","../contract/store":"src/modules/client-runtime/contract/store.js","./manager":"src/modules/client-runtime/workspaces/manager.js"},"src/modules/client-runtime/workspaces/epoch.js":{},"src/modules/client-runtime/workspaces/manager.js":{"../../client-connection/contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","../sessions/notifier":"src/modules/client-runtime/sessions/notifier.js","./workspace":"src/modules/client-runtime/workspaces/workspace.js"},"src/modules/client-runtime/workspaces/workspace.js":{"../../client-connection/contracts/host/apiproxy/api/index":"src/modules/client-connection/contracts/host/apiproxy/api/index.js","../sessions/notifier":"src/modules/client-runtime/sessions/notifier.js"},"src/modules/client-runtime/conversation/event-registry.js":{"./definition-registry":"src/modules/client-runtime/conversation/definition-registry.js"},"src/modules/client-runtime/conversation/definition-registry.js":{"../context":"src/modules/client-runtime/context.js"},"src/modules/client-runtime/conversation/view-registry.js":{"./definition-registry":"src/modules/client-runtime/conversation/definition-registry.js"},"src/modules/client-runtime/work/catalog.js":{"../../client-connection/contracts/core/session/types":"src/modules/client-connection/contracts/core/session/types.js","../sessions/notifier":"src/modules/client-runtime/sessions/notifier.js"},"src/modules/client-connection/contracts/core/session/surface.js":{},"src/modules/client-runtime/sessions/subagent-lineage.js":{},"src/modules/client-runtime/workspaces/path.js":{},"src/modules/client-runtime/sessions/partial.js":{"./conversation":"src/modules/client-runtime/sessions/conversation.js"},"src/modules/client-runtime/sessions/assistant-timing.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/context-provenance.js":{"../value-guards":"src/modules/client-runtime/value-guards.js"},"src/modules/client-runtime/sessions/failure-display.js":{}};
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
return __load("src/modules/client-runtime/index.js");
}
});
