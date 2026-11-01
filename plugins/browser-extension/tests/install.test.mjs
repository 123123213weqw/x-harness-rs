import test from 'node:test'
import assert from 'node:assert/strict'
import{mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{install,autoInstall,registrationTarget}from'../scripts/install-native.mjs'
test('enabled platform package automatically registers all user hosts and converges concurrently',{skip:process.platform==='win32'?'Isolated file registration only; never change runner HKCU in unit tests':false},async()=>{
 const home=await mkdtemp(join(tmpdir(),'xh-install-')),binary=join(home,'fixture-native'),xdg=join(home,'config')
 try{
  await writeFile(binary,'NOT EXECUTED: installer fixture')
  const options={binary,home,os:process.platform,arch:process.arch,xdg}
  const [a,b]=await Promise.all([autoInstall(options),autoInstall(options)])
  assert.equal(a.installed,true);assert.equal(b.installed,true);assert.equal(a.browsers.length,3)
  const first=await install({...options,browser:'chromium',register:true}),before=await stat(first.manifest.path)
  const again=await install({...options,browser:'chromium',register:true})
  assert.equal(again.manifest.path,first.manifest.path);assert.equal((await stat(first.manifest.path)).mtimeMs,before.mtimeMs)
  const snapshot=JSON.parse(await readFile(join(first.manifest.path,'..','launcher.json'),'utf8'))
  assert.equal(snapshot.node,process.execPath);assert.equal(snapshot.extension_id,first.extensionId)
  assert.deepEqual(first.manifest.allowed_origins,[`chrome-extension://${first.extensionId}/`])
  // Native binaries are never downloaded, and unrelated registrations are not overwritten.
  const target=registrationTarget(process.platform,'chromium',home,xdg)
  const manifest=target.manifest??again.manifestPath
  await writeFile(manifest,JSON.stringify({name:'unrelated',description:'other'}))
  await assert.rejects(install({...options,browser:'chromium',register:true}),/unrelated/)
 }finally{await rm(home,{recursive:true,force:true})}
})
test('native setup reports missing resources and rejects tampered snapshots',{skip:process.platform==='win32'?'Isolated file registration only; never change runner HKCU in unit tests':false},async()=>{
 const home=await mkdtemp(join(tmpdir(),'xh-install-invalid-')),binary=join(home,'fixture-native')
 try{
  assert.equal((await autoInstall({home,binary})).installed,false)
  await writeFile(binary,'NOT EXECUTED')
  const options={binary,home,browser:'chromium',register:true,xdg:join(home,'config')}
  const result=await install(options)
  await writeFile(result.manifest.path,'tampered')
  await assert.rejects(install(options),/digest mismatch/)
  await assert.rejects(install({...options,binary:'relative'}),/absolute/)
  if(process.platform!=='win32'){
   const link=join(home,'link');await symlink(binary,link)
   await assert.rejects(install({...options,binary:link}),/Invalid native launcher/)
  }
 }finally{await rm(home,{recursive:true,force:true})}
})
