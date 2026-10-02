/** Runtime owns the frozen call contract; Tool UI only consumes it. */
export type {ToolCallBlock,ToolResultNode} from '../client-runtime/sessions/conversation'
export type {ClientContext} from './context'
import type {Translation} from '../shared/runtime-types'
export type TranslateNS<N extends string> = Translation
export type PropsLocale<N extends string> = {t:TranslateNS<N>}
