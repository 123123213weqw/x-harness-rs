// Maintained against our checked-in UI; no external upstream checkout/build required.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export function patchNetworkWaitUi(input) {
  let source = input.toString();
  const before = 'const label = active ? t("message.retry.active") :';
  const after = 'const label = active ? t(node.mode === "always" && (node.policyKey === "xharness:network-wait" || node.policyKey === "xharness:network-wait:continuation") ? "message.retry.networkWaiting" : "message.retry.active") :';
  if (!source.includes(after)) {
    if (source.split(before).length !== 2) throw Error('network wait: expected one retry label');
    source = source.replace(before, after);
  }
  if (!source.includes('"message.retry.networkWaiting":')) {
    const translations = [
      ['"message.retry.delay": "Retry delay: ",', '"message.retry.networkWaiting": "Connection interrupted; waiting to reconnect",'],
      ['"message.retry.delay": "重试延迟：",', '"message.retry.networkWaiting": "连接中断，等待恢复",'],
    ];
    for (const [anchor, entry] of translations) {
      if (source.split(anchor).length !== 2) throw Error(`network wait translation missing: ${anchor}`);
      source = source.replace(anchor, entry + '\n\t\t\t' + anchor);
    }
  }
  return Buffer.from(source);
}
export function updateNetworkWaitUi(dist) {
  const graphPath = resolve(dist, 'client-graph.json');
  const graph = JSON.parse(readFileSync(graphPath));
  const id = '@xharness/dsh-client-ui-conversation';
  const path = resolve(dist, 'plugins', id, 'client.js');
  const bytes = patchNetworkWaitUi(readFileSync(path));
  const hash = b => createHash('sha256').update(b).digest('hex').slice(0,16);
  const entry = graph.entries.find(e => e.id === id);
  if (!entry) throw Error('network wait plugin missing');
  writeFileSync(path, bytes); entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`;
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(graphPath, JSON.stringify(graph,null,2)+'\n');
  const indexPath = resolve(dist,'index.html');
  let html = readFileSync(indexPath,'utf8');
  html = html.replace(/\/plugins\/@xharness\/dsh-client-ui-conversation\/client\.js\?rev=[0-9a-f]+/g, entry.url);
  html = html.replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`);
  writeFileSync(indexPath,html);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) updateNetworkWaitUi(resolve(process.argv[2] ?? 'ui/dist'));
