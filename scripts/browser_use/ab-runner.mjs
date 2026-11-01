#!/usr/bin/env node
// Paid model evaluation; secrets enter stdin only and are never persisted.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startAbFixture, AB_TASKS } from './ab-fixture.mjs';
import { provenance, verifyUnchanged } from './provenance.mjs';
if (process.platform !== 'linux' || process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw Error('Run only on the isolated Linux server');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); if (!arg.startsWith('--') || at < 0) throw Error('Use --name=value'); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const repeats = Number(options.repeats ?? 3), concurrency = Number(options.concurrency ?? 2);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('Invalid experiment sizes');
let credentialText = ''; for await (const chunk of process.stdin) { credentialText += chunk; if (credentialText.length > 16384) throw Error('Credential envelope too large'); }
const credential = JSON.parse(credentialText); credentialText = '';
let key = credential.api_key; delete credential.api_key;
if (typeof key !== 'string' || !key.trim()) throw Error('An existing DeepSeek credential is required on stdin');
const output = resolve(options.output ?? '../browser-use-ab-20261022/results/current');
await mkdir(output, { recursive: false, mode: 0o700 });
await mkdir(join(output,'media'),{mode:0o700});
const fixture = await startAbFixture();
const referenceModule = process.env.BROWSER_AB_REFERENCE_MODULE;
if (!referenceModule) throw Error('An actual pinned reference backend adapter is required');
const { createReference } = await import(pathToFileURL(resolve(referenceModule)).href);
const runProvenance = await provenance(repository);
const hash = value => createHash('sha256').update(value).digest('hex');
const driverSource = await readFile(fileURLToPath(import.meta.url));
const fixtureSource = await readFile(new URL('./ab-fixture.mjs', import.meta.url));
const initialReferenceHash = hash(await readFile(referenceModule));
const clean = text => String(text).split(key).join('[credential-redacted]');
const commonActions = new Set(['tabs','new','select','close','navigate','back','forward','reload','observe','click','fill','type','press','hover','drag','selectOption','check','scroll','wait','screenshot','mouse','dialog']);
const terminalPolicy = 'Observe page-owned terminal state with up to 500ms passive settling before closing either backend; no action replay';
const config = { model: options.model ?? 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192, stream: false };
const system = 'Complete the user goal using only the browser tools. Choose your own strategy; no operation sequence is prescribed. Only the supplied local test website is in scope. Do not use arbitrary JavaScript, HTTP clients, source inspection, network response bodies, filesystem or shell. Do not purchase, submit orders, or change real accounts. Read actual page evidence and verify the requested end state. Tool receipts describe execution, not task success. After an uncertain operation observe before deciding whether to retry. Screenshots are available if helpful; you need not take one after every action.';
const trials = [], active = new Set();
function score(runId) { const raw=fixture.score(runId); if(typeof raw.success!=='boolean') throw Error('Fixture score must declare boolean success'); return {...raw,passed:raw.success}; }
let requestSequence = 0;
function prepareResult(value) {
  const images = new Map();
  function visit(item) {
    if (typeof item === 'string') {
      const base64 = item.startsWith('data:image/png;base64,') ? item.slice(22) : item.startsWith('iVBORw0KGgo') && item.length > 60 ? item : null;
      if (base64) { const bytes = Buffer.from(base64, 'base64'); if (bytes.length <= 8 * 1024 * 1024 && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a') { const digest = hash(bytes); images.set(digest, { base64, mimeType: 'image/png', sha256: digest, bytes: bytes.length }); return { image: { sha256: digest, bytes: bytes.length } }; } }
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k,v])=>[k,visit(v)]));
    return item;
  }
  const sanitized = visit(value), fullText = JSON.stringify(sanitized);
  const text = Buffer.byteLength(fullText) <= 65536 ? fullText : JSON.stringify({ truncated: true, note: 'Common 64 KiB tool evidence cap; read narrower page evidence', prefix: Buffer.from(fullText).subarray(0,62000).toString('utf8') });
  return { sanitized, imagePayloads:Array.from(images.values()), content: images.size ? [{ type:'text', text }, ...Array.from(images.values(), image=>({ type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.base64}`,detail:'original'} }))] : text, images: Array.from(images.values(), ({base64,...metadata})=>metadata), textBytes: Buffer.byteLength(text) };
}
async function provider(messages, tools, requests) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const start = performance.now(), id = ++requestSequence;
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' }, body:JSON.stringify({...config,messages,tools,tool_choice:'auto'}), signal:AbortSignal.timeout(120000) });
      if (!response.ok) { const error = Error(`provider HTTP ${response.status}`); error.retryable = [408,429,500,502,503,504].includes(response.status); throw error; }
      const body = await response.json();
      requests.push({id,attempt,elapsedMs:Math.round(performance.now()-start),model:body.model,usage:body.usage ?? {},finishReason:body.choices?.[0]?.finish_reason});
      if (!body.choices?.[0]?.message) throw Error('provider omitted message');
      return body.choices[0];
    } catch (error) {
      const retryable = error.retryable === true || error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError;
      requests.push({id,attempt,elapsedMs:Math.round(performance.now()-start),error:clean(error.message),retryable,usageUnavailable:true});
      if (!retryable || attempt === 3) throw error;
      await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
    }
  }
}
async function createCandidate(artifactRoot) {
  const child = spawn(process.execPath,[resolve(repository,'plugins/browser-use/server.mjs')],{cwd:repository,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR ?? '/tmp',XHARNESS_BROWSER_ALLOWED_ORIGINS:JSON.stringify([fixture.origin]),XHARNESS_BROWSER_ARTIFACT_ROOT:artifactRoot},stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0,stderr='';
  child.stderr.on('data', chunk=>{stderr=clean((stderr+chunk).slice(-4000));});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const packet=JSON.parse(line);const slot=pending.get(packet.id);if(slot){pending.delete(packet.id);clearTimeout(slot.timer);packet.error?slot.reject(Error('MCP protocol error')):slot.resolve(packet.result);}}catch{}});
  child.on('exit',(code,signal)=>{for(const slot of pending.values()){clearTimeout(slot.timer);slot.reject(Error(`MCP exited ${code ?? signal}: ${stderr}`));}pending.clear();});
  function rpc(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(`MCP ${method} timeout`));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  const adapter={async close(){child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGTERM'),1500);const hard=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);clearTimeout(hard);resolve();});});lines.close();}};
  try{
    await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'blind-paired-ab',version:'1'}});
    const listed=await rpc('tools/list');
    const tools=listed.tools.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:structuredClone(tool.inputSchema)}}));
    for(const tool of tools)tool.function.parameters.properties.action.enum=tool.function.parameters.properties.action.enum.filter(action=>commonActions.has(action));
    return {...adapter,tools,provenance:{backend:'candidate actual stdio MCP',...runProvenance},async call(name,args){if(name!=='browser'||!commonActions.has(args.action))throw Error('Action outside common browser experiment scope');if(args.url&&new URL(args.url).origin!==fixture.origin)throw Error('URL outside fixture scope');return rpc('tools/call',{name,arguments:args});}};
  }catch(error){await adapter.close();throw error;}
}
function category(result) {
  if(result.score?.passed)return 'passed-page-state';
  if(result.error?.startsWith('provider'))return 'provider-or-network-infrastructure';
  if(result.error)return 'infrastructure-or-tool-failure-needs-review';
  if(result.requests.some(request=>request.finishReason==='length'))return 'output-truncated-needs-review';
  if(result.stopReason==='action-limit'||result.stopReason==='time-limit')return 'bounded-task-incomplete-needs-trace-review';
  return 'page-state-not-achieved-needs-decision-vs-reading-review';
}
async function trial(task,repeat,arm,seed) {
  const run=fixture.createRun({taskId:task.id,seed,arm});
  if(score(run.runId).passed)throw Error("Fresh fixture must not begin already completed");
  const dir=await mkdtemp(join(output,`${arm}-${task.id}-${repeat}-`));
  const requests=[],trace=[];let backend,error,answer='',stopReason='model-turn-limit',start=performance.now();
  const result={taskId:task.id,label:task.label,repeat,arm,seed,scenarioHash:run.scenarioHash,goal:run.goal,url:run.url,requests,trace};
  try{
    backend=arm==='candidate'?await createCandidate(dir):await createReference({allowedOrigins:[fixture.origin],artifactRoot:dir,viewport:{width:1280,height:800},executablePath:process.env.BROWSER_AB_CHROMIUM,visual:true});
    active.add(backend);result.backendProvenance=backend.provenance;result.tools=backend.tools;
    const messages=[{role:'system',content:system},{role:'user',content:`${run.goal}\nStart URL: ${run.url}`}];
    let actions=0;
    for(let step=0;step<25;step++){
      if(performance.now()-start>300000){stopReason='time-limit';break;}
      const choice=await provider(messages,backend.tools,requests), wire=choice.message;
      console.log(JSON.stringify({type:'model-step',task:task.id,repeat,arm,step,request:requests.at(-1)}));
      const calls=wire.tool_calls ?? [];
      // Keep provider-required reasoning only in transient continuation, never reports.
      messages.push({role:'assistant',content:wire.content ?? null,...(wire.reasoning_content===undefined?{}:{reasoning_content:wire.reasoning_content}),...(calls.length?{tool_calls:calls}: {})});
      if(!calls.length){answer=wire.content ?? '';stopReason='model-finished';await new Promise(resolve=>setTimeout(resolve,150));break;}
      for(const call of calls){
        actions++;if(actions>40){stopReason='action-limit';break;}
        const actionStart=performance.now();let args,raw;
        try{args=JSON.parse(call.function.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Tool arguments must be an object');raw=await backend.call(call.function.name,args);}catch(error){raw={error:clean(error.message),outcome:'not-started',experimentBroker:true};}
        const prepared=prepareResult(raw);
        for(const image of prepared.imagePayloads)await writeFile(join(output,'media',image.sha256+'.png'),Buffer.from(image.base64,'base64'),{mode:0o600});
        trace.push({step,action:actions,tool:call.function.name,arguments:args ?? call.function.arguments,result:prepared.sanitized,images:prepared.images,textBytes:prepared.textBytes,elapsedMs:Math.round(performance.now()-actionStart)});
        messages.push({role:'tool',tool_call_id:call.id,content:prepared.content});
      }
      if(actions>40)break;
      if(score(run.runId).passed){stopReason='verified-page-state';break;}
    }
  }catch(caught){error=clean(caught.message);}
  finally{
    if(backend){
      // Observe terminal asynchronous page effects before cleanup; never replay an
      // action or tell the model the hidden goal. Same passive window in both arms.
      const settlementStart=performance.now();
      while(!score(run.runId).passed&&performance.now()-settlementStart<500)await new Promise(resolve=>setTimeout(resolve,20));
      result.terminalSettlement={maximumMs:500,elapsedMs:Math.round(performance.now()-settlementStart),successObservedBeforeClose:score(run.runId).passed};
      result.score=score(run.runId);result.fixture=fixture.evidence(run.runId);
      await backend.close().catch(caught=>{error??=clean(caught.message);});active.delete(backend);
    }
    await rm(dir,{recursive:true,force:true});
  }
  result.elapsedMs=Math.round(performance.now()-start);result.answer=answer;result.stopReason=stopReason;result.error=error;result.score??=score(run.runId);result.fixture??=fixture.evidence(run.runId);result.category=category(result);
  await writeFile(join(output,`${task.id}-${repeat}-${arm}.json`),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  trials.push(result);console.log(JSON.stringify({task:task.id,repeat,arm,passed:result.score.passed,actions:trace.length,elapsedMs:result.elapsedMs,category:result.category,error}));
  return result;
}
function summary() {
 const aggregate={};
 for(const arm of ['candidate','reference']){const rows=trials.filter(row=>row.arm===arm);const usage={};for(const row of rows)for(const r of row.requests)for(const[k,v]of Object.entries(r.usage))if(typeof v==='number')usage[k]=(usage[k]??0)+v;aggregate[arm]={trials:rows.length,passed:rows.filter(row=>row.score.passed).length,failed:rows.filter(row=>!row.score.passed).length,meanElapsedMs:rows.length?Math.round(rows.reduce((n,row)=>n+row.elapsedMs,0)/rows.length):null,toolCalls:rows.reduce((n,row)=>n+row.trace.length,0),providerRequests:rows.reduce((n,row)=>n+row.requests.length,0),usage};}
 const pairs=[];for(const row of trials.filter(row=>row.arm==='candidate')){const other=trials.find(r=>r.arm==='reference'&&r.repeat===row.repeat&&r.taskId===row.taskId);if(other)pairs.push({taskId:row.taskId,repeat:row.repeat,scenarioHashEqual:row.scenarioHash===other.scenarioHash,candidatePassed:row.score.passed,referencePassed:other.score.passed,candidateMs:row.elapsedMs,referenceMs:other.elapsedMs});}
 return {schema:'xharness.browser-use.model-ab.v1',generatedAt:new Date().toISOString(),config,terminalPolicy,systemPrompt:system,repeats,concurrency,aggregate,paired: pairs,provenance:{candidate:runProvenance,runnerSha256:hash(driverSource),fixtureSha256:hash(fixtureSource),referenceModule,referenceAdapterSha256:initialReferenceHash,actualHeadlessLaunchExecutable:process.env.BROWSER_AB_CHROMIUM},scope:'Model-driven paired task experiment: actual candidate stdio MCP vs pinned official ZCode headless backend via native-command broker. Not the full ZCode agent prompt/runtime/UI. First-party generated realistic workflows, not external shopping success.',limitations:['Small task suite, not proof of universal superiority','Different native tool schemas/libraries are part of this interface comparison; backend versions recorded per trial','Fixture page state is the oracle; model self-report never scores success','No purchases, external account changes, live app restart, deployment or existing user profiles','Provider reasoning is retained transiently only for API continuation, never evidence logs','Failed-task categories are provisional; traces require review before attributing to model or code'],trials:trials.map(({trace,fixture,tools,backendProvenance,...row})=>row)};
}
let stopped=false;
process.once('SIGTERM',()=>{stopped=true;for(const backend of active)void backend.close();});
try{
 const tasks=AB_TASKS.filter(task=>!options.tasks||options.tasks.split(',').includes(task.id));if(!tasks.length)throw Error('No selected tasks');
 const jobs=[];for(let repeat=0;repeat<repeats;repeat++)for(let index=0;index<tasks.length;index++)jobs.push({task:tasks[index],repeat,seed:String(20261022+repeat*7919+index*101)});
 let cursor=0;await Promise.all(Array.from({length:concurrency},async()=>{while(!stopped){const job=jobs[cursor++];if(!job)return;for(const arm of (job.repeat+tasks.indexOf(job.task))%2?['reference','candidate']:['candidate','reference']){if(stopped)return;await trial(job.task,job.repeat,arm,job.seed);await writeFile(join(output,'summary.partial.json'),JSON.stringify(summary(),null,2)+'\n',{mode:0o600});}}}));
 await verifyUnchanged(repository,runProvenance);
 if(hash(await readFile(fileURLToPath(import.meta.url)))!==hash(driverSource)||hash(await readFile(new URL('./ab-fixture.mjs',import.meta.url)))!==hash(fixtureSource)||hash(await readFile(referenceModule))!==initialReferenceHash)throw Error('Experiment sources changed during execution');
 const report=summary();report.provenance.referenceAdapterSha256=hash(await readFile(referenceModule));report.complete=!stopped&&trials.length===jobs.length*2;
 await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({output,complete:report.complete,aggregate:report.aggregate,paired:report.paired}));
}finally{for(const backend of active)await backend.close().catch(()=>{});await fixture.close();key='';}
