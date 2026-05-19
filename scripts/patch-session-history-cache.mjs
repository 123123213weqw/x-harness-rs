import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const start = '// xh-session-history-cache:start';
const end = '// xh-session-history-cache:end';
const implementation = readFileSync(new URL('../ui/overrides/session-history-cache.js', import.meta.url), 'utf8');
export function patchSessionHistoryCache(bytes) {
  let s = bytes.toString();
  const block = start + '\n' + implementation + 'installSessionHistoryCache(Session, SessionManager);\n' + end;
  const oldLoadOlderGuard = `\t\t\t\t\tconst tail = older[older.length - 1];
\t\t\t\t\tif (tail === void 0 || tail.event.seq + 1 !== this.baseSeq) {
\t\t\t\t\t\tconsole.error(\`[web-runtime] history page discontinuous: tail seq \${tail?.event.seq} vs baseSeq \${this.baseSeq}\`);
\t\t\t\t\t\tthis.hasMore = false;
\t\t\t\t\t\tthis.conversation.prepend([], false);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`;
  const newLoadOlderGuard = `\t\t\t\t\tif (!this.xhValidHistoryPage(older, this.baseSeq)) {
\t\t\t\t\t\tconsole.error(\`[web-runtime] invalid projected history page before \${this.baseSeq}\`);
\t\t\t\t\t\tthis.hasMore = false;
\t\t\t\t\t\tthis.conversation.prepend([], false);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`;
  if (s.includes(oldLoadOlderGuard)) s = s.replace(oldLoadOlderGuard, newLoadOlderGuard);
  else if (!s.includes(newLoadOlderGuard)) throw Error('History cache loadOlder guard anchor changed');
  if (s.includes(start)) {
    if (s.split(start).length !== 2 || s.split(end).length !== 2) throw Error('History cache implementation anchors changed');
    return Buffer.from(s.slice(0,s.indexOf(start)) + block + s.slice(s.indexOf(end) + end.length));
  }
  const once = (from,to) => {
    if (s.split(from).length !== 2) throw Error('History cache anchor changed: ' + from);
    s = s.replace(from,to);
  };
  once('/** Apply one list mutation without deriving display order. */',block + '\n/** Apply one list mutation without deriving display order. */');
  const install = 'this.installWindow(result.value.events, result.value.hasMore, result.value.projections);\n\t\t\t\t\tconst tailSeq';
  once(install, 'result = { ...result, value: await this.restoreHistoryRange(result.value, generation) };\n\t\t\t\t\tif (generation !== this.openGeneration) return;\n\t\t\t\t\t' + install);
  once('if (result.ok) this.installWindow(result.value.events, result.value.hasMore, result.value.projections);',
    'if (result.ok) { result.value = await this.restoreHistoryRange(result.value, generation); if (generation !== this.openGeneration) return; this.installWindow(result.value.events, result.value.hasMore, result.value.projections); }');
  once('this.openState = "open";\n\t\t\t\t} catch (error)', 'this.openState = "open";\n\t\t\t\t\tthis.xhRestoreBaseSeq = undefined;\n\t\t\t\t} catch (error)');
  // Existing resync guard already handles open. Older-page writes need the same epoch.
  once('this.loadingOlder = true;\n\t\t\t\tthis.notifier.markDirty();', 'this.loadingOlder = true;\n\t\t\t\tconst generation = this.openGeneration;\n\t\t\t\tthis.notifier.markDirty();');
  once('if (!result.ok) return;\n\t\t\t\t\tconst older = result.value.events;', 'if (generation !== this.openGeneration || !result.ok) return;\n\t\t\t\t\tconst older = result.value.events;');
  once('this.loadingOlder = false;\n\t\t\t\t\tthis.notifier.markDirty();',
    'if (generation === this.openGeneration) { this.loadingOlder = false; this.notifier.markDirty(); }');
  once('this.openGeneration++;\n\t\t\t\tthis.openPromise = null;',
    'this.openGeneration++;\n\t\t\t\tthis.loadingOlder = false; this.stitching = false;\n\t\t\t\tthis.openPromise = null;');
  once('this.stitching = false;\n\t\t\t\t}', 'if (generation === this.openGeneration) this.stitching = false;\n\t\t\t\t}');
  return Buffer.from(s);
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist');
  const graph = JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
  const hash = b => createHash('sha256').update(b).digest('hex').slice(0,16);
  const entry = graph.entries.find(e => e.id === '@xharness/dsh-client-runtime');
  const path = resolve(dist,'plugins',entry.id,'client.js');
  const bytes = patchSessionHistoryCache(readFileSync(path));
  writeFileSync(path,bytes); entry.rev = hash(bytes); entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`;
  graph.rev = hash(JSON.stringify(graph.entries));
  writeFileSync(resolve(dist,'client-graph.json'), JSON.stringify(graph,null,2)+'\n');
  const index = resolve(dist,'index.html');
  const tag = new RegExp(`/plugins/${entry.id.replaceAll('.','\\.')}/client\\.js\\?rev=[0-9a-f]+`,'g');
  writeFileSync(index,readFileSync(index,'utf8')
    .replace(tag,`/plugins/${entry.id}/client.js?rev=${entry.rev}`)
    .replace(/window\.__DSH_BOOT__ = .*?<\/script>/,() => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
