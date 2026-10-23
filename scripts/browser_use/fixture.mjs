import { createServer } from 'node:http';

/** Page-owned assertions, independent of browser tool receipts. */
export async function startFixture() {
  const states = new Map();
  const controls = new Map();
  const foreignRequests = [];
  const foreign = createServer((request, response) => {
    foreignRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url?.startsWith('/frame') ? `<button onclick="parent.postMessage({kind:'crossframe',trusted:event.isTrusted},'*')">Cross frame action</button>` : '<h1>Forbidden destination</h1>');
  });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const foreignAddress = foreign.address();
  if (!foreignAddress || typeof foreignAddress === 'string') throw new Error('Missing fixture address');
  const forbiddenOrigin = `http://127.0.0.1:${foreignAddress.port}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const id = url.searchParams.get('id') ?? 'default';
    const state = states.get(id) ?? { events: [], effects: 0 };
    states.set(id, state);
    if (url.pathname === '/control') {
      controls.set(id, response);
      response.once('close', () => { if (controls.get(id) === response) controls.delete(id); });
      return;
    }
    if (['/replace-external', '/shift-external'].includes(url.pathname)) {
      const pending = controls.get(id);
      if (pending) { controls.delete(id); pending.writeHead(200, { 'content-type': 'application/json' }); pending.end(JSON.stringify({ action: url.pathname === '/replace-external' ? 'replace' : 'shift' })); }
      response.writeHead(pending ? 204 : 409); response.end(); return;
    }
    if (url.pathname === '/state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/event' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      state.events.push(JSON.parse(body));
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/pending-fetch') {
      state.pendingFetch ??= { started: 0, cancelled: 0, completed: 0 };
      state.pendingFetch.started++;
      // Keep the HTTP response unfinished until real navigation aborts it.
      response.once('close', () => { if (!response.writableEnded) state.pendingFetch.cancelled++; });
      return;
    }
    if (url.pathname === '/slow-effect') {
      state.effects++;
      setTimeout(() => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<h1>Effect complete</h1>'); }, 1600);
      return;
    }
    if (url.pathname === '/file') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="../../danger.txt"' });
      response.end('download fixture bytes'); return;
    }
    if (url.pathname === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><label>Frame note<input aria-label="Frame note"></label><button onclick="parent.postMessage({kind:'frame',trusted:event.isTrusted},'*')">Frame action</button>`);
      return;
    }
    if (url.pathname === '/redirect-chain') {
      response.writeHead(302, { location: `/redirect?id=${encodeURIComponent(id)}` }); response.end(); return;
    }
    if (url.pathname === '/iframe-redirect-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><h1>Allowed parent</h1><iframe name="redirect-child" src="/redirect-chain?id=${encodeURIComponent(id)}"></iframe>`); return;
    }
    if (url.pathname === '/popup-redirect-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><h1>Allowed popup parent</h1><button onclick="window.open('/redirect-chain?id=${encodeURIComponent(id)}','_blank')">Open redirect popup</button>`); return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: forbiddenOrigin + '/redirect-destination' }); response.end(); return;
    }
    if (url.pathname === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Popup details</title><h1>Popup content</h1>'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(id, forbiddenOrigin, url.searchParams.get('mode')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, forbiddenOrigin, foreignRequests,
    shiftLayout: async id => {
      const response = await fetch(`${origin}/shift-external?id=${encodeURIComponent(id)}`);
      if (response.status !== 204) throw new Error('Fixture control channel not ready');
    },
    replaceNode: async id => {
      const response = await fetch(`${origin}/replace-external?id=${encodeURIComponent(id)}`);
      if (response.status !== 204) throw new Error('Fixture control channel not ready');
    },
    state: async id => (await fetch(`${origin}/state?id=${encodeURIComponent(id)}`)).json(),
    close: async () => {
      server.closeAllConnections(); foreign.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => foreign.close(resolve))]);
    },
  };
}

