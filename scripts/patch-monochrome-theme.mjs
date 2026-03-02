#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function patchMonochromeTheme(dist = join(root, 'ui/dist')) {
  const css = readFileSync(join(root, 'ui/overrides/monochrome.css'))
  const rev = createHash('sha256').update(css).digest('hex').slice(0, 16)
  const indexPath = join(dist, 'index.html')
  let html = readFileSync(indexPath, 'utf8')
  if (!html.includes('</head>')) throw new Error('UI head missing')
  html = html.replace(/\s*<link\b[^>]*\bdata-xh-monochrome[^>]*>\s*/g, '')
  html = html.replace('</head>', `\n<link rel="stylesheet" data-xh-monochrome href="/monochrome.css?rev=${rev}">\n</head>`)
  writeFileSync(join(dist, 'monochrome.css'), css)
  writeFileSync(indexPath, html)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchMonochromeTheme(process.argv[2] ? resolve(process.argv[2]) : undefined)
}
