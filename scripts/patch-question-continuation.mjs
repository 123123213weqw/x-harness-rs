import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export function patchQuestionContinuation(name,bytes) {
 let s=bytes.toString(); const marker='// xh-question-deferred/v1';
 if(s.includes(marker))return bytes;
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Question continuation anchor changed: '+name+' '+a);s=s.replace(a,b)};
 if(name==='@deepseek-ai/dsh-client-connection') {
  once('questions: array(askUserQuestionItemSchema).min(1)','questions: array(askUserQuestionItemSchema).min(1),\n deferred: boolean().optional(), waitTimeoutSeconds: number().optional()');
 } else if(name==='@deepseek-ai/dsh-client-ui-user-questions') {
  once('get questions() {','get deferred() { return this.wait.payload.deferred === true; }\n get questions() {');
  once('"data-question-key": pending.key,','"data-question-key": pending.key,\n "data-question-deferred": pending.deferred ? "true" : "false",');
  once('children: question.question','children: question.question');
  once('children: [question.header !== void 0 &&','children: [pending.deferred && react_jsx_runtime.jsx("div",{role:"status",children:"等待回答 · 已解除阻塞，仅允许独立的只读探索；未回答不代表同意"}),question.header !== void 0 &&');
 } else return bytes;
 return Buffer.from(marker+'\n'+s);
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dist=resolve(process.argv[2]??'ui/dist');const graph=JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
 for(const e of graph.entries) {
  const p=resolve(dist,'plugins',e.id,'client.js');const old=readFileSync(p),b=patchQuestionContinuation(e.id,old);
  if(b.equals(old))continue;writeFileSync(p,b);e.rev=hash(b);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;
 }
 graph.rev=hash(JSON.stringify(graph.entries));writeFileSync(resolve(dist,'client-graph.json'),JSON.stringify(graph,null,2)+'\n');
 const p=resolve(dist,'index.html');writeFileSync(p,readFileSync(p,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
