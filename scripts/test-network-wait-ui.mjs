import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchNetworkWaitUi } from './patch-network-wait-ui.mjs';
const source = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js', import.meta.url), 'utf8');
assert.equal(patchNetworkWaitUi(Buffer.from(source)).toString(), source);
const fresh = source.replace('t(node.mode === "always" && (node.policyKey === "xharness:network-wait" || node.policyKey === "xharness:network-wait:continuation") ? "message.retry.networkWaiting" : "message.retry.active")', 't("message.retry.active")')
  .replace(/^.*"message.retry.networkWaiting":.*\n/gm, '');
assert.equal(patchNetworkWaitUi(Buffer.from(fresh)).toString(), source);
assert.throws(() => patchNetworkWaitUi(Buffer.from('changed renderer')), /expected one/);
const start = source.indexOf('function retrySeconds(');
const end = source.indexOf('\n\t\t/** Persistent, turn-positioned',start);
const ctx = vm.createContext({
  Date, Math,
  react: { useMemo: f => f(), useState: f => [f(), () => {}], useEffect() {} },
  react_jsx_runtime: { jsx: (type, props) => ({type, ...props}), jsxs: (type,props) => ({type,...props}) },
  MessageItem_module_css_default: {},
});
vm.runInContext(source.slice(start,end),ctx);
const render = (active, mode, state='scheduled') => ctx.ModelRetryItem({ active,
  node: {mode, policyKey: "xharness:network-wait", retry:3,maxRetries:2,delayMs:30000,seq:5,retryState:state,failure:{message:'offline'}},
  t: (key, args) => args ? JSON.stringify({key,...args}) : key,
});
const text = row => JSON.parse(row.children[0].children.children);
assert.equal(text(render(true,'always')).label,'message.retry.networkWaiting');
assert.equal(text(render(true,'always')).maximum,'∞');
assert.equal(text(render(true,'normal')).label,'message.retry.active');
assert.equal(text(render(false,'always','started')).label,'message.retry.started');
assert.equal(text(render(false,'always','cancelled')).label,'message.retry.cancelled');
assert.equal(text(render(true,'always')).seconds,30);
console.log('Network wait UI: maintained bundle patch, idempotency, active countdown, finite retry, started/cancelled states passed');
