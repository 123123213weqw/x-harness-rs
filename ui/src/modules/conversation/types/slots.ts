import type { ReactNode } from 'react'
import type { ObservableSnapshot as HostObservable, ConversationSnapshot, SessionId, SessionListState, WorkspaceListState, EngineStoreHandle, UseProjection } from './runtime'
import type { InputState, InputActions } from '../input/contract'
import type { ConversationKey } from '../locales'
export type SnapshotSelectorHook<T> = <S>(select: (state: T) => S, equal?: (left: S, right: S) => boolean) => S
export type MaybeSnapshotSelectorHook<T> = <S>(select: (state: T) => S, equal?: (left: S, right: S) => boolean) => S | undefined
export type BakedActions<A> = { [K in keyof A]: A[K] extends (draft: never, ...params: infer P) => void ? (...params: P) => void : never }
export type BoundActions<H> = H extends { spec: { actions: infer A } } ? BakedActions<A> : never
export type PropsStore<H> = H extends EngineStoreHandle<infer S, infer A> ? { useStore: SnapshotSelectorHook<S>; actions: BakedActions<A> } : object
/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}

/**
 * Locale namespace table. Dictionary owners extend via declaration merging
 * (exactly like {@link SlotMap}, and declared in this entry module for the
 * same lexical-merge reason): the key is the namespace string, the value is
 * the union of its dictionary keys. Register sites declare one of these
 * namespaces (`locale:`), which puts the typed `t` standard seat on the
 * component props.
 */
export interface LocaleNamespaceMap { common: 'retry' | 'cancel' | 'close' | 'copy' | 'copied' | 'loading' }

/**
 * Translate a dictionary key with optional `{name}` template params.
 * `K` narrows the accepted keys to the owning namespace's dictionary union
 * (plus the shared common vocabulary where composed).
 */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string

/**
 * The shared `common` vocabulary keys as merged by the locale plugin;
 * resolves to `never` in programs without the merge (this package's tests),
 * keeping the union collapse harmless.
 */
export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

/**
 * Key domain of a namespace-bound translate: the namespace's own dictionary
 * union plus the shared common vocabulary (the lookup chain consults common
 * after the namespace misses).
 */
export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> =
  (LocaleNamespaceMap[N] & string) | CommonKeyOf

/**
 * Namespace-addressed translate — the developer-facing alias over
 * {@link Translate}: `TranslateNS<'model'>` is the translate function of the
 * `model` namespace (key domain = its dictionary union plus the shared
 * common vocabulary), the exact type of the framework-injected `t` seat and
 * of the locale service's typed `bind`.
 */
export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

/**
 * Dictionary shape for a declared namespace: exactly the keys the namespace
 * merged into {@link LocaleNamespaceMap} — a missing or extra key at a typed
 * registration site is a compile error.
 */
export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> =
  Record<LocaleNamespaceMap[N] & string, string>

/**
 * Locale share of the composed component props: the framework-injected `t`
 * seat, present exactly on entries whose registration declares `locale:`.
 */
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
  ? {
    /** Translate a dictionary key of the declared namespace (or the shared common vocabulary). */
    t: TranslateNS<N>
  }
  : object

/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/**
 * One SlotMap entry: kind/scope axes plus the optional owner-supplied props
 * share (`owner` is what the parent passes at its renderSlot call site; the
 * framework standard kit and the registrant's injected share never enter this
 * table — full component props compose at the component as the four-share
 * intersection, see {@link ComposedProps}).
 */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: (object) | undefined
  /**
   * Optional keyed-entry prop table. A keyed registration contributes one
   * literal key and receives the corresponding prop share; ordinary owner
   * props remain common to every key.
   */
  keyProps?: (Record<string, object>) | undefined
  /**
   * Optional opaque context carried by one renderSlot occurrence. Only
   * function-valued members of the slot-level injected hooks compartment
   * receive it; the slot machinery never interprets the value.
   */
  hookContext?: (unknown) | undefined
  /**
   * Optional Slot-level inject face supplied by the parent registration's
   * child declaration. Every registered entry receives its bound component
   * face; child registrants do not own or replace this common capability.
   */
  inject?: (object) | undefined
}

