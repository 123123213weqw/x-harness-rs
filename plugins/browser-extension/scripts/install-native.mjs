// Explicit per-user installation only. Without --register this prints a plan and changes nothing.
import{readFile,mkdir,writeFile,copyFile,cp,chmod,lstat,rename,realpath,mkdtemp,rm}from'node:fs/promises'
import{homedir,platform}from'node:os'
import{resolve,join,isAbsolute,posix,win32}from'node:path'
import{fileURLToPath}from'node:url'
import{execFileSync}from'node:child_process'
import{createHash}from'node:crypto'
import{privateDirectory}from'../dist/native/common.js'
const root=fileURLToPath(new URL('../',import.meta.url))
export function registrationTarget(os,browser,home,xdg=posix.join(home,'.config')){
 const join=posix.join
 if(!['chrome','chromium','edge'].includes(browser))throw Error('Choose chrome, chromium or edge')
 if(os==='win32')return {registry:`HKCU\\Software\\${browser==='edge'?'Microsoft\\Edge':browser==='chrome'?'Google\\Chrome':'Chromium'}\\NativeMessagingHosts\\com.xharness.browser_bridge`}
 const base=os==='darwin'?join(home,'Library','Application Support',browser==='edge'?'Microsoft Edge':browser==='chrome'?'Google/Chrome':'Chromium'):join(xdg,browser==='edge'?'microsoft-edge':browser==='chrome'?'google-chrome':'chromium')
 if(!['darwin','linux'].includes(os))throw Error('Unsupported platform')
 return {manifest:join(base,'NativeMessagingHosts','com.xharness.browser_bridge.json')}
}
export async function install({binary,browser='chrome',register=false,home=homedir(),os=platform(),xdg=process.env.XDG_CONFIG_HOME,node=process.execPath}={}){
 const {extensionId}=JSON.parse(await readFile(root+'dist/extension-id.json','utf8'))
 const planJoin=os==='win32'?win32.join:posix.join
 const runtime=planJoin(home,'.xharness','browser-extension','native'),target=registrationTarget(os,browser,home,xdg)
 const launcher=planJoin(runtime,os==='win32'?'xharness-browser-extension-host.exe':'xharness-browser-extension-host')
 const manifest={name:'com.xharness.browser_bridge',description:'XHarness browser extension bridge',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]}
 const manifestPath=target.manifest??join(runtime,'native-manifest.json')
 if(!register)return {...target,extensionId,manifest,manifestPath,requires:'Explicit --register and an absolute native launcher binary; no installation performed'}
 if(os!==platform())throw Error('Cannot register a different operating system')
 if(!binary||!isAbsolute(binary))throw Error('--binary must be an absolute native launcher path')
 const metadata=await lstat(binary);if(!metadata.isFile()||metadata.isSymbolicLink())throw Error('Invalid native launcher')
 await privateDirectory(planJoin(home,'.xharness','browser-extension'));await privateDirectory(runtime)
 const directory=await lstat(runtime);if(directory.isSymbolicLink()||os!=='win32'&&(directory.mode&0o077)!==0)throw Error('Native runtime directory must be private')
 let previous
 try{previous=JSON.parse(await readFile(manifestPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 if(previous&&(previous.name!==manifest.name||previous.description!==manifest.description))throw Error('Refusing to replace an unrelated native messaging host')
 // Snapshot runtime files by digest. Existing sessions keep their original files.
 const bytes=await readFile(binary),hash=createHash('sha256').update(bytes).update(await realpath(node)).update(extensionId)
 for(const file of ['native/host.js','native/common.js','native/mcp.js','protocol.js'])hash.update(await readFile(root+'dist/'+file))
 const digest=hash.digest('hex').slice(0,16)
 const version=join(runtime,digest)
 const executable=join(version,os==='win32'?'xharness-browser-extension-host.exe':'xharness-browser-extension-host')
 const config={version:1,extension_id:extensionId,node:await realpath(node),script:join(version,'native','host.js')}
 // Immutable snapshots: do not overwrite an executable held by a live browser,
 // and allow concurrent chat startups to converge on the same verified snapshot.
 const validSnapshot=async()=>{
  const info=await lstat(version);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid native snapshot')
  if(!Buffer.from(await readFile(executable)).equals(bytes))throw Error('Native snapshot digest mismatch')
  if(JSON.stringify(JSON.parse(await readFile(join(version,'launcher.json'),'utf8')))!==JSON.stringify(config))throw Error('Native snapshot configuration changed')
  for(const file of ['native/host.js','native/common.js','native/mcp.js','protocol.js'])if(!Buffer.from(await readFile(join(version,file))).equals(await readFile(root+'dist/'+file)))throw Error('Native snapshot code changed')
 }
 try{await validSnapshot()}catch(error){
  if(error.code!=='ENOENT')throw error
  const temporary=await mkdtemp(join(runtime,'.stage-'))
  try{
   await copyFile(binary,join(temporary,os==='win32'?'xharness-browser-extension-host.exe':'xharness-browser-extension-host'));await chmod(join(temporary,os==='win32'?'xharness-browser-extension-host.exe':'xharness-browser-extension-host'),0o700)
   await cp(root+'dist/native',join(temporary,'native'),{recursive:true});await copyFile(root+'dist/protocol.js',join(temporary,'protocol.js'))
   await writeFile(join(temporary,'package.json'),' {"type":"module"}\n',{mode:0o600})
   await writeFile(join(temporary,'launcher.json'),JSON.stringify(config)+'\n',{mode:0o600})
   try{await rename(temporary,version)}catch(collision){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(collision.code))throw collision;await validSnapshot()}
  }finally{await rm(temporary,{recursive:true,force:true})}
 }
 manifest.path=executable
 await mkdir(resolve(manifestPath,'..'),{recursive:true,mode:0o700})
 if(previous&&JSON.stringify(previous)===JSON.stringify(manifest)&&!target.registry)return {...target,extensionId,manifest,manifestPath,installed:true,unchanged:true}
 const temporary=manifestPath+'.tmp-'+process.pid+'-'+createHash('sha256').update(String(Math.random())).digest('hex').slice(0,12)
 await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,manifestPath)
 if(target.registry)execFileSync('reg.exe',['ADD',target.registry,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{stdio:'pipe',windowsHide:true})
 return {...target,extensionId,manifest,manifestPath,installed:true}
}
/** Called only by the enabled, Host-bound MCP process with a platform package. */
export async function autoInstall({home=homedir(),os=platform(),arch=process.arch,binary=resolve(root,'native',`${os}-${arch}`,os==='win32'?'xharness-browser-extension-host.exe':'xharness-browser-extension-host'),xdg=process.env.XDG_CONFIG_HOME}={}){
 if(!['linux-x64','darwin-arm64','darwin-x64','win32-x64'].includes(`${os}-${arch}`))return {installed:false,message:'Unsupported browser bridge platform'}
 try{await lstat(binary)}catch(error){if(error.code==='ENOENT')return {installed:false,message:'This development package has no bundled native launcher; install the matching platform plugin archive'};throw error}
 const browsers=[]
 for(const browser of ['chrome','chromium','edge'])browsers.push(await install({binary,browser,register:true,home,os,xdg}))
 return {installed:true,browsers:browsers.map(item=>({browser:item.registry??item.manifestPath,unchanged:item.unchanged===true}))}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1]}
 console.log(JSON.stringify(args.includes('--auto')?await autoInstall():await install({binary:option('--binary'),browser:option('--browser'),register:args.includes('--register')}),null,2))
}
