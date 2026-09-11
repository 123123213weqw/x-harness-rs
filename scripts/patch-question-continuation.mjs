import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export function patchQuestionContinuation(name,bytes) {
 let s=bytes.toString(); const marker='// xh-question-deferred/v1';
 if(s.includes(marker))return patchDeferredQuestionUI(name,bytes);
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Question continuation anchor changed: '+name+' '+a);s=s.replace(a,b)};
 if(name==='@deepseek-ai/dsh-client-connection') {
  once('questions: array(askUserQuestionItemSchema).min(1)','questions: array(askUserQuestionItemSchema).min(1),\n deferred: boolean().optional(), waitTimeoutSeconds: number().optional()');
 } else if(name==='@deepseek-ai/dsh-client-ui-user-questions') {
  once('get questions() {','get deferred() { return this.wait.payload.deferred === true; }\n get questions() {');
  once('"data-question-key": pending.key,','"data-question-key": pending.key,\n "data-question-deferred": pending.deferred ? "true" : "false",');
  once('children: question.question','children: question.question');
  once('children: [question.header !== void 0 &&','children: [pending.deferred && react_jsx_runtime.jsx("div",{role:"status",children:"等待回答 · 已解除阻塞，仅允许独立的只读探索；未回答不代表同意"}),question.header !== void 0 &&');
 } else return bytes;
 return patchDeferredQuestionUI(name,Buffer.from(marker+'\n'+s));
}
// Keep the upstream chain winner and draft owner mounted. Only a rendered,
// durably deferred question releases the existing composer fallback; an approval
// or subagent winner never carries this marker and remains blocking.
function patchDeferredQuestionUI(name,bytes) {
 if(name!=='@deepseek-ai/dsh-client-ui-user-questions')return bytes;
 let s=bytes.toString();const marker='// xh-question-strip/v2';if(s.includes(marker))return bytes;
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('Question strip anchor changed: '+a);s=s.replace(a,b)};
 once('const [minimized, setMinimized] = (0, react.useState)(false);',`const [minimized, setMinimized] = (0, react.useState)(pending.deferred);
 const deferredSeen = react.useRef(pending.deferred);
 react.useEffect(() => {
  if(pending.deferred && !deferredSeen.current)setMinimized(true);
  deferredSeen.current=pending.deferred;
 },[pending.deferred]);`);
 once('"data-question-deferred": pending.deferred ? "true" : "false",','"data-question-deferred": pending.deferred ? "true" : "false",\n "data-question-minimized": minimized ? "true" : "false",');
 once('children:"等待回答 · 已解除阻塞，仅允许独立的只读探索；未回答不代表同意"','children:minimized ? "待回答 · 不阻塞当前对话" : "等待回答 · 仅允许独立的只读探索；未回答不代表同意"');
 once('"aria-label": t(minimized ? "nav.maximize" : "nav.minimize"),','"aria-label": pending.deferred && minimized ? "展开待回答问题" : t(minimized ? "nav.maximize" : "nav.minimize"),');
 const css=`
 [data-composer-seat]:has([data-question-deferred="true"]) [data-chain-overlay-fallback="conversation.composer"]{display:contents!important}
 [data-composer-seat]:has([data-question-deferred="true"]) [data-slot="conversation.composer"]{display:flex;flex-direction:column}
 [data-composer-seat]:has([data-question-deferred="true"]) [data-chain-overlay-fallback="conversation.composer"]>*{order:2}
 [data-question-deferred="true"]{order:1;flex-shrink:0}
 [data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_card{padding:0;box-shadow:none;border-radius:12px}
 [data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_header{padding:8px 12px;align-items:center;gap:8px}
 [data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_headingBlock{display:flex;align-items:center;gap:10px;min-width:0}
 [data-question-deferred="true"][data-question-minimized="true"] [role="status"]{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
 [data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_eyebrow{display:none}
 [data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_title{font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
 @media(max-width:520px){[data-question-deferred="true"][data-question-minimized="true"] .r3cF6q_title{display:none}}
 `;
 once('tag.textContent = css;', 'tag.textContent = css + '+JSON.stringify(css)+';');
 return Buffer.from(marker+'\n'+s);
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dist=resolve(process.argv[2]??'ui/dist');const graph=JSON.parse(readFileSync(resolve(dist,'client-graph.json')));
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
 for(const e of graph.entries) {
  if(!['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-user-questions'].includes(e.id))continue;
  const p=resolve(dist,'plugins',e.id,'client.js');const old=readFileSync(p),b=patchQuestionContinuation(e.id,old);
  if(!b.equals(old))writeFileSync(p,b);e.rev=hash(b);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;
 }
 graph.rev=hash(JSON.stringify(graph.entries));writeFileSync(resolve(dist,'client-graph.json'),JSON.stringify(graph,null,2)+'\n');
 const p=resolve(dist,'index.html');writeFileSync(p,readFileSync(p,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`));
}
