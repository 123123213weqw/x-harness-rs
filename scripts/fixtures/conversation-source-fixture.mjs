// Execute the actual emitted closure; only Host/UI services are test doubles.
import {File} from 'node:buffer'
import {webcrypto} from 'node:crypto'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {exposeConversation} from '../conversation-artifact-test.mjs'
export function conversationFixture(source,names,env={}) {
 let registration;
 const jsx=(type,props,key)=>({type,props,key});
 const React={memo:fn=>fn,createContext:initial=>({Provider:'provider',value:initial}),useContext:ctx=>ctx.value,useCallback:fn=>fn,createElement:(type,props,...children)=>jsx(type,{...props,...(children.length?{children:children.length===1?children[0]:children}:{})}),useEffect(){},useRef:()=>({current:null}),useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],...env.react};
 const global={console,File,Blob,URL,AbortController,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,btoa,atob,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild(){}}},...env,window:{__ModuleLoader__:{load:row=>registration=row}}};
 const Service=class {constructor(ctx,name){this.ctx=ctx;if(name)ctx[name]=this}};
 let runtimeRow;vm.runInNewContext(readFileSync(new URL('../../ui/reference/master-a613970/plugins/@xharness/dsh-client-runtime/client.js',import.meta.url),'utf8'),{...global,window:{__ModuleLoader__:{load:row=>runtimeRow=row}}});
 const runtime=env.runtime??runtimeRow.factory(name=>name==='@xharness/cordis'?{Service,Context:{is:ctx=>ctx!==null&&typeof ctx==='object'}}:{});
 const primitives=env.primitives??new Proxy({},{get:(_t,key)=>key});
 vm.runInNewContext(exposeConversation(source,names),global);
 const api=registration.factory(name=>name==='react'?React:name==='react-dom'?(env.reactDom??{createPortal:(children,container)=>({portal:true,children,container})}):name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'fragment'}:name==='@xharness/dsh-client-runtime/client'?runtime:name==='@xharness/cordis'?{Service,Context:{is:ctx=>ctx!==null&&typeof ctx==='object'}}:name==='@xharness/dsh-client-ui-primitives'?primitives:name==='@xharness/dsh-client-ui-slots'?{resolveSlotLabel:x=>typeof x==='function'?x():x}:(()=>{throw Error('Unexpected fixture dependency '+name)})());
 return{api,runtime,global};
}
