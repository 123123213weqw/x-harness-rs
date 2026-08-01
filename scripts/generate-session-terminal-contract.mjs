// Compile the Rust-exported JSON Schema, never a parallel handwritten TS DTO.
// Deliberately bounded schema vocabulary: unsupported validation fails the build
// instead of being silently weakened to unknown. No network or Rust subprocess.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export const root = fileURLToPath(new URL('../', import.meta.url))
const schemaPath = resolve(root, 'protocol/session-terminal.schema.json')
const sourcePath = resolve(root, 'ui/src/modules/shared/generated/session-terminal.ts')
const fixturePath = resolve(root, 'scripts/fixtures/session-terminal.json')
const literal = JSON.stringify
const identifier = name => /^[A-Za-z][A-Za-z0-9]*$/.test(name)

export function generateTerminalContract(contract) {
  if (contract.contract !== 'xharness-session-terminal-v1') throw Error('unsupported terminal contract')
  const definitions = new Map()
  function enroll(name, schema) {
    if (!identifier(name)) throw Error('invalid schema identifier')
    const { $defs, $schema, title, ...body } = schema
    const previous = definitions.get(name)
    if (previous && literal(previous) !== literal(body)) throw Error('conflicting schema ' + name)
    definitions.set(name, body)
    for (const [child, value] of Object.entries($defs ?? {})) enroll(child, value)
  }
  for (const [name, schema] of Object.entries(contract.schemas)) enroll(name, schema)
  const annotations = ['description', 'default']
  function only(schema, keys) {
    const allowed = new Set([...annotations, ...keys])
    for (const key of Object.keys(schema)) if (!allowed.has(key)) throw Error('unsupported schema keyword ' + key)
  }
  function disjointTaggedUnion(variants) {
    // z.union has anyOf semantics. Only lower oneOf when exclusivity can be
    // proven from required, distinct literal tags; overlapping alternatives
    // must fail generation rather than silently weaken the Rust contract.
    const tags = new Set()
    for (const variant of variants) {
      const tag = variant?.properties?.kind?.const
      if (variant?.type !== 'object' || !variant.required?.includes('kind')
        || typeof tag !== 'string' || tags.has(tag)) throw Error('unsupported overlapping oneOf')
      tags.add(tag)
    }
  }
  function emit(schema, mode) {
    if (schema === true) return mode === 'type' ? 'unknown' : 'z.unknown()'
    if (schema === false) return mode === 'type' ? 'never' : 'z.never()'
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('invalid schema')
    if (schema.$ref) {
      only(schema, ['$ref'])
      const name = schema.$ref.replace(/^#\/\$defs\//, '')
      if (!definitions.has(name)) throw Error('unresolved schema reference ' + schema.$ref)
      return mode === 'type' ? name : name + 'Schema'
    }
    if (schema.anyOf || schema.oneOf) {
      only(schema, [schema.anyOf ? 'anyOf' : 'oneOf'])
      if (schema.oneOf) disjointTaggedUnion(schema.oneOf)
      const entries = (schema.anyOf ?? schema.oneOf).map(value => emit(value, mode))
      if (!entries.length) throw Error('empty union')
      return mode === 'type' ? '(' + entries.join(' | ') + ')' : entries.length === 1 ? entries[0] : 'z.union([' + entries.join(', ') + '])'
    }
    if ('const' in schema || schema.enum) {
      only(schema, ['type', 'const' in schema ? 'const' : 'enum'])
      const values = 'const' in schema ? [schema.const] : schema.enum
      if (!values.length || values.some(value => !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || schema.type && typeof value !== schema.type)) throw Error('unsupported literal')
      return mode === 'type' ? values.map(literal).join(' | ') : values.length === 1 ? 'z.literal(' + literal(values[0]) + ')' : 'z.union([' + values.map(value => 'z.literal(' + literal(value) + ')').join(', ') + '])'
    }
    if (Array.isArray(schema.type)) {
      // Schemars emits nullable maps as type:[object,null]. Other composite
      // constraints are intentionally refused until a tested lowering exists.
      only(schema, ['type', 'additionalProperties'])
      if (schema.type.length !== 2 || !schema.type.includes('object') || !schema.type.includes('null')) throw Error('unsupported nullable type array')
      return emit({ anyOf: [{ type: 'object', additionalProperties: schema.additionalProperties ?? true }, { type: 'null' }] }, mode)
    }
    switch (schema.type) {
      case 'string':
        only(schema, ['type'])
        if (schema.format) throw Error('unsupported string format ' + schema.format)
        return mode === 'type' ? 'string' : 'z.string()'
      case 'boolean': only(schema, ['type']); return mode === 'type' ? 'boolean' : 'z.boolean()'
      case 'null': only(schema, ['type']); return mode === 'type' ? 'null' : 'z.null()'
      case 'integer':
      case 'number': {
        only(schema, ['type', 'format', 'minimum', 'maximum'])
        if (schema.format && !['uint32', 'int32', 'double', 'float'].includes(schema.format)) throw Error('unsupported number format')
        if (['uint32', 'int32'].includes(schema.format) && schema.type !== 'integer') throw Error('integer format requires integer type')
        for (const bound of ['minimum', 'maximum']) if (schema[bound] !== undefined && !Number.isFinite(schema[bound])) throw Error('invalid numeric bound')
        if (mode === 'type') return 'number'
        let code = schema.type === 'integer' ? 'z.number().int()' : 'z.number()'
        if (schema.format === 'uint32') code += '.min(0).max(4294967295)'
        if (schema.format === 'int32') code += '.min(-2147483648).max(2147483647)'
        if (schema.minimum !== undefined) code += '.min(' + literal(schema.minimum) + ')'
        if (schema.maximum !== undefined) code += '.max(' + literal(schema.maximum) + ')'
        return code
      }
      case 'array': only(schema, ['type', 'items']); return mode === 'type' ? 'ReadonlyArray<' + emit(schema.items, mode) + '>' : 'z.array(' + emit(schema.items, mode) + ')'
      case 'object': {
        only(schema, ['type', 'properties', 'required', 'additionalProperties'])
        const properties = Object.entries(schema.properties ?? {}), required = new Set(schema.required ?? [])
        for (const key of required) if (!properties.some(([name]) => name === key)) throw Error('required property is undefined')
        if (!properties.length) {
          if (schema.additionalProperties === false) return mode === 'type' ? 'Readonly<Record<string, never>>' : 'z.strictObject({})'
          return mode === 'type' ? 'Readonly<Record<string, ' + emit(schema.additionalProperties ?? true, mode) + '>>' : 'z.record(z.string(), ' + emit(schema.additionalProperties ?? true, mode) + ')'
        }
        if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw Error('typed extras on named object are unsupported')
        return mode === 'type'
          ? '{ ' + properties.map(([name, value]) => 'readonly ' + literal(name) + (required.has(name) ? '' : '?') + ': ' + emit(value, mode) + (required.has(name) ? '' : ' | undefined')).join('; ') + ' }'
          : (schema.additionalProperties === false ? 'z.strictObject({' : 'z.looseObject({') + properties.map(([name, value]) => literal(name) + ': ' + emit(value, mode) + (required.has(name) ? '' : '.optional()')).join(', ') + '})'
      }
      default: throw Error('unsupported schema type ' + schema.type)
    }
  }
  const hash = createHash('sha256').update(literal(contract)).digest('hex')
  const rows = [...definitions].sort(([a], [b]) => a.localeCompare(b, 'en'))
  return '// GENERATED from crates/xharness-projection/src/wire.rs. Do not edit.\n'
    + '// Run the remote Rust exporter, then scripts/generate-session-terminal-contract.mjs.\n'
    + "import { z } from 'zod'\n\n"
    + 'export const SESSION_TERMINAL_CONTRACT = ' + literal(contract.contract) + '\n'
    + 'export const SESSION_TERMINAL_SCHEMA_SHA256 = ' + literal(hash) + '\n\n'
    + rows.map(([name, schema]) => 'export type ' + name + ' = ' + emit(schema, 'type')).join('\n') + '\n\n'
    + rows.map(([name, schema]) => 'export const ' + name + 'Schema: z.ZodType<' + name + '> = z.lazy(() => ' + emit(schema, 'schema') + ')').join('\n') + '\n'
}

export function run(args) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') continue
    if (args[index] === '--from' && args[index + 1] && !args[index + 1].startsWith('--')) { index++; continue }
    throw Error('usage: generate-session-terminal-contract.mjs [--from <Rust export directory>] [--check]')
  }
  const check = args.includes('--check'), from = args.indexOf('--from')
  const exported = from < 0 ? undefined : resolve(args[from + 1])
  const schema = JSON.parse(readFileSync(exported ? resolve(exported, 'session-terminal.schema.json') : schemaPath, 'utf8'))
  const outputs = [[sourcePath, generateTerminalContract(schema)]]
  if (exported) {
    outputs.push([schemaPath, JSON.stringify(schema, null, 2) + '\n'])
    const fixture = JSON.parse(readFileSync(resolve(exported, 'session-terminal.fixtures.json'), 'utf8'))
    outputs.push([fixturePath, JSON.stringify(fixture, null, 2) + '\n'])
  }
  for (const [path, expected] of outputs) {
    if (check) {
      if (readFileSync(path, 'utf8') !== expected) throw Error('generated terminal contract drift: ' + path)
    } else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, expected) }
  }
  console.log('session terminal generation ' + (check ? 'checked' : 'updated') + (exported ? ' against actual Rust output' : ' from committed schema'))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2))
