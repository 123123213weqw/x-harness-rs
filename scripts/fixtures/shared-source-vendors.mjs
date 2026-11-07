// Supply the same pinned singleton boundary as the browser platform seed.
// Execute it inside the fixture realm so wire-object and error semantics match.
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
const require=createRequire(new URL('../../ui/package.json',import.meta.url))
const realms=new WeakMap()
let source,resourceSource
export function sharedSourceVendors(realm=vm.createContext({console,URL,Blob,DOMException,AbortController})) {
  let exports=realms.get(realm)
  if(exports)return exports
  source??=require('esbuild').buildSync({entryPoints:[require.resolve('zod')],bundle:true,
    platform:'browser',format:'cjs',target:'es2020',write:false,legalComments:'inline'}).outputFiles[0].text
  const zod=vm.runInContext(`(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn module.exports})()`,realm)
  resourceSource??=require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('../../ui/src/modules/platform/primitives/image-resources.ts',import.meta.url))],bundle:true,platform:'browser',format:'cjs',target:'es2020',write:false}).outputFiles[0].text
  const imageResources=vm.runInContext(`(()=>{const module={exports:{}};const exports=module.exports;${resourceSource}\nreturn module.exports})()`,realm)
  exports={zod,imageResources};realms.set(realm,exports);return exports
}
export const sharedVendors=sharedSourceVendors()

/** Focused feature fixtures supply the production seed without booting Host. */
export async function installSharedSourceVendors(page) {
  sharedSourceVendors()
  await page.addScriptTag({content:`window.__sourceVendors=(()=>{const module={exports:{}};const exports=module.exports;${source}\nconst zod=module.exports;const resources={exports:{}};((module,exports)=>{${resourceSource}})(resources,resources.exports);return {zod,imageResources:resources.exports}})()`})
}
