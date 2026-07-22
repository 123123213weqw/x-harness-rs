import type * as React from 'react'
import type {ToolCallBlock} from '../types'
import type {ConnectionHandle} from '../context'
import type {Translation} from '../../shared/runtime-types'
export interface ToolCallOwnerProps {callId:string;toolName:string;block:ToolCallBlock;cwd?:string|undefined;home?:string|undefined;openFile(path:string):void;inspect?:(()=>void)|undefined}
export interface ToolCallViewProps extends ToolCallOwnerProps {sessionId:string;useSessions<T>(select:(state:{byId:Readonly<Record<string,{cwd?:string}>>})=>T):T}
export interface ToolHostDescriptionInjected {hooks:{hostDescription:ConnectionHandle['hostDescription']}}
interface HostDescriptionHook {<T>(select:(host:ReturnType<ConnectionHandle['hostDescription']['getSnapshot']>)=>T):T}
export interface ToolTreeProps {node:{data:{root:ToolCallBlock}};selectedCallId?:string|undefined;cwd?:string|undefined;openFile(path:string):void;inspectCall(callId:string):void;t:Translation;useHostDescription:HostDescriptionHook;renderSlot(name:'tool.call.toolview',owner:ToolCallOwnerProps,options:{entryKey:string;fallback:React.ReactNode}):React.ReactNode}
export interface ToolDetailsProps {block:ToolCallBlock;cwd?:string|undefined;t:Translation;useHostDescription:HostDescriptionHook}
