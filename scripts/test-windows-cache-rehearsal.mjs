import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {validateRehearsal} from './windows-cache-rehearsal.mjs'
import {attachmentState,preparationAction,UpdatePreparationError} from './native-desktop-attachment.mjs'
import {currentInstallation} from './native-update-installation.mjs'
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_SHA:'a'.repeat(40),GITHUB_REPOSITORY:'fixture/repo',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'}
const stage={rehearsal_only:true,sha:env.GITHUB_SHA,repository:env.GITHUB_REPOSITORY,platform:'windows-x86_64',target:'x86_64-pc-windows-msvc',version:'0.0.902',base_version:'0.0.901',release_run_id:'123',release_run_attempt:'1',endpoint:'https://github.com/fixture/repo/releases/latest/download/latest.json',base_sha256:'b'.repeat(64),package_sha256:'c'.repeat(64),manifest_sha256:'d'.repeat(64)}
validateRehearsal(stage,env,'win32')
let cases=1
for(const patch of [{rehearsal_only:false},{sha:'e'.repeat(40)},{repository:'other/repo'},{platform:'darwin-aarch64'},{target:'x86_64-unknown-linux-gnu'},{version:'1.0.0'},{base_version:'0.0.900'},{release_run_id:'124'},{release_run_attempt:'2'},{endpoint:'http://evil.test'},{package_sha256:'invalid'}]){assert.throws(()=>validateRehearsal({...stage,...patch},env,'win32'));cases++}
for(const patch of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_SHA:'short'},{GITHUB_RUN_ID:'124'}]){assert.throws(()=>validateRehearsal(stage,{...env,...patch},'win32'));cases++}
assert.throws(()=>validateRehearsal(stage,env,'darwin'));cases++
const local=spawnSync(process.execPath,['scripts/windows-migration-acceptance.mjs','run'],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8'})
assert.notEqual(local.status,0);assert.match(local.stderr,/CI only/);cases++
const healthy={version:'0.0.902',hostRunning:true,updaterConfigured:true,startup:{hostReadyMs:90,frontendHydratedMs:100,firstFrameMs:110}}
for(const [status,hydration,want] of [
 [healthy,true,{ready:true,retired:false}],
 [healthy,false,{ready:true,retired:false}],
 [{...healthy,startup:{hostReadyMs:90,frontendHydratedMs:null,firstFrameMs:null}},true,{ready:false,retired:false}],
 [{...healthy,startup:undefined},false,{ready:true,retired:false}],
 [{...healthy,version:'0.0.901'},true,{ready:false,retired:false}],
 [{...healthy,version:'0.0.901',hostRunning:false},true,{ready:false,retired:true}],
 [{...healthy,hostRunning:false},true,{ready:false,retired:false}],
]){assert.deepEqual(attachmentState('0.0.902',status,hydration),want);cases++}
for(const hostReadyMs of [null,undefined,-1,NaN,Infinity,'90']){
 for(const hydration of [false,true]){
  const status={...healthy,startup:{...healthy.startup,hostReadyMs}}
  assert.deepEqual(attachmentState('0.0.902',status,hydration),{ready:false,retired:false});cases++
 }
}
for(const hydration of [false,true]){
 assert.deepEqual(attachmentState('0.0.902',{...healthy,startupError:'restore failed'},hydration),{ready:false,retired:false});cases++
 assert.deepEqual(attachmentState('0.0.902',{...healthy,startup:{...healthy.startup,hostReadyMs:0}},hydration),{ready:true,retired:false});cases++
}
// Replay the production failure: matching version + live Host during restore
// must not reach the first session RPC, even when hydration is not required.
const restoring={...healthy,startup:{hostReadyMs:null,frontendHydratedMs:null,firstFrameMs:null}}
const productReady={...healthy,startup:{hostReadyMs:90,frontendHydratedMs:null,firstFrameMs:null}}
const restoreSequence=[restoring,restoring,productReady]
assert.equal(restoreSequence.findIndex(status=>attachmentState('0.0.902',status,false).ready),2);cases++
assert.equal(restoreSequence.some(status=>attachmentState('0.0.902',status,true).ready),false);cases++
const target='0.0.902'
const snapshot=(phase,extra={})=>({phase,version:target,...extra})
for(const [state,options,want] of [
 [snapshot('idle'),{},'check'],
 [snapshot('up-to-date'),{},'check'],
 [snapshot('checking',{version:null}),{},'wait'],
 [snapshot('available'),{},'download'],
 [snapshot('downloading'),{},'wait'],
 [snapshot('downloaded'),{},'ready'],
 [snapshot('downloading'),{corrupt:true},'wait'],
 [snapshot('error',{retryAction:'download'}),{corrupt:true,corruptRequestSeen:true},'rejected'],
 [snapshot('error',{retryAction:'download'}),{retryRejected:true},'download'],
]){assert.equal(preparationAction(target,state,options),want);cases++}
for(const [state,options] of [
 [undefined,{}],
 [snapshot('downloaded'),{corrupt:true,corruptRequestSeen:true}],
 [snapshot('error',{retryAction:'download'}),{corrupt:true}],
 [snapshot('error',{retryAction:'check'}),{corrupt:true,corruptRequestSeen:true}],
 [snapshot('error',{retryAction:'download'}),{}],
 [snapshot('downloaded',{version:'9.9.9'}),{}],
 [snapshot('error',{version:'9.9.9',retryAction:'download'}),{corrupt:true,corruptRequestSeen:true}],
 [snapshot('installing'),{}],
 [snapshot('stopping-host'),{}],
]){assert.throws(()=>preparationAction(target,state,options),UpdatePreparationError);cases++}
// Background download can make "available" entirely unobservable. Do not issue
// another check while busy or reset a completed verified download.
assert.deepEqual(['checking','downloading','downloaded'].map(phase=>preparationAction(target,snapshot(phase))),['wait','wait','ready']);cases++
// An elevated hosted runner requires an explicit current-directory choice.
// A failed advertised preflight is never converted into a legacy fallback.
const ownedDirectory='D:\\a\\_temp\\XHarnessMigration'
const plan={needsChoice:true,currentDirectory:ownedDirectory,userDirectory:'C:\\Users\\runner\\AppData\\Local\\Programs\\XHarness',migrationAvailable:false}
const capable={...healthy,updatePreflightSupported:true}
for(const needsChoice of [true,false]) {
 const commands=[]
 const actual=await currentInstallation(async command=>{commands.push(command);return {...plan,needsChoice}},capable,ownedDirectory,true)
 assert.deepEqual(commands,['desktop_update_preflight'])
 assert.deepEqual(actual.args,{confirmStop:true,placement:'current'})
 assert.equal(actual.plan.needsChoice,needsChoice);cases++
}
for(const patch of [{currentDirectory:'C:\\Unrelated'},{currentDirectory:'relative'},{currentDirectory:'D:\\a\\_temp\\other\\..\\XHarnessMigration'},{needsChoice:'true'},{migrationAvailable:null}]) {
 await assert.rejects(()=>currentInstallation(async()=>({...plan,...patch}),capable,ownedDirectory,true),UpdatePreparationError);cases++
}
for(const owned of ['relative','D:\\']) {
 await assert.rejects(()=>currentInstallation(async()=>plan,capable,owned,true),UpdatePreparationError);cases++
}
const nativeError=new Error('Native permission inspection failed')
await assert.rejects(()=>currentInstallation(async()=>{throw nativeError},capable,ownedDirectory,true),error=>error===nativeError);cases++
for(const updatePreflightSupported of [undefined,false]) {
 const legacy={...healthy,updatePreflightSupported}
 let called=false
 const invoke=async()=>{called=true;throw Error('Legacy command must not be called')}
 assert.deepEqual(await currentInstallation(invoke,legacy,ownedDirectory),{plan:null,args:{confirmStop:true,placement:'current'}})
 assert.equal(called,false)
 await assert.rejects(()=>currentInstallation(invoke,legacy,ownedDirectory,true),/requires native installation preflight/);cases++
}
await assert.rejects(()=>currentInstallation(async()=>plan,{...healthy,updatePreflightSupported:'true'},ownedDirectory),/Invalid native installation preflight capability/);cases++
const js=readFileSync('scripts/windows-migration-acceptance.mjs','utf8'),wf=readFileSync('.github/workflows/desktop-windows-cache-rehearsal.yml','utf8')
assert.equal((js.match(/invoke\(page, 'desktop_install_update', choice[.]args\)/g)||[]).length,2,'Both tamper and actual install must use explicit verified placement')
assert.ok(js.includes("{ ...choice.args, confirmStop: false }"),'Consent refusal must not accidentally test missing placement')
assert.equal((js.match(/invoke\(page, 'desktop_install_update', \{ confirmStop: true \}\)/g)||[]).length,1,'Only the intentional missing-choice negative case omits placement')
for(const fragment of ['beforeRejected','Missing choice changed Host, package or retained data','Tamper must reach cache-integrity verification','invalidated.retryAction, \'download\''])assert.ok(js.includes(fragment))
assert.ok(js.includes('nativeDirectLatest: cacheRehearsal ? false : directLatest'),'Formal promotion must reject rehearsal evidence')
assert.ok(js.includes('cachedTamperRejectedBeforeHostStop: true'))
assert.ok(js.includes('packageRequests(), before'))
assert.ok(js.includes('let rejectPackage = !probeOnly'),'Corrupt fixture must be armed before native startup')
assert.ok(js.includes('assert.ok(corruptPackageRejected'),'PASS requires observed rejection, not a hard-coded flag')
assert.ok(js.includes('if (error instanceof UpdatePreparationError) throw error'),'Invalid candidate/verification state must fail immediately')
assert.ok(js.includes("'update-samples.json'"),'Preserve native updater phase/progress evidence')
assert.ok(wf.includes('persist-credentials: false'))
assert.ok(wf.includes("m.prepare_base_ui(pathlib.Path('ui/dist'))"), 'Disposable Windows UI must refresh only verified instrumentation assets')
for(const forbidden of ['secrets.','contents: write','pull_request_target','ignoreHTTPSErrors','NODE_TLS_REJECT_UNAUTHORIZED'])assert.ok(!wf.includes(forbidden))
console.log(`${cases} Windows cache rehearsal provenance/isolation cases passed; no production release evidence claim.`)
