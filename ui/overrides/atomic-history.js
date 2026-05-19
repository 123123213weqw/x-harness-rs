// History transactions are low-frequency. Streaming append stays incremental.
function installAtomicHistory(Assembler, Session) {
  const replace = Assembler.prototype.replaceWindow;
  const acceptLiveEvent = Session.prototype.acceptLiveEvent;
  function prepare(assembler, entries, hasMore) {
    const staged = new Assembler(assembler.eventDefinitions, assembler.viewDefinitions);
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
    return this.replaceWindow([...fresh, ...this.sortedInputs()], hasMore);
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
    const staged = prepare(this.conversation, combined, hasMore);
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
  Session.prototype.resync = async function() {
    if (this.openState === 'cold') return;
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq;
    this.openGeneration++;
    this.loadingOlder = false; this.stitching = false; this.openPromise = null;
    this.openState = 'cold'; this.openError = null;
    this.pending.clear(); this.pendingRev++;
    this.subscribedLastSeq = null;
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
