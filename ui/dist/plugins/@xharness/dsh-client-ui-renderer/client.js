// Generated from src/modules/renderer/index.ts; do not edit.
window.__ModuleLoader__.load({
id: "@xharness/dsh-client-ui-renderer",
factory: (__externalRequire) => {
const __units = {
"src/modules/renderer/index.js": function(module, exports, require) {
// source: src/modules/renderer/index.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/// <reference path="./externals.d.ts" />
/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const client_1 = require("react-dom/client");
const scoped_slots_1 = require("./scoped-slots");
const app_1 = require("./app");
/** Services required before application assembly. */
exports.inject = ['slots', 'sessions'];
/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props) {
    const [ready, setReady] = (0, react_1.useState)(false);
    (0, react_1.useLayoutEffect)(() => { setReady(true); }, []);
    if (ready)
        return props.app();
    return (0, react_1.createElement)('div', {
        className: props.boot.className,
        'data-dsh-boot': '',
        dangerouslySetInnerHTML: { __html: props.boot.html },
    });
}
/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container, app) {
    const boot = container.querySelector(':scope > [data-dsh-boot]');
    if (boot !== null) {
        return (0, client_1.hydrateRoot)(container, (0, react_1.createElement)(BootHandoff, {
            app,
            boot: { className: boot.className, html: boot.innerHTML },
        }));
    }
    const root = (0, client_1.createRoot)(container);
    (0, react_dom_1.flushSync)(() => { root.render(app()); });
    return root;
}
/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
function apply(ctx) {
    ctx.slots.install((0, scoped_slots_1.createSlotRenderer)());
    ctx.reflect.provide('uiRenderer', {
        mount: (container) => {
            const root = mountApp(container, (0, app_1.buildRenderApp)({ ctx }));
            return () => { root.unmount(); };
        },
    });
}

},
"src/modules/renderer/scoped-slots.js": function(module, exports, require) {
// source: src/modules/renderer/scoped-slots.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSlotRenderer = createSlotRenderer;
exports.boundRenderSlot = boundRenderSlot;
exports.boundRenderSlotChain = boundRenderSlotChain;
exports.bindInjectHooks = bindInjectHooks;
exports.cachedSlotInject = cachedSlotInject;
exports.cachedRootInject = cachedRootInject;
exports.cachedSessionInject = cachedSessionInject;
exports.localeSeat = localeSeat;
exports.standardKit = standardKit;
exports.renderOutletContent = renderOutletContent;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_slots_1 = require("@xharness/dsh-client-ui-slots");
/**
 * React renderer for declarative slots. Per-entry bindings enforce child
 * authorization, and entry boundaries contain registrant failures.
 */
const react_1 = require("react");
const session_provider_1 = require("./session-provider");
const runtime_types_1 = require("../shared/runtime-types");
function isSlotHookFactory(value) {
    return typeof value === 'function';
}
function ownedHookDefinitions(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value))
        throw new TypeError('slot hooks must be an object');
    return value;
}
/** Match React's accepted element-type ABI; component props remain unknown.
 * The component's own domain owns its props, not this erased registry seat. */
function isRenderableComponent(value) {
    if (typeof value === 'function' || typeof value === 'string')
        return true;
    if (typeof value === 'symbol')
        return ['react.fragment', 'react.strict_mode', 'react.profiler', 'react.suspense', 'react.suspense_list', 'react.offscreen'].some(tag => value === Symbol.for(tag));
    if (!(0, runtime_types_1.isObjectRecord)(value))
        return false;
    return ['react.memo', 'react.forward_ref', 'react.lazy', 'react.provider', 'react.context'].some(tag => value.$$typeof === Symbol.for(tag));
}
function renderableComponent(value) {
    if (!isRenderableComponent(value))
        throw new TypeError('slot component is not a React element type');
    return value;
}
/**
 * Per-entry renderSlot bindings. The binding is identity-stable per entry
 * (memoized components must not resubscribe on unrelated re-renders) and dies
 * with the entry: a retained closure calling after the entry's disposal hits
 * the in-ledger check and throws.
 */
const renderSlotCache = new WeakMap();
function boundRenderSlot(host, entry) {
    let binding = renderSlotCache.get(entry);
    if (!binding) {
        binding = (key, owner, opts) => {
            if (!host.isLive(entry)) {
                throw new dsh_client_ui_slots_1.StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`);
            }
            // Plain-JS backstop; typed callers are narrowed to the declared keys.
            const declared = entry.children?.[key];
            if (declared === undefined) {
                throw new dsh_client_ui_slots_1.SlotOwnershipError(`slot '${key}' is not declared by this entry's children`);
            }
            if (declared.kind === 'chain') {
                throw new dsh_client_ui_slots_1.SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`);
            }
            return (0, jsx_runtime_1.jsx)(SlotOutlet, { slotKey: key, ownerProps: owner, opts: opts });
        };
        renderSlotCache.set(entry, binding);
    }
    return binding;
}
/**
 * Per-entry renderSlotChain bindings: identity-stable per entry (same cache
 * axis as renderSlot — a per-frame dispatch must not rebuild the binding) and
 * dead with the entry. The chain-kind check is the plain-JS backstop twin of
 * the declaration check; typed callers are narrowed to chain keys.
 */
const renderSlotChainCache = new WeakMap();
function boundRenderSlotChain(host, entry) {
    let binding = renderSlotChainCache.get(entry);
    if (!binding) {
        binding = (key, owner, opts) => {
            if (!host.isLive(entry)) {
                throw new dsh_client_ui_slots_1.StaleAuthorizationError(`renderSlotChain('${key}') from a disposed registration`);
            }
            const declared = entry.children?.[key];
            if (declared === undefined) {
                throw new dsh_client_ui_slots_1.SlotOwnershipError(`slot '${key}' is not declared by this entry's children`);
            }
            if (declared.kind !== 'chain') {
                throw new dsh_client_ui_slots_1.SlotOwnershipError(`slot '${key}' is declared '${declared.kind}', not 'chain' — use renderSlot`);
            }
            return (0, jsx_runtime_1.jsx)(SlotOutlet, { slotKey: key, ownerProps: owner, opts: opts });
        };
        renderSlotChainCache.set(entry, binding);
    }
    return binding;
}
/**
 * Inject results cache: root entries per entry, session entries per
 * (entry x provide bundle). WeakMap keys are entry/info objects (both
 * identity-stable per registration/session scope), so cache lifetime rides
 * the same axes as the values it memoizes.
 */
const rootInjectCache = new WeakMap();
const sessionInjectCache = new WeakMap();
const sessionMaybeInjectCache = new WeakMap();
const EMPTY_INJECTED_PROPS = {};
function runInject(entry, info, actions) {
    const inject = entry.inject;
    if (!inject)
        return EMPTY_INJECTED_PROPS;
    // Declaration-derived positional arguments: sessionId for session scope,
    // baked actions when a store is declared.
    const args = [];
    if (info !== undefined)
        args.push(info.sessionId);
    if (actions !== undefined)
        args.push(actions);
    const face = Reflect.apply(inject, undefined, args);
    if (!(0, runtime_types_1.isObjectRecord)(face))
        throw new TypeError('slot inject must return an object');
    return bindInjectHooks(face);
}
/**
 * Normalize one entry-owned inject face on its existing cache axis. Its hooks
 * compartment remains the original Observable-only contract.
 */
function bindInjectHooks(face) {
    const sources = face['hooks'];
    if (sources === undefined)
        return face;
    const { hooks: _hooks, ...rest } = face;
    const bound = rest;
    for (const [name, source] of Object.entries(ownedHookDefinitions(sources))) {
        const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
        if (!(0, session_provider_1.isHostObservable)(source))
            throw new TypeError('entry inject hook must be an observable');
        bound[hookName] = (0, session_provider_1.observableHook)(source);
    }
    return bound;
}
const slotInjectCache = new WeakMap();
const EMPTY_SLOT_INJECT = { props: EMPTY_INJECTED_PROPS };
/** Normalize one dispatcher-owned inject face by its stable object identity. */
function cachedSlotInject(face) {
    if (face === undefined)
        return EMPTY_SLOT_INJECT;
    let bound = slotInjectCache.get(face);
    if (bound !== undefined)
        return bound;
    if (!(0, runtime_types_1.isObjectRecord)(face))
        throw new TypeError('slot inject must be an object');
    const definitions = face['hooks'];
    if (definitions === undefined) {
        bound = { props: face };
        slotInjectCache.set(face, bound);
        return bound;
    }
    const { hooks: _hooks, ...rest } = face;
    const props = rest;
    let factories;
    for (const [name, definition] of Object.entries(ownedHookDefinitions(definitions))) {
        const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
        if (isSlotHookFactory(definition)) {
            factories ?? (factories = {});
            factories[name] = definition;
        }
        else {
            if (!(0, session_provider_1.isHostObservable)(definition))
                throw new TypeError('slot hook must be a factory or observable');
            props[hookName] = (0, session_provider_1.observableHook)(definition);
        }
    }
    bound = factories === undefined
        ? { props }
        : { props, slotHookFactories: factories };
    slotInjectCache.set(face, bound);
    return bound;
}
/** Bind deferred slot-level factories for one stable renderSlot occurrence. */
function bindSlotHookFactories(factories, standard, hookContext) {
    const hooks = {};
    for (const [name, factory] of Object.entries(factories)) {
        const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
        hooks[hookName] = factory(standard, hookContext);
    }
    return hooks;
}
function cachedRootInject(entry, actions) {
    let props = rootInjectCache.get(entry);
    if (!props) {
        props = runInject(entry, undefined, actions);
        rootInjectCache.set(entry, props);
    }
    return props;
}
function cachedSessionInject(entry, info, actions) {
    let perInfo = sessionInjectCache.get(entry);
    if (!perInfo) {
        perInfo = new WeakMap();
        sessionInjectCache.set(entry, perInfo);
    }
    let props = perInfo.get(info);
    if (!props) {
        props = runInject(entry, info, actions);
        perInfo.set(info, props);
    }
    return props;
}
function cachedSessionMaybeInject(entry, info, actions) {
    let perInfo = sessionMaybeInjectCache.get(entry);
    if (!perInfo) {
        perInfo = new WeakMap();
        sessionMaybeInjectCache.set(entry, perInfo);
    }
    let props = perInfo.get(info);
    if (!props) {
        props = runInject(entry, info, actions);
        perInfo.set(info, props);
    }
    return props;
}
/**
 * Locale `t` seat bindings, cached per (face, namespace, revision). The
 * revision is part of the cache key ON PURPOSE: a locale switch mints a NEW
 * function reference per namespace, so `React.memo` components taking `t`
 * re-render through ordinary shallow comparison — freshness rides identity,
 * no extra invalidation channel. Within one revision the reference is stable
 * (memoized children do not churn on unrelated re-renders).
 */
const localeSeatCache = new WeakMap();
function localeSeat(face, ns) {
    let perNs = localeSeatCache.get(face);
    if (!perNs) {
        perNs = new Map();
        localeSeatCache.set(face, perNs);
    }
    const revision = face.getSnapshot().revision;
    const cached = perNs.get(ns);
    if (cached && cached.revision === revision)
        return cached.t;
    const bound = face.bind(ns);
    // Fresh wrapper per revision: bind() itself may return a stable reference.
    const t = (key, params) => bound(key, params);
    perNs.set(ns, { revision, t });
    return t;
}
const noopSubscribe = () => () => { };
const zeroRevision = () => 0;
/**
 * Per-face subscribe/getSnapshot closure pair. Cached by face identity: the
 * face is one global source shared by every outlet, and uSES resubscribes
 * whenever the subscribe reference changes — fresh closures per render would
 * churn one unsubscribe/resubscribe pair per outlet per render.
 */
const localeSubscriptionCache = new WeakMap();
function localeSubscription(face) {
    let cached = localeSubscriptionCache.get(face);
    if (!cached) {
        cached = {
            subscribe: fn => face.subscribe(fn),
            getRevision: () => face.getSnapshot().revision,
        };
        localeSubscriptionCache.set(face, cached);
    }
    return cached;
}
/**
 * Subscribe an outlet to the installed locale face's revision (0 while none
 * is installed — exactly one uSES call either way, keeping hook order
 * stable). Every outlet re-renders on a locale switch; entry bodies then
 * re-derive their `t` seat at the new revision. The face must be installed
 * before the first render that needs it — a face appearing later has no
 * notification channel to already-mounted outlets.
 */
function useLocaleRevision(face) {
    const subscription = face !== undefined ? localeSubscription(face) : undefined;
    return (0, react_1.useSyncExternalStore)(subscription?.subscribe ?? noopSubscribe, subscription?.getRevision ?? zeroRevision);
}
/**
 * Entry-identity React keys for entry boundaries. An outlet renders one
 * winner per position (single/keyed/list cell head, chain election) through
 * an error boundary; without a key, a boundary that failed on entry A would
 * survive a winner change (re-election, shadowing fallback after an
 * abdication, HMR re-registration) and keep a healthy entry B blacked out.
 * Keying by entry identity remounts the boundary fresh whenever the winner
 * changes (entries are identity-stable per registration, so the key is
 * stable while the same entry stays the winner).
 */
let nextEntryKey = 0;
const entryKeys = new WeakMap();
function entryKeyOf(entry) {
    let key = entryKeys.get(entry);
    if (key === undefined) {
        key = nextEntryKey++;
        entryKeys.set(entry, key);
    }
    return key;
}
/**
 * Per-entry isolation: one registrant crashing (component render or inject
 * factory) must not take down siblings. Assembly errors (missing providers)
 * rethrow — a miswired shell must fail loud, not degrade into fallbacks.
 * Every catch reports through `onEntryError` (the ledger's supervision
 * seam); for shadowing kinds the report abdicates the entry, the outlet
 * re-renders onto the cell's next survivor, and this boundary's crash face
 * only shows until that re-render lands (permanently once the cell is dry —
 * the outlet then owns the crash face).
 */
class SlotErrorBoundary extends react_1.Component {
    constructor() {
        super(...arguments);
        this.state = { failed: false };
    }
    static getDerivedStateFromError(error) {
        if (error instanceof session_provider_1.SlotAssemblyError)
            throw error;
        return { failed: true };
    }
    componentDidCatch(error) {
        console.error(`slot entry crashed in '${this.props.slotKey}':`, error);
        this.props.onEntryError(error);
    }
    render() {
        if (this.state.failed)
            return (0, jsx_runtime_1.jsx)("div", { "data-slot-error": this.props.slotKey });
        return this.props.children;
    }
}
const standardPropsCache = new WeakMap();
/** Stable official-props object used by contextual Hook factories. */
function standardProps(host, scope, info) {
    let cache = standardPropsCache.get(host);
    if (cache === undefined) {
        cache = {
            root: {
                useSessions: (0, session_provider_1.observableHook)(host.sessions.list),
                useWorkspaces: (0, session_provider_1.observableHook)(host.workspaces.list),
            },
            session: new WeakMap(),
            sessionMaybe: new WeakMap(),
        };
        standardPropsCache.set(host, cache);
    }
    if (scope === 'root')
        return cache.root;
    if (info === undefined)
        throw new session_provider_1.SlotAssemblyError(`scope '${scope}' rendered without session provide info`);
    const byInfo = scope === 'session' ? cache.session : cache.sessionMaybe;
    let standard = byInfo.get(info);
    if (standard !== undefined)
        return standard;
    standard = { ...cache.root };
    for (const [name, source] of Object.entries(info.hooks)) {
        const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`;
        if (scope === 'session-maybe') {
            standard[hookName] = (0, session_provider_1.maybeObservableHook)(source);
        }
        else {
            if (source === undefined)
                throw new session_provider_1.SlotAssemblyError(`strict session hook '${name}' has no source`);
            standard[hookName] = (0, session_provider_1.observableHook)(source);
        }
    }
    Object.assign(standard, info.props);
    standard['sessionId'] = info.sessionId;
    standard['useProjection'] = (0, session_provider_1.projectionHook)(info);
    byInfo.set(info, standard);
    return standard;
}
/**
 * Standard-kit synthesis shared by both scope branches: the global
 * useSessions/useWorkspaces hooks, the per-session provide bundle (every
 * `hooks` source becomes a `use<Name>` selector hook — useSession is the
 * runtime's own 'session' contribution, no special case — and `props` spread
 * verbatim), the store pair when declared, the renderSlot binding when
 * children are declared, and the SessionProvider seat when the children
 * declare a session-scope slot. Hosts hand out BARE observable sources
 * (hooks never cross the host contract); every hook is bound HERE, cached
 * per source (observableHook), so spreading a fresh kit object per render
 * never churns child subscriptions.
 */
function standardKit(host, entry, scope, info) {
    const standard = standardProps(host, scope, info);
    const kit = { ...standard };
    if (entry.locale !== undefined) {
        const face = host.locale;
        // Loud assembly failure: locale is immediately-tier infrastructure; a
        // declared namespace with no installed face is a miswired composition.
        if (face === undefined) {
            throw new session_provider_1.SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
        }
        kit['t'] = localeSeat(face, entry.locale);
    }
    const store = scope === 'session-maybe' && info?.sessionId === undefined
        ? undefined
        : host.storeOf(entry, info?.sessionId);
    if (store !== undefined) {
        // The instance IS an observable snapshot source (contract getSnapshot/
        // subscribe); the useStore hook binds here, cached per instance.
        kit['useStore'] = (0, session_provider_1.observableHook)(store);
        kit['actions'] = store.actions;
    }
    if (entry.children !== undefined) {
        kit['renderSlot'] = boundRenderSlot(host, entry);
        // renderSlotChain rides the same declaration source: only entries whose
        // children include a chain-kind slot receive the chain dispatch seat.
        if (Object.values(entry.children).some(spec => spec.kind === 'chain')) {
            kit['renderSlotChain'] = boundRenderSlotChain(host, entry);
        }
        // SessionProvider standard seat: entries declaring a session-scope child
        // render the session area, so the framework hands them the self-wired
        // provider (module-level component = stable reference; no value import).
        if (Object.values(entry.children).some(spec => spec.scope === 'session')) {
            kit['SessionProvider'] = session_provider_1.SessionProvider;
        }
    }
    return { kit, standard, actions: store?.actions };
}
/**
 * One rendered entry: standard kit + cached entry inject + common slot inject
 * + owner props (owner wins). The shares are erased at this render boundary;
 * the registration and renderSlot seams already proved their contracts.
 */
function ContextualEntry({ slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext, }) {
    const contextual = (0, react_1.useMemo)(() => {
        if (!hasHookContext) {
            throw new session_provider_1.SlotAssemblyError(`slot '${slotKey}' has contextual injected Hooks but no hookContext`);
        }
        return bindSlotHookFactories(slotInjected.slotHookFactories, standard, hookContext);
    }, [hasHookContext, hookContext, slotInjected.slotHookFactories, slotKey, standard]);
    return (0, jsx_runtime_1.jsx)(Comp, { ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps });
}
function renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext) {
    if (slotInjected.slotHookFactories === undefined) {
        return (0, jsx_runtime_1.jsx)(Comp, { ...kit, ...injected, ...slotInjected.props, ...ownerProps });
    }
    return ((0, jsx_runtime_1.jsx)(ContextualEntry, { slotKey: slotKey, Comp: Comp, kit: kit, standard: standard, injected: injected, slotInjected: { props: slotInjected.props, slotHookFactories: slotInjected.slotHookFactories }, ownerProps: ownerProps, hookContext: hookContext, hasHookContext: hasHookContext }));
}
function SessionEntry({ entry, ownerProps, info, slotKey, slotInjected, hookContext, hasHookContext }) {
    const host = (0, session_provider_1.useHost)();
    const Comp = renderableComponent(entry.component);
    const { kit, standard, actions } = standardKit(host, entry, 'session', info);
    const injected = cachedSessionInject(entry, info, actions);
    return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext);
}
function SessionMaybeEntryBody({ entry, ownerProps, info, slotKey, slotInjected, hookContext, hasHookContext }) {
    const host = (0, session_provider_1.useHost)();
    const Comp = renderableComponent(entry.component);
    const { kit, standard, actions } = standardKit(host, entry, 'session-maybe', info);
    const injected = cachedSessionMaybeInject(entry, info, actions);
    return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext);
}
/**
 * Session-maybe identity: adoption — the ONLY behavior (there is no
 * hold-identity-forever mode). An incarnation born session-less ADOPTS the
 * first session that arrives: identity holds across that one transition
 * (undefined → first id), so a blank shell's DOM survives the moment a
 * session appears. From then on the entry behaves exactly like a strict
 * session entry: switching to a DIFFERENT session remounts (component-local
 * state must not leak between sessions), and dropping back to no-session
 * remounts into a fresh blank incarnation, which will adopt again.
 * Component-local per-session state therefore clears by construction; state
 * that must SURVIVE a switch belongs in session-bound sources (machine,
 * store, hooks) — the existing layering rule, now load-bearing.
 */
function SessionMaybeEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }) {
    const info = (0, session_provider_1.useSessionMaybeProvideInfo)();
    // The child key is an incarnation counter, NOT the session id: adoption
    // must keep the key constant across undefined → first id. Bookkeeping
    // lives in this stable (unkeyed) wrapper via the render-phase setState
    // form (React's sanctioned derived-state pattern: setState during render
    // of the same component re-renders once before children mount, and the
    // guard conditions make it convergent — StrictMode-safe).
    const [state, setState] = (0, react_1.useState)(FIRST_INCARNATION);
    let { adopted, epoch } = state;
    if (info.sessionId !== undefined && adopted === undefined) {
        // Adoption: same epoch — no remount.
        adopted = info.sessionId;
        setState({ adopted, epoch });
    }
    else if (adopted !== undefined && info.sessionId !== undefined && info.sessionId !== adopted) {
        // Post-adoption session switch: next incarnation, born already adopted.
        adopted = info.sessionId;
        epoch += 1;
        setState({ adopted, epoch });
    }
    else if (adopted !== undefined && info.sessionId === undefined) {
        // Back to no-session: next incarnation, born blank (adopts anew later).
        adopted = undefined;
        epoch += 1;
        setState({ adopted, epoch });
    }
    return ((0, jsx_runtime_1.jsx)(SessionMaybeEntryBody, { entry: entry, ownerProps: ownerProps, info: info, slotKey: slotKey, slotInjected: slotInjected, hookContext: hookContext, hasHookContext: hasHookContext }, epoch));
}
const FIRST_INCARNATION = { adopted: undefined, epoch: 0 };
function RootEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }) {
    const host = (0, session_provider_1.useHost)();
    const Comp = renderableComponent(entry.component);
    const { kit, standard, actions } = standardKit(host, entry, 'root', undefined);
    const injected = cachedRootInject(entry, actions);
    return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext);
}
function StrictSessionEntry({ slotKey, entry, ownerProps, slotInjected, hookContext, hasHookContext, onEntryError }) {
    const info = (0, session_provider_1.useSessionMaybeProvideInfo)();
    if (info.sessionId === undefined)
        return null;
    if (!(0, session_provider_1.isSessionProvideInfo)(info))
        throw new session_provider_1.SlotAssemblyError('strict session hook has no source');
    // Per-session remount rides this key; per-entry remount rides the outer
    // element's entry-identity key (the outlet's guarded() call).
    return ((0, jsx_runtime_1.jsx)(SlotErrorBoundary, { slotKey: slotKey, onEntryError: onEntryError, children: (0, jsx_runtime_1.jsx)(SessionEntry, { entry: entry, ownerProps: ownerProps, info: info, slotKey: slotKey, slotInjected: slotInjected, hookContext: hookContext, hasHookContext: hasHookContext }) }, info.sessionId));
}
/**
 * Anchor style shared by every outlet wrapper: `display:contents` keeps the
 * wrapper out of layout (grid/flex parents see the slot's own children), so
 * the anchor is purely addressable surface. Module-level constant — a stable
 * reference so the wrapper never diffs its style prop.
 */
const ANCHOR_STYLE = { display: 'contents' };
function SlotOutlet({ slotKey, ownerProps, opts }) {
    const host = (0, session_provider_1.useHost)();
    // Version tick drives entries() re-read; the host batches per microtask.
    (0, react_1.useSyncExternalStore)(fn => host.subscribe(slotKey, fn), () => host.getVersion(slotKey));
    // Locale revision tick: a locale switch re-renders every outlet, and entry
    // bodies re-derive their `t` seat at the new revision (fresh identity).
    useLocaleRevision(host.locale);
    const sessionInfo = (0, session_provider_1.useSessionMaybeProvideInfo)();
    // Anchor contract: every slot render site exposes a stable
    // `[data-slot="<key>"]` wrapper — the addressable seam dynamic styles
    // target — and `display:contents` keeps it layout-neutral. The wrapper
    // rides the outlet, not the dispatch outcome: fallback, crash-face, and
    // undeclared-empty states all render inside it, so the anchor's presence
    // never flickers with registration churn.
    return ((0, jsx_runtime_1.jsx)("div", { "data-slot": slotKey, style: ANCHOR_STYLE, children: renderOutletContent(host, slotKey, ownerProps, opts, sessionInfo) }));
}
/** Kind dispatch behind the outlet anchor (single/keyed/list/chain, fallbacks, crash faces). */
function renderOutletContent(host, slotKey, ownerProps, opts, sessionInfo) {
    const spec = host.specOf(slotKey);
    // Undeclared (or no-longer-declared) keys render empty: a declaring entry's
    // unload returns the slot to the undeclared state while retained elements
    // may still be mounted — natural empty, not an ownership failure.
    if (!spec)
        return null;
    const strictSessionAbsent = spec.scope === 'session' && sessionInfo.sessionId === undefined;
    if (strictSessionAbsent && (spec.kind !== 'chain' || !opts?.overlay)) {
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: opts?.fallback ?? null });
    }
    // An absent strict overlay chain follows its ordinary empty-election path,
    // preserving the Fragment/fallback-wrapper shape across session arrival.
    const entries = strictSessionAbsent ? [] : host.entriesOf(slotKey);
    const slotInjected = cachedSlotInject(spec.inject);
    // The boundary must wrap the Entry ELEMENT, not live inside it: inject
    // factories and kit synthesis run in the Entry body and must land in the
    // per-entry fallback rather than escaping to the tree above.
    const guarded = (entry, key, owner = ownerProps) => {
        const hasHookContext = opts !== undefined && Object.hasOwn(opts, 'hookContext');
        const hookContext = opts?.hookContext;
        // Shadowing kinds abdicate on crash (the cell falls to its next
        // survivor); chain reports without abdicating — election alternatives
        // resolve at select time, and retiring a crashed elected entry would
        // change the static crash face.
        const onEntryError = (error) => {
            host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== 'chain' });
        };
        return spec.scope === 'session'
            ? ((0, jsx_runtime_1.jsx)(StrictSessionEntry, { slotKey: slotKey, entry: entry, ownerProps: owner, slotInjected: slotInjected, hookContext: hookContext, hasHookContext: hasHookContext, onEntryError: onEntryError }, key))
            : ((0, jsx_runtime_1.jsx)(SlotErrorBoundary, { slotKey: slotKey, onEntryError: onEntryError, children: spec.scope === 'session-maybe'
                    ? ((0, jsx_runtime_1.jsx)(SessionMaybeEntry, { entry: entry, ownerProps: owner, slotKey: slotKey, slotInjected: slotInjected, hookContext: hookContext, hasHookContext: hasHookContext }))
                    : ((0, jsx_runtime_1.jsx)(RootEntry, { entry: entry, ownerProps: owner, slotKey: slotKey, slotInjected: slotInjected, hookContext: hookContext, hasHookContext: hasHookContext })) }, key));
    };
    // A cell whose every registration abdicated keeps the crash face: the
    // shadowing collapse ran out of survivors, which is a failure state, not
    // the owner's natural-empty fallback.
    const deadCell = () => (0, jsx_runtime_1.jsx)("div", { "data-slot-error": slotKey });
    if (spec.kind === 'single') {
        const entry = host.entriesOfSlot(slotKey)[0];
        if (!entry)
            return entries.length > 0 ? deadCell() : (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: opts?.fallback ?? null });
        return guarded(entry, entryKeyOf(entry));
    }
    if (spec.kind === 'keyed') {
        const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey);
        if (!entry) {
            const occupied = entries.some(e => e.options.key === opts?.entryKey);
            return occupied ? deadCell() : (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: opts?.fallback ?? null });
        }
        return guarded(entry, entryKeyOf(entry));
    }
    if (spec.kind === 'chain') {
        // Entries arrive priority-sorted from the ledger (the core orders at
        // register, ties keep registration sequence). Selectors are pure
        // functions of the owner props (register-face contract), so the routing
        // pass runs per render with zero mount side effects: the first non-null
        // election renders, decliners never mount.
        let elected = null;
        for (const entry of entries) {
            let matched;
            try {
                // Chain entries always carry select (SlotCore register validation).
                const select = entry.select;
                if (select === undefined)
                    throw new TypeError('chain entry has no selector');
                matched = Reflect.apply(select, undefined, [ownerProps]);
            }
            catch (error) {
                // A throwing selector is a registrant contract breach (select MUST be
                // pure and total), but it runs before the entry's SlotErrorBoundary
                // exists — uncontained it would black out the whole owner region. So
                // it degrades to a decline: the chain and the fallback stay intact,
                // and the breach is reported like a crashed entry.
                console.error(`chain selector crashed in '${slotKey}' (${entry.registrant ?? 'unknown registrant'}), treating as declined:`, error);
                continue;
            }
            if (matched !== null) {
                elected = guarded(entry, entryKeyOf(entry), { ...ownerProps, matched });
                break;
            }
        }
        if (opts?.overlay) {
            // Overlay chain (ChainRenderOpts.overlay): the fallback stays mounted
            // through elections — hidden via inline display:none (decisive over any
            // author CSS), shown via display:contents so the wrapper never affects
            // the owner's layout. The wrapper's tree position is constant, so React
            // reconciles instead of remounting and fallback state survives takeover.
            return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { "data-chain-overlay-fallback": slotKey, style: { display: elected === null ? 'contents' : 'none' }, children: opts.fallback ?? null }), elected] }));
        }
        return elected ?? (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: opts?.fallback ?? null });
    }
    // list: one row per id cell — the cell's shadowing winner, or the crash
    // face once every entry of the cell abdicated (a dry cell must not
    // silently drop its row). Row sequence: registration order refined by
    // explicit order, optional id filter, as before shadowing existed.
    const winners = host.entriesOfSlot(slotKey);
    const rows = winners.map(entry => ({
        entry,
        id: entry.options.id,
        order: entry.options.order ?? 0,
    }));
    const rowIds = new Set(rows.map(row => row.id));
    for (const entry of entries) {
        if (rowIds.has(entry.options.id))
            continue;
        rowIds.add(entry.options.id);
        // Dry cells anchor their row at the cell head's declared order.
        rows.push({ entry: undefined, id: entry.options.id, order: entry.options.order ?? 0 });
    }
    let list = [...rows].sort((a, b) => a.order - b.order);
    if (opts?.only !== undefined)
        list = list.filter(item => item.id === opts.only);
    if (list.length === 0)
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: opts?.fallback ?? null });
    // Winner rows key by entry identity (see entryKeyOf); dry-cell rows key by
    // id — the disjoint prefixes keep the two namespaces from colliding.
    return ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: list.map((item, i) => item.entry !== undefined
            ? guarded(item.entry, `e${entryKeyOf(item.entry)}`)
            : (0, jsx_runtime_1.jsx)("div", { "data-slot-error": slotKey }, `x${item.id ?? i}`)) }));
}
/** Root outlet: the shell's single ctx-level render entry — an unregistered 'root' is a boot-order failure, never a silent blank. */
function RootOutlet({ ownerProps }) {
    const host = (0, session_provider_1.useHost)();
    (0, react_1.useSyncExternalStore)(fn => host.subscribe('root', fn), () => host.getVersion('root'));
    useLocaleRevision(host.locale);
    const entry = host.entriesOfSlot('root')[0];
    if (!entry) {
        // Registrations exist but every one abdicated: the shadowing collapse ran
        // dry, so the crash face replaces the tree (registered-but-broken is a
        // crash, not the boot-order assembly failure below).
        if (host.entriesOf('root').length > 0)
            return (0, jsx_runtime_1.jsx)("div", { "data-slot-error": "root" });
        throw new session_provider_1.SlotAssemblyError("renderSlot('root') before any 'root' registration (boot order)");
    }
    // Same anchor contract as SlotOutlet: 'root' is a slot like any other, and
    // display:contents keeps the wrapper out of the shell's layout.
    return ((0, jsx_runtime_1.jsx)("div", { "data-slot": "root", style: ANCHOR_STYLE, children: (0, jsx_runtime_1.jsx)(SlotErrorBoundary, { slotKey: "root", onEntryError: (error) => { host.reportEntryError('root', entry, error, { abdicate: true }); }, children: (0, jsx_runtime_1.jsx)(RootEntry, { entry: entry, ownerProps: ownerProps, slotKey: "root", slotInjected: EMPTY_SLOT_INJECT, hookContext: undefined, hasHookContext: false }) }, entryKeyOf(entry)) }));
}
/**
 * Build the renderer the shell installs into the runtime SlotRegistry
 * (ctx.slots.install(createSlotRenderer()) at boot; the service owns the
 * install/renderSlot contract and the double-install/not-installed throws).
 * @returns the renderer.
 */
function createSlotRenderer() {
    return {
        renderRoot(host, ownerProps) {
            return ((0, jsx_runtime_1.jsx)(session_provider_1.HostContext.Provider, { value: host, children: (0, jsx_runtime_1.jsx)(session_provider_1.SessionMaybeProvider, { children: (0, jsx_runtime_1.jsx)(RootOutlet, { ownerProps: ownerProps }) }) }));
        },
    };
}

},
"src/modules/renderer/session-provider.js": function(module, exports, require) {
// source: src/modules/renderer/session-provider.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostContext = exports.SlotAssemblyError = void 0;
exports.isHostObservable = isHostObservable;
exports.isSessionProvideInfo = isSessionProvideInfo;
exports.useHost = useHost;
exports.useSessionMaybeProvideInfo = useSessionMaybeProvideInfo;
exports.useSessionProvideInfo = useSessionProvideInfo;
exports.observableHook = observableHook;
exports.maybeObservableHook = maybeObservableHook;
exports.projectionHook = projectionHook;
exports.SessionMaybeProvider = SessionMaybeProvider;
exports.SessionProvider = SessionProvider;
const jsx_runtime_1 = require("react/jsx-runtime");
/** Internal React bindings for the renderer host and active session provide bundle. */
const react_1 = require("react");
const bind_1 = require("./bind");
const runtime_types_1 = require("../shared/runtime-types");
/** The renderer deliberately observes unknown snapshots; the providing domain
 * owns their payload schema. This guard checks only the observable ABI. */
function isHostObservable(value) {
    return (0, runtime_types_1.isObjectRecord)(value) && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function';
}
function isSessionMaybeProvideInfo(value) {
    if (!(0, runtime_types_1.isObjectRecord)(value) || (value.sessionId !== undefined && typeof value.sessionId !== 'string'))
        return false;
    if (!(0, runtime_types_1.isObjectRecord)(value.hooks) || !(0, runtime_types_1.isObjectRecord)(value.props))
        return false;
    if (!Object.values(value.hooks).every(source => source === undefined || isHostObservable(source)))
        return false;
    return value.projections === undefined || ((0, runtime_types_1.isObjectRecord)(value.projections) && typeof value.projections.faceOf === 'function');
}
/** A selected-session bundle has only present, observable hook sources. */
function isSessionProvideInfo(value) {
    return value.sessionId !== undefined && Object.values(value.hooks).every(isHostObservable);
}
/**
 * A missing-provider assembly error: the shell wired the tree wrong. The slot
 * error boundary rethrows this class so misassembly stays fail-loud while
 * registrant errors (inject factories, entry components) are contained
 * per entry.
 */
class SlotAssemblyError extends Error {
}
exports.SlotAssemblyError = SlotAssemblyError;
/** In-package renderer host context. */
exports.HostContext = (0, react_1.createContext)(null);
/**
 * Read the installed renderer host; throws outside the rendered root tree
 * (framework components must not render detached from the renderer).
 * @returns the host API.
 */
function useHost() {
    const host = (0, react_1.useContext)(exports.HostContext);
    if (!host)
        throw new SlotAssemblyError('slot machinery rendered outside the installed renderer tree');
    return host;
}
const BindingContext = (0, react_1.createContext)(null);
/** Read the current-session-optional bundle supplied at the root. */
function useSessionMaybeProvideInfo() {
    const info = (0, react_1.useContext)(BindingContext);
    if (!info)
        throw new SlotAssemblyError('session-aware slot rendered outside the root binding provider');
    return info;
}
/**
 * Read the enclosing session provide bundle; throws outside a SessionProvider
 * subtree (session slots must not render without a session).
 * @returns the enclosing bundle.
 */
function useSessionProvideInfo() {
    const info = useSessionMaybeProvideInfo();
    if (!isSessionProvideInfo(info))
        throw new SlotAssemblyError('strict session slot rendered without a session');
    return info;
}
/**
 * Identity-stable selector hook per host observable. uSES resubscribes when
 * the subscribe reference changes, so the bound hook must be created once per
 * source — cached here by source identity (sources are host-owned singletons).
 * @param source - host-provided observable.
 * @returns the cached selector hook.
 */
function observableHook(source) {
    let hook = hookCache.get(source);
    if (hook === undefined) {
        hook = (0, bind_1.bindSnapshotSelector)(source);
        hookCache.set(source, hook);
    }
    return hook;
}
const hookCache = new WeakMap();
const absentSource = {
    getSnapshot: () => undefined,
    subscribe: () => () => { },
};
/** Bind a source that disappears with the current session to an optional selector hook. */
function maybeObservableHook(source) {
    if (source !== undefined)
        return observableHook(source);
    return useAbsentSnapshot;
}
function useAbsentSnapshot(_selector, _equal) {
    // The uSES subscription must still run (hook-order stability); the absent
    // source always snapshots undefined, returned explicitly.
    observableHook(absentSource)(() => undefined);
    return undefined;
}
/**
 * The useProjection framework seat (docs/subsystems/session-projection.md), one bound
 * function per provide bundle (cached by info identity — components may hold
 * it across renders). Key-addressed: the key resolves a per-session value
 * face off the projection store; the bound selector hook comes from the same
 * per-source cache as every other kit hook, so exactly one uSES subscription
 * runs per call and the subscribe reference stays stable per key. A key no
 * baseline or frame has carried (or a no-session bundle) reads `undefined` —
 * capability absence — keeping the hook order constant.
 */
function projectionHook(info) {
    let hook = projectionHookCache.get(info);
    if (hook === undefined) {
        hook = (key, selector, eq) => {
            // The no-session (faceless) branch binds the shared absent source so
            // the caller's selector still runs over `undefined` (absence flows
            // through the selector) and the uSES call count stays constant.
            const useValue = observableHook(info.projections?.faceOf(key) ?? absentSource);
            // Whole values are finished wire payloads (reference changes only when
            // a frame or baseline lands), so the identity selector needs no
            // equality function.
            return useValue(selector ?? (value => value), eq);
        };
        projectionHookCache.set(info, hook);
    }
    return hook;
}
const projectionHookCache = new WeakMap();
/**
 * Root-level binding provider. It follows current selection without a key;
 * per-entry identity is the outlet's adoption bookkeeping (SessionMaybeEntry):
 * a blank-born incarnation adopts the first session without remounting, and
 * every later transition (switch or loss) remounts like a strict entry.
 */
function SessionMaybeProvider({ children }) {
    const host = useHost();
    const info = observableHook(host.sessions.provideInfo)(value => {
        if (!isSessionMaybeProvideInfo(value))
            throw new SlotAssemblyError('invalid session provide info');
        return value;
    });
    return ((0, jsx_runtime_1.jsx)(BindingContext.Provider, { value: info, children: children }));
}
/**
 * Framework-wired session area: subscribes to the host's current provide
 * source and remounts the body under `key={sessionId}` so a session switch
 * rebuilds the session subtree. This dependency-inverted layer uses plain
 * string ids; `PropsRuntime` applies the branded type at the component
 * boundary.
 */
function SessionProvider({ empty, children }) {
    const host = useHost();
    const info = observableHook(host.sessions.provideInfo)(value => {
        if (!isSessionMaybeProvideInfo(value))
            throw new SlotAssemblyError('invalid session provide info');
        return value;
    });
    const id = info.sessionId;
    if (id === undefined)
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: empty?.() ?? null });
    return ((0, jsx_runtime_1.jsx)(BindingContext.Provider, { value: info, children: children(id) }, id));
}

},
"src/modules/renderer/bind.js": function(module, exports, require) {
// source: src/modules/renderer/bind.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindSnapshotSelector = bindSnapshotSelector;
/**
 * uSES bridge: turns any bare observable snapshot source into a typed
 * selector hook. Client-side-rendered only, so no server snapshot is wired.
 * This is the ONE hook constructor in the client stack — engines and hosts
 * traffic in bare sources; binding happens on the React side.
 */
const snapshot_selector_1 = require("./snapshot-selector");
/**
 * Bind a bare observable source to a typed uSES selector hook.
 * subscribe/getSnapshot are captured once per source into stable closures
 * (also re-binds `this` for method-based sources), so components never
 * resubscribe across renders. Equality defaults to Object.is.
 * @param w - snapshot source (engine store, Session object, store instance).
 * @returns the selector hook.
 */
function bindSnapshotSelector(w) {
    const subscribe = (fn) => w.subscribe(fn);
    const getSnapshot = () => w.getSnapshot();
    return function useSelector(sel, eq) {
        return (0, snapshot_selector_1.useSyncExternalStoreWithSelector)(subscribe, getSnapshot, undefined, sel, eq);
    };
}

},
"src/modules/renderer/snapshot-selector.js": function(module, exports, require) {
// source: src/modules/renderer/snapshot-selector.ts

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSyncExternalStoreWithSelector = useSyncExternalStoreWithSelector;
/**
 * Typed selector bridge preserving use-sync-external-store 1.2.0's selection
 * memoization: same snapshots retain identity and equal selections reuse the
 * previously committed value. React 18's native uSES is the current platform.
 */
const react_1 = require("react");
function useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
    const committed = (0, react_1.useRef)({ hasValue: false });
    const [getSelection, getServerSelection] = (0, react_1.useMemo)(() => {
        let memo;
        const select = (snapshot) => {
            if (memo === undefined) {
                const selected = selector(snapshot);
                const prior = committed.current;
                const selection = isEqual !== undefined && prior.hasValue && isEqual(prior.value, selected) ? prior.value : selected;
                memo = { snapshot, selection };
                return selection;
            }
            if (Object.is(memo.snapshot, snapshot))
                return memo.selection;
            const selected = selector(snapshot);
            if (isEqual !== undefined && isEqual(memo.selection, selected))
                return memo.selection;
            memo = { snapshot, selection: selected };
            return selected;
        };
        return [() => select(getSnapshot()), getServerSnapshot == null ? undefined : () => select(getServerSnapshot())];
    }, [getSnapshot, getServerSnapshot, selector, isEqual]);
    const selected = (0, react_1.useSyncExternalStore)(subscribe, getSelection, getServerSelection);
    (0, react_1.useEffect)(() => { committed.current = { hasValue: true, value: selected }; }, [selected]);
    (0, react_1.useDebugValue)(selected);
    return selected;
}

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
"src/modules/renderer/app.js": function(module, exports, require) {
// source: src/modules/renderer/app.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRenderApp = buildRenderApp;
const jsx_runtime_1 = require("react/jsx-runtime");
const bind_1 = require("./bind");
const DocumentTitle_1 = require("./DocumentTitle");
/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
function buildRenderApp(deps) {
    const { ctx } = deps;
    const sessions = ctx.get('sessions');
    if (sessions === undefined)
        throw new Error('ui renderer: sessions service unavailable');
    const useSessions = (0, bind_1.bindSnapshotSelector)(sessions.list);
    const SessionDocumentTitle = () => {
        const title = useSessions((state) => {
            const id = state.current;
            return id === undefined ? undefined : state.byId[id]?.title;
        });
        return (0, jsx_runtime_1.jsx)(DocumentTitle_1.DocumentTitle, { ...title === undefined ? {} : { title } });
    };
    return () => ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(SessionDocumentTitle, {}), ctx.slots.renderSlot('root', {})] }));
}

},
"src/modules/renderer/DocumentTitle.js": function(module, exports, require) {
// source: src/modules/renderer/DocumentTitle.tsx

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentTitle = DocumentTitle;
const react_1 = require("react");
const DEFAULT_CLIENT_TITLE = 'DSH Local Build';
/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
function DocumentTitle({ title }) {
    const productTitle = 'XHarness';
    (0, react_1.useEffect)(() => {
        document.title = title === undefined ? productTitle : `${title} — ${productTitle}`;
        return () => { document.title = productTitle; };
    }, [productTitle, title]);
    return null;
}

}
};
const __dependencies = {"src/modules/renderer/index.js":{"./scoped-slots":"src/modules/renderer/scoped-slots.js","./app":"src/modules/renderer/app.js"},"src/modules/renderer/scoped-slots.js":{"./session-provider":"src/modules/renderer/session-provider.js","../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/renderer/session-provider.js":{"./bind":"src/modules/renderer/bind.js","../shared/runtime-types":"src/modules/shared/runtime-types.js"},"src/modules/renderer/bind.js":{"./snapshot-selector":"src/modules/renderer/snapshot-selector.js"},"src/modules/renderer/snapshot-selector.js":{},"src/modules/shared/runtime-types.js":{},"src/modules/renderer/app.js":{"./bind":"src/modules/renderer/bind.js","./DocumentTitle":"src/modules/renderer/DocumentTitle.js"},"src/modules/renderer/DocumentTitle.js":{}};
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
return __load("src/modules/renderer/index.js");
}
});