function page(id, forbiddenOrigin, mode) {
  const events = `/event?id=${encodeURIComponent(id)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${mode === 'cjk' ? '中文长标题'.repeat(100) : 'Browser acceptance ' + id}</title>
  <style>body{font:16px sans-serif;margin:24px}button,input,select,[role=button]{margin:7px;padding:8px}#overlay{position:fixed;inset:0;background:#ddd;z-index:99;display:none}#far{margin-top:1600px}#pixels{width:200px;height:70px;background:#123abc}</style></head><body>
  <h1>Browser acceptance</h1><main>
  <button id="native">Native action</button>
  <div role="button" tabindex="0" aria-label="Custom action" id="custom">Custom control</div>
  <span id="associated">Associated action</span><button aria-labelledby="associated" id="associated-button">Decorative child</button>
  <label>Search products<input id="query" placeholder="Search catalogue"></label>
  <label>Password<input id="secret" type="password" value="hidden-test-password"></label>
  <input aria-label="Consent" type="checkbox" id="consent">
  <label for="sort">Sort products</label><select id="sort"><option value="price">Price</option><option value="rating">Rating</option></select>
  <input type="file" aria-label="Upload report" id="upload">
  <button id="replace">Replace old target</button><button id="replaceable">Replaceable action</button>
  <button id="duplicate-a">Duplicate action</button><button id="duplicate-b">Duplicate action</button>
  <button id="show-overlay">Show overlay</button><button id="covered">Covered action</button>
  <button id="deferred">Schedule delayed control</button><span id="delayed-slot"></span>
  <button id="shift">Shift layout</button><span id="shift-slot"></span>
  <button id="dialog">Prompt action</button>
  <button id="popup">Open popup</button><a href="/file?id=${encodeURIComponent(id)}" download>Download report</a>
  <a href="${forbiddenOrigin}/forbidden" id="foreign">Forbidden navigation</a>
  <a href="/redirect?id=${encodeURIComponent(id)}">Forbidden redirect</a>
  <a href="/slow-effect?id=${encodeURIComponent(id)}">Slow effect</a>
  <button id="log">Produce logs</button><button id="pending-fetch">Start pending fetch</button>
  <div id="shadow-host"></div><iframe title="Embedded test" name="embedded" src="/frame?id=${encodeURIComponent(id)}"></iframe><iframe title="Cross origin embedded test" name="cross-embedded" src="${forbiddenOrigin}/frame?id=${encodeURIComponent(id)}"></iframe>
  <canvas id="pixels" width="200" height="70"></canvas>
  <button id="far">Below fold action</button>
  ${mode === 'large' ? Array.from({length:180},(_,i)=>`<button aria-label="Large action ${i}">Large action ${i}</button>`).join('') + '<p>' + 'bounded page content '.repeat(1500) + '</p>' : ''}
  ${mode === 'cjk' ? Array.from({length:80},(_,i)=>`<button aria-label="中文操作${i}：${'读取分页进度'.repeat(28)}">中文操作${i}</button>`).join('') + '<p>' + '分页中文内容验证。'.repeat(350) + '</p><button id="cjk-log">中文日志</button>' : ''}
  </main><div id="overlay"><button id="dismiss-overlay">Dismiss overlay</button></div>
  <script>
  const send = (kind, event, extra={}) => fetch(${JSON.stringify(events)}, {method:'POST',body:JSON.stringify({kind,trusted:event?.isTrusted ?? null,...extra})});
  const byId = id => document.getElementById(id);
  ${id === 'origin' ? `fetch(${JSON.stringify(forbiddenOrigin + '/asset-fetch')}).catch(()=>{}).finally(()=>send('origin-fetch-complete',null));const probe=document.createElement('img');probe.onload=probe.onerror=()=>send('origin-image-complete',null);probe.src=${JSON.stringify(forbiddenOrigin + '/asset-image')};document.body.append(probe);` : ''}
  ['native','custom','associated-button','covered','far'].forEach(id=>byId(id).addEventListener('click',e=>send(id,e)));
  byId('query').addEventListener('input',e=>send('query',e,{value:e.target.value}));
  byId('consent').addEventListener('change',e=>send('consent',e,{value:e.target.checked}));
  byId('sort').addEventListener('change',e=>send('sort',e,{value:e.target.value}));
  byId('upload').addEventListener('change',e=>send('upload',e,{names:Array.from(e.target.files).map(f=>f.name)}));
  byId('replaceable').addEventListener('click',e=>send('old-target',e));
  fetch('/control?id=${encodeURIComponent(id)}').then(r=>r.json()).then(command=>{if(command.action==='replace'){const old=byId('replaceable');const fresh=old.cloneNode(true);fresh.addEventListener('click',e=>send('replacement-target',e));old.replaceWith(fresh);send('autonomous-replace',null)}else if(command.action==='shift'){document.body.style.paddingTop='200px';send('autonomous-shift',null)}}).catch(()=>{});
  byId('replace').onclick=e=>{const old=byId('replaceable');const fresh=old.cloneNode(true);fresh.addEventListener('click',e=>send('replacement-target',e));old.replaceWith(fresh);send('replace',e)};
  byId('show-overlay').onclick=e=>{byId('overlay').style.display='block';send('show-overlay',e)};
  byId('dismiss-overlay').onclick=e=>{byId('overlay').style.display='none';send('dismiss-overlay',e)};
  byId('deferred').onclick=e=>{setTimeout(()=>{const b=document.createElement('button');b.textContent='Delayed action';b.onclick=e=>send('delayed',e);byId('delayed-slot').append(b)},140);send('deferred',e)};
  byId('shift').onclick=e=>{byId('shift-slot').style.display='block';byId('shift-slot').style.height='240px';send('shift',e)};
  byId('dialog').onclick=e=>{const answer=prompt('Fixture confirmation','');send('dialog',e,{answer})};
  byId('popup').onclick=e=>{window.open('/popup?id=${encodeURIComponent(id)}','_blank');send('popup',e)};
  if(byId('cjk-log'))byId('cjk-log').onclick=e=>{for(let i=0;i<8;i++)console.log('第'+i+'条'+ '中文日志'.repeat(240));send('cjk-logs',e)};
  byId('pending-fetch').onclick=e=>{for(let n=0;n<4;n++)fetch('/pending-fetch?id=${encodeURIComponent(id)}&n='+n).then(()=>send('pending-fetch-unexpectedly-completed',null)).catch(()=>{});send('pending-fetch-requested',e)};
  byId('log').onclick=e=>{console.log('fixture-log');fetch('/state?id=${encodeURIComponent(id)}&secret=redact-me');send('log',e)};
  const shadow=byId('shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow action</button>';shadow.querySelector('button').onclick=e=>send('shadow',e);
  window.addEventListener('message',e=>{if(['frame','crossframe'].includes(e.data?.kind))send(e.data.kind,null,{trusted:e.data.trusted})});
  const context=byId('pixels').getContext('2d');context.fillStyle='#123abc';context.fillRect(0,0,200,70);byId('pixels').onclick=e=>send('canvas',e,{x:e.offsetX,y:e.offsetY});
  </script></body></html>`;
}
