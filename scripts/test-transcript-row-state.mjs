import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { patchTranscriptRowState } from './patch-transcript-row-state.mjs';
const graph=JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json',import.meta.url)));
const index=readFileSync(new URL('../ui/dist/index.html',import.meta.url),'utf8');
for(const id of ['@xharness/dsh-client-ui-conversation','@xharness/dsh-client-ui-tool','@xharness/dsh-client-ui-cordis','@xlang/xharness-client-ui-computer']) {
 const source=readFileSync(new URL('../ui/dist/plugins/'+id+'/client.js',import.meta.url));
 new Script(source.toString());
 assert.deepEqual(patchTranscriptRowState(id,source),source,'state patch idempotence '+id);
 assert.equal(source.toString().split('// xh-transcript-row-state/v1').length,2,'single state bridge '+id);
 assert.throws(()=>patchTranscriptRowState(id,Buffer.from('unknown source')),/anchor changed/,'unknown shapes fail closed');
 const entry=graph.entries.find(e=>e.id===id);
 assert.equal(entry.rev,createHash('sha256').update(source).digest('hex').slice(0,16));
 assert.ok(index.includes(entry.url),'boot graph updated');
}
assert.deepEqual(patchTranscriptRowState('@xlang/unrelated',Buffer.from('unchanged')),Buffer.from('unchanged'));
const tool=readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-tool/client.js',import.meta.url),'utf8');
assert.equal(tool.split('stateKey: block.callId,').length,8,'every built-in tool view has a stable call key');
assert.match(tool,/xhUseTranscriptState\("tool:" \+ stateKey, false\)/);
assert.match(tool,/if \(appliedMode === processMode\) return/);
const helper=readFileSync(new URL('../ui/overrides/transcript-windowing.js',import.meta.url),'utf8');
assert.ok(!helper.includes('row.pinned'),'no permanent interaction pins');
assert.match(helper,/mounted: keepMounted/,'no full initial mount');
assert.match(helper,/WeakMap/,'root lifetime is weakly scoped');
console.log('transcript row state: four registrants, call identities, patch/hash consistency and bounded lifetime passed');

const pending = runInNewContext(helper + ';xhTranscriptHasPendingTool');
assert.equal(pending({kind:'assistant',data:{}}),false);
assert.equal(pending({kind:'tool-call',data:{root:{callId:'live',subCalls:[]}}}),true);
assert.equal(pending({kind:'tool-call',data:{root:{kind:'result',callId:'done',subCalls:[]}}}),false);
assert.equal(pending({kind:'tool-call',data:{root:{kind:'result',subCalls:[{callId:'nested',subCalls:[]}]}}}),true);
