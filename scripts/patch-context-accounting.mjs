// Reproducible downstream patch; never mix a previous request's usage with a new estimate.
export function patchContextAccounting(bytes) {
  let s=bytes.toString();
  if(s.includes('xharness-context-measurement/v2')) return bytes;
  const start=s.indexOf('function contextOccupancy(pressure) {');
  const end=s.indexOf('\n\t\t}', start);
  if(start<0||end<0) throw Error('context occupancy upstream anchor changed');
  s=s.slice(0,start)+`function contextOccupancy(pressure) {
            // xharness-context-measurement/v2: accuracy belongs to a reading, not the whole projection.
            const measured = Number.isFinite(pressure?.pressureTokens);
            const usedTokens = measured ? pressure.pressureTokens : pressure?.projectedTokens;
            const accuracy = measured ? (pressure?.pressureAccuracy ?? 'provider_reported')
                : (pressure?.projectedAccuracy ?? pressure?.accuracy ?? 'estimated');
            const exact = measured ? accuracy === 'provider_reported'
                : ['exact_request', 'exact_tokenizer'].includes(accuracy);
            const stale = pressure?.phase === 'history_changed';
            const label = (measured ? '最近请求实际输入' : stale ? '最近请求输入计数' : '本次请求输入计数')
                + (!measured && !exact ? '（估算）' : '') + (stale ? ' · 历史已变化' : '');
            if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(pressure?.contextWindow) || pressure.contextWindow <= 0) return null;
            return {
                percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
                usedTokens, contextWindow: pressure.contextWindow, exact, label, accuracy, stale
            };
\t\t}`+s.slice(end+4);
  // Replace stale upstream documentation as well as the implementation.
  s=s.replace(/\/\*\*\s*\n\s*\* Approximate context occupancy,[\s\S]*?\*\//,
      '/** Last request input: provider-reported usage first, otherwise preflight count. Never predicts post-compaction input. */');
  s=s.replace('const reading = `${percent}%`;', 'const reading = `${context.exact ? "" : "≈"}${percent}%`;');
  s=s.replace('children: `~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`','children: `${context.exact ? "" : "≈"}${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`');
  s=s.replace('children: headBefore','children: context.label');
  return Buffer.from(s);
}

export function patchContextConnection(bytes) {
  let s=bytes.toString();
  if(s.includes('xharness-context-replay/v2'))return bytes;
  const start=s.indexOf('function contextPressureOf(log) {');
  const end=s.indexOf('\n\t\tfunction projectionValuesOf',start);
  if(start<0||end<0)throw Error('context connection upstream anchor changed');
  s=s.slice(0,start)+`function contextPressureOf(log) {
            // xharness-context-replay/v2
            let value = {}, active, waiting = false, contextSeen = false;
            for (const event of log) {
                const d=event.data ?? {};
                if(event.type === 'session/model-selected') { value={}; active=undefined; waiting=true; contextSeen=false; }
                if(event.type === 'step/start') {
                    active=[d.turn,d.step]; waiting=false;
                    value={contextWindow:value.contextWindow, phase:'preparing'};
                }
                if(event.type === 'request/header') {
                    const b=d.header?.options?.tokenBudget;
                    waiting=false;
                    value={contextWindow:(contextSeen ? value.contextWindow : (b?.contextWindowTokens ?? b?.context_window_tokens)),
                        projectedTokens:b?.estimate?.totalInputTokens ?? b?.estimate?.total_input_tokens,
                        projectedAccuracy:b?.accuracy ?? 'estimated',
                        accuracy:b?.accuracy ?? 'estimated', phase:'in_flight',
                        measurement:d.header?.options?.measurement ?? {turn:active?.[0] ?? null,step:active?.[1] ?? null,source:'legacy_request'}};
                }
                if(event.type === 'request/context') { contextSeen=true; value.contextWindow=d.contextWindow ?? d.context_window; }
                const sample=usageSampleOf(event);
                if(!waiting && sample && (!active || (active[0]===sample.turn && active[1]===sample.step))) {
                    const n=sample.usage.inputTokens+(sample.usage.cacheReadTokens??0)+(sample.usage.cacheWriteTokens??0);
                    if(Number.isSafeInteger(n)&&n>=0)Object.assign(value,{pressureTokens:n,pressureAccuracy:'provider_reported',accuracy:'provider_reported',phase:value.phase==='history_changed'?'history_changed':'measured'});
                }
                if(['user/message','tool/result','compaction/summary'].includes(event.type))value.phase='history_changed';
                if(event.type==='turn/end' && value.pressureTokens===undefined)value.phase='unmeasured';
            }
            return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));
        }`+s.slice(end);
  s=s.replace('if (type === "request/context") frames.push({',`if (["request/context", "request/header", "step/start", "session/model-selected", "user/message", "tool/result", "compaction/summary"].includes(type)) frames.push({`);
  return Buffer.from(s);
}
