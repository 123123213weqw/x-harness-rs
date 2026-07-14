import {readFileSync} from 'node:fs';
const marker='// xh-conversation-lifecycle/v1';
const reducer=readFileSync(new URL('../ui/overrides/retry-state.js',import.meta.url),'utf8');
export function patchConversationLifecycle(bytes) {
  let source=bytes.toString().replace(/\r\n/g,'\n');
  if(source.includes(marker)) return Buffer.from(source);
  const once=(a,b)=>{if(source.split(a).length!==2)throw Error('Lifecycle anchor changed: '+a);source=source.replace(a,b)};
  once('const retryDefinition = {',marker+'\n'+reducer+'\nconst retryDefinition = {');
  const start=source.indexOf('const retryDefinition = {'), end=source.indexOf('function registerRetryConversationNode',start);
  let block=source.slice(start,end);
  const begin=block.indexOf('start: (_context, match) => {'), finish=block.indexOf('buildViewNode: (context) => {');
  if(begin<0||finish<begin)throw Error('Retry reducer anchors changed');
  block=block.slice(0,begin)+`start: (_context, match) => updateRetryState(undefined, match),
            update: (context, match) => updateRetryState(context.state, match),
            `+block.slice(finish);
  block=block.replace('if (context.state === void 0 || context.state.attempts.length === 0) return null;', 'const state = context.state ?? fallbackRetryState(context);\n            if (state === undefined || state.attempts.length === 0) return null;').replace('const stateAttempts = context.state.attempts;', 'const stateAttempts = state.attempts;');
  source=source.slice(0,start)+block+source.slice(end);
  once('const scheduledSeconds = retrySeconds(node.delayMs);','const scheduledSeconds = node.delayMs === undefined ? "—" : retrySeconds(node.delayMs);');
  once('const maximum = node.mode === "normal" ? node.maxRetries : "∞";','const maximum = node.partial ? "—" : node.mode === "normal" ? node.maxRetries : "∞";');
  once('Math.round(node.delayMs),','node.delayMs === undefined ? "—" : Math.round(node.delayMs),');
  once('}), node.failure.message]', '}), node.failure?.message ?? "—"]');
  // Only audited local reducers opt in. Implicit timeline-data consumers
  // (turn-tail and turn-error) always rebuild; plugins remain conservative.
  for(const name of ['assistantDefinition','commandDefinition','compactionDefinition','messageDefinition','retryDefinition','toolDefinition'])
    once(`const ${name} = {`,`const ${name} = {\n            historyReuse: "local",`);
  return Buffer.from(source);
}
