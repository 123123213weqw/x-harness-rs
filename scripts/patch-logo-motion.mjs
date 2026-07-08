#!/usr/bin/env node
// Publish brand motion styles and the page-visibility hook. Brand geometry
// is maintained separately by the source overrides and patch-brand-mark.mjs.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.argv[2] || 'ui/dist')
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 12)
const indexPath = join(dist, 'index.html')
let html = readFileSync(indexPath, 'utf8')
for (const ext of ['css', 'js']) {
  const data = readFileSync(new URL(`../ui/overrides/logo-motion.${ext}`, import.meta.url))
  writeFileSync(join(dist, `logo-motion.${ext}`), data)
  html = html.replace(new RegExp(`\\s*<(?:link|script)\\b[^>]*data-xh-logo-motion-${ext}[^>]*>(?:<\\/script>)?\\s*`, 'g'), '')
  const url = `/logo-motion.${ext}?rev=${hash(data)}`
  const tag = ext === 'css'
    ? `<link rel="stylesheet" data-xh-logo-motion-css href="${url}">`
    : `<script defer data-xh-logo-motion-js src="${url}"></script>`
  html = html.replace('</head>', `${tag}\n</head>`)
}
writeFileSync(indexPath, html)
console.log('brand motion assets synchronized')
