import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {createHash} from 'node:crypto';
import {assertRebuildInput,uiManifest} from './fixtures/repository-ui-input.mjs';
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
for(const name of ['@xharness/dsh-client-connection','@xharness/dsh-client-ui-user-questions']) {
 const bytes=readFileSync(new URL('../ui/dist/plugins/'+name+'/client.js',import.meta.url));
 assertRebuildInput(name);
 new Script(bytes.toString());
 const entry=graph.entries.find(e=>e.id===name);assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
 assert.ok(readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8').includes(entry.url));
}
console.log('Question artifact syntax, source consistency and shipped hashes passed');

const questionName='@xharness/dsh-client-ui-user-questions';
const updated=readFileSync(new URL('../ui/dist/plugins/'+questionName+'/client.js',import.meta.url),'utf8');
const current='等待回答 · 可继续不依赖答案的工作；未回答不代表同意';
const legacy='等待回答 · 仅允许独立的只读探索；未回答不代表同意';
assert.ok(updated.includes(current));
assert.ok(!updated.includes(legacy));
const golden=readFileSync(new URL('../ui/reference/master-a613970/plugins/'+questionName+'/client.js',import.meta.url),'utf8');
assert.ok(golden.includes(current),'independent frozen guidance retains non-consent wording');
if(uiManifest.modules.find(row=>row.id===questionName)?.kind==='source-module')await import('./test-question-source-module.mjs');
console.log('Deferred question guidance migration passed');
