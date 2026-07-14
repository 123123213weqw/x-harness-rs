// History transactions are low-frequency. Streaming append stays incremental.
function installAtomicHistory(Assembler, Session, Manager) {
  const replace = Assembler.prototype.replaceWindow;
  const acceptLiveEvent = Session.prototype.acceptLiveEvent;
  // Reuse only explicitly local, immutable Definition state. The candidate
  // still owns fresh indexes, location stores and view builders: failed mapping
  // or rendering cannot mutate the committed window. Scanning remains O(n), but
  // expensive reducers and node materialization skip unchanged contexts.
  // Boundaries are immutable; compare each old/new Turn pair once, not once
  // per Match (a long turn can contain many streaming chunks).
  const boundaryPairs = new WeakMap();
  function equalBoundary(left, right) {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'session' || left.kind === 'unresolved') return true;
    if (left.step?.step !== right.step?.step) return false;
    const a = left.turn, b = right.turn;
    if (a === b) return true;
    let pairs = boundaryPairs.get(a);
    if (!pairs) { pairs = new WeakMap(); boundaryPairs.set(a, pairs); }
    if (pairs.has(b)) return pairs.get(b);
    const equal = a.turn === b.turn && a.status === b.status && a.start === b.start && a.end === b.end &&
      a.steps.length === b.steps.length && a.steps.every((step, index) => {
        const other = b.steps[index];
        return step.step === other.step && step.status === other.status && step.start === other.start && step.end === other.end;
      });
    pairs.set(b, equal);
    return equal;
  }
  function reusable(context, old, staged, committed, reused) {
    if (!old || context.definition !== old.definition || context.definition.historyReuse !== 'local' || old.state?.hidden === true) return false;
    if (context.matches.length !== old.matches.length || context.matches.some((match, index) => {
      const prior = old.matches[index];
      return match.event !== prior.event || match.view !== prior.view || match.role !== prior.role || !equalBoundary(match.location, prior.location);
    })) return false;
    for (const dependency of old.dependencies.values()) {
      const current = staged.previousContext(dependency.kind, context.startSeq);
      const prior = committed.contexts.get(dependency.key);
      if (current?.key !== dependency.key || (current?.state !== prior?.state && reused.get(current?.key)?.old !== prior) || (current === undefined && staged.hasMore) !== dependency.windowGap) return false;
    }
    return true;
  }
  function prepare(assembler, entries, hasMore, reuse = false) {
    const staged = new Assembler(assembler.eventDefinitions, assembler.viewDefinitions);
    if (reuse && !assembler.replacePending && assembler.dirty.size === 0) {
      const replay = staged.replayContext, build = staged.buildNode, locationData = staged.buildLocationData;
      const reused = new Map();
      staged.replayContext = function(context) {
        const old = assembler.contexts.get(context.key);
        if (!reusable(context, old, this, assembler, reused)) {
          reused.delete(context.key);
          return replay.call(this, context);
        }
        // Some audited states retain a top-level Match (assistant.final,
        // compaction.start/end). Rebind it to this transaction so its mutable
        // Location readers do not keep prior transaction timelines alive.
        const matches = new Map(old.matches.map((match, index) => [match, context.matches[index]]));
        const changes = old.state && Object.entries(old.state).filter(([, value]) => matches.has(value));
        context.state = changes?.length ? { ...old.state, ...Object.fromEntries(changes.map(([key, value]) => [key, matches.get(value)])) } : old.state;
        context.revision = old.revision;
        this.replaceDependencies(context, new Map(old.dependencies));
        reused.set(context.key, { old, state: context.state });
        this.dirty.add(context);
      };
      staged.buildNode = function(context, target) {
        const cached = reused.get(context.key);
        if (!cached || context.state !== cached.state) return build.call(this, context, target);
        const node = cached.old.current.get(target) ?? null;
        if (node === null) return null;
        // Keep business data stable, but never retain mutable location readers
        // belonging to the old transaction.
        const location = context.start?.location ?? context.matches[0]?.location;
        return node.location === undefined || location === undefined || location === node.location ? node : { ...node, location };
      };
      staged.buildLocationData = function(context, scope) {
        const cached = reused.get(context.key);
        return cached && context.state === cached.state ? cached.old.locationData[scope] : locationData.call(this, context, scope);
      };
      // Collect all evidence before replay; replaying a start immediately
      // would miss the old completed context and re-run every later delta.
      const pending = new Map();
      staged.matchInput = function(input) { return this.collectInput(input, pending); };
      replace.call(staged, entries, hasMore);
      const affected = new Set();
      staged.applyPendingMatches(pending, affected);
      staged.replayContexts(affected);
      staged.replayDependencies();
      staged.revised.clear();
      for (const context of affected) {
        if (context.start !== undefined) continue;
        const old = assembler.contexts.get(context.key);
        if (reusable(context, old, staged, assembler, reused)) reused.set(context.key, { old, state: context.state });
      }
      staged.flush();
      // Do not retain committed graphs through temporary method closures.
      delete staged.matchInput; delete staged.replayContext; delete staged.buildNode; delete staged.buildLocationData;
      return staged;
    }
    replace.call(staged, entries, hasMore);
    // View builders can throw too. Never publish a half-materialized mapping.
    staged.flush();
    return staged;
  }
  Assembler.prototype.replaceWindow = function(entries, hasMore) {
    const staged = prepare(this, entries, hasMore);
    Object.assign(this, staged); // preserve the public assembler identity
    return 'immediate';
  };
  Assembler.prototype.prepend = function(entries, hasMore) {
    const fresh = entries.filter(entry => !this.inputs.has(entry.event.seq));
    if (fresh.length === 0 && hasMore === this.hasMore) return 'none';
    const staged = prepare(this, [...fresh, ...this.sortedInputs()], hasMore, true);
    Object.assign(this, staged);
    return 'immediate';
  };
  Assembler.prototype.rebuildRegistry = function() {
    return this.replaceWindow(this.sortedInputs(), this.hasMore);
  };

  function fail(session, error) {
    session.openState = 'error';
    session.openError = { code: 'history-mapping', message: error instanceof Error ? error.message : String(error) };
    session.notifier.markDirty();
  }
  function responseValue(result) {
    if (!result.ok) throw Error(result.error?.message ?? 'History request failed');
    return result.value;
  }
  async function retryHistory(session) {
    // This is a data-plane retry on the current connection, not a transport
    // generation change. Pending approvals/questions and the subscribed
    // watermark remain authoritative and must not be discarded.
    if (session.events.length) session.xhRestoreBaseSeq = session.baseSeq;
    session.openGeneration++;
    session.loadingOlder = false; session.stitching = false; session.openPromise = null;
    session.openState = 'cold'; session.openError = null;
    session.notifier.markDirty();
    await session.open();
  }
  Session.prototype.acceptLiveEvent = function(event, view) {
    // A history mapping/read failure keeps the committed window visible. Keep
    // its live suffix too so retry can stitch every event that arrived while
    // the error banner was displayed.
    if (this.openState === 'error') {
      this.liveBuffer.push({ event, view });
      return;
    }
    return acceptLiveEvent.call(this, event, view);
  };
  Session.prototype.installWindow = function(entries, hasMore, projections) {
    const combined = [...entries];
    let tail = combined.at(-1)?.event.seq;
    // Only the buffered suffix is sorted; the Host owns history ordering.
    const pending = [...this.liveBuffer].sort((a, b) => a.event.seq - b.event.seq);
    const accepted = [];
    for (const item of pending) {
      if (tail !== undefined && item.event.seq <= tail) continue;
      if (tail !== undefined && item.event.seq !== tail + 1) throw Error('History live-buffer gap; retry history loading');
      combined.push(item); accepted.push(item); tail = item.event.seq;
    }
    const committedTail = this.events.at(-1)?.seq;
    if (committedTail !== undefined && (tail === undefined || tail < committedTail))
      throw Error('History window moved backwards; retry history loading');
    const prependOnly = this.events.length > 0 && combined.length >= this.events.length &&
      this.events.every((event, index) => {
        const candidate = combined[combined.length - this.events.length + index];
        return candidate.event === event && candidate.view === this.views[index];
      });
    const staged = prepare(this.conversation, combined, hasMore, prependOnly);
    const events = combined.map(entry => entry.event), views = combined.map(entry => entry.view);
    // Mapping, reducers and view builders have all succeeded before publication.
    Object.assign(this.conversation, staged);
    this.events = events; this.views = views;
    this.baseSeq = events[0]?.seq ?? 0; this.hasMore = hasMore;
    if (events.some(event => event.type === 'turn/start')) this.firstPromptPendingTurn = false;
    if (projections !== undefined) this.projections.seed(projections);
    for (const item of accepted) this.queueMirror.acceptDurable(item.event);
    this.liveBuffer = [];
    this.notifier.markDirty();
  };
  Session.prototype.loadOlder = async function() {
    // The error-banner retry shares this read-only action; never resubmit a prompt.
    if (this.openState === 'error') return retryHistory(this);
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder || this.stitching) return;
    this.loadingOlder = true;
    const generation = this.openGeneration, beforeSeq = this.baseSeq;
    this.notifier.markDirty();
    try {
      const { result } = await this.history({ beforeSeq, maxMessages: 50 });
      // A live gap discovered while this request was in flight owns the next
      // full-window publication. Discard this stale pagination response and
      // let repairGap settle rather than racing both installers.
      if (generation !== this.openGeneration || this.openState !== 'open' || this.stitching) return;
      const value = responseValue(result), older = value.events;
      if (this.baseSeq !== beforeSeq) throw Error('History window changed during pagination; retry history loading');
      if (older.length && !this.xhValidHistoryPage(older, beforeSeq))
        throw Error('History projected page is invalid; retry history loading');
      if (!older.length && value.hasMore) throw Error('History page made no progress; retry history loading');
      const entries = [...older, ...this.events.map((event, index) => ({ event, view: this.views[index] }))];
      this.installWindow(entries, value.hasMore);
    } catch (error) {
      if (generation === this.openGeneration) fail(this, error);
    } finally {
      if (generation === this.openGeneration) { this.loadingOlder = false; this.notifier.markDirty(); }
    }
  };
  Session.prototype.invalidateConnectionGeneration = function() {
    // Invalidate dead-transport history promises before a new baseline arrives.
    this.openGeneration++;
    this.openPromise = null;
    this.loadingOlder = false; this.stitching = false;
    for (const wait of this.pending.values()) wait.markSettled?.();
    this.pending.clear(); this.pendingRev++;
    this.subscribedLastSeq = null;
    this.notifier.markDirty();
  };
  const disconnected = Manager.prototype.handleDisconnected;
  Manager.prototype.handleDisconnected = function() {
    disconnected.call(this);
    for (const session of this.sessions.values()) session.invalidateConnectionGeneration();
  };
  Session.prototype.resync = async function() {
    if (this.openState === 'cold') return;
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq;
    this.openGeneration++;
    this.loadingOlder = false; this.stitching = false; this.openPromise = null;
    this.openState = 'cold'; this.openError = null;
    // New-generation mux baseline may have arrived before host.describe.
    // Generation cleanup belongs to handleDisconnected, never readiness.
    // Keep the committed window and any buffered suffix until replacement succeeds.
    this.notifier.markDirty();
    await this.open();
  };
  Session.prototype.repairGap = async function() {
    if (this.stitching) return;
    this.stitching = true;
    const generation = this.openGeneration;
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq;
    try {
      const { result } = await this.history({ maxMessages: 50 });
      if (generation !== this.openGeneration || this.openState !== 'open') return;
      const value = await this.restoreHistoryRange(responseValue(result), generation);
      if (generation !== this.openGeneration || this.openState !== 'open') return;
      this.installWindow(value.events, value.hasMore, value.projections);
      this.xhRestoreBaseSeq = undefined;
    } catch (error) {
      if (generation === this.openGeneration) fail(this, error);
    } finally {
      if (generation === this.openGeneration) this.stitching = false;
    }
  };
}
