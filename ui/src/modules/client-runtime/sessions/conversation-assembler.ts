import type {
  ConversationContextReader, ConversationEventInput, ConversationLocationData, ConversationMatch, ConversationLocation, TurnLocation,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationLocationDataScope, ConversationPublication, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from '../contract/conversation'
import { conversationContextKey } from '../contract/conversation'
import { isRecord } from '../value-guards'
import {
  ConversationLocationIndex, type ConversationLocationDataChange,
} from './conversation-location-index'

interface Dependency {
  readonly kind: string
  readonly key: string | undefined
  readonly revision: number | undefined
  readonly windowGap: boolean
}

interface InternalContext {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly definition: ConversationNodeDefinition
  startSeq: number | undefined
  start: ConversationMatch | undefined
  matches: ConversationMatch[]
  state: unknown
  revision: number
  readonly current: Map<string, ConversationViewNode | null>
  readonly locationData: Record<ConversationLocationDataScope, ConversationLocationData | null>
  dependencies: Map<string, Dependency>
}

interface HistoryReuse {
  readonly committed: ConversationNodeAssembler
  readonly reused: Map<string, {old: InternalContext; state: unknown}>
  readonly boundaries: WeakMap<TurnLocation, WeakMap<TurnLocation, boolean>>
}

interface PendingMatch {
  readonly definition: ConversationNodeDefinition
  readonly id: string
  readonly match: ConversationMatch
}

interface ViewState {
  readonly target: string
  readonly builder: ConversationViewBuilder
  snapshot: unknown
}

const PUBLICATION_RANK: Record<ConversationPublication, number> = {
  none: 0,
  'animation-frame': 1,
  immediate: 2,
}

const LOCATION_DATA_SCOPES: readonly ConversationLocationDataScope[] = ['step', 'turn']

function emptyLocationData(): Record<ConversationLocationDataScope, ConversationLocationData | null> {
  return { step: null, turn: null }
}

function maximumPublication(
  left: ConversationPublication,
  right: ConversationPublication,
): ConversationPublication {
  return PUBLICATION_RANK[left] >= PUBLICATION_RANK[right] ? left : right
}

function startSeq(context: InternalContext): number | undefined {
  return context.startSeq
}

function insertionIndex(contexts: readonly InternalContext[], seq: number): number {
  let low = 0
  let high = contexts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = contexts[middle]
    if (candidate !== undefined && candidate.startSeq !== undefined && candidate.startSeq < seq) low = middle + 1
    else high = middle
  }
  return low
}

function contextSnapshot(context: InternalContext): ConversationNodeContext {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    matches: context.matches,
    start: context.start,
    state: context.state,
    current: context.current,
  }
}

function mergeMatches(
  key: string,
  additions: readonly ConversationMatch[],
  existing: readonly ConversationMatch[],
): ConversationMatch[] {
  const merged: ConversationMatch[] = []
  let added = 0
  let current = 0
  while (added < additions.length || current < existing.length) {
    const left = additions[added]
    const right = existing[current]
    if (left !== undefined && right !== undefined && left.event.seq === right.event.seq) {
      throw new Error(`conversation Context ${key} received duplicate Match ${left.event.seq}`)
    }
    if (right === undefined || (left !== undefined && left.event.seq < right.event.seq)) {
      if (left === undefined) break
      merged.push(left)
      added++
    } else {
      merged.push(right)
      current++
    }
  }
  return merged
}

/** Event Registry subset consumed by a Session-owned Assembler. */
export interface ConversationEventDefinitions {
  /** @returns ordinary Definitions in registration order. */
  entries(): readonly ConversationNodeDefinition[]
  /** @returns unmatched-event fallback, when registered. */
  fallbackEntry(): ConversationNodeDefinition | undefined
}

/** View Registry subset consumed by a Session-owned Assembler. */
export interface ConversationViewDefinitions {
  /** @returns view builder factories in registration order. */
  entries(): readonly ConversationViewDefinition[]
}

