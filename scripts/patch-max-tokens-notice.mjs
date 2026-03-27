import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Historical notices describe their own turn. They must not issue a current
// action instruction or claim that a queued task is continuing this answer.
export function patchMaxTokensNotice(bytes) {
 let s=bytes.toString();
 const copy=JSON.parse(readFileSync(new URL('../ui/overrides/max-tokens-notice.json',import.meta.url),'utf8'));
 for(const locale of ['zh','en']) {
  const marker=`const ${locale} = {`;
  const start=s.indexOf(marker);
  if(start<0 || s.indexOf(marker,start+1)>=0)throw Error('max tokens locale anchor changed: '+locale);
  const end=s.indexOf('\n\t\t};',start);
  if(end<0)throw Error('max tokens locale end changed: '+locale);
  const section=s.slice(start,end);
  const re=/"message\.maxTokens\.hint": ("(?:\\.|[^"\\])*")/g;
  if([...section.matchAll(re)].length!==1)throw Error('max tokens hint anchor changed: '+locale);
  const updated=section.replace(re,()=> '"message.maxTokens.hint": '+JSON.stringify(copy[locale]));
  s=s.slice(0,start)+updated+s.slice(end);
 }
 return Buffer.from(s);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dist=resolve(process.argv[2]??'ui/dist'),p=resolve(dist,'plugins/@deepseek-ai/dsh-client-ui-conversation/client.js');
 const bytes=patchMaxTokensNotice(readFileSync(p));writeFileSync(p,bytes);
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
 const gp=resolve(dist,'client-graph.json'),g=JSON.parse(readFileSync(gp));
 const e=g.entries.find(e=>e.id==='@deepseek-ai/dsh-client-ui-conversation');e.rev=hash(bytes);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;
 g.rev=hash(JSON.stringify(g.entries));writeFileSync(gp,JSON.stringify(g,null,2)+'\n');
 const ip=resolve(dist,'index.html');writeFileSync(ip,readFileSync(ip,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(g)}</script>`));
}
