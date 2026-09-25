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

// Keep the composer control mounted while a new model step is being counted.
// The host deliberately clears the previous step's reading at step/start; an
// empty reading must not remove the control and shift the send-button layout.
export function patchContextMeterStability(bytes) {
  let source = bytes.toString();
  if (source.includes('xharness-context-meter-stable/v1')) return bytes;
  const start = source.indexOf('function ContextMeter({ useProjection, t }) {');
  const end = source.indexOf('\n\t\t//#endregion', start);
  if (start < 0 || end < 0) throw Error('context meter upstream anchor changed');
  let block = source.slice(start, end);
  const replace = (before, after) => {
    if (block.split(before).length !== 2) throw Error(`context meter anchor changed: ${before}`);
    block = block.replace(before, after);
  };
  replace('const context = contextOccupancy(pressure);',
    'const context = contextOccupancy(pressure);\n\t\t\t// xharness-context-meter-stable/v1');
  replace('if (context === null) return null;\n\t\t\tconst percent = context.percent;\n\t\t\tconst reading = `${context.exact ? "" : "≈"}${percent}%`;',
    `const percent = context?.percent ?? 0;
            const reading = available ? \`\${context.exact ? "" : "≈"}\${percent}%\` : null;
            const label = available ? t("context.aria", { percent: reading })
                : t(["preparing", "in_flight", "model_changed"].includes(pressure?.phase)
                    ? "context.pending" : "context.unavailable");`);
  replace('label: t("context.aria", { percent: reading }),', 'label,');
  replace('"aria-label": t("context.aria", { percent: reading }),\n\t\t\t\t\t\t"aria-haspopup": "dialog",\n\t\t\t\t\t\t"aria-expanded": open,',
    '"aria-label": label,\n\t\t\t\t\t\t"aria-haspopup": available ? "dialog" : void 0,\n\t\t\t\t\t\t"aria-expanded": available ? open : void 0,\n\t\t\t\t\t\tdisabled: !available,');
  replace('open && (0, react_jsx_runtime.jsxs)("div", {',
    'open && available && (0, react_jsx_runtime.jsxs)("div", {');
  source = source.slice(0, start) + block + source.slice(end);
  const translate = (before, after) => {
    if (source.split(before).length !== 2) throw Error(`context meter locale/CSS anchor changed: ${before}`);
    source = source.replace(before, after);
  };
  translate('"context.aria": "上下文已用 {percent}",',
    '"context.aria": "上下文已用 {percent}",\n\t\t\t"context.pending": "正在计算上下文",\n\t\t\t"context.unavailable": "暂无上下文读数",');
  translate('"context.aria": "{percent} of context used",',
    '"context.aria": "{percent} of context used",\n\t\t\t"context.pending": "Calculating context usage",\n\t\t\t"context.unavailable": "Context usage unavailable",');
  translate('.S4my2G_trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.S4my2G_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.S4my2G_trigger:disabled{cursor:default;opacity:.45}');
  return Buffer.from(source);
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
