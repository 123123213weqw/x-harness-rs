import {homedir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {lstat,mkdir,open} from 'node:fs/promises'
import type {Readable} from 'node:stream'
import {MAX_WIRE} from '../protocol.js'
const protectedWindowsDirectories=new Set<string>()
function protectWindowsDirectory(path:string):void {
  if(protectedWindowsDirectories.has(path))return
  // Fixed, non-interpolated script: paths travel in a child-only environment value.
  const script=`$ErrorActionPreference='Stop';
$path=$env:XHARNESS_BRIDGE_ACL_PATH;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));
Set-Acl -LiteralPath $path -AclObject $acl;`
  execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,XHARNESS_BRIDGE_ACL_PATH:path},windowsHide:true,timeout:10000,stdio:'pipe'})
  protectedWindowsDirectories.add(path)
}
export function stateRoot():string {return join(homedir(),'.xharness','browser-extension')}
export async function privateDirectory(path:string):Promise<void> {
  await mkdir(path,{recursive:true,mode:0o700})
  const info=await lstat(path)
  if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.())))throw Error('Bridge directory must be private and not a symlink')
  if(process.platform==='win32')protectWindowsDirectory(path)
}
export async function readPrivate(path:string):Promise<unknown> {
  const info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096||(process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.())))throw Error('Invalid bridge registration')
  const file=await open(path,'r')
  try {
    const actual=await file.stat()
    if(actual.ino!==info.ino||actual.dev!==info.dev||actual.size>4096)throw Error('Bridge registration changed')
    return JSON.parse(await file.readFile('utf8'))
  } finally {await file.close()}
}
/** A frame is not interpreted until its bounded body is complete. */
export function framed(input:Readable,onMessage:(value:unknown)=>void,onError:(error:Error)=>void):void {
  let pending=Buffer.alloc(0),expected=0,failed=false
  input.on('data',(chunk:Buffer)=>{
    if(failed)return
    try {
      pending=Buffer.concat([pending,chunk])
      for(;;){
        if(expected===0){if(pending.length<4)break;expected=pending.readUInt32LE();pending=pending.subarray(4);if(expected===0||expected>MAX_WIRE)throw Error('Invalid native message length')}
        if(pending.length<expected)break
        const body=pending.subarray(0,expected);pending=pending.subarray(expected);expected=0
        onMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)))
      }
      if(pending.length>MAX_WIRE)throw Error('Native message buffer exceeded')
    }catch(error){failed=true;onError(error instanceof Error?error:Error('Invalid native frame'))}
  })
  input.on('end',()=>{if(!failed&&(expected!==0||pending.length))onError(Error('Truncated native message'))})
}
export function nativeWrite(value:unknown):void {
  const bytes=Buffer.from(JSON.stringify(value))
  // Chrome limits native-host -> extension messages to 1 MiB.
  if(bytes.length>1024*1024)throw Error('Native outbound message exceeded')
  const length=Buffer.alloc(4);length.writeUInt32LE(bytes.length)
  process.stdout.write(Buffer.concat([length,bytes]))
}
export function lines(input:Readable,onMessage:(value:unknown)=>void,onError:(error:Error)=>void):void {
  let pending=Buffer.alloc(0),failed=false
  input.on('data',(chunk:Buffer)=>{
    if(failed)return
    try{
      pending=Buffer.concat([pending,chunk]);let end:number
      while((end=pending.indexOf(10))!==-1){
        if(end>MAX_WIRE)throw Error('Bridge line exceeded')
        const body=pending.subarray(0,end);pending=pending.subarray(end+1)
        if(body.length)onMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)))
      }
      if(pending.length>MAX_WIRE)throw Error('Bridge line exceeded')
    }catch(error){failed=true;onError(error instanceof Error?error:Error('Invalid bridge line'))}
  })
}
