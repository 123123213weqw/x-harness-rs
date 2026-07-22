/** Full generated UI, genuine platform/Core, immutable old/new two-engine comparison. */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
const directory=mkdtempSync(join(tmpdir(),'xharness-full-ui-boot-'))
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
try{
 for(const browser of ['chromium','webkit']){
  const outputs=[]
  for(const implementation of ['source','legacy']){
   const result=spawnSync(process.execPath,['scripts/test-owned-ui-boot-browser.mjs'],{
    env:{...process.env,UI_TEST_BROWSER:browser,UI_TEST_IMPL:implementation,UI_BOOT_RECEIPT_DIR:directory},
    encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
   })
   assert.equal(result.status,0,`${browser}/${implementation}: ${result.error?.message??''}\n${result.stdout}\n${result.stderr}`)
   const receipt=JSON.parse(result.stdout.trim().split('\n').at(-1))
   assert.equal(receipt.fullGraph,true);assert.equal(receipt.fixtureTransport,true)
   assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.staticFailures,[])
   assert.equal(receipt.settingsProviders,true);assert.equal(receipt.modelEffortAndContextControls,true);assert.equal(receipt.effortChange,true)
   assert.equal(receipt.loadedPlugins,implementation==='source'?53:52,'source adds only the internal checked Plugin API helper')
   outputs.push(receipt)
  }
  for(const key of ['text','buttons','inputs'])assert.deepEqual(outputs[0][key],outputs[1][key],`${browser}: full UI ${key} parity`)
  const source=readFileSync(join(directory,browser+'-source-full-boot.png'))
  const old=readFileSync(join(directory,browser+'-legacy-full-boot.png'))
  assert.deepEqual(source,old,`${browser}: complete settled first-frame pixels must match independent frozen master`)
  console.log(JSON.stringify({browser,implementationRuns:2,fullGraph:true,controls:'providers + model + effort + context',effortChange:true,pixelSha256:digest(source)}))
 }
}finally{rmSync(directory,{recursive:true,force:true})}
