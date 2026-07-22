// Compile repository-owned ES modules, then enroll their CommonJS module graph
// in the unchanged browser ModuleLoader. TypeScript is a build-only dependency.
import { createRequire } from 'node:module'
import { realpathSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readInput, localPath } from './ui-build-contract.mjs'
import { assertOwnedSource, inspectOwnedSource } from './owned-ui-type-policy.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'ui/package.json'))
const ts = require('typescript')
const esbuild = require('esbuild')

/** Normalize emitter trivia only; literal/template bytes remain untouched. */
export function stripEmissionTrivia(code) {
  const file=ts.createSourceFile('emitted.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  if(file.parseDiagnostics.length)throw Error('Invalid emitted JavaScript')
  const protectedRanges=[]
  const visit=node=>{
    if(ts.isStringLiteralLike(node)||ts.isTemplateExpression(node)||node.kind===ts.SyntaxKind.RegularExpressionLiteral){
      protectedRanges.push([node.getStart(file),node.end]);return
    }
    ts.forEachChild(node,visit)
  }
  visit(file)
  // Never trim a template or a backslash-continued string: spaces can be data.
  const edits=[...code.matchAll(/[ \t]+(?=\r?$)/gm)].filter(match=>
    !protectedRanges.some(([start,end])=>match.index<end&&match.index+match[0].length>start))
  for(const match of edits.reverse())code=code.slice(0,match.index)+code.slice(match.index+match[0].length)
  return code
}

export function compileSourceModules(ui, rows) {
  if (!rows.length) return new Map()
  ui = realpathSync(ui)
  const root = ui
  const vendorSpec = JSON.parse(readInput(ui, {source: 'source-vendors.json'}).toString('utf8'))
  if (vendorSpec.schemaVersion !== 1 || typeof vendorSpec.packages !== 'object' || !vendorSpec.packages) throw Error('Invalid UI vendor specification')
  const vendorCache = new Map()
  const vendorFiles = new Set()
  const vendorDefines = new Map()
  for (const entry of vendorSpec.sourceTrees ?? []) {
    localPath(entry.root, 'vendor root')
    if (!/^src\/modules\/.+\/vendor$/.test(entry.root) || !Array.isArray(entry.licenses) || !entry.licenses.length) throw Error('Invalid third-party source root')
    const defines = entry.defines ?? {}
    if (typeof defines !== 'object' || defines === null || Array.isArray(defines)
      || Object.entries(defines).some(([key, value]) => key === '__DEV__' ? typeof value !== 'boolean'
        : key !== 'process' || typeof value !== 'object' || value === null || Array.isArray(value)
          || Object.keys(value).join() !== 'env' || typeof value.env !== 'object' || value.env === null || Array.isArray(value.env)
          || Object.keys(value.env).join() !== 'NODE_ENV' || !['production','development'].includes(value.env.NODE_ENV))) throw Error('Invalid vendor build defines')
    const prefix = Object.entries(defines).map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`).join('\n')
    const provenance = JSON.parse(readInput(ui, {source: `${entry.root}/PROVENANCE.json`}).toString('utf8'))
    if (provenance.formatVersion !== 1 || !/^[a-f0-9]{40}$/.test(provenance.sourceRevision) || !Array.isArray(provenance.files)) throw Error('Invalid vendor provenance')
    for (const license of entry.licenses) { localPath(license, 'vendor license'); readInput(ui, {source: `${entry.root}/${license}`}) }
    for (const file of provenance.files) {
      localPath(file.path, 'vendor file')
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Unpinned vendor source')
      const source = `${entry.root}/${file.path}`
      readInput(ui, {source, sha256: file.sha256})
      vendorFiles.add(realpathSync(join(ui, source)))
      vendorDefines.set(source, prefix)
    }
  }
  const bundledVendor = name => {
    const sourceSpec = vendorSpec.sourcePackages?.[name]
    if (sourceSpec) {
      if (vendorCache.has(name)) return vendorCache.get(name)
      for (const field of ['root', 'entry', 'sdk', 'metadata']) localPath(sourceSpec[field], `vendor ${field}`)
      if (!vendorSpec.sourceTrees.some(row => row.root === sourceSpec.root)) throw Error(`Source package has no verified source tree: ${name}`)
      const source = `${sourceSpec.root}/${sourceSpec.entry}`
      const metadataPath = `${sourceSpec.root}/${sourceSpec.metadata}`
      const sdkPath = `${sourceSpec.root}/${sourceSpec.sdk}`
      for (const input of [source, metadataPath, sdkPath]) {
        if (!vendorFiles.has(realpathSync(join(ui, input)))) throw Error(`Unpinned source package input: ${input}`)
      }
      const metadata = JSON.parse(readInput(ui, {source: metadataPath}).toString('utf8'))
      if (metadata.name !== name || metadata.version !== sourceSpec.version || metadata.license !== sourceSpec.license) throw Error(`Source package metadata drift: ${name}`)
      const built = esbuild.buildSync({entryPoints:[join(ui, source)], absWorkingDir:ui, bundle:true,
        platform:'browser', format:'cjs', target:'es2020', write:false, metafile:true,
        legalComments:'inline', define:{'process.env.NODE_ENV':'"production"'}})
      for (const path of Object.keys(built.metafile.inputs)) {
        const actual = realpathSync(resolve(ui, path))
        if (!vendorFiles.has(actual)) throw Error(`Source package import escapes pinned inputs: ${name} -> ${path}`)
      }
      if (built.outputFiles.length !== 1 || built.metafile.outputs[Object.keys(built.metafile.outputs)[0]].imports.length) throw Error(`Source package has unbundled dependencies: ${name}`)
      const value = {path:join(ui,'.xharness-source-emit','vendor',`${name}.js`),
        code:stripEmissionTrivia(built.outputFiles[0].text), source:`vendor:${name}@${sourceSpec.version}`}
      vendorCache.set(name,value); return value
    }
    const spec = vendorSpec.packages[name]
    if (!spec) return undefined
    if (vendorCache.has(name)) return vendorCache.get(name)
    const localRequire = createRequire(join(ui, 'package.json'))
    const packagePath = localRequire.resolve(`${name}/package.json`)
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (metadata.version !== spec.version || metadata.license !== spec.license) throw Error(`Unpinned vendor package: ${name}`)
    const entry = localRequire.resolve(name)
    const built = esbuild.buildSync({entryPoints: [entry], absWorkingDir: ui, bundle: true, platform: 'browser',
      format: 'cjs', target: 'es2020', write: false, metafile: true, legalComments: 'inline'})
    for (const path of Object.keys(built.metafile.inputs)) {
      const actual = realpathSync(resolve(ui, path))
      if (!actual.startsWith(join(root, 'node_modules', name) + sep)) throw Error(`Vendor import escapes locked package: ${path}`)
    }
    if (built.outputFiles.length !== 1 || built.metafile.outputs[Object.keys(built.metafile.outputs)[0]].imports.length) throw Error(`Vendor has unbundled dependencies: ${name}`)
    const value = {path: join(ui, '.xharness-source-emit', 'vendor', `${name}.js`), code: stripEmissionTrivia(built.outputFiles[0].text), source: `npm:${name}@${spec.version}`}
    vendorCache.set(name, value); return value
  }
  for (const row of rows) {
    if (!/^src\/modules\/.+\.tsx?$/.test(row.source)) throw Error(`Invalid source module entry: ${row.id}`)
    readInput(ui, row)
  }
  const configPath = join(ui, 'tsconfig.sources.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ui)
  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    if (parsed.options[key] !== true) throw Error(`Owned source compiler must enable ${key}`)
  }
  if (parsed.options.allowJs === true || parsed.options.skipLibCheck === true)
    throw Error('Owned source compiler may not bypass JS/declaration type boundaries')
  // Compile only admitted entries and their transitive imports. Unfinished
  // migration drafts cannot silently enter a release or break another batch.
  const entries = rows.map(row => resolve(ui, row.source))
  for (const path of parsed.fileNames) {
    if (!path.endsWith('.d.ts')) throw Error('Shared source configuration must list only declaration roots')
    readInput(ui, { source: relative(ui, path).split(sep).join('/') })
  }
  // Specific CSS-module declarations must precede raw CSS's wildcard. Owned
  // feature sheets are plain .css; platform .module.css really emits a map.
  const roots = [...parsed.fileNames, ...entries]
  const outDir = join(ui, '.xharness-source-emit') // virtual output, never written
  const options = { ...parsed.options, rootDir: ui, outDir, typeRoots: [join(ui, 'node_modules/@types')], noEmit: false, noEmitOnError: true }
  // The browser loader keeps CommonJS factory emission, while published npm
  // declaration entry points follow modern package exports. Resolve those
  // real declarations with TS's browser resolver, not an invented ambient
  // face or skipLibCheck. This does not bundle a second platform singleton.
  const host = ts.createCompilerHost(options)
  const resolutionOptions = {...options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler}
  host.resolveModuleNames = (names, containingFile) => names.map(name =>
    ts.resolveModuleName(name, containingFile, resolutionOptions, host).resolvedModule)
  const program = ts.createProgram(roots, options, host)
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => ui, getNewLine: () => '\n',
  }))
  const checker = program.getTypeChecker()
  const policyFailures = []
  for (const file of program.getSourceFiles()) {
    const actual = realpathSync(file.fileName)
    if (file.isDeclarationFile && (actual.includes(`${sep}node_modules${sep}`))) continue
    if (!actual.startsWith(root + sep)) throw Error(`Source import escapes UI inputs: ${file.fileName}`)
    readInput(ui, { source: relative(root, actual).split(sep).join('/') })
    if (vendorFiles.has(actual)) {
      // Pinned third-party assertions are exempt, but silencing its compiler is not.
      if (inspectOwnedSource(ts, file).some(error => error.rule === 'disabled-type-check'))
        throw Error(`Disabled source type checking: ${file.fileName}`)
    } else {
      // Report the complete admitted closure in one run, rather than forcing
      // one-file-at-a-time cleanup. This does not relax any source gate.
      try { assertOwnedSource(ts, file, checker) }
      catch (error) { policyFailures.push(error instanceof Error ? error.message : String(error)) }
    }
  }
  if (policyFailures.length) throw Error(policyFailures.join('\n'))
  const emitted = new Map(), originalPaths = new Map()
  const emission = program.emit(undefined, (path, text, _bom, _error, sourceFiles) => {
    if (!path.endsWith('.js')) throw Error(`Unexpected source output: ${path}`)
    emitted.set(resolve(path), stripEmissionTrivia(text))
    if (sourceFiles?.[0]) originalPaths.set(resolve(path), relative(ui, sourceFiles[0].fileName).split(sep).join('/'))
  })
  if (emission.emitSkipped || emission.diagnostics.length) throw Error('Source module emission failed')
  const imports = code => {
    const source = ts.createSourceFile('output.js', code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS)
    const names = new Set()
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw Error('UI runtime imports must be static string literals')
        names.add(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return [...names]
  }
  const compiledPath = source => resolve(outDir, relative(ui, source).replace(/\.tsx?$/, '.js'))
  const results = new Map()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], first = compiledPath(entries[index])
    const units = new Map(), dependencyMap = {}, external = new Set()
    const key = path => relative(outDir, path).split(sep).join('/')
    const visit = path => {
      if (units.has(path)) return
      const code = emitted.get(path)
      if (code === undefined) throw Error(`Missing source output: ${key(path)}`)
      units.set(path, code); dependencyMap[key(path)] = {}
      for (const name of imports(code)) {
        if (!name.startsWith('.')) {
          const vendor = bundledVendor(name)
          if (!vendor) { external.add(name); continue }
          emitted.set(vendor.path, vendor.code); originalPaths.set(vendor.path, vendor.source)
          dependencyMap[key(path)][name] = key(vendor.path); visit(vendor.path); continue
        }
        const base = resolve(dirname(path), name)
        if (name.endsWith('.css')) {
          const source = relative(outDir, base).split(sep).join('/')
          const css = readInput(ui, { source }).toString('utf8')
          emitted.set(base, `Object.defineProperty(exports, '__esModule', { value: true });\nexports.default = ${JSON.stringify(css)};\n`)
          originalPaths.set(base, source)
        }
        const candidates = [base, base + '.js', join(base, 'index.js')]
        const target = candidates.find(candidate => emitted.has(candidate))
        if (!target || !target.startsWith(outDir + sep)) throw Error(`Unresolved local source import: ${key(path)} -> ${name}`)
        dependencyMap[key(path)][name] = key(target); visit(target)
      }
    }
    visit(first)
    const body = [...units].map(([path, code]) => `${JSON.stringify(key(path))}: function(module, exports, require) {\n// source: ${originalPaths.get(path)}\n${vendorDefines.get(originalPaths.get(path)) ?? ''}\n${code}\n}`).join(',\n')
    const bytes = Buffer.from(`// Generated from ${row.source}; do not edit.\nwindow.__ModuleLoader__.load({\nid: ${JSON.stringify(row.id)},\nfactory: (__externalRequire) => {\nconst __units = {\n${body}\n};\nconst __dependencies = ${JSON.stringify(dependencyMap)};\nconst __cache = Object.create(null);\nconst __load = id => {\n  if (__cache[id]) return __cache[id].exports;\n  const unit = __units[id];\n  if (!unit) throw Error('Unknown local UI module: ' + id);\n  const module = { exports: {} };\n  __cache[id] = module;\n  try {\n    unit(module, module.exports, request => Object.prototype.hasOwnProperty.call(__dependencies[id], request)\n      ? __load(__dependencies[id][request]) : __externalRequire(request));\n  } catch (error) { delete __cache[id]; throw error; }\n  return module.exports;\n};\nreturn __load(${JSON.stringify(key(first))});\n}\n});\n`)
    results.set(row.id, { bytes, external: [...external].sort(), sources: [...units.keys()].map(path => originalPaths.get(path)) })
  }
  return results
}
