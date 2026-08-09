#!/usr/bin/env node
/** Opt-in fixed public repository acceptance. GitHub/DeepSeek secrets never leave this computer. */
import {createServer} from 'node:http'
import {execFileSync,spawn} from 'node:child_process'
import {readFileSync,realpathSync} from 'node:fs'
import {createHash,timingSafeEqual} from 'node:crypto'
const nonce=process.env.XHARNESS_REVIEW_NONCE
if(!nonce||nonce.length<32)throw Error('Strong temporary nonce required')
const providersPath=process.env.XHARNESS_REVIEW_PROVIDERS
if(!providersPath)throw Error('Explicit local provider document required')
const doc=JSON.parse(readFileSync(providersPath,'utf8')),profile=doc.providers.find(p=>p.id===doc.default.provider)
if(!profile||new URL(profile.base_url).hostname!=='api.deepseek.com')throw Error('Select the locally configured direct DeepSeek profile')
let key=process.env[profile.api_key_env]
if(!key&&process.env.XHARNESS_REVIEW_STATE){const state=realpathSync(process.env.XHARNESS_REVIEW_STATE),service=`com.xlang.xharness.models.${createHash('sha256').update(state).digest('hex')}`;try{key=execFileSync('security',['find-generic-password','-s',service,'-a',profile.api_key_env,'-w'],{stdio:['ignore','pipe','ignore']}).toString().trim()}catch{}}
if(!key&&process.env.XHARNESS_REVIEW_SECRET_FILE)key=readFileSync(process.env.XHARNESS_REVIEW_SECRET_FILE,'utf8').trim()
if(!key)throw Error('Configured DeepSeek credential unavailable; no secret value was printed')
const repo='123123213weqw/x-harness-rs',root=`/repos/${repo}`
const queries=[...readFileSync(new URL('../crates/xharness-host-app/src/github_evidence.rs',import.meta.url),'utf8').matchAll(/const (?:THREADS|COMMENTS): &str = r#"([\s\S]*?)"#;/g)].map(row=>row[1])
const active=new Set(),publicThreads=new Set()
function gh(route,method='GET',body){return new Promise((resolve,reject)=>{const child=spawn('gh',['api','--hostname','github.com','--method',method,route,...(body?['--input','-']:[])],{stdio:['pipe','pipe','pipe'],env:{...process.env,GH_PROMPT_DISABLED:'1'}});active.add(child);let size=0,chunks=[];const timer=setTimeout(()=>{child.kill();reject(Error('GitHub deadline'))},45000);child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){child.kill();reject(Error('GitHub response bound'))}else chunks.push(chunk)});child.stderr.resume();child.on('error',reject);child.on('close',code=>{clearTimeout(timer);active.delete(child);if(code!==0)return reject(Error('GitHub read failed'));try{resolve(JSON.parse(Buffer.concat(chunks).toString()))}catch{reject(Error('Invalid GitHub response'))}});child.stdin.end(body?JSON.stringify(body):'')})}
function allowed(route){return route==='/user'||/^\/user\/repos\?sort=updated&per_page=50&page=\d+$/.test(route)||route.startsWith(root+'/')&&/^\/repos\/[^/]+\/[^/]+\/(?:pulls(?:\/\d+(?:\/(?:files|reviews))?)?|issues\/\d+\/comments|commits\/[a-f0-9]{40}\/(?:check-runs|status)|actions\/(?:runs(?:\/\d+(?:\/attempts\/\d+\/jobs)?)?|jobs\/\d+))(?:\?[a-z0-9_=&]+)?$/.test(route)}
async function input(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>4*1024*1024)throw Error('Input bound');parts.push(part)}return JSON.parse(Buffer.concat(parts).toString())}
const server=createServer(async(req,res)=>{const token=req.headers.authorization??'',expected=`Bearer ${nonce}`;if(token.length!==expected.length||!timingSafeEqual(Buffer.from(token),Buffer.from(expected))){res.writeHead(403).end();return}try{
 if(req.method!=='POST')throw Error('Read-only acceptance POST envelope required')
 const data=await input(req),started=Date.now();res.on('finish',()=>console.log(JSON.stringify({endpoint:req.url,route:data.route??'configured-model',status:res.statusCode,elapsedMs:Date.now()-started})))
 if(req.url==='/github'){
  let value
  if(data.route==='/graphql'){
   const {query,variables}=data.body??{};if(typeof query!=='string'||!queries.includes(query)||query.includes('mutation')||!['owner','repo','number','cursor','id'].every(k=>variables[k]===undefined||typeof variables[k]==='string'||typeof variables[k]==='number'||variables[k]===null))throw Error('Unsupported query')
   if(variables.owner){if(`${variables.owner}/${variables.repo}`!==repo||!query.includes('reviewThreads(first:20'))throw Error('Only the explicit public repository is allowed')}else if(!publicThreads.has(variables.id)||!query.includes('PullRequestReviewThread'))throw Error('Thread was not observed in the public repository')
   value=await gh('/graphql','POST',data.body)
   for(const row of value?.data?.repository?.pullRequest?.reviewThreads?.nodes??[])publicThreads.add(row.id)
  }else if(typeof data.route==='string'&&data.route.startsWith(`${root}/actions/jobs/`)&&/^\d+\/logs$/.test(data.route.slice(`${root}/actions/jobs/`.length))){
   const credential=execFileSync('gh',['auth','token','--hostname','github.com'],{stdio:['ignore','pipe','ignore']}).toString().trim()
   const response=await fetch(`https://api.github.com${data.route}`,{headers:{Authorization:`Bearer ${credential}`,Accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(45000)})
   const url=new URL(response.headers.get('location')??'https://invalid.test');if(response.status!==302||url.protocol!=='https:'||!url.hostname.endsWith('.blob.core.windows.net')&&url.hostname!=='results-receiver.actions.githubusercontent.com')throw Error('Unsupported log destination')
   const download=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(45000)});if(!download.ok)throw Error('Log download unavailable')
   let bytes=0,text='',truncated=false;for await(const chunk of download.body){bytes+=chunk.length;if(bytes>2*1024*1024){truncated=true;break}text+=Buffer.from(chunk).toString()};value={text,truncated}
  }else{if(!allowed(data.route))throw Error('Unsupported public route');value=await gh(data.route);if(data.route==='/user')value={login:value.login};if(data.route.startsWith('/user/repos'))value=value.filter(r=>!r.private)}
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));return
 }
 if(req.url==='/chat/completions'||req.url==='/v1/chat/completions'){
  if(data.model!==doc.default.model||data.tools?.length||data.messages?.length>12)throw Error('Unexpected model or tools')
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300000);res.on('close',()=>{clearTimeout(timer);controller.abort()})
  const response=await fetch(new URL('/chat/completions',profile.base_url),{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal})
  if(!response.ok){res.writeHead(response.status,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:`DeepSeek returned HTTP ${response.status}`}}));return}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk)}res.end();return
 }
 throw Error('Unsupported acceptance endpoint')
}catch(e){if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:e instanceof Error?e.message:'Acceptance failed'}}));else res.destroy()}})
server.listen(33942,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:33942,model:doc.default.model,credentials:'local-only',repository:repo})))
process.on('SIGTERM',()=>{for(const child of active)child.kill();server.closeAllConnections();server.close(()=>process.exit(0))})
