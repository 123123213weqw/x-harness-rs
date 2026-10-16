// Read-only package staging for a disposable Windows diagnostic. Never produces
// release acceptance: package source and diagnostic harness source are distinct.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {appendFileSync,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {installerLocation,acceptanceFromPass} from './desktop-windows-acceptance.mjs'
import {verifyPackage} from './verify-updater-package.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => readFileSync(file,'utf8').trim()
const json = file => JSON.parse(read(file))
function validateReplayIdentity({repository,runId,sourceSha,version}) {
  assert.match(repository,/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  assert.match(String(runId),/^[1-9]\d*$/)
  assert.match(sourceSha,/^[a-f0-9]{40}$/)
  assert.match(version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
}
export function validateReplaySource(run, identity) {
  validateReplayIdentity(identity)
  const {repository,runId,sourceSha,version}=identity
  assert.equal(String(run.id),String(runId))
  assert.equal(run.head_repository?.full_name,repository)
  assert.equal(run.path,'.github/workflows/desktop-release.yml')
  assert.equal(run.status,'completed')
  assert.ok(['success','failure'].includes(run.conclusion),'Only completed diagnostic sources are allowed')
  assert.ok(['push','workflow_dispatch'].includes(run.event))
  assert.equal(run.head_branch,'desktop-v'+version)
  assert.equal(run.head_sha,sourceSha)
  assert.ok(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0)
}
export function validateReplayJobs(jobs) {
  const expected=['plan','aggregate','Signed windows-x86_64 candidate','Signed darwin-aarch64 candidate','Signed darwin-x86_64 candidate','Signed linux-x86_64-appimage candidate']
  assert.deepEqual(jobs.map(job=>job.name).sort(),expected.sort())
  for(const job of jobs){
    assert.equal(job.status,'completed')
    if(job.name!=='Signed windows-x86_64 candidate'||job.conclusion==='success'){
      assert.equal(job.conclusion,'success','A different failed producer is not an upgrade replay source')
      continue
    }
    assert.equal(job.conclusion,'failure')
    assert.deepEqual(job.steps.filter(step=>step.conclusion==='failure').map(step=>step.name),['Exact Windows one-hop update and data preservation'])
    for(const name of ['Build and sign desktop bundle (artifacts only)',
      'Verify architecture, embedded channel, updater signature and declared Mac code-signing policy',
      'Windows real installer ownership and crash cleanup acceptance']){
      assert.equal(job.steps.find(step=>step.name===name)?.conclusion,'success',name)
    }
  }
}
export function validateReplayPlan(plan,run,identity) {
  validateReplaySource(run,identity)
  assert.equal(plan.repository,identity.repository)
  assert.equal(plan.sha,identity.sourceSha)
  assert.equal(plan.version,identity.version)
  assert.equal(plan.tag,run.head_branch)
  assert.equal(plan.release_run_id,String(run.id))
  assert.equal(plan.release_run_attempt,String(run.run_attempt))
  assert.equal(plan.acceptance_mode,'in-build')
  assert.equal(plan.endpoint,`https://github.com/${identity.repository}/releases/latest/download/latest.json`)
}

function main(command) {
  const e=process.env
  assert.equal(e.GITHUB_ACTIONS,'true','CI only')
  assert.equal(e.RUNNER_ENVIRONMENT,'github-hosted','Disposable hosted runner only')
  assert.equal(process.platform,'win32','Windows only')
  assert.equal(e.GITHUB_EVENT_NAME,'workflow_dispatch')
  assert.equal(e.SOURCE_CI_RUN_ID||'','','Do not mix installer and upgrade diagnostics')
  const identity={repository:e.GITHUB_REPOSITORY,runId:e.SOURCE_RELEASE_RUN_ID,sourceSha:e.EXPECTED_SOURCE_SHA,version:e.EXPECTED_VERSION}
  validateReplayIdentity(identity)
  const root=resolve('dist/migration-acceptance'),work=resolve('dist/windows-upgrade-replay')
  const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']})
  const api=path=>JSON.parse(gh('api',`repos/${identity.repository}/${path}`))
  const source=()=>{
    const run=api(`actions/runs/${identity.runId}`)
    validateReplaySource(run,identity)
    const jobs=api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
    assert.equal(jobs.total_count,jobs.jobs.length)
    validateReplayJobs(jobs.jobs)
    assert.equal(api('actions/workflows/desktop-candidates.yml').state,'disabled_manually','Automatic candidate builds must remain paused')
    let object=api(`git/ref/tags/desktop-v${identity.version}`).object
    for(let depth=0;object.type==='tag'&&depth<8;depth++)object=api(`git/tags/${object.sha}`).object
    assert.equal(object.type,'commit');assert.equal(object.sha,identity.sourceSha)
    assert.ok(['ahead','identical'].includes(api(`compare/${identity.sourceSha}...master`).status),'Package source must be a master ancestor')
    return run
  }
  if(command==='stage'){
    const run=source()
    assert.ok(!existsSync(root)&&!existsSync(work),'Refuse pre-existing diagnostic directories')
    assert.match(e.GITHUB_SHA,/^[a-f0-9]{40}$/)
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),e.GITHUB_SHA)
    mkdirSync(work,{recursive:true})
    const candidate=join(work,'candidate')
    gh('run','download',identity.runId,'--repo',identity.repository,'--name','desktop-candidate','--dir',candidate)
    const plan=json(join(candidate,'plan.json'))
    validateReplayPlan(plan,run,identity)
    const ci=api(`actions/runs/${plan.ci.id}`)
    for(const [key,value] of Object.entries(plan.ci))assert.equal(ci[key],value,`CI identity drift: ${key}`)
    assert.equal(ci.head_repository?.full_name,identity.repository)
    const latest=JSON.parse(gh('release','view','--repo',identity.repository,'--json','tagName,isDraft,isPrerelease'))
    assert.equal(latest.isDraft,false);assert.equal(latest.isPrerelease,false)
    const old=join(root,'old'),next=join(root,'next'),bridge=join(root,'bridge')
    for(const directory of [old,next,bridge])mkdirSync(directory,{recursive:true})
    gh('release','download',latest.tagName,'--repo',identity.repository,'--dir',old,'--pattern','latest.json','--pattern','updater.pub')
    const before=json(join(old,'latest.json')),release=join(candidate,'release'),after=json(join(release,'latest.json'))
    const key=read(join(old,'updater.pub'))
    assert.equal(read(join(release,'updater.pub')),key,'Candidate cannot choose a different trust key')
    // Invoke the existing complete manifest/receipt/signature verifier as a
    // library. Do not impersonate the package source checkout or build run.
    execFileSync('python',['-B','-c',
      "import runpy,sys; c=runpy.run_path('scripts/desktop-release.py'); p=c['validate_plan'](c['read_json'](sys.argv[1])); c['validate_release'](p,sys.argv[2],sys.argv[3]); print('Complete immutable candidate verified; diagnostic only')",
      join(candidate,'plan.json'),release,join(old,'updater.pub')],{stdio:'inherit',timeout:180000})
    const oldName=installerLocation(identity.repository,latest.tagName,before.version,before.platforms['windows-x86_64'].url)
    const nextName=installerLocation(identity.repository,plan.tag,plan.version,after.platforms['windows-x86_64'].url)
    const a=before.version.split('.').map(Number),b=identity.version.split('.').map(Number)
    assert.ok(b[0]>a[0]||b[0]===a[0]&&(b[1]>a[1]||b[1]===a[1]&&b[2]>a[2]),'Target must be newer than stable')
    gh('release','download',latest.tagName,'--repo',identity.repository,'--dir',old,'--pattern',oldName,'--pattern',oldName+'.sig')
    assert.equal(read(join(old,oldName+'.sig')),before.platforms['windows-x86_64'].signature)
    verifyPackage(readFileSync(join(old,oldName)),key,read(join(old,oldName+'.sig')))
    for(const directory of [next,bridge])for(const name of [nextName,nextName+'.sig','latest.json'])copyFileSync(join(release,name),join(directory,name))
    copyFileSync(join(next,nextName+'.sig'),join(bridge,nextName+'.upstream.sig'))
    verifyPackage(readFileSync(join(next,nextName)),key,read(join(next,nextName+'.sig')))
    const staged={plan,manifest_sha256:sha(readFileSync(join(next,'latest.json'))),package_sha256:sha(readFileSync(join(next,nextName))),base_tag:latest.tagName,base_version:before.version}
    writeFileSync(join(root,'unified-stage.json'),JSON.stringify(staged,null,2)+'\n')
    writeFileSync(join(work,'identity.json'),JSON.stringify({diagnosticOnly:true,releaseEligible:false,harnessSha:e.GITHUB_SHA,sourceRunAttempt:run.run_attempt,baseSha256:sha(readFileSync(join(old,oldName))),...staged},null,2)+'\n')
    assert.equal(source().run_attempt,run.run_attempt,'Source attempt changed while staging')
    const values={UNIFIED_ACCEPTANCE:'true',BASE_VERSION:before.version,BASE_RELEASE_TAG:latest.tagName,BRIDGE_VERSION:plan.version,UPSTREAM_VERSION:plan.version,UPSTREAM_REPOSITORY:identity.repository,OLD_PUBLIC_KEY:key,UPSTREAM_PUBLIC_KEY:key,DIRECT_LATEST:'true',REPLAY_TARGET_INSTALLER:join(next,nextName)}
    for(const [name,value] of Object.entries(values)){assert.ok(!/[\r\n]/.test(value));appendFileSync(e.GITHUB_ENV,`${name}=${value}\n`)}
    console.log(`Reusing signed ${before.version} -> ${plan.version}; no rebuild, signing, publication, or formal acceptance receipt`)
  }else if(command==='report'){
    const run=source(),record=json(join(work,'identity.json')),staged=json(join(root,'unified-stage.json'))
    validateReplayPlan(staged.plan,run,identity)
    assert.equal(record.sourceRunAttempt,run.run_attempt)
    assert.equal(record.harnessSha,e.GITHUB_SHA)
    assert.equal(JSON.parse(gh('release','view','--repo',identity.repository,'--json','tagName')).tagName,record.base_tag,'Stable base changed during replay')
    assert.ok(!existsSync(join(root,'evidence/FAIL.json')))
    assert.ok(!existsSync(join(root,'evidence/acceptance.json')),'Diagnostic must not manufacture formal acceptance')
    const pass=json(join(root,'evidence/PASS.json'))
    assert.equal(pass.checkpoints?.[0]?.version,record.base_version)
    const next=join(root,'next',`XHarness_${identity.version}_x64-setup.exe`),old=join(root,'old',`XHarness_${record.base_version}_x64-setup.exe`)
    assert.equal(sha(readFileSync(next)),record.package_sha256);assert.equal(sha(readFileSync(old)),record.baseSha256)
    assert.equal(sha(readFileSync(join(root,'next/latest.json'))),record.manifest_sha256)
    const checked=acceptanceFromPass(staged.plan,record.manifest_sha256,record.package_sha256,pass,{diagnosticOnly:true})
    writeFileSync(join(root,'evidence/DIAGNOSTIC-REPLAY.json'),JSON.stringify({diagnosticOnly:true,releaseEligible:false,status:'passed',harnessSha:e.GITHUB_SHA,packageSourceSha:identity.sourceSha,sourceRunId:String(run.id),sourceRunAttempt:run.run_attempt,baseVersion:record.base_version,targetVersion:identity.version,packageSha256:record.package_sha256,checks:checked.checks},null,2)+'\n')
    console.log('Windows signed upgrade replay passed; automatic candidates remain paused; not publication evidence')
  }else throw new Error('Expected stage or report')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv[2])
