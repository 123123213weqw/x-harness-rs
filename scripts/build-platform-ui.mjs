// Strict-source browser platform compiler. Reference/legacy artifacts are never inputs.
import {createRequire} from 'node:module'
import {readFileSync, realpathSync, existsSync} from 'node:fs'
import {resolve, join, dirname, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {assertOwnedSource} from './owned-ui-type-policy.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'ui/package.json'))
const ts = require('typescript')
const esbuild = require('esbuild')
const slash = value => value.split(sep).join('/')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const localInput = (ui, path) => {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some(x => x === '..' || x === '.')) throw Error('Invalid platform source path')
  const actual = realpathSync(join(ui, path))
  if (!actual.startsWith(ui + sep) || /^(?:legacy|reference|dist)(?:\/|$)/.test(slash(relative(ui, actual)))) throw Error('Platform source escapes owned/vendor input tree')
  return actual
}
export function platformAliases(ui) {
  const source = name => join(ui, 'src/modules/platform', name)
  const result = {
    'node:module': source('node-module-stub.ts'),
    '@standard-schema/spec': join(ui, 'src/modules/settings/vendor/standard-schema/spec.d.ts'),
  }
  for (const prefix of ['@xharness', '@deepseek-ai']) {
    result[`${prefix}/cordis`] = source('vendor/cordis/src/index.ts')
    result[`${prefix}/cosmokit`] = source('vendor/cosmokit/src/index.ts')
    result[`${prefix}/cordis-plugin-loader`] = source('vendor/loader/src/index.ts')
    result[`${prefix}/dsh-client-web`] = source('web/index.ts')
    result[`${prefix}/dsh-client-ui-primitives`] = source('primitives/index.ts')
    result[`${prefix}/dsh-client-ui-slots`] = source('slots/index.ts')
    result[`${prefix}/dsh-client-modules/client`] = join(ui, 'src/modules/client-modules/index.ts')
    result[`${prefix}/dsh-client-ui-renderer/client`] = join(ui, 'src/modules/renderer/index.ts')
  }
  return result
}
/** Same-version original library SDKs; runtime aliases always stay real TS. */
export function platformTypecheckAliases(ui) {
  const result = platformAliases(ui)
  for (const prefix of ['@xharness', '@deepseek-ai']) {
    result[`${prefix}/cordis`] = join(ui, 'src/modules/platform/vendor/cordis/types/index.d.ts')
    result[`${prefix}/cosmokit`] = join(ui, 'src/modules/platform/vendor/cosmokit/types/index.d.ts')
    result[`${prefix}/cordis-plugin-loader`] = join(ui, 'src/modules/platform/vendor/loader/types/index.d.ts')
  }
  result.immer = join(ui, 'src/modules/client-runtime/vendor/immer/dist/immer.d.ts')
  return result
}
function verifiedVendors(ui) {
  const spec = JSON.parse(readFileSync(join(ui, 'source-vendors.json'), 'utf8'))
  const files = new Set()
  for (const row of spec.sourceTrees ?? []) {
    const root = localInput(ui, row.root)
    const provenance = JSON.parse(readFileSync(join(root, 'PROVENANCE.json'), 'utf8'))
    if (provenance.formatVersion !== 1 || !/^[a-f0-9]{40}$/.test(provenance.sourceRevision)) throw Error('Invalid platform vendor provenance')
    for (const license of row.licenses) localInput(ui, `${row.root}/${license}`)
    for (const file of provenance.files) {
      const actual = localInput(ui, `${row.root}/${file.path}`)
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || digest(readFileSync(actual)) !== file.sha256) throw Error(`Vendor source drift: ${row.root}/${file.path}`)
      files.add(actual)
    }
  }
  const npmProvenance = JSON.parse(readFileSync(join(ui, 'platform-npm-provenance.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(ui, 'package-lock.json'), 'utf8'))
  for (const [name, pin] of Object.entries(spec.platformPackages ?? {})) {
    const packagePath = localInput(ui, `node_modules/${name}/package.json`)
    const bytes = readFileSync(packagePath)
    const actual = JSON.parse(bytes)
    if (actual.name !== name || actual.version !== pin.version || actual.license !== pin.license ||
        digest(bytes) !== pin.packageJsonSha256 || lock.packages[`node_modules/${name}`]?.integrity !== pin.integrity ||
        !pin.licenses.length) throw Error(`Unpinned platform dependency ${name}`)
    for (const license of pin.licenses) localInput(ui, `node_modules/${name}/${license}`)
  }
  for (const row of npmProvenance.files) {
    const actual = localInput(ui, row.path)
    if (digest(readFileSync(actual)) !== row.sha256) throw Error(`Platform npm distribution drift: ${row.path}`)
    files.add(actual)
  }
  return files
}
/** Typecheck actual public entries (and their closure) without emitting files. */
export function typecheckPlatformUi(ui, roots = ['src/modules/platform/main.ts']) {
  ui = realpathSync(ui)
  const vendors = verifiedVendors(ui)
  const aliases = platformTypecheckAliases(ui)
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, allowImportingTsExtensions: true, esModuleInterop: true,
    types: ['react', 'node'], typeRoots: [join(ui, 'node_modules/@types')], skipLibCheck: false,
  }
  const host = ts.createCompilerHost(options)
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (aliases[name]) return {resolvedFileName: aliases[name], extension: aliases[name].endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts}
    const normal = ts.resolveModuleName(name, containingFile, options, host).resolvedModule
    if (normal && (!normal.resolvedFileName.endsWith('.js') || name.startsWith('.'))) return normal
    return ts.resolveModuleName(name, join(ui, '__platform_resolver__.ts'), options, host).resolvedModule ?? normal
  })
  const program = ts.createProgram(['src/modules/platform/primitives/css-modules.d.ts', 'src/modules/shared/assets.d.ts', ...roots].map(path => localInput(ui, path)), options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => ui, getNewLine: () => '\n',
  }))
  const inputs = []
  const ownedErrors = []
  for (const file of program.getSourceFiles()) {
    const actual = realpathSync(file.fileName)
    if (file.isDeclarationFile && actual.includes(`${sep}node_modules${sep}`)) continue
    if (!actual.startsWith(ui + sep)) throw Error(`Platform source import escapes UI: ${actual}`)
    localInput(ui, slash(relative(ui, actual)))
    if (!vendors.has(actual)) { try { assertOwnedSource(ts, file, program.getTypeChecker()) } catch (error) { ownedErrors.push(error.message) } }
    inputs.push({source: slash(relative(ui, actual)), sha256: digest(readFileSync(actual))})
  }
  if (ownedErrors.length) throw Error(ownedErrors.join('\n'))
  return {program, inputs, aliases, vendors}
}
/** Pure assembly input: actual ESM/CSS/font/lazy-grammar outputs plus HTML roles. */
export function compilePlatformUi(ui, spec = {source: 'src/modules/platform/main.ts'}) {
  ui = realpathSync(ui)
  if (spec.source !== 'src/modules/platform/main.ts') throw Error('Unexpected platform entry')
  const checked = typecheckPlatformUi(ui, [spec.source, 'src/modules/platform/bootstrap.ts'])
  const outdir = join(ui, '.xharness-platform-emit')
  const built = esbuild.buildSync({
    absWorkingDir: ui, entryPoints: [join(ui, spec.source)], bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', splitting: true,
    write: false, outdir, entryNames: 'assets/platform-[hash]',
    chunkNames: 'assets/platform/[name]-[hash]', assetNames: 'assets/fonts/[name]-[hash]',
    metafile: true, sourcemap: true, legalComments: 'inline', minify: false,
    jsx: 'automatic', nodePaths: [join(ui, 'node_modules')], alias: platformAliases(ui),
    define: {'process.env.NODE_ENV': '"production"', 'process.versions.node': '"0.0.0"',
      'process.execArgv': '[]', 'process.env.CORDIS_SHARED': 'undefined'},
    loader: {'.module.css': 'local-css', '.woff2': 'file', '.woff': 'file', '.ttf': 'file'},
  })
  const boot = esbuild.buildSync({
    absWorkingDir: ui, entryPoints: [join(ui, 'src/modules/platform/bootstrap.ts')],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
    write: false, outdir, entryNames: 'assets/loader-[hash]',
    metafile: true, sourcemap: true, legalComments: 'inline', minify: false,
  })
  const allOutputs = {...built.metafile.outputs, ...boot.metafile.outputs}
  const outputs = new Map([...built.outputFiles, ...boot.outputFiles].map(file => [slash(relative(outdir, file.path)), Buffer.from(file.contents)]))
  const files = []
  let entryPath
  let preloadPath
  const cssPaths = []
  for (const [name, row] of Object.entries(allOutputs)) {
    const path = slash(relative(outdir, resolve(ui, name)))
    if (row.entryPoint === spec.source) entryPath = path
    if (row.entryPoint === 'src/modules/platform/bootstrap.ts') preloadPath = path
    if (row.cssBundle) cssPaths.push(slash(relative(outdir, resolve(ui, row.cssBundle))))
    const bytes = outputs.get(path)
    if (!bytes) throw Error(`Missing platform output ${path}`)
    const role = row.entryPoint === spec.source ? 'entry' : row.entryPoint === 'src/modules/platform/bootstrap.ts' ? 'bootstrap' : path.endsWith('.css') ? 'stylesheet'
      : /\.(woff2?|ttf)$/.test(path) ? 'font' : path.endsWith('.map') ? 'source-map' : 'module'
    files.push({path, sha256: digest(bytes), bytes: bytes.length, role})
    for (const request of row.imports) {
      if (request.external) throw Error(`Platform dependency escaped bundling: ${request.path}`)
    }
  }
  for (const name of Object.keys({...built.metafile.inputs, ...boot.metafile.inputs})) {
    if (name.startsWith('<define:')) {
      if (!['<define:process.execArgv>'].includes(name)) throw Error(`Unexpected virtual platform input: ${name}`)
      continue
    }
    const actual = localInput(ui, slash(relative(ui, resolve(ui, name))))
    if (!checked.inputs.some(row => row.source === slash(relative(ui, actual)))) checked.inputs.push({source: slash(relative(ui, actual)), sha256: digest(readFileSync(actual))})
  }
  if (!entryPath || !preloadPath) throw Error('Platform builder did not emit both typed boot entries')
  return {outputs, entryPath, preloadPath, inlineBootBytes: outputs.get(preloadPath), cssPaths: [...new Set(cssPaths)], files, inputs: checked.inputs, aliases: platformAliases(ui), typecheckAliases: checked.aliases}
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ui = join(repo, 'ui')
  if (process.argv.includes('--primitives')) {
    const result = typecheckPlatformUi(ui, ['src/modules/platform/primitives/index.ts', 'src/modules/platform/slots/index.ts'])
    console.log(`Strict platform primitives/slots: ${result.inputs.length} local source files`)
  } else {
    const result = compilePlatformUi(ui)
    console.log(JSON.stringify({entryPath: result.entryPath, preloadPath: result.preloadPath, cssPaths: result.cssPaths, files: result.files, inputs: result.inputs}, null, 2))
  }
}
