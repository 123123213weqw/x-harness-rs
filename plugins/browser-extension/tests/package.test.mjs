import test from 'node:test'
import assert from 'node:assert/strict'
import{spawn,execFile}from'node:child_process'
import{promisify}from'node:util'
import{mkdtemp,writeFile,readFile,mkdir,rm}from'node:fs/promises'
import{createInterface}from'node:readline'
import{tmpdir}from'node:os'
import{join,resolve,dirname}from'node:path'
test('complete generated archive boots automatic setup without a source checkout',{
 skip:process.platform==='win32'?'File-only integration must not modify HKCU':false,
},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'xh-archive-')),binary=join(temp,'fake-helper'),plugin=join(temp,'plugin'),home=join(temp,'home')
 let child
 try{
  await writeFile(binary,'NEVER EXECUTED: packaging fixture')
  const platform=process.platform+'-'+process.arch,output=join(temp,'artifacts')
  await promisify(execFile)(process.execPath,['scripts/package.mjs','--platform',platform,'--native',binary,'--output',output])
  const bytes=await readFile(join(output,`browser-extension-plugin-0.1.0-${platform}.zip`)),names=[]
  let at=0
  while(bytes.readUInt32LE(at)===0x04034b50){
   assert.equal(bytes.readUInt16LE(at+8),0,'only deterministic stored ZIP entries')
   const length=bytes.readUInt32LE(at+18),nameLength=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),name=bytes.subarray(at+30,at+30+nameLength).toString(),start=at+30+nameLength+extra
   assert.equal(name.includes('..'),false);assert.equal(name.startsWith('/'),false)
   const path=join(plugin,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes.subarray(start,start+length));names.push(name);at=start+length
  }
  for(const required of ['dist/extension-id.json','scripts/install-native.mjs','.mcp.json',`native/${platform}/xharness-browser-extension-host`])assert.ok(names.includes(required),required)
  await mkdir(home,{recursive:true})
  child=spawn(process.execPath,[join(plugin,'dist/native/mcp.js')],{env:{...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'config'),XHARNESS_BROWSER_CONTEXT_ID:'f'.repeat(64),XHARNESS_BROWSER_CONTEXT_LABEL:'Archive fixture'}})
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk)
  const reply=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error(stderr||'archive MCP timeout')),20000)
   createInterface({input:child.stdout}).once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line))})
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser',arguments:{action:'status'}}})+'\n')
  })
  const state=JSON.parse(reply.result.content[0].text)
  assert.equal(state.installation.installed,true,JSON.stringify(state));assert.equal(state.connected,false);assert.equal(state.contextId,'f'.repeat(64))
 }finally{if(child){child.stdin.end();await new Promise(resolve=>child.once('exit',resolve))}await rm(temp,{recursive:true,force:true})}
})
