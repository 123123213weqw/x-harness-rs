import { readChatSnapshot } from './chat-snapshot-codec'
import { validateSessionTerminal } from '../../shared/session-terminal'
// Sessions remain resident after creation so they continue consuming mux frames off-screen.

import type { Context } from '../context'
import type { AttachmentIdType, ImageAttachmentRef } from '../../client-connection/contracts/facades/attachment'
import type { SessionWireEvent } from '../../client-connection/contracts/host/apiproxy/api/sessions'
import type {
  HistoryEntry, IApiClient, MessageId, MuxFrame, PromptContentPart, QueueAction, RpcError,
  RpcId, RpcResponse, RpcResult, SessionId, SubagentAddress, ToolEventView,
} from '../../client-connection/index'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '../../client-connection/contracts/host/apiproxy/api/index'
import type { HistoryOpenTarget, SessionFace } from '../contract/session'
import { ConversationNodeAssembler } from './conversation-assembler'
import type { ConversationRuntime } from './conversation-assembler'
import type { ConversationEventInput, ConversationPublication } from '../contract/conversation'
import type {
  ChatSnapshot, ComposerPhase, ConversationSnapshot, HistoryMappingError, OpenState, PromptError,
} from './conversation'
import { EMPTY_CHAT_SNAPSHOT } from './conversation'
import type { PendingInteraction } from './pending'
import { PendingWait } from './pending'
import { Notifier } from './notifier'
import type { RemoteResult } from '../remote-contracts'
import type { SessionRemotes } from './remotes'
import { ProjectionValueStore } from './projection-store'
import type { ProjectionsBaseline } from './projection-store'
import { resolvedClientTimeZone } from '../time-zone'
import type { HistoryCache } from './history-cache'
import { SessionQueueMirror } from './queue-mirror'
import { ACTIVE_WINDOW, activeWindowCut, payloadWeight } from './active-working-set'
import { CooperativeDelivery } from './cooperative-delivery'

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /** Manager-owned production delivery yields between bounded event slices. */
  cooperativeEvents?: boolean
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /** Whether the exact direct parent Agent was live at the latest catalog read. */
  parentAvailable?: boolean
  /**
   * First ACCEPTED prompt on a blank session (fires at most once, on the
   * prompt RPC's success response): the manager mirrors the blank→false flip
   * into its list row so the session surfaces without waiting for a host
   * frame. Acceptance is the flip point because it proves the user message
   * is in the host log; a rejected first prompt keeps the session blank
   * (hidden, still reusable by connectWorkspace).
   */
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
  /** Runtime registries used by this Session-owned Conversation assembler. */
  conversation?: ConversationRuntime
}

