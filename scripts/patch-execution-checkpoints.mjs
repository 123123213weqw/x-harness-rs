import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function patchExecutionCheckpoints(bytes) {
 let s=bytes.toString();
 const once=(a,b)=>{if(s.split(a).length!==2)throw Error('checkpoint UI anchor changed: '+a);s=s.replace(a,b)};
 const helper=readFileSync(new URL('../ui/overrides/execution-checkpoints.js',import.meta.url),'utf8');
 if(s.includes('// xh-execution-checkpoints/v1')) {
  const start=s.indexOf('// xh-execution-checkpoints/v1'),end=s.indexOf('\t\tfunction registerTurnMaxTokensConversationNode(ctx) {',start);
  if(end<0)throw Error('checkpoint helper end anchor changed');
  return Buffer.from(s.slice(0,start)+helper+'\n'+s.slice(end));
 }
 once('\t\tfunction registerTurnMaxTokensConversationNode(ctx) {',helper+'\n\t\tfunction registerTurnMaxTokensConversationNode(ctx) {');
 once('registerTurnMaxTokensConversationNode(ctx);','registerTurnMaxTokensConversationNode(ctx);\n ctx.conversationEvents.register(xhCheckpointDefinition);');
 once('case "turn-max-tokens":','case "run-checkpoint":\n\t\t\t\tcase "turn-max-tokens":');
 once('}, TurnMaxTokensNodeView));',`}, TurnMaxTokensNodeView));
 ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({name:"conversation.chat.node",key:"run-checkpoint",locale:NS}, XhCheckpointView));`);
 return Buffer.from(s);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dist=resolve(process.argv[2]??'ui/dist'),p=resolve(dist,'plugins/@deepseek-ai/dsh-client-ui-conversation/client.js');
 const bytes=patchExecutionCheckpoints(readFileSync(p));writeFileSync(p,bytes);
 const hash=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
 const gp=resolve(dist,'client-graph.json'),g=JSON.parse(readFileSync(gp));
 const e=g.entries.find(e=>e.id==='@deepseek-ai/dsh-client-ui-conversation');e.rev=hash(bytes);e.url='/plugins/'+e.id+'/client.js?rev='+e.rev;
 g.rev=hash(JSON.stringify(g.entries));writeFileSync(gp,JSON.stringify(g,null,2)+'\n');
 const ip=resolve(dist,'index.html');writeFileSync(ip,readFileSync(ip,'utf8').replace(/window\.__DSH_BOOT__ = .*?<\/script>/,()=>`window.__DSH_BOOT__ = ${JSON.stringify(g)}</script>`));
}
