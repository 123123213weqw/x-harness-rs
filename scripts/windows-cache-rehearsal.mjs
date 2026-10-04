// Disposable native NSIS rehearsal. No published release or production signing key.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {verifyPackage} from './verify-updater-package.mjs'

export function validateRehearsal(stage, env, platform=process.platform) {
  assert.equal(platform,'win32','Native Windows only')
  assert.equal(env.GITHUB_ACTIONS,'true','CI only')
  assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted','Disposable hosted runner only')
  assert.equal(stage.rehearsal_only,true,'Never a production acceptance receipt')
  assert.match(env.GITHUB_SHA,/^[a-f0-9]{40}$/)
  assert.equal(stage.sha,env.GITHUB_SHA)
  assert.equal(stage.repository,env.GITHUB_REPOSITORY)
  assert.equal(stage.platform,'windows-x86_64')
  assert.equal(stage.target,'x86_64-pc-windows-msvc')
  assert.equal(stage.version,'0.0.902')
  assert.equal(stage.base_version,'0.0.901')
  assert.equal(stage.release_run_id,env.GITHUB_RUN_ID)
  assert.equal(stage.release_run_attempt,env.GITHUB_RUN_ATTEMPT)
  assert.equal(stage.endpoint,`https://github.com/${env.GITHUB_REPOSITORY}/releases/latest/download/latest.json`)
  for(const key of ['base_sha256','package_sha256','manifest_sha256'])assert.match(stage[key],/^[a-f0-9]{64}$/)
}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
export function checkStaged(root, env=process.env) {
  const stage=JSON.parse(readFileSync(join(root,'cache-rehearsal.json'),'utf8'))
  validateRehearsal(stage,env)
  assert.equal(hash(join(root,'old','XHarness_0.0.901_x64-setup.exe')),stage.base_sha256)
  const installer=join(root,'next','XHarness_0.0.902_x64-setup.exe')
  assert.equal(hash(installer),stage.package_sha256)
  assert.equal(hash(join(root,'next','latest.json')),stage.manifest_sha256)
  const manifest=JSON.parse(readFileSync(join(root,'next','latest.json'),'utf8'))
  assert.equal(manifest.version,stage.version)
  assert.equal(manifest.platforms[stage.platform].signature,stage.signature)
  assert.equal(manifest.platforms[stage.platform].url,`https://github.com/${stage.repository}/releases/download/desktop-v0.0.902/XHarness_0.0.902_x64-setup.exe`)
  verifyPackage(readFileSync(installer),stage.public_key,stage.signature)
  return stage
}
function stage() {
  const env=process.env
  const candidate=resolve(env.CANDIDATE), release=join(candidate,'release')
  const receipt=JSON.parse(readFileSync(join(release,'windows-x86_64.receipt.json'),'utf8'))
  assert.equal(receipt.rehearsal_only,true)
  const root=resolve('dist/migration-acceptance')
  assert.ok(!existsSync(root),'Refuse to overwrite any staged acceptance data')
  for(const name of ['old','next','bridge','evidence'])mkdirSync(join(root,name),{recursive:true})
  const base=resolve('apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/XHarness_0.0.901_x64-setup.exe')
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),env.GITHUB_SHA)
  const value={...receipt,base_version:'0.0.901',base_sha256:hash(base),
    manifest_sha256:hash(join(release,'latest.json')),public_key:readFileSync(join(release,'updater.pub'),'utf8').trim()}
  validateRehearsal(value,env)
  copyFileSync(base,join(root,'old','XHarness_0.0.901_x64-setup.exe'))
  for(const kind of ['next','bridge'])for(const name of [receipt.package,receipt.package+'.sig','latest.json'])copyFileSync(join(release,name),join(root,kind,name))
  writeFileSync(join(root,'cache-rehearsal.json'),JSON.stringify(value,null,2)+'\n')
  checkStaged(root,env)
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){assert.equal(process.argv[2],'stage');stage()}