/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are manager/runtime entry points.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  xhHistoryOwner: HistoryCache | undefined
  private xhRestoreBaseSeq: number | undefined
  private historyOpenTarget: HistoryOpenTarget | undefined
  private historyGeneration = new AbortController()
  private historyRangeRead: AbortController | undefined
  private xhPendingOperations = 0
  private xhLiveRecoveryAt: number | undefined
  private events: SessionWireEvent[] = []
  /** Wire views aligned with `events` by index (envelope-level annotations; undefined = no view).
   *  Kept parallel rather than merged so `events` stays the raw log slice (model-visible ⟺ logged). */
  private views: (ToolEventView | undefined)[] = []
  private eventWeights: number[] = []
  private eventBytes = 0
  private trimAfterEvents: number = ACTIVE_WINDOW.highEvents
  private trimAfterBytes: number = ACTIVE_WINDOW.highBytes
  private olderPagePinned = false
  private stopRequested = false
  private cancelEpoch = 0
  private cancelPromise: Promise<RpcResult<{ accepted: true }>> | undefined
  private readonly delivery: CooperativeDelivery<{ event: SessionWireEvent; view: ToolEventView | undefined }> | undefined
  private liveBufferBytes = 0
  private baseSeq = 0
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RpcError | HistoryMappingError | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by resync to invalidate an in-flight doOpen: a reconnect must rebuild, never adopt
   *  a pre-disconnect open whose history request is already doomed. Stale doOpen
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  private pending = new Map<string, PendingInteraction>()
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  /** Authoritative stream-only inbox snapshot; pending work never hits history. */
  private readonly queueMirror = new SessionQueueMirror()
  /** Session-owned business Context engine over the contiguous raw window. */
  private readonly conversation: ConversationNodeAssembler
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable = false
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * synchronously before prompt()'s first await, never reset — the blank →
   * engaging edge of the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  /** Empty-log mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
  private blankBit = true
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  private agentErrorGeneration = 0
  /** Live events buffered during open/resync and stitched by sequence once history lands. */
  private liveBuffer: { event: SessionWireEvent; view: ToolEventView | undefined }[] = []
  /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the host, seeded by the tail page's
   * projections block and updated by `session/projection` frames under the
   * one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  private snapshotCache: ConversationSnapshot
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by SessionRuntime when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param api - shared wire client.
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.address = options.address
    this.parentAvailable = options.parentAvailable ?? false
    this.conversation = options.conversation === undefined
      ? new ConversationNodeAssembler(
        { entries: () => [], fallbackEntry: () => undefined },
        { entries: () => [] },
      )
      : new ConversationNodeAssembler(options.conversation.events, options.conversation.views)
    this.delivery = options.cooperativeEvents ? new CooperativeDelivery(
      ({ event, view }) => this.acceptLiveEvent(event, view),
      error => this.failLiveBacklog(error),
    ) : undefined
    this.notifier = new Notifier(() => {
      this.trimActiveWindow()
      this.conversation.flush()
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Bind the Agent-scoped context minted by SessionRuntime (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
   * @param content - text, browser uploads or durable attachment references.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  private async doPrompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    options: {requireIdle?: boolean} = {},
  ): Promise<RpcResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Synchronous, before the first await: the blank → engaging edge must be
    // visible on the session area's very first frame when a caller sends
    // ahead of navigation (first-send flow).
    this.promptAttempted = true
    if (this.blankBit) this.firstPromptPendingTurn = true
    this.notifier.markDirty()
    let result: RpcResult<{ accepted: true }>
    try {
      if (this.address === undefined) {
        result = (await this.api.sessions.prompt({
          sessionId: this.sessionId,
          mode,
          content,
          ...(options.requireIdle === true ? {requireIdle: true} : {}),
          clientTimeZone: resolvedClientTimeZone(),
        }, signal)).result
      } else if (this.address.mode === 'one-shot') {
        result = {
          ok: false,
          error: {
            code: 'subagent-not-resumable',
            message: 'one-shot subagent conversations are read-only',
            details: { childSessionId: this.address.childSessionId },
          },
        }
      } else {
        if (content.some(part => part.type === 'image' || part.type === 'image_ref'
          || part.type === 'file' || part.type === 'file_ref')) {
          result = {
            ok: false,
            error: {
              code: 'attachment-error',
              message: 'Image input is unavailable for subagent continuations.',
              details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' },
            },
          }
        } else {
          const routed = (await this.api.subagents.prompt({
            ...this.address,
            content: content.flatMap(part => part.type === 'text'
              ? [{ type: 'text' as const, text: part.text }]
              : []),
            clientTimeZone: resolvedClientTimeZone(),
          }, signal)).result
          result = routed.ok ? { ok: true, value: { accepted: true } } : routed
        }
      }
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
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
      this.blankBit = false
      this.options.onEngaged?.(this)
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Resolve one image referenced by this session into browser-consumable bytes.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    try {
      const result = (await this.api.sessions.attachment({
        sessionId: this.sessionId,
        attachmentId,
      })).result
      if (!result.ok) return result
      const binary = atob(result.value.data)
      const data = Uint8Array.from(binary, char => char.charCodeAt(0))
      return { ok: true, value: { attachment: result.value.attachment, data } }
    } catch (error) {
      return transportError(error)
    }
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>> {
    try {
      return (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId, action })).result
    } catch (error) {
      return transportError(error)
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
  cancel(): Promise<RpcResult<{ accepted: true }>> {
    if (this.cancelPromise !== undefined) return this.cancelPromise
    if (this.stopRequested) return Promise.resolve({ ok: true, value: { accepted: true } })
    this.stopRequested = this.running
    const epoch = this.cancelEpoch
    this.notifier.markDirty()
    const pending = this.doCancel(epoch).finally(() => {
      if (this.cancelPromise === pending) this.cancelPromise = undefined
    })
    this.cancelPromise = pending
    return pending
  }

  private async doCancel(epoch: number): Promise<RpcResult<{ accepted: true }>> {
    const address = this.address
    if (address !== undefined && address.mode === 'one-shot') {
      const result: RpcResult<{ accepted: true }> = {
        ok: false,
        error: {
          code: 'subagent-delivery-unavailable',
          message: 'subagent activation cancellation is unavailable',
          details: { childSessionId: address.childSessionId },
        },
      }
      this.stopRequested = false
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
      return result
    }
    let result: RpcResult<{ accepted: true }>
    try {
      result = address !== undefined
        ? (await this.api.subagents.interrupt(address)).result
        : (await this.api.sessions.cancel({ sessionId: this.sessionId })).result
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok && epoch === this.cancelEpoch) {
      this.stopRequested = false
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
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
  async rename(title: string): Promise<RpcResult<{ title: string; seq: number }>> {
    try {
      const { result } = await this.api.sessions.rename({ sessionId: this.sessionId, title })
      if (result.ok) this.projections.apply('title', result.value.title, result.value.seq)
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the error branch on transport failure.
   */
  private async doCommand(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    if (!result.ok) return result
    if (line.trim() === '/reload' && result.value !== undefined) {
      if (result.value.result.kind !== 'success') return transportError(new Error(result.value.result.text ?? 'Session restart was not successful'))
      try { await this.recoverHistory() } catch (error) { return transportError(error) }
    }
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** Called only after an explicit successful worker-recovery receipt. */
  async recoverHistory(): Promise<void> {
    const errorGeneration = this.agentErrorGeneration
    await this.resync()
    if (this.openState !== 'open') throw new Error(this.openError?.message ?? 'Session restarted but history could not be restored')
    // A new turn/error may arrive while history is in flight. Recovery owns
    // only the prior error, even when the newer message has identical text.
    if (this.agentErrorGeneration === errorGeneration) this.lastAgentError = null
    this.notifier.markDirty()
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  private openEntry(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
  loadOlder(): Promise<void> { return this.historyOperation(() => this.doLoadOlder(), true) }

  private async doLoadOlder(): Promise<void> {
    if (this.openState === 'error') return this.retryHistory()
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder || this.stitching) return
    this.olderPagePinned = true
    this.loadingOlder = true
    const generation = this.openGeneration, beforeSeq = this.baseSeq
    this.notifier.markDirty()
    try {
      const { result } = await this.history({ beforeSeq, maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration || this.openState !== 'open' || this.stitching) return
      const value = this.responseValue(result), older = value.events
      if (this.baseSeq !== beforeSeq) throw new Error('History window changed during pagination; retry history loading')
      if (older.length && !this.xhValidHistoryPage(older, beforeSeq)) throw new Error('History projected page is invalid; retry history loading')
      if (!older.length && value.hasMore) throw new Error('History page made no progress; retry history loading')
      const entries = [...older, ...this.events.map((event, index) => ({ event, view: this.views[index] }))]
      this.installWindow(entries, value.hasMore)
    } catch (error) {
      if (generation === this.openGeneration) this.failHistory(error)
    } finally {
      if (generation === this.openGeneration) { this.loadingOlder = false; this.notifier.markDirty() }
    }
  }

  /** Invalidate only history reads; model, tool, and mutation requests have separate owners. */
  private advanceHistoryGeneration(): void {
    this.openGeneration++
    this.historyGeneration.abort()
    this.historyGeneration = new AbortController()
  }

  /** Invalidate dead-transport work before any new-generation frame arrives. */
  invalidateConnectionGeneration(): void {
    this.delivery?.clear()
    this.liveBuffer = []
    this.liveBufferBytes = 0
    this.stopRequested = false
    this.cancelEpoch++
    this.cancelPromise = undefined
    this.advanceHistoryGeneration()
    this.openPromise = null
    this.loadingOlder = false
    this.stitching = false
    for (const wait of this.pending.values()) wait.markSettled?.()
    this.pending.clear()
    this.pendingRev++
    this.subscribedLastSeq = null
    this.notifier.markDirty()
  }

  /** Reconnect retains committed history until a complete replacement succeeds. */
  async resync(): Promise<void> {
    if (this.openState === 'cold') return
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq
    this.advanceHistoryGeneration()
    this.loadingOlder = false
    this.stitching = false
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    // New-generation mux baseline may precede readiness. Cleanup belongs to
    // transport death, never this readiness-triggered history replacement.
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached conversation snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): ConversationSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Mux frame arrival (the dispatch switch).
   * @param rpcId - the frame envelope id (the respond backfill key for requested frames).
   * @param frame - the routed frame.
   */
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void {
    if (frame.type === 'session/event' && this.delivery !== undefined) {
      this.delivery.push({ event: frame.event, view: frame.view }, payloadWeight([frame.event, frame.view]))
    } else this.dispatchMuxEnvelope(rpcId, frame)
    if (frame.type === 'session/event') void this.xhRecoverLiveAnswer()
    this.xhHistoryOwner?.schedule()
  }

  private dispatchMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/event': {
        this.acceptLiveEvent(frame.event, frame.view)
        return
      }
      case 'session/queue': {
        this.queueMirror.replace(frame.items, this.events)
        this.notifier.markDirty()
        return
      }
      case 'session/subscribed': {
        this.subscribedLastSeq = frame.lastSeq
        // New mux-generation baseline: the host pushes this session's queue
        // snapshot AFTER the subscribed frame on the same stream, so the
        // stale mirror clears here — race-free against onConnected/resync
        // timing (clearing there could wipe a baseline that already landed).
        if (this.queueMirror.reset()) this.notifier.markDirty()
        return
      }
      case 'approval/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('approval', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'approval/resolved': {
        for (const item of this.pending.values()) {
          if (item.kind === 'approval' && item.payload.approvalId === frame.approvalId) this.settle(item)
        }
        this.notifier.markDirty()
        return
      }
      case 'question/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('question', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'question/resolved': {
        const item = this.pending.get(`q:${frame.questionRpcId}`)
        if (item !== undefined) this.settle(item)
        this.notifier.markDirty()
        return
      }
      default:
        return // stream/error never reaches Session (Controller converges it); unknown frames ignored (documented default)
    }
  }

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    this.applyRunning(running)
    if (running) void this.xhRecoverLiveAnswer()
    this.xhHistoryOwner?.schedule()
  }

  private applyRunning(running: boolean): void {
    if (!running && (this.running || this.stopRequested)) {
      this.stopRequested = false
      this.cancelEpoch++
      this.cancelPromise = undefined
      this.notifier.markDirty()
    }
    // Turn-start conversion: a blank session never runs, so the first
    // running:true proves another side's first message landed.
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   * @param parentAvailable - latest exact-parent availability hint.
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable = false): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Update only the parent availability hint from a catalog refresh.
   * @param available - whether the exact direct parent is live.
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * Blank-bit relay from the authoritative summary source (list baseline and
   * the session-added frame). Monotone: once any signal (local first send,
   * running flip, an earlier summary) cleared it, a stale true never
   * re-blanks.
   * @param blank - the summary's derived empty-log bit.
   */
  handleBlank(blank: boolean): void {
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** host/session-removed relay: flag the snapshot (instance survives — resident-instance rule). */
  handleRemoved(): void {
    this.delivery?.clear()
    this.liveBuffer = []
    this.liveBufferBytes = 0
    this.stopRequested = false
    this.cancelEpoch++
    this.cancelPromise = undefined
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * host/agent-error relay: the only outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.agentErrorGeneration++
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /** No-op because session instances remain resident. */
  dispose(): void {}

  /** Rebuild the current window after a low-frequency Definition or view registration change. */
  rebuildConversationRegistry(): void {
    this.scheduleConversation(this.conversation.rebuildRegistry())
  }

  // ---- Private ----

  /** Requested-frame arrival: the wait enters the pending map under its own key. */
  private mint(wait: PendingInteraction): void {
    this.pending.set(wait.key, wait)
    this.pendingRev++
  }

  /** Authoritative resolved-frame settlement: mark, then drop from the pending map. */
  private settle(wait: PendingInteraction): void {
    wait.markSettled()
    this.pending.delete(wait.key)
    this.pendingRev++
    this.xhHistoryOwner?.schedule()
  }

  /** @param generation - openGeneration at launch; every await re-checks it and a stale pass
   *  drops all writes (resync superseded this open — its outcome belongs to a dead connection). */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    try {
      let { result } = await this.history({ maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration) return
      if (!result.ok) {
        this.openState = 'error'
        this.openError = result.error
        return
      }
      result = { ...result, value: await this.restoreHistoryRange(result.value, generation) }
      if (generation !== this.openGeneration) return
      this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
      // Gap detection: baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
      const tailSeq = this.windowTailSeq()
      if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
        result = (await this.history({ maxMessages: PAGE_MESSAGES })).result
        if (generation !== this.openGeneration) return
        if (result.ok) {
          result.value = await this.restoreHistoryRange(result.value, generation)
          if (generation !== this.openGeneration) return
          this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
        }
      }
      this.openState = 'open'
      this.xhRestoreBaseSeq = undefined
    } catch (error) {
      if (generation !== this.openGeneration) return
      this.openState = 'error'
      const folded = transportError<never>(error)
      /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
      this.openError = folded.ok ? null : folded.error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Install the history window + stitch the liveBuffer (seq is the sole dedup key).
   *  Stitching MUST NOT route through acceptLiveEvent: openState is still 'loading' here
   *  (doOpen flips it after install), so recursing would push every buffered event straight
   *  back into liveBuffer where nothing ever drains it — a silent drop loop.
   *  A carried projections block seeds the value store (higher seq wins, so a stale
   *  baseline cannot overwrite a newer push frame); the window events themselves are
   *  never folded — the host is the only computation site. */
  private installWindow(entries: WindowEntry[], hasMore: boolean, projections?: ProjectionsBaseline | undefined): void {
    const combined = [...entries]
    let tail = combined.at(-1)?.event.seq
    const buffered = [...this.liveBuffer].sort((a, b) => a.event.seq - b.event.seq)
    const accepted: typeof this.liveBuffer = []
    for (const item of buffered) {
      if (tail !== undefined && item.event.seq <= tail) continue
      if (tail !== undefined && item.event.seq !== tail + 1) throw new Error('History live-buffer gap; retry history loading')
      combined.push(item)
      accepted.push(item)
      tail = item.event.seq
    }
    const committedTail = this.events.at(-1)?.seq
    if (committedTail !== undefined && (tail === undefined || tail < committedTail)) throw new Error('History window moved backwards; retry history loading')
    const prependOnly = this.events.length > 0 && accepted.length === 0 && combined.length >= this.events.length
      && this.events.every((event,index) => {
        const candidate=combined[combined.length-this.events.length+index]
        return candidate!==undefined && candidate.event===event && candidate.view===this.views[index]
      })
    const staged = this.conversation.stageReplacement(combined.map(conversationInput), hasMore, prependOnly)
    const events = combined.map(entry => entry.event), views = combined.map(entry => entry.view)
    Object.assign(this.conversation, staged)
    this.events = events
    this.views = views
    this.eventWeights = events.map((event, index) => payloadWeight([event, views[index]]))
    this.eventBytes = this.eventWeights.reduce((sum, bytes) => sum + bytes, 0)
    this.trimAfterEvents = ACTIVE_WINDOW.highEvents
    this.trimAfterBytes = ACTIVE_WINDOW.highBytes
    this.baseSeq = events[0]?.seq ?? 0
    this.hasMore = hasMore
    if (events.some(event => event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    // A queue baseline may have landed before history on open/reconnect.
    // Reconcile the complete installed window, not only newly buffered events.
    for (const event of events) this.queueMirror.acceptDurable(event)
    this.liveBuffer = []
    this.liveBufferBytes = 0
    this.notifier.markDirty()
    this.xhHistoryOwner?.changed(this)
  }

  /** Seq-guarded append shared by stitching and the open-state live path. */
  private appendLive(event: SessionWireEvent, view?: ToolEventView): ConversationPublication {
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq <= tailSeq) return 'none' // replay overlap, drop
    const input = conversationInput({ event, view })
    this.events.push(event)
    this.views.push(view)
    const bytes = payloadWeight([event, view])
    this.eventWeights.push(bytes)
    this.eventBytes += bytes
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    const queueChanged = this.queueMirror.acceptDurable(event)
    const publication = this.conversation.append(input)
    this.xhHistoryOwner?.changed(this)
    return queueChanged ? 'immediate' : publication
  }

  /** Land a live session/event (open/repair in flight -> buffer; overlapping seq -> drop;
   *  a seq gap -> buffer + tail-page repull instead of appending a hole (a gap is an
   *  expected reconnect-window artifact, repaired by refetch). The window stays one contiguous
   *  raw range, which lets Conversation Definitions correlate every recorded event between its
   *  ends and lets a compaction checkpoint resolve its cited summary event. */
  private acceptLiveEvent(event: SessionWireEvent, view?: ToolEventView): void {
    if (this.openState === 'error' || this.openState === 'loading' || this.stitching) {
      this.bufferLive(event, view)
      return
    }
    if (this.openState !== 'open') return // cold/error: no window upkeep (history fully backfills on open)
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq <= tailSeq) return // an already committed seq cannot mutate or poison the view
    if (tailSeq !== null && event.seq > tailSeq + 1) {
      this.bufferLive(event, view)
      void this.repairGap()
      return
    }
    try {
      validateSessionTerminal(event)
    } catch (error) {
      // A terminal protocol failure cannot close only half of the UI. Preserve
      // the last window, retain the carrier for history reconciliation, and
      // reuse the existing visible/retryable history error path.
      this.bufferLive(event, view)
      this.failHistory(error)
      return
    }
    this.scheduleConversation(this.appendLive(event, view))
  }

  private bufferLive(event: SessionWireEvent, view: ToolEventView | undefined): void {
    const bytes = payloadWeight([event, view])
    if (this.liveBuffer.length >= ACTIVE_WINDOW.highEvents || this.liveBufferBytes + bytes > ACTIVE_WINDOW.highBytes) {
      this.failLiveBacklog()
      return
    }
    this.liveBuffer.push({ event, view })
    this.liveBufferBytes += bytes
  }

  private failLiveBacklog(error: unknown = new Error('Live history backlog exceeded the UI budget; reload history to reconcile')): void {
    // The Host journal remains authoritative. Never replay a mutation to
    // recover UI evidence, or adopt a partial old-generation history read.
    this.delivery?.clear()
    this.liveBuffer = []
    this.liveBufferBytes = 0
    this.advanceHistoryGeneration()
    this.openPromise = null
    this.stitching = false
    this.loadingOlder = false
    this.failHistory(error)
  }

  private trimActiveWindow(): void {
    if (this.openState !== 'open' || this.loadingOlder || this.stitching || this.openPromise !== null
      || this.olderPagePinned || this.historyOpenTarget?.kind === 'anchor') return
    if (this.events.length <= this.trimAfterEvents && this.eventBytes <= this.trimAfterBytes) return
    // A protected huge turn/dependency chain must not trigger an O(N) policy
    // scan for every streaming chunk. Retry only after meaningful growth.
    this.trimAfterEvents = this.events.length + 256
    this.trimAfterBytes = this.eventBytes + 512 * 1024
    const cut = activeWindowCut(this.events, this.eventWeights, this.eventBytes)
    const first = this.events[cut]
    if (cut === 0 || first === undefined || !this.conversation.canTrimBefore(first.seq)) return
    const events = this.events.slice(cut), views = this.views.slice(cut)
    // Stage atomically. Current-turn evidence, in-flight tools and turn-end
    // artifacts remain intact; older complete turns reload through loadOlder.
    const staged = this.conversation.stageReplacement(events.map((event, index) => ({ event, view: views[index] })), true, true)
    Object.assign(this.conversation, staged)
    this.events = events
    this.views = views
    this.eventWeights = this.eventWeights.slice(cut)
    this.eventBytes = this.eventWeights.reduce((sum, bytes) => sum + bytes, 0)
    this.baseSeq = events[0]?.seq ?? 0
    this.trimAfterEvents = ACTIVE_WINDOW.highEvents
    this.trimAfterBytes = ACTIVE_WINDOW.highBytes
    this.hasMore = true
    this.xhHistoryOwner?.changed(this)
  }

  /** Route assembler cadence into the Session's existing microtask/RAF notifier. */
  private scheduleConversation(publication: ConversationPublication): void {
    if (publication === 'immediate') this.notifier.markDirty()
    else if (publication === 'animation-frame') this.notifier.markFrameDirty()
  }

  /** Resync-lite: repull the tail page and stitch the liveBuffer through the shared
   *  installWindow path. No openState transition — the UI keeps the current window (no loading
   *  flash); events arriving meanwhile detour to liveBuffer via the stitching flag. */
  private repairGap(): Promise<void> { return this.historyOperation(() => this.doRepairGap()) }

  private async doRepairGap(): Promise<void> {
    if (this.stitching) return
    this.stitching = true
    const generation = this.openGeneration
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq
    try {
      const { result } = await this.history({ maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration || this.openState !== 'open') return
      const value = await this.restoreHistoryRange(this.responseValue(result), generation)
      if (generation !== this.openGeneration || this.openState !== 'open') return
      this.installWindow(value.events, value.hasMore, value.projections)
      this.xhRestoreBaseSeq = undefined
    } catch (error) {
      if (generation === this.openGeneration) this.failHistory(error)
    } finally {
      if (generation === this.openGeneration) this.stitching = false
    }
  }

  prompt(content: PromptContentPart[], mode: 'queue' | 'steer', signal?: AbortSignal, options: { requireIdle?: boolean } = {}): Promise<RpcResult<{ accepted: true }>> {
    return this.historyOperation(async () => {
      const result = await this.doPrompt(content, mode, signal, options)
      if (result.ok) void this.xhRecoverLiveAnswer()
      return result
    })
  }

  command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    return this.historyOperation(() => this.doCommand(line))
  }

  open(): Promise<void> { return this.historyOperation(() => this.openEntry()) }

  private historyOperation<T>(operation: () => Promise<T>, dirty = false): Promise<T> {
    this.xhPendingOperations++
    let result: Promise<T>
    try { result = operation() }
    catch (error) { this.xhPendingOperations--; this.xhHistoryOwner?.schedule(); throw error }
    return Promise.resolve(result).finally(() => {
      this.xhPendingOperations--
      if (dirty) this.xhHistoryOwner?.changed(this)
      else this.xhHistoryOwner?.schedule()
    })
  }

  /** Bounded read-only recovery; never resubmits the user's prompt. */
  xhRecoverLiveAnswer(): Promise<void> | undefined {
    if (this.openState !== 'error') return undefined
    if (this.xhHistoryOwner !== undefined && !this.xhHistoryOwner.manager.isCurrent(this.sessionId)) return undefined
    const now = Date.now()
    if (now - (this.xhLiveRecoveryAt ?? 0) < 5000) return undefined
    this.xhLiveRecoveryAt = now
    return this.loadOlder()
  }

  private failHistory(error: unknown): void {
    this.openState = 'error'
    this.openError = { code: 'history-mapping', message: error instanceof Error ? error.message : String(error) }
    this.notifier.markDirty()
  }

  private responseValue<T>(result: RpcResult<T>): T {
    if (!result.ok) throw new Error(result.error.message ?? 'History request failed')
    return result.value
  }

  private async retryHistory(): Promise<void> {
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq
    this.advanceHistoryGeneration()
    this.loadingOlder = false
    this.stitching = false
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.notifier.markDirty()
    await this.open()
  }

  /** Projected pages may omit raw chunk seqs, but must remain ordered and bounded. */
  xhValidHistoryPage(entries: HistoryEntry[], beforeSeq: number): boolean {
    if (!Array.isArray(entries) || entries.length === 0 || !Number.isSafeInteger(beforeSeq)) return false
    let priorSeq = -1
    return entries.every(entry => {
      const seq = entry?.event?.seq
      const ordered = Number.isSafeInteger(seq) && seq >= 0 && seq > priorSeq && seq < beforeSeq
      priorSeq = seq
      return ordered
    })
  }

  /** A reader hint is lightweight and remains resident when history is evicted. */
  setHistoryOpenTarget(target: HistoryOpenTarget | undefined): void {
    if (target?.kind === 'anchor' && (!Number.isSafeInteger(target.seq) || target.seq < 0)) {
      throw new Error('History reading anchor must be a non-negative safe event sequence')
    }
    if (target?.kind === 'latest' && (this.historyOpenTarget?.kind !== 'latest' || this.olderPagePinned)) {
      this.olderPagePinned = false
      this.trimAfterEvents = ACTIVE_WINDOW.highEvents
      this.trimAfterBytes = ACTIVE_WINDOW.highBytes
      this.notifier.markDirty()
    }
    this.historyOpenTarget = target?.kind === 'anchor' ? { kind: 'anchor', seq: target.seq }
      : target === undefined ? undefined : { kind: 'latest' }
    // A cold reader choosing latest no longer needs the pending older page.
    // A reconnect with committed history still restores that window atomically.
    if (this.events.length === 0 && this.historyRestoreTarget() === undefined) this.historyRangeRead?.abort()
  }

  private historyRestoreTarget(): number | undefined {
    // Reconnect/gap repair owns an already committed window: keep it atomic and
    // never shrink it to a tail page, regardless of a later presentation hint.
    if (this.events.length > 0) return this.xhRestoreBaseSeq
    if (this.historyOpenTarget?.kind === 'latest') return undefined
    return this.historyOpenTarget?.kind === 'anchor' ? this.historyOpenTarget.seq : this.xhRestoreBaseSeq
  }

  private async restoreHistoryRange(value: HistoryValue, generation: number): Promise<HistoryValue> {
    let target = this.historyRestoreTarget()
    if (target === undefined) return value
    let entries = value.events, hasMore = value.hasMore
    const pages = [entries]
    while (hasMore && entries[0] !== undefined && entries[0].event.seq > target) {
      const beforeSeq = entries[0].event.seq
      let response: RpcResponse<HistoryValue>
      const read = new AbortController()
      this.historyRangeRead = read
      try { response = await this.history({ beforeSeq, maxMessages: PAGE_MESSAGES }, read.signal) }
      catch (error) {
        if (generation !== this.openGeneration || this.historyRestoreTarget() === undefined) return value
        // Latest may have been superseded by a new bookmark before abort settled.
        if (read.signal.aborted) continue
        throw error
      } finally {
        if (this.historyRangeRead === read) this.historyRangeRead = undefined
      }
      if (generation !== this.openGeneration) return value
      const { result } = response
      // An explicit send/jump can supersede a cold bookmark while this RPC is
      // in flight. Discard unused pages, not the initial validated tail page.
      target = this.historyRestoreTarget()
      if (target === undefined) return value
      if (!result.ok) throw new Error('History restore failed: ' + (result.error.message ?? 'request rejected'))
      entries = result.value.events
      hasMore = result.value.hasMore
      if (!this.xhValidHistoryPage(entries, beforeSeq)) throw new Error('History restore failed: invalid projected page')
      pages.push(entries)
    }
    if (generation !== this.openGeneration) return value
    if (entries[0] === undefined || entries[0].event.seq > target) throw new Error('History restore failed: saved reading position is no longer available')
    return { ...value, events: pages.reverse().flat(), hasMore }
  }

  historyResidencyCold(): boolean { return this.openState === 'cold' }
  historyPayload(): readonly unknown[] { return [this.events, this.views] }
  historyResidencyProtected(): boolean {
    return this.running || this.pending.size > 0 || this.queueMirror.snapshot().length > 0
      || this.firstPromptPendingTurn || this.xhPendingOperations > 0
      || this.openPromise !== null || this.openState === 'loading' || this.loadingOlder || this.stitching
  }

  unloadHistory(): boolean {
    if (this.xhHistoryOwner === undefined || this.xhHistoryOwner.protected(this)) return false
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq
    this.advanceHistoryGeneration()
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.delivery?.clear()
    this.events = []
    this.views = []
    this.eventWeights = []
    this.eventBytes = 0
    this.liveBuffer = []
    this.liveBufferBytes = 0
    this.baseSeq = 0
    this.hasMore = false
    this.subscribedLastSeq = null
    this.conversation.releaseWindow()
    this.notifier.notifyNow()
    this.notifier.ensureFresh()
    return true
  }

  private windowTailSeq(): number | null {
    const tail = this.events[this.events.length - 1]
    return tail === undefined ? null : tail.seq
  }

  private buildSnapshot(): ConversationSnapshot {
    if (this.pendingCache === null || this.pendingCache.rev !== this.pendingRev) {
      this.pendingCache = { rev: this.pendingRev, value: [...this.pending.values()] }
    }
    const chat = readChatSnapshot(this.conversation.snapshot('chat'))
    const legacy = chat.legacy
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
      composerPhase: derivePhase(
        hasVisibleConversationContent(chat)
          || (!this.blankBit && !this.firstPromptPendingTurn)
          || this.running
          || this.pendingCache.value.length > 0,
        this.promptAttempted,
      ),
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
    }
  }

  /** Select ordinary or addressed history transport from the stored browser fact. */
  private history(payload: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal): Promise<RpcResponse<{
    events: HistoryEntry[]
    hasMore: boolean
    projections?: ProjectionsBaseline | undefined
  }>> {
    const readSignal = signal === undefined ? this.historyGeneration.signal
      : AbortSignal.any([this.historyGeneration.signal, signal])
    return this.address === undefined
      ? this.api.sessions.history({ sessionId: this.sessionId, ...payload }, readSignal)
      : this.api.subagents.history({ ...this.address, ...payload }, readSignal)
  }
}

/** Convert one wire history row into the assembler's transport-neutral input. */
function conversationInput(entry: WindowEntry): ConversationEventInput {
  validateSessionTerminal(entry.event)
  return { event: entry.event, view: entry.view }
}

/** A generic command row alone remains control-plane content; every other visible Chat Node activates the conversation. */
function hasVisibleConversationContent(chat: ChatSnapshot): boolean {
  return chat.order.some(key => chat.nodes.get(key)?.kind !== 'command')
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
function derivePhase(hasContent: boolean, promptAttempted: boolean): ComposerPhase {
  if (hasContent) return 'active'
  return promptAttempted ? 'engaging' : 'blank'
}

interface HistoryValue { events: HistoryEntry[]; hasMore: boolean; projections?: ProjectionsBaseline | undefined }

interface WindowEntry { event: SessionWireEvent; view?: ToolEventView | undefined }
