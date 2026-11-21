// The native caller supplies code as an async function body, not eval/Function.
// This also works on pages whose CSP disables string-based JavaScript evaluation.
function(options, run) {
  const key = Symbol.for('xharness.browser.executions');
  const store = globalThis[key] ??= Object.create(null);
  const entry = {done:false, result:null};
  store[options.id] = entry;
  const logs = [], restore = [];
  let truncated = false, settled = false;
  const stringify = JSON.stringify.bind(JSON);
  const encode = new TextEncoder();
  const clip = (text, count) => {
    text = String(text);
    if (text.length > count) {
      truncated = true;
      // Never split a UTF-16 surrogate pair: Rust JSON rejects lone surrogates.
      if (count > 0 && /[\uD800-\uDBFF]/.test(text[count-1]) && /[\uDC00-\uDFFF]/.test(text[count])) count--;
      text = text.slice(0,count) + '…';
    }
    return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,unit=>unit.length===2?unit:'\uFFFD');
  };
  function snapshot(value) {
    let remaining = 256;
    const seen = new WeakSet();
    function visit(v, depth) {
      if (--remaining < 0 || depth > 6) { truncated = true; return '[truncated]'; }
      if (v === null || typeof v === 'boolean') return v;
      if (typeof v === 'string') return clip(v, 4096);
      if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
      if (typeof v === 'undefined') return {type:'undefined'};
      if (typeof v === 'bigint') return {type:'bigint', value:String(v)};
      if (typeof v !== 'object') return clip(String(v), 256);
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      try {
        if (typeof Node !== 'undefined' && v instanceof Node)
          return {type:'node', nodeName:v.nodeName, id:v.id ?? null};
        if (v instanceof Error) return {name:clip(v.name,128), message:clip(v.message,1024), stack:clip(v.stack ?? '',2048)};
        const result = Array.isArray(v) ? [] : Object.create(null);
        const keys = Object.keys(v);
        if (keys.length > 64) truncated = true;
        for (const name of keys.slice(0,64)) {
          if (remaining <= 0) { truncated = true; break; }
          try { result[clip(name,128)] = visit(v[name],depth+1); }
          catch { result[clip(name,128)] = '[unreadable property]'; }
        }
        return result;
      } finally { seen.delete(v); }
    }
    return visit(value,0);
  }
  for (const level of ['log','info','warn','error','debug']) {
    try {
      const original = console[level];
      const wrapper = function(...values) {
        if (!settled && logs.length < 32) {
          try { logs.push({level,text:clip(stringify(snapshot(values)),512)}); }
          catch { logs.push({level,text:'[unserializable console arguments]'}); }
        } else if (!settled) truncated = true;
        return Reflect.apply(original,console,values);
      };
      console[level] = wrapper;
      restore.push(() => { if (console[level] === wrapper) console[level] = original; });
    } catch { /* A page may freeze its console; return values still work. */ }
  }
  function finish(ok, status, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const cleanup of restore) { try { cleanup(); } catch {} }
    const result = {id:options.id,state:'finished',ok,status,effect:ok?'applied':'unknown',console:logs,truncated};
    try {
      if (ok) result.value = snapshot(value);
      else result.error = snapshot(value);
    } catch { result.error = {message:'Result could not be serialized'}; result.ok = false; result.status = 'serialization_error'; result.effect = 'unknown'; }
    result.truncated = truncated;
    let wire = stringify(result);
    if (encode.encode(wire).length > 7168) {
      result.truncated = true;
      if ('value' in result) { result.value_preview = clip(stringify(result.value),1024); delete result.value; }
      while (result.console.length && encode.encode(stringify(result)).length > 7168) result.console.pop();
      wire = stringify(result);
    }
    // Bound even errors containing control characters or exotic Unicode.
    if (encode.encode(wire).length > 7168)
      wire = stringify({id:options.id,state:'finished',ok:false,status:'serialization_error',effect:'unknown',error:{message:'Result exceeds output budget'},console:[],truncated:true});
    entry.result = wire;
    entry.done = true;
    // The native caller may have disconnected. Do not retain results forever.
    setTimeout(() => { if (store[options.id] === entry) delete store[options.id]; }, 15000);
  }
  const timer = setTimeout(() => finish(false,'timeout',{message:'JavaScript wait timed out; effects are not rolled back and pending code may continue. Do not replay automatically.'}), options.timeout_ms);
  Promise.resolve().then(() => Reflect.apply(run,globalThis,[options.args]))
    .then(value => finish(true,'completed',value),error => finish(false,'exception',error));
  return stringify({id:options.id,state:'started'});
}
