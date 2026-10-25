/** These fixed functions execute in the extension's isolated world. They capture no module variables. */
interface ObservationState {id:string;expires:number;elements:Map<string,Element>}
declare global {interface Window {__xharnessBrowserObservation?:ObservationState}}
export function observeDom(observationId:string):{observationId:string;text:string;nodes:{ref:string;role:string;name:string;tag:string}[];truncated:boolean;scope:string} {
  const nodes:{ref:string;role:string;name:string;tag:string}[]=[],elements=new Map<string,Element>()
  const encoder=new TextEncoder()
  const clip=(value:string,limit:number):string=>{let out='',bytes=0;for(const char of value){const size=encoder.encode(char).length;if(bytes+size>limit)break;out+=char;bytes+=size}return out}
  for(const element of document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[contenteditable="true"]')){
    if(nodes.length>=64)break
    if(element instanceof HTMLInputElement&&element.type==='password')continue
    const style=getComputedStyle(element)
    if(style.display==='none'||style.visibility!=='visible'||element.getClientRects().length===0||element.closest('[hidden],[inert],[aria-hidden="true"]'))continue
    const ref='n'+nodes.length
    const label=element.getAttribute('aria-label')??(element instanceof HTMLElement?element.innerText:'')??''
    const linked=element.id?Array.from(document.querySelectorAll('label')).find(item=>item.htmlFor===element.id)?.innerText:undefined
    const name=clip(label.trim()||linked||element.getAttribute('placeholder')||element.getAttribute('title')||element.tagName.toLowerCase(),80)
    nodes.push({ref,role:element.getAttribute('role')??element.tagName.toLowerCase(),name,tag:element.tagName.toLowerCase()});elements.set(ref,element)
  }
  window.__xharnessBrowserObservation={id:observationId,expires:Date.now()+30000,elements}
  const walker=document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_TEXT)
  let body='',visited=0,textTruncated=false,node:Node|null=null
  while((node=walker.nextNode())&&visited++<3000&&encoder.encode(body).length<8000){
    const parent=node.parentElement
    if(!parent||parent.closest('script,style,input,textarea,[hidden],[inert],[aria-hidden="true"]')||getComputedStyle(parent).visibility!=='visible'||parent.getClientRects().length===0)continue
    const raw=node.textContent??'',part=clip(raw,Math.max(0,8000-encoder.encode(body).length))
    if(part.length<raw.length)textTruncated=true
    body+=part+' '
  }
  const result={observationId,text:clip(body,8000),nodes,truncated:textTruncated||node!==null||nodes.length===64,scope:'main-frame; password values excluded; cross-origin frames not traversed'}
  while(encoder.encode(JSON.stringify(result)).length>16000){const removed=nodes.pop();if(!removed)throw Error('Observation exceeded byte budget');elements.delete(removed.ref);result.truncated=true}
  return result
}
export function resolveRef(observationId:string,ref:string,fill:boolean):{x:number;y:number} {
  const state=window.__xharnessBrowserObservation
  // Consume before any focus/scroll/effect. Replaced or removed DOM nodes cannot inherit refs.
  delete window.__xharnessBrowserObservation
  if(!state||state.id!==observationId||Date.now()>state.expires)throw Error('Observation expired; observe again')
  const element=state.elements.get(ref)
  if(!(element instanceof HTMLElement)||!element.isConnected)throw Error('Stale element; observe again')
  if(element.closest('[hidden],[inert],[aria-hidden="true"]')||element.matches(':disabled,[aria-disabled="true"]'))throw Error('Element is unavailable')
  const style=getComputedStyle(element)
  if(style.visibility!=='visible'||style.display==='none'||style.pointerEvents==='none')throw Error('Element is not interactable')
  element.scrollIntoView({block:'center',inline:'center',behavior:'instant'})
  const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2
  if(rect.width===0||rect.height===0||x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('Element is outside the viewport')
  const hit=document.elementFromPoint(x,y)
  if(!hit||!(element===hit||element.contains(hit)))throw Error('Element is occluded')
  if(fill){
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement){
      if(element.readOnly||element instanceof HTMLInputElement&&element.type==='password')throw Error('This field cannot be filled')
      element.focus();element.select()
    }else if(element.isContentEditable){
      element.focus();const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range)
    }else throw Error('Element is not a text field')
  }
  return {x,y}
}

export function invalidateObservation():void {delete window.__xharnessBrowserObservation}
