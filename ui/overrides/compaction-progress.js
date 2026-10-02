// xh-compaction-progress/v1
// Minimal status; durable progress and recovery remain owned by the runtime.
function xhCompactProgress(value) {
  if (!value || !['preparing','summarizing','splitting','merging','retrying','paused','validating','committing'].includes(value.stage)) return undefined;
  for (const key of ['calls','completedParts','splits','retries']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) return undefined;
  if (value.completedParts > value.calls) return undefined;
  for (const key of ['delayMs','inputTokensBefore','inputTokensAfter']) if (value[key] != null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return undefined;
  return value;
}
function xhCompactLifecycle(state) {
  const view = state.presentation;
  const start = state.start?.event;
  const end = state.end?.event;
  const update = state.progress?.event;
  const progress = xhCompactProgress(view?.progress ?? update?.data.progress);
  if (view?.phase === 'succeeded') return {
    kind:'compaction', seq:view.anchorSeq, time:view.time, summary:view.summary,
    summaryEventSeq:view.summaryEventSeq, shadowedItemCount:view.shadowedItemCount,
    shadowedTokenCount:view.shadowedTokenCount, progress,
    startedAt:view.startedAt, endedAt:view.endedAt,
  };
  if (!view && !start) return null;
  return {
    kind:'compaction', status:(view?.phase === 'failed' || end) ? 'failed' : 'running',
    seq:view?.anchorSeq ?? start.seq, time:view?.time ?? start.time,
    progress, progressTime:view?.progressTime ?? update?.time,
    error:view?.error ?? end?.data.error ?? null, endedAt:view?.endedAt ?? end?.time,
  };
}
function XhCompactionProgressCard({ data, t }) {
  const [open, setOpen] = xhUseTranscriptState('compact-progress', false);
  const active = data.status === 'running';
  const paused = active && data.progress?.stage === 'paused';
  const title = paused ? t('xh.compact.paused') : active ? t('message.compaction.running') : t('xh.compact.failed');
  const detail = paused ? t('xh.compact.resume') : active ? t('xh.compact.takesMinutes') : t('xh.compact.unchanged');
  const content = [
    (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.IconApiOutline14, {'aria-hidden':true}),
    (0, react_jsx_runtime.jsx)('span', {
      style:{minWidth:0, overflowWrap:'anywhere'}, children:title + ' · ' + detail,
    }),
  ];
  return (0, react_jsx_runtime.jsxs)('div', {
    className:MessageItem_module_css_default.compactionRow,
    'data-compaction-progress':true, 'data-compaction-running':active || undefined,
    'data-active':active || undefined, 'data-state':active ? 'running' : 'error',
    'data-stage':data.progress?.stage, style:{display:'block', width:'100%', minWidth:0},
    children:[
      active ? (0, react_jsx_runtime.jsx)('div', {
        role:'status', 'aria-live':'polite', 'aria-atomic':true,
        style:{display:'flex', gap:8, alignItems:'center', padding:'8px 0', fontSize:13, color:'var(--dsw-alias-label-secondary)'},
        children:content,
      }) : (0, react_jsx_runtime.jsx)('div', {
        role:'alert', children:(0, react_jsx_runtime.jsxs)('button', {
          type:'button', className:MessageItem_module_css_default.compactionButton,
          'aria-expanded':open, disabled:!data.error, onClick:() => setOpen(value => !value),
          style:{width:'100%', textAlign:'left', display:'flex', gap:8, alignItems:'center', padding:'8px 0'},
          children:[...content, data.error && (0, react_jsx_runtime.jsx)(open ? _xharness_dsh_client_ui_primitives.IconChevronDownOutline14 : _xharness_dsh_client_ui_primitives.IconChevronRightOutline14, {'aria-hidden':true})],
        }),
      }),
      !active && open && data.error && (0, react_jsx_runtime.jsx)('div', {
        style:{padding:'4px 0 10px 22px', fontSize:12, color:'var(--dsw-alias-label-secondary)', overflowWrap:'anywhere'},
        children:data.error,
      }),
    ],
  });
}