/**
 * Session-owned incremental engine that assembles business Contexts from a
 * contiguous Event window and materializes registered view snapshots.
 */
export class ConversationNodeAssembler implements ConversationViewSnapshotStore {
  private readonly contexts = new Map<string, InternalContext>()
  private readonly contextsByKind = new Map<string, InternalContext[]>()
  private readonly contextsBySeq = new Map<number, Set<InternalContext>>()
  private readonly inputs = new Map<number, ConversationEventInput>()
  private readonly locationIndex = new ConversationLocationIndex()
  private readonly dirty = new Set<InternalContext>()
  private readonly revised = new Set<InternalContext>()
  private readonly dependents = new Map<string, Set<InternalContext>>()
  private readonly views = new Map<string, ViewState>()
  private hasMore = false
  private replacePending = true
  private timelineDirty = true
  private historyReuse: HistoryReuse | undefined

  /**
   * @param eventDefinitions - live Event Definition registry.
   * @param viewDefinitions - live view builder registry.
   */
  constructor(
    private readonly eventDefinitions: ConversationEventDefinitions,
    private readonly viewDefinitions: ConversationViewDefinitions,
  ) {
    this.resetViewBuilders()
  }

  /**
   * Replace the complete loaded window after open, resync, or gap repair.
   * @param entries - complete contiguous window.
   * @param hasMore - whether older history remains outside the window.
   * @returns immediate publication request.
   */
  /** Stage a complete history mapping without publishing partial reducers or views. */
  stageReplacement(entries: readonly ConversationEventInput[], hasMore: boolean, reuse = false): ConversationNodeAssembler {
    const staged = new ConversationNodeAssembler(this.eventDefinitions, this.viewDefinitions)
    if (reuse && !this.replacePending && this.dirty.size === 0) {
      staged.historyReuse = {committed:this, reused:new Map(), boundaries:new WeakMap()}
    }
    try {
      staged.stageWindow(entries, hasMore)
      staged.flush()
      return staged
    } finally {
      // A committed window must not retain previous transaction graphs.
      staged.historyReuse = undefined
    }
  }

  replaceWindow(entries: readonly ConversationEventInput[], hasMore: boolean): ConversationPublication {
    Object.assign(this, this.stageReplacement(entries, hasMore))
    return 'immediate'
  }

  /** Release materialized view snapshots when an inactive window is evicted. */
  releaseWindow(): void {
    this.replaceWindow([], false)
    this.resetViewBuilders()
  }

