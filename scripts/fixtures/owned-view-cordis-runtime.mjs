/** Test-only real Cordis kernel. No fake Service/Context ABI and no production
 * exports. Same original vendor runtime, alias table and four defines as the
 * production platform compiler; public SDK checking stays in the source build. */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import vm from 'node:vm'
import {platformAliases} from '../build-platform-ui.mjs'
const repo=fileURLToPath(new URL('../../',import.meta.url)),ui=join(repo,'ui')
const require=createRequire(join(ui,'package.json')),esbuild=require('esbuild')
let core,store
export function loadOwnedCordisRuntime(){
  if(core)return core
  const vendor=join(ui,'src/modules/platform/vendor'),pin=JSON.parse(readFileSync(join(vendor,'PROVENANCE.json'),'utf8'))
  for(const file of pin.files){
    const bytes=readFileSync(join(vendor,file.path))
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Test Core vendor drift: '+file.path)
  }
  core=bundle('src/modules/platform/vendor/cordis/src/index.ts')
  return core
}
export function loadOwnedSnapshotRuntime(){return store??=bundle('src/modules/client-runtime/contract/store.ts')}
function bundle(source){
  const built=esbuild.buildSync({entryPoints:[join(ui,source)],absWorkingDir:ui,bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',nodePaths:[join(ui,'node_modules')],alias:{...platformAliases(ui),immer:join(ui,'src/modules/client-runtime/vendor/immer/src/immer.ts')},
    define:{'process.env.NODE_ENV':'"production"','process.versions.node':'"0.0.0"','process.execArgv':'[]','process.env.CORDIS_SHARED':'undefined'},legalComments:'inline'})
  const module={exports:{}}
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,console,Promise,Date,Map,Set,WeakMap,WeakSet,Symbol,Error,TypeError,AbortController,AbortSignal,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval,structuredClone,URL,Uint8Array})
  return module.exports
}
