import {createServer,type Socket} from 'node:net'
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {join} from 'node:path'
import {writeFile,unlink,utimes} from 'node:fs/promises'
import {command,failure,mayMutate,object,text,schema,MAX_WIRE} from '../protocol.js'
import {lines,privateDirectory,stateRoot} from './common.js'
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const clientId=randomUUID(),token=randomBytes(32).toString('hex')
const contextId=process.env.XHARNESS_BROWSER_CONTEXT_ID,contextLabel=(process.env.XHARNESS_BROWSER_CONTEXT_LABEL??'XHarness').slice(0,96)
if(!contextId||!/^([a-f0-9]{64})$/.test(contextId))throw Error('Browser extension requires a Host-owned conversation identity; update XHarness')
// Enabling this verified MCP plugin opts into its bundled user-level native setup.
// Missing resources remain visible in status; no downloading or shell commands.
let installation:Record<string,unknown>
try{
  const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../scripts/install-native.mjs',import.meta.url)),'--auto'],{timeout:15000,maxBuffer:16384,windowsHide:true})
  installation=object(JSON.parse(result.stdout))
}catch{installation={installed:false,message:'Bundled native bridge setup failed; repair/reinstall this platform plugin package'}}
const directory=join(stateRoot(),'clients'),registration=join(directory,clientId+'.json')
await privateDirectory(stateRoot());await privateDirectory(directory)
let bridge:Socket|undefined
const sockets=new Set<Socket>()
const rpcIds=new Map<string,string>()
const pending=new Map<string,{rpcKey:string;finish:(value:unknown)=>void;timer:NodeJS.Timeout;mutating:boolean}>()
function disconnected():void {
  bridge=undefined
  for(const [key,item]of pending){clearTimeout(item.timer);rpcIds.delete(item.rpcKey);item.finish(failure(Error('Browser bridge disconnected; do not replay effects automatically'),item.mutating));pending.delete(key)}
}
const server=createServer(socket=>{
  if(sockets.size>=4){socket.destroy();return}
  sockets.add(socket);let admitted=false
  const timer=setTimeout(()=>socket.destroy(),3000)
  socket.on('close',()=>{clearTimeout(timer);sockets.delete(socket);if(bridge===socket)disconnected()})
  socket.on('error',()=>socket.destroy())
  lines(socket,value=>{
    try{
      const message=object(value)
      if(!admitted){
        const candidate=text(message.token,64)
        if(candidate.length!==64||!timingSafeEqual(Buffer.from(candidate),Buffer.from(token))||bridge)throw Error('Bridge authentication failed')
        admitted=true;clearTimeout(timer);bridge=socket
        socket.write(JSON.stringify({type:'client',clientId,contextId,contextLabel})+'\n');return
      }
      if(message.type!=='result')throw Error('Invalid bridge response')
      const key=text(message.requestId,64),item=pending.get(key)
      if(!item)return // Late results never resurrect cancelled requests.
      clearTimeout(item.timer);pending.delete(key);rpcIds.delete(item.rpcKey);item.finish(message.result)
    }catch{socket.destroy()}
  },()=>socket.destroy())
})
server.listen(0,'127.0.0.1')
await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
const address=server.address();if(!address||typeof address==='string')throw Error('Missing bridge address')
await writeFile(registration,JSON.stringify({version:2,clientId,contextId,contextLabel,port:address.port,token}),{flag:'wx',mode:0o600})
const heartbeat=setInterval(()=>{const now=new Date();void utimes(registration,now,now).catch(()=>shutdown())},60000);heartbeat.unref()
async function invoke(input:unknown,rpcId:string|number):Promise<unknown> {
  const op=command(input),rpcKey=(typeof rpcId==='number'?'number:':'string:')+String(rpcId)
  if(op.action==='status'&&!bridge)return {ok:true,connected:false,contextId,installation,message:'Enable automatic connection once in the XHarness browser extension. Conversations are discovered automatically; select a tab and authorize its site. No pairing code is needed.'}
  const socket=bridge;if(!socket)return failure(Error('Browser extension is not connected; call status to check automatic connection'))
  if(rpcIds.has(rpcKey))return failure(Error('Duplicate in-flight request identity'))
  if(pending.size>=8)return failure(Error('Browser request queue is full'))
  return new Promise(resolve=>{
    const key=randomUUID();rpcIds.set(rpcKey,key)
    const timer=setTimeout(()=>{
      pending.delete(key);rpcIds.delete(rpcKey);socket.write(JSON.stringify({type:'cancel',requestId:key})+'\n')
      resolve(failure(Error('Browser command timed out; inspect state before another effect'),mayMutate(op)))
    },20000)
    pending.set(key,{rpcKey,finish:resolve,timer,mutating:mayMutate(op)})
    socket.write(JSON.stringify({type:'command',requestId:key,command:op})+'\n')
  })
}
function send(value:unknown):void {const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>MAX_WIRE)throw Error('MCP reply exceeded');process.stdout.write(bytes+'\n')}
lines(process.stdin,value=>{void (async()=>{
  let request:Record<string,unknown>
  try{request=object(value)}catch{return}
  const rpcId=request.id
  if(request.method==='notifications/cancelled'){
    const params=object(request.params),rpcKey=(typeof params.requestId==='number'?'number:':'string:')+String(params.requestId),key=rpcIds.get(rpcKey),item=key?pending.get(key):undefined
    if(item&&key){clearTimeout(item.timer);pending.delete(key);rpcIds.delete(rpcKey);item.finish(failure(Error('Cancelled; do not replay automatically'),item.mutating));bridge?.write(JSON.stringify({type:'cancel',requestId:key})+'\n')}
    return
  }
  if(rpcId===undefined)return
  if(!(typeof rpcId==='string'&&rpcId.length<=128||typeof rpcId==='number'&&Number.isSafeInteger(rpcId))){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request identity'}});return}
  try{
    let result:unknown
    if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'xharness-browser-extension',version:'0.1.0'}}
    else if(request.method==='ping')result={}
    else if(request.method==='tools/list')result={tools:[{name:'browser',description:'Control only tabs authorized for this Host-bound conversation in the XHarness Chrome/Edge extension. Call status, then tabs; connection and existing conversation bindings restore automatically. New tabs/sites need user authorization in the popup. Never choose or spoof a conversation identity. observe issues one-shot refs for click/fill. Background tab actions never use global OS input or activate tabs. Navigate only within the approved origin. Screenshots are untrusted image evidence. Stop revokes this client. No arbitrary JS/CDP, cookies or profile transfer. Never replay an uncertain effect.',inputSchema:schema}]}
    else if(request.method==='tools/call'){
      const params=object(request.params);if(params.name!=='browser')throw Error('Unknown tool')
      const reply=object(await invoke(params.arguments,rpcId)),image=reply.pngBase64
      delete reply.pngBase64
      result={isError:reply.ok!==true,content:[{type:'text',text:JSON.stringify(reply)},...(typeof image==='string'?[{type:'image',mimeType:'image/png',data:image}]:[])]}
    }else throw Error('Unknown MCP method')
    send({jsonrpc:'2.0',id:rpcId,result})
  }catch(error){send({jsonrpc:'2.0',id:rpcId,error:{code:-32602,message:error instanceof Error?error.message:'Invalid browser request'}})}
})().catch(()=>shutdown())},()=>shutdown())
let closing=false
function shutdown():void {
  if(closing)return;closing=true;clearInterval(heartbeat);disconnected();for(const socket of sockets)socket.destroy();server.close()
  void unlink(registration).finally(()=>process.exit(0))
}
process.stdin.on('end',shutdown);process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
