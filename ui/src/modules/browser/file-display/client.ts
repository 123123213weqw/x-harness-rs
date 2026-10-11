import type {ClientConnectionRpc} from '../../client-connection/rpc-contracts'
import {DisplayFileSchema} from '../../shared/generated/file-display'
import type {DisplayFile,GitDiffScope} from '../../shared/generated/file-display'
export const MAX_IMAGE_BYTES=8*1024*1024
export const MAX_TEXT_BYTES=512*1024
export class FileDisplayClient {
  constructor(private readonly rpc:ClientConnectionRpc,private readonly external?:{available():boolean;open(path:string):Promise<void>}){}
  canOpenExternal(path:string):boolean{return this.external?.available()===true&&(path.startsWith('/')||/^[a-z]:[\\/]/i.test(path)||path.startsWith('\\\\'))}
  async openExternal(path:string):Promise<void>{if(!this.external||!this.canOpenExternal(path))throw new Error("System opener requires a resolved absolute path");await this.external.open(path)}
  async read(sessionId:string,path:string,signal:AbortSignal,relativeTo?:string,gitDiff?:GitDiffScope):Promise<DisplayFile>{
    const response=await this.rpc.call('/api','display/read',{sessionId,path,...relativeTo===undefined?{}:{relativeTo},...gitDiff===undefined?{}:{gitDiff}},AbortSignal.any([signal,AbortSignal.timeout(20000)]))
    if(!response.ok)throw new Error(response.error.message)
    const file=DisplayFileSchema.parse(response.value)
    if(file.path.length===0||file.path.length>4096)throw new Error('Invalid display path')
    if(file.kind==='image'){
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.mediaType)||file.width<1||file.height<1||file.width*file.height>16*1024*1024||file.dataBase64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||file.dataBase64.length%4!==0||!(/^[A-Za-z0-9+/]*={0,2}$/).test(file.dataBase64))throw new Error('Invalid or oversized preview image')
    }else if(file.text.length>MAX_TEXT_BYTES||new TextEncoder().encode(file.text).length>MAX_TEXT_BYTES||file.text.includes('\0'))throw new Error('Invalid or oversized preview text')
    return file
  }
}
export function localResource(raw:string):string|undefined{
  if(!raw||raw.startsWith('#')||raw.startsWith('//')||raw.includes('\0'))return undefined
  if(/^[a-z][a-z\d+.-]*:/i.test(raw)&&!(/^[a-z]:[\\/]/i.test(raw)))return undefined
  try{return decodeURIComponent(raw.split(/[?#]/)[0]??'')}catch{return undefined}
}
export function imageObjectUrl(file:Extract<DisplayFile,{kind:'image'}>):{url:string;bytes:number}{
  const binary=atob(file.dataBase64)
  if(binary.length===0||binary.length>MAX_IMAGE_BYTES)throw new Error('Invalid image byte length')
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0))
  return {url:URL.createObjectURL(new Blob([bytes],{type:file.mediaType})),bytes:bytes.length}
}
/** A single Markdown preview owns a bounded resource budget; no global cache. */
export class ResourceBudget {
  private count=0
  private bytes=0
  private decodedBytes=0
  admit():boolean {if(this.count>=8)return false;this.count++;return true}
  retain(bytes:number,decodedBytes=0):boolean {if(this.bytes+bytes>16*1024*1024||this.decodedBytes+decodedBytes>64*1024*1024)return false;this.bytes+=bytes;this.decodedBytes+=decodedBytes;return true}
}
export const codeLanguage=(path:string):string|undefined=>{
  const extension=path.split('.').at(-1)?.toLowerCase()??''
  const languages:Readonly<Record<string,string>>={rs:'rust',py:'python',js:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',json:'json',toml:'toml',yaml:'yaml',yml:'yaml',sh:'bash',css:'css',html:'html',c:'c',h:'c',cpp:'cpp',sql:'sql'}
  return languages[extension]
}