/**
 * Runtime dispatch spec for one slot, recorded from a register call's
 * `children` value. The literal is compile-time checked against the SlotMap
 * entry (`SlotSpec<SlotMap[P]>` in {@link ChildrenDecl}), so kind, scope, and
 * any common inject face are declared at one point and validate each other.
 */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
} & ('inject' extends keyof E
  ? E extends { inject: infer Injected extends object }
    ? { inject: Injected }
    : { inject?: (object) | undefined }
  : { inject?: (never) | undefined })

/**
 * Child-slot declaration table for register(): keys are the declared (and
 * thereby render-authorized) slot names, values are their runtime dispatch
 * specs. Declaring is claiming: the registering entry becomes the only entry
 * allowed to render these keys.
 */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** Owner-supplied props share for a slot key ({} for entries declaring no `owner`). */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** Registration/dispatch key domain of one keyed slot. */
export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? keyof P & string
    : string

/** Key-dependent props supplied by the owner at one keyed dispatch site. */
export type KeyPropsOf<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
> = SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
  ? EntryKey extends keyof P
    ? P[EntryKey] extends object ? P[EntryKey] : never
    : never
  : object

/** Opaque per-render occurrence context declared by one slot. */
export type HookContextOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { hookContext: infer Context } ? Context : never

/** Common render-occurrence inject face declared by one slot. */
export type SlotInjectOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { inject: infer Injected extends object } ? Injected : object

/** Scope axis of a slot key's SlotMap entry. */
export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope']

/**
 * Framework standard kit delivered to every session-scope slot component.
 * Declared EMPTY here (zero-dependency layer): the runtime package merges the
 * real members (`useSession` bound to the conversation snapshot and the
 * framework-supplied `sessionId`) exactly as consumers merge SlotMap keys.
 */
export interface SessionStandardProps { sessionId: SessionId; useSession: SnapshotSelectorHook<ConversationSnapshot>; useInput: SnapshotSelectorHook<InputState>; inputActions: InputActions; useProjection: UseProjection }

/**
 * Framework standard kit delivered to current-session-optional slots. Its
 * hooks stay callable while no session is selected and return `undefined`
 * until one becomes current; concrete members merge in at runtime packages.
 */
export interface SessionMaybeStandardProps { sessionId: SessionId | undefined; useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>; useInput: MaybeSnapshotSelectorHook<InputState>; inputActions: InputActions | undefined; useProjection: UseProjection }

/**
 * Framework standard kit delivered to EVERY slot component (the global seat).
 * Declared empty here; the runtime package merges the global object-layer
 * selector hooks that shared page composition consumes.
 */
export interface GlobalStandardProps { useSessions: SnapshotSelectorHook<SessionListState>; useWorkspaces: SnapshotSelectorHook<WorkspaceListState> }

/**
 * The session id type as the runtime's SessionStandardProps merge declares it
 * (branded); falls back to `string` in programs without the merge (this
 * package's own tests).
 */
export type SessionIdOf = SessionStandardProps extends { sessionId: infer S } ? S : string

/**
 * Runtime props share for a slot key: owner share (parent's renderSlot call
 * site) + session standard kit (session scope only) + the global seat.
 */
export type PropsRuntime<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> =
  OwnerOf<K> &
  KeyPropsOf<K, EntryKey> &
  SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/** renderSlot dispatch options: keyed dispatch key, list filtering, and empty fallback. */
export interface RenderOpts<EntryKey extends string = string> {
  entryKey?: (EntryKey) | undefined
  only?: (string) | undefined
  fallback?: (ReactNode) | undefined
  /** Type-erased runtime seat; PropsRenderSlots narrows or removes it per slot declaration. */
  hookContext?: (unknown) | undefined
}

