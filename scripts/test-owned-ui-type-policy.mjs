import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { inspectOwnedSource, assertOwnedSource } from './owned-ui-type-policy.mjs'
const require = createRequire(resolve('ui/package.json'))
const ts = require('typescript')
function syntax(code) { return ts.createSourceFile('owned.ts', code, ts.ScriptTarget.Latest, true) }
for (const [label, code, rule] of [
  ['explicit any', 'export const x: any = 1', 'explicit-any'],
  ['cast', 'export const x = {} as { id: string }', 'type-assertion'],
  ['double cast', 'export const x = {} as unknown as { id: string }', 'type-assertion'],
  ['angle cast', 'export const x = <{ id: string }>{}', 'type-assertion'],
  ['non-null cast', 'export const x = document.querySelector("button")!', 'non-null-assertion'],
  ['ignore', '// @ts-ignore\nexport const x: number = "bad"', 'disabled-type-check'],
  ['nocheck', '// @ts-nocheck\nexport const x: number = "bad"', 'disabled-type-check'],
  ['expect-error', '// @ts-expect-error\nexport const x: number = "bad"', 'disabled-type-check'],
]) test(`reject ${label}`, () => {
  const file = syntax(code), errors = inspectOwnedSource(ts, file)
  assert.ok(errors.some(error => error.rule === rule))
  assert.throws(() => assertOwnedSource(ts, file), /Owned UI|Disabled source/)
})
for (const [label, code] of [
  ['literal preservation', 'export const x = { kind: "known", n: 1 } as const'],
  ['import/export aliases', 'import { a as b } from "module"; export { b as c }'],
  ['satisfies', 'export const x = { n: 1 } satisfies { n: number }'],
  ['unknown guard', 'export function object(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) }'],
  ['text mentions', 'export const x = "as unknown as T; @ts-ignore; any"'],
  ['regex text mentions', String.raw`export const x = /\/\/ @ts-ignore; any as T/`],
  ['template raw text mentions', 'export const x = `@ts-ignore ${1} // @ts-nocheck`;'],
  ['non-directive comments', '// any value may need validation; x as T is forbidden\nexport const x = 1'],
  ['logical negation', 'export const empty = !document.querySelector("button")'],
]) test(`allow ${label}`, () => assert.deepEqual(inspectOwnedSource(ts, syntax(code)), []))
function semantic(code) {
  const name = join(process.cwd(), 'owned-policy-semantic.ts')
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, types: ['react'], moduleResolution: ts.ModuleResolutionKind.Node10, typeRoots: [resolve('ui/node_modules/@types')] }
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host)
  host.readFile = file => file === name ? code : read(file)
  host.fileExists = file => file === name || exists(file)
  const program = ts.createProgram([name], options, host)
  assert.deepEqual(ts.getPreEmitDiagnostics(program), [], 'semantic fixture itself must strictly typecheck')
  const file = program.getSourceFile(name)
  assert.ok(file)
  return inspectOwnedSource(ts, file, program.getTypeChecker())
}
test('reject inferred any from an untyped library boundary', () => {
  const errors = semantic('export const body = JSON.parse("{}"); export function reply() { return JSON.parse("{}"); }')
  assert.ok(errors.some(error => error.rule === 'inferred-any'))
  assert.ok(errors.some(error => error.rule === 'any-return'))
})
test('receive a library reply as unknown before narrowing, never assume fields', () => {
  assert.deepEqual(semantic('export const body: unknown = JSON.parse("{}"); export function reply(): unknown { return JSON.parse("{}"); }'), [])
})
test('ordinary functions keep sound inference', () => {
  assert.deepEqual(semantic('export const n = 3; export function add(a: number, b: number) { return a + b; }'), [])
})

test('directives within template expressions and after regex literals remain forbidden', () => {
  for (const code of [
    'export const x = `${ /* @ts-ignore */ 1 }`',
    String.raw`export const x = /\/\//; // @ts-ignore` + '\nexport const y = 1',
    'export const x = `before ${1} after`; // @ts-expect-error\nexport const y = 1',
  ]) assert.ok(inspectOwnedSource(ts, syntax(code)).some(error => error.rule === 'disabled-type-check'), code)
})
test('async and container inference cannot hide an any boundary', () => {
  const errors = semantic('export const rows = [JSON.parse("{}")]; export async function reply() { return JSON.parse("{}"); }')
  assert.ok(errors.some(error => error.rule === 'inferred-any'))
  assert.ok(errors.some(error => error.rule === 'any-return'))
})

test('vendor React component types do not masquerade as owned any bindings', () => {
  assert.deepEqual(semantic('import type * as React from "react"; export interface Slots { register<P>(component: React.ComponentType<P>): void; } export function jsx(): React.ReactElement { throw Error("fixture"); }'), [])
})
