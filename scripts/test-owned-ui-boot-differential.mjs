/** Full generated UI, genuine platform/Core, old/new two-engine comparison with the explicit Work navigation delta. */
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
    env:{...process.env,UI_TEST_BROWSER:browser,UI_TEST_IMPL:implementation,UI_BOOT_RECEIPT_DIR:directory,UI_BOOT_REFERENCE_LAYOUT:'false'},
    encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
   })
   assert.equal(result.status,0,`${browser}/${implementation}: ${result.error?.message??''}\n${result.stdout}\n${result.stderr}`)
   const receipt=JSON.parse(result.stdout.trim().split('\n').at(-1))
   assert.equal(receipt.fullGraph,true);assert.equal(receipt.fixtureTransport,true)
   assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.staticFailures,[])
   assert.equal(receipt.settingsProviders,true);assert.equal(receipt.modelEffortAndContextControls,true);assert.equal(receipt.effortChange,true)
   assert.equal(receipt.loadedPlugins,implementation==='source'?55:52,'source adds only the reviewed Plugin API helper, Code Review and Little X modules')
   assert.equal(receipt.shellNavigationCount,implementation==='source'?2:0,'reviewed Back/Forward controls only')
   assert.equal(receipt.assistantEntryCount,implementation==='source'?1:0,'one reviewed Little X entry; frozen control stays unchanged')
   assert.equal(receipt.codeReviewEntryCount,implementation==='source'?1:0,'only the reviewed Code Review navigation is projected out of old/new text and button parity')
   assert.equal(receipt.sidebarSearchEntryCount,implementation==='source'?0:1,'source removes only the requested search entry; frozen positive control retains it')
   assert.equal(receipt.sidebarSearchInputCount,implementation==='source'?0:1,'source removes the search field; frozen reference stays immutable')
   outputs.push(receipt)
  }
  assert.deepEqual(outputs[0].loadedPluginPaths,[...outputs[1].loadedPluginPaths,
   '/plugins/@xlang/xharness-client-plugin-api/client.js',
   '/plugins/@xlang/xharness-client-ui-code-review/client.js',
   '/plugins/@xlang/xharness-client-ui-assistant/client.js',
  ].sort(),`${browser}: exact reviewed plugin additions; no missing, duplicate or unreviewed modules`)
  for(const receipt of outputs) assert.equal(receipt.navigationCount,1,'exactly one work navigation, legacy footer or new clock')
  for(const key of ['stableText','stableButtons','inputs'])assert.deepEqual(outputs[0][key],outputs[1][key],`${browser}: full UI ${key} parity`)
  const actualSource=readFileSync(join(directory,browser+'-source-chat-boot.png'))
  // Keep both approved deltas narrow: project only regional insets/wrappers
  // to the frozen geometry, and compare the conversation independently of
  // the intentionally replaced sidebar work-navigation control.
  const projected=spawnSync(process.execPath,['scripts/test-owned-ui-boot-browser.mjs'],{
    env:{...process.env,UI_TEST_BROWSER:browser,UI_TEST_IMPL:'source',UI_BOOT_RECEIPT_DIR:directory,UI_BOOT_REFERENCE_LAYOUT:'true'},
    encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
  })
  assert.equal(projected.status,0,`${browser}/reference layout: ${projected.error?.message??''}\n${projected.stdout}\n${projected.stderr}`)
  const projectedReceipt=JSON.parse(projected.stdout.trim().split('\n').at(-1))
  assert.equal(projectedReceipt.sidebarSearchEntryCount,0)
  assert.equal(projectedReceipt.sidebarSearchInputCount,0)
  assert.equal(projectedReceipt.assistantEntryCount,1)
  for(const key of ['stableText','stableButtons','inputs'])assert.deepEqual(projectedReceipt[key],outputs[1][key],`${browser}: projected full UI ${key} parity`)
  const source=readFileSync(join(directory,browser+'-source-reference-chat-boot.png'))
  const old=readFileSync(join(directory,browser+'-legacy-chat-boot.png'))
  assert.notDeepEqual(actualSource,old,`${browser}: actual rounded conversation region must differ from the frozen shell`)
  assert.equal(Buffer.compare(source,old),0,`${browser}: settled conversation pixels after only regional geometry projection must match independent frozen master`)
  console.log(JSON.stringify({browser,implementationRuns:3,fullGraph:true,controls:'providers + model + effort + context',effortChange:true,regionalChrome:true,workNavigation:true,pixelSha256:digest(source),actualPixelSha256:digest(actualSource)}))
 }
}finally{rmSync(directory,{recursive:true,force:true})}
