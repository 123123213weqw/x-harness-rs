// Supply the same pinned singleton boundary as the browser platform seed.
// Execute it inside the fixture realm so wire-object and error semantics match.
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../../ui/package.json',import.meta.url))
const realms=new WeakMap()
let source
export function sharedSourceVendors(realm=vm.createContext({console})) {
  let exports=realms.get(realm)
  if(exports)return exports
  source??=require('esbuild').buildSync({entryPoints:[require.resolve('zod')],bundle:true,
    platform:'browser',format:'cjs',target:'es2020',write:false,legalComments:'inline'}).outputFiles[0].text
  const zod=vm.runInContext(`(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn module.exports})()`,realm)
  exports={zod};realms.set(realm,exports);return exports
}
export const sharedVendors=sharedSourceVendors()

/** Focused feature fixtures supply the production seed without booting Host. */
export async function installSharedSourceVendors(page) {
  sharedSourceVendors()
  await page.addScriptTag({content:`window.__sourceVendors=(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn {zod:module.exports}})()`})
}
