import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {verifyConversationArtifact,exposeConversation,legacyConversation} from './conversation-artifact-test.mjs';
import {harness} from './conversation-test-harness.mjs';
const source=verifyConversationArtifact();
const golden=legacyConversation().toString();
for(const [label,bytes] of [['native',source],['golden',golden]]) {
const jsx=(type,props)=>({type,...props});
const ctx=harness(exposeConversation(bytes,['ModelRetryItem']),{
 react:{useMemo:f=>f(),useState:f=>[typeof f==='function'?f():f,()=>{}],useEffect(){}},
 jsx:{jsx,jsxs:jsx},
}).plugin;
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
}
console.log('Network wait UI: actual shipped source closure + immutable golden, network/∞/normal/started/cancelled/30s passed');
