"""Synthetic UI-only challenges. No product runtime changes or payments."""
import argparse, subprocess, sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);root=p.parse_args().output
subprocess.run([sys.executable,str(Path(__file__).with_name('create-shop.py')),'--output',str(root)],check=True)
html=(root/'shop.html').read_text()
def replace_once(text,old,new,count=1):
    if text.count(old)!=1 or count!=1:raise RuntimeError('Base fixture changed: '+old[:60])
    return text.replace(old,new,1)
html=replace_once(html,"const products=", "const scenario=new URLSearchParams(location.search).get('case')||'filter';let seq=0;let showing=[];const products=",1)
html=replace_once(html,"JSON.stringify({type,detail,cart:","JSON.stringify({type,detail,scenario,seq:++seq,visible:showing.map(p=>p.id),scrollY:window.scrollY,cart:",1)
html=replace_once(html,"$('status').textContent=`${list.length} products`;","showing=list;$('status').textContent=`${list.length} products`;",1)
html=replace_once(html,"<h2>${p.name}</h2>","<h2>${p.name}</h2><button class=details aria-label=\"Details ${p.name}\">Details</button>",1)
html=replace_once(html,"a.querySelector('button').onclick", "a.querySelector('.details').onclick=()=>openDetails(p);a.querySelector('.actions button').onclick",1)
html=replace_once(html,"</style>","#overlay{position:fixed;inset:0;background:#0009;z-index:50;display:grid;place-items:center}#overlay div{background:white;padding:32px;border-radius:12px;width:360px}#overlay[hidden],#detail[hidden]{display:none}#detail{padding:24px;background:white}#layout-note{background:#e8edf1;padding:36px;margin-bottom:16px}</style>",1)
html=replace_once(html,'<section id="grid"', '<section id="detail" hidden></section><section id="grid"',1)
html=replace_once(html,"render();event('search',{});", "event('search_started',{});if(scenario==='slow-layout'){ $('grid').replaceChildren();$('status').textContent='Loading products…';setTimeout(()=>{render();const note=document.createElement('div');note.id='layout-note';note.textContent='Search complete — prices are below';$('grid').before(note);event('layout_shift',{});event('search',{});},2200);}else{render();event('search',{});}",1)
html=replace_once(html,"render();event('initial'", "initializeScenario();render();event('initial'",1)
extra='''
function openDetails(p){$('detail').hidden=false;$('detail').innerHTML=`<button id="back">Back to products</button><h2>${p.name}</h2><p>CNY ${p.price}</p><p>${spec(p)}</p><p>Product code: ${p.id}</p>`;$('grid').hidden=true;history.pushState({id:p.id},'', '#product-'+p.id);window.scrollTo(0,0);event('navigate_detail',{id:p.id});$('back').onclick=closeDetail;}
function closeDetail(){$('detail').hidden=true;$('grid').hidden=false;history.replaceState(null,'',location.pathname+location.search);event('return_products',{});}
window.addEventListener('popstate',()=>{if(!location.hash)closeDetail();});
function initializeScenario(){if(scenario==='scroll-detail'){const target=products.findIndex(p=>p.id==='other-779');const item=products.splice(target,1)[0];products.splice(11,0,item);}if(scenario==='modal'){const overlay=document.createElement('section');overlay.id='overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','Store announcement');overlay.innerHTML='<div><h2>Store announcement</h2><p>Browse freely. No account or payment is needed.</p><button id="dismiss">Continue browsing</button></div>';document.body.append(overlay);$('dismiss').onclick=()=>{overlay.remove();event('dismiss_modal',{});};}}
let lastScroll=0;window.addEventListener('scroll',()=>{if(Date.now()-lastScroll>150){lastScroll=Date.now();event('scroll',{});}});
'''
html=replace_once(html,"const chosen=new Set()",extra+"const chosen=new Set()",1)
(root/'expanded.html').write_text(html)
print('Expanded scenarios: filter, scroll-detail, modal, slow-layout')
