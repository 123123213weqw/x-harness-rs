// Reproducible downstream patch; never mix a previous request's usage with a new estimate.
export function patchContextAccounting(bytes) {
  let s=bytes.toString();
  if(s.includes('xharness-context-measurement/v1')) return bytes;
  const old='const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;';
  if(!s.includes(old)) throw Error('context occupancy upstream anchor changed');
  s=s.replace(old,`// xharness-context-measurement/v1
            const measured = Number.isFinite(pressure?.pressureTokens);
            const usedTokens = measured ? pressure.pressureTokens : pressure?.projectedTokens;
            const exact = measured || ['exact_request', 'exact_tokenizer'].includes(pressure?.accuracy);
            const label = measured ? '最近请求实际输入' : exact ? '本次请求输入计数' : '本次请求估算输入';`);
  s=s.replace('if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;',"if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(pressure?.contextWindow) || pressure.contextWindow <= 0) return null;");
  s=s.replace('contextWindow: pressure.contextWindow\n',"contextWindow: pressure.contextWindow, exact, label\n");
  s=s.replace('const reading = `${percent}%`;', 'const reading = `${context.exact ? "" : "≈"}${percent}%`;');
  s=s.replace('children: `~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`','children: `${context.exact ? "" : "≈"}${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`');
  s=s.replace('children: headBefore','children: context.label');
  return Buffer.from(s);
}

export function patchContextConnection(bytes) {
  let s=bytes.toString();
  if(s.includes('xharness-context-replay/v1'))return bytes;
  const start=s.indexOf('function contextPressureOf(log) {');
  const end=s.indexOf('\n\t\tfunction projectionValuesOf',start);
  if(start<0||end<0)throw Error('context connection upstream anchor changed');
  s=s.slice(0,start)+`function contextPressureOf(log) {
            // xharness-context-replay/v1
            let value = {}, active, waiting = false;
            for (const event of log) {
                const d=event.data ?? {};
                if(event.type === 'session/model-selected') { value={}; active=undefined; waiting=true; }
                if(event.type === 'step/start') {
                    active=[d.turn,d.step]; waiting=false;
                    value={contextWindow:value.contextWindow, phase:'preparing'};
                }
                if(event.type === 'request/header') {
                    const b=d.header?.options?.tokenBudget;
                    waiting=false;
                    value={contextWindow:value.contextWindow ?? b?.contextWindowTokens,
                        projectedTokens:b?.estimate?.totalInputTokens,
                        accuracy:b?.accuracy ?? 'estimated', phase:'in_flight',
                        measurement:d.header?.options?.measurement};
                }
                if(event.type === 'request/context') value.contextWindow=d.contextWindow;
                const sample=usageSampleOf(event);
                if(!waiting && sample && (!active || (active[0]===sample.turn && active[1]===sample.step))) {
                    const n=sample.usage.inputTokens+(sample.usage.cacheReadTokens??0)+(sample.usage.cacheWriteTokens??0);
                    if(Number.isSafeInteger(n)&&n>=0)Object.assign(value,{pressureTokens:n,accuracy:'provider_reported',phase:'measured'});
                }
                if(['user/message','tool/result','compaction/summary'].includes(event.type))value.phase='history_changed';
            }
            return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));
        }`+s.slice(end);
  s=s.replace('if (type === "request/context") frames.push({',`if (["request/context", "request/header", "step/start", "session/model-selected", "user/message", "tool/result", "compaction/summary"].includes(type)) frames.push({`);
  return Buffer.from(s);
}
