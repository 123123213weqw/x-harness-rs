// Strict TS -> plain script assets. Original URL/DOM/native-command ABI stays unchanged.
import {createRequire} from 'node:module'
import {readFileSync, realpathSync} from 'node:fs'
import {join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {readInput, localPath, sha256} from './ui-build-contract.mjs'
import {assertOwnedSource} from './owned-ui-type-policy.mjs'
const repo = resolve(fileURLToPath(new URL('../', import.meta.url)))
const require = createRequire(join(repo, 'ui/package.json'))
const ts = require('typescript'), esbuild = require('esbuild')
export function compileScriptAssets(ui, rows) {
  if (!rows.length) return new Map()
  ui = realpathSync(ui)
  const entries = rows.map(row => {
    localPath(row.path, 'script asset target')
    if (!/^src\/desktop\/.+\.ts$/.test(row.source) || !row.path.endsWith('.js')) throw Error('Invalid owned script asset')
    readInput(ui, row); return join(ui, row.source)
  })
  const options = {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, types: [], typeRoots: [join(ui, 'node_modules/@types')],
    lib: ['lib.es2024.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']}
  const program = ts.createProgram(entries, options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => ui, getNewLine: () => '\n',
  }))
  const checker = program.getTypeChecker(), sources = []
  for (const file of program.getSourceFiles()) {
    const actual = realpathSync(file.fileName)
    if (file.isDeclarationFile && actual.includes(`${sep}node_modules${sep}`)) continue
    if (!actual.startsWith(ui + sep)) throw Error(`Script source escapes UI: ${actual}`)
    const source = relative(ui, actual).split(sep).join('/')
    const bytes = readInput(ui, {source})
    assertOwnedSource(ts, file, checker); sources.push({source, sha256:sha256(bytes)})
  }
  const result = new Map()
  for (let i = 0; i < rows.length; i++) {
    const built = esbuild.buildSync({entryPoints: [entries[i]], bundle: true,
      absWorkingDir: ui, format: 'iife', platform: 'browser', target: 'es2020',
      write:false, legalComments:'inline', metafile:true,
      loader:{'.raw.css':'text','.svg':'text'}})
    if (built.outputFiles.length !== 1 || Object.values(built.metafile.outputs).some(row => row.imports.length))
      throw Error('Script asset escaped bundling')
    for (const path of Object.keys(built.metafile.inputs)) readInput(ui, {source: relative(ui, resolve(ui,path)).split(sep).join('/')})
    result.set(rows[i].path, {bytes: Buffer.from(built.outputFiles[0].contents), sources})
  }
  return result
}
