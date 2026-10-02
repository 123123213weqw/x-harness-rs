import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {compileScriptAssets} from '../build-script-assets.mjs'
const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const scriptRows = [
  {source:'src/desktop/startup.ts',path:'desktop-startup.js'},
  {source:'src/desktop/titlebar.ts',path:'desktop-titlebar.js'},
  {source:'src/desktop/updater.ts',path:'desktop-updater.js'},
  {source:'src/desktop/logo-motion.ts',path:'logo-motion.js'},
]
let compiled
export function scriptAsset(path, implementation = process.env.UI_TEST_IMPL ?? 'source') {
  if (!scriptRows.some(row => row.path === path)) throw Error('Unknown owned script test entry')
  if (implementation === 'legacy') return readFileSync(resolve(repo,'ui/reference/master-a613970',path),'utf8')
  if (implementation !== 'source') throw Error('Invalid script implementation')
  compiled ??= compileScriptAssets(resolve(repo,'ui'),scriptRows)
  return compiled.get(path).bytes.toString('utf8')
}
export function scriptAssetDist(path) {return resolve(process.env.UI_TEST_DIST ?? resolve(repo,'ui/dist'),path)}
