/** Chrome owns this process. It only relays bounded structured commands to per-chat MCP clients. */
import {connect,type Socket} from 'node:net'
import {join} from 'node:path'
import {readdir,lstat} from 'node:fs/promises'
import {object,text,id,command,failure} from '../protocol.js'
import {framed,lines,nativeWrite,readPrivate,stateRoot,privateDirectory} from './common.js'

const clients=new Map<string,{socket:Socket;admitted:boolean}>()
const retryAfter=new Map<string,number>()
let scanning=false,ready=false,closed=false,scanOffset=0
const directory=join(stateRoot(),'clients')
async function scan():Promise<void> {
  if(scanning||!ready||closed)return
  scanning=true
  try{
    await privateDirectory(stateRoot());await privateDirectory(directory)
    const candidates=(await readdir(directory)).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).sort()
    // A crashed process can leave a registration. Rotate the bounded scan so
    // stale names cannot permanently hide newer live conversations.
    if(scanOffset>=candidates.length)scanOffset=0
    const names=candidates.slice(scanOffset,scanOffset+64);scanOffset+=names.length
    for(const name of names){
      if(clients.size>=16)break
      const key=name.slice(0,-5);if(clients.has(key)||Date.now()<(retryAfter.get(key)??0))continue
      try{
        const path=join(directory,name),stat=await lstat(path)
        if(Date.now()-stat.mtimeMs>24*60*60*1000)continue
        const entry=object(await readPrivate(path))
        if(entry.version!==2||id(entry.clientId)!==key||typeof entry.port!=='number'||!Number.isInteger(entry.port)||entry.port<1||entry.port>65535)continue
        const contextId=text(entry.contextId,64),contextLabel=text(entry.contextLabel,96);if(!/^[a-f0-9]{64}$/.test(contextId))continue
        const token=text(entry.token,64);if(!/^[a-f0-9]{64}$/.test(token))continue
        const socket=connect({host:'127.0.0.1',port:entry.port})
        const client={socket,admitted:false};clients.set(key,client)
        socket.setTimeout(3000,()=>{if(!client.admitted)socket.destroy()})
        socket.on('connect',()=>socket.write(JSON.stringify({token})+'\n'))
        socket.on('error',()=>socket.destroy())
        socket.on('close',()=>{clients.delete(key);if(retryAfter.size>=128)retryAfter.clear();retryAfter.set(key,Date.now()+15000);if(client.admitted)nativeWrite({type:'clientGone',clientId:key})})
        lines(socket,value=>{
          try{
            const message=object(value)
            if(!client.admitted){
              if(message.type!=='client'||message.clientId!==key||message.contextId!==contextId||message.contextLabel!==contextLabel)throw Error('Invalid client handshake')
              client.admitted=true;socket.setTimeout(0);nativeWrite({type:'client',clientId:key,contextId,contextLabel});return
            }
            if(message.type==='command')nativeWrite({type:'command',clientId:key,requestId:id(message.requestId),command:command(message.command)})
            else if(message.type==='cancel')nativeWrite({type:'cancel',clientId:key,requestId:id(message.requestId)})
            else throw Error('Invalid client message')
          }catch{socket.destroy()}
        },()=>socket.destroy())
      }catch{/* Stale or foreign registrations are not capabilities. */}
    }
  }finally{scanning=false}
}
function close():void {
  if(closed)return;closed=true;clearInterval(poll)
  for(const item of clients.values())item.socket.destroy()
  process.exit(0)
}
framed(process.stdin,value=>{
  try{
    const message=object(value)
    if(message.type==='hello'){
      if(message.version!==1||ready)throw Error('Invalid native handshake')
      ready=true;nativeWrite({type:'ready',version:1});void scan();return
    }
    if(!ready||message.type!=='result')throw Error('Unexpected native message')
    const key=id(message.clientId),requestId=id(message.requestId),client=clients.get(key)
    if(!client?.admitted)return
    const result=object(message.result)
    if(typeof result.ok!=='boolean')throw Error('Invalid browser result')
    client.socket.write(JSON.stringify({type:'result',requestId,result})+'\n')
  }catch(error){process.stderr.write((error instanceof Error?error.message:'Invalid bridge message')+'\n');close()}
},()=>close())
const poll=setInterval(()=>{void scan().catch(()=>{})},2000)
process.stdin.on('end',close);process.on('SIGTERM',close);process.on('SIGINT',close)
// stdout is reserved for native frames, including all failure paths.
process.on('uncaughtException',()=>close())
