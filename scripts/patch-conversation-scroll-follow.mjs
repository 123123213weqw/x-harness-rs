import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = '// xh-conversation-scroll-follow/v1';
const helper = readFileSync(new URL('../ui/overrides/conversation-scroll-follow.js', import.meta.url), 'utf8');

export function patchConversationScrollFollow(bytes) {
  let source = bytes.toString();
  if (source.includes(marker)) return Buffer.from(source);
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw Error('conversation scroll anchor changed: ' + before.slice(0, 100));
    source = source.replace(before, after);
  };
  once('\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, editMessage, fileMentions, t }) {',
    marker + '\n' + helper + '\n\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, editMessage, fileMentions, t }) {');
  once('\t\t\tconst observedTopRef = (0, react.useRef)(0);',
    '\t\t\tconst observedTopRef = (0, react.useRef)(0);\n\t\t\tconst readerScrollUntilRef = (0, react.useRef)(0);');
  once('\t\t\t\tconst movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > .5;\n'
    + '\t\t\t\tconst isAtBottom = movedByReader ? floor - el.scrollTop <= 25 : atBottomRef.current;',
    '\t\t\t\tconst readerInputRecent = Date.now() <= readerScrollUntilRef.current;\n'
    + '\t\t\t\tconst movedByReader = readerInputRecent && Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > .5;\n'
    + '\t\t\t\tconst isAtBottom = xhScrollFollowAtBottom(atBottomRef.current, el.scrollTop, floor, observedTopRef.current, readerInputRecent);');
  once('\t\t\t\tconst onScroll = () => {\n'
    + '\t\t\t\t\tonScrollRef.current();\n'
    + '\t\t\t\t};\n'
    + '\t\t\t\tel.addEventListener("scroll", onScroll, { passive: true });\n'
    + '\t\t\t\treturn () => {\n'
    + '\t\t\t\t\tel.removeEventListener("scroll", onScroll);\n'
    + '\t\t\t\t};',
    '\t\t\t\tconst onScroll = () => onScrollRef.current();\n'
    + '\t\t\t\tconst readerInput = () => { readerScrollUntilRef.current = Date.now() + 1500; };\n'
    + '\t\t\t\tconst readerKey = (event) => {\n'
    + '\t\t\t\t\tif (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;\n'
    + '\t\t\t\t\tif (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) readerInput();\n'
    + '\t\t\t\t};\n'
    + '\t\t\t\tconst readerPointer = (event) => { if (event.target === el) readerInput(); };\n'
    + '\t\t\t\tel.addEventListener("scroll", onScroll, { passive: true });\n'
    + '\t\t\t\tel.addEventListener("wheel", readerInput, { passive: true });\n'
    + '\t\t\t\tel.addEventListener("touchmove", readerInput, { passive: true });\n'
    + '\t\t\t\tel.addEventListener("keydown", readerKey);\n'
    + '\t\t\t\tel.addEventListener("pointerdown", readerPointer, { passive: true });\n'
    + '\t\t\t\treturn () => {\n'
    + '\t\t\t\t\tel.removeEventListener("scroll", onScroll);\n'
    + '\t\t\t\t\tel.removeEventListener("wheel", readerInput);\n'
    + '\t\t\t\t\tel.removeEventListener("touchmove", readerInput);\n'
    + '\t\t\t\t\tel.removeEventListener("keydown", readerKey);\n'
    + '\t\t\t\t\tel.removeEventListener("pointerdown", readerPointer);\n'
    + '\t\t\t\t};');
  return Buffer.from(source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graphPath = resolve(dist, 'client-graph.json');
  const graph = JSON.parse(readFileSync(graphPath));
  const entry = graph.entries.find(item => item.id === '@xharness/dsh-client-ui-conversation');
  const path = resolve(dist, 'plugins', entry.id, 'client.js');
  const bytes = patchConversationScrollFollow(readFileSync(path));
  writeFileSync(path, bytes);
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
  entry.rev = hash(bytes);
  entry.url = '/plugins/' + entry.id + '/client.js?rev=' + entry.rev;
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n');
  const indexPath = resolve(dist, 'index.html');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,
    () => 'window.__DSH_BOOT__ = ' + JSON.stringify(graph) + '</script>'));
}
