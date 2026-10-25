import test from 'node:test'
import assert from 'node:assert/strict'
import{spawn}from'node:child_process'
import{createServer}from'node:net'
import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{framed,lines}from'../dist/native/common.js'
test('automatic discovery rotates past crashed registrations and preserves exact Host context',async()=>{
 const home=await mkdtemp(join(tmpdir(),'xh-discovery-')),directory=join(home,'.xharness/browser-extension/clients'),clientId='ffffffff-ffff-ffff-ffff-ffffffffffff',contextId='c'.repeat(64),token='d'.repeat(64)
 await mkdir(directory,{recursive:true,mode:0o700})
 for(let i=0;i<80;i++)await writeFile(join(directory,`00000000-0000-0000-0000-${i.toString(16).padStart(12,'0')}.json`),'{}',{mode:0o600})
 const sockets=new Set(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));lines(socket,value=>{assert.equal(value.token,token);socket.write(JSON.stringify({type:'client',clientId,contextId,contextLabel:'Exact fixture context'})+'\n')},()=>socket.destroy())})
 server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve))
 await writeFile(join(directory,clientId+'.json'),JSON.stringify({version:2,clientId,contextId,contextLabel:'Exact fixture context',port:server.address().port,token}),{mode:0o600})
 const child=spawn(process.execPath,[resolve('dist/native/host.js')],{env:{...process.env,HOME:home,USERPROFILE:home}})
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk)
 try{
  const found=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error(stderr||'discovery timed out behind stale entries')),12000)
   framed(child.stdout,message=>{if(message.type==='client'){clearTimeout(timer);resolve(message)}},error=>{clearTimeout(timer);reject(error)})
  })
  const body=Buffer.from(JSON.stringify({type:'hello',version:1})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);child.stdin.write(Buffer.concat([header,body]))
  const result=await found;assert.equal(result.clientId,clientId);assert.equal(result.contextId,contextId);assert.equal(result.contextLabel,'Exact fixture context');assert.equal(result.token,undefined);assert.equal(result.pairCode,undefined)
 }finally{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));for(const socket of sockets)socket.destroy();server.close();await rm(home,{recursive:true,force:true})}
})
