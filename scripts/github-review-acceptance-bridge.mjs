#!/usr/bin/env node
// Acceptance only: gh credentials never leave this workstation. Only fixed
// public-repository GET routes are exposed through an SSH loopback tunnel.
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {timingSafeEqual} from 'node:crypto'
const nonce=process.env.XHARNESS_GITHUB_ACCEPTANCE_NONCE
if(!nonce||nonce.length<32)throw Error('Supply a strong temporary acceptance nonce')
const publicRepo='123123213weqw/x-harness-rs'
const root=`/repos/${publicRepo}`
const active=new Set()
function allowed(route){return route==='/user'||/^\/user\/repos\?sort=updated&per_page=50&page=\d+$/.test(route)||route.startsWith(root+'/')&&new RegExp(`^/repos/${publicRepo}/(?:pulls(?:/\\d+(?:/(?:files|reviews))?)?|issues/\\d+/comments|commits/[a-f0-9]{40}/(?:check-runs|status))(?:\\?[a-z0-9_=&]+)?$`).test(route)}
const server=createServer((req,res)=>{
 const token=req.headers.authorization??'',expected=`Bearer ${nonce}`
 if(token.length!==expected.length||!timingSafeEqual(Buffer.from(token),Buffer.from(expected))){res.writeHead(403).end();return}
 const route=new URL(req.url??'/', 'http://127.0.0.1').searchParams.get('route')??''
 if(req.method!=='GET'||!allowed(route)){console.warn('Acceptance route rejected:',route);res.writeHead(400).end();return}
 const child=spawn('gh',['api','--hostname','github.com','--method','GET',route],{stdio:['ignore','pipe','pipe'],env:{...process.env,GH_PROMPT_DISABLED:'1'}})
 active.add(child)
 let bytes=0;const chunks=[];let stopped=false;let httpStatus=null
 child.stderr.on('data',chunk=>{const match=/HTTP (\d{3})/.exec(chunk.toString());if(match)httpStatus=match[1]})
 function stop(){if(stopped)return;stopped=true;child.kill();clearTimeout(timer)}
 const timer=setTimeout(()=>{stop();res.writeHead(504).end()},35000)
 req.on('aborted',stop);res.on('close',stop)
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){stop();res.writeHead(413).end()}else chunks.push(chunk)})
 child.stderr.resume() // Never expose raw CLI diagnostics.
 child.on('error',()=>{stop();if(!res.writableEnded)res.writeHead(502).end()})
 child.on('close',code=>{
  active.delete(child);if(stopped)return;clearTimeout(timer)
  if(code!==0){console.warn('Acceptance CLI read failed:',route,'exit',code,'http',httpStatus);res.writeHead(502).end();return}
  try{let value=JSON.parse(Buffer.concat(chunks).toString());if(route==='/user')value={login:value.login};
   // This acceptance tunnel intentionally excludes all private repository data.
   if(route.startsWith('/user/repos'))value=value.filter(item=>!item.private)
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value))
  }catch{res.writeHead(502).end()}
 })
})
server.listen(33941,'127.0.0.1',()=>console.log('Read-only public GitHub acceptance bridge listening on loopback 33941'))

process.on('SIGTERM',()=>{for(const child of active)child.kill();server.closeAllConnections();server.close(()=>process.exit(0))})
