import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {createHash} from 'node:crypto';
import {patchQuestionContinuation} from './patch-question-continuation.mjs';
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
for(const name of ['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-user-questions']) {
 const bytes=readFileSync(new URL('../ui/dist/plugins/'+name+'/client.js',import.meta.url));
 assert.deepEqual(patchQuestionContinuation(name,bytes),bytes);
 new Script(bytes.toString());
 assert.throws(()=>patchQuestionContinuation(name,Buffer.from('upstream changed')),/anchor changed/);
 const entry=graph.entries.find(e=>e.id===name);assert.equal(entry.rev,createHash('sha256').update(bytes).digest('hex').slice(0,16));
 assert.ok(readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8').includes(entry.url));
}
console.log('Question patch syntax, idempotence, fail-closed anchors and shipped hashes passed');
