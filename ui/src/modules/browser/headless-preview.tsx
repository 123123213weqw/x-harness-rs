import * as React from 'react'
import type {BrowserPaneProps} from './index'
import {objectValue} from '../shared/runtime-types'
const {createElement:h,useEffect,useRef,useState}=React
let previewReadInFlight=false

/** One request at a time. Hiding/unmounting releases preview only, never the page. */
export function HeadlessPreview(props:BrowserPaneProps & {onNative?:()=>void}) {
  const {item,sessionId,open}=props
  const current=useRef(props);current.current=props
  const initial=item.entries[item.position]??''
  const [draft,setDraft]=useState(initial)
  const [image,setImage]=useState('')
  const [error,setError]=useState('')
  const [opening,setOpening]=useState(false)
  useEffect(()=>setDraft(initial),[initial])
  useEffect(()=>{
    if(!open||!sessionId||!item.id.startsWith('headless:')){setImage('');return}
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined,running=false
    const poll=async()=>{
      if(disposed||running||document.hidden)return
      if(previewReadInFlight){timer=setTimeout(poll,1000);return}
      running=true
      previewReadInFlight=true
      try{
        const native=window.__TAURI__;if(!native)throw Error('后台浏览器需要桌面客户端')
        const raw=objectValue(await native.core.invoke('desktop_headless_preview',{owner:sessionId,tabId:item.id}))
        if(disposed)return
        if(raw.busy!==true){
          if(raw.tabId!==item.id||raw.mime!=='image/jpeg'||raw.width!==640||raw.height!==360||typeof raw.image!=='string'||raw.image.length>2*1024*1024)throw Error('无效的浏览器预览')
          setImage(`data:image/jpeg;base64,${raw.image}`);setError('')
          if(typeof raw.url==='string'&&raw.url.length<=4096&&raw.url!==current.current.item.entries[current.current.item.position]){
            try{const url=new URL(raw.url);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){const entries=[...current.current.item.entries.slice(-49),url.href];current.current.onUpdate({entries,position:entries.length-1,title:typeof raw.title==='string'?raw.title.slice(0,160):url.hostname})}}catch{/* Untrusted guest address is not executable UI. */}
          }
        }
      }catch(problem){if(!disposed)setError(String(problem))}
      finally{running=false;previewReadInFlight=false;if(!disposed&&!document.hidden)timer=setTimeout(poll,1000)}
    }
    const visibility=()=>{clearTimeout(timer);if(!document.hidden)void poll()}
    document.addEventListener('visibilitychange',visibility)
    void poll()
    return()=>{disposed=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility)}
  },[item.id,sessionId,open])
  const navigate=async(event:React.FormEvent)=>{
    event.preventDefault();if(opening||!sessionId)return
    let url:URL
    try{url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(draft)?draft:`${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(draft)?'http':'https'}://${draft}`);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('invalid')}
    catch{setError('请输入有效的 http/https 网址');return}
    const native=window.__TAURI__;if(!native)return
    setOpening(true);setError('')
    try{
      const result=objectValue(await native.core.invoke('desktop_headless_control',{owner:sessionId,arguments:{action:'open',url:url.href}}))
      if(result.ok!==true)throw Error('页面未打开')
    }catch(problem){setError(String(problem))}finally{setOpening(false)}
  }
  return h('section',{className:'xhbrowser-pane','aria-label':'后台浏览器预览','data-headless-preview':true},
    h('form',{className:'xhbrowser-toolbar',onSubmit:navigate},
      h('input',{className:'xhbrowser-headless-address','aria-label':'后台浏览器网址',value:draft,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setDraft(e.currentTarget.value),placeholder:'输入网址'}),
      h('button',{type:'submit',disabled:opening||!sessionId},opening?'打开中…':'打开'),
      h('button',{type:'button',onClick:()=>current.current.onClose(),'aria-label':'关闭当前后台网页'},'×')),
    error&&h('p',{className:'xhbrowser-error',role:'alert'},error),
    h('div',{className:'xhbrowser-headless-canvas'},image?h('img',{src:image,alt:'当前后台浏览器页面预览，收起侧栏不会停止任务',draggable:false}):h('p',null,item.id.startsWith('headless:')?'等待页面预览…':'使用本机 Chrome／Edge，独立后台会话')),
    h('footer',{className:'xhbrowser-headless-footer'},'预览 · 收起后 AI 仍可操作',
      props.onNative&&h('button',{type:'button',onClick:props.onNative},'使用原生 WebView')))
}
