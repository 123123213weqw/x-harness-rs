import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const implementation = readFileSync(new URL('../ui/overrides/atomic-history.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = '// xh-atomic-history:start', end = '// xh-atomic-history:end';
export function patchAtomicHistory(bytes) {
  let source = bytes.toString().replace(/\r\n/g, '\n');
  const block = `${start}\n${implementation}\ninstallAtomicHistory(ConversationNodeAssembler, Session);\n${end}\n`;
  if (source.includes(start)) {
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Atomic history anchors changed');
    return Buffer.from(source.slice(0, source.indexOf(start)) + block.trimEnd() + source.slice(source.indexOf(end) + end.length));
  }
  // Install before the residency wrappers so pending-operation protections still apply.
  const anchor = '// xh-session-history-cache:start';
  if (source.split(anchor).length !== 2) throw Error('Atomic history cache anchor changed');
  return Buffer.from(source.replace(anchor, block + anchor));
}
export function patchHistoryRetry(bytes) {
  let source = bytes.toString().replace(/\r\n/g, '\n');
  if (source.includes('data-history-retry')) return Buffer.from(source);
  const anchor = 'openState === "error" && openError !== null && (0, react_jsx_runtime.jsx)("div", {';
  if (source.split(anchor).length !== 2) throw Error('History retry view anchor changed');
  const position = source.indexOf(anchor);
  const last = source.indexOf('\n\t\t\t\t\t\t\t}),', position);
  if (last < 0) throw Error('History retry end anchor changed');
  const old = source.slice(position, last);
  const text = 'children: t("chat.loadError", {';
  if (old.split(text).length !== 2) throw Error('History retry message anchor changed');
  const next = old.replace('react_jsx_runtime.jsx)', 'react_jsx_runtime.jsxs)')
    .replace(text, 'role: "alert",\n\t\t\t\t\t\t\t\tchildren: [t("chat.loadError", {')
    .replace(/\}\)\s*$/, '}), (0, react_jsx_runtime.jsx)("button", { type: "button", "data-history-retry": "", onClick: loadOlder, children: t("retry") })]');
  return Buffer.from(source.slice(0, position) + next + source.slice(last));
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  for (const [id, patch] of [['@xharness/dsh-client-runtime', patchAtomicHistory], ['@xharness/dsh-client-ui-conversation', patchHistoryRetry]]) {
    const entry = graph.entries.find(entry => entry.id === id);
    const path = resolve(dist, 'plugins', id, 'client.js');
    const bytes = patch(readFileSync(path));
    writeFileSync(path, bytes); entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`;
  }
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(resolve(dist, 'client-graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const index = resolve(dist, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
