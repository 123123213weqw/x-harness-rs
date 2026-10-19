// Browser tests/previews opt in here, never through a production URL flag.
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {OUTPUT_MARKER} from '../ui-build-contract.mjs'
let built
export function fixtureUiRoot() {
  if (built) return built
  if (process.env.UI_FIXTURE_DIST) built = resolve(process.env.UI_FIXTURE_DIST)
  else {
    const temporary = mkdtempSync(join(tmpdir(), 'xharness-ui-fixture-'))
    process.once('exit', () => rmSync(temporary, {recursive: true, force: true}))
    built = join(temporary, 'dist')
    execFileSync(process.execPath, [fileURLToPath(new URL('../assemble-static-ui.mjs', import.meta.url)), '--variant', 'fixture', '--out-dir', built], {stdio: 'inherit'})
  }
  const marker = JSON.parse(readFileSync(join(built, OUTPUT_MARKER), 'utf8'))
  if (marker.builder !== 'xharness-self-contained-ui' || marker.variant !== 'fixture') throw Error('UI_FIXTURE_DIST must be an explicit fixture build, not production assets')
  return built
}
