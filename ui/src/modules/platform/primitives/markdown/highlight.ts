/**
 * The client's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Colors live in the
 * theme package's token sheets as `--shiki-*` custom properties (light and
 * dark blocks), never here — the repo's tokens-only styling rule.
 *
 * Every grammar, including common fences, loads only when rendered. The
 * read card's wider extension set (the file-extension language hints the read
 * tool's `langFromPath` emits — `packages/fs/tool-fs`: python, rust, yaml,
 * markup, …) is imported lazily and registered the first time such a language
 * is requested, so a session that never opens a read card in one of those
 * languages pays neither the ~1.6 MB of grammar modules nor their synchronous
 * init. The first render of a lazy language falls back to plain text while its
 * grammar loads, then {@link subscribeGrammarLoaded} notifies subscribers to re-render
 * with highlighting. An unknown or absent language falls back to plain text (no
 * highlighting, still monospace) — never an error.
 */

import type { HighlighterCore } from 'shiki/core'
import type { LanguageRegistration } from '@shikijs/types'
import type { CSSProperties } from 'react'
import type { CompiledPattern } from './regex-cache/types'

type LangModule = { default: LanguageRegistration[] }

const BUNDLED_EMBEDDED = new Set(['typescript', 'shellscript', 'json'])

/** Original pinned grammars load only when requested. Build-time regex caches
 * accelerate common code fences without rewriting the TextMate patterns or
 * losing dynamic backreferences. Unknown patterns still use the same engine.
 */
const GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['typescript', () => import('@shikijs/langs/typescript')],
  ['shellscript', () => import('@shikijs/langs/shellscript')],
  ['json', () => import('@shikijs/langs/json')],
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
])

/**
 * Language ids (and aliases) the highlighter accepts; everything else renders
 * plain. A Map, not an object: fence info strings are assistant-authored, so
 * a label like `constructor` or `__proto__` must miss instead of resolving an
 * inherited property and crashing the renderer inside shiki. Keys cover both
 * the markdown-fence aliases `CodeBlock` uses and the file-extension hint ids
 * the read tool's `langFromPath` emits, so both callers resolve the same
 * grammars. The JS family maps to the TypeScript grammar (see {@link GRAMMARS} for
 * the JSX/TSX approximation). Each value names a grammar loaded on first use.
 */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
])

/** The engine sees the exact original pattern strings. The cache only saves
 * conversion work; a missing pattern (including a dynamic end delimiter)
 * always goes through the original forgiving converter.
 */
const regexCache = new Map<string, RegExp | Error>()
/** Pinned conversion caches target ES2018: WebKit compiles its `u` patterns
 * much faster than equivalent `v` patterns. Original TextMate strings stay
 * intact; patterns not expressible at that target are omitted and use the
 * original auto-target converter. These are data strings, not grammar rewrites.
 */
const PREPARED_CACHES = new Map<string, () => Promise<{entries: readonly CompiledPattern[]}>>([
  ['typescript', () => import('./regex-cache/typescript-es2018')],
  ['shellscript', () => import('./regex-cache/shellscript-es2018')],
  ['json', () => import('./regex-cache/json-es2018')],
])

let singleton: HighlighterCore | undefined
let creating: Promise<HighlighterCore> | undefined

/** Representative paths compiled only when that grammar is requested. */
const GRAMMAR_WARMUPS = new Map<string, string>([
  ['typescript', 'const answer: number = 42'],
  ['shellscript', 'printf \'%s\\n\' "$HOME"'],
  ['json', '{"ready":true}'],
])

/** Even SDK parsing/theme/core construction waits for a real code read.
 * No speculative warm-up runs while the first screen is mounting.
 */
function highlighter(): Promise<HighlighterCore> {
  creating ??= (async () => {
    const [{ createHighlighterCoreSync, createCssVariablesTheme },
      { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor }] = await Promise.all([
      import('shiki/core'), import('shiki/engine/javascript'),
    ])
    const instance = createHighlighterCoreSync({
      themes: [createCssVariablesTheme({name: 'css-variables', variablePrefix: '--shiki-', fontStyle: true})],
      langs: [],
      engine: createJavaScriptRegexEngine({
        forgiving: true, cache: regexCache,
        regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
          lazyCompileLength: Number.POSITIVE_INFINITY,
        }),
      }),
    })
    singleton = instance
    return instance
  })()
  return creating
}

/** Grammar ids whose lazy import is in flight or done, so it is requested once. */
const pending = new Map<string, Promise<void>>()
/** Subscribers re-rendered after a lazy grammar registers (React callers). */
const listeners = new Set<() => void>()
/** Bumped on each lazy-grammar load; the `useSyncExternalStore` snapshot. */
let loadCount = 0

