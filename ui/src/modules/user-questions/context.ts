import type * as React from 'react'
import type {PageContext} from '../shared/runtime-types'
import type {QuestionWait} from './contract/slots'
export interface ComposerChainProps {interactions: readonly ({kind:string}|QuestionWait)[]}
export interface ClientContext extends Pick<PageContext,'effect'|'locale'> {
 slots:{inject(name:string, install:()=>void):void;register<P>(spec:{name:string;locale:string;select(props:ComposerChainProps):QuestionWait|null},component:React.ComponentType<P>):void}
}