/** renderSlotChain dispatch options. */
export interface ChainRenderOpts {
  /** The owner's fallback body, rendered when every entry's selector declines. */
  fallback?: (ReactNode) | undefined
  /**
   * Keep the fallback permanently mounted: an election hides it (wrapped,
   * display:none) instead of unmounting it, and the all-decline case shows it
   * as-is — fallback-held state (composer drafts, DOM state) survives a
   * takeover. Chain kind only. Sole consumer today: the
   * 'conversation.composer' chain.
   */
  overlay?: (boolean) | undefined
}

/**
 * Chain-entry selector: the routing decision of one chain contribution.
 * Runs at render time in chain order (ascending `priority`, default 0, lower
 * tries first; ties keep registration = assembly order); the first non-null
 * return elects its entry
 * and becomes the component's `matched` prop; `null` passes to the next
 * entry; all-null falls to the owner's {@link ChainRenderOpts} fallback.
 * MUST be pure — a function of the owner props only, no external mutable
 * reads, no side effects (the decline decision lives here, never in a
 * mounted component probing its own props).
 */
export type ChainSelect<O extends object, M> = (owner: O) => M | null

/** Keys of a slot-key union whose SlotMap entry is chain-kind (renderSlotChain's dispatch domain). */
export type ChainKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S]['kind'] extends 'chain' ? S : never) : never

/** Keys in a render share whose dispatch occurrence requires hookContext. */
type ContextualKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S] extends { hookContext: unknown } ? S : never) : never

/** Keys in a render share with the ordinary optional options bag. */
type OrdinaryKeysOf<S extends keyof SlotMap & string> = Exclude<S, ContextualKeysOf<S>>

/**
 * Plain and contextual child dispatch signatures. Keeping them as separate
 * call signatures preserves ordinary renderSlot assignability while making a
 * declared hookContext mandatory only for the Slot keys that need it.
 */
type RenderSlotFn<S extends keyof SlotMap & string> =
  ([ContextualKeysOf<S>] extends [never] ? object : {
    <
      K extends ContextualKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts: RenderOpts<EntryKey> & { hookContext: HookContextOf<K> },
    ): ReactNode
  }) &
  ([OrdinaryKeysOf<S>] extends [never] ? object : {
    <
      K extends OrdinaryKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts?: Omit<RenderOpts<EntryKey>, 'hookContext'>,
    ): ReactNode
  })

/**
 * Chain matched share: a chain-slot component receives its selector's
 * non-null result as the framework-injected `matched` prop; other kinds add
 * nothing to the composed constraint.
 */
export type MatchedShare<E extends SlotEntryDef, M> =
  E['kind'] extends 'chain' ? { matched: M } : object

/**
 * Conversation-session selector hook alias for props contracts. Wide by
 * default at this dependency-inverted layer; the runtime narrows at its
 * export outlet (`UseSession<ConversationSnapshot>`).
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

/** Props of the standard-kit SessionProvider seat (render-prop form). */
export interface SessionAreaProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; the framework remounts it per session (key=sessionId). */
  children: (sessionId: SessionIdOf) => ReactNode
}

/**
 * Framework-wired session area component. It subscribes to runtime-owned
 * session selection and is injected into entries that declare session-scoped
 * children; business code does not import it directly.
 */
export type SessionProviderComponent = (props: SessionAreaProps) => ReactNode