  private stageWindow(entries: readonly ConversationEventInput[], hasMore: boolean): ConversationPublication {
    this.contexts.clear()
    this.contextsByKind.clear()
    this.contextsBySeq.clear()
    this.inputs.clear()
    this.dirty.clear()
    this.revised.clear()
    this.dependents.clear()
    this.hasMore = hasMore
    const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq)
    for (const entry of sorted) this.inputs.set(entry.event.seq, entry)
    this.locationIndex.rebuild(sorted)
    this.timelineDirty = true
    const pending = new Map<string, PendingMatch[]>()
    if (this.historyReuse === undefined) {
      for (const entry of sorted) this.matchInput(entry)
    } else {
      // Collect all evidence before replay: immediate start replay would miss
      // the old completed context and repeat each later delta reducer.
      for (const entry of sorted) this.collectInput(entry, pending)
      const affected = new Set<InternalContext>()
      this.applyPendingMatches(pending, affected)
      this.replayContexts(affected)
    }
    this.replayDependencies()
    this.revised.clear()
    if (this.historyReuse !== undefined) {
      for (const context of this.contexts.values()) {
        if (context.start !== undefined) continue
        const old = this.historyReuse.committed.contexts.get(context.key)
        if (old !== undefined && this.reusable(context, old)) {
          this.historyReuse.reused.set(context.key, {old, state:context.state})
        }
      }
    }
    for (const context of this.contexts.values()) this.dirty.add(context)
    this.replacePending = true
    return 'immediate'
  }

  /**
   * Add one contiguous live tail event without scanning existing Contexts.
   * @param input - appended Event and optional wire view.
   * @returns highest requested publication cadence.
   */
  append(input: ConversationEventInput): ConversationPublication {
    if (this.inputs.has(input.event.seq)) return 'none'
    this.revised.clear()
    this.inputs.set(input.event.seq, input)
    let publication: ConversationPublication = 'none'
    if (isLocationBoundary(input.event.type)) {
      const previousTimeline = this.locationIndex.snapshot()
      const changed = this.locationIndex.appendBoundary(input.event)
      if (this.locationIndex.snapshot() !== previousTimeline) {
        this.timelineDirty = true
        publication = 'immediate'
      }
      this.replayContexts(this.refreshMatchLocations(changed))
      if (changed.size > 0) publication = 'immediate'
    } else {
      this.locationIndex.appendNonBoundary(input.event)
    }
    publication = maximumPublication(publication, this.matchInput(input))
    if (this.replayRevisedDependents()) publication = 'immediate'
    this.revised.clear()
    return publication
  }

  /**
   * Add an older page while preserving existing Context and view identities.
   * @param entries - newly loaded older Events.
   * @param hasMore - whether history still precedes the expanded window.
   * @returns highest requested publication cadence.
   */
  prepend(entries: readonly ConversationEventInput[], hasMore: boolean): ConversationPublication {
    const fresh = entries.filter(entry => !this.inputs.has(entry.event.seq))
    if (fresh.length === 0 && hasMore === this.hasMore) return 'none'
    Object.assign(this, this.stageReplacement([...fresh, ...this.sortedInputs()], hasMore, true))
    return 'immediate'
  }

  /**
   * Rebuild against the current Registry set after a low-frequency plugin change.
   * @returns immediate publication request.
   */
  rebuildRegistry(): ConversationPublication {
    return this.replaceWindow(this.sortedInputs(), this.hasMore)
  }

  /**
   * Materialize dirty Contexts and advance every registered view builder.
   * @returns whether any view snapshot was rebuilt or incrementally applied.
   */
  flush(): boolean {
    if (!this.replacePending && this.dirty.size === 0 && !this.timelineDirty) return false
    if (this.replacePending) {
      this.replaceLocationData()
      const allByTarget = new Map<string, ConversationViewNode[]>()
      for (const target of this.views.keys()) allByTarget.set(target, [])
      for (const context of this.contexts.values()) {
        const target = context.definition.target
        if (target === undefined || !this.views.has(target)) continue
        const node = this.buildNode(context, target)
        context.current.set(target, node)
        if (node !== null) allByTarget.get(target)?.push(node)
      }
      for (const view of this.views.values()) {
        view.snapshot = view.builder.replace({
          nodes: allByTarget.get(view.target) ?? [],
          timeline: this.locationIndex.snapshot(),
        })
      }
      this.replacePending = false
      this.dirty.clear()
      this.timelineDirty = false
      return true
    }

    const upsertsByTarget = new Map<string, ConversationViewNode[]>()
    for (const target of this.views.keys()) upsertsByTarget.set(target, [])
    if (this.applyDirtyLocationData()) this.timelineDirty = true
    for (const context of this.dirty) {
      const target = context.definition.target
      if (target === undefined || !this.views.has(target)) continue
      const previous = context.current.get(target) ?? null
      const node = this.buildNode(context, target)
      if (node === null && previous !== null) {
        throw new Error(
          `conversation Definition "${context.kind}" withdrew materialized target "${target}"; return the same key with hidden visibility instead`,
        )
      }
      context.current.set(target, node)
      if (node !== null) upsertsByTarget.get(target)?.push(node)
    }
    this.dirty.clear()
    const timelineDirty = this.timelineDirty
    this.timelineDirty = false
    for (const view of this.views.values()) {
      const upserts = upsertsByTarget.get(view.target) ?? []
      if (upserts.length === 0 && !timelineDirty) continue
      view.snapshot = view.builder.apply({
        upserts,
        timeline: this.locationIndex.snapshot(),
      })
    }
    return true
  }

  /**
   * Read the latest snapshot of a registered target.
   * @param target - registered view target.
   * @returns target snapshot, or undefined when no builder is registered.
   */
  snapshot(target: string): unknown {
    return this.views.get(target)?.snapshot
  }

  get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): unknown {
    return this.snapshot(target)
  }

  private sortedInputs(): ConversationEventInput[] {
    return [...this.inputs.values()].sort((left, right) => left.event.seq - right.event.seq)
  }

  private matchInput(input: ConversationEventInput): ConversationPublication {
    return this.dispatchInput(input, (definition, id, role) =>
      this.acceptMatch(definition, id, role, input))
  }

  private collectInput(
    input: ConversationEventInput,
    pending: Map<string, PendingMatch[]>,
  ): ConversationPublication {
    return this.dispatchInput(input, (definition, id, role) => {
      const key = conversationContextKey(definition.kind, id)
      const match: ConversationMatch = {
        ...input,
        role,
        location: this.locationIndex.locationOf(input.event),
      }
      const matches = pending.get(key) ?? []
      matches.push({ definition, id, match })
      pending.set(key, matches)
      return definition.publication?.(match) ?? 'immediate'
    })
  }

  private dispatchInput(
    input: ConversationEventInput,
    accept: (
      definition: ConversationNodeDefinition,
      id: string,
      role: ConversationMatch['role'],
    ) => ConversationPublication,
  ): ConversationPublication {
    const matchedTargets = new Set<string>()
    let publication: ConversationPublication = 'none'
    for (const definition of this.eventDefinitions.entries()) {
      const result = definition.match(input.event, input.view)
      if (result === null) continue
      if (definition.target !== undefined) matchedTargets.add(definition.target)
      publication = maximumPublication(publication, accept(definition, result.id, result.role))
    }
    const fallback = this.eventDefinitions.fallbackEntry()
    const target = fallback?.target
    if (fallback !== undefined && target !== undefined && !matchedTargets.has(target)) {
      const result = fallback.match(input.event, input.view)
      if (result !== null) {
        publication = maximumPublication(publication, accept(fallback, result.id, result.role))
      }
    }
    return publication
  }

  private acceptMatch(
    definition: ConversationNodeDefinition,
    id: string,
    role: ConversationMatch['role'],
    input: ConversationEventInput,
  ): ConversationPublication {
    const key = conversationContextKey(definition.kind, id)
    let context = this.contexts.get(key)
    if (role === 'start' && context?.start !== undefined) {
      throw new Error(`conversation Context ${key} received more than one start Match`)
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
      }
      this.contexts.set(key, context)
    }
    const match: ConversationMatch = {
      ...input,
      role,
      location: this.locationIndex.locationOf(input.event),
    }
    const previous = context.matches.at(-1)
    if (previous !== undefined && previous.event.seq >= input.event.seq) {
      throw new Error(`conversation Context ${key} received non-appended Match ${input.event.seq}`)
    }
    if (role === 'start' && context.matches.length > 0) {
      throw new Error(`conversation Context ${key} received an update before its start Match`)
    }
    context.matches.push(match)
    if (role === 'start') {
      context.startSeq = input.event.seq
      context.start = match
      this.indexStartedContext(context)
    }
    const owners = this.contextsBySeq.get(input.event.seq) ?? new Set<InternalContext>()
    owners.add(context)
    this.contextsBySeq.set(input.event.seq, owners)

    if (role === 'start') {
      this.replayContext(context)
    } else if (context.state !== undefined) {
      const typed = { ...contextSnapshot(context), state: context.state }
      context.state = requireState(definition, 'update', definition.update(typed, match))
      context.revision++
      this.revised.add(context)
    }
    this.dirty.add(context)
    return definition.publication?.(match) ?? 'immediate'
  }

  private applyPendingMatches(
    pending: ReadonlyMap<string, readonly PendingMatch[]>,
    affected: Set<InternalContext>,
  ): void {
    const startsByKind = new Map<string, InternalContext[]>()
    for (const [key, entries] of pending) {
      const first = entries[0]
      if (first === undefined) continue
      let context = this.contexts.get(key)
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
        }
        this.contexts.set(key, context)
      }
      let discoveredStart: ConversationMatch | undefined
      const additions = entries
        .map((entry) => {
          if (entry.definition !== context.definition || entry.id !== context.id) {
            throw new Error(`conversation Context ${key} received inconsistent Definition identity`)
          }
          if (entry.match.role === 'start') {
            if (discoveredStart !== undefined || context.start !== undefined) {
              throw new Error(`conversation Context ${key} received more than one start Match`)
            }
            discoveredStart = entry.match
          }
          const owners = this.contextsBySeq.get(entry.match.event.seq) ?? new Set<InternalContext>()
          owners.add(context)
          this.contextsBySeq.set(entry.match.event.seq, owners)
          return entry.match
        })
        .sort((left, right) => left.event.seq - right.event.seq)
      context.matches = mergeMatches(context.key, additions, context.matches)
      if (discoveredStart !== undefined) {
        context.start = discoveredStart
        context.startSeq = discoveredStart.event.seq
        const starts = startsByKind.get(context.kind) ?? []
        starts.push(context)
        startsByKind.set(context.kind, starts)
      }
      if (context.start !== undefined && context.matches[0] !== context.start) {
        throw new Error(`conversation Context ${context.key} received an update before its start Match`)
      }
      affected.add(context)
      this.dirty.add(context)
    }
    for (const [kind, contexts] of startsByKind) this.indexStartedContexts(kind, contexts)
  }

  private replayContexts(contexts: ReadonlySet<InternalContext>): void {
    const ordered = [...contexts].sort((left, right) =>
      (left.startSeq ?? Number.POSITIVE_INFINITY) - (right.startSeq ?? Number.POSITIVE_INFINITY))
    for (const context of ordered) {
      if (context.start === undefined) {
        context.state = undefined
        this.dirty.add(context)
        continue
      }
      this.replayContext(context)
    }
  }

  private replayContext(context: InternalContext): void {
    const reuse = this.historyReuse
    const old = reuse?.committed.contexts.get(context.key)
    if (reuse !== undefined && old !== undefined && this.reusable(context, old)) {
      const matches = new Map<unknown, ConversationMatch>()
      for (let index = 0; index < old.matches.length; index++) {
        const next = context.matches[index], prior = old.matches[index]
        if (next !== undefined && prior !== undefined) matches.set(prior, next)
      }
      // Audited local states may retain top-level Match records. Rebind those
      // readers to the fresh staged timeline, preserving all business values.
      const state = old.state
      if (isRecord(state)) {
        const changes: Record<string, unknown> = {}
        for (const [key,value] of Object.entries(state)) {
          const match = matches.get(value)
          if (match !== undefined) changes[key]=match
        }
        context.state = Object.keys(changes).length === 0 ? state : {...state,...changes}
      } else context.state = state
      context.revision = old.revision
      this.replaceDependencies(context, new Map(old.dependencies))
      reuse.reused.set(context.key, {old, state:context.state})
      this.dirty.add(context)
      return
    }
    reuse?.reused.delete(context.key)
    const start = context.start
    if (start === undefined) {
      context.state = undefined
      return
    }
    if (context.matches[0] !== start) {
      throw new Error(`conversation Context ${context.key} received an update before its start Match`)
    }
    const dependencies = new Map<string, Dependency>()
    const reader = this.readerFor(start.event.seq, dependencies)
    context.state = undefined
    context.state = requireState(
      context.definition,
      'start',
      context.definition.start(contextSnapshot(context), start, reader),
    )
    this.replaceDependencies(context, dependencies)
    for (let index = 1; index < context.matches.length; index++) {
      const match = context.matches[index]
      if (match === undefined || match.role !== 'update') continue
      const typed = { ...contextSnapshot(context), state: context.state }
      context.state = requireState(
        context.definition,
        'update',
        context.definition.update(typed, match),
      )
    }
    context.revision++
    this.revised.add(context)
    this.dirty.add(context)
  }

  private reusable(context: InternalContext, old: InternalContext): boolean {
    const reuse = this.historyReuse
    if (reuse === undefined || context.definition !== old.definition || context.definition.historyReuse !== 'local'
      || isRecord(old.state) && old.state.hidden === true) return false
    if (context.matches.length !== old.matches.length || context.matches.some((match,index) => {
      const prior = old.matches[index]
      return prior === undefined || match.event !== prior.event || match.view !== prior.view || match.role !== prior.role
        || !equalBoundary(match.location,prior.location,reuse.boundaries)
    })) return false
    for (const dependency of old.dependencies.values()) {
      const current = context.startSeq === undefined ? undefined : this.previousContext(dependency.kind, context.startSeq)
      const prior = dependency.key === undefined ? undefined : reuse.committed.contexts.get(dependency.key)
      if (current?.key !== dependency.key
        || current?.state !== prior?.state && (current === undefined || reuse.reused.get(current.key)?.old !== prior)
        || (current === undefined && this.hasMore) !== dependency.windowGap) return false
    }
    return true
  }

  private replaceDependencies(context: InternalContext, dependencies: Map<string, Dependency>): void {
    for (const dependency of context.dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key)
      current?.delete(context)
      if (current?.size === 0) this.dependents.delete(dependency.key)
    }
    context.dependencies = dependencies
    for (const dependency of dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key) ?? new Set()
      current.add(context)
      this.dependents.set(dependency.key, current)
    }
  }

  private replayRevisedDependents(): boolean {
    const pending = [...this.revised]
    const affected = new Set<InternalContext>()
    for (let index = 0; index < pending.length; index++) {
      const dependency = pending[index]
      if (dependency === undefined) continue
      for (const dependent of this.dependents.get(dependency.key) ?? []) {
        if (affected.has(dependent)) continue
        affected.add(dependent)
        pending.push(dependent)
      }
    }
    this.replayContexts(affected)
    return affected.size > 0
  }

  private readerFor(
    beforeSeq: number,
    dependencies: Map<string, Dependency>,
  ): ConversationContextReader {
    return {
      previous: (kind: string): ConversationPreviousContext | undefined => {
        const predecessor = this.previousContext(kind, beforeSeq)
        dependencies.set(kind, {
          kind,
          key: predecessor?.key,
          revision: predecessor?.revision,
          windowGap: predecessor === undefined && this.hasMore,
        })
        if (predecessor?.state === undefined) return undefined
        const seq = startSeq(predecessor)
        if (seq === undefined) return undefined
        return {
          key: predecessor.key,
          kind: predecessor.kind,
          id: predecessor.id,
          startSeq: seq,
          state: predecessor.state,
          matches: predecessor.matches,
        }
      },
    }
  }

  private previousContext(kind: string, beforeSeq: number): InternalContext | undefined {
    const candidates = this.contextsByKind.get(kind) ?? []
    const indexBefore = insertionIndex(candidates, beforeSeq)
    for (let index = indexBefore - 1; index >= 0; index--) {
      const candidate = candidates[index]
      if (candidate?.state !== undefined) return candidate
    }
    return undefined
  }

  /** Insert one newly discovered start into its Definition's ordered predecessor index. */
  private indexStartedContext(context: InternalContext): void {
    const seq = context.startSeq
    if (seq === undefined) return
    const candidates = this.contextsByKind.get(context.kind) ?? []
    const previous = candidates.at(-1)
    if (previous === undefined || previous.startSeq !== undefined && previous.startSeq < seq) candidates.push(context)
    else candidates.splice(insertionIndex(candidates, seq), 0, context)
    this.contextsByKind.set(context.kind, candidates)
  }

  private indexStartedContexts(kind: string, additions: readonly InternalContext[]): void {
    if (additions.length === 0) return
    const sorted = [...additions].sort((left, right) =>
      requireStartSeq(left) - requireStartSeq(right))
    const existing = this.contextsByKind.get(kind) ?? []
    const merged: InternalContext[] = []
    let before = 0
    let added = 0
    while (before < existing.length || added < sorted.length) {
      const left = existing[before]
      const right = sorted[added]
      if (right === undefined || (left !== undefined && requireStartSeq(left) < requireStartSeq(right))) {
        if (left === undefined) break
        merged.push(left)
        before++
      } else {
        merged.push(right)
        added++
      }
    }
    this.contextsByKind.set(kind, merged)
  }

  private replayDependencies(): boolean {
    let replayed = false
    const ordered = [...this.contexts.values()]
      .filter(context => startSeq(context) !== undefined)
      .sort((left, right) => requireStartSeq(left) - requireStartSeq(right))
    for (const context of ordered) {
      if (context.state === undefined || context.dependencies.size === 0) continue
      const before = startSeq(context)
      if (before === undefined) continue
      let changed = false
      for (const dependency of context.dependencies.values()) {
        const current = this.previousContext(dependency.kind, before)
        const windowGap = current === undefined && this.hasMore
        if (current?.key !== dependency.key
          || current?.revision !== dependency.revision
          || windowGap !== dependency.windowGap) {
          changed = true
          break
        }
      }
      if (changed) {
        this.replayContext(context)
        replayed = true
      }
    }
    return replayed
  }

  private refreshMatchLocations(changedSeqs: ReadonlySet<number>): Set<InternalContext> {
    const affected = new Set<InternalContext>()
    if (changedSeqs.size === 0) return affected
    for (const seq of changedSeqs) {
      for (const context of this.contextsBySeq.get(seq) ?? []) affected.add(context)
    }
    for (const context of affected) {
      let start = context.start
      const matches = context.matches.map((match): ConversationMatch => {
        if (!changedSeqs.has(match.event.seq)) return match
        const refreshed = { ...match, location: this.locationIndex.locationOf(match.event) }
        if (match === start) start = refreshed
        return refreshed
      })
      context.matches = matches
      context.start = start
    }
    return affected
  }

  private buildNode(context: InternalContext, target: string): ConversationViewNode | null {
    const cached = this.historyReuse?.reused.get(context.key)
    if (cached !== undefined && context.state === cached.state) {
      const node = cached.old.current.get(target) ?? null
      if (node === null) return null
      const location = context.start?.location ?? context.matches[0]?.location
      if (!('location' in node) || node.location === undefined || location === undefined || location === node.location) return node
      const rebound = {...node,location}
      return rebound
    }
    if (context.definition.target !== target || context.definition.buildViewNode === undefined) return null
    const node = context.definition.buildViewNode(contextSnapshot(context))
    if (node === null) return null
    if (node.key !== context.key) {
      throw new Error(`conversation Definition "${context.kind}" returned unstable key "${node.key}"; expected "${context.key}"`)
    }
    if (node.target !== target) {
      throw new Error(`conversation Definition "${context.kind}" returned target "${node.target}" while building "${target}"`)
    }
    return node
  }

  private buildLocationData(
    context: InternalContext,
    scope: ConversationLocationDataScope,
  ): ConversationLocationData | null {
    const cached = this.historyReuse?.reused.get(context.key)
    if (cached !== undefined && context.state === cached.state) return cached.old.locationData[scope]
    if (context.definition.buildLocationData === undefined) return null
    const data = context.definition.buildLocationData(contextSnapshot(context), scope)
    if (data === null) return null
    if (data.kind !== scope) {
      throw new Error(
        `conversation Definition "${context.kind}" published ${data.kind} data through its ${scope} scope`,
      )
    }
    if (data.key !== context.kind) {
      throw new Error(
        `conversation Definition "${context.kind}" published Location data key "${data.key}"; expected its owned kind`,
      )
    }
    if (!Number.isSafeInteger(data.turn) || data.turn < 0) {
      throw new Error(`conversation Definition "${context.kind}" published invalid turn ${data.turn}`)
    }
    if (data.kind === 'step' && (typeof data.step !== 'number' || !Number.isSafeInteger(data.step) || data.step < 0)) {
      throw new Error(`conversation Definition "${context.kind}" published invalid step ${String(data.step)}`)
    }
    return data
  }

  private replaceLocationData(): void {
    const entries: { owner: string; data: ConversationLocationData }[] = []
    for (const scope of LOCATION_DATA_SCOPES) {
      for (const context of this.contexts.values()) {
        const data = this.buildLocationData(context, scope)
        context.locationData[scope] = data
        if (data !== null) entries.push({ owner: context.key, data })
      }
      // Turn publishers may read Step data from this same flush, so each phase
      // installs the cumulative replacement before the next phase builds.
      this.locationIndex.replaceData(entries)
    }
  }

  private applyDirtyLocationData(): boolean {
    let changed = false
    for (const scope of LOCATION_DATA_SCOPES) {
      const changes: ConversationLocationDataChange[] = []
      for (const context of this.dirty) {
        const previous = context.locationData[scope]
        const next = this.buildLocationData(context, scope)
        context.locationData[scope] = next
        if (previous !== next) changes.push({ owner: context.key, previous, next })
      }
      changed = this.locationIndex.applyData(changes) || changed
    }
    return changed
  }

  private resetViewBuilders(): void {
    this.views.clear()
    for (const definition of this.viewDefinitions.entries()) {
      const builder = definition.create()
      this.views.set(definition.target, {
        target: definition.target,
        builder,
        snapshot: builder.empty,
      })
    }
    this.replacePending = true
  }
}