/**
 * Subscribe to lazy-grammar load completions; `listener` fires after a
 * {@link GRAMMARS} grammar finishes registering on the singleton, so a
 * caller that rendered its plain fallback while the grammar loaded can
 * re-highlight. Uses the `useSyncExternalStore` subscribe signature; pair it with
 * {@link grammarLoadCount} as the snapshot. Returns an unsubscribe function.
 * @param listener - invoked (no args) on each grammar-load completion.
 * @returns a disposer that removes the listener.
 */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The lazy-grammar load counter — a value that changes on every load, so a
 * `useSyncExternalStore` snapshot re-renders the subscriber when a grammar
 * registers. Opaque: only its identity across renders matters.
 * @returns the current load count.
 */
export function grammarLoadCount(): number {
  return loadCount
}

/** Load once, including the bundled scopes that were previously available
 * for a Markdown/MDX read. Metadata, not extensions, declares that dependency.
 */
function loadGrammar(resolved: string): Promise<void> {
  const existing = pending.get(resolved)
  if (existing !== undefined) return existing
  const load = GRAMMARS.get(resolved)
  if (load === undefined) return Promise.resolve()
  const prepared = PREPARED_CACHES.get(resolved)
  const promise = Promise.all([load(), prepared?.().catch((error: unknown) => {
    // Optional acceleration must not disable a readable/highlightable grammar.
    console.warn('Syntax cache unavailable:', resolved, error)
    return undefined
  })]).then(async ([mod, cache]) => {
    if (cache !== undefined) {
      const { EmulatedRegExp } = await import('oniguruma-to-es')
      for (const [pattern, source, flags, options] of cache.entries) {
        if (!regexCache.has(pattern)) regexCache.set(pattern, new EmulatedRegExp(source, flags, options))
      }
    }
    const dependencies = new Set<string>()
    for (const grammar of mod.default) {
      for (const embedded of grammar.embeddedLangsLazy ?? []) {
        if (BUNDLED_EMBEDDED.has(embedded) && embedded !== resolved) dependencies.add(embedded)
      }
    }
    await Promise.all([...dependencies].map(loadGrammar))
    const instance = await highlighter()
    instance.loadLanguageSync(mod.default)
    const sample = GRAMMAR_WARMUPS.get(resolved)
    if (sample !== undefined) {
      instance.codeToTokens(sample, {lang: resolved, theme: 'css-variables', tokenizeTimeLimit: 0})
    }
    loadCount += 1
    for (const listener of listeners) listener()
  })
  pending.set(resolved, promise)
  return promise
}

/** Plain text immediately, then re-highlight through the existing store
 * subscription. A missing grammar remains readable and does not reject app
 * boot or repeatedly request a failed asset on every streaming render.
 */
function ensureGrammar(resolved: string): boolean {
  if (singleton?.getLoadedLanguages().includes(resolved)) return true
  if (!pending.has(resolved)) {
    void loadGrammar(resolved).catch((error: unknown) => {
      console.warn('Syntax grammar unavailable:', resolved, error)
    })
  }
  return false
}

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback. A lazy grammar not yet loaded returns `undefined`
 * for this call and loads in the background; subscribe with
 * {@link subscribeGrammarLoaded} to re-highlight once it registers.
 * @param code - the source text.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns the highlighted HTML, or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  return singleton?.codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}

/**
 * One highlighted run of a line: the text and the inline style shiki assigned
 * it. The css-variables theme colors every run through a `--shiki-*` custom
 * property, so `style.color` is always present; it is held as a style object
 * rather than a bare color so a run spreads onto a `<span style>` uniformly.
 */
export interface HighlightSpan {
  text: string
  style: CSSProperties
}

/**
 * Tokenize `code` into per-line highlighted runs when `lang` maps to a
 * registered grammar; `undefined` means the caller renders its plain fallback.
 * A line-numbered view needs the token runs split per line (one gutter number
 * per line), which the single-`<pre>` {@link highlightToHtml} does not expose,
 * so this returns shiki's own 2D line/token structure narrowed to what a run
 * renders. Each run's color is a `--shiki-*` custom property, keeping token
 * colors on the theme package's sheets exactly as the HTML path does; the
 * css-variables theme carries no font-style bits, matching that path's
 * color-only output. The trailing newline shiki appends as a final empty line
 * is dropped so the run count matches the caller's own line array.
 * @param code - the source text.
 * @param lang - the language hint (a file-extension-derived language id).
 * @returns one entry per source line (each an array of runs), or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightLines(code: string, lang: string | undefined): HighlightSpan[][] | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  const instance = singleton
  if (instance === undefined) return undefined
  const { tokens } = instance.codeToTokens(code, { lang: resolved, theme: 'css-variables' })
  // shiki tokenizes `a\nb` into two lines; a trailing newline (`a\n`) adds a
  // third, empty line the caller's own line array does not carry. Drop that
  // one terminator line so the two structures stay in step. The explicit
  // `last !== undefined` (over `tokens[...]?.length`) keeps a single branch for
  // per-file coverage, matching TerminalBlock's terminator check.
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  return lines.map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
}
