import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { localPath, orderModules, readInput, renderBoot, treeHashes } from './ui-build-contract.mjs'

test('Windows checkouts and TS emission use canonical LF for pinned UI inputs', () => {
  assert.match(readFileSync(resolve('.gitattributes'), 'utf8'), /^\/ui\/\*\* text=auto eol=lf$/m)
  assert.equal(JSON.parse(readFileSync(resolve('ui/tsconfig.json'), 'utf8')).compilerOptions.newLine, 'lf')
})
for (const path of ['/tmp/escape', '../escape', 'dir/../../escape', 'dir\\escape', 'a//b', 'a?b', 'a%2fb', 'a\0b']) {
  test(`rejects non-local input/output path ${JSON.stringify(path)}`, () => assert.throws(() => localPath(path), /Invalid local/))
}
test('code dependencies order factories, not service inject labels', () => {
  const modules = [{ id: '@xh/consumer', external: ['@xh/helper/client'] }, { id: '@xh/helper', inject: ['@xh/consumer'] }]
  assert.deepEqual(orderModules(modules).map(row => row.id), ['@xh/helper', '@xh/consumer'])
})
test('cycles, self references, duplicate IDs and missing dependencies fail closed', () => {
  for (const rows of [
    [{ id: '@xh/a', external: ['@xh/a'] }],
    [{ id: '@xh/a', external: ['@xh/b'] }, { id: '@xh/b', external: ['@xh/a'] }],
    [{ id: '@xh/a' }, { id: '@xh/a' }],
    [{ id: '@xh/a', external: ['@xh/missing'] }],
    [{ id: '@xh/a', external: 'not-an-array' }],
  ]) assert.throws(() => orderModules(rows))
})
test('templates require one graph marker and all referenced assets', () => {
  const graph = { rev: 'test', entries: [] }, files = new Map([['code.js', Buffer.from('code')]])
  assert.match(renderBoot('__XHARNESS_BOOT_GRAPH__ <script src="/code.js?rev=0000000000000000"></script>', graph, files), /rev=[a-f0-9]{16}/)
  assert.throws(() => renderBoot('no marker', graph, files), /placeholder/)
  assert.throws(() => renderBoot('__XHARNESS_BOOT_GRAPH__ __XHARNESS_BOOT_GRAPH__', graph, files), /placeholder/)
  assert.throws(() => renderBoot('__XHARNESS_BOOT_GRAPH__ <script src="/missing.js"></script>', graph, files), /missing asset/)
})
test('generated dist cannot be an input and symlinks cannot escape the source tree', () => {
  const temp = mkdtempSync(join(tmpdir(), 'xh-ui-path-'))
  try {
    mkdirSync(join(temp, 'ui')); writeFileSync(join(temp, 'private.txt'), 'not an input')
    symlinkSync(join(temp, 'private.txt'), join(temp, 'ui/escape.js'))
    assert.throws(() => readInput(join(temp, 'ui'), { source: 'escape.js' }), /escapes/)
    assert.throws(() => readInput(join(temp, 'ui'), { source: 'dist/code.js' }), /generated output/)
    for (const directory of ['dist', 'node_modules', 'reference']) {
      mkdirSync(join(temp, 'ui', directory)); writeFileSync(join(temp, 'ui', directory, 'cached.js'), 'cache')
      symlinkSync(join(temp, 'ui', directory, 'cached.js'), join(temp, 'ui', `${directory}-alias.js`))
      assert.throws(() => readInput(join(temp, 'ui'), { source: `${directory}-alias.js` }), /alias generated output/)
    }
  } finally { rmSync(temp, { recursive: true }) }
})
test('clean isolated checkout builds without dist, old builders, patch scripts or another repository', { timeout: 600000 }, () => {
  const root = resolve('.'), temp = mkdtempSync(join(tmpdir(), 'xh-ui-clean-'))
  const repo = join(temp, 'checkout'), ui = join(repo, 'ui'), output = join(ui, 'dist')
  const run = (...args) => spawnSync(args[0], args.slice(1), { cwd: repo, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, UPSTREAM_HARNESS_DIR: join(temp, 'does-not-exist') } })
  const good = result => assert.equal(result.status, 0, result.stdout + result.stderr)
  try {
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    for (const path of ['assemble-static-ui.mjs', 'ui-build-contract.mjs', 'build-plugin-api.mjs', 'build-source-modules.mjs', 'owned-ui-type-policy.mjs', 'build-script-assets.mjs', 'build-platform-ui.mjs', 'rebuild-ui.sh', 'generate-session-terminal-contract.mjs']) cpSync(join(root, 'scripts', path), join(repo, 'scripts', path))
    cpSync(join(root, 'protocol'), join(repo, 'protocol'), { recursive: true })
    for (const path of ['src', 'types', 'modules.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.sources.json', 'source-vendors.json', 'platform-npm-provenance.json']) cpSync(join(root, 'ui', path), join(ui, path), { recursive: true })
    const productionAssets = JSON.parse(readFileSync(join(ui, 'modules.json'))).assets
    for (const {source} of productionAssets) {
      if (source.startsWith('src/')) continue
      mkdirSync(join(ui, source, '..'), {recursive: true})
      cpSync(join(root, 'ui', source), join(ui, source))
    }
    // No legacy platform, historical business bundle, or golden reference is
    // present. Only the pinned original xterm distribution may be plain JS.
    assert.equal(existsSync(join(ui, 'legacy')), false)
    assert.equal(existsSync(join(ui, 'reference')), false)
    assert.equal(existsSync(join(ui, 'plugins/@xlang/xharness-client-plugin-api')), false)
    assert.equal(existsSync(output), false)
    assert.equal(existsSync(join(repo, 'scripts/patch-attachments.mjs')), false)
    // CI installs the locked packages before this test; npm's local cache is
    // sufficient here. No network fetch or original workspace symlink needed.
    good(run('npm', 'ci', '--prefix', 'ui', '--ignore-scripts', '--offline'))
    good(run('npm', 'run', 'build', '--prefix', 'ui'))
    const first = treeHashes(output)
    good(run('npm', 'run', 'build', '--prefix', 'ui'))
    assert.deepEqual(treeHashes(output), first, 'identical inputs generate byte-identical outputs')
    good(run('npm', 'run', 'check:build', '--prefix', 'ui'))
    const generatedContract = join(ui, 'src/modules/shared/generated/session-terminal.ts'), originalContract = readFileSync(generatedContract)
    writeFileSync(generatedContract, originalContract + '\n// stale contract\n')
    assert.notEqual(run('npm', 'run', 'build', '--prefix', 'ui').status, 0, 'protocol drift fails before UI publication')
    assert.notEqual(run('node', 'scripts/assemble-static-ui.mjs').status, 0, 'direct assembly cannot bypass the same contract gate')
    assert.deepEqual(treeHashes(output), first)
    writeFileSync(generatedContract, originalContract)
    writeFileSync(join(output, 'index.html'), 'stale output')
    assert.notEqual(run('npm', 'run', 'check:build', '--prefix', 'ui').status, 0, 'consistency check detects stale committed output without repairing it')
    assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), 'stale output')
    good(run('npm', 'run', 'build', '--prefix', 'ui'))
    assert.deepEqual(treeHashes(output), first)
    const inventory = JSON.parse(readFileSync(join(output, 'asset-manifest.json'), 'utf8'))
    for (const [path, entry] of Object.entries(inventory.files)) assert.equal(entry.sha256, first[path])
    const manifestPath = join(ui, 'modules.json'), original = readFileSync(manifestPath), manifest = JSON.parse(original)
    const rejectedManifest = change => {
      const changed = structuredClone(manifest); change(changed); writeFileSync(manifestPath, JSON.stringify(changed))
      assert.notEqual(run('npm', 'run', 'build', '--prefix', 'ui').status, 0)
      assert.deepEqual(treeHashes(output), first, 'failed build preserves the last good output')
      writeFileSync(manifestPath, original)
    }
    rejectedManifest(m => { m.modules[0].external = ['@xh/missing'] })
    rejectedManifest(m => { m.modules[0].source = '../private' })
    rejectedManifest(m => { m.modules[0].sha256 = '0'.repeat(64) })
    rejectedManifest(m => { m.assets.push(structuredClone(m.assets[0])) })
    rejectedManifest(m => { m.assets.push({path:`plugins/${m.modules.find(row=>row.kind==='source-module').id}/client.js.map`,source:m.assets[0].source}) })
    rejectedManifest(m => { m.assets[0].path = 'client-graph.json' })
    rejectedManifest(m => { m.modules[0].kind = 'classic-js' })
    rejectedManifest(m => { m.bootTemplate.source = 'legacy/index.template.html' })
    rejectedManifest(m => { m.platform = undefined })
    rejectedManifest(m => { m.frozenOverrides = [] })
    const tsFile = join(ui, 'src/plugin-api/client.ts'), ts = readFileSync(tsFile)
    writeFileSync(tsFile, ts + '\nexport const broken: number = "not a number";\n')
    assert.notEqual(run('npm', 'run', 'build', '--prefix', 'ui').status, 0)
    assert.deepEqual(treeHashes(output), first, 'compiler failure preserves output')
    writeFileSync(tsFile, ts)
    const pinned = manifest.assets.find(row => row.sha256), asset = join(ui, pinned.source), previous = readFileSync(asset)
    writeFileSync(asset, Buffer.concat([previous, Buffer.from('\n// changed pinned resource\n')]))
    assert.notEqual(run('npm', 'run', 'build', '--prefix', 'ui').status, 0, 'edited pinned resources cannot silently ship changed bytes')
    assert.deepEqual(treeHashes(output), first)
    writeFileSync(asset, previous)
    const own = manifest.modules.find(row => row.id === '@xlang/xharness-client-ui-motion')
    const ownPath = join(ui, own.source), ownSource = readFileSync(ownPath)
    writeFileSync(ownPath, "window.__ModuleLoader__.load({ id: '@xh/wrong', factory: () => ({}) });\n")
    assert.notEqual(run('npm', 'run', 'build', '--prefix', 'ui').status, 0, 'wrong ModuleLoader registration fails before publishing')
    assert.deepEqual(treeHashes(output), first)
    writeFileSync(ownPath, ownSource + '\n// source rebuild proof\n')
    good(run('npm', 'run', 'build', '--prefix', 'ui'))
    assert.notEqual(treeHashes(output)[`plugins/${own.id}/client.js`], first[`plugins/${own.id}/client.js`], 'product JS is built from source')
    const unowned = join(temp, 'user-data'); mkdirSync(unowned); writeFileSync(join(unowned, 'keep.txt'), 'keep')
    assert.notEqual(run('node', 'scripts/assemble-static-ui.mjs', '--out-dir', unowned).status, 0)
    assert.equal(readFileSync(join(unowned, 'keep.txt'), 'utf8'), 'keep')
    assert.notEqual(run('node', 'scripts/assemble-static-ui.mjs', '--out-dir', ui).status, 0)
    assert.notEqual(run('bash', 'scripts/rebuild-ui.sh', '/external/tree').status, 0, 'old external directory argument is rejected')
    assert.notEqual(run('node', 'scripts/assemble-static-ui.mjs', '/external/tree', output).status, 0)
  } finally { rmSync(temp, { recursive: true }) }
})

