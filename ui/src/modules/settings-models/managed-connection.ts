import type {TauriBridge} from '../shared/tauri'
import type {IApiClient, SettingsDescribeFace} from './contracts'
import {objectValue} from '../shared/runtime-types'
const REF='XHARNESS_MANAGED_API_TOKEN', ROUTE='xharness-managed', NS='llm-pi-ai'
export async function saveManagedAccess(api:IApiClient,describe:SettingsDescribeFace,raw:unknown){
 const v=objectValue(raw);if(v.status!=='authorized'||typeof v.accessToken!=='string'||typeof v.baseURL!=='string'||!Array.isArray(v.models))throw Error('invalid_access')
 await describe.ensure();const snap=describe.getSnapshot();const ns=snap.view?.namespaces.find(n=>n.ns===NS);if(snap.status!=='ready'||!ns||!snap.view?.writable)throw Error('settings_unavailable')
 const existing=objectValue(objectValue(ns.value).providers)[ROUTE]
 if(existing!==undefined){const p=objectValue(existing);if(p.apiKeyEnv!==REF||p.baseURL!==v.baseURL||p.api!=='openai-completions')throw Error('provider_conflict')}
 const profile={displayName:'XHarness',api:'openai-completions',baseURL:v.baseURL,apiKeyEnv:REF,models:v.models}
 const write=await api.settings.mutate({ns:NS,expectedRevision:ns.revision,ops:[{op:'set',path:['providers',ROUTE],value:profile}]});if(!write.result.ok)throw Error('settings_write_failed');describe.acceptView(write.result.value)
 const stored=await api.credentials.set({ref:REF,value:v.accessToken});if(!stored.result.ok)throw Error('credential_store_failed')
}

export interface ConnectionSnapshot {
  native: boolean; flow: {code:string;uri:string}|null; connected:boolean; busy:boolean; error:boolean; retry:boolean
}
/** Plugin-owned lifecycle, not modal-owned: leaving Settings never cancels login. */
export class ManagedConnection {
  private view:ConnectionSnapshot={native:false,flow:null,connected:false,busy:false,error:false,retry:false}
  private listeners=new Set<()=>void>()
  private bridge:TauriBridge|undefined
  private active=false
  private working=false
  private halted=false
  private timer:ReturnType<typeof setInterval>|undefined
  private revision=0
  constructor(private api:IApiClient,private describe:SettingsDescribeFace){}
  getSnapshot=()=>this.view
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
  private update(next:Partial<ConnectionSnapshot>){this.view={...this.view,...next};this.revision++;for(const fn of this.listeners)fn()}
  attach(bridge:TauriBridge|undefined){
    this.active=true;this.bridge=bridge;this.update({native:!!bridge});let closed=false
    const revision=this.revision
    void this.api.credentials.describe({refs:[REF]}).then(r=>{if(this.active&&this.revision===revision&&r.result.ok)this.update({connected:r.result.value.credentials[REF]?.configured===true})}).catch(()=>{})
    if(bridge){
      void bridge.core.invoke('desktop_account_status').then(raw=>{const v=objectValue(raw);if(this.active&&typeof v.userCode==='string'&&typeof v.verificationUri==='string')this.update({flow:{code:v.userCode,uri:v.verificationUri}})}).catch(()=>{if(this.active)this.update({error:true})})
      this.timer=setInterval(()=>{void this.tick()},5000)
    }
    let unlisten:(()=>void)|undefined
    if(bridge?.event)void bridge.event.listen('xharness-account-ready',()=>{void this.tick()}).then(fn=>{if(closed)fn();else unlisten=fn}).catch(()=>{})
    return()=>{closed=true;this.active=false;if(this.timer)clearInterval(this.timer);unlisten?.()}
  }
  async start(){
    if(!this.bridge||this.view.busy||this.working)return
    this.update({busy:true,error:false});this.halted=false
    try{
      if(!this.view.flow){const v=objectValue(await this.bridge.core.invoke('desktop_account_start'));if(typeof v.userCode!=='string'||typeof v.verificationUri!=='string')throw Error();if(this.active)this.update({flow:{code:v.userCode,uri:v.verificationUri}})}
      await this.bridge.core.invoke('desktop_account_open')
    }catch{if(this.active)this.update({error:true})}finally{if(this.active)this.update({busy:false})}
  }
  async open(){try{await this.bridge?.core.invoke('desktop_account_open')}catch{if(this.active)this.update({error:true})}}
  async tick(){
    if(!this.active||!this.bridge||!this.view.flow||this.view.busy||this.working||this.halted)return
    this.working=true;let saving=false
    try{
      const raw=await this.bridge.core.invoke('desktop_account_poll');if(!this.active)return
      const v=objectValue(raw)
      if(v.status==='authorized'){
        saving=true;await saveManagedAccess(this.api,this.describe,raw)
        await this.bridge.core.invoke('desktop_account_finish',{saved:true})
        if(this.active)this.update({connected:true,flow:null,error:false,retry:false})
      }
    }catch(error){
      if(this.active){
        if(error==='account_poll_pending')return
        if(error==='account_connection_expired'||error==='account_connection_missing')this.update({flow:null,error:true,retry:false})
        else {this.halted=saving;this.update({error:true,retry:saving})}
      }
    }finally{this.working=false}
  }
  retry(){this.halted=false;this.update({error:false,retry:false});void this.tick()}
  async cancel(){
    if(!this.bridge||this.working||this.view.busy)return
    this.update({busy:true})
    try{await this.bridge.core.invoke('desktop_account_finish',{saved:false});this.halted=false;if(this.active)this.update({flow:null,retry:false,error:false})}
    catch{if(this.active)this.update({error:true})}finally{if(this.active)this.update({busy:false})}
  }
  async disconnect(){
    if(this.view.busy||this.working)return
    this.update({busy:true})
    try{const r=await this.api.credentials.unset({ref:REF});if(!r.result.ok)throw Error();if(this.active)this.update({connected:false})}
    catch{if(this.active)this.update({error:true})}finally{if(this.active)this.update({busy:false})}
  }
}
