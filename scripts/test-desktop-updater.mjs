import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const window = {}
const sandbox = { window, document: undefined }
vm.createContext(sandbox)
vm.runInContext(
  await readFile(new URL('../ui/desktop/updater.js', import.meta.url), 'utf8'),
  sandbox,
)

const { updateView } = window.__XHARNESS_DESKTOP_UPDATER_TEST__
assert.equal(updateView({ phase: 'idle' }).action, '检查更新')
assert.equal(updateView({ phase: 'checking' }).busy, true)
assert.equal(updateView({ phase: 'available', version: '1.2.3' }).emphasized, true)
assert.match(updateView({ phase: 'available', version: '1.2.3' }).label, /1\.2\.3/)
assert.match(
  updateView({ phase: 'downloading', downloaded: 51, total: 100 }).label,
  /51%/,
)
assert.equal(updateView({ phase: 'error', message: 'offline' }).action, '重试')
assert.equal(updateView({ phase: 'recovering-host' }).busy, true)
assert.equal(updateView({ phase: 'up-to-date' }).busy, false)

console.log('desktop updater projection tests passed')
