/** These fixed functions execute in the extension's isolated world. They capture no module variables. */
interface ObservationState {
  id:string;expires:number;elements:Map<string,Element>;url:string;dirty:boolean;observer:MutationObserver;
  controls:TreeWalker;texts:TreeWalker;pendingText:string;nodesDone:boolean;textDone:boolean
}
declare global {interface Window {__xharnessBrowserObservation?:ObservationState}}
export function observeDom(observationId:string,cursor:string|null=null):{observationId:string;text:string;nodes:{ref:string;role:string;name:string;tag:string}[];truncated:boolean;nextCursor:string|null;scope:string} {
  const previous=window.__xharnessBrowserObservation
  delete window.__xharnessBrowserObservation
  if(cursor&&(!previous||previous.id!==cursor||Date.now()>previous.expires||previous.dirty||previous.observer.takeRecords().length||previous.url!==location.href)){
    previous?.observer.disconnect();throw Error('Observation page expired or changed; observe again without cursor')
  }
  if(!cursor)previous?.observer.disconnect()
  const state:ObservationState=cursor&&previous?previous:{id:observationId,expires:Date.now()+30000,elements:new Map(),url:location.href,dirty:false,
    observer:new MutationObserver(()=>{state.dirty=true}),controls:document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_ELEMENT),
    texts:document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_TEXT),pendingText:'',nodesDone:false,textDone:false}
  if(!cursor)state.observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
  state.id=observationId;state.expires=Date.now()+30000;state.elements=new Map()
  const nodes:{ref:string;role:string;name:string;tag:string}[]=[],encoder=new TextEncoder()
  const clip=(value:string,limit:number):string=>{let out='',bytes=0;for(const char of value){const size=encoder.encode(char).length;if(bytes+size>limit)break;out+=char;bytes+=size}return out}
  // Each page bounds traversal as well as output. Continuation advances both
  // walkers, so offscreen controls and long documents remain reachable.
  for(let visited=0;!state.nodesDone&&visited<3000&&nodes.length<64;visited++){
    const node=state.controls.nextNode();if(!node){state.nodesDone=true;break}
    if(!(node instanceof Element)||!node.matches('button,a[href],input,textarea,select,[role="button"],[contenteditable="true"]'))continue
    const element=node
    if(element instanceof HTMLInputElement&&element.type==='password')continue
    const style=getComputedStyle(element)
    if(style.display==='none'||style.visibility!=='visible'||element.getClientRects().length===0||element.closest('[hidden],[inert],[aria-hidden="true"]'))continue
    const ref='n'+nodes.length
    const label=element.getAttribute('aria-label')??(element instanceof HTMLElement?element.innerText:'')??''
    const linked=element.id?Array.from(document.querySelectorAll('label')).find(item=>item.htmlFor===element.id)?.innerText:undefined
    const name=clip(label.trim()||linked||element.getAttribute('placeholder')||element.getAttribute('title')||element.tagName.toLowerCase(),80)
    nodes.push({ref,role:clip(element.getAttribute('role')??element.tagName.toLowerCase(),80),name,tag:clip(element.tagName.toLowerCase(),32)});state.elements.set(ref,element)
    if(encoder.encode(JSON.stringify(nodes)).length>12000){nodes.pop();state.elements.delete(ref);state.controls.previousNode();break}
  }
  const undefinedCursor=():string|null=>null
  const result={observationId,text:'',nodes,truncated:false,nextCursor:undefinedCursor(),scope:'main-frame; password values excluded; cross-origin frames not traversed'}
  const budget=Math.min(8000,16000-encoder.encode(JSON.stringify(result)).length-128)
  let bytes=0
  for(let visited=0;!state.textDone&&visited<3000&&bytes<budget;visited++){
    if(!state.pendingText){
      const node=state.texts.nextNode();if(!node){state.textDone=true;break}
      const parent=node.parentElement
      if(!parent||parent.closest('script,style,input,textarea,[hidden],[inert],[aria-hidden="true"]')||getComputedStyle(parent).visibility!=='visible'||parent.getClientRects().length===0)continue
      state.pendingText=(node.textContent??'')+' '
    }
    let part='',partBytes=0
    for(const char of state.pendingText){const size=encoder.encode(JSON.stringify(char)).length-2;if(partBytes+size>budget-bytes)break;part+=char;partBytes+=size}

    if(!part)break
    result.text+=part;bytes+=partBytes;state.pendingText=state.pendingText.slice(part.length)
  }
  result.truncated=!state.nodesDone||!state.textDone
  result.nextCursor=result.truncated?observationId:null
  window.__xharnessBrowserObservation=state
  return result
}
export function resolveRef(observationId:string,ref:string,fill:boolean):{x:number;y:number} {
  const state=window.__xharnessBrowserObservation
  // Consume before any focus/scroll/effect. Replaced or removed DOM nodes cannot inherit refs.
  delete window.__xharnessBrowserObservation
  state?.observer.disconnect()
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

export function invalidateObservation():void {window.__xharnessBrowserObservation?.observer.disconnect();delete window.__xharnessBrowserObservation}
