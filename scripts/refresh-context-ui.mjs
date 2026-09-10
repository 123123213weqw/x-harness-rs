import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dist='ui/dist',id='@xlang/xharness-client-ui-context';
const bytes=readFileSync(`ui/plugins/${id}/client.js`);writeFileSync(`${dist}/plugins/${id}/client.js`,bytes);
const hash=x=>createHash('sha256').update(x).digest('hex').slice(0,16);
const graph=JSON.parse(readFileSync(`${dist}/client-graph.json`));const entry=graph.entries.find(e=>e.id===id);entry.rev=hash(bytes);entry.url=`/plugins/${id}/client.js?rev=${entry.rev}`;graph.rev=hash(JSON.stringify(graph.entries));
writeFileSync(`${dist}/client-graph.json`,JSON.stringify(graph,null,2)+'\n');
writeFileSync(`${dist}/index.html`,readFileSync(`${dist}/index.html`,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
