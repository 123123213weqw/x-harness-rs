// One fold for incremental and history-only retry evidence. Started-only pages
// retain the observed attempt without inventing its failure, delay or policy.
function updateRetryState(state, match) {
  const event = match.event;
  if (event.type !== 'llm/retry' && event.type !== 'llm/retry-started') return state;
  const attempts = state?.attempts ?? [];
  const index = attempts.findIndex(attempt => attempt.retry === event.data.retry);
  if (event.type === 'llm/retry') {
    const node = scheduledNode(match);
    const next = index < 0 ? [...attempts, node] : attempts.map((old, at) => at === index ? { ...node, retryState: old.retryState } : old);
    return { turn: event.data.turn, step: event.data.step, attempts: next };
  }
  const started = index < 0 ? {
    kind: 'model-retry', seq: event.seq, time: event.time,
    ...event.data, retryState: 'started', partial: true,
  } : { ...attempts[index], retryState: 'started' };
  return { turn: event.data.turn, step: event.data.step,
    attempts: index < 0 ? [...attempts, started] : attempts.map((old, at) => at === index ? started : old) };
}
function fallbackRetryState(context) {
  return context.matches.reduce(updateRetryState, undefined);
}
