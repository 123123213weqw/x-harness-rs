import type * as React from 'react'
import type {ObservableStore} from '../shared/runtime-types'
import type {JobClient} from '../jobs/client'
export interface ConnectionHandle {hostDescription:ObservableStore<{home?:string}|undefined>;jobs?:JobClient|undefined}
export interface ToolSpec {name:string;key?:string;locale?:string;children?:Record<string,{kind:'keyed';scope:'session'}>;inject?:()=>{hooks:{hostDescription:ConnectionHandle['hostDescription']}}}
export interface ClientContext {get(name:'connection'):ConnectionHandle;slots:{inject(name:string,install:()=>void):void;register<P>(spec:ToolSpec,component:React.ComponentType<P>):void};plugin(plugin:{name:string;inject:string[];apply(ctx:ClientContext):void}):void}
export type Context=ClientContext
