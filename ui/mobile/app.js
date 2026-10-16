const $ = id => document.getElementById(id);
// Presentation only: keep the app shell inside the visible viewport. In iOS
// the keyboard can shrink visualViewport without resizing the layout viewport.
function syncViewport(){
 const viewport=window.visualViewport;
 if(viewport&&viewport.scale!==1)return; // Preserve browser pinch-to-zoom.
 const height=Math.round(viewport?.height??window.innerHeight);
 if(!Number.isFinite(height)||height<=0)return;
 const top=Math.max(0,Math.round(viewport?.offsetTop??0));
 const root=document.documentElement;
 root.style.setProperty('--app-height',height+'px');
 root.style.setProperty('--app-top',Number.isFinite(top)?top+'px':'0px');
 root.dataset.compact=String(height<520);
}
function setView(view){document.documentElement.dataset.view=view;}
setView('pair');
syncViewport();
window.addEventListener('resize',syncViewport,{passive:true});
window.addEventListener('pageshow',syncViewport,{passive:true});
window.visualViewport?.addEventListener('resize',syncViewport,{passive:true});
window.visualViewport?.addEventListener('scroll',syncViewport,{passive:true});
const ERROR = {unauthorized:'尚未配对或设备授权已失效。请在电脑生成配对二维码；已配对可先尝试重新连接。',host_offline:'电脑未连接中继。已接纳的任务不会因此取消。',host_unavailable:'原生会话暂不可用。',conflict:'会话或授权版本已变化，请刷新后重新确认。',pair_expired:'配对码已过期，请在电脑重新生成。',pair_consumed:'配对码已使用，请重新生成。',capacity:'达到请求或附件上限，请稍后核验。',stream_gap:'输出记录出现缺口，请刷新恢复原生历史。',invalid_request:'请求无效，请检查输入。',storage_unavailable:'持久记录暂不可用。',timeout:'连接超时，操作结果可能未知；不会自动重发。',connection_lost:'连接中断，操作结果可能未知；不会自动重发。',invalid_response:'服务响应不符合协议，未展示为成功。',request_rejected:'原始请求已被拒绝或放弃，没有重新执行。'};
let status, generation, after=0, pending, working=false, polling=false, active=false, epoch=0, tick=0;
const messages = new Map();
const interactionViews = new Map();
function record(v){if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('invalid_response');return v;}
function ids(v){if(!Array.isArray(v)||v.length>4096)throw new Error('invalid_response');return v;}
function integer(v){if(!Number.isSafeInteger(v)||v<0)throw new Error('invalid_response');return v;}
function text(v,max=200000){if(typeof v!=='string'||v.length>max)throw new Error('invalid_response');return v;}
function element(tag,content){const el=document.createElement(tag);if(content!==undefined)el.textContent=content;return el;}
function issue(error){const code=error?.message??'connection_lost';if(code==='unauthorized')sealScope();$('error').textContent=ERROR[code]??'操作未完成，请核验原始请求。';$('error').hidden=false;}
function clearIssue(){$('error').hidden=true;}
// Pending operations have their own modal surface, never the chat scroll offset.
function syncInteractionReview(){const count=interactionViews.size;$('review-interactions').hidden=!count;$('review-interactions').textContent='Review ('+count+')';if(!count&&$('interaction-dialog').open)$('interaction-dialog').close();}
function clearInteractions(){interactionViews.clear();$('interactions').replaceChildren();syncInteractionReview();}
function sealScope(){epoch++;active=false;status=undefined;generation=undefined;after=0;clearInteractions();messages.clear();$('timeline').replaceChildren();$('pair').hidden=false;$('control').hidden=!pending;setView(pending?'recovery':'pair');$('scope').textContent='设备授权已封闭 · 原始请求仍可核验，不会重发';$('connection').textContent='尚未配对或设备授权已失效 · 请配对';setWorking(working);}
async function api(route,body){
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),35000);
 try{
  const response=await fetch(new URL('api/mobile/'+route,location.href),{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:abort.signal});
  const reader=response.body?.getReader();if(!reader)throw new Error('invalid_response');const chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new Error('capacity');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const buffer=new Uint8Array(size);let pos=0;for(const chunk of chunks){buffer.set(chunk,pos);pos+=chunk.length;}
  let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{throw new Error('invalid_response');}
  const envelope=record(raw);if(!response.ok||envelope.ok!==true)throw new Error(typeof envelope.error==='string'?envelope.error:'invalid_response');return envelope.result;
 }catch(error){if(error instanceof Error&&Object.hasOwn(ERROR,error.message))throw error;throw new Error('connection_lost');}finally{clearTimeout(timer);}
}
function remember(value){pending=value;try{if(value)sessionStorage.setItem('xh-mobile-pending',JSON.stringify(value));else sessionStorage.removeItem('xh-mobile-pending');}catch{}$('unknown').hidden=!value?.unknown;}
try{const saved=sessionStorage.getItem('xh-mobile-pending');if(saved){const p=record(JSON.parse(saved));if(typeof p.request_id==='string'&&p.request_id.length<=128)remember({...p,unknown:true});}}catch{}
function setWorking(value){working=value;for(const button of $('control').querySelectorAll('button'))button.disabled=value||(!status&&button!==$('refresh')&&button!==$('inspect')&&button!==$('abandon'));$('sessions').disabled=value||!status;$('prompt').disabled=!status;$('files').disabled=!status;$('mode').disabled=!status;}
function renderReceipt(receipt){const r=record(receipt);text(r.key,128);integer(r.generation);if(!['queued','dispatching','completed','rejected','uncertain','abandoned'].includes(r.state))throw new Error('invalid_response');
 $('connection').textContent=({queued:'请求已入队',dispatching:'Host 正在处理请求',completed:'请求已处理 · 不代表 Agent 已完成',rejected:'请求被拒绝',uncertain:'原生操作结果未知',abandoned:'请求已放弃'})[r.state];
 if(r.state==='uncertain'){remember({...pending,key:r.key,unknown:true});return null;}if(['rejected','abandoned'].includes(r.state)){remember(null);throw new Error('request_rejected');}
 if(r.state!=='completed')return undefined;if(r.result_withheld)throw new Error('conflict');const result=record(r.result);if(typeof result.ok!=='boolean')throw new Error('invalid_response');if(result.ok!==true){remember(null);throw new Error('request_rejected');}if(!Object.hasOwn(result,'value'))throw new Error('invalid_response');remember(null);return {ok:true,value:result.value};
}
async function awaitReceipt(first){let r=first;for(let count=0;count<30;count++){const result=renderReceipt(r);if(result!==undefined)return result;remember({...pending,key:r.key});await new Promise(resolve=>setTimeout(resolve,300));r=await api('action',{type:'delivery',key:r.key});}throw new Error('timeout');}
async function command(command){
 if(working||!status||!Number.isSafeInteger(generation)||pending)return null;setWorking(true);clearIssue();
 const request_id=crypto.randomUUID();remember({request_id,generation,kind:command.type});
 try{return await awaitReceipt(await api('action',{type:'command',request_id,generation,command}));}
 catch(error){// A post-admission fence/response failure is not proof that Host did nothing.
 if(pending)remember({...pending,unknown:true});issue(error);return null;}
 finally{setWorking(false);}
}
async function readStatus(){const r=record(await api('action',{type:'status'}));const b=record(r.binding);integer(r.generation);integer(b.generation);text(r.host,512);text(r.device,512);integer(r.principal_revision);text(b.workspace,512);text(b.session,512);if(r.generation!==b.generation)throw new Error('invalid_response');
 const changed=status&&(status.host!==r.host||status.device!==r.device||status.principal_revision!==r.principal_revision||status.binding.session!==b.session||generation!==r.generation);status=r;generation=r.generation;active=true;$('pair').hidden=true;$('control').hidden=false;setView('control');$('logout').hidden=false;$('scope').textContent='默认会话：'+b.session+' · 授权版本 '+integer(r.principal_revision);if(!pending)$('connection').textContent='电脑连接正常';if(changed){epoch++;after=0;messages.clear();$('timeline').replaceChildren();clearInteractions();}setWorking(working);return changed;
}
async function catalogue(){const r=record(await api('action',{type:'catalogue',after:null}));const c=record(r.catalogue);const workspaces=ids(c.workspaces),sessions=ids(c.sessions);$('sessions').replaceChildren();for(const s of sessions){record(s);const w=workspaces.find(w=>w.id===s.workspace);const option=element('option',(w?.title??s.workspace)+' / '+(s.title??s.id)+(s.running?' · 执行中':''));option.value=JSON.stringify({workspace:text(s.workspace,512),session:text(s.id,512)});option.selected=s.id===status.binding.session&&s.workspace===status.binding.workspace;$('sessions').append(option);}if(c.next)$('scope').textContent+=' · 当前显示前25个会话';}
function bodyText(content,depth=0){if(depth>8||!Array.isArray(content))return '';return content.slice(0,128).map(c=>c?.type==='text'?(typeof c.text==='string'?c.text:''):c?.type==='tool-result'?(typeof c.content==='string'?c.content:bodyText(c.content,depth+1)):'').filter(Boolean).join('\n');}
function putMessage(key,label,content,append=false){let item=messages.get(key);if(!item){const article=element('article');article.className='message';article.append(element('strong',label));const pre=element('pre','');article.append(pre);$('timeline').append(article);item={article,pre};messages.set(key,item);}item.pre.textContent=append?item.pre.textContent+content:content;while(messages.size>500){const oldest=messages.keys().next().value;messages.get(oldest).article.remove();messages.delete(oldest);}return item;}
function frame(frame){record(frame);const payload=record(frame.payload);if(payload.sessionId!==status.binding.session)return;
 if(frame.method==='session/event'){const event=record(payload.event),data=record(event.data??{});const seq=integer(event.seq),key='assistant:'+String(data.turn)+':'+String(data.step);
  if(event.type==='user/message')putMessage('user:'+seq,'你',bodyText(data.content));
  else if(event.type==='assistant/message')putMessage(key,data.interrupted?'XHarness · 已中断':'XHarness',bodyText(data.message?.content));
  else if(event.type==='assistant/chunk'&&data.chunk?.type==='text-delta')putMessage(key,'XHarness · 正在输出',text(data.chunk.text),true);
  else if(event.type==='tool/call'&&!messages.has('tool-call:'+seq)){const detail=element('details');detail.className='message';detail.append(element('summary','工具：'+String(data.name??'原生工具')));detail.append(element('pre',JSON.stringify(data.arguments??{},null,2)));$('timeline').append(detail);messages.set('tool-call:'+seq,{article:detail,pre:detail.querySelector('pre')});while(messages.size>500){const oldest=messages.keys().next().value;messages.get(oldest).article.remove();messages.delete(oldest);}}
  else if(event.type==='tool/result')putMessage('tool:'+seq,'工具结果',bodyText(data.message?.content));
 }
}
function interaction(ticket){record(ticket);text(ticket.token,64);integer(ticket.expires_at_ms);const original=record(ticket.interaction),f=record(original.frame),p=record(f.payload);if(p.sessionId!==status.binding.session||ticket.expires_at_ms<=Date.now())return;
 if(!['approval/requested','question/requested'].includes(f.method))throw new Error('invalid_response');
 const signature=JSON.stringify(ticket),previous=interactionViews.get(ticket.token);
 if(previous&&previous.generation===generation&&previous.signature===signature&&previous.section.parentElement===$('interactions'))return previous.section;
 if(previous){previous.section.remove();interactionViews.delete(ticket.token);}
 const section=element('section');section.append(element('strong',f.method==='approval/requested'?'需要你的审批':'需要你的回答'));
 const issuedGeneration=generation;
 function current(){return interactionViews.get(ticket.token)?.section===section&&generation===issuedGeneration&&status?.binding.session===p.sessionId&&ticket.expires_at_ms>Date.now();}
 function stale(){if(interactionViews.get(ticket.token)?.section===section){interactionViews.delete(ticket.token);section.remove();syncInteractionReview();}issue(new Error('conflict'));return null;}
 async function answer(value){if(!current())return stale();return command({type:'answer_interaction',ticket:ticket.token,answer:value});}
 if(f.method==='approval/requested'){section.append(element('p',String(p.toolName??'')+'\n'+String(p.reason??'')));for(const [label,allowed] of [['仅允许这一次',true],['拒绝',false]]){const button=element('button',label);button.onclick=async()=>{if(!current())return stale();if(allowed&&!confirm('确认允许这一次原生工具操作？'))return;const result=await answer({type:'approval',allowed});if(result!==null)await snapshot();};section.append(button);}}
 else if(f.method==='question/requested'){const form=element('form');const controls=[];for(const q of ids(p.questions)){record(q);const label=element('label',String(q.question??q.header??'')),select=element('select'),custom=element('input');select.append(Object.assign(element('option','选择回答或输入自定义内容'),{value:''}));for(const option of ids(q.options??[])){const opt=element('option',String(option.label??''));opt.value=String(option.label??'');select.append(opt);}custom.placeholder='自定义回答';custom.maxLength=8192;label.append(select,custom);form.append(label);controls.push({q,select,custom});}const submit=element('button','提交回答');submit.type='submit';form.append(submit);form.onsubmit=async event=>{event.preventDefault();if(!current())return stale();const answers=controls.map(({q,select,custom})=>({id:q.id,selected:select.value||null,custom:custom.value||null}));if(answers.some(a=>!a.selected&&!a.custom)){issue(new Error('invalid_request'));return;}const result=await answer({type:'question',answers});if(result!==null)await snapshot();};section.append(form);const cancel=element('button','取消这组问题');cancel.onclick=async()=>{const result=await answer({type:'cancel_question'});if(result!==null)await snapshot();};section.append(cancel);}
 interactionViews.set(ticket.token,{section,signature,generation:issuedGeneration});$('interactions').append(section);syncInteractionReview();return section;
}
async function snapshot(){const cut=epoch,expectedGeneration=generation;const r=record(await api('action',{type:'snapshot'}));if(cut!==epoch||generation!==expectedGeneration||integer(r.generation)!==generation)return;const tickets=ids(r.interactions),keep=new Set();for(const ticket of tickets){record(ticket);text(ticket.token,64);integer(ticket.expires_at_ms);const p=record(record(record(ticket.interaction).frame).payload);if(p.sessionId!==status.binding.session||ticket.expires_at_ms<=Date.now())continue;if(keep.has(ticket.token))throw new Error('invalid_response');keep.add(ticket.token);interaction(ticket);}for(const [token,view] of interactionViews)if(!keep.has(token)){view.section.remove();interactionViews.delete(token);}syncInteractionReview();}
async function events(){const cut=epoch;const r=record(await api('action',{type:'events',after}));if(cut!==epoch||integer(r.generation)!==generation)return;const page=record(r.page),items=ids(page.events),start=integer(page.start_seq),next=integer(page.next_seq),head=integer(page.head_seq);if(start!==after||next>head||next-start!==items.length||items.length>128)throw new Error('stream_gap');for(let i=0;i<items.length;i++){const e=record(items[i]),p=record(e.payload);if(e.method!=='session/event'||p.type!=='session/event'||p.sessionId!==status.binding.session||integer(record(p.event).seq)!==start+i)throw new Error('invalid_response');}for(const note of $('timeline').querySelectorAll('p'))if(note.parentElement===$('timeline'))note.remove();for(const event of items)frame(event);after=next;if(!$('timeline').children.length)$('timeline').append(element('p','这个会话暂时没有消息。'));}
async function refresh(force=false){if(working)return;while(polling){if(!force)return;await new Promise(resolve=>setTimeout(resolve,50));}polling=true;clearIssue();try{await readStatus();await catalogue();await events();await snapshot();}catch(error){issue(error);}finally{polling=false;}}
$('pair-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;const data=new FormData(form),button=form.querySelector('button');button.disabled=true;clearIssue();const code=String(data.get('code'));form.elements.code.value='';history.replaceState(null,'',location.pathname);try{await api('pair',{host:String(data.get('host')),code,name:String(data.get('name'))});epoch++;clearInteractions();remember(null);await refresh(true);}catch(error){issue(error);}finally{button.disabled=false;}};
$('refresh').onclick=()=>refresh(true);
$('review-interactions').onclick=()=>{if(interactionViews.size&&!$('interaction-dialog').open)$('interaction-dialog').showModal();};
$('close-interactions').onclick=()=>{if($('interaction-dialog').open)$('interaction-dialog').close();};
$('reconnect').onclick=()=>refresh(true);
$('sessions').onchange=async event=>{const target=JSON.parse(event.target.value);await command({type:'select',target});await refresh(true);};
$('prompt-form').onsubmit=async event=>{event.preventDefault();const prompt=$('prompt').value.trim(),files=[...$('files').files];if(!prompt&&!files.length)return;if(files.length>8||files.reduce((n,f)=>n+f.size,0)>5*1024*1024){issue(new Error('capacity'));return;}const content=prompt?[{type:'text',text:prompt}]:[];try{for(const file of files){const buffer=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<buffer.length;offset+=8192)binary+=String.fromCharCode(...buffer.subarray(offset,offset+8192));content.push({type:file.type.startsWith('image/')?'image':'file',media_type:file.type||'application/octet-stream',data:btoa(binary),name:file.name});}const result=await command({type:'prompt',mode:$('mode').value,content,client_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone});if(result!==null){if($('prompt').value.trim()===prompt)$('prompt').value='';if([...$('files').files].every((file,index)=>file===files[index])&&$('files').files.length===files.length){$('files').value='';$('file-status').textContent='';}}}catch(error){issue(error);}};
$('files').onchange=()=>{$('file-status').textContent=[...$('files').files].map(f=>f.name).join(' · ');};
$('cancel').onclick=async()=>{if(confirm('确认请求取消当前原生任务？这不是断开网页连接。'))await command({type:'cancel'});};
$('inspect').onclick=async()=>{if(!pending)return;setWorking(true);clearIssue();try{const receipt=await api('action',{type:'delivery',key:pending.key??('request:'+pending.request_id)});renderReceipt(receipt);await readStatus();}catch(error){issue(error);}finally{setWorking(false);}};
$('logout').onclick=async()=>{if(!confirm('退出这个浏览器？不会取消任务或撤销电脑端设备授权。'))return;try{await api('logout',{});epoch++;remember(null);active=false;status=undefined;generation=undefined;messages.clear();$('timeline').replaceChildren();clearInteractions();$('control').hidden=true;$('pair').hidden=false;setView('pair');$('logout').hidden=true;$('connection').textContent='已退出 · 设备授权仍需在电脑撤销';}catch(error){issue(error);}};
$('automations').onclick=async()=>{const result=await command({type:'automation_read',read:{action:'list',after:null}});if(!result)return;const page=record(record(result.value).page);$('automation-list').replaceChildren();for(const entry of ids(page.entries)){record(entry);const row=element('section');row.append(element('p',String(entry.name??entry.id)+' · '+String(entry.state??'')));for(const [label,action] of [['查看','view'],['暂停','pause'],['恢复','resume']]){const button=element('button',label);button.onclick=async()=>{if(action!=='view'&&!confirm('确认'+label+'此原生自动化？'))return;const value=await command(action==='view'?{type:'automation_read',read:{action:'view',id:entry.id}}:{type:'automation_control',control:{action,id:entry.id}});if(value){const pre=element('pre',JSON.stringify(value.value,null,2));row.append(pre);}};row.append(button);}$('automation-list').append(row);}if(!page.entries.length)$('automation-list').append(element('p','这个会话没有已保存的自动化。'));};
$('abandon').onclick=()=>{if(pending&&confirm('请先核验原生会话记录。只放弃本地等待，不会取消已接纳的任务，也不会重发请求。确认已核验？')){remember(null);clearIssue();}};
// A QR/link may carry its short-lived code in the fragment, never query or logs.
const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.has('host')&&fragment.has('code')){$('pair-form').elements.host.value=fragment.get('host');$('pair-form').elements.code.value=fragment.get('code');history.replaceState(null,'',location.pathname);}
setInterval(async()=>{if(!active||working||polling||document.hidden)return;polling=true;try{await readStatus();await events();if(++tick%5===0)await snapshot();}catch(error){$('connection').textContent=error.message==='unauthorized'?'尚未配对或设备授权已失效 · 请配对':'连接中断 · 不自动重发';issue(error);if(error.message==='unauthorized')active=false;}finally{polling=false;}},2000);
// Existing cookies can reconnect; a failed initial read is not a successful pairing.
refresh();
