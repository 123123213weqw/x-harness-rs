import{cp,mkdir,readFile,writeFile}from'node:fs/promises'
import{createHash}from'node:crypto'
import{deflateSync}from'node:zlib'
import{fileURLToPath}from'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await readFile(root+'extension/manifest.json','utf8'))
const metadata=JSON.parse(await readFile(root+'.claude-plugin/plugin.json','utf8')),pkg=JSON.parse(await readFile(root+'package.json','utf8'))
if(manifest.version!==pkg.version||metadata.version!==pkg.version)throw Error('Extension, plugin and package versions must match')
await mkdir(root+'dist/icons',{recursive:true});await cp(root+'extension',root+'dist',{recursive:true})
// Original code-native cursor glyph. Rasterize at 4x; no third-party image or icon dependency.
function crc(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}return(value^0xffffffff)>>>0}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum])}
const polygon=[[.25,.14],[.79,.53],[.57,.58],[.69,.82],[.54,.89],[.42,.65],[.27,.82]]
function inside(x,y){let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const[a,b]=polygon[i],[c,d]=polygon[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)yes=!yes}return yes}
for(const size of[16,32,48,128]){
 const raw=Buffer.alloc(size*(size*4+1));for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  let r=0,g=0,b=0,a=0;for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
   const px=(x+(sx+.5)/4)/size,py=(y+(sy+.5)/4)/size,mark=inside(px,py),circle=(px-.53)**2+(py-.53)**2<.38**2
   const color=mark?[35,31,43,255]:circle?[219,199,252,255]:[0,0,0,0];r+=color[0];g+=color[1];b+=color[2];a+=color[3]
  }const at=y*(size*4+1)+1+x*4;raw.set([r/16,g/16,b/16,a/16],at)
 }const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6
 await writeFile(root+`dist/icons/icon${size}.png`,Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]))
}
const hash=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
const extensionId=[...hash].map(char=>String.fromCharCode(97+parseInt(char,16))).join('')
await writeFile(root+'dist/extension-id.json',JSON.stringify({extensionId})+'\n');console.log('Built XHarness Browser extension:',extensionId)
