import assert from 'node:assert/strict'
import {readFileSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {test} from 'node:test'
import {sha256,readInput} from './ui-build-contract.mjs'
const root=resolve('ui/reference/master-a613970')
const metadata=JSON.parse(readFileSync(join(root,'REFERENCE.json'),'utf8'))
const approvedAdditions = [
  {"id":"@xlang/xharness-client-ui-runtime","kind":"source-module","source":"src/modules/runtime-environment/index.ts","inject":["@xharness/dsh-client-ui-conversation","@xharness/dsh-client-locale"]},
  { id: '@xlang/xharness-client-ui-performance', kind: 'source-module', source: 'src/modules/performance/index.ts', inject: ['@xharness/dsh-client-ui-conversation', '@xharness/dsh-client-runtime', '@xharness/dsh-client-locale'] },
  { id: '@xlang/xharness-client-ui-memory', kind: 'source-module', source: 'src/modules/memory/index.tsx', inject: ['@xharness/dsh-client-runtime', '@xharness/dsh-client-locale', '@xharness/dsh-client-ui-settings-general'] },
  { id: '@xlang/xharness-client-plugin-api', kind: 'plugin-api-ts', source: 'src/plugin-api/client.ts', inject: [] },
  { id: '@xlang/xharness-client-ui-assistant', kind: 'source-module', source: 'src/modules/assistant/index.tsx', inject: ['@xharness/dsh-client-runtime', '@xharness/dsh-client-ui-primitives', '@xharness/dsh-client-ui-layout', '@xharness/dsh-client-ui-sidebar', '@xharness/dsh-client-ui-conversation'] },
  { id: '@xlang/xharness-client-ui-code-review', kind: 'source-module', source: 'src/modules/code-review/index.tsx', inject: ['@xharness/dsh-client-ui-layout', '@xharness/dsh-client-ui-sidebar', '@xharness/dsh-client-locale', '@xharness/dsh-client-connection', '@xharness/dsh-client-runtime', '@xlang/xharness-client-ui-assistant'] },
]
function assertReviewedAdditions(manifest, baseline) {
  const additions = manifest.modules.filter(row => !baseline.entries.some(old => old.id === row.id))
  assert.deepEqual(additions.map(({id,kind,source,inject}) => ({id,kind,source,inject})), approvedAdditions, 'only reviewed source/transport additions and their exact ABI are admitted')
  assert.ok(additions.every(row => row.immediately !== true), 'reviewed additions must not add eager boot work')
}
test('parity reference is independent immutable merged master, not a candidate self-golden',()=>{
  assert.equal(metadata.sourceCommit,'a613970c78a36a024de56100078323df25b96004')
  assert.equal(metadata.files.length,216)
  const declared=new Set(metadata.files.map(row=>row.path))
  const walk=(path,prefix='')=>readdirSync(path,{withFileTypes:true}).flatMap(row=>{
    const key=prefix+row.name
    assert.equal(row.isSymbolicLink(),false)
    return row.isDirectory()?walk(join(path,row.name),key+'/'):[key]
  })
  assert.deepEqual(walk(root).filter(path=>path!=='REFERENCE.json').sort(),[...declared].sort())
  for(const row of metadata.files){const bytes=readFileSync(join(root,row.path));assert.equal(bytes.length,row.bytes,row.path);assert.equal(sha256(bytes),row.sha256,row.path)}
  assert.throws(()=>readInput(resolve('ui'),{source:'reference/master-a613970/index.html'}),/acceptance reference/)
})
test('new owned HTML retains latest master desktop bridge URLs and boot ordering',()=>{
  const html=readFileSync('ui/src/index.template.html','utf8')
  const old=readFileSync(join(root,'index.html'),'utf8')
  const ownedScripts=['desktop-startup.js','desktop-titlebar.js','desktop-updater.js','logo-motion.js']
  for(const script of ownedScripts){assert.ok(old.includes('/'+script));assert.ok(html.includes('/'+script))}
  const ordered=['__XHARNESS_PRELOAD_BOOT__','/plugins/@xharness/dsh-client-modules/client.js','/plugins/@xharness/dsh-client-runtime/client.js','__XHARNESS_BOOT_GRAPH__','__XHARNESS_PLATFORM_ENTRY__']
  let prior=-1
  for(const value of ordered){const index=html.indexOf(value);assert.ok(index>prior,value);prior=index}
  assert.ok(html.includes('<title>XHarness</title>'));assert.ok(html.includes('<div id="root"></div>'))
  assert.doesNotMatch(html,/assets\/(?:vendor|index)-.*\.(?:js|css)/)
})
test('production manifest retains every merged-master module and no legacy executable input', () => {
  const manifest = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const baseline = JSON.parse(readFileSync(join(root, 'client-graph.json'), 'utf8'))
  assert.equal(manifest.bootTemplate.source, 'src/index.template.html')
  assert.deepEqual(manifest.platform, {kind:'source-platform', source:'src/modules/platform/main.ts'})
  assert.equal(manifest.frozenOverrides, undefined)
  for (const old of baseline.entries) {
    const migrated = manifest.modules.find(row => row.id === old.id)
    assert.ok(migrated, `missing merged-master module: ${old.id}`)
    assert.equal(migrated.kind, 'source-module')
    // The parity reference stays immutable. The post-migration Harness redesign
    // deliberately adds the existing locale service for bilingual labels; no
    // other module may silently change its dependency contract.
    let expectedInject = old.inject ?? []
    if (old.id === '@xlang/xharness-client-ui-context') {
      assert.deepEqual(expectedInject, ['@xharness/dsh-client-runtime', '@xharness/dsh-client-ui-conversation'])
      expectedInject = [expectedInject[0], '@xharness/dsh-client-locale', expectedInject[1]]
    }
    assert.deepEqual(migrated.inject ?? [], expectedInject, `changed service requirements: ${old.id}`)
    assert.equal(migrated.immediately === true, old.immediately === true, `changed eager activation: ${old.id}`)
  }
  // Admit only reviewed additions, pinning their source and injected ABI;
  // the frozen baseline remains immutable and arbitrary WIP modules still fail.
  assertReviewedAdditions(manifest, baseline)
  assert.ok(manifest.modules.every(row => row.source.startsWith('src/')))
  assert.ok(manifest.assets.every(row => !row.source.startsWith('legacy/') && !row.source.startsWith('reference/') && !row.source.startsWith('dist/')))
  const originalLibrary = manifest.assets.filter(row => row.path.endsWith('.js') && row.kind !== 'script-ts')
  assert.equal(originalLibrary.length, 1)
  assert.equal(originalLibrary[0].source, 'plugins/@xlang/xharness-client-ui-terminal/vendor/xterm.js')
  assert.equal(originalLibrary[0].sha256, sha256(readFileSync(join(root, originalLibrary[0].source))))
})

test('reviewed additions still reject unknown modules, removal and registration reordering', () => {
  const manifest = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const baseline = JSON.parse(readFileSync(join(root, 'client-graph.json'), 'utf8'))
  for (const mutate of [
    candidate => candidate.modules.push({id:'@xlang/unreviewed-wip', kind:'source-module', source:'src/modules/wip/index.ts', inject:[]}),
    candidate => { candidate.modules = candidate.modules.filter(row => row.id !== '@xlang/xharness-client-ui-performance') },
    candidate => { const index = candidate.modules.findIndex(row => row.id === '@xlang/xharness-client-ui-performance'); candidate.modules.push(...candidate.modules.splice(index, 1)) },
  ]) {
    const candidate = structuredClone(manifest); mutate(candidate)
    assert.throws(() => assertReviewedAdditions(candidate, baseline), /only reviewed source\/transport additions/)
  }
})
test('performance allowance pins source, module kind and the complete injected ABI', () => {
  const manifest = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const baseline = JSON.parse(readFileSync(join(root, 'client-graph.json'), 'utf8'))
  for (const mutate of [
    row => { row.source = 'src/modules/wip/index.ts' },
    row => { row.kind = 'source-library' },
    row => { row.inject = row.inject.slice(0, -1) },
    row => { row.inject.push('@xharness/dsh-client-connection') },
    row => { row.inject.reverse() },
  ]) {
    const candidate = structuredClone(manifest)
    const row = candidate.modules.find(row => row.id === '@xlang/xharness-client-ui-performance')
    assert.ok(row); mutate(row)
    assert.throws(() => assertReviewedAdditions(candidate, baseline), /only reviewed source\/transport additions/)
  }
})
test('performance allowance cannot add eager boot work', () => {
  const manifest = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const baseline = JSON.parse(readFileSync(join(root, 'client-graph.json'), 'utf8'))
  const row = manifest.modules.find(row => row.id === '@xlang/xharness-client-ui-performance')
  assert.ok(row); row.immediately = true
  assert.throws(() => assertReviewedAdditions(manifest, baseline), /must not add eager boot work/)
})

test('memory allowance is exact and never grants eager boot or an unreviewed ABI', () => {
  const manifest = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const baseline = JSON.parse(readFileSync(join(root, 'client-graph.json'), 'utf8'))
  for (const mutate of [
    row => { row.source = 'src/modules/wip/index.ts' },
    row => { row.kind = 'source-library' },
    row => { row.inject.push('@xharness/dsh-client-connection') },
    row => { row.inject.reverse() },
    row => { row.immediately = true },
  ]) {
    const candidate = structuredClone(manifest)
    const row = candidate.modules.find(row => row.id === '@xlang/xharness-client-ui-memory')
    assert.ok(row); mutate(row)
    assert.throws(() => assertReviewedAdditions(candidate, baseline), /only reviewed source\/transport additions|must not add eager boot work/)
  }
})
