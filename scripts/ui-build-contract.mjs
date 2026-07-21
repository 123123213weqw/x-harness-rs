// Repository-owned build contract. No package resolution against another tree.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, readdirSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'

export const OUTPUT_MARKER = '.xharness-ui-output.json'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const revision = bytes => sha256(bytes).slice(0, 16)
export function localPath(value, label = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || /[\x00-\x1f?#:%]/.test(value)) throw Error(`Invalid local ${label}`)
  return value
}
export function readInput(ui, descriptor) {
  localPath(descriptor.source, 'source')
  if (['dist', 'node_modules', 'reference'].some(directory => descriptor.source.startsWith(directory + '/'))) throw Error('Build input must not reference generated output, dependency cache or acceptance reference')
  const root = realpathSync(ui), path = realpathSync(resolve(ui, descriptor.source))
  if (!path.startsWith(root + sep) || !statSync(path).isFile()) throw Error(`Input escapes UI tree: ${descriptor.source}`)
  for (const directory of ['dist', 'node_modules', 'reference']) {
    if (path.startsWith(join(root, directory) + sep)) throw Error('Build input must not alias generated output, dependency cache or acceptance reference')
  }
  const bytes = readFileSync(path)
  if (descriptor.source.startsWith('legacy/') && !descriptor.sha256) throw Error(`Unpinned legacy input: ${descriptor.source}`)
  if (descriptor.sha256 && (typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || sha256(bytes) !== descriptor.sha256)) throw Error(`Pinned input changed: ${descriptor.source}`)
  return bytes
}
export function orderModules(modules) {
  const rows = new Map()
  for (const row of modules) {
    if (typeof row.id !== 'string' || !/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(row.id)) throw Error('Invalid module ID')
    if (rows.has(row.id)) throw Error(`Duplicate module: ${row.id}`)
    for (const field of ['external', 'inject']) if (row[field] !== undefined && (!Array.isArray(row[field]) || row[field].some(value => typeof value !== 'string'))) throw Error(`Invalid ${field}: ${row.id}`)
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') throw Error(`Invalid immediately: ${row.id}`)
    rows.set(row.id, row)
  }
  const result = [], placed = new Set(), open = []
  // These are platform seeds, not packages fetched from an external checkout.
  const seeds = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
    '@xharness/cordis', '@xharness/dsh-client-ui-slots', '@xharness/dsh-client-ui-primitives'])
  const visit = row => {
    if (placed.has(row.id)) return
    if (open.includes(row.id)) throw Error(`Module dependency cycle: ${[...open, row.id].join(' -> ')}`)
    open.push(row.id)
    for (const request of row.external ?? []) {
      const dependency = rows.get(request.replace(/\/client$/, ''))
      if (dependency) visit(dependency)
      else if (!seeds.has(request)) throw Error(`Missing code dependency: ${row.id} -> ${request}`)
    }
    open.pop(); placed.add(row.id); result.push(row)
  }
  for (const row of modules) visit(row)
  return result
}
export function treeHashes(dir, prefix = '') {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error('Output must not contain symlinks')
    const path = join(dir, entry.name), key = prefix + entry.name
    return entry.isDirectory() ? Object.entries(treeHashes(path, key + '/')) : [[key, sha256(readFileSync(path))]]
  }))
}
export function renderBoot(template, graph, files, platform) {
  if (template.split('__XHARNESS_BOOT_GRAPH__').length !== 2) throw Error('Boot template must contain one graph placeholder')
  let html = template.replace('__XHARNESS_BOOT_GRAPH__', () => JSON.stringify(graph))
  const markers = ['__XHARNESS_PLATFORM_ENTRY__', '__XHARNESS_PLATFORM_STYLES__', '__XHARNESS_PRELOAD_BOOT__']
  if (platform) {
    for (const marker of markers) if (html.split(marker).length !== 2) throw Error(`Platform template needs exactly one ${marker}`)
    localPath(platform.entryPath, 'platform entry')
    if (!files.has(platform.entryPath)) throw Error('Missing platform entry asset')
    for (const path of platform.cssPaths) { localPath(path, 'platform stylesheet'); if (!files.has(path)) throw Error('Missing platform stylesheet asset') }
    if (typeof platform.preloadBootBytes !== 'string' || platform.preloadBootBytes.includes('</script')) throw Error('Invalid typed preload bootstrap')
    html = html.replace('__XHARNESS_PLATFORM_ENTRY__', () => '/' + platform.entryPath)
      .replace('__XHARNESS_PLATFORM_STYLES__', () => platform.cssPaths.map(path => `<link rel="stylesheet" crossorigin href="/${path}">`).join(''))
      .replace('__XHARNESS_PRELOAD_BOOT__', () => platform.preloadBootBytes)
  } else if (markers.some(marker => html.includes(marker))) throw Error('Source platform required by boot template')
  html = html.replace(/(?:src|href)="([^"?#]+)\?rev=([a-f0-9]+)"/g, (match, url, prior) => {
    const path = url.replace(/^\//, ''), bytes = files.get(path)
    if (!bytes) throw Error(`HTML references missing revisioned asset: ${url}`)
    return match.replace(`rev=${prior}`, `rev=${sha256(bytes).slice(0, prior.length)}`)
  })
  for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)(?:\?[^"#]*)?"/g)) {
    if (!files.has(match[1].slice(1))) throw Error(`HTML references missing asset: ${match[1]}`)
  }
  return html
}