test('source-platform HTML uses only generated entry/CSS and strictly checked bootstrap', () => {
  const files = new Map([['assets/platform.js', Buffer.from('entry')], ['assets/platform.css', Buffer.from('css')]])
  const template = '<script>__XHARNESS_PRELOAD_BOOT__</script><script type="module" src="__XHARNESS_PLATFORM_ENTRY__"></script>__XHARNESS_PLATFORM_STYLES__ __XHARNESS_BOOT_GRAPH__'
  const platform = {entryPath:'assets/platform.js', cssPaths:['assets/platform.css'], preloadBootBytes:'window.queue = [];'}
  const html = renderBoot(template, {entries:[]}, files, platform)
  assert.match(html, /src="\/assets\/platform.js"/)
  assert.match(html, /href="\/assets\/platform.css"/)
  assert.match(html, /window.queue = \[\];/)
  assert.throws(()=>renderBoot(template, {}, files), /Source platform required/)
  assert.throws(()=>renderBoot(template+ '__XHARNESS_PLATFORM_ENTRY__', {}, files, platform), /exactly one/)
  assert.throws(()=>renderBoot(template, {}, files, {...platform,entryPath:'../escape'}), /Invalid local/)
  assert.throws(()=>renderBoot(template, {}, files, {...platform,entryPath:'missing.js'}), /Missing platform entry/)
  assert.throws(()=>renderBoot(template, {}, files, {...platform,cssPaths:['missing.css']}), /Missing platform stylesheet/)
  assert.throws(()=>renderBoot(template, {}, files, {...platform,preloadBootBytes:'</script><script>bad'}), /Invalid typed preload/)
})
