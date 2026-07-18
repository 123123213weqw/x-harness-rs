// xh-compaction-progress/v1
// One small compositor-only animation shared by all mounted compaction rows.
if (typeof document !== 'undefined' && !document.getElementById('xh-compaction-progress-style')) {
  const style = document.createElement('style');
  style.id = 'xh-compaction-progress-style';
  style.textContent = `
    .xhCompactTrack{height:3px;margin:2px 0 8px;border-radius:99px;overflow:hidden;position:relative;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,currentColor 12%,transparent)}
    .xhCompactSweep{position:absolute;inset:0;width:32%;border-radius:inherit;background:currentColor;animation:xh-compact-sweep var(--xh-duration-status-pulse,1.5s) var(--xh-ease-in-out,ease-in-out) infinite}
    [data-stage="paused"] .xhCompactSweep{animation-play-state:paused;opacity:.35}
    @keyframes xh-compact-sweep{from{transform:translateX(-110%)}to{transform:translateX(350%)}}
    @media(prefers-reduced-motion:reduce){.xhCompactSweep{animation:none;transform:translateX(100%);opacity:.6}}
  `;
  document.head.appendChild(style);
}
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
function xhCompactClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
function XhCompactionMetrics({ data, t }) {
  const p = data.progress;
  if (!p) return null;
  return (0, react_jsx_runtime.jsxs)('div', {
    style:{display:'grid', gap:6, fontSize:12, color:'var(--dsw-alias-label-secondary)', overflowWrap:'anywhere'},
    children:[
      (0, react_jsx_runtime.jsx)('div', {children:t('xh.compact.counts', {calls:p.calls, parts:p.completedParts, splits:p.splits, retries:p.retries})}),
      p.inputTokensBefore != null && (0, react_jsx_runtime.jsx)('div', {children:t('xh.compact.tokens', {before:p.inputTokensBefore.toLocaleString(), after:p.inputTokensAfter == null ? '—' : p.inputTokensAfter.toLocaleString()})}),
    ],
  });
}
function XhCompactionProgressCard({ data, t }) {
  const [open, setOpen] = xhUseTranscriptState('compact-progress', false);
  const [now, setNow] = (0, react.useState)(Date.now);
  const active = data.status === 'running';
  (0, react.useEffect)(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [active, data.time]);
  const stage = data.progress?.stage ?? 'preparing';
  const elapsed = xhCompactClock((active ? now : data.endedAt ?? data.time) - data.time);
  const retryAt = (data.progressTime ?? data.time) + (data.progress?.delayMs ?? 0);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const title = active ? t('message.compaction.running') : t('xh.compact.failed');
  const detail = active ? t('xh.compact.stage.' + stage) : t('xh.compact.unchanged');
  return (0, react_jsx_runtime.jsxs)('div', {
    className:MessageItem_module_css_default.compactionRow,
    'data-compaction-progress':true, 'data-compaction-running':active || undefined,
    'data-active':active || undefined, 'data-state':active ? 'running' : 'error',
    style:{display:'block', width:'100%', minWidth:0},
    children:[
      (0, react_jsx_runtime.jsxs)('button', {
        type:'button', className:MessageItem_module_css_default.compactionButton,
        'aria-expanded':open, onClick:() => setOpen(value => !value),
        style:{width:'100%', textAlign:'left', display:'flex', gap:8, alignItems:'center', padding:'8px 0'},
        children:[
          (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.IconApiOutline14, {}),
          (0, react_jsx_runtime.jsx)('span', { 'aria-live':'polite', title:title + ' · ' + detail, style:{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}, children:title + ' · ' + detail }),
          (0, react_jsx_runtime.jsx)('span', { style:{marginLeft:'auto', whiteSpace:'nowrap', fontSize:12, fontVariantNumeric:'tabular-nums'}, children:elapsed }),
          (0, react_jsx_runtime.jsx)(open ? _xharness_dsh_client_ui_primitives.IconChevronDownOutline14 : _xharness_dsh_client_ui_primitives.IconChevronRightOutline14, {'aria-hidden':true}),
        ],
      }),
      active && (0, react_jsx_runtime.jsx)('div', {
        className:'xhCompactTrack', role:'progressbar', 'data-stage':stage,
        'aria-label':t('message.compaction.running'),
        'aria-valuetext':stage === 'retrying' ? t('xh.compact.retry', {retry:data.progress?.retries ?? 0, seconds:remaining}) : detail,
        // Indeterminate work, not an invented overall percentage.
        children:(0, react_jsx_runtime.jsx)('span', {className:'xhCompactSweep', 'aria-hidden':true}),
      }),
      active && stage === 'retrying' && (0, react_jsx_runtime.jsx)('div', {
        style:{fontSize:12, color:'var(--dsw-alias-label-secondary)', paddingBottom:8},
        children:t('xh.compact.retry', {retry:data.progress?.retries ?? 0, seconds:remaining}),
      }),
      open && (0, react_jsx_runtime.jsxs)('div', {
        style:{padding:'4px 0 10px 22px', display:'grid', gap:8, fontSize:12, color:'var(--dsw-alias-label-secondary)'},
        children:[
          (0, react_jsx_runtime.jsx)(XhCompactionMetrics, {data,t}),
          active && (0, react_jsx_runtime.jsx)('div', {children:t('xh.compact.controls')}),
          !active && data.error && (0, react_jsx_runtime.jsx)('div', {role:'alert', style:{overflowWrap:'anywhere'}, children:data.error}),
        ],
      }),
    ],
  });
}