/**
 * Child-slot render share: `renderSlot` statically narrowed to the entry's
 * declared children keys. Delegation is plain props passing (hand
 * `props.renderSlot` down); the authorizing identity stays the registering
 * entry. `__renders` is a phantom variance anchor (never materialized):
 * generic method signatures compare loosely across differing key unions, so
 * this contravariant marker is what actually enforces "component key set ⊆
 * children declaration" at the register call site.
 */
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
  /**
   * Render a declared non-chain child slot (chain keys dispatch through
   * `renderSlotChain` — their routing lives in entry selectors).
   * @param key - declared child key.
   * @param owner - owner props share for that key (decided at the render site).
   * @param opts - kind dispatch options.
   * @returns rendered node(s).
   */
  renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>
  readonly __renders?: ((key: S) => void) | undefined
} & ([ChainKeysOf<S>] extends [never] ? object : {
  /**
   * Render a declared chain child slot: entry selectors run in chain order
   * over `owner`; the first non-null match renders its component with the
   * selector result injected as `matched`; all-null renders `opts.fallback`.
   * @param key - declared chain child key.
   * @param owner - owner props share (the selectors' routing input).
   * @param opts - fallback body for the all-null case.
   * @returns rendered node(s).
   */
  renderSlotChain: <K extends ChainKeysOf<S>>(key: K, owner: OwnerOf<K>, opts?: ChainRenderOpts) => ReactNode
}) & ('session' extends ScopeOf<S>
  // The SessionProvider seat rides the same source as renderSlot: declaring
  // a session-scope child is what makes a session area exist, so the seat
  // derives from the children key set's scopes (renderer injects the value).
  ? { SessionProvider: SessionProviderComponent }
  : object)

/**
 * Registration-position component shape: the bare call signature, so composed
 * constraints check through clean parameter contravariance (FC statics add
 * covariant noise rejecting legitimate narrowings).
 */
export type SlotComponent<P> = (props: P) => ReactNode

/**
 * Registrant hooks compartment: bare observable sources (getSnapshot +
 * subscribe pairs) supplied under the reserved `hooks` key of an entry's
 * inject face. These retain the original source-to-selector binding and do
 * not participate in render-occurrence context.
 */
export type HooksSources = Record<string, HostObservable<unknown>>

/** Framework-owned props visible while a slot-level contextual Hook is bound. */
export type StandardPropsOf<K extends keyof SlotMap & string> =
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/**
 * One function-valued slot-level inject.hooks member. The factory is pure and
 * returns the actual custom Hook; it must not invoke a Hook while being bound.
 */
export type SlotHookFactory<
  K extends keyof SlotMap & string,
  Hook extends (...args: never[]) => unknown,
> = (
  standard: StandardPropsOf<K>,
  hookContext: HookContextOf<K>,
) => Hook

/** Component-side Hook produced from one slot-level inject.hooks member. */
type BoundHookOf<Definition> =
  Definition extends HostObservable<infer Snapshot>
    ? SnapshotSelectorHook<Snapshot>
    : Definition extends (...args: never[]) => infer Hook
      ? Hook extends (...args: never[]) => unknown ? Hook : never
      : never

/**
 * Selector-hook share synthesized from a hooks compartment: each source
 * `name` becomes a `use<Name>` selector hook over its snapshot type.
 */
export type PropsSlotHooks<HS extends object> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  BoundHookOf<HS[N]>
}

/** Component-side view of a slot dispatcher's common inject face. */
export type SlotInjectFace<I extends object> =
  I extends { hooks: infer HS extends object } ? Omit<I, 'hooks'> & PropsSlotHooks<HS> : I

/** Selector-hook share synthesized from an entry inject hooks compartment. */
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
}

/**
 * The component-side view of an inject face: the reserved `hooks`
 * compartment (when declared) arrives as bound `use<Name>` selector hooks;
 * every other member passes through verbatim.
 */
export type InjectFace<I extends object> =
  I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I

export interface SlotMap { conversation: { kind: 'single'; scope: 'session-maybe' }; details: { kind: 'single'; scope: 'session' } }

export interface SlotMap { 'settings.general.item': { kind: 'list'; scope: 'root' }; 'conversation.input.overlay': { kind: 'list'; scope: 'session' } }
