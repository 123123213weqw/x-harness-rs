// Mechanical staging for the standalone native bridge, without rebuilding the
// upstream UI/plugin graph or introducing unrelated generated changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = new URL('../', import.meta.url)
const source = readFileSync(new URL('ui/desktop/updater.js', root), 'utf8').replace(/\r\n/g, '\n')
writeFileSync(new URL('ui/desktop/updater.js', root), source)
writeFileSync(new URL('ui/dist/desktop-updater.js', root), source)
const rev = createHash('sha256').update(source).digest('hex').slice(0, 16)
const index = new URL('ui/dist/index.html', root)
writeFileSync(index, readFileSync(index, 'utf8').replace(/\/desktop-updater\.js\?rev=[a-f0-9]+/g, '/desktop-updater.js?rev=' + rev))
