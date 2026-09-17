import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {UI_NAMESPACE,pluginName} from './ui-namespace.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ID=`${UI_NAMESPACE}/dsh-client-ui-settings`;
const MARK='// XHARNESS SETTINGS SAVE FEEDBACK';
const helper=readFileSync(resolve(root,'ui/overrides/settings-save-feedback.js'),'utf8').replaceAll('\r\n','\n');
function once(text,before,after) {
  if(text.split(before).length!==2) throw Error('Settings save feedback anchor changed: '+before.slice(0,100));
  return text.replace(before,after);
}
export function patchSettingsSaveFeedback(id,bytes) {
  if(pluginName(id)!==pluginName(ID)) return bytes;
  let text=bytes.toString().replaceAll('\r\n','\n');
  if(text.includes(MARK)) return Buffer.from(text);
  text=once(text,'\t\tvar module = { exports: {} };',`${MARK}\n${helper}\n\t\tvar module = { exports: {} };`);
  text=once(text,'\t\t\t\t\t\tthis.mirror.acceptView(response.result.value);',
    '\t\t\t\t\t\txhSettingsSaveFeedback(this.spec.namespace, false);\n\t\t\t\t\t\tthis.mirror.acceptView(response.result.value);');
  text=once(text,'\t\t\t\tawait this.mirror.load();\n\t\t\t}',
    '\t\t\t\ttry { await this.mirror.load(); } catch { /* A failed reread is still a failed save. */ }\n'+
    '\t\t\t\tif (!this.disposed && generation === this.writeGeneration) xhSettingsSaveFeedback(this.spec.namespace, true);\n\t\t\t}');
  return Buffer.from(text);
}
export function refreshSettingsSaveFeedback(dist=resolve(root,'ui/dist')) {
  const target=resolve(dist,'plugins',ID,'client.js');
  const patched=patchSettingsSaveFeedback(ID,readFileSync(target));
  writeFileSync(target,patched);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,16);
  const graphPath=resolve(dist,'client-graph.json');
  const graph=JSON.parse(readFileSync(graphPath,'utf8'));
  const entry=graph.entries.find(entry=>entry.id===ID);
  if(!entry) throw Error('Missing settings client graph entry');
  entry.rev=hash(patched);entry.url=`/plugins/${ID}/client.js?rev=${entry.rev}`;
  graph.rev=hash(JSON.stringify(graph.entries));
  writeFileSync(graphPath,JSON.stringify(graph,null,2)+'\n');
  const indexPath=resolve(dist,'index.html');
  const index=readFileSync(indexPath,'utf8');
  if((index.match(/window\.__DSH_BOOT__ = .*?<\/script>/g)||[]).length!==1) throw Error('Boot graph anchor changed');
  writeFileSync(indexPath,index.replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) refreshSettingsSaveFeedback();
