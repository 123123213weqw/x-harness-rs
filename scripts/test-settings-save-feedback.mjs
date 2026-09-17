import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {patchSettingsSaveFeedback} from './patch-settings-save-feedback.mjs';

const read = path => readFileSync(new URL('../'+path, import.meta.url),'utf8');
const text = read('ui/dist/plugins/@xharness/dsh-client-ui-settings/client.js');
const start = text.indexOf('var SettingsScopeController = class');
const end = text.indexOf('var SettingsScopeBinder = class', start);
assert.ok(start >= 0 && end > start);
const notifications = [];
const makeStore = initial => {
  let value = initial;
  return {getSnapshot:()=>value, subscribe:()=>()=>{}, update:fn=>{value=structuredClone(value);fn(value);}};
};
const Controller = new Function('_xharness_dsh_client_runtime_client','xhSettingsSaveFeedback',
  text.slice(start,end)+';return SettingsScopeController;')({createSnapshotStore:makeStore},(ns,failed)=>notifications.push({ns,failed}));
const make = (mutate,load=async()=>{},mode='host') => new Controller({settings:{mutate}},
  {namespace:'ui-theme'}, {subscribe:()=>()=>{},getSnapshot:()=>({}),load,acceptView:()=>{}}, mode, {});
const rejected = async()=>({result:{ok:false,error:{message:'SECRET must never be rendered'}}});
const success = async()=>({result:{ok:true,value:{revision:1}}});

for (const fail of [rejected, async()=>{throw Error('offline SECRET');}]) {
  notifications.length=0;
  const scope=make(fail);
  await scope.set('preference','dark');
  assert.deepEqual(notifications,[{ns:'ui-theme',failed:true}], 'failed saves must be visible');
}
notifications.length=0;
await make(rejected,async()=>{throw Error('recovery also offline');}).set('preference','dark');
assert.deepEqual(notifications,[{ns:'ui-theme',failed:true}], 'recovery failure must not reject an unawaited setter');

notifications.length=0;
let release;
const gate=new Promise(resolve=>{release=resolve});
let calls=0;
const race=make(async()=>{if(++calls===1){await gate;return rejected();}return success();});
const older=race.set('preference','dark');
const newer=race.set('preference','light');
release(); await Promise.all([older,newer]);
assert.deepEqual(notifications,[{ns:'ui-theme',failed:false}], 'superseded failure must not overwrite success');

notifications.length=0;
let finish;
const pending=make(()=>new Promise(resolve=>{finish=resolve}));
const write=pending.set('preference','dark');
await Promise.resolve();
const disposed=pending.dispose();
finish(await rejected()); await Promise.all([write,disposed]);
assert.deepEqual(notifications,[], 'disposed scopes must not display failures');

notifications.length=0;
await make(()=>{throw Error('remote browser must not write');},undefined,'memory').set('preference','dark');
assert.deepEqual(notifications,[]);
console.log('Settings save settlement: refusal, offline/recovery failure, supersession, disposal and memory mode passed');

const id='@xharness/dsh-client-ui-settings';
const helper=read('ui/overrides/settings-save-feedback.js').replaceAll('\r\n','\n');
assert.ok(text.includes(helper));
const original=text.replace('// XHARNESS SETTINGS SAVE FEEDBACK\n'+helper+'\n','')
  .replace('\t\t\t\t\t\txhSettingsSaveFeedback(this.spec.namespace, false);\n','')
  .replace('\t\t\t\ttry { await this.mirror.load(); } catch { /* A failed reread is still a failed save. */ }\n\t\t\t\tif (!this.disposed && generation === this.writeGeneration) xhSettingsSaveFeedback(this.spec.namespace, true);', '\t\t\t\tawait this.mirror.load();');
assert.equal(patchSettingsSaveFeedback(id,Buffer.from(original)).toString(),text);
assert.equal(patchSettingsSaveFeedback(id,Buffer.from(original.replaceAll('\n','\r\n'))).toString(),text);
assert.equal(patchSettingsSaveFeedback(id,Buffer.from(text)).toString(),text);
assert.equal(patchSettingsSaveFeedback('unrelated',Buffer.from(original)).toString(),original);
assert.throws(()=>patchSettingsSaveFeedback(id,Buffer.from(original.replace('await this.mirror.load();','await changed();'))),/anchor changed/);
new Script(text);
const graph=JSON.parse(read('ui/dist/client-graph.json'));
const entry=graph.entries.find(entry=>entry.id===id);
assert.equal(entry.rev,createHash('sha256').update(text).digest('hex').slice(0,16));
assert.ok(read('ui/dist/index.html').includes(entry.url));
console.log('Settings patch: fail-closed anchors, CRLF, idempotence, shipped graph/hash passed');
