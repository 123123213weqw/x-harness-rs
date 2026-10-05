import type { EmulatedRegExp } from 'oniguruma-to-es'

/** Build-time converter output; the TextMate grammar still owns all patterns. */
export type CompiledPattern = readonly [
  original: string,
  source: string,
  flags: string,
  options: EmulatedRegExp['rawOptions'],
]
