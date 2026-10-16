/** Desktop-only pairing administration; mobile cookies are never valid here. */
import {useEffect,useRef,useState,type FormEvent} from 'react'
import type {Catalog} from './contracts'
type Device={id:string;name:string;created_at_ms:number;revoked:boolean;active:boolean}
type MobileStatus={available:boolean;host:string;relay_url:string|null;devices:Device[]}
type Offer={host:string;code:string;expires_at_ms:number;link:string|null;qr_svg:string|null}
function isRecord(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function record(v:unknown):Record<string,unknown>{if(!isRecord(v))throw Error('invalid_response');return v}
function str(v:unknown,max=512):string{if(typeof v!=='string'||v.length>max)throw Error('invalid_response');return v}
function num(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw Error('invalid_response');return v}
function bool(v:unknown):boolean{if(typeof v!=='boolean')throw Error('invalid_response');return v}
async function request(action:Record<string,unknown>):Promise<unknown>{
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000)
 try{const r=await fetch('/api/remote-control/manage',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','x-xharness-remote-admin':'v1'},body:JSON.stringify(action),signal:abort.signal})
  const reader=r.body?.getReader();if(!reader)throw Error('invalid_response');const chunks:Uint8Array[]=[];let total=0
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>1024*1024){await reader.cancel();throw Error('capacity')}chunks.push(chunk.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
  const decoded:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const envelope=record(decoded)
  if(!r.ok||envelope.ok!==true)throw Error(str(record(envelope.error).code));return envelope.value
 }finally{clearTimeout(timer)}
}
export function MobileSettings({catalog}:{catalog:()=>Promise<Catalog>}){
 const [status,setStatus]=useState<MobileStatus>(),[places,setPlaces]=useState<Catalog>(),[workspace,setWorkspace]=useState(''),[session,setSession]=useState(''),[offer,setOffer]=useState<Offer>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[now,setNow]=useState(Date.now())
 const live=useRef(true),reading=useRef(0),working=useRef(false)
 useEffect(()=>{live.current=true;const clock=setInterval(()=>{if(live.current)setNow(Date.now())},1000);return()=>{live.current=false;reading.current++;clearInterval(clock)}},[])
 async function load(){const current=++reading.current;try{const raw=record(await request({type:'mobile_status'}));if(!Array.isArray(raw.devices)||raw.devices.length>256)throw Error('invalid_response');const devices=raw.devices.map((value:unknown)=>{const d=record(value);return {id:str(d.id),name:str(d.name,64),created_at_ms:num(d.created_at_ms),revoked:bool(d.revoked),active:bool(d.active)}});const next={available:bool(raw.available),host:str(raw.host),relay_url:raw.relay_url===null?null:str(raw.relay_url,2048),devices};const known=await catalog();if(live.current&&current===reading.current){setStatus(next);setPlaces(known);setError(undefined)}}catch{if(live.current&&current===reading.current)setError('手机连接不可用；请确认 Host 已配置中继。失败或断线的写操作不要盲目重复提交。')}}
 async function pairing(event:FormEvent){event.preventDefault();if(working.current)return;working.current=true;setBusy(true);setOffer(undefined);setError(undefined)
  try{const r=record(await request({type:'mobile_pair',workspaces:[workspace],sessions:[session],workspace,session,create_workspaces:[],ttl_seconds:300}));const next={host:str(r.host),code:str(r.code),expires_at_ms:num(r.expires_at_ms),link:r.link===null?null:str(r.link,4096),qr_svg:r.qr_svg===null?null:str(r.qr_svg,512000)}
   if(next.link){const url=new URL(next.link);if(url.protocol!=='https:'||url.search||url.username||url.password||url.hash.slice(1)!==new URLSearchParams({host:next.host,code:next.code}).toString())throw Error('invalid_response')}
   if(next.qr_svg&&!next.qr_svg.startsWith('<?xml')&&!next.qr_svg.startsWith('<svg'))throw Error('invalid_response')
   if(live.current)setOffer(next)
  }catch{if(live.current)setError('未取得有效配对结果。不会自动重试；已生成的旧配对码会自行过期。')}finally{working.current=false;if(live.current)setBusy(false)}
 }
 async function revoke(device:string){if(working.current||!confirm('永久撤销这个手机设备？已接纳的任务不会被取消；重新连接必须重新配对。'))return;working.current=true;setBusy(true);setError(undefined);try{const r=record(await request({type:'mobile_revoke',device}));if(r.device!==device||r.revoked!==true)throw Error('invalid_response');await load()}catch{if(live.current)setError('撤销结果未知，请刷新设备状态核验，不要盲目重复提交。')}finally{working.current=false;if(live.current)setBusy(false)}}
 const sessions=places?.workspaces.find(w=>w.id===workspace)?.sessions??[]
 const visibleOffer=offer&&offer.expires_at_ms>now?offer:undefined
 return <fieldset disabled={busy}><legend>手机网页与设备</legend><p>电脑主动连接中继；手机独立配对。授权只覆盖选定会话，不公开桌面管理接口。</p><button type="button" onClick={()=>void load()}>读取／刷新手机连接</button>
 {error&&<p role="alert">{error}</p>}
 {status&&<><p>{status.available?'手机模块已配置（不等于中继已连通）':'尚未配置手机中继'} · Host <code>{status.host}</code></p>{status.relay_url&&<p>手机网页：<a href={status.relay_url} target="_blank" rel="noreferrer">{status.relay_url}</a></p>}
 {status.available&&<form className="xr_remoteForm" onSubmit={pairing}><label>授权工作区<select value={workspace} onChange={e=>{setWorkspace(e.target.value);setSession('');setOffer(undefined)}} required><option value="">请选择</option>{places?.workspaces.map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label><label>默认／授权会话<select value={session} onChange={e=>{setSession(e.target.value);setOffer(undefined)}} required><option value="">请选择</option>{sessions.map(s=><option key={s} value={s}>{places?.sessions[s]??s}</option>)}</select></label><small>首轮配对不授予新建会话权限。配对码五分钟有效且只能使用一次。</small><button type="submit" disabled={!workspace||!session}>生成一次性配对二维码</button></form>}
 {visibleOffer&&<div>{visibleOffer.qr_svg&&<img alt="一次性手机配对二维码" width="256" height="256" src={'data:image/svg+xml;base64,'+btoa(visibleOffer.qr_svg)}/>}<p>剩余 {Math.max(0,Math.ceil((visibleOffer.expires_at_ms-now)/1000))} 秒</p><p>Host：<code>{visibleOffer.host}</code></p><p>手动配对码：<code>{visibleOffer.code}</code></p>{visibleOffer.link&&<a href={visibleOffer.link} target="_blank" rel="noreferrer">打开手机配对页</a>}<p>不要分享二维码、配对码或包含片段的配对链接。</p></div>}
 <ul className="xr_remoteList">{status.devices.map(device=><li key={device.id}><div><strong>{device.name}</strong><p>{device.revoked?'已撤销':device.active?'已配对':'未完成配对'}</p></div>{!device.revoked&&<button onClick={()=>void revoke(device.id)}>撤销设备</button>}</li>)}</ul></>}
 </fieldset>
}
