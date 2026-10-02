#!/usr/bin/env node
// Typecheck the owned TS boundary, then emit the existing ModuleLoader
// format. No new runtime loader, bundler or framework is introduced.
import { createRequire } from 'node:module'
import { assertOwnedSource } from './owned-ui-type-policy.mjs'
import { readInput } from './ui-build-contract.mjs'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
let target = resolve(root, 'ui/dist/plugins/@xlang/xharness-client-plugin-api/client.js')
let check = false
let explicitOutput = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check' && !check) check = true
  else if (args[i] === '--output' && args[i + 1] && !explicitOutput) { target = resolve(args[++i]); explicitOutput = true }
  else throw new Error('usage: build-plugin-api.mjs [--check] [--output FILE]')
}
if (!check && !explicitOutput) throw Error('Use npm run build --prefix ui for atomic production assembly; isolated compilation requires --output FILE')
const output = mkdtempSync(join(tmpdir(), 'xharness-ui-types-'))
try {
  const ui = resolve(root, 'ui')
  const require = createRequire(join(ui, 'package.json'))
  const ts = require('typescript')
  const configPath = join(ui, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ui)
  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    if (parsed.options[key] !== true) throw Error(`Plugin API compiler must enable ${key}`)
  }
  if (parsed.options.allowJs === true || parsed.options.skipLibCheck === true)
    throw Error('Plugin API compiler may not bypass JS/declaration type boundaries')
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir: output, typeRoots: [join(ui, 'node_modules/@types')] })
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => ui, getNewLine: () => '\n',
  }))
  const checker = program.getTypeChecker()
  for (const file of program.getSourceFiles()) {
    const path = realpathSync(file.fileName)
    if (file.isDeclarationFile && path.includes(`${sep}node_modules${sep}`)) continue
    if (!path.startsWith(ui + sep)) throw Error(`Plugin API source escapes UI: ${path}`)
    readInput(ui, {source: relative(ui, path).split(sep).join('/')})
    assertOwnedSource(ts, file, checker)
  }
  const emission = program.emit()
  if (emission.emitSkipped || emission.diagnostics.length) throw Error('Plugin API emission failed')
  const compiled = readFileSync(join(output, 'src/plugin-api/client.js'), 'utf8')
  if (/\brequire\s*\(/.test(compiled)) throw new Error('Plugin API must not acquire runtime package imports')
  const bytes = `// Generated from ui/src/plugin-api/client.ts; do not edit.\nwindow.__ModuleLoader__.load({\n  id: '@xlang/xharness-client-plugin-api',\n  factory: () => {\n    const exports = {};\n${compiled.split('\n').map(line => `    ${line}`).join('\n')}\n    return exports;\n  },\n});\n`
  if (check) {
    if (readFileSync(target, 'utf8') !== bytes) throw new Error('Generated Plugin API is stale; npm run build --prefix ui')
  } else {
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
  }
  console.log(`Plugin API: strict owned TS passed; ${check ? 'artifact verified' : 'ModuleLoader artifact emitted'}`)
} finally { rmSync(output, { recursive: true, force: true }) }
