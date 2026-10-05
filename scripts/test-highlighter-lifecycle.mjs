/** Strict actual platform source; mock only the expensive third-party core. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import vm from 'node:vm'
import {typecheckPlatformUi} from './build-platform-ui.mjs'
import {verifyPreparedCaches} from './prepare-platform-regex-cache.mjs'
await verifyPreparedCaches()

const ui = resolve('ui'), require = createRequire(resolve(ui, 'package.json')), ts = require('typescript')
typecheckPlatformUi(ui)
const code = ts.transpileModule(readFileSync(resolve(ui, 'src/modules/platform/primitives/markdown/highlight.ts'), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText
function fixture({failed = false, failedCache = false} = {}) {
  const exports = {}, registered = [], warmups = [], scans = [], imports = []
  let created = 0, timers = 0, warnings = 0, engineCache
  const core = {
    loadLanguageSync: grammar => registered.push(...grammar.map(row => row.name)),
    getLoadedLanguages: () => [...registered],
    codeToHtml: (code, options) => {scans.push(options.lang); return `<pre>${code}</pre>`},
    codeToTokens: (code, options) => {
      if (options.tokenizeTimeLimit === 0) warmups.push(options.lang)
      else scans.push(options.lang)
      return {tokens: [[{content: code, color: 'var(--shiki-token)'}], []]}
    },
  }
  const dependencies = {
    'shiki/core': {createCssVariablesTheme: () => ({}), createHighlighterCoreSync: options => {
      assert.deepEqual(Array.from(options.langs), [], 'construction must not register unused grammars')
      created++; return core
    }},
    'shiki/engine/javascript': {createJavaScriptRegexEngine: options => {engineCache=options.cache; return {}}, defaultJavaScriptRegexConstructor: () => ({})},
    'oniguruma-to-es': {EmulatedRegExp: RegExp},
    '@shikijs/langs/typescript': {default: [{name: 'typescript'}]},
    '@shikijs/langs/shellscript': {default: [{name: 'shellscript'}]},
    '@shikijs/langs/json': {default: [{name: 'json'}]},
    '@shikijs/langs/python': {default: [{name: 'python'}]},
    '@shikijs/langs/markdown': {default: [{name: 'markdown', embeddedLangsLazy: ['typescript', 'json', 'unknown-embedded']}]},
  }
  for (const language of ['typescript', 'shellscript', 'json']) {
    dependencies[`./regex-cache/${language}-es2018`] = {entries:[[language, language, 'g', {}]]}
  }
  vm.runInNewContext(code, {exports,
    console: {warn: () => warnings++}, setTimeout: () => {timers++}, require: name => {
      assert.ok(name in dependencies, name); imports.push(name)
      if (failed && name === '@shikijs/langs/typescript') throw Error('fixture asset unavailable')
      if (failedCache && name.startsWith('./regex-cache/')) throw Error('fixture cache unavailable')
      return dependencies[name]
    }})
  return {api: exports, registered, warmups, scans, imports, get cache() {return engineCache}, get created() {return created}, get timers() {return timers}, get warnings() {return warnings}}
}
const settle = () => new Promise(resolve => setImmediate(resolve))
test('import/unknown languages do not construct, register or schedule speculative grammar work', () => {
  const h = fixture()
  for (const lang of [undefined, '', 'unknown', 'constructor', '__proto__', 'toString']) {
    assert.equal(h.api.highlightToHtml('raw text', lang), undefined)
    assert.equal(h.api.highlightLines('raw text', lang), undefined)
  }
  assert.equal(h.created, 0); assert.equal(h.timers, 0); assert.deepEqual(h.registered, [])
})
test('grammar loader: ES2018 cache imports, aliases, one core and exact subscription', async () => {
  const h = fixture(); let notifications = 0
  h.api.subscribeGrammarLoaded(() => notifications++)
  assert.equal(h.api.highlightToHtml('{"x":1}', 'JSON'), undefined)
  assert.equal(h.api.highlightToHtml('{}', 'jsonc'), undefined)
  await settle()
  assert.equal(h.api.highlightToHtml('{"x":1}', 'JSON'), '<pre>{"x":1}</pre>')
  assert.deepEqual(h.registered, ['json']); assert.deepEqual(h.warmups, ['json'])
  h.api.highlightToHtml('const x = 1', 'js'); h.api.highlightToHtml('const x = 2', 'tsx'); await settle()
  h.api.highlightToHtml('printf x', 'zsh'); await settle()
  assert.deepEqual(h.registered, ['json', 'typescript', 'shellscript'])
  assert.deepEqual(h.warmups, ['json', 'typescript', 'shellscript']); assert.equal(h.created, 1)
  assert.deepEqual(h.imports.filter(name => name.startsWith('@shikijs/langs')), ['@shikijs/langs/json', '@shikijs/langs/typescript', '@shikijs/langs/shellscript'])
  assert.deepEqual(h.imports.filter(name => name.startsWith('./regex-cache/')), ['json','typescript','shellscript'].map(name=>`./regex-cache/${name}-es2018`))
  assert.equal(h.cache.size, 3); assert.ok(h.cache.get('typescript') instanceof RegExp)
  assert.equal(notifications, 3); assert.equal(h.api.grammarLoadCount(), 3)
})
test('read-line output preserves text/trailing newline and shares registration with code blocks', async () => {
  const h = fixture(); assert.equal(h.api.highlightLines('const x = 1', 'ts'), undefined); await settle()
  const lines = h.api.highlightLines('const x = 1', 'ts')
  assert.equal(lines.length, 1); assert.equal(lines[0][0].text, 'const x = 1')
  h.api.highlightToHtml('const y = 2', 'typescript')
  assert.deepEqual(h.registered, ['typescript']); assert.deepEqual(h.warmups, ['typescript'])
})
test('wider grammar requests deduplicate; unsubscribe prevents callbacks and no unrelated boot grammar loads', async () => {
  const h = fixture(); let notifications = 0, unsubscribed = 0
  h.api.subscribeGrammarLoaded(() => notifications++)
  const off = h.api.subscribeGrammarLoaded(() => unsubscribed++); off(); off()
  assert.equal(h.api.highlightToHtml('print(42)', 'python'), undefined)
  assert.equal(h.api.highlightLines('print(42)', 'py'), undefined); await settle()
  assert.equal(h.imports.filter(x => x === '@shikijs/langs/python').length, 1)
  assert.deepEqual(h.registered, ['python']); assert.deepEqual(h.warmups, [])
  assert.equal(notifications, 1); assert.equal(unsubscribed, 0); assert.equal(h.api.grammarLoadCount(), 1)
})
test('embedded scopes come from grammar metadata; Markdown retains bundled fence highlighting', async () => {
  const h = fixture(); h.api.highlightToHtml('```ts\nconst answer = 42\n```', 'md'); await settle()
  assert.deepEqual(h.registered, ['typescript', 'json', 'markdown'])
  assert.deepEqual(h.warmups, ['typescript', 'json']); assert.equal(h.api.grammarLoadCount(), 3)
  h.api.highlightToHtml('const answer = 42', 'ts'); assert.deepEqual(h.warmups, ['typescript', 'json'])
})
test('failed assets warn once, remain plain/readable, and never create an import retry/render loop', async () => {
  const h = fixture({failed: true}); h.api.highlightToHtml('raw code', 'ts'); await settle()
  for (let i = 0; i < 50; i++) assert.equal(h.api.highlightToHtml('raw code', 'ts'), undefined)
  await settle(); assert.equal(h.warnings, 1); assert.equal(h.created, 0)
  assert.equal(h.imports.filter(x => x === '@shikijs/langs/typescript').length, 1)
})

test('optional acceleration asset failure falls back to original grammar, not a broken code card', async () => {
  const h = fixture({failedCache:true}); h.api.highlightToHtml('const x = 1', 'ts'); await settle()
  assert.equal(h.api.highlightToHtml('const x = 1', 'ts'), '<pre>const x = 1</pre>')
  assert.equal(h.warnings, 1); assert.equal(h.cache.size, 0); assert.deepEqual(h.registered, ['typescript'])
})

// Actual pinned SDK, not mocked: cache serialization must preserve semantic
// tokenization, including Bash's dynamically constructed here-doc delimiters.
const coreSdk = await import(require.resolve('shiki/core'))
const engineSdk = await import(require.resolve('shiki/engine/javascript'))
const {EmulatedRegExp} = require('oniguruma-to-es')
const samples = {
  typescript: ['const answer: number = 42', 'interface Pair<T> {first: T; second: T}',
    'export async function main<T>(x: T) { return await Promise.resolve(x) }',
    '// 中文\nconst rx = /(?<n>\\d+)\\s+/giu;', 'const s = `a${1 + 2}b`;',
    '/* comment\n * multiple lines\n */\nclass A extends B { private x = true; }',
    'const x = "unterminated', 'const x = `unterminated ${value', 'const π: number = 1; const 中文 = "👋";', 'const x = 1;\r\nconsole.log(x);\r\n', ''],
  shellscript: [`printf '%s\\n' "$HOME"`,
    '#!/bin/bash\nset -euo pipefail\nfor x in "$@"; do echo "${x:-none}"; done',
    `cat <<'EOF'\nhello $HOME\nEOF\necho done`,
    'cat <<END\nhello $HOME\nEND\necho done',
    'cat <<-MARK\n\thello\n\tMARK\n',
    'x=$(printf ok)\nif [[ $x == ok ]]; then :; fi',
    '# 中文\nx="unterminated', ''],
  json: ['{"x":1,"text":"中文","nested":[true,null]}',
    '{\n  "a": "\\u1234",\n  "b": -1.2e+3\n}',
    '// comment\n{"trailing": 1,}', '{"stream":"unfinished', ''],
}
Object.assign(samples, {
  python:['# 中文\ndef answer(x: int = 42):\n    return f"value={x}"', 's = """multi\nline"""\nprint(s)'],
  rust:['// 中文\nfn main() { let x: Option<u32> = Some(42); println!("{x:?}"); }'],
  yaml:['# comment\nitems:\n  - name: 中文\n    enabled: true'],
  markdown:['# Title\n**bold** and `code`\n\n```json\n{"x":42}\n```'],
  mdx:['# Title\n<Component value={42}>**bold**</Component>'],
  html:['<!doctype html>\n<div class="test">中文<!-- comment --></div>'],
  css:['/* comment */\n.test { color: #fff; width: calc(100% - 1px); }'],
  go:['package main\nfunc main() { x := 42; fmt.Println(x) }'],
  ruby:['# comment\ndef answer(x = 42)\n  "value=#{x}"\nend'],
  java:['public class Main { public static void main(String[] args) { System.out.println(42); } }'],
  c:['#include <stdio.h>\nint main(void) { printf("%d", 42); return 0; }'],
  cpp:['#include <vector>\nint main() { std::vector<int> xs{1,2}; return xs.size(); }'],
  csharp:['public class Main { public static int Answer() => 42; }'],
  kotlin:['fun main() { val answer: Int = 42; println(answer) }'],
  swift:['let answer: Int = 42\nprint(answer)'],
  php:['<?php $answer = 42; echo "value=$answer"; ?>'],
  toml:['# comment\n[server]\nport = 8080\nenabled = true'],
  ini:['; comment\n[server]\nport=8080'],
  scss:['$color: #fff;\n.test { &:hover { color: $color; } }'],
  less:['@color: #fff;\n.test { color: @color; }'],
  sql:["-- comment\nSELECT name, COUNT(*) FROM items WHERE enabled = TRUE GROUP BY name;"],
  xml:['<?xml version="1.0"?><root name="test"><item>中文</item><!-- comment --></root>'],
  lua:['-- comment\nlocal answer = 42\nfunction main(x) return x + answer end'],
})
test('actual pinned SDK: ES2018 cache preserves original auto-target HTML across all supported languages', async () => {
  const entries = []
  for (const lang of ['typescript','shellscript','json']) {
    const compiled = ts.transpileModule(readFileSync(resolve(ui, `src/modules/platform/primitives/markdown/regex-cache/${lang}-es2018.ts`), 'utf8'), {
      compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
    }).outputText
    const exports = {}; vm.runInNewContext(compiled,{exports}); entries.push(...exports.entries)
  }
  for (const [lang, texts] of Object.entries(samples)) {
    const grammar = (await import(require.resolve(`@shikijs/langs/${lang}`))).default
    const cache = new Map(entries.map(([pattern,source,flags,options]) => [pattern,new EmulatedRegExp(source,flags,options)]))
    const make = cache => coreSdk.createHighlighterCoreSync({
      langs:grammar, themes:[coreSdk.createCssVariablesTheme({name:'css-variables',variablePrefix:'--shiki-',fontStyle:true})],
      engine:engineSdk.createJavaScriptRegexEngine({forgiving:true,cache,
        regexConstructor:pattern=>engineSdk.defaultJavaScriptRegexConstructor(pattern,{lazyCompileLength:Infinity})}),
    })
    const baseline = make(new Map()), optimized = make(cache)
    for (const code of texts) assert.equal(optimized.codeToHtml(code,{lang,theme:'css-variables',tokenizeTimeLimit:0}),baseline.codeToHtml(code,{lang,theme:'css-variables',tokenizeTimeLimit:0}),`${lang}: ${code}`)
    baseline.dispose(); optimized.dispose()
  }
})
