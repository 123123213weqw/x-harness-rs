// A failed history read leaves a session in `openState === 'error'`. The
// transactional history layer keeps every live frame in that state instead of
// dropping it, so nothing is lost — but nothing publishes that suffix either:
// the transcript shows the error banner and the buffered answer stays invisible
// until the user presses the banner's retry (or reloads). The model keeps
// answering in the meantime, which is the reported "模型还在回答，但是前端不显示".
//
// The status frame that a new user prompt produces is the right moment to
// recover: the user just acted, and the answer is about to arrive. Retrying
// there means the frames that follow already have a window to land in.
//
// Recovery reuses the error banner's own read-only path (`loadOlder` is routed
// to the history-only retry by the transactional layer), so it never resubmits
// a prompt and never drops pending approvals, questions or the subscribed
// watermark. It is rate-limited, and it only starts from the `error` state, so a
// failing history endpoint cannot be turned into a fetch loop.
function installLiveAnswerRecovery(Session) {
  const RETRY_INTERVAL_MS = 5000;
  // The residency owner is the only place that knows which session the user is
  // looking at. A host without that layer is treated as current: the retry is a
  // single read-only history request, still bounded by the interval below.
  function isCurrent(session) {
    const owner = session.xhHistoryOwner;
    return owner === undefined || owner.manager?.selected === session.sessionId;
  }
  Session.prototype.xhRecoverLiveAnswer = function() {
    if (this.openState !== 'error') return undefined;
    if (!isCurrent(this)) return undefined;
    const now = Date.now();
    if (now - (this.xhLiveRecoveryAt ?? 0) < RETRY_INTERVAL_MS) return undefined;
    this.xhLiveRecoveryAt = now;
    return this.loadOlder();
  };
  const handleRunning = Session.prototype.handleRunning;
  if (typeof handleRunning !== 'function') throw Error('Live answer recovery method missing: handleRunning');
  const prompt = Session.prototype.prompt;
  if (typeof prompt !== 'function') throw Error('Live answer recovery method missing: prompt');
  // A queued prompt does not necessarily produce another running=true frame:
  // the Host only publishes that edge when it starts an idle driver. Recover
  // from the accepted prompt itself as the authoritative user-action signal,
  // then keep handleRunning as the fallback for background/remote starts.
  Session.prototype.prompt = async function(...args) {
    const result = await prompt.apply(this, args);
    if (result?.ok === true) this.xhRecoverLiveAnswer();
    return result;
  };
  // Wrapped rather than replaced: the residency layer wraps this method too, and
  // its trim must still observe every status change.
  Session.prototype.handleRunning = function(running) {
    const result = handleRunning.call(this, running);
    // `handleRunning` returns early when the flag did not change, so react to the
    // reported status instead of to a transition.
    if (running === true) this.xhRecoverLiveAnswer();
    return result;
  };
}
