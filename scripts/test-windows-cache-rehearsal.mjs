import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {validateRehearsal} from './windows-cache-rehearsal.mjs'
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_SHA:'a'.repeat(40),GITHUB_REPOSITORY:'fixture/repo',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'}
const stage={rehearsal_only:true,sha:env.GITHUB_SHA,repository:env.GITHUB_REPOSITORY,platform:'windows-x86_64',target:'x86_64-pc-windows-msvc',version:'0.0.902',base_version:'0.0.901',release_run_id:'123',release_run_attempt:'1',endpoint:'https://github.com/fixture/repo/releases/latest/download/latest.json',base_sha256:'b'.repeat(64),package_sha256:'c'.repeat(64),manifest_sha256:'d'.repeat(64)}
validateRehearsal(stage,env,'win32')
let cases=1
for(const patch of [{rehearsal_only:false},{sha:'e'.repeat(40)},{repository:'other/repo'},{platform:'darwin-aarch64'},{target:'x86_64-unknown-linux-gnu'},{version:'1.0.0'},{base_version:'0.0.900'},{release_run_id:'124'},{release_run_attempt:'2'},{endpoint:'http://evil.test'},{package_sha256:'invalid'}]){assert.throws(()=>validateRehearsal({...stage,...patch},env,'win32'));cases++}
for(const patch of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_SHA:'short'},{GITHUB_RUN_ID:'124'}]){assert.throws(()=>validateRehearsal(stage,{...env,...patch},'win32'));cases++}
assert.throws(()=>validateRehearsal(stage,env,'darwin'));cases++
const local=spawnSync(process.execPath,['scripts/windows-migration-acceptance.mjs','run'],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8'})
assert.notEqual(local.status,0);assert.match(local.stderr,/CI only/);cases++
const js=readFileSync('scripts/windows-migration-acceptance.mjs','utf8'),wf=readFileSync('.github/workflows/desktop-windows-cache-rehearsal.yml','utf8')
assert.ok(js.includes('nativeDirectLatest: cacheRehearsal ? false : directLatest'),'Formal promotion must reject rehearsal evidence')
assert.ok(js.includes('cachedTamperRejectedBeforeHostStop: true'))
assert.ok(js.includes('packageRequests(), before'))
assert.ok(wf.includes('persist-credentials: false'))
for(const forbidden of ['secrets.','contents: write','pull_request_target','ignoreHTTPSErrors','NODE_TLS_REJECT_UNAUTHORIZED'])assert.ok(!wf.includes(forbidden))
console.log(`${cases} Windows cache rehearsal provenance/isolation cases passed; no production release evidence claim.`)
