/** Real production factories and their true Core/React/SlotCore/primitive imports.
 * Pure projector gates do not mount a UI, but loading their full closures must
 * still obey the real platform ABI (in particular the shared React context).
 */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
import {loadOwnedCordisRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs'
import {exposeConversation,verifyConversationArtifact,legacyConversation} from './conversation-artifact-test.mjs'
const ui=new URL('../ui/',import.meta.url),require=createRequire(new URL('package.json',ui))
const Core=loadOwnedCordisRuntime(),React=require('react'),jsx=require('react/jsx-runtime'),ReactDOM=require('react-dom')
const globals={console,URL,AbortController,AbortSignal,setTimeout,clearTimeout,queueMicrotask,
 document:{querySelector:()=>null,getElementById:()=>null,createElement:()=>({dataset:{}}),head:{appendChild(){}}}}
function load(source,externals){
 let registration
 vm.runInNewContext(source,{...globals,window:{__ModuleLoader__:{load:row=>registration=row}}})
 return registration.factory(name=>{if(name in externals)return externals[name];throw Error(`Unexpected projection artifact external ${name}`)})
}
const platform=compileSourceModules(ui.pathname,[
 {id:'projection:real-slot-core',source:'src/modules/platform/slots/index.ts'},
 {id:'projection:real-primitives',source:'src/modules/platform/primitives/index.ts'},
])
const platformImports={'@xharness/cordis':Core,react:React,'react/jsx-runtime':jsx,'react-dom':ReactDOM}
const slots=load(platform.get('projection:real-slot-core').bytes.toString(),platformImports)
const primitiveEntry=platform.get('projection:real-primitives')
const primitiveImports={...platformImports}
for(const name of primitiveEntry.external)if(!(name in primitiveImports)){
 // These are the exact pinned npm dependencies of the real primitive entry.
 // CSS is an inert imported asset in this non-DOM projector test, not a fake
 // component implementation; the actual browser platform covers its mounting.
 primitiveImports[name]=name.endsWith('.css')?readFileSync(require.resolve(name),'utf8'):require(name)
}
const primitives=load(primitiveEntry.bytes.toString(),primitiveImports)
export function projectionArtifacts(names,implementation='source'){
 if(!['source','legacy'].includes(implementation))throw Error('Unknown projection implementation '+implementation)
 if(implementation==='source')assertRebuildInput('@xharness/dsh-client-runtime')
 const runtimeSource=readFileSync(new URL(`${implementation==='source'?'dist':'reference/master-a613970'}/plugins/@xharness/dsh-client-runtime/client.js`,ui),'utf8')
 const runtime=load(runtimeSource,{'@xharness/cordis':Core,'@xharness/dsh-client-ui-slots':slots})
 const conversation=load(exposeConversation(implementation==='source'?verifyConversationArtifact():legacyConversation().toString(),names),{
  ...platformImports,'@xharness/dsh-client-runtime/client':runtime,
  '@xharness/dsh-client-ui-slots':slots,'@xharness/dsh-client-ui-primitives':primitives,
 })
 return{runtime,conversation}
}
