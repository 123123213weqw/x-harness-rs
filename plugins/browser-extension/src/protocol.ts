/** Only these structured operations cross the browser boundary; never raw CDP or JavaScript. */
export const HOST_NAME = 'com.xharness.browser_bridge'
export const MAX_WIRE = 4 * 1024 * 1024
export const MAX_TEXT = 16_000
export type Command =
  | {action:'status'} | {action:'tabs'} | {action:'stop'}
  | {action:'observe';tabId:number} | {action:'screenshot';tabId:number}
  | {action:'navigate';tabId:number;url:string}
  | {action:'click';tabId:number;observationId:string;ref:string}
  | {action:'fill';tabId:number;observationId:string;ref:string;text:string}
  | {action:'press';tabId:number;key:string}
export const KEYS = ['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown',' ']
export function object(value:unknown):Record<string,unknown> {
  if(typeof value!=='object'||value===null||Array.isArray(value))throw Error('Expected an object')
  return Object.fromEntries(Object.entries(value))
}
export function text(value:unknown,max=512):string {
  if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid text')
  if(value.length>max){let count=0;for(const _char of value)if(++count>max)throw Error('Text exceeded the character limit')}
  return value
}
export function id(value:unknown):string {
  const result=text(value,64)
  if(!/^[a-zA-Z0-9-]{1,64}$/.test(result))throw Error('Invalid identity')
  return result
}
export function tabId(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Invalid tab ID')
  return value
}
export function httpOrigin(value:unknown):string {
  const url=new URL(text(value,4096))
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Only credential-free HTTP(S) URLs are supported')
  return url.origin
}
export function command(value:unknown):Command {
  const input=object(value),action=text(input.action,20)
  const fields=action==='status'||action==='tabs'||action==='stop'?['action']:
    action==='navigate'?['action','tabId','url']:action==='click'?['action','tabId','observationId','ref']:
    action==='fill'?['action','tabId','observationId','ref','text']:action==='press'?['action','tabId','key']:['action','tabId']
  if(Object.keys(input).some(key=>!fields.includes(key)))throw Error('Unknown command field')
  if(action==='status'||action==='tabs'||action==='stop')return {action}
  const target=tabId(input.tabId)
  if(action==='observe'||action==='screenshot')return {action,tabId:target}
  if(action==='navigate'){const url=text(input.url,4096);httpOrigin(url);return {action,tabId:target,url}}
  if(action==='click'||action==='fill'){
    const base={tabId:target,observationId:id(input.observationId),ref:id(input.ref)}
    return action==='click'?{action,...base}:{action,...base,text:text(input.text,8192)}
  }
  if(action==='press'){const key=text(input.key,20);if(!KEYS.includes(key))throw Error('Unsupported key');return {action,tabId:target,key}}
  throw Error('Unsupported action')
}
export function mayMutate(value:Command):boolean {return ['click','fill','press','navigate'].includes(value.action)}
export function failure(error:unknown,uncertain=false):Record<string,unknown> {
  return {ok:false,outcome:uncertain?'possibly-applied':'not-started',error:error instanceof Error?error.message.slice(0,300):'Browser operation failed'}
}
const targetSchema={type:'integer',minimum:0,description:'A tab ID returned by tabs; the user must authorize it for this Host-bound conversation.'}
const observationSchema={type:'string',maxLength:64,description:'Latest observe observationId; expires after 30 seconds and is consumed by click/fill.'}
const refSchema={type:'string',maxLength:64,description:'One node ref from that observation, not a selector or coordinate.'}
export const schema={type:'object',oneOf:[
  {type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['status','tabs','stop']}},required:['action']},
  {type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['observe','screenshot']},tabId:targetSchema},required:['action','tabId']},
  {type:'object',additionalProperties:false,properties:{action:{const:'click'},tabId:targetSchema,observationId:observationSchema,ref:refSchema},required:['action','tabId','observationId','ref']},
  {type:'object',additionalProperties:false,properties:{action:{const:'fill'},tabId:targetSchema,observationId:observationSchema,ref:refSchema,text:{type:'string',maxLength:8192}},required:['action','tabId','observationId','ref','text']},
  {type:'object',additionalProperties:false,properties:{action:{const:'press'},tabId:targetSchema,key:{type:'string',enum:KEYS}},required:['action','tabId','key']},
  {type:'object',additionalProperties:false,properties:{action:{const:'navigate'},tabId:targetSchema,url:{type:'string',maxLength:4096,description:'HTTP(S) URL within the same explicitly approved origin.'}},required:['action','tabId','url']}
]}
