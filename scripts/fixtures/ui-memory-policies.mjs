// Experiment-only policies. No product bundle imports this module.
import {deflateSync} from 'node:zlib'
export class DecodedImageBudget {
 constructor(limit){if(!Number.isSafeInteger(limit)||limit<=0)throw Error('Invalid image budget');this.limit=limit;this.used=0;this.leases=0}
 reserve(width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||!Number.isSafeInteger(width*height*4))throw Error('Invalid image dimensions')
  const bytes=width*height*4
  if(bytes>this.limit-this.used)return null
  this.used+=bytes;this.leases++
  let active=true,published=false,dispose
  return {
   bytes,
   publish:cleanup=>{
    if(published)throw Error('Image lease already published')
    published=true
    if(!active){cleanup();return false}
    dispose=cleanup;return true
   },
   release:()=>{
    if(!active)return
    active=false;this.used-=bytes;this.leases--
    dispose?.()
   },
  }
 }
 get stats(){return {used:this.used,leases:this.leases,limit:this.limit}}
}
export function thumbnailSize(width,height,max=480){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(max)||max<1)throw Error('Invalid thumbnail dimensions')
 const scale=Math.min(1,max/Math.max(width,height))
 return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))}
}
const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0}
function chunk(name,bytes){const kind=Buffer.from(name),result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);kind.copy(result,4);bytes.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([kind,bytes])),bytes.length+8);return result}
/** Synthetic PNG fixtures only, never read/resize a user's image. */
export function syntheticPng(width,height,seed=1){
 const raw=Buffer.alloc((width*4+1)*height)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+x*4+1;raw[i]=(x+seed*31)%256;raw[i+1]=(y+seed*71)%256;raw[i+2]=(x+y+seed*17)%256;raw[i+3]=255}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}
