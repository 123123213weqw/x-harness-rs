import {useEffect,useRef,useState} from 'react'
import type {WorkspaceItemOwner} from '../layout/workspace-pane'
import type {FileDisplayClient} from './file-display/client'
import {objectValue} from '../shared/runtime-types'

interface Panel {capability:string;sessionId:string;plugin:string;title:string;source:string;entry:string;initial:unknown}
const panels=new Map<string,Panel>()
const CLOSE='xharness:plugin-panel-close-request',CLOSED='xharness:plugin-panel-closed'
export const panelClosedEvent=CLOSED
const chinese=()=>document.documentElement.lang.startsWith('zh')
const label=(zh:string,en:string)=>chinese()?zh:en
export function panelDescriptor(value:unknown,session:string):Panel {
  const outer=objectValue(value),raw=objectValue(outer.panel)
  if(typeof raw.capability!=='string'||!/^[a-f0-9]{64}$/.test(raw.capability)||raw.sessionId!==session||typeof raw.plugin!=='string'||typeof raw.title!=='string'||typeof raw.source!=='string'||typeof raw.entry!=='string'||!raw.entry.startsWith(`/plugin-panel/${raw.capability}/`)||raw.entry.includes('..'))throw Error('Invalid editor descriptor')
  return {capability:raw.capability,sessionId:session,plugin:raw.plugin,title:raw.title,source:raw.source,entry:raw.entry,initial:outer.initial}
}
export async function openPluginEditor(client:FileDisplayClient,sessionId:string,path:string):Promise<void> {
  let panel=panelDescriptor(await client.panelCall('plugins/panelOpen',{name:'wordcraft',sessionId,path}),sessionId)
  if(panel.initial===null&&!panels.has(panel.capability)){
    if(!window.confirm(label('该文档仍在另一个或上次页面的编辑器中。关闭旧编辑器并从已保存文件重新载入？未保存内容会丢失。','The document is open in another or previous page. Close that editor and reload the saved file? Unsaved changes will be lost.')))return
    await client.panelCall('plugins/panelClose',{capability:panel.capability,discardConfirmed:true})
    panel=panelDescriptor(await client.panelCall('plugins/panelOpen',{name:'wordcraft',sessionId,path}),sessionId)
  }
  if(!panels.has(panel.capability))panels.set(panel.capability,panel)
  window.dispatchEvent(new CustomEvent('xharness:workspace-open',{detail:{kind:'plugin',source:panel.capability,sessionId,title:`${panel.source.split(/[\\/]/).at(-1)??panel.title} · ${panel.title}`}}))
}
export function requestPluginPanelClose(capability:string):void {window.dispatchEvent(new CustomEvent(CLOSE,{detail:{capability}}))}
export function PluginPanel({item,sessionId,client,open=true}:WorkspaceItemOwner&{client:FileDisplayClient}) {
  const ref=useRef<HTMLIFrameElement>(null),[error,setError]=useState(''),closing=useRef(false)
  const panel=panels.get(item.source),visible=useRef(open)
  visible.current=open
  useEffect(()=>{
    if(!panel||panel.sessionId!==sessionId)return
    const abort=new AbortController();let disposed=false,ready=false
    const activity=():void=>{void client.panelCall('plugins/panelActivity',{capability:panel.capability,interactive:ready&&visible.current&&document.visibilityState!=='hidden'},abort.signal).catch(()=>{if(!disposed)setError(label('编辑器状态同步失败，请重新打开','Editor status sync failed; reopen the panel'))})}
    const send=(message:unknown)=>ref.current?.contentWindow?.postMessage(message,'*')
    const onMessage=async(event:MessageEvent<unknown>):Promise<void>=>{
      if(event.source!==ref.current?.contentWindow||event.origin!=='null'||disposed)return
      const message=objectValue(event.data)
      if(message.jsonrpc!=='2.0'||typeof message.method!=='string')return
      if(message.id===undefined)return
      let result:unknown
      try{
        if(message.method==='ui/initialize'){
          const params=objectValue(message.params)
          result={protocolVersion:params.protocolVersion,hostInfo:{name:'XHarness',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},downloadFile:{}},hostContext:{theme:document.documentElement.dataset.theme==='dark'?'dark':'light',locale:document.documentElement.lang||'zh-CN',displayMode:'fullscreen'}}
        }else if(message.method==='resources/read'||message.method==='tools/call'){
          result=await client.panelCall('plugins/panelRpc',{capability:panel.capability,method:message.method,params:message.params},abort.signal)
          if(message.method==='tools/call'&&objectValue(message.params).name==='_editor_attach'&&objectValue(result).isError!==true){ready=true;activity()}
        }else if(message.method==='ui/download-file'){
          const params=objectValue(message.params)
          const contents:unknown[]=Array.isArray(params.contents)?params.contents:[]
          const resource=objectValue(objectValue(contents[0]).resource)
          const name=typeof resource.name==='string'?resource.name:panel.source.split(/[\\/]/).at(-1)??'document.docx'
          if(!/\.docx$/i.test(name))throw Error(label('此版本仅支持保存 DOCX；其他格式请使用对应的导出工具','This version saves DOCX only; use the matching export tool for other formats'))
          const base=panel.source.replace(/[^/\\]+$/,'')+name.replace(/^.*[\\/]/,'')
          const destination=window.prompt(label('保存到当前工作区路径','Save to workspace path'),base)
          if(destination===null||!window.confirm(label(`确认保存到 ${destination}？已有文件将被覆盖。`,`Save to ${destination}? An existing file will be replaced.`)))throw Error(label('已取消保存','Save cancelled'))
          // Re-save the live editor through its normal MCP path; do not accept
          // arbitrary browser-provided bytes or filenames as filesystem authority.
          await client.panelCall('plugins/panelSave',{capability:panel.capability,path:destination,overwriteConfirmed:true},abort.signal)
          result={}
        }else throw Error('This panel capability is not supported')
        if(!disposed)send({jsonrpc:'2.0',id:message.id,result})
      }catch(e){if(!disposed)send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:e instanceof Error?e.message:'Panel operation failed'}})}
    }
    const message=(event:MessageEvent<unknown>):void=>{void onMessage(event).catch(()=>{setError('Panel message failed')})}
    const initialized=(event:MessageEvent<unknown>):void=>{
      if(event.source!==ref.current?.contentWindow||event.origin!=='null')return
      if(objectValue(event.data).method==='ui/notifications/initialized'){
        send({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{path:panel.source}}})
        send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:panel.initial})
      }
    }
    const close=async(event:Event):Promise<void>=>{
      if(!(event instanceof CustomEvent)||objectValue(event.detail).capability!==panel.capability||closing.current)return
      if(!window.confirm(label('请先保存修改。确认关闭并放弃尚未保存的内容？','Save your changes first. Close and discard any remaining unsaved changes?')))return
      closing.current=true
      try{
        await client.panelCall('plugins/panelClose',{capability:panel.capability,discardConfirmed:true})
        panels.delete(panel.capability)
        window.dispatchEvent(new CustomEvent(CLOSED,{detail:{capability:panel.capability}}))
      }catch(e){setError(e instanceof Error?e.message:'Could not close editor')}
      finally{closing.current=false}
    }
    const onClose=(event:Event):void=>{void close(event).catch(()=>setError('Could not close editor'))}
    const beforeUnload=(event:BeforeUnloadEvent):void=>{event.preventDefault();event.returnValue=''}
    const heartbeat=window.setInterval(()=>{if(ready&&visible.current&&document.visibilityState!=='hidden')activity()},10000)
    document.addEventListener('visibilitychange',activity);window.addEventListener('xharness:plugin-visibility',activity);window.addEventListener('message',message);window.addEventListener('message',initialized);window.addEventListener(CLOSE,onClose);window.addEventListener('beforeunload',beforeUnload)
    if(ref.current&&ref.current.getAttribute('src')!==panel.entry)ref.current.src=panel.entry
    return()=>{disposed=true;window.clearInterval(heartbeat);abort.abort();document.removeEventListener('visibilitychange',activity);window.removeEventListener('xharness:plugin-visibility',activity);window.removeEventListener('message',message);window.removeEventListener('message',initialized);window.removeEventListener(CLOSE,onClose);window.removeEventListener('beforeunload',beforeUnload)}
  },[panel,sessionId,client])
  useEffect(()=>{window.dispatchEvent(new Event('xharness:plugin-visibility'))},[open])
  if(!panel||panel.sessionId!==sessionId)return <p role="alert">{label('编辑器会话已失效，请重新打开文件','Editor expired; reopen the file')}</p>
  return <section className="xhfile-pane" data-plugin-panel={panel.plugin}>
    {error&&<p role="alert" className="xhfile-action-error">{error}</p>}
    <iframe ref={ref} title={panel.title} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" style={{width:'100%',height:'100%',border:0}}/>
  </section>
}
