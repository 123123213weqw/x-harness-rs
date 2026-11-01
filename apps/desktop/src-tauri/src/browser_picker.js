// Fixed user-selection overlay. Guest evidence is untrusted. No IPC/network
// callbacks, form values or page-action replay are installed by this script.
function(args) {
  const key='__xharnessComponentPickerV1', previous=window[key];
  if(args.action!=='start') {
    if(!previous||previous.token!==args.token)return JSON.stringify({status:'cancelled'});
    if(args.action==='cancel'){previous.cancel();delete window[key];return JSON.stringify({status:'cancelled'});}
    const result=previous.result;if(result.status!=='pending')delete window[key];return JSON.stringify(result);
  }
  previous?.cancel();
  const state={token:args.token,result:{status:'pending'},cancel:()=>{}};window[key]=state;
  const viewport={x:scrollX,y:scrollY,width:innerWidth,height:innerHeight};
  const host=document.createElement('div');
  host.style.cssText='all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;touch-action:none;';
  const shadow=host.attachShadow({mode:'closed'}),box=document.createElement('div'),tip=document.createElement('div');
  box.style.cssText='position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #5689ff;background:#5689ff22;display:none;';
  tip.textContent='点击选择组件 · 拖拽框选 · Esc 取消';
  tip.style.cssText='position:fixed;top:12px;left:12px;padding:8px 12px;background:#18243f;color:white;border-radius:8px;font:13px system-ui;pointer-events:none;';
  shadow.append(box,tip);document.documentElement.append(host);
  let down=null,finished=false,timer;
  const rect=r=>({x:Math.round(r.x*100)/100,y:Math.round(r.y*100)/100,width:Math.round(r.width*100)/100,height:Math.round(r.height*100)/100});
  const draw=r=>{box.style.display='block';Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});};
  const hit=(x,y)=>{host.style.pointerEvents='none';let e=document.elementFromPoint(x,y);while(e?.shadowRoot){const inner=e.shadowRoot.elementFromPoint(x,y);if(!inner||inner===e)break;e=inner;}host.style.pointerEvents='auto';return e;};
  const selector=e=>{const parts=[];for(let n=e;n&&parts.length<7;n=n.parentElement){let part=n.localName;if(n.id){part+='#'+CSS.escape(n.id).slice(0,100);parts.unshift(part);break;}const peers=n.parentElement?[...n.parentElement.children].filter(s=>s.localName===n.localName):[];if(peers.length>1)part+=':nth-of-type('+(peers.indexOf(n)+1)+')';parts.unshift(part);}return {selector:parts.join(' > '),root:e.getRootNode() instanceof ShadowRoot?'shadow-root':'document'};};
  const describe=e=>{
    const style=getComputedStyle(e),styles={};for(const name of ['display','position','color','background-color','font-size','font-weight','line-height','padding','margin','border-radius','gap','grid-template-columns','flex-direction'])styles[name]=style.getPropertyValue(name).slice(0,100);
    const sensitive='input,textarea,select,[contenteditable],[data-private]';
    let text='';if(!e.matches(sensitive)&&!e.closest(sensitive)){const walk=document.createTreeWalker(e,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:n=>n.nodeType===1&&(n.matches('script,style,noscript,'+sensitive))?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});let n,count=0;while((n=walk.nextNode())&&count++<500&&text.length<600)if(n.nodeType===3)text+=n.textContent+' ';text=text.replace(/\s+/g,' ').trim().slice(0,600);}
    return {...selector(e),tag:e.localName,id:e.id.slice(0,100),classes:[...e.classList].slice(0,6).map(s=>s.slice(0,60)),text,bounds:rect(e.getBoundingClientRect()),styles,opaqueFrame:e.localName==='iframe'};
  };
  const unchanged=()=>scrollX===viewport.x&&scrollY===viewport.y&&innerWidth===viewport.width&&innerHeight===viewport.height;
  const cleanup=()=>{clearTimeout(timer);host.remove();for(const [name,fn] of listeners)window.removeEventListener(name,fn,true);};
  const finish=result=>{if(finished)return;finished=true;state.result=result;cleanup();};state.cancel=()=>finish({status:'cancelled'});
  const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
  const move=e=>{stop(e);if(down)draw({x:Math.min(down.x,e.clientX),y:Math.min(down.y,e.clientY),width:Math.abs(down.x-e.clientX),height:Math.abs(down.y-e.clientY)});else{const el=hit(e.clientX,e.clientY);if(el)draw(el.getBoundingClientRect());}};
  const start=e=>{stop(e);if(e.button===0){down={x:e.clientX,y:e.clientY,id:e.pointerId};host.setPointerCapture?.(e.pointerId);}};
  const end=e=>{
    stop(e);if(!down||down.id!==e.pointerId)return;if(!unchanged()){state.cancel();return;}
    const ex=Math.max(0,Math.min(innerWidth,e.clientX)),ey=Math.max(0,Math.min(innerHeight,e.clientY));
    const area={x:Math.min(down.x,ex),y:Math.min(down.y,ey),width:Math.abs(down.x-ex),height:Math.abs(down.y-ey)};
    const region=area.width>5&&area.height>5;let elements=[],truncated=false;
    if(region){const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);let n,count=0;while((n=walk.nextNode())&&count++<5000&&elements.length<8){if(n===host||elements.some(p=>p.contains(n)))continue;const r=n.getBoundingClientRect();if(r.width>0&&r.height>0&&r.x>=area.x&&r.y>=area.y&&r.right<=area.x+area.width&&r.bottom<=area.y+area.height&&getComputedStyle(n).visibility==='visible')elements.push(n);}truncated=count>=5000||elements.length>=8;if(!elements.length){const center=hit(area.x+area.width/2,area.y+area.height/2);if(center)elements=[center];}}
    else{const el=hit(e.clientX,e.clientY);if(el)elements=[el];}
    if(!elements.length){finish({status:'empty'});return;}
    const b=region?area:elements[0].getBoundingClientRect(),x=Math.max(0,b.x),y=Math.max(0,b.y);
    const swallow=e=>{stop(e);window.removeEventListener('click',swallow,true);};window.addEventListener('click',swallow,true);setTimeout(()=>window.removeEventListener('click',swallow,true),400);
    finish({status:'selected',selection:{mode:region?'region':'element',bounds:rect({x,y,width:Math.min(innerWidth,b.x+b.width)-x,height:Math.min(innerHeight,b.y+b.height)-y}),viewport,page:{origin:location.origin,path:location.pathname.slice(0,300)},elements:elements.map(describe),truncated,coordinateSpace:'CSS viewport pixels',untrusted:true}});
  };
  const keyboard=e=>{stop(e);if(e.key==='Escape')state.cancel();},cancel=()=>state.cancel();
  const listeners=[['pointermove',move],['pointerdown',start],['pointerup',end],['click',stop],['dblclick',stop],['contextmenu',stop],['keydown',keyboard],['keyup',stop],['wheel',stop],['touchstart',stop],['scroll',cancel],['resize',cancel],['pagehide',cancel],['blur',cancel],['pointercancel',cancel]];
  for(const [name,fn] of listeners)window.addEventListener(name,fn,{capture:true,passive:false});timer=setTimeout(cancel,90000);
  return JSON.stringify({status:'pending'});
}
