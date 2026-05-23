// Product-owned history residency. This is NOT model context compaction.
function installSessionHistoryCache(Session, SessionManager) {
  const defaults = Object.freeze({ maxInactiveSessions: 6, maxInactiveBytes: 64 * 1024 * 1024 });
  // History pages contain the Host's conversation projection, not a raw slice
  // of the durable journal. Completed streaming chunks can be folded and
  // adjacent deltas can be coalesced, so a sound page is ordered and bounded
  // by beforeSeq but is not required to contain every intervening seq.
  function validProjectedHistoryPage(entries, beforeSeq) {
    if (!Array.isArray(entries) || entries.length === 0 || !Number.isSafeInteger(beforeSeq)) return false;
    let priorSeq = -1;
    return entries.every(entry => {
      const seq = entry?.event?.seq;
      const ordered = Number.isSafeInteger(seq) && seq >= 0 && seq > priorSeq && seq < beforeSeq;
      priorSeq = seq;
      return ordered;
    });
  }
  // loadOlder is defined by the upstream runtime. Keep the page contract on
  // the Session prototype so the patched method and range restoration share
  // exactly one validator.
  Session.prototype.xhValidHistoryPage = function(entries, beforeSeq) {
    return validProjectedHistoryPage(entries, beforeSeq);
  };
  // Conservative payload weight, not a promise about JS heap/RSS. No JSON copy,
  // no strong global memo, and no recursive stack overflow on deeply nested data.
  function weight(value) {
    let bytes = 0;
    const stack = [value], seen = new WeakSet();
    while (stack.length && bytes <= defaults.maxInactiveBytes) {
      const item = stack.pop();
      if (typeof item === 'string') bytes += 24 + item.length * 2;
      else if (item && typeof item === 'object') {
        if (seen.has(item)) continue;
        seen.add(item); bytes += 64;
        for (const key of Object.keys(item)) { bytes += 16 + key.length * 2; stack.push(item[key]); }
      } else bytes += 8;
    }
    return bytes;
  }
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
      if (this.entries.has(session.sessionId)) return;
      const entry = { session, lastAccess: ++this.clock, bytes: 0, dirty: true };
      this.entries.set(session.sessionId, entry);
      session.xhHistoryOwner = this;
      this.schedule();
    }
    touch(id) {
      const entry = this.entries.get(id);
      if (entry) entry.lastAccess = ++this.clock;
      this.schedule();
    }
    changed(session) {
      const entry = this.entries.get(session.sessionId);
      if (entry) entry.dirty = true;
      this.schedule();
    }
    forget(id) {
      const entry = this.entries.get(id);
      if (!entry) return;
      entry.session.xhHistoryOwner = undefined;
      this.entries.delete(id);
    }
    protected(session) {
      return this.manager.selected === session.sessionId || session.running ||
        (this.manager.pendingInteractions.get(session.sessionId)?.size ?? 0) > 0 ||
        session.pending.size > 0 || session.queueMirror.snapshot().length > 0 ||
        session.firstPromptPendingTurn || (session.xhPendingOperations ?? 0) > 0 ||
        session.openPromise !== null || session.openState === 'loading' ||
        session.loadingOlder || session.stitching;
    }
    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.trim(); });
    }
    trim() {
      const candidates = [];
      let bytes = 0, protectedSessions = 0;
      for (const entry of this.entries.values()) {
        const session = entry.session;
        if (session.openState === 'cold') continue;
        if (this.protected(session)) { protectedSessions++; continue; }
        // Running streams are never rescanned per delta. Recount only dirty idle data.
        if (entry.dirty) { entry.bytes = weight([session.events, session.views]); entry.dirty = false; }
        bytes += entry.bytes; candidates.push(entry);
      }
      candidates.sort((a, b) => a.lastAccess - b.lastAccess);
      let count = candidates.length;
      for (const entry of candidates) {
        if (count <= this.limits.maxInactiveSessions && bytes <= this.limits.maxInactiveBytes) break;
        if (this.protected(entry.session)) continue;
        if (!entry.session.unloadHistory()) continue;
        bytes -= entry.bytes; entry.bytes = 0; entry.dirty = true; count--; this.evictions++;
      }
      this.lastStats = { inactiveSessions: count, estimatedInactiveBytes: bytes, protectedSessions, evictions: this.evictions };
      return this.lastStats;
    }
  }
  function cache(manager) { return manager.xhHistoryCache ??= new HistoryCache(manager); }
  function wrap(prototype, name, make) {
    const previous = prototype[name];
    if (typeof previous !== 'function') throw Error('History cache method missing: ' + name);
    prototype[name] = make(previous);
  }
  wrap(SessionManager.prototype, 'get', previous => function(id) {
    const session = previous.call(this, id);
    const owner = cache(this); owner.track(session);
    return session;
  });
  for (const name of ['select', 'selectSubagent', 'clearSelection']) {
    wrap(SessionManager.prototype, name, previous => function(...args) {
      const result = previous.apply(this, args);
      cache(this).touch(this.selected);
      return result;
    });
  }
  wrap(SessionManager.prototype, 'drop', previous => function(id) {
    this.xhHistoryCache?.forget(id);
    return previous.call(this, id);
  });
  // Counters contain neither prompts nor secrets; usable by debug tests/host adapters.
  SessionManager.prototype.historyCacheStats = function() { return cache(this).trim(); };
  Session.prototype.unloadHistory = function() {
    if (!this.xhHistoryOwner || this.xhHistoryOwner.protected(this)) return false;
    // Retain the loaded range as scalar metadata so existing chatScroll anchors
    // can be restored even when they were outside the most recent 50 messages.
    if (this.events.length) this.xhRestoreBaseSeq = this.baseSeq;
    this.openGeneration++;
    this.openPromise = null; this.openState = 'cold'; this.openError = null;
    this.events = []; this.views = []; this.liveBuffer = [];
    this.baseSeq = 0; this.hasMore = false; this.subscribedLastSeq = null;
    this.conversation.replaceWindow([], false);
    this.conversation.resetViewBuilders();
    this.notifier.notifyNow();
    this.notifier.ensureFresh(); // release cached snapshots even with zero subscribers
    return true;
  };
  // These paths alter raw history. Generic status/projection notifications do not
  // mark bytes dirty, and background arrival never updates the LRU access order.
  for (const name of ['installWindow', 'appendLive']) {
    wrap(Session.prototype, name, previous => function(...args) {
      const result = previous.apply(this, args); this.xhHistoryOwner?.changed(this); return result;
    });
  }
  for (const name of ['handleMuxEnvelope', 'handleRunning', 'settle']) {
    wrap(Session.prototype, name, previous => function(...args) {
      const result = previous.apply(this, args); this.xhHistoryOwner?.schedule(); return result;
    });
  }
  for (const name of ['open', 'loadOlder', 'repairGap', 'prompt', 'command']) {
    wrap(Session.prototype, name, previous => function(...args) {
      this.xhPendingOperations = (this.xhPendingOperations ?? 0) + 1;
      let result;
      try { result = previous.apply(this, args); }
      catch (error) { this.xhPendingOperations--; this.xhHistoryOwner?.schedule(); throw error; }
      return Promise.resolve(result).finally(() => {
        this.xhPendingOperations--;
        if (name === 'loadOlder') this.xhHistoryOwner?.changed(this);
        else this.xhHistoryOwner?.schedule();
      });
    });
  }
  Session.prototype.restoreHistoryRange = async function(value, generation) {
    const target = this.xhRestoreBaseSeq;
    if (target === undefined) return value;
    let entries = value.events, hasMore = value.hasMore;
    const pages = [entries];
    while (hasMore && entries.length && entries[0].event.seq > target) {
      const beforeSeq = entries[0].event.seq;
      const { result } = await this.history({ beforeSeq, maxMessages: 50 });
      if (generation !== this.openGeneration) return value;
      if (!result.ok) throw Error('History restore failed: ' + (result.error?.message ?? 'request rejected'));
      entries = result.value.events; hasMore = result.value.hasMore;
      if (!validProjectedHistoryPage(entries, beforeSeq))
        throw Error('History restore failed: invalid projected page');
      pages.push(entries);
    }
    if (generation !== this.openGeneration) return value;
    if (!entries.length || entries[0].event.seq > target) throw Error('History restore failed: saved range is no longer available');
    return { ...value, events: pages.reverse().flat(), hasMore };
  };
}
