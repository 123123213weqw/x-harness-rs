// Compatibility commands must use the complete source build, never stale cache
// bundles. All outputs stay in disposable directories, not the installed App.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {treeHashes} from './ui-build-contract.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const commands=['update-context-composition-dist.mjs','sync-browser-ui.mjs']
const hashes=treeHashes
for(const command of commands)test(`${command}: full owned rebuild, coherent revisions and fail-closed arguments`,{timeout:240000},()=>{
 const temp=mkdtempSync(join(tmpdir(),'xh-refresh-entry-'))
 const run=(...args)=>{
  const result=spawnSync(process.execPath,[resolve(root,'scripts',command),...args],{cwd:root,encoding:'utf8',timeout:120000})
  assert.ifError(result.error);assert.equal(result.signal,null);assert.ok(Number.isInteger(result.status)&&result.status>=0)
  return {...result,diagnostic:result.stdout+result.stderr}
 }
 try{
  const target=join(temp,'owned output with spaces')
  const built=run(target);assert.equal(built.status,0,built.diagnostic)
  assert.deepEqual(hashes(target),hashes(resolve(root,'ui/dist')),'every committed UI byte is rebuilt, including boot/preload and revision metadata')
  const invalid=run(target,'unexpected');assert.notEqual(invalid.status,0);assert.match(invalid.diagnostic,/usage:/)
  const unowned=join(temp,'unowned');mkdirSync(unowned);writeFileSync(join(unowned,'keep.txt'),'private input')
  const rejected=run(unowned);assert.notEqual(rejected.status,0);assert.match(rejected.diagnostic,/unowned output/)
  assert.equal(readFileSync(join(unowned,'keep.txt'),'utf8'),'private input','builder rejection never erases existing inputs')
 }finally{rmSync(temp,{recursive:true,force:true})}
})

test('macOS brand generation refreshes owned UI instead of invoking a retired favicon patch',()=>{
 const script=readFileSync(resolve(root,'scripts/generate-brand-assets-macos.sh'),'utf8')
 assert.ok(script.includes('node "$repo_root/scripts/assemble-static-ui.mjs"'))
 assert.doesNotMatch(script,/patch-favicon/)
})
