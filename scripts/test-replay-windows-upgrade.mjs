import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {validateReplaySource,validateReplayJobs,validateReplayPlan} from './replay-windows-upgrade.mjs'

const identity={repository:'owner/repo',runId:'123',sourceSha:'a'.repeat(40),version:'0.2.50'}
const run={id:123,head_repository:{full_name:'owner/repo'},path:'.github/workflows/desktop-release.yml',status:'completed',conclusion:'failure',event:'workflow_dispatch',head_branch:'desktop-v0.2.50',head_sha:identity.sourceSha,run_attempt:1}
let cases=0
validateReplaySource(run,identity);cases++
validateReplaySource({...run,conclusion:'success'},identity);cases++
for(const patch of [{id:124},{head_repository:{full_name:'other/repo'}},{path:'.github/workflows/ci.yml'},{status:'in_progress'},{conclusion:'cancelled'},{event:'pull_request'},{head_branch:'master'},{head_sha:'b'.repeat(40)},{run_attempt:0},{run_attempt:1.5}]){
  assert.throws(()=>validateReplaySource({...run,...patch},identity));cases++
}
for(const patch of [{runId:'123; command'},{sourceSha:'HEAD'},{version:'0.02.50'},{repository:'owner/repo/extra'}]){
  assert.throws(()=>validateReplaySource(run,{...identity,...patch}));cases++
}
const jobs=['plan','aggregate','Signed windows-x86_64 candidate','Signed darwin-aarch64 candidate','Signed darwin-x86_64 candidate','Signed linux-x86_64-appimage candidate'].map(name=>({name,status:'completed',conclusion:'success',steps:[]}))
const windows=jobs.find(job=>job.name==='Signed windows-x86_64 candidate')
windows.conclusion='failure'
windows.steps=[
  {name:'Build and sign desktop bundle (artifacts only)',conclusion:'success'},
  {name:'Verify architecture, embedded channel, updater signature and declared Mac code-signing policy',conclusion:'success'},
  {name:'Windows real installer ownership and crash cleanup acceptance',conclusion:'success'},
  {name:'Exact Windows one-hop update and data preservation',conclusion:'failure'},
]
validateReplayJobs(jobs);cases++
for(const mutate of [
  rows=>rows.pop(),rows=>rows.push(structuredClone(rows[0])),
  rows=>{rows[1].conclusion='failure'},rows=>{rows[0].status='in_progress'},
  rows=>{rows[2].conclusion='cancelled'},
  rows=>{rows[2].steps[3].name='Unrelated build failure'},
  rows=>{rows[2].steps[0].conclusion='failure'},
  rows=>{rows[2].steps[2].conclusion='skipped'},
]){const copy=structuredClone(jobs);mutate(copy);assert.throws(()=>validateReplayJobs(copy));cases++}
const plan={repository:identity.repository,sha:identity.sourceSha,version:identity.version,tag:run.head_branch,release_run_id:'123',release_run_attempt:'1',acceptance_mode:'in-build',endpoint:'https://github.com/owner/repo/releases/latest/download/latest.json'}
validateReplayPlan(plan,run,identity);cases++
for(const patch of [{repository:'other/repo'},{sha:'b'.repeat(40)},{version:'0.2.49'},{tag:'desktop-v0.2.49'},{release_run_id:'124'},{release_run_attempt:'2'},{acceptance_mode:undefined},{endpoint:'https://evil.test/latest.json'}]){
  assert.throws(()=>validateReplayPlan({...plan,...patch},run,identity));cases++
}
const local=spawnSync(process.execPath,[fileURLToPath(new URL('./replay-windows-upgrade.mjs',import.meta.url)),'stage'],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8'})
assert.notEqual(local.status,0);assert.match(local.stderr,/CI only/);cases++
const workflow=readFileSync(new URL('../.github/workflows/installer-process-probe.yml',import.meta.url),'utf8')
const source=readFileSync(new URL('./replay-windows-upgrade.mjs',import.meta.url),'utf8')
assert.ok(workflow.includes('name: windows-upgrade-replay'))
assert.ok(workflow.includes('contents: read')&&workflow.includes('actions: read'))
for(const forbidden of ['contents: write','pull_request_target','PRIVATE_KEY','secrets.','cargo build','cargo test','cargo check'])assert.ok(!workflow.includes(forbidden));cases++
assert.ok(source.includes(".state,'disabled_manually'"))
assert.ok(source.includes("c['validate_release']"))
assert.ok(source.includes('releaseEligible:false'))
assert.ok(source.includes("evidence/acceptance.json"))
assert.ok(!source.includes("writeFileSync(join(root,'evidence/acceptance.json')"))
cases++
console.log(`${cases} Windows-only upgrade replay provenance/isolation cases passed; no native upgrade claim.`)
