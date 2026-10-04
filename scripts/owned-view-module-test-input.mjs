/** Test-only selector: production always enrolls its manifest source entry.
 * A/B runs deliberately keep the immutable latest-master reference separate. */
import {readFileSync, mkdtempSync, rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {compileSourceModules} from './build-source-modules.mjs'
const sources = {
  '@xharness/dsh-client-connection':'src/modules/client-connection/index.ts',
  '@xharness/dsh-client-ui-theme':'src/modules/theme/index.ts',
  '@xharness/dsh-client-ui-workspace':'src/modules/workspace/index.ts',
  '@xlang/xharness-client-ui-directory':'src/modules/directory/index.tsx',
  '@xlang/xharness-client-ui-context':'src/modules/context/index.tsx',
  '@xharness/dsh-client-ui-tool':'src/modules/tool/index.ts',
  '@xharness/dsh-client-ui-layout':'src/modules/layout/index.ts',
  '@xharness/dsh-client-runtime':'src/modules/client-runtime/index.ts',
  '@xlang/xharness-client-ui-plugin-hub': 'src/modules/plugin-hub/index.tsx',
  '@xlang/xharness-client-ui-profile': 'src/modules/profile/index.tsx',
  '@xlang/xharness-client-plugin-api': 'src/plugin-api/client.ts',
  '@xlang/xharness-client-ui-tasks': 'src/modules/tasks/index.tsx',
  '@xlang/xharness-client-ui-schedule': 'src/modules/schedule/index.tsx',
  '@xlang/xharness-client-ui-browser': 'src/modules/browser/index.tsx',
  '@xlang/xharness-client-ui-experience': 'src/modules/experience/index.tsx',
}
const compiled = new Map()
export function ownedViewModuleTestInput(id) {
  const mode = process.env.UI_TEST_IMPL ?? 'canonical'
  if (mode === 'legacy') return readFileSync(new URL(`../ui/reference/master-a613970/plugins/${id}/client.js`, import.meta.url), 'utf8')
  if (mode === 'source') {
    if (!sources[id]) throw Error(`No owned view test source for ${id}`)
    if (id === '@xlang/xharness-client-plugin-api' && !compiled.has(id)) {
      const temp = mkdtempSync(join(tmpdir(), 'xharness-owned-api-fixture-'))
      try {
        const output = join(temp, 'client.js')
        execFileSync(process.execPath, [new URL('./build-plugin-api.mjs', import.meta.url).pathname, '--output', output], {stdio:'pipe'})
        compiled.set(id, readFileSync(output, 'utf8'))
      } finally {rmSync(temp, {recursive:true,force:true})}
    }
    if (!compiled.has(id)) compiled.set(id, compileSourceModules(new URL('../ui', import.meta.url).pathname, [{id,source:sources[id]}]).get(id).bytes.toString())
    return compiled.get(id)
  }
  if (mode !== 'canonical') throw Error(`Unknown view test implementation ${mode}`)
  return readFileSync(new URL(`../ui/dist/plugins/${id}/client.js`, import.meta.url), 'utf8')
}
