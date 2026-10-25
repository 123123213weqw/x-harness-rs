import test from 'node:test'
import assert from 'node:assert/strict'
import{spawn}from'node:child_process'
import{mkdtemp,rm,readdir,readFile,stat}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{connect}from'node:net'
import{createInterface}from'node:readline'
async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'xh-browser-client-')),child=spawn(process.execPath,[resolve('dist/native/mcp.js')],{env:{...process.env,HOME:home,USERPROFILE:home,XHARNESS_BROWSER_CONTEXT_ID:'a'.repeat(64),XHARNESS_BROWSER_CONTEXT_LABEL:'Conversation A'}}),replies=new Map();let seq=0,stderr=''
 child.stderr.on('data',chunk=>stderr+=chunk)
 createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);replies.get(value.id)?.(value);replies.delete(value.id)})
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>reject(Error(stderr||'MCP timeout')),20000);replies.set(id,value=>{clearTimeout(timer);resolve(value)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
 const dir=join(home,'.xharness/browser-extension/clients');let entry
 for(let i=0;i<500;i++){try{const files=await readdir(dir);if(files.length){entry=JSON.parse(await readFile(join(dir,files[0]),'utf8'));break}}catch{}await new Promise(r=>setTimeout(r,30))}
 assert.ok(entry,stderr)
 return {child,home,entry,call,async close(){child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));await rm(home,{recursive:true,force:true})}}
}
test('unpaired MCP is discoverable but cannot operate a tab; credentials are private',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('initialize',{})).result.serverInfo.name,'xharness-browser-extension')
  const tools=(await f.call('tools/list',{})).result.tools;assert.equal(tools.length,1);assert.equal(tools[0].name,'browser');assert.equal(tools[0].inputSchema.oneOf.length,6);assert.ok(tools[0].inputSchema.oneOf.every(row=>row.additionalProperties===false))
  const status=JSON.parse((await f.call('tools/call',{name:'browser',arguments:{action:'status'}})).result.content[0].text)
  assert.equal(status.connected,false);assert.equal(status.contextId,'a'.repeat(64));assert.equal(status.pairCode,undefined);assert.equal(status.installation.installed,false);assert.equal(JSON.stringify(status).includes(f.entry.token),false)
  assert.equal((await f.call('tools/call',{name:'browser',arguments:{action:'observe',tabId:1}})).result.isError,true)
  if(process.platform!=='win32')assert.equal((await stat(join(f.home,'.xharness/browser-extension/clients',f.entry.clientId+'.json'))).mode&0o077,0)
 }finally{await f.close()}
})
test('wrong bridge token is rejected; disconnect settles an in-flight effect as uncertain',async()=>{
 const f=await fixture();let socket
 try{
  const bad=connect(f.entry.port,'127.0.0.1');bad.on('error',()=>{});bad.write(JSON.stringify({token:'0'.repeat(64)})+'\n');await new Promise(resolve=>bad.once('close',resolve))
  socket=connect(f.entry.port,'127.0.0.1');socket.write(JSON.stringify({token:f.entry.token})+'\n')
  const reader=createInterface({input:socket}),messages=[];reader.on('line',line=>messages.push(JSON.parse(line)))
  while(messages.length===0)await new Promise(r=>setTimeout(r,5))
  assert.equal(messages[0].contextId,f.entry.contextId)
  const promise=f.call('tools/call',{name:'browser',arguments:{action:'press',tabId:7,key:'Enter'}})
  while(messages.length<2)await new Promise(r=>setTimeout(r,5))
  socket.destroy();const response=await promise
  assert.equal(response.result.isError,true);assert.equal(JSON.parse(response.result.content[0].text).outcome,'possibly-applied')
 }finally{socket?.destroy();await f.close()}
})

test('an MCP without Host identity fails before publishing rendezvous or installing anything',async()=>{
 const home=await mkdtemp(join(tmpdir(),'xh-no-binding-')),env={...process.env,HOME:home,USERPROFILE:home}
 delete env.XHARNESS_BROWSER_CONTEXT_ID
 const child=spawn(process.execPath,[resolve('dist/native/mcp.js')],{env});let stderr=''
 child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume()
 try{const code=await new Promise(resolve=>child.once('exit',resolve));assert.notEqual(code,0);assert.match(stderr,/Host-owned conversation identity/);await assert.rejects(readdir(join(home,'.xharness')))}finally{child.kill();await rm(home,{recursive:true,force:true})}
})