function isLocationBoundary(type: string): boolean {
  return type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end'
}

function requireState(
  definition: ConversationNodeDefinition,
  phase: 'start' | 'update',
  state: unknown,
): unknown {
  if (state === undefined) {
    throw new Error(`conversation Definition "${definition.kind}" returned undefined from ${phase}()`)
  }
  return state
}

/** Structural registry pair accepted by Session and SessionManager. */
export interface ConversationRuntime {
  readonly events: ConversationEventDefinitions & { subscribe(listener: () => void): () => void }
  readonly views: ConversationViewDefinitions & { subscribe(listener: () => void): () => void }
}

function requireStartSeq(context: InternalContext): number {
  if (context.startSeq === undefined) throw new Error(`conversation Context ${context.key} has no start seq`)
  return context.startSeq
}

/** Immutable boundary equality is memoized once per pair, not per streaming Match. */
function equalBoundary(left: ConversationLocation, right: ConversationLocation,
  pairs: WeakMap<TurnLocation, WeakMap<TurnLocation, boolean>>): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  if (left.kind === 'session' || left.kind === 'unresolved') return true
  if (right.kind === 'session' || right.kind === 'unresolved') return false
  if ((left.kind === 'step' ? left.step.step : undefined) !== (right.kind === 'step' ? right.step.step : undefined)) return false
  const a=left.turn,b=right.turn
  if (a===b) return true
  let compared=pairs.get(a)
  if (compared===undefined) {compared=new WeakMap();pairs.set(a,compared)}
  const cached=compared.get(b)
  if (cached!==undefined) return cached
  const equal=a.turn===b.turn && a.status===b.status && a.start===b.start && a.end===b.end
    && a.steps.length===b.steps.length && a.steps.every((step,index)=>{
      const other=b.steps[index]
      return other!==undefined && step.step===other.step && step.status===other.status && step.start===other.start && step.end===other.end
    })
  compared.set(b,equal)
  return equal
}
