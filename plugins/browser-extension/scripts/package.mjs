// Deterministic stored ZIPs, no platform archive tool or runtime packaging dependency.
import{readFile,writeFile,mkdir}from'node:fs/promises'
import{resolve,isAbsolute}from'node:path'
import{fileURLToPath}from'node:url'
import{createHash}from'node:crypto'
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]}
const out=resolve(option('--output')??resolve(root,'../../dist/browser-extension'))
function crc(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}return(value^0xffffffff)>>>0}
async function zip(entries){const local=[],central=[];let offset=0
 for(const[name,path]of entries){
  const body=await readFile(isAbsolute(path)?path:root+path),filename=Buffer.from(name),hash=crc(body),header=Buffer.alloc(30),record=Buffer.alloc(46)
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(hash,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26)
  record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(0x21,14);record.writeUInt32LE(hash,16);record.writeUInt32LE(body.length,20);record.writeUInt32LE(body.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42)
  local.push(header,filename,body);central.push(record,filename);offset+=header.length+filename.length+body.length
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
 return Buffer.concat([...local,directory,end])
}
const extensionFiles=['manifest.json','popup.html','popup.css','protocol.js','extension/background.js','extension/dom.js','extension/popup.js',...['16','32','48','128'].map(size=>`icons/icon${size}.png`)]
const pluginFiles=['scripts/install-native.mjs','.claude-plugin/plugin.json','.mcp.json','package.json','dist/extension-id.json','dist/native/mcp.js','dist/native/common.js','dist/native/host.js','dist/protocol.js']
const platform=option('--platform'),binary=option('--native')
const definitions=[['chrome-edge-extension-0.1.0.zip',extensionFiles.map(name=>[name,'dist/'+name])]]
if(!args.includes('--extension-only')){
 if(!['linux-x64','darwin-arm64','darwin-x64','win32-x64'].includes(platform)||!binary)throw Error('Complete plugin packaging requires --platform and --native (or explicit --extension-only)')
 const name='xharness-browser-extension-host'+(platform==='win32-x64'?'.exe':'')
 definitions.push([`browser-extension-plugin-0.1.0-${platform}.zip`,[...pluginFiles.map(name=>[name,name]),[`native/${platform}/${name}`,resolve(binary)]]])
}
await mkdir(out,{recursive:true});const artifacts=[]
for(const[file,entries]of definitions){const bytes=await zip(entries);await writeFile(resolve(out,file),bytes);artifacts.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
const identity=JSON.parse(await readFile(root+'dist/extension-id.json','utf8'))
await writeFile(resolve(out,'receipts.json'),JSON.stringify({...identity,artifacts,requires:'Node 20+ and Host conversation binding. Native launcher is bundled per platform; enabled MCP automatically registers it per user. Browser extension installation and site consent remain explicit.'},null,2)+'\n')
console.log(JSON.stringify({out,...identity,artifacts},null,2))
