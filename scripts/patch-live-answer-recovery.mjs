import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const implementation = readFileSync(new URL('../ui/overrides/live-answer-recovery.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = '// xh-live-answer-recovery:start', end = '// xh-live-answer-recovery:end';
export function patchLiveAnswerRecovery(bytes) {
  let source = bytes.toString().replace(/\r\n/g, '\n');
  const block = `${start}\n${implementation}\ninstallLiveAnswerRecovery(Session);\n${end}\n`;
  if (source.includes(start)) {
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Live answer recovery anchors changed');
    return Buffer.from(source.slice(0, source.indexOf(start)) + block.trimEnd() + source.slice(source.indexOf(end) + end.length));
  }
  // Installed ahead of the transactional history layer: its retry is the
  // recovery path this relies on, and its residency wrapper must stay outermost
  // so a trim still sees every status change.
  const anchor = '// xh-atomic-history:start';
  if (source.split(anchor).length !== 2) throw Error('Live answer recovery history anchor changed');
  return Buffer.from(source.replace(anchor, block + anchor));
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const id = '@xharness/dsh-client-runtime';
  const entry = graph.entries.find(row => row.id === id);
  const path = resolve(dist, 'plugins', id, 'client.js');
  const bytes = patchLiveAnswerRecovery(readFileSync(path));
  writeFileSync(path, bytes); entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`;
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(resolve(dist, 'client-graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const index = resolve(dist, 'index.html');
  // index.html serves this bundle from an eager <script src> as well as from the
  // boot manifest; a stale query string would keep a cached pre-patch copy alive.
  const tag = new RegExp(`/plugins/${id.replaceAll('.', '\\.')}/client\\.js\\?rev=[0-9a-f]+`, 'g');
  writeFileSync(index, readFileSync(index, 'utf8')
    .replace(tag, `/plugins/${id}/client.js?rev=${entry.rev}`)
    .replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
