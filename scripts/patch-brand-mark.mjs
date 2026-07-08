#!/usr/bin/env node
// Refresh the checked-in Web shell without a full upstream UI rebuild. Full
// rebuilds compile the matching FishLogo/BrandWordmark TSX overrides instead.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.argv[2] || 'ui/dist')
const indexPath = join(dist, 'index.html')
let html = readFileSync(indexPath, 'utf8')
const entry = html.match(/src="(\/assets\/index-[^"?]+\.js)(?:\?[^" ]*)?"/)?.[1]
if (!entry) throw Error('UI entry not found')
const source = readFileSync(join(dist, entry), 'utf8')
const paths = [
  'M57.01 5.59H44.27L6.99 49.86V58.41H19.73L57.01 14.14V5.59Z',
  'M6.99 5.59H19.73L57.01 49.86V58.41H44.27L6.99 14.14V5.59Z',
]
const mark = paths.map((path, index) => `d.jsx("path",{d:"${path}",fillOpacity:"${index === 0 ? '0.42' : '0.9'}"})`).join(',')
const replacements = {
  of: `function of({size:n=24,className:i}){return d.jsxs("svg",{width:n,height:n,className:["xh-logo-sweep",i].filter(Boolean).join(" "),viewBox:"0 0 64 64",fill:"currentColor","aria-hidden":"true",children:[${mark}]})}`,
  lf: `function lf({size:n=24,className:i,includeMark:l=!0}){return d.jsxs("svg",{width:n*(l?340:232)/64,height:n,className:i,viewBox:l?"0 0 340 64":"108 0 232 64",fill:"none","aria-hidden":"true",children:[l&&d.jsxs("g",{className:"xh-logo-sweep",fill:"currentColor",children:[${mark}]}),d.jsx("text",{x:"108",y:"51",fill:"currentColor",fontFamily:"Rajdhani, Orbitron, ui-monospace, SFMono-Regular, Menlo, monospace",fontSize:"45",fontWeight:"600",letterSpacing:"2.2",children:"XHarness"})]})}`,
}
let next = source
for (const [name, replacement] of Object.entries(replacements)) {
  const block = next.match(new RegExp(`function ${name}\\([^]*?(?=function )`))?.[0]
  if (!block) throw Error(`brand component ${name} not found`)
  if (block === replacement) continue
  if (!block.includes('xhLogoGradient') && !block.includes('/app-icon-512.png') && !block.includes('M11 11H22L34 24L26 33L11 17V11Z') && !block.includes('M57.01 5.59H44.27L6.99 49.86')) {
    throw Error(`brand component ${name} changed; rebuild from TSX instead`)
  }
  next = next.replace(block, replacement)
}
if (next !== source) {
  const rev = createHash('sha256').update(next).digest('hex').slice(0, 12)
  const output = `/assets/index-xhmotion-${rev}.js`
  writeFileSync(join(dist, output), next)
  html = html.replaceAll(entry, output)
  writeFileSync(indexPath, html)
  console.log(`Web brand mark: ${output}`)
} else {
  console.log(`Web brand mark already current: ${entry}`)
}
