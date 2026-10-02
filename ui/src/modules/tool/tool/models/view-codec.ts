import {z} from 'zod'

/** ToolEventView wire admits arbitrary card tags; only consumed presentation fields are decoded here. */
const title = {title: z.string().optional()}
const terminalCall = z.looseObject({card: z.literal('terminal'), title: z.string().optional(), description: z.string().optional(), cwd: z.string().optional()})
const terminalResult = z.looseObject({card: z.literal('terminal'), ...title, output: z.string().optional(), exitCode: z.number().optional(), signal: z.string().optional()})
const diff = z.looseObject({card: z.literal('diff'), diffs: z.unknown()})
const read = z.looseObject({card: z.literal('read'), ...title, path: z.string(), lines: z.array(z.looseObject({number: z.number(), text: z.string()})), totalLines: z.number(), lang: z.string().optional()})
const search = z.looseObject({card: z.literal('search'), ...title, truncated: z.boolean(), total: z.number(), shape: z.string(), files: z.unknown().optional(), paths: z.unknown().optional()})
const web = z.discriminatedUnion('kind', [
  z.looseObject({card: z.literal('web'), kind: z.literal('search'), answer: z.string().optional(), sources: z.array(z.looseObject({url: z.string(), title: z.string().optional(), snippet: z.string().optional(), publishedAt: z.string().optional()})), truncated: z.boolean()}),
  z.looseObject({card: z.literal('web'), kind: z.literal('fetch'), url: z.string(), statusCode: z.number(), truncated: z.boolean()}),
])
const schemas = {terminalCall, terminalResult, diff, read, search, web}
type ViewMap = {[K in keyof typeof schemas]: z.output<(typeof schemas)[K]>}
/** Validation never replaces the original view or discards foreign producer fields. */
export function isView<K extends keyof ViewMap>(value: unknown, kind: K): value is ViewMap[K] {
  return schemas[kind].safeParse(value).success
}
