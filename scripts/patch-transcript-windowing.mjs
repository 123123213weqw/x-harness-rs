import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const marker = '// xh-transcript-windowing/v1';
const startMarker = '// xh-transcript-implementation:start';
const endMarker = '// xh-transcript-implementation:end';
const implementation = readFileSync(new URL('../ui/overrides/transcript-windowing.js', import.meta.url), 'utf8');
export function patchTranscriptWindowing(bytes) {
  let s = bytes.toString();
  if (s.includes(marker)) {
    if (s.split(startMarker).length !== 2 || s.split(endMarker).length !== 2) throw Error('Transcript implementation anchors changed');
    const start = s.indexOf(startMarker), end = s.indexOf(endMarker, start);
    return Buffer.from(s.slice(0, start) + startMarker + '\n' + implementation + endMarker + s.slice(end + endMarker.length));
  }
  const once = (from, to) => {
    if (s.split(from).length !== 2) throw Error('Transcript windowing anchor changed: ' + from);
    s = s.replace(from, to);
  };
  once('const ChatNodeSeat = (0, react.memo)', startMarker + '\n' + implementation + endMarker + '\nconst XhTranscriptWindowRow = createTranscriptWindowing(react);\nconst ChatNodeSeat = (0, react.memo)');
  // Preserve the existing anchor element and all upstream layout semantics.
  once('editAvailable, renderMessageImages, fileMentions, useSession, renderSlot, t }) {',
       'editAvailable, renderMessageImages, fileMentions, useSession, renderSlot, t, keepMounted }) {');
  once('className: ChatView_module_css_default.flowItem,', 'className: ChatView_module_css_default.flowItem,\n                keepMounted,');
  const start = s.indexOf('const ChatNodeSeat = (0, react.memo)');
  const end = s.indexOf('//#region lib/types/client/chat/ChatView.js', start);
  let seat = s.slice(start, end);
  const root = 'return (0, react_jsx_runtime.jsx)("div", {';
  if (seat.split(root).length !== 2) throw Error('Transcript root anchor changed');
  seat = seat.replace(root, 'return (0, react_jsx_runtime.jsx)(XhTranscriptWindowRow, {');
  s = s.slice(0, start) + seat + s.slice(end);
  // Protect all nodes in the active user-turn suffix, including parallel tools.
  once('const selectedCallId = useStore((s) => s.selection?.callId);',
       'const selectedCallId = useStore((s) => s.selection?.callId);\nconst activeSuffix = running ? Math.max(0, order.findLastIndex(key => nodeStore.get(key)?.kind === "user")) : order.length;');
  once('order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {',
       'order.map((nodeKey, index) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {\nkeepMounted: index >= activeSuffix,');
  return Buffer.from(marker + '\n' + s);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json')));
  const hash = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
  const entry = graph.entries.find(e => e.id === '@deepseek-ai/dsh-client-ui-conversation');
  const path = resolve(dist, 'plugins', entry.id, 'client.js');
  const bytes = patchTranscriptWindowing(readFileSync(path));
  writeFileSync(path, bytes); entry.rev = hash(bytes); entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`;
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(resolve(dist, 'client-graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const index = resolve(dist, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,
    () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
